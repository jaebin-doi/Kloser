/* EmailProvider abstraction — Phase 3 contract, Phase 7 Step 1 multi-provider.
 *
 * Phase 3 (Step 2) introduced the EmailProvider interface and a single
 * dev_outbox implementation. Phase 7 Step 1 adds a queued (real-provider)
 * path while keeping the existing interface and singleton export so
 * callers (auth/signup, verify/resend, password/forgot, invitations) do
 * not change.
 *
 * Two providers:
 *
 *   DevOutboxEmailProvider  (`EMAIL_PROVIDER` unset / `dev_outbox`)
 *     - Writes the outbox row via `emailOutboxRepo.insertDeliveredDevEmail`.
 *     - status='delivered', provider='dev_outbox', delivered_at=now().
 *     - body_text and metadata keep the raw URL (with ?token=<raw>) so
 *       the Phase 3 e2e + route tests can extract tokens by regex.
 *       sensitive_payload_* columns stay NULL.
 *
 *   QueuedEmailProvider  (`EMAIL_PROVIDER=resend`)
 *     - Writes a `pending` row via `emailOutboxRepo.insertPendingEmail`.
 *     - body_text / metadata carry a redacted URL (`?token=[redacted]`).
 *     - Raw URL is AES-256-GCM encrypted and stored only in the
 *       sensitive_payload_* columns. The worker (next commit) decrypts
 *       in memory, sends, and then scrubs the columns.
 *     - This commit DOES NOT call Resend HTTP. The worker + adapter are
 *       next commits per `PHASE_7_STEP_1_PLAN.md` §11.
 *
 * Resolver: `resolveEmailProvider(env?)` selects between them. Real
 * provider mode is fail-fast on missing/invalid env so a misconfigured
 * deploy cannot silently fall back to dev. The module-level singleton
 * `emailProvider` is resolved eagerly at import time from `process.env`;
 * dev environments default to DevOutboxEmailProvider so existing tests
 * are unaffected.
 *
 * Body builders for each of the three templates are shared between the
 * providers so wording stays consistent. The queued provider feeds the
 * same builders the redacted URL.
 *
 * Error policy:
 *   - `EmailProviderConfigError` for resolver / env validation failures.
 *   - The encryption helper owns `EmailEncryptionConfigError` (key load /
 *     shape) and `EmailEncryptionFailureError` (decrypt-time corruption).
 *   - Error messages NEVER include RESEND_API_KEY, raw tokens, or raw
 *     URLs. The variable name is enough for an operator to fix.
 */
import type { PoolClient } from "pg";
import * as outboxRepo from "../repositories/emailOutbox.js";
import {
  encryptEmailSensitivePayload,
  loadEmailOutboxEncryptionKey,
} from "./emailSensitivePayload.js";

// ---------------------------------------------------------------------------
// Payloads (Phase 3 contract — unchanged)
// ---------------------------------------------------------------------------

interface BaseSendPayload {
  client: PoolClient;          // required — caller's transaction client
  orgId: string;
  toEmail: string;
  toName: string;
  rawToken: string;            // raw token already embedded in <*>Url
}

export interface EmailVerificationPayload extends BaseSendPayload {
  verifyUrl: string;           // full URL with ?token=<raw>
}

export interface EmailInvitationPayload extends BaseSendPayload {
  inviterName: string;
  organizationName: string;
  acceptUrl: string;
  invitationId: string;
}

export interface EmailPasswordResetPayload extends BaseSendPayload {
  resetUrl: string;
}

export interface EmailProvider {
  sendVerificationEmail(input: EmailVerificationPayload): Promise<void>;
  sendInvitationEmail(input: EmailInvitationPayload): Promise<void>;
  sendPasswordResetEmail(input: EmailPasswordResetPayload): Promise<void>;
}

export class EmailProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailProviderConfigError";
  }
}

// ---------------------------------------------------------------------------
// Shared body builders
// ---------------------------------------------------------------------------

function buildVerificationSubject(): string {
  return "[Kloser] 이메일 인증을 완료해주세요";
}

function buildVerificationBody(toName: string, verifyUrl: string): string {
  return (
    `안녕하세요 ${toName},\n\n` +
    `Kloser 회원가입 이메일 인증을 완료해주세요. 아래 링크는 24시간 동안 유효합니다.\n\n` +
    `${verifyUrl}\n\n` +
    `— Kloser`
  );
}

function buildInvitationSubject(organizationName: string): string {
  return `[Kloser] ${organizationName} 팀에 초대되었습니다`;
}

function buildInvitationBody(
  toName: string,
  inviterName: string,
  organizationName: string,
  acceptUrl: string,
): string {
  return (
    `안녕하세요 ${toName},\n\n` +
    `${inviterName}님이 ${organizationName} 팀에 회원님을 초대했습니다.\n` +
    `아래 링크에서 7일 안에 수락해주세요.\n\n` +
    `${acceptUrl}\n\n` +
    `— Kloser`
  );
}

function buildPasswordResetSubject(): string {
  return "[Kloser] 비밀번호 재설정 요청";
}

function buildPasswordResetBody(toName: string, resetUrl: string): string {
  return (
    `안녕하세요 ${toName},\n\n` +
    `비밀번호 재설정 요청을 받았습니다. 아래 링크는 1시간 동안 유효합니다.\n` +
    `본인이 요청한 게 아니면 이 메일은 무시하셔도 됩니다.\n\n` +
    `${resetUrl}\n\n` +
    `— Kloser`
  );
}

// Replace every `?token=...` / `&token=...` value in a URL with the literal
// `[redacted]`. Used by the queued provider so the outbox archive carries
// a recognisable-but-non-sensitive URL. We don't depend on knowing the
// raw token value — the regex pins on the query-param name, which is
// stable across all three builders.
function redactTokenInUrl(url: string): string {
  return url.replace(/([?&]token=)[^&\s]+/g, "$1[redacted]");
}

// ---------------------------------------------------------------------------
// Dev outbox provider (Phase 3 behavior preserved)
// ---------------------------------------------------------------------------

export class DevOutboxEmailProvider implements EmailProvider {
  async sendVerificationEmail(p: EmailVerificationPayload): Promise<void> {
    await outboxRepo.insertDeliveredDevEmail(p.client, {
      orgId:    p.orgId,
      toEmail:  p.toEmail,
      subject:  buildVerificationSubject(),
      bodyText: buildVerificationBody(p.toName, p.verifyUrl),
      template: "email_verification",
      metadata: { verifyUrl: p.verifyUrl },
    });
  }

  async sendInvitationEmail(p: EmailInvitationPayload): Promise<void> {
    await outboxRepo.insertDeliveredDevEmail(p.client, {
      orgId:    p.orgId,
      toEmail:  p.toEmail,
      subject:  buildInvitationSubject(p.organizationName),
      bodyText: buildInvitationBody(
        p.toName, p.inviterName, p.organizationName, p.acceptUrl,
      ),
      template: "invitation",
      metadata: { invitation_id: p.invitationId, acceptUrl: p.acceptUrl },
    });
  }

  async sendPasswordResetEmail(p: EmailPasswordResetPayload): Promise<void> {
    await outboxRepo.insertDeliveredDevEmail(p.client, {
      orgId:    p.orgId,
      toEmail:  p.toEmail,
      subject:  buildPasswordResetSubject(),
      bodyText: buildPasswordResetBody(p.toName, p.resetUrl),
      template: "password_reset",
      metadata: { resetUrl: p.resetUrl },
    });
  }
}

// ---------------------------------------------------------------------------
// Queued provider (real-provider pending outbox row, no HTTP this commit)
// ---------------------------------------------------------------------------

interface QueuedEmailProviderConfig {
  // EMAIL_FROM / RESEND_API_KEY are validated at resolver time. The
  // queued provider only needs the encryption key here; the From header
  // and provider API key are used by the worker / adapter (next commits).
  encryptionKey: Buffer;
}

export class QueuedEmailProvider implements EmailProvider {
  constructor(private readonly cfg: QueuedEmailProviderConfig) {}

  async sendVerificationEmail(p: EmailVerificationPayload): Promise<void> {
    const redactedUrl = redactTokenInUrl(p.verifyUrl);
    const sensitive = encryptEmailSensitivePayload(p.verifyUrl, this.cfg.encryptionKey);
    await outboxRepo.insertPendingEmail(p.client, {
      orgId:    p.orgId,
      toEmail:  p.toEmail,
      subject:  buildVerificationSubject(),
      bodyText: buildVerificationBody(p.toName, redactedUrl),
      template: "email_verification",
      metadata: { verifyUrl: redactedUrl },
      provider: "resend",
      sensitivePayload: { ...sensitive, keyVersion: 1 },
    });
  }

  async sendInvitationEmail(p: EmailInvitationPayload): Promise<void> {
    const redactedUrl = redactTokenInUrl(p.acceptUrl);
    const sensitive = encryptEmailSensitivePayload(p.acceptUrl, this.cfg.encryptionKey);
    await outboxRepo.insertPendingEmail(p.client, {
      orgId:    p.orgId,
      toEmail:  p.toEmail,
      subject:  buildInvitationSubject(p.organizationName),
      bodyText: buildInvitationBody(
        p.toName, p.inviterName, p.organizationName, redactedUrl,
      ),
      template: "invitation",
      metadata: { invitation_id: p.invitationId, acceptUrl: redactedUrl },
      provider: "resend",
      sensitivePayload: { ...sensitive, keyVersion: 1 },
    });
  }

  async sendPasswordResetEmail(p: EmailPasswordResetPayload): Promise<void> {
    const redactedUrl = redactTokenInUrl(p.resetUrl);
    const sensitive = encryptEmailSensitivePayload(p.resetUrl, this.cfg.encryptionKey);
    await outboxRepo.insertPendingEmail(p.client, {
      orgId:    p.orgId,
      toEmail:  p.toEmail,
      subject:  buildPasswordResetSubject(),
      bodyText: buildPasswordResetBody(p.toName, redactedUrl),
      template: "password_reset",
      metadata: { resetUrl: redactedUrl },
      provider: "resend",
      sensitivePayload: { ...sensitive, keyVersion: 1 },
    });
  }
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

// EMAIL_PROVIDER selector:
//   unset / "" / "dev_outbox" → DevOutboxEmailProvider
//   "resend"                  → QueuedEmailProvider (with validated config)
//   anything else             → EmailProviderConfigError (fail-fast)
//
// Real-provider mode validates EMAIL_FROM, RESEND_API_KEY, and
// EMAIL_OUTBOX_ENCRYPTION_KEY. Missing/invalid throws — silent dev
// fallback is forbidden so a misconfigured production cannot accidentally
// stop sending mail and write rows the worker can never decrypt.
export function resolveEmailProvider(
  env: NodeJS.ProcessEnv = process.env,
): EmailProvider {
  const raw = (env.EMAIL_PROVIDER ?? "").trim().toLowerCase();

  if (raw === "" || raw === "dev_outbox") {
    return new DevOutboxEmailProvider();
  }

  if (raw === "resend") {
    const from = (env.EMAIL_FROM ?? "").trim();
    if (from.length === 0) {
      throw new EmailProviderConfigError(
        "EMAIL_FROM is required when EMAIL_PROVIDER=resend",
      );
    }
    const apiKey = (env.RESEND_API_KEY ?? "").trim();
    if (apiKey.length === 0) {
      throw new EmailProviderConfigError(
        "RESEND_API_KEY is required when EMAIL_PROVIDER=resend",
      );
    }
    // loadEmailOutboxEncryptionKey throws EmailEncryptionConfigError on
    // missing / non-base64 / wrong-length key. Surface unchanged — the
    // caller observes a config error regardless of which env field was
    // wrong.
    const encryptionKey = loadEmailOutboxEncryptionKey(env);
    return new QueuedEmailProvider({ encryptionKey });
  }

  throw new EmailProviderConfigError(
    "Unknown EMAIL_PROVIDER value; supported values: dev_outbox, resend",
  );
}

// ---------------------------------------------------------------------------
// Runtime singleton (Phase 3 callers import this directly)
// ---------------------------------------------------------------------------

export const emailProvider: EmailProvider = resolveEmailProvider();

// ---------------------------------------------------------------------------
// URL builder helpers (used by callers — keeps env access in one place)
// ---------------------------------------------------------------------------

function publicOrigin(): string {
  return process.env.PUBLIC_APP_ORIGIN ?? "http://localhost:8765";
}

export function buildVerifyUrl(rawToken: string): string {
  return `${publicOrigin()}/platform/verify.html?token=${encodeURIComponent(rawToken)}`;
}

export function buildResetUrl(rawToken: string): string {
  return `${publicOrigin()}/platform/reset-password.html?token=${encodeURIComponent(rawToken)}`;
}

export function buildAcceptInvitationUrl(rawToken: string): string {
  return `${publicOrigin()}/platform/accept-invitation.html?token=${encodeURIComponent(rawToken)}`;
}

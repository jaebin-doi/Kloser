/* EmailProvider abstraction + dev outbox implementation.
 *
 * Phase 3 Step 2. Plan: docs/plan/phase-3/PHASE_3_STEP_2_SIGNUP_VERIFY.md §4.
 *
 * Three send methods (verification, invitation, password reset) — the only
 * outbound email kinds in Phase 3. Each takes a PoolClient so the outbox
 * INSERT runs inside the caller's transaction. The provider NEVER opens
 * its own connection: the caller (signup, verify-resend, password-forgot,
 * invitation-create, reset wrapper, accept wrapper) owns the boundary.
 *
 * The dev provider writes a row to email_outbox. body_text and metadata
 * include the raw token in the URL — this is the documented dev-only
 * exposure (see plan §7 and migration 1715000007000_phase3_email_outbox.sql
 * for rationale). Phase 6+ SMTP/Resend adapters will mask or strip the raw
 * token from outbox storage; their interface contract is unchanged.
 *
 * Step 3 (password reset) and Step 5 (invitation accept) call the relevant
 * method without extending this module.
 */
import type { PoolClient } from "pg";

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

interface BaseSendPayload {
  client: PoolClient;          // required — caller's transaction client
  orgId: string;
  toEmail: string;
  toName: string;
  rawToken: string;            // included in body / metadata for dev extraction
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

// ---------------------------------------------------------------------------
// Dev outbox provider
// ---------------------------------------------------------------------------

class DevOutboxEmailProvider implements EmailProvider {
  async sendVerificationEmail(p: EmailVerificationPayload): Promise<void> {
    const subject = "[Kloser] 이메일 인증을 완료해주세요";
    const bodyText =
      `안녕하세요 ${p.toName},\n\n` +
      `Kloser 회원가입 이메일 인증을 완료해주세요. 아래 링크는 24시간 동안 유효합니다.\n\n` +
      `${p.verifyUrl}\n\n` +
      `— Kloser`;
    await insertOutboxRow(p.client, {
      orgId:    p.orgId,
      toEmail:  p.toEmail,
      subject,
      bodyText,
      template: "email_verification",
      metadata: { verifyUrl: p.verifyUrl },
    });
  }

  async sendInvitationEmail(p: EmailInvitationPayload): Promise<void> {
    const subject = `[Kloser] ${p.organizationName} 팀에 초대되었습니다`;
    const bodyText =
      `안녕하세요 ${p.toName},\n\n` +
      `${p.inviterName}님이 ${p.organizationName} 팀에 회원님을 초대했습니다.\n` +
      `아래 링크에서 7일 안에 수락해주세요.\n\n` +
      `${p.acceptUrl}\n\n` +
      `— Kloser`;
    await insertOutboxRow(p.client, {
      orgId:    p.orgId,
      toEmail:  p.toEmail,
      subject,
      bodyText,
      template: "invitation",
      metadata: { invitation_id: p.invitationId, acceptUrl: p.acceptUrl },
    });
  }

  async sendPasswordResetEmail(p: EmailPasswordResetPayload): Promise<void> {
    const subject = "[Kloser] 비밀번호 재설정 요청";
    const bodyText =
      `안녕하세요 ${p.toName},\n\n` +
      `비밀번호 재설정 요청을 받았습니다. 아래 링크는 1시간 동안 유효합니다.\n` +
      `본인이 요청한 게 아니면 이 메일은 무시하셔도 됩니다.\n\n` +
      `${p.resetUrl}\n\n` +
      `— Kloser`;
    await insertOutboxRow(p.client, {
      orgId:    p.orgId,
      toEmail:  p.toEmail,
      subject,
      bodyText,
      template: "password_reset",
      metadata: { resetUrl: p.resetUrl },
    });
  }
}

interface OutboxRow {
  orgId: string;
  toEmail: string;
  subject: string;
  bodyText: string;
  template: "email_verification" | "password_reset" | "invitation";
  metadata: Record<string, unknown>;
}

async function insertOutboxRow(client: PoolClient, row: OutboxRow): Promise<void> {
  await client.query(
    `INSERT INTO email_outbox
       (org_id, to_email, subject, body_text, template, metadata, delivered_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())`,
    [
      row.orgId,
      row.toEmail,
      row.subject,
      row.bodyText,
      row.template,
      row.metadata,
    ],
  );
}

// ---------------------------------------------------------------------------
// Runtime singleton
// ---------------------------------------------------------------------------

export const emailProvider: EmailProvider = new DevOutboxEmailProvider();

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

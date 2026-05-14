/* Email delivery worker — Phase 7 Step 1.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_1_PLAN.md §5.4.
 *
 * Consumes the `email-delivery` singleton repeatable queue. Each tick:
 *   1. If `EMAIL_PROVIDER!=resend` → no-op (early return).
 *   2. List all org ids (organizations has no RLS — `app.pg` is enough).
 *   3. Per org enter `withOrgContext(orgId)` and call
 *      `emailOutbox.leaseDueEmail(client, now, lockToken)`. Skip the org
 *      when nothing is due.
 *   4. Decrypt the row's sensitive payload to recover the raw URL. On
 *      decrypt failure: dead-letter + scrub (retry will not change the
 *      outcome — key/version mismatch is permanent).
 *   5. Render the body by replacing the `?token=[redacted]` placeholder
 *      with the raw token segment, and call `adapter.send`.
 *   6. On success: markDelivered + scrubSensitivePayload.
 *      On PermanentEmailDeliveryError or attempt_count+1 ≥ max:
 *        markDeadLetter + scrubSensitivePayload.
 *      On RetryableEmailDeliveryError below max:
 *        markRetryableFailure with exponential backoff next_attempt_at.
 *      On unexpected throw: treated as retryable (defensive — never lose
 *      a row to an unhandled exception class).
 *
 * Concurrency:
 *   - leaseDueEmail uses FOR UPDATE SKIP LOCKED so two concurrent ticks
 *     processing the same org each lease at most one distinct row.
 *   - The lock is held only for the duration of the lease transaction.
 *     Once status='sending' is committed, the row is invisible to the
 *     next lease scan until mark* transitions it again.
 *
 * Stuck rows:
 *   - A worker that crashes between lease and mark* leaves the row at
 *     status='sending' indefinitely. Step 1 does NOT ship a stuck-row
 *     sweep — Phase 7 Step 4 retention cron can pick that up. Operators
 *     can manually re-`UPDATE email_outbox SET status='failed', locked_at
 *     =NULL, lock_token=NULL` to recover.
 *
 * Org enumeration:
 *   - `listAllOrgIds` is worker-internal (Phase 6 Step 1). Same surface
 *     used by heartbeat sweep.
 *
 * Error hygiene:
 *   - Every error_message written to email_outbox.error_message is the
 *     adapter's pre-sanitised message (no api key, no raw token, no raw
 *     URL). decrypt-failure messages do not echo ciphertext bytes.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Worker, type Job } from "bullmq";
import { getRedisConnection } from "../queue/redis.js";
import {
  EMAIL_DELIVERY_QUEUE,
  type EmailDeliveryJobData,
} from "../queue/queues.js";
import * as emailOutbox from "../repositories/emailOutbox.js";
import { listAllOrgIds } from "../repositories/orgs.js";
import {
  decryptEmailSensitivePayload,
  EmailEncryptionFailureError,
  loadEmailOutboxEncryptionKey,
} from "../services/emailSensitivePayload.js";
import {
  type EmailDeliveryAdapter,
  PermanentEmailDeliveryError,
  ResendEmailDeliveryAdapter,
  RetryableEmailDeliveryError,
} from "../adapters/email/index.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface EmailDeliveryRuntimeConfig {
  adapter: EmailDeliveryAdapter;
  from: string;
  apiKey: string;
  encryptionKey: Buffer;
  maxAttempts: number;
  // Base backoff in ms. Effective delay for attempt N (post-failure) is
  // baseBackoffMs * 2^(N-1). Capped at 1 hour to avoid runaway delays.
  baseBackoffMs: number;
}

export class EmailDeliveryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailDeliveryConfigError";
  }
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

export function computeBackoffMs(
  attemptCountAfter: number,
  baseMs: number,
): number {
  // attemptCountAfter is 1-indexed (1 = after first failure).
  const exp = Math.max(0, attemptCountAfter - 1);
  const raw = baseMs * Math.pow(2, exp);
  return Math.min(raw, MAX_BACKOFF_MS);
}

// ---------------------------------------------------------------------------
// Body rendering — swap [redacted] back to the raw token segment
// ---------------------------------------------------------------------------

function extractRawTokenSegment(rawUrl: string): string | null {
  const m = /([?&])token=([^&\s]+)/.exec(rawUrl);
  if (!m) return null;
  return m[2]!;
}

function renderBodyWithRawToken(
  redactedBody: string,
  rawTokenSegment: string,
): string {
  // Replace every `?token=[redacted]` / `&token=[redacted]` with the raw
  // token segment. Pinning on the query-param name keeps us from
  // accidentally rewriting unrelated `[redacted]` strings that may
  // appear in future body templates.
  return redactedBody.replace(
    /([?&]token=)\[redacted\]/g,
    (_m, prefix: string) => `${prefix}${rawTokenSegment}`,
  );
}

// ---------------------------------------------------------------------------
// Processor — exported standalone so tests can drive one tick directly
// ---------------------------------------------------------------------------

export interface EmailDeliveryTickResult {
  skipped?: boolean;
  reason?: "no_adapter";
  orgsScanned: number;
  leased: number;
  delivered: number;
  retried: number;
  deadLettered: number;
  decryptFailed: number;
}

export interface MakeEmailDeliveryProcessorOptions {
  config: EmailDeliveryRuntimeConfig | null;
  // `now` injection point for deterministic backoff tests. Defaults to
  // `() => new Date()` so production code never has to pass it.
  now?: () => Date;
}

export function makeEmailDeliveryProcessor(
  app: FastifyInstance,
  opts: MakeEmailDeliveryProcessorOptions,
) {
  const config = opts.config;
  const nowFn = opts.now ?? (() => new Date());

  return async function processor(
    _job?: Pick<Job<EmailDeliveryJobData>, "data">,
  ): Promise<EmailDeliveryTickResult> {
    if (!config) {
      return {
        skipped: true,
        reason: "no_adapter",
        orgsScanned: 0,
        leased: 0,
        delivered: 0,
        retried: 0,
        deadLettered: 0,
        decryptFailed: 0,
      };
    }

    const stats: EmailDeliveryTickResult = {
      orgsScanned: 0,
      leased: 0,
      delivered: 0,
      retried: 0,
      deadLettered: 0,
      decryptFailed: 0,
    };

    // organizations has no RLS — bare `app.pg` connect is fine.
    const orgClient = await app.pg.connect();
    let orgIds: string[];
    try {
      orgIds = await listAllOrgIds(orgClient);
    } finally {
      orgClient.release();
    }
    stats.orgsScanned = orgIds.length;

    for (const orgId of orgIds) {
      try {
        const outcome = await processOneOrg(app, orgId, config, nowFn);
        if (outcome === "delivered") {
          stats.leased += 1;
          stats.delivered += 1;
        } else if (outcome === "retried") {
          stats.leased += 1;
          stats.retried += 1;
        } else if (outcome === "dead_lettered") {
          stats.leased += 1;
          stats.deadLettered += 1;
        } else if (outcome === "decrypt_failed") {
          stats.leased += 1;
          stats.decryptFailed += 1;
          stats.deadLettered += 1;
        }
        // outcome === "idle" → no leasable row in this org
      } catch (err) {
        // Per-org failures don't stop the sweep. Bare error name keeps
        // the log line out of sensitive territory.
        console.error(
          `[email-delivery] org=${orgId} tick failed: ${(err as Error).name}`,
        );
      }
    }

    return stats;
  };
}

type OrgOutcome =
  | "idle"
  | "delivered"
  | "retried"
  | "dead_lettered"
  | "decrypt_failed";

async function processOneOrg(
  app: FastifyInstance,
  orgId: string,
  config: EmailDeliveryRuntimeConfig,
  nowFn: () => Date,
): Promise<OrgOutcome> {
  const lockToken = randomUUID();
  const leased = await app.withOrgContext(orgId, (client) =>
    emailOutbox.leaseDueEmail(client, nowFn(), lockToken),
  );
  if (!leased) return "idle";

  // Decrypt sensitive payload. Missing columns => the row was inserted
  // by something other than the queued provider (defensive — should not
  // happen since lease filters pending/failed which only the queued
  // provider produces). Treat the same as decrypt failure.
  if (
    !leased.sensitive_payload_ciphertext ||
    !leased.sensitive_payload_iv ||
    !leased.sensitive_payload_tag
  ) {
    await app.withOrgContext(orgId, async (client) => {
      await emailOutbox.markDeadLetter(
        client,
        leased.id,
        "sensitive_payload_missing",
      );
      await emailOutbox.scrubSensitivePayload(client, leased.id);
    });
    return "decrypt_failed";
  }

  let rawUrl: string;
  try {
    rawUrl = decryptEmailSensitivePayload(
      {
        ciphertext: leased.sensitive_payload_ciphertext,
        iv: leased.sensitive_payload_iv,
        tag: leased.sensitive_payload_tag,
      },
      config.encryptionKey,
    );
  } catch (err) {
    // Treat all decrypt errors the same: key/version drift or row
    // tampering won't get better on retry. Dead-letter + scrub.
    const reason = err instanceof EmailEncryptionFailureError
      ? "decrypt_failed"
      : `decrypt_error:${(err as Error).name}`;
    await app.withOrgContext(orgId, async (client) => {
      await emailOutbox.markDeadLetter(client, leased.id, reason);
      await emailOutbox.scrubSensitivePayload(client, leased.id);
    });
    return "decrypt_failed";
  }

  const rawTokenSeg = extractRawTokenSegment(rawUrl);
  if (!rawTokenSeg) {
    await app.withOrgContext(orgId, async (client) => {
      await emailOutbox.markDeadLetter(client, leased.id, "raw_url_no_token");
      await emailOutbox.scrubSensitivePayload(client, leased.id);
    });
    return "decrypt_failed";
  }

  const renderedText = renderBodyWithRawToken(leased.body_text, rawTokenSeg);
  const renderedHtml = leased.body_html
    ? renderBodyWithRawToken(leased.body_html, rawTokenSeg)
    : null;

  try {
    const { providerMessageId } = await config.adapter.send({
      toEmail: leased.to_email,
      subject: leased.subject,
      text: renderedText,
      html: renderedHtml,
      from: config.from,
      apiKey: config.apiKey,
    });
    await app.withOrgContext(orgId, async (client) => {
      await emailOutbox.markDelivered(client, leased.id, providerMessageId);
      await emailOutbox.scrubSensitivePayload(client, leased.id);
    });
    return "delivered";
  } catch (err) {
    return handleSendFailure(app, orgId, leased, err, config, nowFn);
  }
}

async function handleSendFailure(
  app: FastifyInstance,
  orgId: string,
  leased: { id: string; attempt_count: number },
  err: unknown,
  config: EmailDeliveryRuntimeConfig,
  nowFn: () => Date,
): Promise<OrgOutcome> {
  const isPermanent = err instanceof PermanentEmailDeliveryError;
  const isRetryable = err instanceof RetryableEmailDeliveryError;

  // Adapter contract: pre-sanitised message. For unknown classes we
  // record only the error name so an unexpected library doesn't leak
  // the request body into error_message.
  let reason: string;
  if (isPermanent || isRetryable) {
    reason = (err as Error).message;
  } else {
    reason = `unexpected:${(err as Error).name}`;
  }

  const attemptCountAfter = leased.attempt_count + 1;

  // Permanent — straight to dead-letter regardless of attempt count.
  if (isPermanent) {
    await app.withOrgContext(orgId, async (client) => {
      await emailOutbox.markDeadLetter(client, leased.id, reason);
      await emailOutbox.scrubSensitivePayload(client, leased.id);
    });
    return "dead_lettered";
  }

  // Retryable or unexpected — dead-letter when we'd hit max, else retry.
  if (attemptCountAfter >= config.maxAttempts) {
    await app.withOrgContext(orgId, async (client) => {
      await emailOutbox.markDeadLetter(client, leased.id, reason);
      await emailOutbox.scrubSensitivePayload(client, leased.id);
    });
    return "dead_lettered";
  }

  const delayMs = computeBackoffMs(attemptCountAfter, config.baseBackoffMs);
  const nextAttemptAt = new Date(nowFn().getTime() + delayMs);
  await app.withOrgContext(orgId, async (client) => {
    await emailOutbox.markRetryableFailure(
      client,
      leased.id,
      reason,
      nextAttemptAt,
    );
  });
  return "retried";
}

// ---------------------------------------------------------------------------
// Env loader + Worker factory
// ---------------------------------------------------------------------------

// Returns the runtime config when EMAIL_PROVIDER=resend and all required
// env is valid. Returns null only for the dev provider (worker no-op).
// Unknown providers and missing/invalid real-provider env are fail-fast
// so a selected production provider cannot silently stop sending.
export function loadEmailDeliveryConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  adapterFactory?: () => EmailDeliveryAdapter,
): EmailDeliveryRuntimeConfig | null {
  const provider = (env.EMAIL_PROVIDER ?? "").trim().toLowerCase();
  if (provider === "" || provider === "dev_outbox") return null;
  if (provider !== "resend") {
    throw new EmailDeliveryConfigError(
      "Unknown EMAIL_PROVIDER value; supported values: dev_outbox, resend",
    );
  }

  const from = (env.EMAIL_FROM ?? "").trim();
  if (from.length === 0) {
    throw new EmailDeliveryConfigError(
      "EMAIL_FROM is required when EMAIL_PROVIDER=resend",
    );
  }
  const apiKey = (env.RESEND_API_KEY ?? "").trim();
  if (apiKey.length === 0) {
    throw new EmailDeliveryConfigError(
      "RESEND_API_KEY is required when EMAIL_PROVIDER=resend",
    );
  }

  // Validates EMAIL_OUTBOX_ENCRYPTION_KEY shape (base64 + 32 bytes).
  // Throws EmailEncryptionConfigError on missing/malformed.
  const encryptionKey = loadEmailOutboxEncryptionKey(env);

  const maxAttempts = parseIntEnv(
    env.KLOSER_EMAIL_MAX_ATTEMPTS,
    DEFAULT_MAX_ATTEMPTS,
  );

  // Adapter factory is injectable for tests. Default = Resend HTTP.
  const adapter: EmailDeliveryAdapter = adapterFactory
    ? adapterFactory()
    : new ResendEmailDeliveryAdapter();

  return {
    adapter,
    from,
    apiKey,
    encryptionKey,
    maxAttempts,
    baseBackoffMs: DEFAULT_BASE_BACKOFF_MS,
  };
}

function parseIntEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function createEmailDeliveryWorker(
  app: FastifyInstance,
  config: EmailDeliveryRuntimeConfig | null,
): Worker<EmailDeliveryJobData> {
  const processor = makeEmailDeliveryProcessor(app, { config });
  return new Worker<EmailDeliveryJobData>(
    EMAIL_DELIVERY_QUEUE,
    async (job) => processor(job),
    {
      connection: getRedisConnection(),
      // Concurrency 1: at most one tick at a time per process. The
      // per-org SKIP LOCKED already handles inter-process concurrency.
      concurrency: 1,
    },
  );
}

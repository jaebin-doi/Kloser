/* email_outbox repository — Phase 7 Step 1.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_1_PLAN.md §4.
 * Schema: server/migrations/1715000022000_phase7_email_delivery.sql.
 *
 * Phase 3 (migration 1715000007000) created email_outbox as a dev-only
 * archive: every row was INSERTed with delivered_at=now(). Phase 7 keeps
 * that compatibility (`EMAIL_PROVIDER=dev_outbox` path) and extends the
 * same table to a transactional delivery outbox for real providers
 * (Resend). The new column surface is:
 *
 *   status / provider / attempt_count / next_attempt_at  — lifecycle
 *   locked_at / lock_token                               — lease metadata
 *   provider_message_id                                  — webhook id
 *   sensitive_payload_{ciphertext,iv,tag,key_version}    — AES-256-GCM
 *                                                          raw URL kept
 *                                                          only while
 *                                                          pending; scrubbed
 *                                                          after delivery
 *                                                          or dead-letter.
 *
 * State machine:
 *
 *   pending  --leaseDueEmail-->        sending
 *   failed   --leaseDueEmail-->        sending
 *   sending  --markDelivered-->        delivered     (terminal)
 *   sending  --markRetryableFailure--> failed
 *   sending  --markDeadLetter-->       dead_lettered (terminal)
 *
 * All mark* helpers gate on `status = 'sending'` so concurrent or stale
 * actors cannot transition a row from an unexpected state. They throw a
 * generic Error if 0 rows update — the worker is expected to translate
 * that into a structured event.
 *
 * All helpers run on a PoolClient handed in by the caller. The caller
 * owns the transaction and the `withOrgContext` GUC. Same convention as
 * Phase 4 calls / Phase 5 call_suggestions / Phase 6 llm_usage_log:
 * routes / workers must wrap in `app.withOrgContext(orgId, fn)` so RLS
 * applies against the right org.
 */
import type { PoolClient } from "pg";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type EmailOutboxStatus =
  | "pending"
  | "sending"
  | "delivered"
  | "failed"
  | "dead_lettered";

export type EmailOutboxProvider = "dev_outbox" | "resend";

export type EmailOutboxTemplate =
  | "email_verification"
  | "password_reset"
  | "invitation";

export interface EmailOutboxRow {
  id: string;
  org_id: string;
  to_email: string;
  subject: string;
  body_text: string;
  body_html: string | null;
  template: EmailOutboxTemplate;
  metadata: Record<string, unknown>;
  delivered_at: Date | null;
  failed_at: Date | null;
  error_message: string | null;
  created_at: Date;
  status: EmailOutboxStatus;
  provider: EmailOutboxProvider;
  provider_message_id: string | null;
  attempt_count: number;
  last_attempt_at: Date | null;
  next_attempt_at: Date | null;
  dead_lettered_at: Date | null;
  locked_at: Date | null;
  lock_token: string | null;
  sensitive_payload_ciphertext: string | null;
  sensitive_payload_iv: string | null;
  sensitive_payload_tag: string | null;
  sensitive_payload_key_version: number;
}

export interface EmailSensitivePayloadFields {
  ciphertext: string;
  iv: string;
  tag: string;
  keyVersion: number;
}

const COLUMNS = `
  id, org_id, to_email, subject, body_text, body_html, template, metadata,
  delivered_at, failed_at, error_message, created_at,
  status, provider, provider_message_id, attempt_count,
  last_attempt_at, next_attempt_at, dead_lettered_at,
  locked_at, lock_token,
  sensitive_payload_ciphertext, sensitive_payload_iv, sensitive_payload_tag,
  sensitive_payload_key_version
`;

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

export interface InsertDeliveredDevEmailInput {
  orgId: string;
  toEmail: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  template: EmailOutboxTemplate;
  metadata: Record<string, unknown>;
}

// Dev provider INSERT: status='delivered', provider='dev_outbox',
// delivered_at=now(). body_text / metadata still carry the raw URL — the
// dev archive contract from Phase 3 is intentionally preserved so e2e
// token extraction keeps working. No sensitive_payload_* columns are
// touched; they stay NULL.
export async function insertDeliveredDevEmail(
  client: PoolClient,
  input: InsertDeliveredDevEmailInput,
): Promise<EmailOutboxRow> {
  const r = await client.query<EmailOutboxRow>(
    `INSERT INTO email_outbox (
        org_id, to_email, subject, body_text, body_html, template, metadata,
        status, provider, delivered_at
     ) VALUES (
        $1, $2, $3, $4, $5, $6, COALESCE($7::jsonb, '{}'::jsonb),
        'delivered', 'dev_outbox', now()
     )
     RETURNING ${COLUMNS}`,
    [
      input.orgId,
      input.toEmail,
      input.subject,
      input.bodyText,
      input.bodyHtml ?? null,
      input.template,
      JSON.stringify(input.metadata),
    ],
  );
  return r.rows[0]!;
}

export interface InsertPendingEmailInput {
  orgId: string;
  toEmail: string;
  subject: string;
  bodyText: string;     // caller must redact raw URL / token
  bodyHtml?: string | null;
  template: EmailOutboxTemplate;
  metadata: Record<string, unknown>;  // caller must redact raw URL / token
  provider: EmailOutboxProvider;       // 'resend' in Phase 7 Step 1
  sensitivePayload: EmailSensitivePayloadFields;
  nextAttemptAt?: Date | null;         // default now()
}

// Real-provider INSERT: status='pending', sensitive_payload_* populated,
// body_text / metadata redacted (caller responsibility). Worker leases the
// row via leaseDueEmail and decrypts the sensitive payload in memory to
// render the actual outbound body. delivered_at remains NULL until the
// worker marks success.
export async function insertPendingEmail(
  client: PoolClient,
  input: InsertPendingEmailInput,
): Promise<EmailOutboxRow> {
  const r = await client.query<EmailOutboxRow>(
    `INSERT INTO email_outbox (
        org_id, to_email, subject, body_text, body_html, template, metadata,
        status, provider, next_attempt_at,
        sensitive_payload_ciphertext, sensitive_payload_iv,
        sensitive_payload_tag, sensitive_payload_key_version
     ) VALUES (
        $1, $2, $3, $4, $5, $6, COALESCE($7::jsonb, '{}'::jsonb),
        'pending', $8, COALESCE($9, now()),
        $10, $11, $12, $13
     )
     RETURNING ${COLUMNS}`,
    [
      input.orgId,
      input.toEmail,
      input.subject,
      input.bodyText,
      input.bodyHtml ?? null,
      input.template,
      JSON.stringify(input.metadata),
      input.provider,
      input.nextAttemptAt ?? null,
      input.sensitivePayload.ciphertext,
      input.sensitivePayload.iv,
      input.sensitivePayload.tag,
      input.sensitivePayload.keyVersion,
    ],
  );
  return r.rows[0]!;
}

// ---------------------------------------------------------------------------
// Lease
// ---------------------------------------------------------------------------

// Pick exactly one due `pending` or `failed` row, lock it with
// `FOR UPDATE SKIP LOCKED`, and transition it to `sending` with the
// caller's lock token. Returns the leased row, or null if no row is due.
//
// attempt_count is NOT incremented here — `mark*` helpers below own the
// count so a successful delivery and a retryable failure both increment
// by exactly one. last_attempt_at is set to `now` so audit / cron logic
// can observe how long the row has been in-flight.
//
// Concurrency: a second concurrent caller running this query inside its
// own transaction will skip the locked row (FOR UPDATE SKIP LOCKED) and
// return null. Verified by phase7_email_outbox_repo.test.mjs.
export async function leaseDueEmail(
  client: PoolClient,
  now: Date,
  lockToken: string,
): Promise<EmailOutboxRow | null> {
  const picked = await client.query<{ id: string }>(
    `SELECT id
       FROM email_outbox
      WHERE status IN ('pending','failed')
        AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
      ORDER BY next_attempt_at NULLS FIRST, created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1`,
    [now],
  );
  if (picked.rows.length === 0) {
    return null;
  }
  const id = picked.rows[0]!.id;

  const r = await client.query<EmailOutboxRow>(
    `UPDATE email_outbox
        SET status = 'sending',
            locked_at = $2,
            lock_token = $3,
            last_attempt_at = $2
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [id, now, lockToken],
  );
  return r.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Mark transitions (sending -> terminal/retry)
// ---------------------------------------------------------------------------

// Worker called provider successfully. Sets delivered_at + provider message id
// and clears lock metadata. Sensitive payload is NOT scrubbed here — callers
// chain `scrubSensitivePayload(client, id)` so a delivered row keeps no
// secret material at rest.
export async function markDelivered(
  client: PoolClient,
  id: string,
  providerMessageId: string,
): Promise<void> {
  const r = await client.query(
    `UPDATE email_outbox
        SET status = 'delivered',
            delivered_at = now(),
            provider_message_id = $2,
            locked_at = NULL,
            lock_token = NULL
      WHERE id = $1
        AND status = 'sending'`,
    [id, providerMessageId],
  );
  if (r.rowCount === 0) {
    throw new Error(
      `email_outbox: markDelivered expected status='sending' (id=${id})`,
    );
  }
}

// Worker call failed but the failure is recoverable (network blip, 5xx).
// Caller bumps `next_attempt_at` based on its own backoff policy. Lock
// metadata is cleared so the next lease can pick the row back up after
// next_attempt_at passes.
export async function markRetryableFailure(
  client: PoolClient,
  id: string,
  errorMessage: string,
  nextAttemptAt: Date,
): Promise<void> {
  const r = await client.query(
    `UPDATE email_outbox
        SET status = 'failed',
            failed_at = now(),
            error_message = $2,
            attempt_count = attempt_count + 1,
            next_attempt_at = $3,
            locked_at = NULL,
            lock_token = NULL
      WHERE id = $1
        AND status = 'sending'`,
    [id, errorMessage, nextAttemptAt],
  );
  if (r.rowCount === 0) {
    throw new Error(
      `email_outbox: markRetryableFailure expected status='sending' (id=${id})`,
    );
  }
}

// Worker has given up on this row (max attempts hit or permanent error).
// dead_lettered_at + error_message recorded, lock cleared, terminal.
// Caller chains `scrubSensitivePayload` so the row stops carrying secret
// material once we will not retry it.
export async function markDeadLetter(
  client: PoolClient,
  id: string,
  errorMessage: string,
): Promise<void> {
  const r = await client.query(
    `UPDATE email_outbox
        SET status = 'dead_lettered',
            dead_lettered_at = now(),
            error_message = $2,
            attempt_count = attempt_count + 1,
            locked_at = NULL,
            lock_token = NULL
      WHERE id = $1
        AND status = 'sending'`,
    [id, errorMessage],
  );
  if (r.rowCount === 0) {
    throw new Error(
      `email_outbox: markDeadLetter expected status='sending' (id=${id})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Scrub
// ---------------------------------------------------------------------------

// Null out the three ciphertext columns. Worker calls this after a row
// reaches a terminal state (delivered or dead_lettered) so encrypted raw
// URLs do not sit in the table indefinitely. key_version is left alone —
// it records which key produced the now-removed ciphertext.
//
// scrub is idempotent: calling it on a row whose payload is already NULL
// is a no-op. RLS still enforces org isolation.
export async function scrubSensitivePayload(
  client: PoolClient,
  id: string,
): Promise<void> {
  await client.query(
    `UPDATE email_outbox
        SET sensitive_payload_ciphertext = NULL,
            sensitive_payload_iv = NULL,
            sensitive_payload_tag = NULL
      WHERE id = $1`,
    [id],
  );
}

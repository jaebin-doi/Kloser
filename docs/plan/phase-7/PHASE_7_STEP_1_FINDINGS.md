# Phase 7 Step 1 Findings — Resend email delivery

Date: 2026-05-14

## Scope

Phase 7 Step 1 moved Phase 3 email flows from dev-only outbox archive to a
production-capable transactional delivery outbox.

Covered flows:

- email verification
- password reset
- invitation accept

The request path still does not call external HTTP. It writes an outbox row in
the same transaction as the token mutation. The worker sends after commit.

## Commits

- `38c7bf7 Add Phase 7 email delivery schema`
- `4c8d2cb Add Phase 7 email outbox repository`
- `7fcd035 Refactor Phase 7 email provider`
- `441cb31 Add Phase 7 email delivery worker`

## Implemented

- `email_outbox` schema now tracks delivery lifecycle:
  `status`, `provider`, `provider_message_id`, `attempt_count`,
  `last_attempt_at`, `next_attempt_at`, `dead_lettered_at`, `locked_at`,
  `lock_token`, and `sensitive_payload_*`.
- Existing dev rows were backfilled to `(status='delivered',
  provider='dev_outbox')`.
- Partial indexes were added for due lease scans, provider message lookup, and
  dead-letter operator queries.
- `server/src/repositories/emailOutbox.ts` owns the state machine:
  `pending|failed -> sending -> delivered|failed|dead_lettered`.
- `server/src/services/emailSensitivePayload.ts` provides AES-256-GCM helpers
  for raw verify/reset/invite URLs. Config and decrypt errors do not echo
  plaintext or ciphertext bytes.
- `server/src/services/email.ts` now resolves:
  - `dev_outbox` default: same Phase 3 behavior, raw URL kept in `body_text`
    and `metadata` for dev/e2e token extraction.
  - `resend`: queued provider, archive text uses `?token=[redacted]`, raw URL
    is encrypted into `sensitive_payload_*`.
- `server/src/adapters/email/resend.ts` implements the live Resend HTTP adapter
  with native `fetch`.
- `server/src/workers/emailDelivery.worker.ts` leases due rows by org through
  `app.withOrgContext`, decrypts the raw URL, restores the redacted token in
  the outbound body, sends through the adapter, and marks delivered/retryable
  failure/dead-letter.
- BullMQ queue registration was added under `email-delivery`.

## Decisions

- `EMAIL_PROVIDER=dev_outbox` remains the default. This preserves local dev
  and Phase 3 e2e behavior.
- `EMAIL_PROVIDER=resend` is the first real provider. Self-hosted SMTP is
  deferred because deliverability work is larger than the Step 1 target.
- Missing or malformed real-provider env is fail-fast:
  `EMAIL_FROM`, `RESEND_API_KEY`, and `EMAIL_OUTBOX_ENCRYPTION_KEY` are required
  when `EMAIL_PROVIDER=resend`.
- Unknown `EMAIL_PROVIDER` values are fail-fast and do not echo the original
  value.
- The worker uses the app role plus per-org `withOrgContext`. It does not use
  BYPASSRLS.
- Delivery errors persist only sanitized reason strings. API keys, raw tokens,
  raw URLs, request bodies, and provider error messages are not echoed.
- Delivered and dead-lettered rows scrub `sensitive_payload_ciphertext`,
  `sensitive_payload_iv`, and `sensitive_payload_tag`.
- Stuck `status='sending'` rows after worker crash are deferred to Phase 7 Step
  4 retention/recovery sweep.

## Verification

Final Codex-side validation:

- `npm --prefix server run typecheck` PASS
- `npm --prefix server test` PASS: 443 total / 440 pass / 0 fail / 3 skipped
- `node test/sync_shared_types.mjs` PASS: 15 entities
- `node test/phase_3_e2e.mjs` PASS

Key test coverage added:

- encryption round-trip, wrong-key/tag failure, missing/malformed env
- outbox RLS isolation and SKIP LOCKED lease behavior
- dev provider keeps raw URL for existing e2e extraction
- queued provider redacts archive text and encrypts raw URL
- Resend adapter success, 3xx/4xx permanent, 5xx/network retryable
- worker happy path, retryable failure, permanent failure, max attempts,
  decrypt failure, concurrent lease race, and error hygiene

## Remaining Work

- Staging smoke test with real Resend credentials and verified sender domain.
- Provider webhook/idempotency ingestion.
- Stuck `sending` row recovery sweep in Phase 7 Step 4.
- Step 2: MFA / session hardening.
- Step 3: activity_log population and audit query surface.
- Step 4: retention enforce cron.

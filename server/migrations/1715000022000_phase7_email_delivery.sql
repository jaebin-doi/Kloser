-- Phase 7 Step 1 — email_outbox transactional delivery columns.
-- Plan:   docs/plan/phase-7/PHASE_7_STEP_1_PLAN.md §3.
-- Master: docs/plan/phase-7/PHASE_7_MASTER.md §3 Step 1.
--
-- Phase 3 (migration 1715000007000) ships `email_outbox` as a dev-only
-- archive that the dev provider INSERTs into with delivered_at = now().
-- e2e then SELECTs the raw token from body_text / metadata. Phase 7 keeps
-- that compatibility for `EMAIL_PROVIDER=dev_outbox` and extends the same
-- table to a transactional delivery outbox for real providers (Resend).
--
-- New columns:
--   status, provider, attempt_count, last_attempt_at, next_attempt_at,
--   dead_lettered_at                — worker lifecycle (lease / retry /
--                                     dead-letter / scrub).
--   provider_message_id            — id returned by the real provider
--                                     (webhook correlation, idempotency).
--   locked_at, lock_token          — `FOR UPDATE SKIP LOCKED` lease metadata
--                                     so concurrent workers do not double-send.
--   sensitive_payload_ciphertext,
--   sensitive_payload_iv,
--   sensitive_payload_tag,
--   sensitive_payload_key_version  — AES-256-GCM ciphertext of the raw URL /
--                                     raw token kept ONLY while delivery is
--                                     pending. body_text / metadata stay
--                                     redacted in real provider mode; the
--                                     worker decrypts in memory, sends, then
--                                     scrubs (NULL) the four columns.
--
-- Scope: schema-only. Repository, service refactor, encryption helper, queued
-- provider, Resend adapter, and worker live in the next commits per
-- PHASE_7_STEP_1_PLAN §11.
--
-- Backward compatibility:
--   - Dev flow (`EMAIL_PROVIDER=dev_outbox`) keeps inserting with
--     status='delivered', provider='dev_outbox', delivered_at=now().
--   - Phase 3 e2e (`server/test/verify_routes`, `password_reset_routes`,
--     `invitation_routes`, and root `test/phase_3_e2e.mjs`) keeps extracting
--     raw tokens from body_text / metadata.<*>Url on dev rows.
--   - Real-provider archive redaction is implemented in the follow-up
--     service commit, not here.
--
-- Backfill (Plan §3.1):
--   delivered_at IS NOT NULL → status='delivered'
--   failed_at    IS NOT NULL → status='failed'   (delivered_at takes precedence)
--   otherwise                → status='pending'
--   provider = 'dev_outbox' for all existing rows.
--
-- RLS:
--   No policy change. Existing email_outbox_select / _insert / _update /
--   _delete are org-scoped via current_app_org_id() and continue to cover
--   the new columns. FORCE ROW LEVEL SECURITY remains set from
--   migration 1715000007000.
--
-- Grants:
--   No grant change.
--     - `app` already has SELECT/INSERT/UPDATE/DELETE on email_outbox via
--       ops/postgres/init/01_app_role.sql default privileges. The worker
--       runs as the `app` role through `app.withOrgContext`.
--     - `kloser_service` already has SELECT/INSERT/UPDATE on email_outbox
--       from migration 1715000008000. The anonymous verify / reset / invite
--       flows use it to INSERT pending rows during signup; UPDATE is reserved
--       for the worker path, which runs as `app`. No DELETE is needed in
--       Step 1 — dead-lettered rows remain for audit; a future retention
--       sweep (Phase 7 Step 4) decides removal policy.

-- Up Migration
-- ============================================================================

ALTER TABLE email_outbox
    ADD COLUMN status text NOT NULL DEFAULT 'delivered'
        CHECK (status IN ('pending','sending','delivered','failed','dead_lettered')),
    ADD COLUMN provider text NOT NULL DEFAULT 'dev_outbox'
        CHECK (provider IN ('dev_outbox','resend')),
    ADD COLUMN provider_message_id text,
    ADD COLUMN attempt_count integer NOT NULL DEFAULT 0
        CHECK (attempt_count >= 0),
    ADD COLUMN last_attempt_at  timestamptz,
    ADD COLUMN next_attempt_at  timestamptz,
    ADD COLUMN dead_lettered_at timestamptz,
    ADD COLUMN locked_at        timestamptz,
    ADD COLUMN lock_token       uuid,
    ADD COLUMN sensitive_payload_ciphertext   text,
    ADD COLUMN sensitive_payload_iv           text,
    ADD COLUMN sensitive_payload_tag          text,
    ADD COLUMN sensitive_payload_key_version  integer NOT NULL DEFAULT 1
        CHECK (sensitive_payload_key_version >= 1);

-- Backfill status from the legacy timestamp pair. The CASE re-affirms the
-- temporary 'delivered' default where it is correct and reclassifies the
-- two non-default cases. provider stays at the 'dev_outbox' default for
-- every existing row because pre-Phase-7 inserts only ever came from the
-- dev provider.
UPDATE email_outbox
   SET status = CASE
       WHEN delivered_at IS NOT NULL THEN 'delivered'
       WHEN failed_at    IS NOT NULL THEN 'failed'
       ELSE 'pending'
   END;

-- Due-row index for worker lease. Partial on the only states the worker
-- can pick up: 'pending' (never tried) and 'failed' (retryable). 'sending'
-- is transient under an in-flight lease; 'delivered' and 'dead_lettered'
-- are terminal. NULLS FIRST so a freshly-INSERTed pending row whose worker
-- has not yet set next_attempt_at still sorts to the front; created_at
-- breaks ties FIFO.
CREATE INDEX email_outbox_due_idx
    ON email_outbox (next_attempt_at NULLS FIRST, created_at)
    WHERE status IN ('pending','failed');

-- Provider message id lookup. Partial because dev_outbox rows never carry
-- a provider_message_id; this index targets webhook callbacks (bounces,
-- complaints) and post-send idempotency checks.
CREATE INDEX email_outbox_provider_message_idx
    ON email_outbox (provider, provider_message_id)
    WHERE provider_message_id IS NOT NULL;

-- Dead-letter operator view — admin / ops drill into rows the worker
-- gave up on, newest first within each org.
CREATE INDEX email_outbox_dead_letter_idx
    ON email_outbox (org_id, dead_lettered_at DESC)
    WHERE status = 'dead_lettered';


-- Down Migration
-- ============================================================================

DROP INDEX IF EXISTS email_outbox_dead_letter_idx;
DROP INDEX IF EXISTS email_outbox_provider_message_idx;
DROP INDEX IF EXISTS email_outbox_due_idx;

ALTER TABLE email_outbox
    DROP COLUMN IF EXISTS sensitive_payload_key_version,
    DROP COLUMN IF EXISTS sensitive_payload_tag,
    DROP COLUMN IF EXISTS sensitive_payload_iv,
    DROP COLUMN IF EXISTS sensitive_payload_ciphertext,
    DROP COLUMN IF EXISTS lock_token,
    DROP COLUMN IF EXISTS locked_at,
    DROP COLUMN IF EXISTS dead_lettered_at,
    DROP COLUMN IF EXISTS next_attempt_at,
    DROP COLUMN IF EXISTS last_attempt_at,
    DROP COLUMN IF EXISTS attempt_count,
    DROP COLUMN IF EXISTS provider_message_id,
    DROP COLUMN IF EXISTS provider,
    DROP COLUMN IF EXISTS status;

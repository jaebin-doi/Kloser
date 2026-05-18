-- Phase 7 Step 4 — retention audit actions + email outbox stuck-recovery index.
--
-- Plan: docs/plan/phase-7/PHASE_7_STEP_4_PLAN.md §4 / §9.
-- Master: docs/plan/phase-7/PHASE_7_MASTER.md §3 Step 4.
--
-- Two surface changes:
--
--   1. Extend `activity_log_action_check` with the retention worker's
--      two aggregate audit actions:
--        - retention.transcripts_deleted
--        - email_outbox.sending_recovered
--      PostgreSQL has no in-place CHECK edit, so we DROP + ADD with the
--      full allow-list (Step 3 set + the two new entries). Drift between
--      the DB CHECK and the TS unions (repositories/activityLog.ts +
--      routes/activityLog.ts) surfaces as a CHECK violation at insert
--      time — that is the intended fail-fast contract from Step 3 plan
--      §3.3.
--
--   2. Add `email_outbox_sending_locked_idx` — partial index that backs
--      the worker's "stale sending lease" scan
--        WHERE status = 'sending' AND locked_at < cutoff
--      The Step 1 `email_outbox_due_idx` is partial on (`status='pending'`
--      OR `status='failed'`) for the due-lease query, so stuck rows in
--      'sending' do not benefit from it. The new index is also partial
--      and keyed on (org_id, locked_at) so the per-org tick can range-
--      scan the oldest stuck rows directly.
--
-- Out of scope (per plan §2 "안 한다"):
--   - `call_recordings` table / object storage. Recording surface does not
--     exist in the schema today; the Step 4 worker is a no-op on the
--     recording side until Phase 8/P2 adds the metadata table.
--   - per-org retention overrides (no `organizations.retention_*` columns).
--   - email_outbox delivered / dead_lettered archive purge.
--   - app role grants are already SELECT/INSERT/UPDATE/DELETE from the
--     init bootstrap (ops/postgres/init/01_app_role.sql), so no GRANT
--     change is needed for the worker. Phase 7 Step 3 added an explicit
--     `GRANT SELECT, INSERT ON activity_log TO app` for documentation;
--     retention writes use the same path and stay covered.

-- Up Migration
-- ============================================================================

ALTER TABLE activity_log
  DROP CONSTRAINT IF EXISTS activity_log_action_check;

ALTER TABLE activity_log
  ADD CONSTRAINT activity_log_action_check
    CHECK (action IN (
      -- auth
      'auth.login',
      'auth.logout',
      'auth.refresh_mfa_required',
      'auth.password_reset_requested',
      'auth.password_reset_completed',
      'auth.email_verified',
      'auth.email_verification_resent',

      -- mfa
      'mfa.login_challenge_issued',
      'mfa.login_verified',
      'mfa.setup_started',
      'mfa.enabled',
      'mfa.disabled',
      'mfa.failed_attempt',
      'mfa.locked',

      -- organization
      'organization.mfa_required_enabled',
      'organization.mfa_required_disabled',

      -- membership
      'membership.role_changed',
      'membership.status_changed',
      'membership.team_changed',

      -- invitation
      'invitation.created',
      'invitation.resent',
      'invitation.cancelled',
      'invitation.accepted',

      -- customer
      'customer.created',
      'customer.updated',
      'customer.deleted',

      -- call
      'call.created',
      'call.ended',
      'call.customer_linked',
      'call.customer_unlinked',
      'call.notes_updated',
      'call.manual_summary_updated',

      -- call_action_item
      'call_action_item.created',
      'call_action_item.status_changed',
      'call_action_item.assignee_changed',
      'call_action_item.deleted',

      -- knowledge
      'knowledge_base.created',
      'knowledge_base.updated',
      'knowledge_base.deleted',
      'knowledge_chunk.replaced',

      -- checklist template
      'checklist_template.created',
      'checklist_template.updated',
      'checklist_template.deleted',

      -- report (read-event, may be best-effort per plan §3.1)
      'report.team_viewed',

      -- Phase 7 Step 4 — retention worker aggregate events
      'retention.transcripts_deleted',
      'email_outbox.sending_recovered'
    ));

-- Partial index — `WHERE status='sending' AND locked_at IS NOT NULL` keeps it
-- aimed at the only state the recovery sweep cares about. Leading column is
-- org_id so the per-org tick (which sets app.org_id and lets RLS narrow the
-- scan) lands on a small slice. locked_at is the ordering key so
-- `ORDER BY locked_at LIMIT N FOR UPDATE SKIP LOCKED` picks the oldest stuck
-- rows first.
CREATE INDEX email_outbox_sending_locked_idx
  ON email_outbox (org_id, locked_at)
  WHERE status = 'sending' AND locked_at IS NOT NULL;


-- Down Migration
-- ============================================================================
-- Reverse only what this migration added.

DROP INDEX IF EXISTS email_outbox_sending_locked_idx;

ALTER TABLE activity_log
  DROP CONSTRAINT IF EXISTS activity_log_action_check;

ALTER TABLE activity_log
  ADD CONSTRAINT activity_log_action_check
    CHECK (action IN (
      'auth.login',
      'auth.logout',
      'auth.refresh_mfa_required',
      'auth.password_reset_requested',
      'auth.password_reset_completed',
      'auth.email_verified',
      'auth.email_verification_resent',
      'mfa.login_challenge_issued',
      'mfa.login_verified',
      'mfa.setup_started',
      'mfa.enabled',
      'mfa.disabled',
      'mfa.failed_attempt',
      'mfa.locked',
      'organization.mfa_required_enabled',
      'organization.mfa_required_disabled',
      'membership.role_changed',
      'membership.status_changed',
      'membership.team_changed',
      'invitation.created',
      'invitation.resent',
      'invitation.cancelled',
      'invitation.accepted',
      'customer.created',
      'customer.updated',
      'customer.deleted',
      'call.created',
      'call.ended',
      'call.customer_linked',
      'call.customer_unlinked',
      'call.notes_updated',
      'call.manual_summary_updated',
      'call_action_item.created',
      'call_action_item.status_changed',
      'call_action_item.assignee_changed',
      'call_action_item.deleted',
      'knowledge_base.created',
      'knowledge_base.updated',
      'knowledge_base.deleted',
      'knowledge_chunk.replaced',
      'checklist_template.created',
      'checklist_template.updated',
      'checklist_template.deleted',
      'report.team_viewed'
    ));

-- Phase 7 Step 3 — activity_log hardening (schema-only).
--
-- Plan: docs/plan/phase-7/PHASE_7_STEP_3_PLAN.md §4 / §13.
--
-- Scope (this migration only):
--   1. CHECK constraints — action allow-list, target_type allow-list,
--      payload is a JSON object.
--   2. Composite indexes for admin audit queries — by action, by target,
--      by user, all org-scoped + created_at DESC.
--   3. Explicit app-role grants — SELECT/INSERT only. activity_log is
--      append-only by service convention (no UPDATE/DELETE hook in the
--      Step 3 service plan). Tightening to revoke UPDATE/DELETE entirely
--      is deferred — the init bootstrap (ops/postgres/init/01_app_role.sql)
--      already hands out UPDATE/DELETE to `app` on ALL TABLES, so an
--      explicit REVOKE here would be a behavior change that must land
--      together with the repository / service hook commits, not in this
--      schema-only migration.
--
-- Out of scope (deferred to follow-up commits per plan §11):
--   - repository / service helpers
--   - audit event hooks
--   - admin `GET /activity-log` route
--   - shared types + frontend audit panel
--   - retention/append-only enforcement at DB level
--
-- The `kloser_service` role is intentionally NOT granted activity_log
-- access. Phase 3 service grants migration (1715000008000) already lists
-- activity_log among the tables withheld from the service role. Step 3
-- preserves that posture — anonymous auth flows that need an audit row
-- write through the runtime `app` role with explicit `app.org_id` set
-- (see plan §3.2).
--
-- The action / target_type lists below are the EXACT lists declared in
-- the plan's allow-list (§3.3 actions, §3.4 / §4 target types). They are
-- intentionally verbose so that adding a new audit event is a two-step
-- change (TS union + this CHECK), making accidental string drift
-- impossible. New values require a forward migration.

-- Up Migration
-- ============================================================================

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
      'report.team_viewed'
    )),
  ADD CONSTRAINT activity_log_target_type_check
    CHECK (
      target_type IS NULL
      OR target_type IN (
        'organization',
        'user',
        'membership',
        'invitation',
        'customer',
        'call',
        'call_action_item',
        'knowledge_base',
        'knowledge_chunk',
        'checklist_template',
        'auth_token',
        'session',
        'report'
      )
    ),
  ADD CONSTRAINT activity_log_payload_object_check
    CHECK (jsonb_typeof(payload) = 'object');

-- Admin audit queries are typed: list by action, drill into a target,
-- or filter by actor user. All three are scoped to (org_id, created_at
-- DESC) — the same shape as the existing activity_log_created_at_idx
-- but with a leading discriminator column to make selective scans cheap.
CREATE INDEX activity_log_org_action_created_idx
  ON activity_log (org_id, action, created_at DESC);

-- Partial index — `WHERE target_type IS NOT NULL AND target_id IS NOT NULL`
-- keeps it lean for the "drill into one entity's history" query and skips
-- system-wide events (auth.login, etc.) that have no target.
CREATE INDEX activity_log_org_target_created_idx
  ON activity_log (org_id, target_type, target_id, created_at DESC)
  WHERE target_type IS NOT NULL AND target_id IS NOT NULL;

-- Partial index — `WHERE user_id IS NOT NULL` skips system/worker events
-- where actor is null (plan §3.2). The admin "who did what" query hits
-- this one.
CREATE INDEX activity_log_org_user_created_idx
  ON activity_log (org_id, user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

-- Explicit assertion of the runtime grant. The init bootstrap already
-- hands `app` SELECT/INSERT/UPDATE/DELETE on ALL TABLES, so this is
-- idempotent confirmation — and it documents the contract directly in
-- the migration history (matches the Phase 4 app_grants pattern).
GRANT SELECT, INSERT ON activity_log TO app;


-- Down Migration
-- ============================================================================
-- Reverse only what this migration added. Do NOT touch the init
-- migration's table/RLS/policy/created_at index — those belong to
-- 1715000000000_init.sql.

-- Do not mirror the GRANT with REVOKE here. PostgreSQL does not track
-- grant provenance, so revoking SELECT/INSERT would also strip the
-- bootstrap/runtime grant that predates this migration. Append-only
-- privilege tightening belongs in a separate forward migration.

DROP INDEX IF EXISTS activity_log_org_user_created_idx;
DROP INDEX IF EXISTS activity_log_org_target_created_idx;
DROP INDEX IF EXISTS activity_log_org_action_created_idx;

ALTER TABLE activity_log
  DROP CONSTRAINT IF EXISTS activity_log_payload_object_check,
  DROP CONSTRAINT IF EXISTS activity_log_target_type_check,
  DROP CONSTRAINT IF EXISTS activity_log_action_check;

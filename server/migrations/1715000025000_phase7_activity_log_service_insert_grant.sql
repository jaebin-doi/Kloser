-- Phase 7 Step 3 — INSERT-only grant on activity_log for kloser_service.
--
-- Plan: docs/plan/phase-7/PHASE_7_STEP_3_PLAN.md §3.2 (audit actor model).
-- Closes the gap left by 1715000024000_phase7_activity_log_hardening.sql
-- so the login-time MFA flows (verifyLoginMfa / setupLoginMfaChallenge /
-- confirmLoginMfaChallenge) can append audit rows in the SAME transaction
-- as the mutation they're auditing.
--
-- Why this exception to plan §3.2 ("kloser_service에는 activity_log
-- grant 주지 말 것"):
--
--   Those three login-time endpoints are anonymous (no Bearer yet) and
--   own the auth_tokens / users / sessions mutations on the
--   BYPASSRLS-aware servicePool transaction. Step 3 audit policy
--   (plan §3.1) requires `mfa.login_verified`, login-time
--   `mfa.setup_started`, login-time `mfa.enabled`, login-time
--   `mfa.failed_attempt`, and login-time `mfa.locked` to commit together
--   with the corresponding mutation — an out-of-transaction insert from
--   a separate app-pool connection would leave a window where the
--   session was minted (or counter incremented) but the audit row was
--   lost. That violates the transactional contract.
--
--   App-pool refactor of the three endpoints is the alternative, but
--   means re-doing the GUC dance for every step + reproducing the
--   CommitAuthError pattern from auth.ts twice over — substantially
--   more code than this one-line INSERT grant.
--
--   The grant is INSERT only. No SELECT / UPDATE / DELETE. Even with
--   BYPASSRLS, kloser_service:
--     - cannot read other orgs' audit rows (no SELECT grant),
--     - cannot tamper with existing rows (no UPDATE),
--     - cannot scrub the audit trail (no DELETE).
--   The admin-only `GET /activity-log` route (next commits) goes through
--   the app pool + RLS as planned.
--
--   `kloser_service`'s BYPASSRLS does mean a `WITH CHECK` policy
--   violation cannot block a wrong-org INSERT here. The hook code is
--   responsible for passing the correct orgId — the audit row's org_id
--   column is the source of truth, and the action / target_type CHECK
--   constraints from migration 0024 still apply.

-- Up Migration
-- ============================================================================

GRANT INSERT ON activity_log TO kloser_service;


-- Down Migration
-- ============================================================================

REVOKE INSERT ON activity_log FROM kloser_service;

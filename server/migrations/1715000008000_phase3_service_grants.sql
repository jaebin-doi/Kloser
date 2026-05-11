-- Phase 3 Step 2 — table grants for kloser_service role.
-- Plan: docs/plan/phase-3/PHASE_3_STEP_2_SIGNUP_VERIFY.md §2.
--
-- The role itself is created by ops/postgres/init/02_service_role.sql at
-- volume init time. This migration runs after Phase 3 Step 1 (0004~0007)
-- so all referenced tables already exist. Schema-level USAGE is also set
-- in the init script — only table grants live here.
--
-- Surface (7 tables) — the minimum set anonymous endpoints actually touch:
--   - auth_tokens   : SELECT/INSERT/UPDATE (consume / mint / invalidate)
--   - email_outbox  : SELECT/INSERT/UPDATE (dev provider writes outbox rows)
--   - users         : SELECT/INSERT/UPDATE (verify sets email_verified_at,
--                                           accept-invitation creates user)
--   - memberships   : SELECT/INSERT        (accept-invitation adds membership)
--   - sessions      : SELECT/INSERT/UPDATE (password-reset revokes sessions)
--   - organizations : SELECT               (join to derive org metadata)
--   - invitations   : SELECT/UPDATE        (accept marks accepted_at)
--
-- customers / activity_log / teams have no grant — kloser_service can
-- BYPASSRLS, but only on tables with explicit table-level permission.
--
-- Idempotent: GRANT statements are inherently idempotent in PostgreSQL.

-- Up Migration
-- ============================================================================

GRANT SELECT, INSERT, UPDATE ON auth_tokens    TO kloser_service;
GRANT SELECT, INSERT, UPDATE ON email_outbox   TO kloser_service;
GRANT SELECT, INSERT, UPDATE ON users          TO kloser_service;
GRANT SELECT, INSERT          ON memberships   TO kloser_service;
-- UPDATE on sessions is for Step 3 /auth/password/reset which revokes all
-- active sessions on successful reset (sets revoked_at = now()). Granted
-- now so Step 3 doesn't need a follow-up grant migration.
GRANT SELECT, INSERT, UPDATE ON sessions       TO kloser_service;
GRANT SELECT                 ON organizations  TO kloser_service;
GRANT SELECT, UPDATE         ON invitations    TO kloser_service;


-- Down Migration
-- ============================================================================

REVOKE SELECT, UPDATE          ON invitations   FROM kloser_service;
REVOKE SELECT                  ON organizations FROM kloser_service;
REVOKE SELECT, INSERT, UPDATE  ON sessions      FROM kloser_service;
REVOKE SELECT, INSERT          ON memberships   FROM kloser_service;
REVOKE SELECT, INSERT, UPDATE  ON users         FROM kloser_service;
REVOKE SELECT, INSERT, UPDATE  ON email_outbox  FROM kloser_service;
REVOKE SELECT, INSERT, UPDATE  ON auth_tokens   FROM kloser_service;

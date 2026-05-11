-- Phase 3 Step 2 — service role for anonymous RLS bypass (DEV ONLY).
-- Plan: docs/plan/phase-3/PHASE_3_STEP_2_SIGNUP_VERIFY.md §2.
--
-- Used by runtime code on three anonymous endpoints:
--   - POST /auth/verify              (Step 2)
--   - POST /auth/password/reset      (Step 3)
--   - POST /invitations/accept       (Step 5)
--
-- These flows arrive without a JWT — a raw token is the only server-side
-- identity. The runtime app role cannot consume those tokens because it
-- is NOBYPASSRLS and there is no app.org_id GUC to set. The service role
-- carries BYPASSRLS so it can SELECT/UPDATE auth_tokens by token_hash and
-- write the resulting state into RLS-scoped tables. Table-level grants
-- live in migration 1715000008000_phase3_service_grants.sql — that is the
-- minimum-surface list of tables the service role can touch. customers /
-- activity_log / teams are intentionally NOT granted.
--
-- Why this file is not a migration: roles are cluster-wide, not DB-scoped.
-- node-pg-migrate's down/redo would tangle with role state. Postgres runs
-- files in /docker-entrypoint-initdb.d/ ONLY on first volume creation, so
-- for an existing volume run this file manually:
--
--   docker exec -i kloser-dev-postgres-1 \
--     psql -U kloser -d kloser_dev -f /docker-entrypoint-initdb.d/02_service_role.sql
--
-- Idempotent — safe to re-run.
--
-- Production: replace the hardcoded password below with a secret-store
-- managed value and inject SERVICE_DATABASE_URL from the deploy env.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kloser_service') THEN
    CREATE ROLE kloser_service
      LOGIN PASSWORD 'kloser_service_dev'
      NOSUPERUSER BYPASSRLS;
  END IF;
END
$$;

-- Connect + schema usage. Table-level grants are in migration 0008 because
-- the relevant Phase 3 tables don't exist yet at init time on a fresh DB.
GRANT CONNECT ON DATABASE kloser_dev TO kloser_service;
GRANT USAGE   ON SCHEMA   public     TO kloser_service;

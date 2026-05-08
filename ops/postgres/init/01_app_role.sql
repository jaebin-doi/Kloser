-- Phase 1 Step 2 — runtime app role bootstrap (DEV ONLY).
--
-- This file hardcodes dev credentials (`kloser_dev`, `app_dev`, etc.). For
-- production, the runtime password must come from a secret store and the
-- DATABASE_URL injected from the deploy environment — do not re-use this
-- file as-is. Treat it as a dev-only convenience.
--
-- Why a separate role: the migration owner (kloser, created by POSTGRES_USER)
-- is a superuser with rolbypassrls=t. RLS policies do not apply to it. The
-- runtime `app` role is NOSUPERUSER NOBYPASSRLS, so RLS actually enforces
-- isolation against it. See docs/plan/phase-1/PHASE_1_STEP_1_FINDINGS.md §9.
--
-- Why this file is not a migration: roles are cluster-wide objects, not DB
-- objects. node-pg-migrate's down/redo would tangle with role state. Postgres
-- runs files in /docker-entrypoint-initdb.d/ ONLY on first volume creation,
-- so for an existing volume run this file manually:
--
--   docker exec -i kloser-dev-postgres-1 \
--     psql -U kloser -d kloser_dev -f /docker-entrypoint-initdb.d/01_app_role.sql
--
-- The file is fully idempotent — safe to re-run.

-- ----------------------------------------------------------------------------
-- 1. Role
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app') THEN
    CREATE ROLE app LOGIN PASSWORD 'app_dev' NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

-- ----------------------------------------------------------------------------
-- 2. Privileges on the current DB and schema
-- ----------------------------------------------------------------------------
GRANT CONNECT ON DATABASE kloser_dev TO app;
GRANT USAGE   ON SCHEMA public        TO app;

-- Existing tables/sequences (created by the Step 1 migration as kloser).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO app;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO app;

-- node-pg-migrate's tracking table is migration metadata, not application
-- data. Runtime should never read or modify it — revoke everything that
-- the blanket GRANT above just handed out.
REVOKE ALL ON TABLE pgmigrations FROM app;

-- ----------------------------------------------------------------------------
-- 3. Default privileges for FUTURE objects created by `kloser`
-- ----------------------------------------------------------------------------
-- FOR ROLE kloser is required: without it the rule applies only to objects
-- created by the CURRENT session, which would silently miss future migrations.
ALTER DEFAULT PRIVILEGES FOR ROLE kloser IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app;
ALTER DEFAULT PRIVILEGES FOR ROLE kloser IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app;

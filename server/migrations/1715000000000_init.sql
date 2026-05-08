-- Phase 1 Step 1 — initial schema
-- Tables: organizations, users, memberships, sessions, teams, invitations, activity_log
-- RLS default-deny ENABLE on org-scoped tables.

-- Up Migration
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- organizations ---------------------------------------------------------------
CREATE TABLE organizations (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text        NOT NULL,
    plan        text        NOT NULL DEFAULT 'starter',
    settings    jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- users -----------------------------------------------------------------------
-- Not org-scoped: a user may belong to multiple orgs via memberships.
-- Cross-org isolation is enforced via memberships join, not on `users` itself.
CREATE TABLE users (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    email             citext      NOT NULL UNIQUE,
    password_hash     text        NOT NULL,
    name              text        NOT NULL,
    avatar_url        text,
    email_verified_at timestamptz,
    disabled_at       timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

-- teams -----------------------------------------------------------------------
-- (org_id, id) is UNIQUE so memberships(org_id, team_id) can have a composite
-- FK against it. Without that, a row in memberships(org_id=A, team_id=t_B)
-- would be insertable even though t_B belongs to a different org.
CREATE TABLE teams (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name        text        NOT NULL,
    manager_id  uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, id)
);
CREATE INDEX teams_org_id_idx ON teams(org_id);

-- memberships -----------------------------------------------------------------
-- team_id FK is composite against teams(org_id, id) to prevent a membership
-- in org A from referencing a team in org B (cross-org pollution). The plain
-- single-column FK to teams(id) would have allowed it.
CREATE TABLE memberships (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id     uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       text        NOT NULL CHECK (role IN ('admin', 'manager', 'employee', 'viewer')),
    team_id    uuid,
    status     text        NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, user_id),
    FOREIGN KEY (org_id, team_id) REFERENCES teams(org_id, id) ON DELETE SET NULL
);
CREATE INDEX memberships_org_id_idx  ON memberships(org_id);
CREATE INDEX memberships_user_id_idx ON memberships(user_id);

-- sessions --------------------------------------------------------------------
-- Refresh-token-rotated sessions. user-scoped; cross-org isolation enforced
-- elsewhere (auth middleware checks membership).
CREATE TABLE sessions (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash  text        NOT NULL,
    user_agent          text,
    ip                  inet,
    expires_at          timestamptz NOT NULL,
    revoked_at          timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX        sessions_user_id_idx            ON sessions(user_id);
-- refresh_token_hash is logically a unique key (each session has its own
-- random refresh token; a collision would mean session confusion). Step 3's
-- refresh-rotation flow relies on a single row per token.
CREATE UNIQUE INDEX sessions_refresh_token_hash_idx ON sessions(refresh_token_hash);

-- invitations -----------------------------------------------------------------
CREATE TABLE invitations (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email        citext      NOT NULL,
    role         text        NOT NULL CHECK (role IN ('admin', 'manager', 'employee', 'viewer')),
    token_hash   text        NOT NULL,
    expires_at   timestamptz NOT NULL,
    accepted_at  timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitations_org_id_idx       ON invitations(org_id);
CREATE INDEX invitations_token_hash_idx   ON invitations(token_hash);

-- activity_log ----------------------------------------------------------------
CREATE TABLE activity_log (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id      uuid        REFERENCES users(id) ON DELETE SET NULL,
    action       text        NOT NULL,
    target_type  text,
    target_id    uuid,
    payload      jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_log_org_id_idx     ON activity_log(org_id);
CREATE INDEX activity_log_created_at_idx ON activity_log(org_id, created_at DESC);

-- ============================================================================
-- Row-Level Security (default-deny)
-- ============================================================================
-- Strategy:
--   - org-scoped tables (memberships, teams, invitations, activity_log) get
--     RLS with USING/WITH CHECK matching current_setting('app.org_id').
--   - `users` is NOT org-scoped (can belong to many orgs); isolation is via
--     memberships join in the application layer.
--   - `organizations` is browsed via memberships join (a user only sees orgs
--     they have a membership in); enforcing here would fight the auth flow.
--   - `sessions` is user-scoped (refresh-token rotation); RLS would require a
--     `current_setting('app.user_id')` plumbing — deferred to Step 2 if
--     wanted, otherwise enforced at repository layer.
--
-- The `app.org_id` GUC must be set per transaction by the auth middleware
-- (Step 2). Without it, default-deny means 0 rows visible.

ALTER TABLE memberships  ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams        ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;

-- FORCE makes the policy apply even to the table owner. Without FORCE, the
-- migration role (which owns the tables) would silently bypass RLS in tests.
ALTER TABLE memberships  FORCE ROW LEVEL SECURITY;
ALTER TABLE teams        FORCE ROW LEVEL SECURITY;
ALTER TABLE invitations  FORCE ROW LEVEL SECURITY;
ALTER TABLE activity_log FORCE ROW LEVEL SECURITY;

-- Helper: returns the current app.org_id GUC as uuid, or NULL if unset/blank.
-- Used by every policy below so missing GUC = 0 rows, never an error.
CREATE OR REPLACE FUNCTION current_app_org_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.org_id', true), '')::uuid
$$;

CREATE POLICY memberships_org_isolation ON memberships
    USING      (org_id = current_app_org_id())
    WITH CHECK (org_id = current_app_org_id());

CREATE POLICY teams_org_isolation ON teams
    USING      (org_id = current_app_org_id())
    WITH CHECK (org_id = current_app_org_id());

CREATE POLICY invitations_org_isolation ON invitations
    USING      (org_id = current_app_org_id())
    WITH CHECK (org_id = current_app_org_id());

CREATE POLICY activity_log_org_isolation ON activity_log
    USING      (org_id = current_app_org_id())
    WITH CHECK (org_id = current_app_org_id());


-- Down Migration
-- ============================================================================

DROP POLICY IF EXISTS activity_log_org_isolation ON activity_log;
DROP POLICY IF EXISTS invitations_org_isolation  ON invitations;
DROP POLICY IF EXISTS teams_org_isolation        ON teams;
DROP POLICY IF EXISTS memberships_org_isolation  ON memberships;

DROP FUNCTION IF EXISTS current_app_org_id();

DROP TABLE IF EXISTS activity_log;
DROP TABLE IF EXISTS invitations;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS memberships;
DROP TABLE IF EXISTS teams;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS organizations;

-- Extensions intentionally not dropped — pgcrypto/citext are likely shared.

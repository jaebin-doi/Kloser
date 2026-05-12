-- Phase 1 Step 1 — demo seed.
--
-- Two organizations, each with one admin and one employee = 4 users + 4
-- memberships. Used by RLS isolation tests in Step 2.
--
-- Dev login credentials (password_hash is Argon2id):
--   admin@acme.test  / acme-admin-1234
--   emp@acme.test    / acme-emp-1234
--   admin@beta.test  / beta-admin-1234
--   emp@beta.test    / beta-emp-1234
--
-- Idempotent: safe to re-run.

-- Disable RLS for the duration of the seed by elevating to a superuser-like
-- session. The migration role owns these tables and FORCE RLS is enabled, so
-- we set the org_id GUC to a synthetic value and rely on plain INSERTs which
-- only need WITH CHECK satisfaction. We bypass cleanly by setting the GUC
-- per-org during inserts.

BEGIN;

-- Two organizations. Use deterministic UUIDs so tests can reference them.
INSERT INTO organizations (id, name, plan)
VALUES
    ('11111111-1111-1111-1111-111111111111', 'Acme Sales Inc.', 'pro'),
    ('22222222-2222-2222-2222-222222222222', 'Beta Outreach Co.', 'starter')
ON CONFLICT (id) DO NOTHING;

-- Four users (org-agnostic). Email is unique.
-- email_verified_at = now() so seeded dev logins don't trigger the
-- unverified-email banner. New (non-seeded) signups still go through
-- the normal verify flow with email_verified_at NULL until consumed.
INSERT INTO users (id, email, password_hash, name, email_verified_at)
VALUES
    ('aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa', 'admin@acme.test',  '$argon2id$v=19$m=65536,t=3,p=4$cvCzqlGNJKXbUERhk+gdSw$Aqr75RM6pPlkpavJewnfgZHcyhNXTiGYTPA5m747XHE', '에이스 어드민', now()),
    ('aaaaaaaa-0002-0002-0002-aaaaaaaaaaaa', 'emp@acme.test',    '$argon2id$v=19$m=65536,t=3,p=4$PptJ6PQCqRV3Ybv7TpvpQA$IZYjnfiP5xKeNTubE5gFh6Ki2eqOR1GJ8q8QICNwIG0', '에이스 직원',   now()),
    ('bbbbbbbb-0001-0001-0001-bbbbbbbbbbbb', 'admin@beta.test',  '$argon2id$v=19$m=65536,t=3,p=4$9R4CMOu4g/KE0oyQGsZkyA$bf14Dco+8qNsmf6MCFLiKLgu6a5eQm55kagvbdNvsI0', '베타 어드민',   now()),
    ('bbbbbbbb-0002-0002-0002-bbbbbbbbbbbb', 'emp@beta.test',    '$argon2id$v=19$m=65536,t=3,p=4$aKVjfxX66LVQyLztPKPibw$amDLHRojtzPjRhxhEGAUX2ynlzdUa6IJpxbDmCZk+b4', '베타 직원',     now())
ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    password_hash = EXCLUDED.password_hash,
    name = EXCLUDED.name,
    email_verified_at = EXCLUDED.email_verified_at,
    updated_at = now();

-- Memberships — RLS-enforced. Set the GUC per org so WITH CHECK passes.
SET LOCAL app.org_id = '11111111-1111-1111-1111-111111111111';
INSERT INTO memberships (id, org_id, user_id, role)
VALUES
    ('cccccccc-0001-0001-0001-cccccccccccc', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa', 'admin'),
    ('cccccccc-0002-0002-0002-cccccccccccc', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0002-0002-0002-aaaaaaaaaaaa', 'employee')
ON CONFLICT (id) DO NOTHING;

SET LOCAL app.org_id = '22222222-2222-2222-2222-222222222222';
INSERT INTO memberships (id, org_id, user_id, role)
VALUES
    ('dddddddd-0001-0001-0001-dddddddddddd', '22222222-2222-2222-2222-222222222222', 'bbbbbbbb-0001-0001-0001-bbbbbbbbbbbb', 'admin'),
    ('dddddddd-0002-0002-0002-dddddddddddd', '22222222-2222-2222-2222-222222222222', 'bbbbbbbb-0002-0002-0002-bbbbbbbbbbbb', 'employee')
ON CONFLICT (id) DO NOTHING;

COMMIT;

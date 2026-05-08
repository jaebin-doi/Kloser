-- Phase 1 Step 3 — auth sessions enrichment.
-- Adds the columns needed to (a) make multi-org refresh unambiguous
-- (org_id, membership_id) and (b) support refresh-token rotation with
-- family-level reuse detection (token_family_id, replaced_by_session_id,
-- last_used_at, revoked_reason).
--
-- The sessions table is empty at this point (Step 1 seed never inserts
-- session rows), so adding NOT NULL columns without a backfill is safe.

-- Up Migration
-- ============================================================================

ALTER TABLE sessions
  ADD COLUMN org_id                 uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ADD COLUMN membership_id          uuid        NOT NULL REFERENCES memberships(id)   ON DELETE CASCADE,
  ADD COLUMN token_family_id        uuid        NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN replaced_by_session_id uuid        REFERENCES sessions(id) ON DELETE SET NULL,
  ADD COLUMN last_used_at           timestamptz,
  ADD COLUMN revoked_reason         text;

-- Refresh rotation looks up the whole family to revoke on reuse detection.
CREATE INDEX sessions_token_family_id_idx ON sessions(token_family_id);

-- Auth queries that enumerate a user's live sessions ("active sessions
-- for this user") want a partial index that ignores revoked rows.
CREATE INDEX sessions_active_user_idx ON sessions(user_id, expires_at)
  WHERE revoked_at IS NULL;


-- Down Migration
-- ============================================================================

DROP INDEX IF EXISTS sessions_active_user_idx;
DROP INDEX IF EXISTS sessions_token_family_id_idx;

ALTER TABLE sessions
  DROP COLUMN IF EXISTS revoked_reason,
  DROP COLUMN IF EXISTS last_used_at,
  DROP COLUMN IF EXISTS replaced_by_session_id,
  DROP COLUMN IF EXISTS token_family_id,
  DROP COLUMN IF EXISTS membership_id,
  DROP COLUMN IF EXISTS org_id;

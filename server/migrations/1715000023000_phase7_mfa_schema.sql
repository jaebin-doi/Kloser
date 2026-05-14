-- Phase 7 Step 2 - MFA / session hardening schema.
--
-- Adds the minimum DB surface for TOTP-first MFA:
--   - per-user encrypted TOTP secret fields
--   - per-org MFA-required toggle
--   - auth_tokens purpose='mfa_challenge'
--   - sessions.mfa_verified_at / mfa_method audit fields
--
-- No route/service behavior changes in this migration. Follow-up commits wire
-- repositories, auth routes, shared types, and frontend flows.

-- Up Migration
-- ============================================================================

ALTER TABLE users
  ADD COLUMN mfa_secret_ciphertext text,
  ADD COLUMN mfa_secret_iv         text,
  ADD COLUMN mfa_secret_tag        text,
  ADD COLUMN mfa_secret_key_version int NOT NULL DEFAULT 1,
  ADD COLUMN mfa_enabled_at        timestamptz,
  ADD COLUMN mfa_failed_attempt_count int NOT NULL DEFAULT 0,
  ADD COLUMN mfa_locked_until      timestamptz,
  ADD CONSTRAINT users_mfa_secret_all_or_none_check
    CHECK (
      (mfa_secret_ciphertext IS NULL AND mfa_secret_iv IS NULL AND mfa_secret_tag IS NULL)
      OR
      (mfa_secret_ciphertext IS NOT NULL AND mfa_secret_iv IS NOT NULL AND mfa_secret_tag IS NOT NULL)
    ),
  ADD CONSTRAINT users_mfa_enabled_requires_secret_check
    CHECK (
      mfa_enabled_at IS NULL
      OR
      (mfa_secret_ciphertext IS NOT NULL AND mfa_secret_iv IS NOT NULL AND mfa_secret_tag IS NOT NULL)
    ),
  ADD CONSTRAINT users_mfa_secret_key_version_check
    CHECK (mfa_secret_key_version >= 1),
  ADD CONSTRAINT users_mfa_failed_attempt_count_check
    CHECK (mfa_failed_attempt_count >= 0);

CREATE INDEX users_mfa_enabled_idx ON users (id)
  WHERE mfa_enabled_at IS NOT NULL AND disabled_at IS NULL;

ALTER TABLE organizations
  ADD COLUMN mfa_required boolean NOT NULL DEFAULT false;

ALTER TABLE sessions
  ADD COLUMN mfa_verified_at timestamptz,
  ADD COLUMN mfa_method text,
  ADD CONSTRAINT sessions_mfa_method_check
    CHECK (
      mfa_method IS NULL
      OR mfa_method IN ('totp', 'webauthn', 'recovery_code')
    ),
  ADD CONSTRAINT sessions_mfa_method_requires_verified_at_check
    CHECK (
      mfa_method IS NULL
      OR mfa_verified_at IS NOT NULL
    );

CREATE INDEX sessions_mfa_verified_user_idx ON sessions (user_id, mfa_verified_at DESC)
  WHERE revoked_at IS NULL AND mfa_verified_at IS NOT NULL;

ALTER TABLE auth_tokens
  DROP CONSTRAINT IF EXISTS auth_tokens_purpose_check;

ALTER TABLE auth_tokens
  ADD CONSTRAINT auth_tokens_purpose_check
    CHECK (purpose IN ('email_verification','password_reset','invitation','mfa_challenge'));

-- Existing auth_tokens_invitation_purpose_check already allows every
-- non-invitation purpose to carry user_id and no invitation_id, so
-- mfa_challenge fits that branch without changing the lock/lookup model.


-- Down Migration
-- ============================================================================

ALTER TABLE auth_tokens
  DROP CONSTRAINT IF EXISTS auth_tokens_purpose_check;

ALTER TABLE auth_tokens
  ADD CONSTRAINT auth_tokens_purpose_check
    CHECK (purpose IN ('email_verification','password_reset','invitation'));

DROP INDEX IF EXISTS sessions_mfa_verified_user_idx;

ALTER TABLE sessions
  DROP CONSTRAINT IF EXISTS sessions_mfa_method_requires_verified_at_check,
  DROP CONSTRAINT IF EXISTS sessions_mfa_method_check,
  DROP COLUMN IF EXISTS mfa_method,
  DROP COLUMN IF EXISTS mfa_verified_at;

ALTER TABLE organizations
  DROP COLUMN IF EXISTS mfa_required;

DROP INDEX IF EXISTS users_mfa_enabled_idx;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_mfa_failed_attempt_count_check,
  DROP CONSTRAINT IF EXISTS users_mfa_secret_key_version_check,
  DROP CONSTRAINT IF EXISTS users_mfa_enabled_requires_secret_check,
  DROP CONSTRAINT IF EXISTS users_mfa_secret_all_or_none_check,
  DROP COLUMN IF EXISTS mfa_locked_until,
  DROP COLUMN IF EXISTS mfa_failed_attempt_count,
  DROP COLUMN IF EXISTS mfa_enabled_at,
  DROP COLUMN IF EXISTS mfa_secret_key_version,
  DROP COLUMN IF EXISTS mfa_secret_tag,
  DROP COLUMN IF EXISTS mfa_secret_iv,
  DROP COLUMN IF EXISTS mfa_secret_ciphertext;

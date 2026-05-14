/* MFA user repository — Phase 7 Step 2.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_2_PLAN.md §3.3.
 *
 * `users` is intentionally NOT row-level-security scoped (a user belongs
 * to many orgs). Org isolation for MFA happens at the service layer by
 * verifying the actor's membership in the current org before invoking
 * these helpers. Every function therefore takes an explicit `userId`.
 *
 * The migration `1715000023000_phase7_mfa_schema.sql` enforces:
 *
 *   users_mfa_secret_all_or_none_check
 *     all three of (ciphertext, iv, tag) are NULL together or all set.
 *   users_mfa_enabled_requires_secret_check
 *     `mfa_enabled_at IS NOT NULL` implies the secret triple is set.
 *   users_mfa_secret_key_version_check
 *     key_version >= 1.
 *   users_mfa_failed_attempt_count_check
 *     failed_attempt_count >= 0.
 *
 * These helpers therefore use SQL atomic operations that keep the row
 * legal at every point — e.g. `clearMfa()` nulls the secret triple AND
 * `mfa_enabled_at` in one UPDATE so the "enabled without secret" state
 * is unreachable.
 *
 * Secret bytes themselves never appear in this file. The service layer
 * runs `mfaSecretEncryption.encrypt(rawBytes, key)` and hands us the
 * three base64 fields; we just persist them. The plaintext TOTP secret
 * exists in process memory long enough to render the otpauth URI and is
 * dropped before this repo is called.
 */
import type { PoolClient } from "pg";

export interface MfaState {
  user_id: string;
  has_secret: boolean;
  mfa_secret_ciphertext: string | null;
  mfa_secret_iv: string | null;
  mfa_secret_tag: string | null;
  mfa_secret_key_version: number;
  mfa_enabled_at: Date | null;
  mfa_failed_attempt_count: number;
  mfa_locked_until: Date | null;
}

export interface MfaSecretCiphertext {
  ciphertext: string;
  iv: string;
  tag: string;
  keyVersion: number;
}

const MFA_COLUMNS =
  "id AS user_id," +
  " (mfa_secret_ciphertext IS NOT NULL) AS has_secret," +
  " mfa_secret_ciphertext, mfa_secret_iv, mfa_secret_tag," +
  " mfa_secret_key_version, mfa_enabled_at," +
  " mfa_failed_attempt_count, mfa_locked_until";

// Read the full MFA state for a user (encrypted secret + lockout
// counters). Returns null when the user id doesn't exist — callers that
// know the id is real treat that as a server-side invariant violation
// and surface 500.
export async function getMfaState(
  client: PoolClient,
  userId: string,
): Promise<MfaState | null> {
  const r = await client.query<MfaState>(
    `SELECT ${MFA_COLUMNS}
       FROM users
      WHERE id = $1`,
    [userId],
  );
  return r.rows[0] ?? null;
}

// Persist a pending TOTP secret. Used by the "setup" flow: the user has
// generated and scanned a QR code but has not yet confirmed possession
// by entering a valid TOTP code. The secret is stored, but
// `mfa_enabled_at` stays NULL so login flow does not yet require MFA.
//
// The check constraints permit this state: secret-set + enabled NULL is
// the documented "pending" shape. Replacing a pending secret is allowed
// (e.g. user re-runs setup with a fresh QR); replacing an enabled
// secret is also permitted at the DB level — service code is expected to
// gate that path on current-password + current-TOTP confirmation.
export async function storePendingSecret(
  client: PoolClient,
  userId: string,
  secret: MfaSecretCiphertext,
): Promise<void> {
  await client.query(
    `UPDATE users
        SET mfa_secret_ciphertext = $2,
            mfa_secret_iv         = $3,
            mfa_secret_tag        = $4,
            mfa_secret_key_version = $5,
            mfa_enabled_at        = NULL,
            mfa_failed_attempt_count = 0,
            mfa_locked_until      = NULL
      WHERE id = $1`,
    [userId, secret.ciphertext, secret.iv, secret.tag, secret.keyVersion],
  );
}

// Promote a pending secret to enabled. The check constraint
// `users_mfa_enabled_requires_secret_check` rejects this if the secret
// triple is somehow NULL — the rowCount return lets the service detect
// that and 500 instead of silently no-op.
//
// `now` is injectable so the service can choose between server clock and
// transaction-start time; production paths pass `new Date()`.
export async function enableMfa(
  client: PoolClient,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const r = await client.query(
    `UPDATE users
        SET mfa_enabled_at = $2,
            mfa_failed_attempt_count = 0,
            mfa_locked_until = NULL
      WHERE id = $1
        AND mfa_secret_ciphertext IS NOT NULL`,
    [userId, now],
  );
  return r.rowCount ?? 0;
}

// Drop every MFA-related field for a user in one UPDATE: the secret
// triple, key_version (reset to the migration default), enabled_at,
// failed counter, lockout. Service code calls this after verifying
// current password + current TOTP (when MFA was enabled) per plan §2.7.
// Disable in a `mfa_required` org should already have been rejected at
// the route level — this repo does not enforce that policy.
export async function clearMfa(
  client: PoolClient,
  userId: string,
): Promise<void> {
  await client.query(
    `UPDATE users
        SET mfa_secret_ciphertext = NULL,
            mfa_secret_iv         = NULL,
            mfa_secret_tag        = NULL,
            mfa_secret_key_version = 1,
            mfa_enabled_at        = NULL,
            mfa_failed_attempt_count = 0,
            mfa_locked_until      = NULL
      WHERE id = $1`,
    [userId],
  );
}

// Atomically bump the failed-attempt counter and return its new value.
// Service code compares against the lockout threshold (plan §4.4: 5
// wrong attempts → 10 minute lock) and follows up with `setLockedUntil`.
// Combining the bump + threshold check into one round-trip is not done
// here because the threshold lives at the service layer and may change
// per org/policy.
export async function incrementFailedAttempts(
  client: PoolClient,
  userId: string,
): Promise<number> {
  const r = await client.query<{ mfa_failed_attempt_count: number }>(
    `UPDATE users
        SET mfa_failed_attempt_count = mfa_failed_attempt_count + 1
      WHERE id = $1
      RETURNING mfa_failed_attempt_count`,
    [userId],
  );
  return r.rows[0]?.mfa_failed_attempt_count ?? 0;
}

// Zero the counter. Called on every successful TOTP verify so a stale
// run of failures from an earlier session does not haunt a now-working
// user. Also called when an admin manually clears a lockout (Phase 7+).
export async function resetFailedAttempts(
  client: PoolClient,
  userId: string,
): Promise<void> {
  await client.query(
    `UPDATE users
        SET mfa_failed_attempt_count = 0
      WHERE id = $1`,
    [userId],
  );
}

// Set or extend the lockout window. Passing null clears it.
export async function setLockedUntil(
  client: PoolClient,
  userId: string,
  until: Date | null,
): Promise<void> {
  await client.query(
    `UPDATE users SET mfa_locked_until = $2 WHERE id = $1`,
    [userId, until],
  );
}

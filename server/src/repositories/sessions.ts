/* sessions repository.
 *
 * sessions has no RLS. Guard every user-facing query by either
 * refresh_token_hash (opaque secret) or user_id/session id.
 *
 * Phase 7 Step 2 added MFA audit fields: a session created from a
 * password-only login leaves both null; a session created or upgraded by
 * a successful TOTP verify records `mfa_verified_at` + `mfa_method='totp'`.
 * Refresh rotation copies these from the leased session into its
 * replacement so the MFA fact is durable across rotation chains.
 */
import type { PoolClient } from "pg";

export type SessionMfaMethod = "totp" | "webauthn" | "recovery_code";

export interface AuthSession {
  id: string;
  user_id: string;
  org_id: string;
  membership_id: string;
  refresh_token_hash: string;
  user_agent: string | null;
  ip: string | null;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
  token_family_id: string;
  replaced_by_session_id: string | null;
  last_used_at: Date | null;
  revoked_reason: string | null;
  // Phase 7 Step 2 — null on password-only sessions. Non-null when the
  // session was created from (or upgraded by) an MFA factor.
  mfa_verified_at: Date | null;
  mfa_method: SessionMfaMethod | null;
}

const SESSION_COLUMNS =
  "id, user_id, org_id, membership_id, refresh_token_hash, user_agent, ip," +
  " expires_at, revoked_at, created_at, token_family_id," +
  " replaced_by_session_id, last_used_at, revoked_reason," +
  " mfa_verified_at, mfa_method";

export interface CreateSessionInput {
  userId: string;
  orgId: string;
  membershipId: string;
  refreshTokenHash: string;
  expiresAt: Date;
  userAgent?: string | null;
  ip?: string | null;
  tokenFamilyId?: string;
  // Phase 7 Step 2 — caller-provided when the session is being created as
  // MFA-verified from the start (login → TOTP success path), OR when a
  // refresh rotation is copying MFA fields from the old session into the
  // replacement. Both must be either both null/undefined or both set; the
  // DB check constraint `sessions_mfa_method_requires_verified_at_check`
  // rejects `(mfa_method='totp', mfa_verified_at IS NULL)` either way.
  mfaVerifiedAt?: Date | null;
  mfaMethod?: SessionMfaMethod | null;
}

export async function createSession(
  client: PoolClient,
  input: CreateSessionInput,
): Promise<AuthSession> {
  // The DB check `sessions_mfa_method_requires_verified_at_check` rejects
  // (method='totp', verified_at IS NULL) but accepts the inverse
  // (verified_at set, method NULL) — that legal-at-DB state would still
  // be a silent caller bug because the audit row carries a timestamp
  // with no method label, which is exactly the shape we cannot recover
  // from later. Enforce both-or-neither at the repository boundary so
  // every call site is forced to be explicit.
  //
  // null and undefined are treated identically: both mean "no MFA on this
  // session". Caller passes either both null/undefined or both set.
  const verifiedAtProvided =
    input.mfaVerifiedAt !== undefined && input.mfaVerifiedAt !== null;
  const methodProvided =
    input.mfaMethod !== undefined && input.mfaMethod !== null;
  if (verifiedAtProvided !== methodProvided) {
    throw new Error(
      "createSession: mfaVerifiedAt and mfaMethod must be set together or both null",
    );
  }

  const cols = [
    "user_id",
    "org_id",
    "membership_id",
    "refresh_token_hash",
    "expires_at",
    "user_agent",
    "ip",
  ];
  const values: unknown[] = [
    input.userId,
    input.orgId,
    input.membershipId,
    input.refreshTokenHash,
    input.expiresAt,
    input.userAgent ?? null,
    input.ip ?? null,
  ];

  if (input.tokenFamilyId) {
    cols.push("token_family_id");
    values.push(input.tokenFamilyId);
  }

  // Both MFA columns flip together (see pairing check above). Omit when
  // neither is set so the column defaults (NULL) keep the
  // password-only-session shape.
  if (verifiedAtProvided && methodProvided) {
    cols.push("mfa_verified_at", "mfa_method");
    values.push(input.mfaVerifiedAt, input.mfaMethod);
  }

  const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");
  const r = await client.query<AuthSession>(
    `INSERT INTO sessions (${cols.join(", ")})
     VALUES (${placeholders})
     RETURNING ${SESSION_COLUMNS}`,
    values,
  );
  return r.rows[0]!;
}

export async function findByRefreshTokenHashForUpdate(
  client: PoolClient,
  refreshTokenHash: string,
): Promise<AuthSession | null> {
  const r = await client.query<AuthSession>(
    `SELECT ${SESSION_COLUMNS}
       FROM sessions
      WHERE refresh_token_hash = $1
      FOR UPDATE`,
    [refreshTokenHash],
  );
  return r.rows[0] ?? null;
}

export async function getByIdForUpdate(
  client: PoolClient,
  sessionId: string,
): Promise<AuthSession | null> {
  const r = await client.query<AuthSession>(
    `SELECT ${SESSION_COLUMNS}
       FROM sessions
      WHERE id = $1
      FOR UPDATE`,
    [sessionId],
  );
  return r.rows[0] ?? null;
}

export async function revokeSession(
  client: PoolClient,
  input: { sessionId: string; reason: string; replacedBySessionId?: string },
): Promise<void> {
  await client.query(
    `UPDATE sessions
        SET revoked_at = COALESCE(revoked_at, now()),
            revoked_reason = COALESCE(revoked_reason, $2),
            replaced_by_session_id = COALESCE(replaced_by_session_id, $3)
      WHERE id = $1`,
    [input.sessionId, input.reason, input.replacedBySessionId ?? null],
  );
}

export async function revokeTokenFamily(
  client: PoolClient,
  input: { tokenFamilyId: string; reason: string },
): Promise<void> {
  await client.query(
    `UPDATE sessions
        SET revoked_at = COALESCE(revoked_at, now()),
            revoked_reason = COALESCE(revoked_reason, $2)
      WHERE token_family_id = $1`,
    [input.tokenFamilyId, input.reason],
  );
}

export async function touchLastUsed(
  client: PoolClient,
  sessionId: string,
): Promise<void> {
  await client.query(
    "UPDATE sessions SET last_used_at = now() WHERE id = $1",
    [sessionId],
  );
}

// Phase 7 Step 2 — upgrade an existing session to MFA-verified state.
// Used by the TOTP confirm path when the user enables MFA from inside an
// already-authenticated session: that session retains its refresh family
// and id but starts carrying mfa_verified_at + mfa_method.
//
// The WHERE intentionally excludes revoked sessions (`revoked_at IS NULL`)
// — a logged-out or rotated-away session has no business gaining a fresh
// MFA-verified stamp. Without that guard a stale session id (e.g. from
// a forgotten browser tab whose refresh was already rotated out) could
// be silently upgraded, polluting the audit trail with a verified
// timestamp on a session the user no longer holds.
//
// `now` is injectable so the update timestamp can be made deterministic
// for tests; production callers pass `new Date()`.
//
// Returns the rowCount so callers can detect "session not found OR
// already revoked" without a separate SELECT. The DB check constraint
// `sessions_mfa_method_requires_verified_at_check` keeps the two MFA
// columns atomically paired.
export async function markMfaVerified(
  client: PoolClient,
  input: { sessionId: string; method: SessionMfaMethod; now?: Date },
): Promise<number> {
  const r = await client.query(
    `UPDATE sessions
        SET mfa_verified_at = $2,
            mfa_method = $3
      WHERE id = $1
        AND revoked_at IS NULL`,
    [input.sessionId, input.now ?? new Date(), input.method],
  );
  return r.rowCount ?? 0;
}

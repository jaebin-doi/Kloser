/* sessions repository.
 *
 * sessions has no RLS. Guard every user-facing query by either
 * refresh_token_hash (opaque secret) or user_id/session id.
 */
import type { PoolClient } from "pg";

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
}

const SESSION_COLUMNS =
  "id, user_id, org_id, membership_id, refresh_token_hash, user_agent, ip," +
  " expires_at, revoked_at, created_at, token_family_id," +
  " replaced_by_session_id, last_used_at, revoked_reason";

export async function createSession(
  client: PoolClient,
  input: {
    userId: string;
    orgId: string;
    membershipId: string;
    refreshTokenHash: string;
    expiresAt: Date;
    userAgent?: string | null;
    ip?: string | null;
    tokenFamilyId?: string;
  },
): Promise<AuthSession> {
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

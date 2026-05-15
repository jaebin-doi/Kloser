/* users repository.
 *
 * users does NOT have RLS — a single user may belong to many orgs and
 * the table cannot be scoped to one. Cross-org isolation is enforced by
 * joining `memberships`, which IS RLS-scoped to the current app.org_id.
 *
 * The exposed surface is intentionally narrow:
 *   listForCurrentOrg(client)              → users that have a membership
 *                                              in the current org.
 *   getByIdInCurrentOrg(client, userId)    → a user, only if they have a
 *                                              membership in the current
 *                                              org.
 *
 * No `list()` or plain `getById()` — those would let one org enumerate or
 * lookup users that belong to another org. password_hash is excluded from
 * the result type; auth-side queries that need it (Step 3) will do their
 * own SELECT against the table directly.
 */
import type { PoolClient } from "pg";

export interface User {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  email_verified_at: Date | null;
  mfa_enabled_at: Date | null;
  disabled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const USER_COLUMNS =
  "u.id, u.email, u.name, u.avatar_url, u.email_verified_at," +
  " u.mfa_enabled_at, u.disabled_at, u.created_at, u.updated_at";

export async function listForCurrentOrg(client: PoolClient): Promise<User[]> {
  const r = await client.query<User>(
    `SELECT ${USER_COLUMNS}
       FROM users u
       JOIN memberships m ON m.user_id = u.id
       ORDER BY u.created_at`,
  );
  return r.rows;
}

export async function getByIdInCurrentOrg(
  client: PoolClient,
  userId: string,
): Promise<User | null> {
  const r = await client.query<User>(
    `SELECT ${USER_COLUMNS}
       FROM users u
       JOIN memberships m ON m.user_id = u.id
       WHERE u.id = $1`,
    [userId],
  );
  return r.rows[0] ?? null;
}

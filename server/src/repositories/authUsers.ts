/* Auth-only users repository.
 *
 * The regular users repository intentionally excludes password_hash. Auth is
 * the one place that may read it, and only for signup/login flows.
 */
import type { PoolClient } from "pg";

export interface AuthUser {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  avatar_url: string | null;
  email_verified_at: Date | null;
  disabled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface PublicAuthUser {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  email_verified_at: Date | null;
}

export async function getByEmailWithPasswordHash(
  client: PoolClient,
  email: string,
): Promise<AuthUser | null> {
  const r = await client.query<AuthUser>(
    `SELECT id, email, password_hash, name, avatar_url, email_verified_at,
            disabled_at, created_at, updated_at
       FROM users
      WHERE email = $1`,
    [email],
  );
  return r.rows[0] ?? null;
}

export async function createUserWithPasswordHash(
  client: PoolClient,
  input: { email: string; passwordHash: string; name: string },
): Promise<AuthUser> {
  const r = await client.query<AuthUser>(
    `INSERT INTO users (email, password_hash, name)
     VALUES ($1, $2, $3)
     RETURNING id, email, password_hash, name, avatar_url, email_verified_at,
               disabled_at, created_at, updated_at`,
    [input.email, input.passwordHash, input.name],
  );
  return r.rows[0]!;
}

export function toPublicAuthUser(user: AuthUser): PublicAuthUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatar_url: user.avatar_url,
    email_verified_at: user.email_verified_at,
  };
}

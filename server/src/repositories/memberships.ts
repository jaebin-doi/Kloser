/* memberships repository.
 *
 * memberships has RLS FORCED with policy
 *   USING / WITH CHECK (org_id = current_app_org_id())
 * so a connection running inside withOrgContext sees only its own org's
 * rows automatically. No explicit org_id filter needed in queries.
 */
import type { PoolClient } from "pg";

export type MembershipRole = "admin" | "manager" | "employee" | "viewer";

export interface Membership {
  id: string;
  org_id: string;
  user_id: string;
  role: MembershipRole;
  team_id: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export async function getById(
  client: PoolClient,
  id: string,
): Promise<Membership | null> {
  const r = await client.query<Membership>(
    "SELECT id, org_id, user_id, role, team_id, status, created_at, updated_at" +
    " FROM memberships WHERE id = $1",
    [id],
  );
  return r.rows[0] ?? null;
}

export async function listForCurrentOrg(
  client: PoolClient,
): Promise<Membership[]> {
  const r = await client.query<Membership>(
    "SELECT id, org_id, user_id, role, team_id, status, created_at, updated_at" +
    " FROM memberships ORDER BY created_at",
  );
  return r.rows;
}

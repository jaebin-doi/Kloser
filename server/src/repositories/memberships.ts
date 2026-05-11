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

// ----- Phase 3 Step 4 ---------------------------------------------------- //

export interface MemberRow {
  id: string;
  role: MembershipRole;
  status: "active" | "disabled";
  team_id: string | null;
  team_name: string | null;
  user_id: string;
  user_email: string;
  user_name: string;
  user_email_verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** GET /team/members feed — joins user (always) and team (left join, may
 *  be NULL). RLS scopes both memberships and teams to the current org. */
export async function listForCurrentOrgWithUser(
  client: PoolClient,
): Promise<MemberRow[]> {
  const r = await client.query<MemberRow>(
    `SELECT m.id, m.role, m.status, m.team_id,
            t.name AS team_name,
            u.id    AS user_id,
            u.email AS user_email,
            u.name  AS user_name,
            u.email_verified_at AS user_email_verified_at,
            m.created_at, m.updated_at
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN teams t ON t.id = m.team_id
      ORDER BY m.created_at`,
  );
  return r.rows;
}

/** Single-row lookup with FOR UPDATE — used by updateMembership to take
 *  a row-level lock on the target before mutating. */
export async function getByIdForUpdate(
  client: PoolClient,
  id: string,
): Promise<Membership | null> {
  const r = await client.query<Membership>(
    "SELECT id, org_id, user_id, role, team_id, status, created_at, updated_at" +
    " FROM memberships WHERE id = $1 FOR UPDATE",
    [id],
  );
  return r.rows[0] ?? null;
}

/** Locks every active admin row in the current org and returns their ids.
 *  ORDER BY id makes the lock acquisition deterministic so two concurrent
 *  callers grab rows in the same sequence — no cross-row deadlock.
 *  See plan §1-3 / §3 for the "last admin protection" pattern. */
export async function lockActiveAdminIds(client: PoolClient): Promise<string[]> {
  const r = await client.query<{ id: string }>(
    `SELECT id FROM memberships
      WHERE role = 'admin' AND status = 'active'
      ORDER BY id
      FOR UPDATE`,
  );
  return r.rows.map((row) => row.id);
}

/** Applies role / status patch and returns the updated row. memberships
 *  has no touch_updated_at trigger (Phase 2's trigger is customers-only),
 *  so we set updated_at = now() explicitly here.
 *  At least one of role / status must be set — the caller (service) is
 *  responsible for that precondition (zod refine on MembershipPatchInput). */
export async function updateRoleStatus(
  client: PoolClient,
  id: string,
  patch: { role?: MembershipRole; status?: "active" | "disabled" },
): Promise<Membership | null> {
  // Build a dynamic SET clause so callers can patch role only, status
  // only, or both. pg parameterises every value — no string concat of
  // user input.
  const sets: string[] = ["updated_at = now()"];
  const args: unknown[] = [];
  if (patch.role !== undefined) {
    args.push(patch.role);
    sets.push(`role = $${args.length}`);
  }
  if (patch.status !== undefined) {
    args.push(patch.status);
    sets.push(`status = $${args.length}`);
  }
  if (args.length === 0) return null; // defensive — no real change requested

  args.push(id);
  const r = await client.query<Membership>(
    `UPDATE memberships SET ${sets.join(", ")}
      WHERE id = $${args.length}
      RETURNING id, org_id, user_id, role, team_id, status, created_at, updated_at`,
    args,
  );
  return r.rows[0] ?? null;
}

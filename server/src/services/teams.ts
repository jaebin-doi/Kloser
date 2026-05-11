/* Teams service.
 *
 * Phase 3 Step 4. Plan: docs/plan/phase-3/PHASE_3_STEP_4_TEAM_MEMBER_API.md §4.
 *
 * Four functions covering the CRUD surface plus two invariants:
 *
 *   - managerId, when set, must be a user with an active membership in
 *     the SAME org. Cross-org pollution is caught at the service layer
 *     (the FK only points at users(id), which is global).
 *
 *   - DELETE pre-clears memberships.team_id before hitting `DELETE FROM
 *     teams`. The Phase 1 composite FK
 *         (org_id, team_id) → teams(org_id, id) ON DELETE SET NULL
 *     would otherwise try to NULL org_id too (composite SET NULL applies
 *     to every referencing column) and fail the NOT NULL constraint on
 *     memberships.org_id. Service pre-cleanup keeps schema migrations
 *     out of Phase 3.
 *
 * RLS is enforced because every public function runs inside the caller's
 * withOrgContext transaction. Cross-org reads / writes are hidden by the
 * policy; the service surfaces them as 404.
 */
import type { PoolClient } from "pg";
import { AuthError } from "./auth.js";

export interface Team {
  id: string;
  org_id: string;
  name: string;
  manager_id: string | null;
  created_at: Date;
  updated_at: Date;
}

const TEAM_COLUMNS =
  "id, org_id, name, manager_id, created_at, updated_at";

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export async function listTeams(client: PoolClient): Promise<Team[]> {
  const r = await client.query<Team>(
    `SELECT ${TEAM_COLUMNS} FROM teams ORDER BY created_at`,
  );
  return r.rows;
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

export interface CreateTeamInput {
  name: string;
  managerId?: string | null;
}

export async function createTeam(
  client: PoolClient,
  orgId: string,
  input: CreateTeamInput,
): Promise<Team> {
  const managerId = input.managerId ?? null;
  if (managerId !== null) {
    await assertActiveMemberInCurrentOrg(client, managerId);
  }
  // org_id is NOT NULL with no default in Phase 1 schema. We pass it
  // explicitly (mirrors customers.insertInCurrentOrg's signature) instead
  // of relying on current_setting('app.org_id') inside the INSERT so the
  // contract is visible in TypeScript.
  const r = await client.query<Team>(
    `INSERT INTO teams (org_id, name, manager_id)
     VALUES ($1, $2, $3)
     RETURNING ${TEAM_COLUMNS}`,
    [orgId, input.name, managerId],
  );
  return r.rows[0]!;
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

export interface UpdateTeamInput {
  name?: string;
  managerId?: string | null;
}

export async function updateTeam(
  client: PoolClient,
  teamId: string,
  patch: UpdateTeamInput,
): Promise<Team> {
  if (patch.managerId !== undefined && patch.managerId !== null) {
    await assertActiveMemberInCurrentOrg(client, patch.managerId);
  }

  const sets: string[] = ["updated_at = now()"];
  const args: unknown[] = [];
  if (patch.name !== undefined) {
    args.push(patch.name);
    sets.push(`name = $${args.length}`);
  }
  if (patch.managerId !== undefined) {
    args.push(patch.managerId);
    sets.push(`manager_id = $${args.length}`);
  }
  if (args.length === 0) {
    // Schema validation should have caught this — defensive.
    throw new AuthError(400, "invalid_input", "no fields to update");
  }
  args.push(teamId);
  const r = await client.query<Team>(
    `UPDATE teams SET ${sets.join(", ")}
      WHERE id = $${args.length}
      RETURNING ${TEAM_COLUMNS}`,
    args,
  );
  if (r.rows.length === 0) {
    throw new AuthError(404, "not_found", "team not found");
  }
  return r.rows[0]!;
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

export async function deleteTeam(
  client: PoolClient,
  teamId: string,
): Promise<void> {
  // Pre-clear memberships.team_id. Phase 1 composite FK
  //   (org_id, team_id) → teams(org_id, id) ON DELETE SET NULL
  // would otherwise try to NULL both referencing columns at cascade time
  // and fail because memberships.org_id is NOT NULL. RLS scopes this
  // UPDATE to the current org automatically.
  await client.query(
    `UPDATE memberships SET team_id = NULL, updated_at = now()
      WHERE team_id = $1`,
    [teamId],
  );
  const r = await client.query(
    `DELETE FROM teams WHERE id = $1`,
    [teamId],
  );
  if (r.rowCount === 0) {
    throw new AuthError(404, "not_found", "team not found");
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Throws 400 invalid_manager if userId is not an active member of the
 *  current org. RLS enforces the "current org" scoping. */
async function assertActiveMemberInCurrentOrg(
  client: PoolClient,
  userId: string,
): Promise<void> {
  const r = await client.query<{ one: number }>(
    `SELECT 1 AS one FROM memberships
      WHERE user_id = $1 AND status = 'active'
      LIMIT 1`,
    [userId],
  );
  if (r.rows.length === 0) {
    throw new AuthError(400, "invalid_manager",
      "manager is not an active member of this organization");
  }
}

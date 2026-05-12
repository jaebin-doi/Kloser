/* Call mutation permission helper — Phase 5 Step 2.
 *
 * Phase 4 used route-local checks ("is this employee touching their own
 * call?"). Phase 5 introduces manager team-scope mutation: a manager
 * may write to any call whose agent shares their (non-null) team_id,
 * but not to calls of other teams or unassigned calls.
 *
 * We do *not* lower this to RLS. Read scope stays org-wide so the
 * dashboard and call list keep working for managers; only mutations
 * narrow to "same team". This module is the single source of truth for
 * the rule so route handlers in Step 3 do not re-implement it.
 *
 * Lookup: same-team check is one SQL round trip against the two
 * memberships rows (actor + agent). Both rows must be in the current
 * org (RLS) AND status='active' AND share the same non-null team_id.
 *
 * Errors are exposed as PermissionError with code 'forbidden'. Step 3
 * route handlers map that to HTTP 403. Missing rows are NOT thrown
 * from here — the caller already resolved the parent call and we trust
 * its agent_user_id field.
 */
import type { PoolClient } from "pg";

export type ActorRole = "admin" | "manager" | "employee" | "viewer";

export interface Actor {
  id: string;
  orgId: string;
  role: ActorRole;
}

export interface CallForPermission {
  agent_user_id: string | null;
}

export class PermissionError extends Error {
  code = "forbidden" as const;
  constructor(message = "forbidden") {
    super(message);
    this.name = "PermissionError";
  }
}

// Returns true when actor and agent are both active members of the
// current org AND share the same non-null team_id. NULL team_id is
// never "same team" — managers without a team cannot touch other agents.
async function isSameTeam(
  client: PoolClient,
  actorUserId: string,
  agentUserId: string,
): Promise<boolean> {
  const r = await client.query<{ same: boolean }>(
    `SELECT (
        SELECT team_id FROM memberships
         WHERE user_id = $1
           AND status = 'active'
           AND team_id IS NOT NULL
       ) = (
        SELECT team_id FROM memberships
         WHERE user_id = $2
           AND status = 'active'
           AND team_id IS NOT NULL
       ) AS same`,
    [actorUserId, agentUserId],
  );
  return r.rows[0]?.same === true;
}

// Throw PermissionError if `actor` may not mutate `call`. The actor is
// trusted to be authenticated and to have its orgId already verified by
// the request middleware. Caller is inside withOrgContext so RLS scopes
// any helper queries we run.
//
// Rules:
//   - admin    : always allowed (within their own org)
//   - viewer   : always denied
//   - employee : allowed only when call.agent_user_id === actor.id
//   - manager  :
//       - denied if call.agent_user_id IS NULL (cannot judge team)
//       - allowed if actor and agent share the same active non-null team
//       - otherwise denied
export async function assertCanMutateCall(
  client: PoolClient,
  actor: Actor,
  call: CallForPermission,
): Promise<void> {
  if (actor.role === "admin") return;
  if (actor.role === "viewer") {
    throw new PermissionError("viewer cannot mutate");
  }
  if (actor.role === "employee") {
    if (call.agent_user_id && call.agent_user_id === actor.id) return;
    throw new PermissionError("employee can only mutate own call");
  }
  if (actor.role === "manager") {
    if (!call.agent_user_id) {
      throw new PermissionError("manager cannot mutate unassigned call");
    }
    // The agent could legally be the manager themselves; allow.
    if (call.agent_user_id === actor.id) return;
    const sameTeam = await isSameTeam(client, actor.id, call.agent_user_id);
    if (sameTeam) return;
    throw new PermissionError("manager team-scope denies this call");
  }
  // Defensive default: unknown role denies. ActorRole is closed today
  // but a forward-compatible deny matches the "viewer cannot mutate"
  // floor.
  throw new PermissionError("unknown role cannot mutate");
}

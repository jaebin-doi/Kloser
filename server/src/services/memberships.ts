/* Membership mutation service.
 *
 * Phase 3 Step 4. Plan: docs/plan/phase-3/PHASE_3_STEP_4_TEAM_MEMBER_API.md §3.
 *
 * Single exported function — `updateMembership` — handles both role and
 * status PATCH paths. Pulls together:
 *
 *   - Last-active-admin protection inside the transaction (locks every
 *     active admin row with ORDER BY id FOR UPDATE so concurrent
 *     mutators serialize deterministically).
 *   - Eager session revoke when a member is disabled — Step 3's pattern
 *     reused. 'admin_disabled' is the revoke reason.
 *   - Eager teams.manager_id cleanup when a manager is disabled.
 *
 * The route gets a single `Membership` back on success, an `AuthError` on
 * any expected failure (404 not_found / 409 last_admin_protected).
 *
 * RLS is enforced because the caller opens withOrgContext(orgId, ...).
 * A membership id from a different org returns null from getByIdForUpdate
 * (RLS hides the row) → AuthError(404).
 */
import type { PoolClient } from "pg";
import { AuthError } from "./auth.js";
import {
  getByIdForUpdate,
  lockActiveAdminIds,
  type Membership,
  type MembershipRole,
  updateRoleStatus,
} from "../repositories/memberships.js";
import {
  recordMembershipRoleChanged,
  recordMembershipStatusChanged,
} from "./activityLog.js";

export interface UpdateMembershipInput {
  membershipId: string;
  patch: {
    role?:   MembershipRole;
    status?: "active" | "disabled";
  };
  // Phase 7 Step 3 — actor for the audit row(s). The route layer pulls
  // it from request.user.id; PATCH /memberships/:id is admin-only so
  // this is always populated by the time we reach the service.
  actorUserId: string;
}

export async function updateMembership(
  client: PoolClient,
  orgId: string,
  input: UpdateMembershipInput,
): Promise<Membership> {
  // 1) Lock the active-admin set first (deterministic order). Locking the
  //    set before the target row keeps the lock-acquisition graph the same
  //    in every concurrent mutator — no cross-row deadlock.
  const adminIds = await lockActiveAdminIds(client);

  // 2) Lock the target row. If it doesn't exist (or RLS hid it because it
  //    belongs to a different org), surface 404.
  const target = await getByIdForUpdate(client, input.membershipId);
  if (!target) {
    throw new AuthError(404, "not_found", "membership not found");
  }

  // 3) Simulate the patch against the active-admin invariant.
  //    "active admin" = role='admin' AND status='active'. If the target
  //    currently satisfies that predicate and the patch breaks it, the
  //    target is leaving the active-admin set — verify the set is not
  //    about to empty.
  const nextRole   = input.patch.role   ?? target.role;
  const nextStatus = input.patch.status ?? target.status;
  const isAdminNow      = target.role === "admin" && target.status === "active";
  const wouldStayAdmin  = nextRole === "admin"  && nextStatus === "active";

  if (isAdminNow && !wouldStayAdmin) {
    const surviving = adminIds.filter((id) => id !== target.id);
    if (surviving.length === 0) {
      throw new AuthError(409, "last_admin_protected",
        "cannot remove the last active admin");
    }
  }

  // 4) Apply the patch.
  const updated = await updateRoleStatus(client, target.id, input.patch);
  if (!updated) {
    throw new AuthError(404, "not_found", "membership not found");
  }

  // 5) Side effects on disable (active → disabled transition only).
  const becameDisabled =
    input.patch.status === "disabled" && target.status === "active";

  if (becameDisabled) {
    // 5a) Revoke every active session for this user in this org. Step 3
    //     password reset uses the same COALESCE pattern so an already-
    //     revoked row keeps its original timestamp / reason.
    await client.query(
      `UPDATE sessions
          SET revoked_at     = COALESCE(revoked_at, now()),
              revoked_reason = COALESCE(revoked_reason, 'admin_disabled')
        WHERE user_id    = $1
          AND org_id     = $2
          AND revoked_at IS NULL`,
      [target.user_id, orgId],
    );
    // 5b) Clear teams.manager_id pointing at this user — a disabled
    //     member must never appear as a team manager. RLS scopes the
    //     UPDATE to the current org; we add the org_id predicate
    //     explicitly so the intent is readable.
    await client.query(
      `UPDATE teams SET manager_id = NULL, updated_at = now()
        WHERE org_id = $2 AND manager_id = $1`,
      [target.user_id, orgId],
    );
  }

  // Phase 7 Step 3 — audit. Only fire helpers for fields that actually
  // changed (a PATCH may send role+status both unchanged from current —
  // route schema disallows fully-empty PATCH but a same-value PATCH
  // still reaches here). Same transaction as the UPDATE, so an audit
  // failure rolls the mutation back together with the writes above —
  // the "high-risk mutation audit must commit together" contract.
  if (input.patch.role !== undefined && input.patch.role !== target.role) {
    await recordMembershipRoleChanged(client, {
      orgId,
      actorUserId:  input.actorUserId,
      membershipId: updated.id,
      fromRole:     target.role,
      toRole:       input.patch.role,
    });
  }
  if (input.patch.status !== undefined && input.patch.status !== target.status) {
    await recordMembershipStatusChanged(client, {
      orgId,
      actorUserId:  input.actorUserId,
      membershipId: updated.id,
      fromStatus:   target.status as ("active" | "disabled"),
      toStatus:     input.patch.status,
    });
  }

  return updated;
}

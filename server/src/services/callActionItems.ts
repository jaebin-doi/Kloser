/* Call action item service — Phase 6 Step 3.
 *
 * Plan: docs/plan/phase-6/PHASE_6_STEP_3_PLAN.md §4.2.
 *
 * Today this module owns only the DELETE flow — create / status /
 * assignee still run through the repository directly from
 * `routes/calls.ts` (Phase 4 pattern). The Step 3 DELETE adds the
 * `assertCanMutateCall` policy (manager team-scope), which means the
 * service has to:
 *
 *   1. Resolve the parent call inside the same `withOrgContext`
 *      transaction so RLS scopes the lookup correctly.
 *   2. Throw `PermissionError` for viewer / employee-non-owner /
 *      manager-other-team / manager-unassigned. The route handler maps
 *      that to HTTP 403. Cross-org / soft-deleted parents collapse to
 *      `false` so the route returns 404 without leaking existence.
 *   3. Hard-delete the action item via the repository helper.
 *
 * No new shared types — the DELETE response is 204 No Content.
 *
 * Future action item workflows (bulk export, archive, audit log) belong
 * in this file too; we keep the entry point centralised so the next
 * sub-step does not re-implement permission checks per route.
 */
import type { FastifyInstance } from "fastify";
import * as actionItemsRepo from "../repositories/callActionItems.js";
import {
  assertCanMutateCall,
  type Actor,
} from "./callPermissions.js";
import { recordActionItemDeleted } from "./activityLog.js";

// Returns true when a row was deleted; false otherwise (missing /
// cross-org / soft-deleted parent / already deleted). Throws
// PermissionError when the caller lacks permission for the parent call.
//
// Race note: between the parent-call lookup and the DELETE another
// transaction may delete the same action item. The DELETE then matches
// 0 rows and we still return false. From the caller's perspective that
// is "already gone" → 404, which is the right answer.
export async function deleteActionItem(
  app: FastifyInstance,
  actor: Actor,
  id: string,
): Promise<boolean> {
  return app.withOrgContext(actor.orgId, actor.id, async (client) => {
    const parent = await actionItemsRepo.getParentCallForActionItem(
      client,
      id,
    );
    if (!parent) return false;
    await assertCanMutateCall(client, actor, {
      agent_user_id: parent.agent_user_id,
    });
    const ok = await actionItemsRepo.deleteByIdInCurrentOrg(client, id);
    if (ok) {
      // Phase 7 Step 3 — audit inside the same tx as the DELETE so a
      // hook-row failure rolls the delete back together. The parent
      // call id comes from the look-up above; it stays meaningful for
      // the auditor even after the row itself is gone.
      await recordActionItemDeleted(client, {
        orgId:        actor.orgId,
        actorUserId:  actor.id,
        actionItemId: id,
        callId:       parent.call_id,
      });
    }
    return ok;
  });
}

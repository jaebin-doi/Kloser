/* Call checklist service — Phase 5 Step 2.
 *
 * Two surfaces:
 *   - initialize: copy the org's active templates into call_checklist_items
 *     for a given call (idempotent on (call_id, template_id)).
 *   - mark: toggle one item between 'open' and 'done', recording the
 *     checker user id when transitioning to 'done'.
 *
 * Mutation flows resolve the parent call first and run assertCanMutateCall
 * so manager team-scope and employee-own-call rules are enforced before
 * any UPDATE touches a row.
 *
 * Template CRUD goes through services/callChecklistTemplates in Step 3.
 * Step 2 only owns the call-side glue.
 */
import type { FastifyInstance } from "fastify";
import * as itemsRepo from "../repositories/callChecklistItems.js";
import {
  assertCanMutateCall,
  type Actor,
} from "./callPermissions.js";
import type {
  CallChecklistItem,
  CallChecklistStatus,
} from "../repositories/callChecklistItems.js";

// Initialize is read-or-create: callable by any same-org user (the call
// detail view triggers it on first open). No team-scope check — the
// list is org-wide read.
export async function initializeChecklistForCall(
  app: FastifyInstance,
  actorOrgId: string,
  callId: string,
): Promise<CallChecklistItem[] | null> {
  return app.withOrgContext(actorOrgId, (client) =>
    itemsRepo.initializeForCallInCurrentOrg(client, callId),
  );
}

export async function listChecklistForCall(
  app: FastifyInstance,
  actorOrgId: string,
  callId: string,
): Promise<CallChecklistItem[] | null> {
  return app.withOrgContext(actorOrgId, (client) =>
    itemsRepo.listByCallInCurrentOrg(client, callId),
  );
}

// Mark one checklist item open/done. Resolves the parent call, runs the
// mutation permission helper, then performs the update. Returns null
// when the item id is invalid or its call is missing/soft-deleted; the
// permission helper throws PermissionError on role/team denial.
export async function markChecklistItem(
  app: FastifyInstance,
  actor: Actor,
  itemId: string,
  status: CallChecklistStatus,
): Promise<CallChecklistItem | null> {
  return app.withOrgContext(actor.orgId, actor.id, async (client) => {
    const parent = await itemsRepo.getParentCallForChecklistItem(
      client,
      itemId,
    );
    if (!parent) return null;
    await assertCanMutateCall(client, actor, {
      agent_user_id: parent.agent_user_id,
    });
    return itemsRepo.markStatusInCurrentOrg(
      client,
      itemId,
      status,
      status === "done" ? actor.id : null,
    );
  });
}

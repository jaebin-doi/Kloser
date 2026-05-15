/* Customer linkage service — Phase 5 Step 2.
 *
 * Bind / unbind a customer to an existing call. Flow:
 *   1. resolve parent call (returns null when missing/cross-org/soft-deleted)
 *   2. assertCanMutateCall (employee-own / manager-team / admin / viewer)
 *   3. repository update — wrong-org customer surfaces as 23503 from
 *      the calls.customer_id composite FK; the linker user id is bound
 *      by calls_customer_linked_by_membership_fk to the actor's org.
 *
 * customer_linked_at / customer_linked_by_user_id stay stamped on
 * unlink too — audit record of who last touched the binding.
 */
import type { FastifyInstance } from "fastify";
import * as callsRepo from "../repositories/calls.js";
import {
  assertCanMutateCall,
  type Actor,
} from "./callPermissions.js";
import type { Call } from "../repositories/calls.js";
import {
  recordCallCustomerLinked,
  recordCallCustomerUnlinked,
} from "./activityLog.js";

export async function linkCustomerToCall(
  app: FastifyInstance,
  actor: Actor,
  callId: string,
  customerId: string,
  linkedAt: Date = new Date(),
): Promise<Call | null> {
  return app.withOrgContext(actor.orgId, actor.id, async (client) => {
    const current = await callsRepo.getByIdInCurrentOrg(client, callId);
    if (!current) return null;
    await assertCanMutateCall(client, actor, {
      agent_user_id: current.agent_user_id,
    });
    const updated = await callsRepo.linkCustomerInCurrentOrg(
      client,
      callId,
      customerId,
      actor.id,
      linkedAt,
    );
    if (updated) {
      // Phase 7 Step 3 — same tx as the UPDATE.
      await recordCallCustomerLinked(client, {
        orgId:       actor.orgId,
        actorUserId: actor.id,
        callId:      updated.id,
        customerId,
      });
    }
    return updated;
  });
}

export async function unlinkCustomerFromCall(
  app: FastifyInstance,
  actor: Actor,
  callId: string,
  linkedAt: Date = new Date(),
): Promise<Call | null> {
  return app.withOrgContext(actor.orgId, actor.id, async (client) => {
    const current = await callsRepo.getByIdInCurrentOrg(client, callId);
    if (!current) return null;
    await assertCanMutateCall(client, actor, {
      agent_user_id: current.agent_user_id,
    });
    // Capture the prior customer_id BEFORE the UPDATE so the audit row
    // can show the auditor what binding was just removed. `current` was
    // fetched in the same transaction so RLS / read-consistency is fine.
    const previousCustomerId = current.customer_id;
    const updated = await callsRepo.linkCustomerInCurrentOrg(
      client,
      callId,
      null,
      actor.id,
      linkedAt,
    );
    if (updated) {
      await recordCallCustomerUnlinked(client, {
        orgId:       actor.orgId,
        actorUserId: actor.id,
        callId:      updated.id,
        previousCustomerId,
      });
    }
    return updated;
  });
}

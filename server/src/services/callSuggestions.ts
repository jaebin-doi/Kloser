/* Call suggestions service — Phase 5 Step 2.
 *
 * Two flows:
 *   - persistSuggestionGroup: server-internal (WS handler / LLM worker
 *     in Step 3+). No actor permission check — the caller already
 *     validated the call exists and is in its own org. We only need
 *     the org context for RLS.
 *   - useSuggestion / dismissSuggestion: user actions, so
 *     assertCanMutateCall is required.
 *
 * The repository row update is conditional on "not already
 * used/dismissed", but we still surface a friendly SuggestionStateError
 * domain error when a duplicate transition is requested, so Step 3
 * routes can return 409 conflict_state instead of a generic 404.
 */
import type { FastifyInstance } from "fastify";
import * as suggestionsRepo from "../repositories/callSuggestions.js";
import {
  assertCanMutateCall,
  type Actor,
} from "./callPermissions.js";
import type {
  CallSuggestion,
  CallSuggestionInput,
} from "../repositories/callSuggestions.js";

export class SuggestionStateError extends Error {
  code = "conflict_state" as const;
  constructor(message: string) {
    super(message);
    this.name = "SuggestionStateError";
  }
}

export async function persistSuggestionGroup(
  app: FastifyInstance,
  actorOrgId: string,
  callId: string,
  items: CallSuggestionInput[],
): Promise<CallSuggestion[] | null> {
  return app.withOrgContext(actorOrgId, (client) =>
    suggestionsRepo.insertGroupForCallInCurrentOrg(client, callId, items),
  );
}

export async function listSuggestionsForCall(
  app: FastifyInstance,
  actorOrgId: string,
  callId: string,
): Promise<CallSuggestion[] | null> {
  return app.withOrgContext(actorOrgId, (client) =>
    suggestionsRepo.listByCallInCurrentOrg(client, callId),
  );
}

// Mark used. Distinguishes "missing" (null) from "already
// used/dismissed" (SuggestionStateError) by reading the row first.
export async function useSuggestion(
  app: FastifyInstance,
  actor: Actor,
  suggestionId: string,
  usedAt: Date = new Date(),
): Promise<CallSuggestion | null> {
  return app.withOrgContext(actor.orgId, actor.id, async (client) => {
    const parent = await suggestionsRepo.getParentCallForSuggestion(
      client,
      suggestionId,
    );
    if (!parent) return null;
    await assertCanMutateCall(client, actor, {
      agent_user_id: parent.agent_user_id,
    });
    const updated = await suggestionsRepo.markUsedInCurrentOrg(
      client,
      suggestionId,
      usedAt,
    );
    if (updated) return updated;
    // Row exists (parent found) but UPDATE matched 0 rows → already
    // used or dismissed. Read once more to confirm.
    const existing = await suggestionsRepo.getByIdInCurrentOrg(
      client,
      suggestionId,
    );
    if (!existing) return null;
    throw new SuggestionStateError(
      existing.used_at
        ? "suggestion already used"
        : "suggestion already dismissed",
    );
  });
}

export async function dismissSuggestion(
  app: FastifyInstance,
  actor: Actor,
  suggestionId: string,
  dismissedAt: Date = new Date(),
): Promise<CallSuggestion | null> {
  return app.withOrgContext(actor.orgId, actor.id, async (client) => {
    const parent = await suggestionsRepo.getParentCallForSuggestion(
      client,
      suggestionId,
    );
    if (!parent) return null;
    await assertCanMutateCall(client, actor, {
      agent_user_id: parent.agent_user_id,
    });
    const updated = await suggestionsRepo.markDismissedInCurrentOrg(
      client,
      suggestionId,
      dismissedAt,
    );
    if (updated) return updated;
    const existing = await suggestionsRepo.getByIdInCurrentOrg(
      client,
      suggestionId,
    );
    if (!existing) return null;
    throw new SuggestionStateError(
      existing.dismissed_at
        ? "suggestion already dismissed"
        : "suggestion already used",
    );
  });
}

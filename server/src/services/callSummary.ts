/* Call summary service — Phase 5 Step 2.
 *
 * Two writers — AI worker and manual user input — share the same four
 * columns (summary, needs, issues, sentiment) but obey opposite
 * overwrite rules:
 *
 *   - AI summary: only writes if the existing summary_source is NULL or
 *     'ai'. Once a user edits the summary (summary_source='manual'),
 *     subsequent AI worker pushes are ignored.
 *   - Manual summary: always overwrites whatever was there and stamps
 *     summary_source='manual'.
 *
 * The repository UPDATEs encode both rules in SQL so a race between an
 * AI worker and a user click can't drop the manual edit.
 *
 * Permission: AI summary is server-internal (no actor). Manual summary
 * goes through assertCanMutateCall so manager team-scope and
 * employee-own-call rules apply.
 */
import type { FastifyInstance } from "fastify";
import * as callsRepo from "../repositories/calls.js";
import {
  assertCanMutateCall,
  type Actor,
} from "./callPermissions.js";
import type {
  Call,
  CallSentiment,
  CallSummaryPatch,
} from "../repositories/calls.js";

export interface GeneratedCallSummary {
  summary: string | null;
  needs: string | null;
  issues: string | null;
  sentiment: CallSentiment | null;
}

// AI writer. Returns null when:
//   - call is missing/soft-deleted, OR
//   - summary_source='manual' (user edit protection); SQL filter rejects
//     the row in the same query so we surface it as "no update happened".
// Caller (LLM worker) treats null as a no-op, not an error.
export async function applyAiSummary(
  app: FastifyInstance,
  actorOrgId: string,
  callId: string,
  generated: GeneratedCallSummary,
  generatedAt: Date = new Date(),
): Promise<Call | null> {
  const patch: CallSummaryPatch = {
    summary: generated.summary,
    needs: generated.needs,
    issues: generated.issues,
    sentiment: generated.sentiment,
  };
  return app.withOrgContext(actorOrgId, (client) =>
    callsRepo.updateAiSummaryInCurrentOrg(client, callId, patch, generatedAt),
  );
}

// Manual writer. Always wins. Stamps summary_source='manual' so any
// queued AI worker push lands as a no-op.
export async function applyManualSummary(
  app: FastifyInstance,
  actor: Actor,
  callId: string,
  patch: CallSummaryPatch,
): Promise<Call | null> {
  return app.withOrgContext(actor.orgId, actor.id, async (client) => {
    const current = await callsRepo.getByIdInCurrentOrg(client, callId);
    if (!current) return null;
    await assertCanMutateCall(client, actor, {
      agent_user_id: current.agent_user_id,
    });
    return callsRepo.updateManualSummaryInCurrentOrg(client, callId, patch);
  });
}

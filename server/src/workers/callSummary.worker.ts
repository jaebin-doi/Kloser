/* AI summary worker — Phase 6 Step 1.
 *
 * Consumes the `call-summary` queue. For each job:
 *   1. Validate `{ orgId, callId }`.
 *   2. Enter `withOrgContext(orgId)` and read the call's transcript text.
 *   3. Ask the resolved LLM adapter (Phase 5 mock by default) to
 *      summarize. The mock returns null fields when transcript is empty
 *      — that is treated as success.
 *   4. Call `callSummary.applyAiSummary(...)` to persist. Manual
 *      summary protection is enforced by repository SQL — if the row
 *      already has `summary_source='manual'`, the UPDATE matches 0
 *      rows and the service returns null, which we treat as a no-op
 *      success.
 *
 * Failure handling:
 *   - Adapter throw / DB throw → BullMQ retries (3 attempts,
 *     exponential backoff per queue defaults). After 3 the job moves
 *     to the failed set and we log; the call is left with summary=NULL.
 *   - Missing call (e.g. cross-org or soft-deleted between endCall and
 *     job pickup) → silent success.
 */
import type { FastifyInstance } from "fastify";
import { Worker, type Job } from "bullmq";
import { getRedisConnection } from "../queue/redis.js";
import {
  CALL_SUMMARY_QUEUE,
  type CallSummaryJobData,
} from "../queue/queues.js";
import { resolveLlmAdapter } from "../adapters/index.js";
import * as callsRepo from "../repositories/calls.js";
import * as transcriptsRepo from "../repositories/transcripts.js";
import * as callSummaryService from "../services/callSummary.js";

// Build a single transcript string from the persisted utterances so
// the LLM has the same view a human would see scrolling the panel.
// Speaker label is dropped to keep the prompt focused on content.
function joinTranscript(rows: { text: string }[]): string {
  return rows.map((r) => r.text).join("\n");
}

export interface CallSummaryJobResult {
  skipped?: boolean;
  reason?: "call_not_found" | "manual_summary_locked";
}

// Exported separately so tests can drive the processor with a synthetic
// `{ data }` Job-shape without needing a live Redis worker loop.
export function makeCallSummaryProcessor(app: FastifyInstance) {
  const llm = resolveLlmAdapter();
  return async function processor(
    job: Pick<Job<CallSummaryJobData>, "data">,
  ): Promise<CallSummaryJobResult> {
    const data = job.data ?? ({} as CallSummaryJobData);
    const orgId = data.orgId;
    const callId = data.callId;
    if (typeof orgId !== "string" || typeof callId !== "string") {
      throw new Error(
        `[callSummary] invalid job payload: expected { orgId, callId }, got ${JSON.stringify(data)}`,
      );
    }

    const transcript = await app.withOrgContext(orgId, async (client) => {
      const call = await callsRepo.getByIdInCurrentOrg(client, callId);
      if (!call) return null;
      const rows = await transcriptsRepo.listByCallInCurrentOrg(client, callId);
      return joinTranscript(rows ?? []);
    });

    if (transcript === null) {
      return { skipped: true, reason: "call_not_found" };
    }

    // Phase 6 Step 2: adapter returns ProviderResult. Usage logging
    // wiring lands in a follow-up commit; for now we just unwrap the
    // domain value so existing summary behaviour is preserved.
    const generated = (await llm.summarizeCall({ transcript })).value;

    const updated = await callSummaryService.applyAiSummary(
      app,
      orgId,
      callId,
      generated,
    );
    return {
      skipped: updated === null,
      reason: updated === null ? "manual_summary_locked" : undefined,
    };
  };
}

export function createCallSummaryWorker(app: FastifyInstance): Worker<CallSummaryJobData> {
  const processor = makeCallSummaryProcessor(app);
  return new Worker<CallSummaryJobData>(
    CALL_SUMMARY_QUEUE,
    async (job) => processor(job),
    {
      connection: getRedisConnection(),
      // Concurrency 1 is safe (mock adapter, single DB pool). Real
      // provider workload tuning happens in Phase 6 Step 2.
      concurrency: 1,
    },
  );
}

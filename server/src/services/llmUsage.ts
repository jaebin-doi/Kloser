/* llm_usage_log service — Phase 6 Step 2.
 *
 * Plan: docs/plan/phase-6/PHASE_6_STEP_2_PLAN.md §6.
 *
 * Wraps the append-only `llm_usage_log` repository with two guarantees:
 *
 *   1. Org-scoped transaction. RLS on the table is FORCE'd, so an
 *      INSERT without `app.org_id` set silently fails the WITH CHECK.
 *      All inserts go through `withOrgContext` here so callers can't
 *      forget the GUC.
 *
 *   2. Logging failure must never fail the original provider call. The
 *      user already paid for the LLM tokens; we record what we can, and
 *      if the INSERT itself trips on a transient DB error we log a warn
 *      and return null. The worker / WS handler / route handler keeps
 *      running on the value it already received from the adapter.
 *
 * This file is intentionally test-driven in Step 2 — the wiring commit
 * (worker / WS / knowledge route) calls `recordProviderUsage` after the
 * adapter returns. Until that lands the production path still ignores
 * the usage envelope, which is fine: `llm_usage_log` is append-only and
 * adding rows later doesn't change any existing behaviour.
 */
import type { FastifyInstance } from "fastify";
import * as llmUsageRepo from "../repositories/llmUsage.js";
import type {
  LlmUsageInsertInput,
  LlmUsageLog,
} from "../repositories/llmUsage.js";
import type { ProviderUsage } from "../adapters/usage.js";

export interface RecordProviderUsageOptions {
  // Extra metadata merged onto the usage envelope. Useful for callers
  // that want to tag rows by feature flag, test prefix, or job id.
  metadata?: Record<string, unknown>;
}

// Bridge the camelCase ProviderUsage shape adapters return into the
// snake_case repository input. Optional fields fall through as null so
// the migration's CHECK constraints accept them.
function toInsertInput(
  callId: string | null,
  usage: ProviderUsage,
  extraMetadata?: Record<string, unknown>,
): LlmUsageInsertInput {
  const mergedMetadata =
    extraMetadata !== undefined || usage.metadata !== undefined
      ? { ...(usage.metadata ?? {}), ...(extraMetadata ?? {}) }
      : null;
  return {
    call_id: callId,
    provider: usage.provider,
    operation: usage.operation,
    model: usage.model,
    status: usage.status,
    tokens_in: usage.tokensIn,
    tokens_out: usage.tokensOut,
    latency_ms: usage.latencyMs,
    cost_usd_micros: usage.costUsdMicros,
    provider_request_id: usage.providerRequestId ?? null,
    error_code: usage.errorCode ?? null,
    metadata: mergedMetadata,
  };
}

// Record one provider invocation. Returns the inserted row on success
// and null when logging fails (the caller still proceeds — the
// upstream LLM/embedding/STT result has already been handed back).
export async function recordProviderUsage(
  app: FastifyInstance,
  actorOrgId: string,
  callId: string | null,
  usage: ProviderUsage,
  opts: RecordProviderUsageOptions = {},
): Promise<LlmUsageLog | null> {
  try {
    return await app.withOrgContext(actorOrgId, (client) =>
      llmUsageRepo.insertInCurrentOrg(
        client,
        actorOrgId,
        toInsertInput(callId, usage, opts.metadata),
      ),
    );
  } catch (err) {
    const log = app.log ?? console;
    const message = (err as Error)?.message ?? String(err);
    log.warn(
      {
        err: message,
        orgId: actorOrgId,
        callId,
        provider: usage.provider,
        operation: usage.operation,
        model: usage.model,
        status: usage.status,
      },
      "llm_usage_log insert failed; original provider flow continues",
    );
    return null;
  }
}

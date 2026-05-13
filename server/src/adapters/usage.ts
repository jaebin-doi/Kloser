/* Adapter usage contract — Phase 6 Step 2.
 *
 * Plan: docs/plan/phase-6/PHASE_6_STEP_2_PLAN.md §4.
 *
 * Adapter methods used to return only their domain output (a summary
 * object, a vector, an utterance). Step 2 needs to record provider
 * cost/latency per call, and that metadata lives at the SDK boundary —
 * not in the service that consumed the result. Storing it in adapter
 * instance state would also race under concurrent requests.
 *
 * `ProviderResult<T>` keeps the domain value and the optional usage
 * envelope together so the caller can `unwrap.value` for the existing
 * behaviour and pass `unwrap.usage` to `services/llmUsage` in the
 * follow-up wiring commit.
 *
 * `provider`, `operation`, and `status` are intentionally aligned with
 * `repositories/llmUsage.ts` enums so the value can flow straight from
 * the adapter into the INSERT without remapping.
 */

import type {
  LlmUsageOperation,
  LlmUsageProvider,
  LlmUsageStatus,
} from "../repositories/llmUsage.js";

export type ProviderName = LlmUsageProvider;
export type ProviderOperation = LlmUsageOperation;
export type ProviderStatus = LlmUsageStatus;

export interface ProviderUsage {
  provider: ProviderName;
  operation: ProviderOperation;
  model: string;
  status: ProviderStatus;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number | null;
  costUsdMicros: number | null;
  providerRequestId?: string | null;
  errorCode?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ProviderResult<T> {
  value: T;
  usage?: ProviderUsage;
}

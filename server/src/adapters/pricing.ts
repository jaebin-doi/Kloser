/* LLM/embedding usage cost map — Phase 7 Step 5.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_5_PLAN.md §3 / §4.1.
 *
 * Adapter boundary helper. Real provider adapters call
 * `calculateUsageCostUsdMicros(...)` from their `makeUsage(...)`
 * factory and let the returned `costUsdMicros` flow straight into the
 * `ProviderUsage` envelope. The `services/llmUsage.ts` repository stays
 * a mechanical pass-through INSERT — provider pricing knowledge lives
 * in exactly one place (this file).
 *
 * Policy (Plan §3.4):
 *   - mock provider               → costUsdMicros = 0,    status='zero'
 *   - real provider, known model, all required tokens     → calculated
 *   - real provider, known model, tokens skipped (0/0)    → 0, 'zero'
 *   - real provider, known model, required tokens missing → null, 'missing_usage'
 *   - real provider, unknown model                        → null, 'unknown_model'
 *   - Clova STT (no audio duration in envelope)           → null, 'unsupported_unit'
 *   - any other unmatched provider/operation combo        → null, 'unsupported_unit'
 *
 * `null` means "this code cannot price the call reliably". It does NOT
 * mean "free / zero cost". The DB column `llm_usage_log.cost_usd_micros`
 * keeps the same semantics: NULL = unknown, 0 = mock-or-skipped.
 *
 * Math (Plan §3.2):
 *   - All internal arithmetic uses `bigint` micro-dollars per million tokens.
 *   - Per-call cost is computed as
 *       ceil(tokens * pricePerMillion / 1_000_000)
 *     with bigint ceiling division so we never lose a fraction of a
 *     micro-dollar to floating-point rounding.
 *   - The final return value is `number`. We assert `Number.isSafeInteger`
 *     on the bigint result before converting; anything above 2^53-1 is
 *     impossible at sane usage levels but the assertion stays as a tripwire.
 *
 * Model matching (Plan §3.3):
 *   - Exact-match only after `model.trim().toLowerCase()` normalisation.
 *   - No alias / prefix / wildcard guessing. If a provider's response
 *     returns a snapshot id we have not catalogued, the row's cost stays
 *     NULL with `status='unknown_model'`. That is the intended trap —
 *     better an admin sees "unknown_model" in the audit metadata than
 *     a guessed cost that turns out to be 10x off in either direction.
 *
 * Price constants are verified against the official provider pricing
 * page on the date stamped in each entry. The plan calls out that
 * pricing drifts; this file is the diff target on any update.
 */

import type {
  ProviderName,
  ProviderOperation,
  ProviderUsage,
} from "./usage.js";

// ============================================================ //
// Public types
// ============================================================ //

export type CostStatus =
  | "calculated"
  | "zero"
  | "unknown_model"
  | "missing_usage"
  | "unsupported_unit";

export interface UsageCostInput {
  provider: ProviderName;
  operation: ProviderOperation;
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
}

export interface UsageCostResult {
  /** Micro-USD cost for this call. NULL when this helper cannot
   *  reliably price it (see CostStatus values for the categories). */
  costUsdMicros: number | null;
  status: CostStatus;
  /** ISO date (YYYY-MM-DD) on which the price constant used here was
   *  last verified against the official provider pricing page.
   *  Undefined for non-calculated results (zero / NULL outcomes).
   *  Operators reading audit metadata can use this to know if a cost
   *  came from a stale snapshot. */
  pricingVerifiedOn?: string;
}

// ============================================================ //
// Validation
// ============================================================ //

export class UsageCostInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageCostInputError";
  }
}

function assertTokenCount(label: string, n: number | null): void {
  if (n === null) return;
  if (
    typeof n !== "number" ||
    !Number.isFinite(n) ||
    !Number.isInteger(n) ||
    n < 0
  ) {
    // Per Plan §4.1: adapter boundary invariant violation — token counts
    // come straight from provider SDK responses, so a non-integer or
    // negative value indicates an adapter parsing bug, not a user
    // condition. Throw so the caller's existing error path runs and the
    // usage row is logged as `status='failed'` rather than persisting
    // a corrupt cost.
    throw new UsageCostInputError(
      `${label} must be null or a non-negative integer, got: ${String(n)}`,
    );
  }
}

// ============================================================ //
// Price map — Anthropic LLM (input + output tokens)
//
// Source: https://platform.claude.com/docs/en/about-claude/pricing
// Verified on: 2026-05-18
//
// The published table is in USD per million tokens ("$ / MTok").
// Stored here as bigint micro-USD per million tokens so the calculator
// can do integer math: micro-USD = USD * 1_000_000.
//
// Aliases ("claude-sonnet-4-5") are the keys the adapter passes when the
// SDK echoes the requested alias. If Anthropic SDK responses ever return
// a dated snapshot id (e.g. "claude-sonnet-4-5-20250929"), the lookup
// will miss and we record `unknown_model` — by design. Add the new
// snapshot key here in the same PR that confirms it from production logs.
// ============================================================ //

interface TokenPrice {
  inputUsdMicrosPerMillionTokens: bigint;
  outputUsdMicrosPerMillionTokens: bigint;
  verifiedOn: string;
  source: string;
}

const ANTHROPIC_PRICE_SOURCE =
  "https://platform.claude.com/docs/en/about-claude/pricing";
const ANTHROPIC_VERIFIED_ON = "2026-05-18";

const ANTHROPIC_LLM_PRICES: Readonly<Record<string, TokenPrice>> = {
  // Default for this product. Sonnet 4.5 and 4.6 share the same rate.
  "claude-sonnet-4-5": {
    inputUsdMicrosPerMillionTokens: 3_000_000n,
    outputUsdMicrosPerMillionTokens: 15_000_000n,
    verifiedOn: ANTHROPIC_VERIFIED_ON,
    source: ANTHROPIC_PRICE_SOURCE,
  },
  "claude-sonnet-4-6": {
    inputUsdMicrosPerMillionTokens: 3_000_000n,
    outputUsdMicrosPerMillionTokens: 15_000_000n,
    verifiedOn: ANTHROPIC_VERIFIED_ON,
    source: ANTHROPIC_PRICE_SOURCE,
  },
  "claude-opus-4-7": {
    inputUsdMicrosPerMillionTokens: 5_000_000n,
    outputUsdMicrosPerMillionTokens: 25_000_000n,
    verifiedOn: ANTHROPIC_VERIFIED_ON,
    source: ANTHROPIC_PRICE_SOURCE,
  },
  "claude-opus-4-6": {
    inputUsdMicrosPerMillionTokens: 5_000_000n,
    outputUsdMicrosPerMillionTokens: 25_000_000n,
    verifiedOn: ANTHROPIC_VERIFIED_ON,
    source: ANTHROPIC_PRICE_SOURCE,
  },
  "claude-opus-4-5": {
    inputUsdMicrosPerMillionTokens: 5_000_000n,
    outputUsdMicrosPerMillionTokens: 25_000_000n,
    verifiedOn: ANTHROPIC_VERIFIED_ON,
    source: ANTHROPIC_PRICE_SOURCE,
  },
  "claude-haiku-4-5": {
    inputUsdMicrosPerMillionTokens: 1_000_000n,
    outputUsdMicrosPerMillionTokens: 5_000_000n,
    verifiedOn: ANTHROPIC_VERIFIED_ON,
    source: ANTHROPIC_PRICE_SOURCE,
  },
};

// ============================================================ //
// Price map — OpenAI embedding (input tokens only)
//
// Source: https://developers.openai.com/api/docs/models/text-embedding-3-small
//         (also https://platform.openai.com/docs/pricing — same number)
// Verified on: 2026-05-18
//
// Embedding requests have no output tokens; `tokensOut` is always 0 in
// the adapter. The calculator multiplies tokensIn against the input
// price only.
// ============================================================ //

const OPENAI_EMBEDDING_PRICE_SOURCE =
  "https://developers.openai.com/api/docs/models/text-embedding-3-small";
const OPENAI_EMBEDDING_VERIFIED_ON = "2026-05-18";

const OPENAI_EMBEDDING_PRICES: Readonly<Record<string, TokenPrice>> = {
  // $0.02 per 1M tokens = 20_000 micro-USD per 1M tokens.
  "text-embedding-3-small": {
    inputUsdMicrosPerMillionTokens: 20_000n,
    outputUsdMicrosPerMillionTokens: 0n,
    verifiedOn: OPENAI_EMBEDDING_VERIFIED_ON,
    source: OPENAI_EMBEDDING_PRICE_SOURCE,
  },
  // $0.13 per 1M tokens = 130_000 micro-USD per 1M tokens.
  "text-embedding-3-large": {
    inputUsdMicrosPerMillionTokens: 130_000n,
    outputUsdMicrosPerMillionTokens: 0n,
    verifiedOn: OPENAI_EMBEDDING_VERIFIED_ON,
    source: OPENAI_EMBEDDING_PRICE_SOURCE,
  },
};

// ============================================================ //
// Math
// ============================================================ //

/** Integer ceiling division: ceil(a / b) for non-negative bigints. */
function bigintCeilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) {
    // Should never happen — prices are positive constants. Kept as a
    // tripwire for future map edits.
    throw new UsageCostInputError("bigintCeilDiv: divisor must be positive");
  }
  return (a + b - 1n) / b;
}

const ONE_MILLION = 1_000_000n;

function bigintToSafeNumber(n: bigint, label: string): number {
  if (n < 0n) {
    throw new UsageCostInputError(`${label} produced a negative result`);
  }
  // Number.MAX_SAFE_INTEGER = 2^53-1 = 9_007_199_254_740_991. A single
  // call at provider-imaginable rates couldn't get near this, but the
  // assertion stays so a future bigger price map can't silently overflow.
  if (n > 9_007_199_254_740_991n) {
    throw new UsageCostInputError(
      `${label} exceeds Number.MAX_SAFE_INTEGER (${n.toString()})`,
    );
  }
  return Number(n);
}

function computeTokenCostMicros(
  tokens: number,
  pricePerMillion: bigint,
): bigint {
  if (tokens === 0 || pricePerMillion === 0n) return 0n;
  const product = BigInt(tokens) * pricePerMillion;
  return bigintCeilDiv(product, ONE_MILLION);
}

// ============================================================ //
// Lookup
// ============================================================ //

function normalizeModelKey(model: string): string {
  return model.trim().toLowerCase();
}

function lookupAnthropicLlmPrice(model: string): TokenPrice | undefined {
  return ANTHROPIC_LLM_PRICES[normalizeModelKey(model)];
}

function lookupOpenAIEmbeddingPrice(model: string): TokenPrice | undefined {
  return OPENAI_EMBEDDING_PRICES[normalizeModelKey(model)];
}

// ============================================================ //
// Public entry point
// ============================================================ //

/** Calculate `costUsdMicros` for one provider call.
 *
 *  Throws `UsageCostInputError` ONLY when an adapter passes a value
 *  that violates the boundary contract (negative / fractional token
 *  count, etc.). All "we can't price this" cases return `{ cost: null,
 *  status: ... }` so the caller can still record a usage row with the
 *  tokens / latency / model intact.
 */
export function calculateUsageCostUsdMicros(
  input: UsageCostInput,
): UsageCostResult {
  assertTokenCount("tokensIn", input.tokensIn);
  assertTokenCount("tokensOut", input.tokensOut);

  // 1. Mock provider — Phase 6 contract: zero cost always.
  if (input.provider === "mock") {
    return { costUsdMicros: 0, status: "zero" };
  }

  // 2. Anthropic LLM (call_summary / call_suggestion).
  if (
    input.provider === "anthropic" &&
    (input.operation === "call_summary" ||
      input.operation === "call_suggestion")
  ) {
    return calculateTokenBasedCost(
      input,
      lookupAnthropicLlmPrice(input.model),
      /* requireOutput */ true,
    );
  }

  // 3. OpenAI embedding (knowledge_embedding).
  if (
    input.provider === "openai" &&
    input.operation === "knowledge_embedding"
  ) {
    return calculateTokenBasedCost(
      input,
      lookupOpenAIEmbeddingPrice(input.model),
      /* requireOutput */ false,
    );
  }

  // 4. Clova STT — per-15-second billing; usage envelope has no audio
  //    duration field yet (Plan §4.4). NULL until that field is added.
  if (input.provider === "clova" && input.operation === "stt_transcribe") {
    return { costUsdMicros: null, status: "unsupported_unit" };
  }

  // 5. Anything else — defensive branch. The compile-time
  //    ProviderName / ProviderOperation unions already constrain inputs,
  //    so this is only reachable if a future provider+operation lands
  //    without a pricing entry. NULL keeps the request flowing.
  return { costUsdMicros: null, status: "unsupported_unit" };
}

function calculateTokenBasedCost(
  input: UsageCostInput,
  price: TokenPrice | undefined,
  requireOutput: boolean,
): UsageCostResult {
  if (!price) {
    return { costUsdMicros: null, status: "unknown_model" };
  }

  // "skipped" calls: adapters set tokensIn=0 / tokensOut=0 when the
  // request was a no-op (empty transcript, empty input). Cost is
  // deterministically 0 for those — distinct from "missing usage"
  // where the provider responded but we couldn't read the counters.
  const skippedZeroTokens =
    input.tokensIn === 0 &&
    (!requireOutput || input.tokensOut === 0);
  if (skippedZeroTokens) {
    return {
      costUsdMicros: 0,
      status: "zero",
      pricingVerifiedOn: price.verifiedOn,
    };
  }

  // Token counts the provider didn't fill in: we can't compute cost.
  // Adapters surface this as `cost_usd_micros = NULL` in the audit row
  // and tag metadata with `cost_status='missing_usage'`.
  if (input.tokensIn === null) {
    return { costUsdMicros: null, status: "missing_usage" };
  }
  if (requireOutput && input.tokensOut === null) {
    return { costUsdMicros: null, status: "missing_usage" };
  }

  const inputCostMicros = computeTokenCostMicros(
    input.tokensIn,
    price.inputUsdMicrosPerMillionTokens,
  );
  const outputCostMicros = requireOutput
    ? computeTokenCostMicros(
        input.tokensOut ?? 0,
        price.outputUsdMicrosPerMillionTokens,
      )
    : 0n;

  const totalMicros = inputCostMicros + outputCostMicros;
  const cost = bigintToSafeNumber(totalMicros, "usage cost micros");

  // Provider can return non-zero tokens but the math still floors to 0
  // micro-USD (e.g. 1 token at $0.02/MTok before ceil). The ceiling
  // makes that produce 1 micro-USD when there are any tokens, so this
  // branch is really for the all-zero edge already handled above. Kept
  // as a defensive classification so the status field stays meaningful
  // when prices ever round to 0.
  if (cost === 0) {
    return {
      costUsdMicros: 0,
      status: "zero",
      pricingVerifiedOn: price.verifiedOn,
    };
  }
  return {
    costUsdMicros: cost,
    status: "calculated",
    pricingVerifiedOn: price.verifiedOn,
  };
}

// ============================================================ //
// Convenience: attach result + status marker to a ProviderUsage
//
// Adapters that already produce a ProviderUsage object can call this
// helper to fold the cost result back in. It writes:
//   - costUsdMicros (from result, may be null)
//   - metadata.cost_status (when status is not "calculated" / "zero")
//   - metadata.pricing_verified_on (when present)
//
// This keeps the per-adapter wiring to one helper call rather than
// scattering metadata-shape decisions across three adapters.
// ============================================================ //

export function applyUsageCost(
  usage: ProviderUsage,
  result: UsageCostResult,
): void {
  usage.costUsdMicros = result.costUsdMicros;

  // Surface non-trivial outcomes in metadata so operators tailing the
  // `llm_usage_log` can spot pricing-related gaps without diffing the
  // raw `cost_usd_micros` column. "calculated" / "zero" are the silent
  // happy paths.
  const needsMarker =
    result.status === "unknown_model" ||
    result.status === "missing_usage" ||
    result.status === "unsupported_unit";
  if (!needsMarker && !result.pricingVerifiedOn) return;

  const md = usage.metadata ?? {};
  if (needsMarker) {
    md.cost_status = result.status;
  }
  if (result.pricingVerifiedOn) {
    md.pricing_verified_on = result.pricingVerifiedOn;
  }
  usage.metadata = md;
}

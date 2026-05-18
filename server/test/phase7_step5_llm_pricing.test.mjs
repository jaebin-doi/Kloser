/* Phase 7 Step 5 — LLM usage cost map / calculator tests.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_5_PLAN.md §4.5.
 *
 * Covered surface:
 *   - calculateUsageCostUsdMicros (all CostStatus categories)
 *   - applyUsageCost (folds the result into a ProviderUsage envelope)
 *
 * Test scenarios:
 *    1. Mock provider always returns { cost: 0, status: 'zero' }
 *       regardless of operation/model/tokens.
 *    2. Anthropic claude-sonnet-4-5 input+output → calculated cost
 *       matches the public price ($3 / $15 per MTok) with integer ceil.
 *    3. Anthropic call_suggestion uses the same map as call_summary.
 *    4. OpenAI text-embedding-3-small input-only → calculated cost
 *       matches $0.02 per MTok. tokensOut is allowed to be null/0/undefined.
 *    5. Skipped zero-token call (0/0) on a known model → cost 0,
 *       status='zero', pricingVerifiedOn populated.
 *    6. Unknown real model returns { cost: null, status: 'unknown_model' }
 *       and does NOT throw.
 *    7. Missing tokensIn on Anthropic → null + 'missing_usage'.
 *    8. Missing tokensOut on Anthropic → null + 'missing_usage'.
 *    9. Clova STT always returns null + 'unsupported_unit' (no audio
 *       duration field in the usage envelope).
 *   10. Negative tokensIn throws UsageCostInputError (adapter invariant).
 *   11. Fractional tokensIn throws UsageCostInputError.
 *   12. Rounding: 1 token at sub-micro-dollar rate ceils to 1 micro-USD.
 *   13. Model name normalisation: trailing whitespace and casing match.
 *   14. applyUsageCost: marker metadata is attached only for non-trivial
 *       outcomes; calculated rows still get pricing_verified_on.
 *
 * Run: cd server && npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calculateUsageCostUsdMicros,
  applyUsageCost,
  UsageCostInputError,
} from "../src/adapters/pricing.ts";

// =============================================================
//                  1. Mock provider → zero
// =============================================================

test("mock provider returns cost=0 regardless of model/tokens", () => {
  const r = calculateUsageCostUsdMicros({
    provider: "mock",
    operation: "call_summary",
    model: "irrelevant-model",
    tokensIn: 999_999,
    tokensOut: 999_999,
  });
  assert.equal(r.costUsdMicros, 0);
  assert.equal(r.status, "zero");
  assert.equal(r.pricingVerifiedOn, undefined);
});

// =============================================================
//                  2. Anthropic happy path — Sonnet 4.5
// =============================================================

test("Anthropic claude-sonnet-4-5 input + output → calculated micro-USD", () => {
  // $3 / MTok input × 1000 tokens = $0.003 = 3000 micro-USD
  // $15 / MTok output × 200 tokens = $0.003 = 3000 micro-USD
  // Total = 6000 micro-USD
  const r = calculateUsageCostUsdMicros({
    provider: "anthropic",
    operation: "call_summary",
    model: "claude-sonnet-4-5",
    tokensIn: 1000,
    tokensOut: 200,
  });
  assert.equal(r.costUsdMicros, 6000);
  assert.equal(r.status, "calculated");
  assert.equal(r.pricingVerifiedOn, "2026-05-18");
});

test("Anthropic call_suggestion uses the same price map as call_summary", () => {
  const summary = calculateUsageCostUsdMicros({
    provider: "anthropic",
    operation: "call_summary",
    model: "claude-sonnet-4-5",
    tokensIn: 2500,
    tokensOut: 500,
  });
  const suggestion = calculateUsageCostUsdMicros({
    provider: "anthropic",
    operation: "call_suggestion",
    model: "claude-sonnet-4-5",
    tokensIn: 2500,
    tokensOut: 500,
  });
  assert.equal(suggestion.status, "calculated");
  assert.equal(suggestion.costUsdMicros, summary.costUsdMicros);
});

test("Anthropic claude-opus-4-7 uses higher Opus rate", () => {
  // $5 / MTok input × 1_000_000 = $5 = 5_000_000 micro-USD
  // $25 / MTok output × 100_000 = $2.5 = 2_500_000 micro-USD
  // Total = 7_500_000
  const r = calculateUsageCostUsdMicros({
    provider: "anthropic",
    operation: "call_summary",
    model: "claude-opus-4-7",
    tokensIn: 1_000_000,
    tokensOut: 100_000,
  });
  assert.equal(r.costUsdMicros, 7_500_000);
  assert.equal(r.status, "calculated");
});

// =============================================================
//                  3. OpenAI embedding happy path
// =============================================================

test("OpenAI text-embedding-3-small calculates input-only cost", () => {
  // $0.02 / MTok × 1_000_000 tokens = $0.02 = 20_000 micro-USD
  const r = calculateUsageCostUsdMicros({
    provider: "openai",
    operation: "knowledge_embedding",
    model: "text-embedding-3-small",
    tokensIn: 1_000_000,
    tokensOut: 0,
  });
  assert.equal(r.costUsdMicros, 20_000);
  assert.equal(r.status, "calculated");
  assert.equal(r.pricingVerifiedOn, "2026-05-18");
});

test("OpenAI embedding ignores tokensOut value entirely", () => {
  // tokensOut is allowed to be null (real adapters set it to 0; this
  // test just confirms the embedding branch never reads it).
  const r = calculateUsageCostUsdMicros({
    provider: "openai",
    operation: "knowledge_embedding",
    model: "text-embedding-3-small",
    tokensIn: 5000,
    // Real OpenAI adapter sets tokensOut to 0; pass null to prove the
    // embedding branch doesn't require it.
    tokensOut: null,
  });
  assert.equal(r.status, "calculated");
  // $0.02 / MTok × 5000 tokens = $0.0001 = 100 micro-USD
  assert.equal(r.costUsdMicros, 100);
});

// =============================================================
//                  4. Skipped zero-token call
// =============================================================

test("Anthropic known model with 0/0 tokens → cost 0 'zero' + verifiedOn", () => {
  const r = calculateUsageCostUsdMicros({
    provider: "anthropic",
    operation: "call_summary",
    model: "claude-sonnet-4-5",
    tokensIn: 0,
    tokensOut: 0,
  });
  assert.equal(r.costUsdMicros, 0);
  assert.equal(r.status, "zero");
  assert.equal(r.pricingVerifiedOn, "2026-05-18");
});

test("OpenAI embedding with 0 input tokens → cost 0 'zero'", () => {
  const r = calculateUsageCostUsdMicros({
    provider: "openai",
    operation: "knowledge_embedding",
    model: "text-embedding-3-small",
    tokensIn: 0,
    tokensOut: 0,
  });
  assert.equal(r.costUsdMicros, 0);
  assert.equal(r.status, "zero");
});

// =============================================================
//                  5. Unknown model → null
// =============================================================

test("Anthropic unknown model returns null + 'unknown_model' (no throw)", () => {
  const r = calculateUsageCostUsdMicros({
    provider: "anthropic",
    operation: "call_summary",
    // Plausible-looking but not in the price map.
    model: "claude-opus-9000-future",
    tokensIn: 1000,
    tokensOut: 200,
  });
  assert.equal(r.costUsdMicros, null);
  assert.equal(r.status, "unknown_model");
  assert.equal(r.pricingVerifiedOn, undefined);
});

test("OpenAI unknown embedding model returns null + 'unknown_model'", () => {
  const r = calculateUsageCostUsdMicros({
    provider: "openai",
    operation: "knowledge_embedding",
    model: "text-embedding-9-future",
    tokensIn: 100,
    tokensOut: 0,
  });
  assert.equal(r.costUsdMicros, null);
  assert.equal(r.status, "unknown_model");
});

test("Anthropic SDK-style dated snapshot id misses the alias map → unknown_model", () => {
  // The plan explicitly forbids wildcard matching. If a future snapshot
  // id is returned by the SDK we record unknown_model rather than
  // guessing — this test pins that contract.
  const r = calculateUsageCostUsdMicros({
    provider: "anthropic",
    operation: "call_summary",
    model: "claude-sonnet-4-5-20250929",
    tokensIn: 1000,
    tokensOut: 200,
  });
  assert.equal(r.costUsdMicros, null);
  assert.equal(r.status, "unknown_model");
});

// =============================================================
//                  6. Missing usage counters
// =============================================================

test("Anthropic with tokensIn=null → null + 'missing_usage'", () => {
  const r = calculateUsageCostUsdMicros({
    provider: "anthropic",
    operation: "call_summary",
    model: "claude-sonnet-4-5",
    tokensIn: null,
    tokensOut: 200,
  });
  assert.equal(r.costUsdMicros, null);
  assert.equal(r.status, "missing_usage");
});

test("Anthropic with tokensOut=null → null + 'missing_usage'", () => {
  const r = calculateUsageCostUsdMicros({
    provider: "anthropic",
    operation: "call_summary",
    model: "claude-sonnet-4-5",
    tokensIn: 1000,
    tokensOut: null,
  });
  assert.equal(r.costUsdMicros, null);
  assert.equal(r.status, "missing_usage");
});

test("OpenAI embedding with tokensIn=null → null + 'missing_usage'", () => {
  const r = calculateUsageCostUsdMicros({
    provider: "openai",
    operation: "knowledge_embedding",
    model: "text-embedding-3-small",
    tokensIn: null,
    tokensOut: 0,
  });
  assert.equal(r.costUsdMicros, null);
  assert.equal(r.status, "missing_usage");
});

// =============================================================
//                  7. Clova STT — duration not modelled
// =============================================================

test("Clova STT returns null + 'unsupported_unit' (no audio duration field)", () => {
  const r = calculateUsageCostUsdMicros({
    provider: "clova",
    operation: "stt_transcribe",
    model: "clova-speech-recog-rest",
    tokensIn: null,
    tokensOut: null,
  });
  assert.equal(r.costUsdMicros, null);
  assert.equal(r.status, "unsupported_unit");
  assert.equal(r.pricingVerifiedOn, undefined);
});

// =============================================================
//                  8. Invariant violations throw
// =============================================================

test("negative tokensIn throws UsageCostInputError", () => {
  assert.throws(
    () =>
      calculateUsageCostUsdMicros({
        provider: "anthropic",
        operation: "call_summary",
        model: "claude-sonnet-4-5",
        tokensIn: -1,
        tokensOut: 0,
      }),
    (err) => err instanceof UsageCostInputError,
  );
});

test("fractional tokensIn throws UsageCostInputError", () => {
  assert.throws(
    () =>
      calculateUsageCostUsdMicros({
        provider: "anthropic",
        operation: "call_summary",
        model: "claude-sonnet-4-5",
        tokensIn: 1.5,
        tokensOut: 0,
      }),
    (err) => err instanceof UsageCostInputError,
  );
});

test("non-finite tokensOut throws UsageCostInputError", () => {
  assert.throws(
    () =>
      calculateUsageCostUsdMicros({
        provider: "anthropic",
        operation: "call_summary",
        model: "claude-sonnet-4-5",
        tokensIn: 100,
        tokensOut: Number.NaN,
      }),
    (err) => err instanceof UsageCostInputError,
  );
});

// =============================================================
//                  9. Rounding & sub-micro-dollar
// =============================================================

test("rounding: 1 input token on $0.02/MTok ceils to 1 micro-USD (never 0)", () => {
  // $0.02 / 1_000_000 tokens * 1 token = 0.02 micro-USD,
  // ceiling → 1 micro-USD.
  const r = calculateUsageCostUsdMicros({
    provider: "openai",
    operation: "knowledge_embedding",
    model: "text-embedding-3-small",
    tokensIn: 1,
    tokensOut: 0,
  });
  assert.equal(r.costUsdMicros, 1);
  assert.equal(r.status, "calculated");
});

test("rounding: 333_333 input tokens on $3/MTok ceils to 999_999 micro-USD", () => {
  // 333_333 * 3_000_000 / 1_000_000 = 999_999.0 → exact.
  const r = calculateUsageCostUsdMicros({
    provider: "anthropic",
    operation: "call_summary",
    model: "claude-sonnet-4-5",
    tokensIn: 333_333,
    tokensOut: 0,
  });
  assert.equal(r.costUsdMicros, 999_999);
});

test("rounding: 1 input token on $3/MTok ceils to 3 micro-USD", () => {
  // 1 * 3_000_000 / 1_000_000 = 3 exactly.
  const r = calculateUsageCostUsdMicros({
    provider: "anthropic",
    operation: "call_summary",
    model: "claude-sonnet-4-5",
    tokensIn: 1,
    tokensOut: 0,
  });
  assert.equal(r.costUsdMicros, 3);
});

// =============================================================
//                  10. Model name normalisation
// =============================================================

test("model name with mixed case + trailing whitespace matches", () => {
  const r = calculateUsageCostUsdMicros({
    provider: "anthropic",
    operation: "call_summary",
    model: "  Claude-Sonnet-4-5  ",
    tokensIn: 1000,
    tokensOut: 200,
  });
  assert.equal(r.status, "calculated");
  assert.equal(r.costUsdMicros, 6000);
});

// =============================================================
//                  11. applyUsageCost metadata folding
// =============================================================

test("applyUsageCost: calculated row writes pricing_verified_on, no cost_status", () => {
  const usage = {
    provider: "anthropic",
    operation: "call_summary",
    model: "claude-sonnet-4-5",
    status: "succeeded",
    tokensIn: 1000,
    tokensOut: 200,
    latencyMs: 123,
    costUsdMicros: null,
  };
  const result = calculateUsageCostUsdMicros({
    provider: "anthropic",
    operation: "call_summary",
    model: "claude-sonnet-4-5",
    tokensIn: 1000,
    tokensOut: 200,
  });
  applyUsageCost(usage, result);
  assert.equal(usage.costUsdMicros, 6000);
  assert.equal(usage.metadata?.pricing_verified_on, "2026-05-18");
  // Happy paths don't leave a marker.
  assert.equal(usage.metadata?.cost_status, undefined);
});

test("applyUsageCost: unknown_model writes cost_status, leaves null", () => {
  const usage = {
    provider: "anthropic",
    operation: "call_summary",
    model: "future-model",
    status: "succeeded",
    tokensIn: 1000,
    tokensOut: 200,
    latencyMs: 123,
    costUsdMicros: null,
  };
  const result = calculateUsageCostUsdMicros({
    provider: "anthropic",
    operation: "call_summary",
    model: "future-model",
    tokensIn: 1000,
    tokensOut: 200,
  });
  applyUsageCost(usage, result);
  assert.equal(usage.costUsdMicros, null);
  assert.equal(usage.metadata?.cost_status, "unknown_model");
  // No verifiedOn on unknown_model.
  assert.equal(usage.metadata?.pricing_verified_on, undefined);
});

test("applyUsageCost: zero status (no verifiedOn) leaves metadata untouched", () => {
  const usage = {
    provider: "mock",
    operation: "call_summary",
    model: "mock-model",
    status: "succeeded",
    tokensIn: 0,
    tokensOut: 0,
    latencyMs: 0,
    costUsdMicros: null,
  };
  const result = calculateUsageCostUsdMicros({
    provider: "mock",
    operation: "call_summary",
    model: "mock-model",
    tokensIn: 0,
    tokensOut: 0,
  });
  applyUsageCost(usage, result);
  assert.equal(usage.costUsdMicros, 0);
  // Mock has no verifiedOn → no metadata added.
  assert.equal(usage.metadata, undefined);
});

test("applyUsageCost: unsupported_unit (Clova) writes cost_status marker", () => {
  const usage = {
    provider: "clova",
    operation: "stt_transcribe",
    model: "clova-speech-recog-rest",
    status: "succeeded",
    tokensIn: null,
    tokensOut: null,
    latencyMs: 500,
    costUsdMicros: null,
  };
  const result = calculateUsageCostUsdMicros({
    provider: "clova",
    operation: "stt_transcribe",
    model: "clova-speech-recog-rest",
    tokensIn: null,
    tokensOut: null,
  });
  applyUsageCost(usage, result);
  assert.equal(usage.costUsdMicros, null);
  assert.equal(usage.metadata?.cost_status, "unsupported_unit");
});

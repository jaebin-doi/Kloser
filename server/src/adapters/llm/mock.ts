/* LLM mock adapter — Phase 5 Step 3, updated in Phase 6 Step 2.
 *
 * Phase 5 plan: docs/plan/phase-5/PHASE_5_STEP_3_ROUTES.md §1.3.
 * Phase 6 plan: docs/plan/phase-6/PHASE_6_STEP_2_PLAN.md §4.
 *
 * Deterministic rule-based mock so route/WS tests and dev runs can
 * exercise the AI summary / suggestion pipeline without a real
 * Anthropic key. Mirror the Phase 0.5 fixture vocabulary so existing
 * frontend rendering (Step 4) snaps onto the same shapes.
 *
 * Same input → same output. No randomness, no clock reads.
 *
 * Step 6.2 change: returns ProviderResult<T>. `.value` carries the
 * exact same domain payload Phase 5 returned; `.usage` is a deterministic
 * envelope (provider='mock', cost=0, status='succeeded') so call sites
 * can route the row to services/llmUsage without branching on adapter
 * identity. Cost stays 0 for mock; real provider clients will populate
 * tokens/cost from SDK response objects.
 */
import {
  type LLMAdapter,
  type LlmGeneratedSummary,
  type LlmGeneratedSuggestion,
  type LlmSummarizeInput,
  type LlmSuggestInput,
} from "./index.js";
import type { ProviderResult, ProviderUsage } from "../usage.js";

const MOCK_SUMMARY_MODEL = "mock-llm-summary-v1";
const MOCK_SUGGEST_MODEL = "mock-llm-suggest-v1";

// Heuristic: very short transcripts read 'cautious' (the customer
// barely engaged), long transcripts with positive markers read
// 'positive', long transcripts with negative markers read 'negative',
// otherwise 'neutral'.
function deriveSentiment(transcript: string): LlmGeneratedSummary["sentiment"] {
  if (/문제|취소|불만|화|곤란/.test(transcript)) return "negative";
  if (/좋|감사|연동|시연|계약/.test(transcript)) return "positive";
  if (transcript.length < 40) return "cautious";
  return "neutral";
}

function summaryUsage(transcript: string): ProviderUsage {
  // Deterministic: same transcript length always yields the same token
  // counts. Real providers report actual SDK usage; mock uses a 4-char
  // ≈ 1 token approximation so summary tests can still assert numbers.
  const approxIn = Math.ceil(transcript.length / 4);
  return {
    provider: "mock",
    operation: "call_summary",
    model: MOCK_SUMMARY_MODEL,
    status: "succeeded",
    tokensIn: approxIn,
    tokensOut: transcript.length === 0 ? 0 : Math.min(64, approxIn),
    latencyMs: 0,
    costUsdMicros: 0,
  };
}

function suggestUsage(transcript: string, count: number): ProviderUsage {
  const approxIn = Math.ceil(transcript.length / 4);
  return {
    provider: "mock",
    operation: "call_suggestion",
    model: MOCK_SUGGEST_MODEL,
    status: "succeeded",
    tokensIn: approxIn,
    tokensOut: count * 16,
    latencyMs: 0,
    costUsdMicros: 0,
  };
}

export function createMockLlmAdapter(): LLMAdapter {
  return {
    provider: "mock",

    async summarizeCall(
      input: LlmSummarizeInput,
    ): Promise<ProviderResult<LlmGeneratedSummary>> {
      const t = input.transcript ?? "";
      if (t.length === 0) {
        return {
          value: { summary: null, needs: null, issues: null, sentiment: null },
          usage: summaryUsage(t),
        };
      }
      // Truncate to 200 chars for the summary so tests can assert
      // deterministically against transcript shape.
      const summary = t.length <= 200 ? t : t.slice(0, 200) + "…";
      const needs = /CRM|연동|시연/.test(t)
        ? "CRM 연동 / 시연 일정 협의"
        : null;
      const issues = /문제|불만|취소/.test(t) ? "고객 측 우려 확인" : null;
      return {
        value: {
          summary,
          needs,
          issues,
          sentiment: deriveSentiment(t),
        },
        usage: summaryUsage(t),
      };
    },

    async suggestForUtterance(
      input: LlmSuggestInput,
    ): Promise<ProviderResult<LlmGeneratedSuggestion[]>> {
      const t = input.transcript ?? "";
      if (t.length === 0) {
        return { value: [], usage: suggestUsage(t, 0) };
      }
      const suggestions: LlmGeneratedSuggestion[] = [];

      // Always emit a direction card so tests have one row to assert on.
      suggestions.push({
        group_seq: input.groupSeq,
        at_ms: input.atMs,
        tone: "blue",
        type: "direction",
        title: "고객 발화 요지 확인",
        body: t.length <= 80 ? t : t.slice(0, 80) + "…",
      });

      if (/CRM|연동/.test(t)) {
        suggestions.push({
          group_seq: input.groupSeq,
          at_ms: input.atMs,
          tone: "emerald",
          type: "script",
          title: "기존 CRM 연동 안내",
          body: "Salesforce / HubSpot / 자체 CRM 모두 REST API 또는 webhook으로 연동 가능합니다.",
        });
      }
      if (/시연|데모/.test(t)) {
        suggestions.push({
          group_seq: input.groupSeq,
          at_ms: input.atMs,
          tone: "amber",
          type: "next",
          title: "시연 일정 제안",
          body: "다음 주 화요일 14:00 또는 목요일 10:00 어떠신가요.",
        });
      }
      return { value: suggestions, usage: suggestUsage(t, suggestions.length) };
    },
  };
}

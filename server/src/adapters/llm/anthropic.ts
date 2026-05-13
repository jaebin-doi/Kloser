/* Anthropic LLM adapter — Phase 6 Step 2.
 *
 * Plan: docs/plan/phase-6/PHASE_6_STEP_2_PLAN.md §5.1.
 *
 * Wraps the official `@anthropic-ai/sdk` Messages API. The summary and
 * suggestion endpoints both ask Claude to respond with strict JSON so
 * the parsed result drops straight onto the Step 5 repository inputs.
 *
 * Failure model (plan §5.1):
 *   - 401 / 403 (AuthenticationError / PermissionDeniedError) → throw
 *     fail-fast. Returning a `failed` ProviderResult would let the
 *     worker silently lose summaries on a bad key; the BullMQ retry
 *     budget is the right place to give up.
 *   - 429 / 5xx (RateLimitError / InternalServerError) → throw so the
 *     queue retries with exponential backoff (3 attempts, Step 1 default).
 *   - Malformed JSON / invalid enum / wrong shape → throw before any
 *     DB write so a corrupted response never overwrites a real summary.
 *
 * Cost (plan §2):
 *   We deliberately leave `cost_usd_micros = null` in Step 2. Pricing
 *   constants need an explicit verification-date comment per the plan,
 *   and rather than ship potentially stale numbers we record tokens
 *   only. A follow-up commit will add a model→price map with the
 *   "verified on YYYY-MM-DD" comment the plan requires.
 *
 * Mock parity: the returned domain shape matches `mock.ts` exactly so
 * `services/callSummary.applyAiSummary` / `services/callSuggestions
 * .persistSuggestionGroup` accept either provider's output unchanged.
 */
import Anthropic, {
  APIError as AnthropicAPIError,
} from "@anthropic-ai/sdk";
import {
  type LLMAdapter,
  type LlmGeneratedSummary,
  type LlmGeneratedSuggestion,
  type LlmSummarizeInput,
  type LlmSuggestInput,
  type CallSentiment,
  type SuggestionTone,
  type SuggestionType,
} from "./index.js";
import type { ProviderResult, ProviderUsage } from "../usage.js";

export const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-4-5";
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TIMEOUT_MS = 30000;

const ALLOWED_SENTIMENTS: ReadonlySet<CallSentiment> = new Set<CallSentiment>([
  "positive",
  "neutral",
  "cautious",
  "negative",
]);
const ALLOWED_TONES: ReadonlySet<SuggestionTone> = new Set<SuggestionTone>([
  "blue",
  "cyan",
  "amber",
  "rose",
  "emerald",
  "slate",
]);
const ALLOWED_TYPES: ReadonlySet<SuggestionType> = new Set<SuggestionType>([
  "direction",
  "script",
  "alert",
  "risk",
  "next",
  "kb",
]);

export interface AnthropicAdapterConfig {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export class AnthropicResponseError extends Error {
  code = "anthropic_response" as const;
  constructor(message: string) {
    super(message);
    this.name = "AnthropicResponseError";
  }
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Read all text from the response content blocks. Anthropic returns an
// array of blocks (text / thinking / tool_use); we only consume the
// text ones, in order.
function joinTextBlocks(blocks: Array<{ type: string; text?: string }>): string {
  let out = "";
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string") {
      out += b.text;
    }
  }
  return out;
}

// Parse strict-JSON output and validate it against the summary shape.
// Throws AnthropicResponseError on any mismatch so the worker treats
// the call as a provider failure (BullMQ retry) rather than persisting
// junk.
function parseSummary(text: string): LlmGeneratedSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new AnthropicResponseError(
      `summary response was not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AnthropicResponseError(
      "summary response must be a JSON object with summary/needs/issues/sentiment",
    );
  }
  const obj = parsed as Record<string, unknown>;
  const summary = obj.summary === null ? null : obj.summary;
  const needs = obj.needs === null ? null : obj.needs;
  const issues = obj.issues === null ? null : obj.issues;
  const sentiment = obj.sentiment === null ? null : obj.sentiment;
  if (summary !== null && typeof summary !== "string") {
    throw new AnthropicResponseError("summary.summary must be string or null");
  }
  if (needs !== null && typeof needs !== "string") {
    throw new AnthropicResponseError("summary.needs must be string or null");
  }
  if (issues !== null && typeof issues !== "string") {
    throw new AnthropicResponseError("summary.issues must be string or null");
  }
  if (sentiment !== null) {
    if (typeof sentiment !== "string" || !ALLOWED_SENTIMENTS.has(sentiment as CallSentiment)) {
      throw new AnthropicResponseError(
        `summary.sentiment must be one of ${[...ALLOWED_SENTIMENTS].join("/")} or null`,
      );
    }
  }
  return {
    summary: summary as string | null,
    needs: needs as string | null,
    issues: issues as string | null,
    sentiment: sentiment as CallSentiment | null,
  };
}

function parseSuggestions(
  text: string,
  fallbackGroupSeq: number,
  fallbackAtMs: number,
): LlmGeneratedSuggestion[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new AnthropicResponseError(
      `suggestion response was not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new AnthropicResponseError(
      "suggestion response must be a JSON array of suggestion objects",
    );
  }
  const out: LlmGeneratedSuggestion[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") {
      throw new AnthropicResponseError("suggestion item must be a JSON object");
    }
    const r = raw as Record<string, unknown>;
    const tone = r.tone;
    const type = r.type;
    const title = r.title;
    const body = r.body === undefined ? null : r.body;
    if (typeof tone !== "string" || !ALLOWED_TONES.has(tone as SuggestionTone)) {
      throw new AnthropicResponseError(
        `suggestion.tone must be one of ${[...ALLOWED_TONES].join("/")}`,
      );
    }
    if (typeof type !== "string" || !ALLOWED_TYPES.has(type as SuggestionType)) {
      throw new AnthropicResponseError(
        `suggestion.type must be one of ${[...ALLOWED_TYPES].join("/")}`,
      );
    }
    if (typeof title !== "string" || title.length === 0) {
      throw new AnthropicResponseError("suggestion.title must be a non-empty string");
    }
    if (body !== null && typeof body !== "string") {
      throw new AnthropicResponseError("suggestion.body must be string or null");
    }
    // group_seq / at_ms come from the caller's CallContext, not the LLM.
    // Ignore any model-provided timeline fields so persisted rows always
    // match the actual live-call clock.
    out.push({
      group_seq: fallbackGroupSeq,
      at_ms: fallbackAtMs,
      tone: tone as SuggestionTone,
      type: type as SuggestionType,
      title,
      body: body as string | null,
    });
  }
  return out;
}

function isAuthError(err: unknown): boolean {
  if (err instanceof AnthropicAPIError) {
    return err.status === 401 || err.status === 403;
  }
  return false;
}

function makeUsage(
  operation: ProviderUsage["operation"],
  model: string,
  status: ProviderUsage["status"],
  tokensIn: number | null,
  tokensOut: number | null,
  latencyMs: number,
  providerRequestId: string | null,
  errorCode: string | null = null,
): ProviderUsage {
  return {
    provider: "anthropic",
    operation,
    model,
    status,
    tokensIn,
    tokensOut,
    // cost_usd_micros: see file header — left null in Step 2.
    costUsdMicros: null,
    latencyMs,
    providerRequestId,
    errorCode,
  };
}

const SUMMARY_SYSTEM_PROMPT = [
  "당신은 한국어 영업 통화 보조 AI 입니다.",
  "주어진 통화 전사(transcript)를 다음 4개 필드 JSON 객체로 요약하세요.",
  '{ "summary": string|null, "needs": string|null, "issues": string|null, "sentiment": "positive"|"neutral"|"cautious"|"negative"|null }',
  "- summary: 2~3 문장의 통화 요지.",
  "- needs: 고객이 명시적으로 요청한 필요사항.",
  "- issues: 미해결 이슈, 우려, 불만.",
  "- sentiment: 통화 전반의 감정.",
  "JSON 객체만 출력하세요. 마크다운 / 설명 / 코드펜스 금지.",
  "정보가 부족한 필드는 null로 출력하세요.",
].join("\n");

const SUGGESTION_SYSTEM_PROMPT = [
  "당신은 한국어 영업 통화 실시간 응대 추천 AI 입니다.",
  "최근 발화 transcript를 보고 상담원이 다음 한 마디로 사용할 응대 카드 0~3개를 JSON 배열로 출력하세요.",
  "각 항목 shape:",
  '{ "tone": "blue"|"cyan"|"amber"|"rose"|"emerald"|"slate", "type": "direction"|"script"|"alert"|"risk"|"next"|"kb", "title": string, "body": string|null }',
  "JSON 배열만 출력하세요. 마크다운 / 설명 금지.",
].join("\n");

export function createAnthropicLlmAdapter(
  config: AnthropicAdapterConfig,
): LLMAdapter {
  if (!config.apiKey || config.apiKey.trim() === "") {
    throw new Error("createAnthropicLlmAdapter: apiKey is required");
  }
  const model = config.model ?? ANTHROPIC_DEFAULT_MODEL;
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const client = new Anthropic({
    apiKey: config.apiKey,
    timeout: timeoutMs,
  });

  return {
    provider: "anthropic",

    async summarizeCall(
      input: LlmSummarizeInput,
    ): Promise<ProviderResult<LlmGeneratedSummary>> {
      const transcript = input.transcript ?? "";
      if (transcript.length === 0) {
        // No transcript = no provider call. Skip with a usage row that
        // operators can still see for "we had nothing to summarize".
        return {
          value: { summary: null, needs: null, issues: null, sentiment: null },
          usage: makeUsage("call_summary", model, "skipped", 0, 0, 0, null),
        };
      }
      const userParts: string[] = [];
      if (input.knowledgeContext && input.knowledgeContext.length > 0) {
        userParts.push("## 회사 가이드 (참고용)");
        for (const k of input.knowledgeContext) userParts.push(k);
        userParts.push("");
      }
      userParts.push("## 통화 전사");
      userParts.push(transcript);

      const start = Date.now();
      try {
        const message = await client.messages.create({
          model,
          max_tokens: maxTokens,
          system: SUMMARY_SYSTEM_PROMPT,
          messages: [{ role: "user", content: userParts.join("\n") }],
        });
        const latency = Date.now() - start;
        const text = joinTextBlocks(
          message.content as Array<{ type: string; text?: string }>,
        );
        const value = parseSummary(text);
        return {
          value,
          usage: makeUsage(
            "call_summary",
            (message.model as string) ?? model,
            "succeeded",
            message.usage?.input_tokens ?? null,
            message.usage?.output_tokens ?? null,
            latency,
            message.id ?? null,
          ),
        };
      } catch (err) {
        // 401/403 = misconfigured key. Fail-fast all the way up.
        if (isAuthError(err)) throw err;
        // Everything else (429/5xx/parse error) becomes a thrown error
        // so BullMQ retries. We do NOT swallow into a `failed`
        // ProviderResult — that would let the queue treat a transient
        // outage as a permanent no-op.
        throw err;
      }
    },

    async suggestForUtterance(
      input: LlmSuggestInput,
    ): Promise<ProviderResult<LlmGeneratedSuggestion[]>> {
      const transcript = input.transcript ?? "";
      if (transcript.length === 0) {
        return {
          value: [],
          usage: makeUsage("call_suggestion", model, "skipped", 0, 0, 0, null),
        };
      }
      const userParts: string[] = [];
      if (input.knowledgeContext && input.knowledgeContext.length > 0) {
        userParts.push("## 회사 가이드 (참고용)");
        for (const k of input.knowledgeContext) userParts.push(k);
        userParts.push("");
      }
      userParts.push("## 최근 발화");
      userParts.push(transcript);

      const start = Date.now();
      try {
        const message = await client.messages.create({
          model,
          max_tokens: maxTokens,
          system: SUGGESTION_SYSTEM_PROMPT,
          messages: [{ role: "user", content: userParts.join("\n") }],
        });
        const latency = Date.now() - start;
        const text = joinTextBlocks(
          message.content as Array<{ type: string; text?: string }>,
        );
        const value = parseSuggestions(text, input.groupSeq, input.atMs);
        return {
          value,
          usage: makeUsage(
            "call_suggestion",
            (message.model as string) ?? model,
            "succeeded",
            message.usage?.input_tokens ?? null,
            message.usage?.output_tokens ?? null,
            latency,
            message.id ?? null,
          ),
        };
      } catch (err) {
        if (isAuthError(err)) throw err;
        throw err;
      }
    },
  };
}

// Resolver helper — reads env, validates required fields, throws when
// the user explicitly selected anthropic but forgot the key. Kept here
// (next to the adapter) so a future provider can ship its own factory
// without touching adapters/index.ts beyond the wiring branch.
export function createAnthropicLlmAdapterFromEnv(): LLMAdapter {
  const apiKey = (process.env.ANTHROPIC_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error(
      "LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is empty. Set it or revert to LLM_PROVIDER=mock.",
    );
  }
  const model = (process.env.ANTHROPIC_MODEL ?? "").trim() || ANTHROPIC_DEFAULT_MODEL;
  return createAnthropicLlmAdapter({
    apiKey,
    model,
    maxTokens: envNumber("ANTHROPIC_MAX_TOKENS", DEFAULT_MAX_TOKENS),
    timeoutMs: envNumber("ANTHROPIC_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
  });
}

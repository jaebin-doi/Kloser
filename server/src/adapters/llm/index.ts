/* LLM adapter interface — Phase 5 Step 3.
 *
 * Plan: docs/plan/phase-5/PHASE_5_STEP_3_ROUTES.md §1.3.
 *
 * Two surfaces:
 *   - summarizeCall: feeds the full transcript + optional knowledge
 *     context, expects a 4-field summary (summary / needs / issues /
 *     sentiment) shaped to fit calls.{summary,needs,issues,sentiment}.
 *   - suggestForUtterance: live in-call suggestion generator. Returns
 *     0..N suggestions; each row maps onto call_suggestions schema.
 *
 * The Anthropic / OpenAI clients are NOT added in this step (see plan
 * §1.1). Step 3 ships interface + mock only.
 */

export type CallSentiment =
  | "positive"
  | "neutral"
  | "cautious"
  | "negative";

export type SuggestionTone =
  | "blue"
  | "cyan"
  | "amber"
  | "rose"
  | "emerald"
  | "slate";

export type SuggestionType =
  | "direction"
  | "script"
  | "alert"
  | "risk"
  | "next"
  | "kb";

export interface LlmGeneratedSummary {
  summary: string | null;
  needs: string | null;
  issues: string | null;
  sentiment: CallSentiment | null;
}

export interface LlmGeneratedSuggestion {
  group_seq: number;
  at_ms: number;
  tone: SuggestionTone;
  type: SuggestionType;
  title: string;
  body: string | null;
}

export interface LlmSummarizeInput {
  transcript: string;
  knowledgeContext?: string[];
}

export interface LlmSuggestInput {
  transcript: string;
  knowledgeContext?: string[];
  groupSeq: number;
  atMs: number;
}

export type LlmProvider = "anthropic" | "openai" | "mock";

export interface LLMAdapter {
  provider: LlmProvider;
  summarizeCall(input: LlmSummarizeInput): Promise<LlmGeneratedSummary>;
  suggestForUtterance(
    input: LlmSuggestInput,
  ): Promise<LlmGeneratedSuggestion[]>;
}

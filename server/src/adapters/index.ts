/* Adapter resolver — Phase 5 Step 3, extended in Phase 6 Step 2.
 *
 * Phase 5 plan: docs/plan/phase-5/PHASE_5_STEP_3_ROUTES.md §1.5.
 * Phase 6 plan: docs/plan/phase-6/PHASE_6_STEP_2_PLAN.md §7.
 *
 * Each resolver maps an env var to a provider factory:
 *
 *   STT_PROVIDER       = mock | clova
 *   LLM_PROVIDER       = mock | anthropic
 *   EMBEDDING_PROVIDER = mock | openai
 *
 * Behavior:
 *   - unset / empty → 'mock' (safe default; tests + dev pay nothing).
 *   - explicit 'mock' → mock factory.
 *   - explicit real provider → real factory. The factory throws fast
 *     when its required key/url env is empty so a misconfigured prod
 *     boot fails loudly instead of silently falling back to mock.
 *   - unknown value → throw, naming the offending provider.
 *
 * Resolvers are stateless. Callers may cache the returned adapter if
 * they want (currently nobody does — service code accepts the adapter
 * as a parameter so tests can inject a fixture).
 */
import { createMockSttAdapter } from "./stt/mock.js";
import { createMockLlmAdapter } from "./llm/mock.js";
import { createMockEmbeddingAdapter } from "./embedding/mock.js";
import { createAnthropicLlmAdapterFromEnv } from "./llm/anthropic.js";
import { createOpenAIEmbeddingAdapterFromEnv } from "./embedding/openai.js";
import { createClovaSttAdapterFromEnv } from "./stt/clova.js";
import type { STTAdapter } from "./stt/index.js";
import type { LLMAdapter } from "./llm/index.js";
import type { EmbeddingAdapter } from "./embedding/index.js";

function envOrMock(key: string): string {
  const raw = process.env[key];
  if (!raw || raw.trim() === "") return "mock";
  return raw.trim();
}

export function resolveSttAdapter(): STTAdapter {
  const provider = envOrMock("STT_PROVIDER");
  if (provider === "mock") return createMockSttAdapter();
  if (provider === "clova") return createClovaSttAdapterFromEnv();
  throw new Error(
    `STT_PROVIDER='${provider}' is not implemented in this build; supported values: mock, clova.`,
  );
}

export function resolveLlmAdapter(): LLMAdapter {
  const provider = envOrMock("LLM_PROVIDER");
  if (provider === "mock") return createMockLlmAdapter();
  if (provider === "anthropic") return createAnthropicLlmAdapterFromEnv();
  throw new Error(
    `LLM_PROVIDER='${provider}' is not implemented in this build; supported values: mock, anthropic.`,
  );
}

export function resolveEmbeddingAdapter(): EmbeddingAdapter {
  const provider = envOrMock("EMBEDDING_PROVIDER");
  if (provider === "mock") return createMockEmbeddingAdapter();
  if (provider === "openai") return createOpenAIEmbeddingAdapterFromEnv();
  throw new Error(
    `EMBEDDING_PROVIDER='${provider}' is not implemented in this build; supported values: mock, openai.`,
  );
}

export type { STTAdapter } from "./stt/index.js";
export type { LLMAdapter } from "./llm/index.js";
export type { EmbeddingAdapter } from "./embedding/index.js";

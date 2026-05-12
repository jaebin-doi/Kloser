/* Adapter resolver — Phase 5 Step 3.
 *
 * Plan: docs/plan/phase-5/PHASE_5_STEP_3_ROUTES.md §1.5.
 *
 * Resolves each adapter from process.env. Step 3 only ships 'mock' so
 * any other value throws — that lets a forgotten `.env` flip fail fast
 * instead of silently calling a missing provider client. Real provider
 * clients will be wired here when they land (post-Step 3).
 *
 * Resolvers are stateless. Callers may cache the returned adapter if
 * they want (currently nobody does — service code accepts the adapter
 * as a parameter so tests can inject a fixture).
 */
import { createMockSttAdapter } from "./stt/mock.js";
import { createMockLlmAdapter } from "./llm/mock.js";
import { createMockEmbeddingAdapter } from "./embedding/mock.js";
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
  throw new Error(
    `STT_PROVIDER='${provider}' is not implemented in this build; only 'mock' is wired.`,
  );
}

export function resolveLlmAdapter(): LLMAdapter {
  const provider = envOrMock("LLM_PROVIDER");
  if (provider === "mock") return createMockLlmAdapter();
  throw new Error(
    `LLM_PROVIDER='${provider}' is not implemented in this build; only 'mock' is wired.`,
  );
}

export function resolveEmbeddingAdapter(): EmbeddingAdapter {
  const provider = envOrMock("EMBEDDING_PROVIDER");
  if (provider === "mock") return createMockEmbeddingAdapter();
  throw new Error(
    `EMBEDDING_PROVIDER='${provider}' is not implemented in this build; only 'mock' is wired.`,
  );
}

export type { STTAdapter } from "./stt/index.js";
export type { LLMAdapter } from "./llm/index.js";
export type { EmbeddingAdapter } from "./embedding/index.js";

/* OpenAI Embedding adapter — Phase 6 Step 2.
 *
 * Plan: docs/plan/phase-6/PHASE_6_STEP_2_PLAN.md §5.2.
 *
 * Uses the official `openai` SDK. Returns deterministic 1536-dim
 * vectors so the pgvector column shape stays consistent with the mock
 * adapter — the Step 1 migration is fixed at 1536 and resizing it
 * requires a hard re-embed of every existing row.
 *
 * Dimension safety:
 *   - Request: explicitly pass `dimensions: 1536` to the SDK. New OpenAI
 *     embedding models support this param; legacy ones (ada-002) reject
 *     it, which is what we want — fail fast rather than silently store
 *     a vector at the wrong width.
 *   - Response: validate every returned vector length before returning.
 *     Wrong-length vectors become an `EmbeddingDimensionError`, the same
 *     error type the repository throws on a malformed VALUES literal —
 *     so the route's error handler maps either path to 400.
 *
 * Cost (Phase 7 Step 5):
 *   Pricing is delegated to `adapters/pricing.ts`. Embedding requests
 *   have no output tokens; the calculator multiplies `tokensIn` against
 *   the input-only rate ($0.02/MTok for text-embedding-3-small as of
 *   the price map's verified date). Unknown models keep
 *   `costUsdMicros = null` with `metadata.cost_status = 'unknown_model'`.
 *
 * Failure: 401/403 throw fail-fast (bad config); 429/5xx throw so the
 * caller's retry policy (BullMQ for KB ingest, immediate for search)
 * can act. We do not synthesise a `failed` ProviderResult here because
 * downstream code expects a usable vector.
 */
import OpenAI, { APIError as OpenAIAPIError } from "openai";
import {
  type EmbeddingAdapter,
  EmbeddingDimensionError,
} from "./index.js";
import type { ProviderResult, ProviderUsage } from "../usage.js";
import {
  applyUsageCost,
  calculateUsageCostUsdMicros,
} from "../pricing.js";

export const OPENAI_DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DIM = 1536 as const;
const DEFAULT_TIMEOUT_MS = 10000;

export interface OpenAIEmbeddingAdapterConfig {
  apiKey: string;
  model?: string;
  dimensions?: number;
  timeoutMs?: number;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function makeUsage(
  model: string,
  status: ProviderUsage["status"],
  tokensIn: number | null,
  latencyMs: number,
): ProviderUsage {
  const usage: ProviderUsage = {
    provider: "openai",
    operation: "knowledge_embedding",
    model,
    status,
    tokensIn,
    tokensOut: 0,
    // Populated by calculateUsageCostUsdMicros below — Phase 7 Step 5.
    costUsdMicros: null,
    latencyMs,
  };
  if (status !== "failed") {
    const result = calculateUsageCostUsdMicros({
      provider: "openai",
      operation: "knowledge_embedding",
      model,
      tokensIn,
      tokensOut: 0,
    });
    applyUsageCost(usage, result);
  }
  return usage;
}

function isAuthError(err: unknown): boolean {
  if (err instanceof OpenAIAPIError) {
    return err.status === 401 || err.status === 403;
  }
  return false;
}

function assertVectorLength(vec: number[], idx: number): void {
  if (vec.length !== DIM) {
    throw new EmbeddingDimensionError(
      `OpenAI returned vector at index ${idx} with length ${vec.length}, expected ${DIM}`,
    );
  }
}

export function createOpenAIEmbeddingAdapter(
  config: OpenAIEmbeddingAdapterConfig,
): EmbeddingAdapter {
  if (!config.apiKey || config.apiKey.trim() === "") {
    throw new Error("createOpenAIEmbeddingAdapter: apiKey is required");
  }
  if (config.dimensions !== undefined && config.dimensions !== DIM) {
    throw new EmbeddingDimensionError(
      `OpenAI adapter must use dimensions=${DIM}; got ${config.dimensions}. pgvector column width is fixed.`,
    );
  }
  const model = config.model ?? OPENAI_DEFAULT_EMBEDDING_MODEL;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const client = new OpenAI({ apiKey: config.apiKey, timeout: timeoutMs });

  async function embedMany(
    texts: string[],
  ): Promise<{ vectors: number[][]; usage: ProviderUsage }> {
    if (texts.length === 0) {
      return {
        vectors: [],
        usage: makeUsage(model, "skipped", 0, 0),
      };
    }
    const start = Date.now();
    try {
      const response = await client.embeddings.create({
        model,
        input: texts,
        encoding_format: "float",
        // Explicit width — OpenAI rejects unsupported sizes per model so
        // a misconfig surfaces immediately rather than after a silent
        // dimensionality drift.
        dimensions: DIM,
      });
      const latency = Date.now() - start;
      const vectors: number[][] = [];
      response.data.forEach((row, i) => {
        const v = row.embedding;
        assertVectorLength(v, i);
        vectors.push(v);
      });
      return {
        vectors,
        usage: makeUsage(
          response.model ?? model,
          "succeeded",
          response.usage?.prompt_tokens ?? null,
          latency,
        ),
      };
    } catch (err) {
      if (isAuthError(err)) throw err;
      throw err;
    }
  }

  return {
    provider: "openai",
    dimensions: DIM,
    async embed(text: string): Promise<ProviderResult<number[]>> {
      const { vectors, usage } = await embedMany([text]);
      const v = vectors[0];
      if (!v) {
        throw new EmbeddingDimensionError(
          "OpenAI returned no embedding vector for a single embed request",
        );
      }
      return { value: v, usage };
    },
    async embedBatch(texts: string[]): Promise<ProviderResult<number[][]>> {
      const { vectors, usage } = await embedMany(texts);
      return { value: vectors, usage };
    },
  };
}

export function createOpenAIEmbeddingAdapterFromEnv(): EmbeddingAdapter {
  const apiKey = (process.env.OPENAI_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error(
      "EMBEDDING_PROVIDER=openai but OPENAI_API_KEY is empty. Set it or revert to EMBEDDING_PROVIDER=mock.",
    );
  }
  const model =
    (process.env.OPENAI_EMBEDDING_MODEL ?? "").trim() ||
    OPENAI_DEFAULT_EMBEDDING_MODEL;
  const dimensions = envNumber("OPENAI_EMBEDDING_DIMENSIONS", DIM);
  return createOpenAIEmbeddingAdapter({
    apiKey,
    model,
    dimensions,
    timeoutMs: envNumber("OPENAI_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
  });
}

/* Embedding adapter interface — Phase 5 Step 3, extended in Phase 6 Step 2.
 *
 * Phase 5 plan: docs/plan/phase-5/PHASE_5_STEP_3_ROUTES.md §1.4.
 * Phase 6 plan: docs/plan/phase-6/PHASE_6_STEP_2_PLAN.md §4.
 *
 * Sticks to OpenAI ada-002 / text-embedding-3-small dimensionality
 * (1536) because that is the pgvector column type the Step 1 migration
 * picked. A real Voyage / Cohere client must project into 1536 dims at
 * the boundary.
 *
 * Phase 6 Step 2 wraps results in ProviderResult so callers can record
 * provider usage. embedBatch returns one ProviderResult containing the
 * full batch of vectors — usage is per-API-call, not per-input-text.
 */

import type { ProviderResult } from "../usage.js";

export type EmbeddingProvider = "openai" | "voyage" | "mock";

export interface EmbeddingAdapter {
  provider: EmbeddingProvider;
  dimensions: 1536;
  embed(text: string): Promise<ProviderResult<number[]>>;
  embedBatch(texts: string[]): Promise<ProviderResult<number[][]>>;
}

export class EmbeddingDimensionError extends Error {
  code = "embedding_dimension" as const;
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingDimensionError";
  }
}

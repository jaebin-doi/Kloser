/* Embedding adapter interface — Phase 5 Step 3.
 *
 * Plan: docs/plan/phase-5/PHASE_5_STEP_3_ROUTES.md §1.4.
 *
 * Sticks to OpenAI ada-002 / text-embedding-3-small dimensionality
 * (1536) because that is the pgvector column type the Step 1 migration
 * picked. A real Voyage / Cohere client must project into 1536 dims at
 * the boundary.
 */

export type EmbeddingProvider = "openai" | "voyage" | "mock";

export interface EmbeddingAdapter {
  provider: EmbeddingProvider;
  dimensions: 1536;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

export class EmbeddingDimensionError extends Error {
  code = "embedding_dimension" as const;
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingDimensionError";
  }
}

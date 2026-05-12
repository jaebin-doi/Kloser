/* Embedding mock adapter — Phase 5 Step 3.
 *
 * Plan: docs/plan/phase-5/PHASE_5_STEP_3_ROUTES.md §1.4.
 *
 * Deterministic 1536-dim vector derived from text content. Same input
 * → same output, and similar texts produce closer cosine distances so
 * vector search tests against the mock can verify that ordering is
 * preserved end-to-end (search.test asserts the closest result is the
 * query string itself).
 *
 * Construction:
 *   - Each text character contributes (codePoint - 'A'.codePoint) / 256
 *     to bucket index `i % 1536`.
 *   - Vector is then L2-normalised so cosine distance ≈ 1 - cos(θ)
 *     stays in the expected range.
 */
import {
  type EmbeddingAdapter,
  EmbeddingDimensionError,
} from "./index.js";

const DIM = 1536 as const;

function embedDeterministic(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  const A = "A".codePointAt(0)!;
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i) ?? 0;
    const bucket = (cp + i) % DIM;
    v[bucket] = (v[bucket] ?? 0) + (cp - A) / 256;
  }
  // Add a small bias so the all-zero vector (empty string) doesn't
  // become NaN under L2-normalisation. Bias is per-bucket and trivial.
  for (let i = 0; i < DIM; i++) v[i] = (v[i] ?? 0) + 1e-6;
  // L2 normalise.
  let sum = 0;
  for (let i = 0; i < DIM; i++) sum += (v[i] ?? 0) * (v[i] ?? 0);
  const norm = Math.sqrt(sum);
  if (norm === 0) {
    throw new EmbeddingDimensionError("mock embedding norm collapsed to 0");
  }
  for (let i = 0; i < DIM; i++) v[i] = (v[i] ?? 0) / norm;
  return v;
}

export function createMockEmbeddingAdapter(): EmbeddingAdapter {
  return {
    provider: "mock",
    dimensions: DIM,
    async embed(text: string): Promise<number[]> {
      return embedDeterministic(text);
    },
    async embedBatch(texts: string[]): Promise<number[][]> {
      return texts.map(embedDeterministic);
    },
  };
}

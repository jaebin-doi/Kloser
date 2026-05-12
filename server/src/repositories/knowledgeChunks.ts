/* knowledge_chunks repository — Phase 5 Step 2.
 *
 * Chunks are children of a knowledge_base. The Step 1 migration:
 *   - denormalises org_id (RLS authority without JOIN)
 *   - (org_id, knowledge_base_id) composite FK blocks cross-org pointers
 *   - UNIQUE (knowledge_base_id, position) gives stable ordering
 *   - embedding vector(1536) NULL allowed — ingest writes text first,
 *     a downstream worker fills the embedding (Phase 5 Step 3+).
 *   - ivfflat (cosine_ops, lists=100) index on embedding column.
 *
 * pgvector parameterisation: node-postgres has no vector encoder, so we
 * pass the vector as a literal string `"[v1,v2,...]"` and cast in SQL
 * via `$1::vector`. toVectorLiteral asserts length === 1536 before any
 * SQL touches the value.
 *
 * Search must always include `WHERE embedding IS NOT NULL` because the
 * ivfflat index is not partial (some pgvector versions reject partial
 * vector indexes) — without the filter the planner can still pick the
 * index but result rows would include NULL-embedded chunks, which sort
 * arbitrarily under <=>.
 */
import type { PoolClient } from "pg";

export interface KnowledgeChunk {
  id: string;
  knowledge_base_id: string;
  org_id: string;
  position: number;
  text: string;
  // embedding is returned as the pgvector text form "[v1,v2,...]" or null.
  // Repositories surface that raw string; service callers parse only
  // when they need the array form.
  embedding: string | null;
  token_count: number | null;
  created_at: Date;
}

export interface KnowledgeChunkInput {
  position: number;
  text: string;
  embedding?: number[] | null;
  token_count?: number | null;
}

export interface KnowledgeChunkSearchOptions {
  limit: number;
}

export interface KnowledgeChunkSearchResult extends KnowledgeChunk {
  distance: number;
}

export class InvalidEmbeddingError extends Error {
  code = "invalid_embedding" as const;
  constructor(message: string) {
    super(message);
    this.name = "InvalidEmbeddingError";
  }
}

const KNOWLEDGE_CHUNK_COLUMNS =
  "id, knowledge_base_id, org_id, position, text," +
  " embedding::text AS embedding, token_count, created_at";

const EMBEDDING_DIM = 1536;

// Build the pgvector literal "[v1,v2,...]". Validates length up front so
// a 768-dim vector cannot reach SQL and explode the planner.
export function toVectorLiteral(values: number[]): string {
  if (!Array.isArray(values) || values.length !== EMBEDDING_DIM) {
    throw new InvalidEmbeddingError(
      `embedding must be a length-${EMBEDDING_DIM} array, got ${
        Array.isArray(values) ? values.length : typeof values
      }`,
    );
  }
  return "[" + values.join(",") + "]";
}

// ---------- read ---------- //

// Confirms the parent KB exists in the current org (RLS authority) and
// is not soft-deleted. Used as a "did this KB exist for us?" guard for
// reads/writes that target chunks under a specific KB.
async function findKbOrgId(
  client: PoolClient,
  kbId: string,
): Promise<string | null> {
  const r = await client.query<{ org_id: string }>(
    `SELECT org_id FROM knowledge_bases
      WHERE id = $1 AND deleted_at IS NULL`,
    [kbId],
  );
  return r.rows[0]?.org_id ?? null;
}

export async function listByKnowledgeBaseInCurrentOrg(
  client: PoolClient,
  knowledgeBaseId: string,
): Promise<KnowledgeChunk[] | null> {
  const orgId = await findKbOrgId(client, knowledgeBaseId);
  if (!orgId) return null;
  const r = await client.query<KnowledgeChunk>(
    `SELECT ${KNOWLEDGE_CHUNK_COLUMNS} FROM knowledge_chunks
      WHERE knowledge_base_id = $1
      ORDER BY position ASC`,
    [knowledgeBaseId],
  );
  return r.rows;
}

// ---------- write ---------- //

// Replace all chunks for a KB in a single transaction. Returns null if
// the parent KB is missing/cross-org/soft-deleted. The caller is
// expected to be inside withOrgContext already.
export async function replaceForKnowledgeBaseInCurrentOrg(
  client: PoolClient,
  orgId: string,
  knowledgeBaseId: string,
  chunks: KnowledgeChunkInput[],
): Promise<KnowledgeChunk[] | null> {
  const kbOrgId = await findKbOrgId(client, knowledgeBaseId);
  if (!kbOrgId) return null;

  await client.query(
    `DELETE FROM knowledge_chunks WHERE knowledge_base_id = $1`,
    [knowledgeBaseId],
  );

  if (chunks.length === 0) return [];

  const inserted: KnowledgeChunk[] = [];
  for (const chunk of chunks) {
    const embeddingLiteral =
      chunk.embedding === undefined || chunk.embedding === null
        ? null
        : toVectorLiteral(chunk.embedding);
    const r = await client.query<KnowledgeChunk>(
      `INSERT INTO knowledge_chunks (
          org_id, knowledge_base_id, position, text, embedding, token_count
       ) VALUES (
          $1, $2, $3, $4, $5::vector, $6
       )
       RETURNING ${KNOWLEDGE_CHUNK_COLUMNS}`,
      [
        orgId,
        knowledgeBaseId,
        chunk.position,
        chunk.text,
        embeddingLiteral,
        chunk.token_count ?? null,
      ],
    );
    inserted.push(r.rows[0]!);
  }
  return inserted;
}

// Set the embedding (and optionally token_count) for a chunk that was
// inserted without one. Returns null if the chunk doesn't exist in this
// org. Validates dimension before SQL.
export async function updateEmbeddingInCurrentOrg(
  client: PoolClient,
  chunkId: string,
  embedding: number[],
  tokenCount: number | null,
): Promise<KnowledgeChunk | null> {
  const literal = toVectorLiteral(embedding);
  const r = await client.query<KnowledgeChunk>(
    `UPDATE knowledge_chunks
        SET embedding   = $1::vector,
            token_count = COALESCE($2, token_count)
      WHERE id = $3
      RETURNING ${KNOWLEDGE_CHUNK_COLUMNS}`,
    [literal, tokenCount, chunkId],
  );
  return r.rows[0] ?? null;
}

// Cosine-distance ANN search. Always filters `embedding IS NOT NULL` so
// chunks without an embedding never appear. RLS handles org scoping.
export async function searchSimilarInCurrentOrg(
  client: PoolClient,
  queryEmbedding: number[],
  opts: KnowledgeChunkSearchOptions,
): Promise<KnowledgeChunkSearchResult[]> {
  const literal = toVectorLiteral(queryEmbedding);
  const r = await client.query<KnowledgeChunkSearchResult>(
    `SELECT ${KNOWLEDGE_CHUNK_COLUMNS},
            (embedding <=> $1::vector)::float8 AS distance
       FROM knowledge_chunks
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> $1::vector
      LIMIT $2`,
    [literal, opts.limit],
  );
  return r.rows;
}

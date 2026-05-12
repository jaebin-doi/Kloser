/* knowledge chunk shared types — Phase 5 Step 3.
 *
 * Server source-of-truth: server/src/types/knowledgeChunk.ts.
 * Browser JSDoc mirror:   platform/types/knowledgeChunk.js.
 *
 * Sync target schemas (top-level `export const X = z.object({ ... })`):
 *   - KnowledgeChunk
 *   - KnowledgeChunkInput
 *   - KnowledgeChunkReplaceInput
 *   - KnowledgeChunkSearchQuery
 *   - KnowledgeChunkSearchResultItem
 *   - KnowledgeChunkSearchResponse
 *
 * Wire format: `embedding` is returned as the pgvector text form
 * "[v1,v2,...]" or null. Browser code that needs the array can JSON.parse
 * after stripping the brackets — current frontend pages never read it.
 */
import { z } from "zod";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UuidString = z.string().regex(UUID_RE, "invalid uuid");

export const KnowledgeChunk = z.object({
  id: UuidString,
  knowledge_base_id: UuidString,
  org_id: UuidString,
  position: z.number().int().nonnegative(),
  text: z.string(),
  embedding: z.string().nullable(),
  token_count: z.number().int().positive().nullable(),
  created_at: z.date(),
});
export type KnowledgeChunk = z.infer<typeof KnowledgeChunk>;

export const KnowledgeChunkInput = z.object({
  position: z.number().int().nonnegative(),
  text: z.string().min(1).max(8000),
  embedding: z.array(z.number()).length(1536).nullable().optional(),
  token_count: z.number().int().positive().nullable().optional(),
});
export type KnowledgeChunkInput = z.infer<typeof KnowledgeChunkInput>;

export const KnowledgeChunkReplaceInput = z.object({
  chunks: z.array(KnowledgeChunkInput).max(2000),
});
export type KnowledgeChunkReplaceInput = z.infer<typeof KnowledgeChunkReplaceInput>;

export const KnowledgeChunkSearchQuery = z.object({
  query: z.string().min(1).max(2000),
  limit: z.number().int().min(1).max(20).optional(),
});
export type KnowledgeChunkSearchQuery = z.infer<typeof KnowledgeChunkSearchQuery>;

export const KnowledgeChunkSearchResultItem = z.object({
  id: UuidString,
  knowledge_base_id: UuidString,
  org_id: UuidString,
  position: z.number().int().nonnegative(),
  text: z.string(),
  embedding: z.string().nullable(),
  token_count: z.number().int().positive().nullable(),
  created_at: z.date(),
  distance: z.number(),
});
export type KnowledgeChunkSearchResultItem = z.infer<
  typeof KnowledgeChunkSearchResultItem
>;

export const KnowledgeChunkSearchResponse = z.object({
  items: z.array(KnowledgeChunkSearchResultItem),
});
export type KnowledgeChunkSearchResponse = z.infer<
  typeof KnowledgeChunkSearchResponse
>;

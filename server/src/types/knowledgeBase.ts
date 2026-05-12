/* knowledge base shared types — Phase 5 Step 3.
 *
 * Server source-of-truth: server/src/types/knowledgeBase.ts.
 * Browser JSDoc mirror:   platform/types/knowledgeBase.js.
 *
 * Sync target schemas (top-level `export const X = z.object({ ... })`):
 *   - KnowledgeBase
 *   - KnowledgeBaseCreateInput
 *   - KnowledgeBasePatchInput
 *   - KnowledgeBaseListResponse
 */
import { z } from "zod";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UuidString = z.string().regex(UUID_RE, "invalid uuid");

export const KnowledgeBaseSourceType = z.enum(["manual", "file", "url"]);
export type KnowledgeBaseSourceType = z.infer<typeof KnowledgeBaseSourceType>;

export const KnowledgeBase = z.object({
  id: UuidString,
  org_id: UuidString,
  title: z.string(),
  source_type: KnowledgeBaseSourceType,
  source_uri: z.string().nullable(),
  created_by_user_id: UuidString.nullable(),
  deleted_at: z.date().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
});
export type KnowledgeBase = z.infer<typeof KnowledgeBase>;

export const KnowledgeBaseCreateInput = z.object({
  title: z.string().min(1).max(200),
  source_type: KnowledgeBaseSourceType,
  source_uri: z.string().max(2000).nullable().optional(),
});
export type KnowledgeBaseCreateInput = z.infer<typeof KnowledgeBaseCreateInput>;

export const KnowledgeBasePatchInput = z.object({
  title: z.string().min(1).max(200).optional(),
  source_type: KnowledgeBaseSourceType.optional(),
  source_uri: z.string().max(2000).nullable().optional(),
});
export type KnowledgeBasePatchInput = z.infer<typeof KnowledgeBasePatchInput>;

export const KnowledgeBaseListResponse = z.object({
  items: z.array(KnowledgeBase),
});
export type KnowledgeBaseListResponse = z.infer<typeof KnowledgeBaseListResponse>;

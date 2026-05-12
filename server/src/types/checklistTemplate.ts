/* checklist template shared types — Phase 5 Step 3.
 *
 * Server source-of-truth: server/src/types/checklistTemplate.ts.
 * Browser JSDoc mirror:   platform/types/checklistTemplate.js.
 *
 * Sync target schemas (top-level `export const X = z.object({ ... })`):
 *   - CallChecklistTemplate
 *   - CallChecklistTemplateCreateInput
 *   - CallChecklistTemplatePatchInput
 *   - CallChecklistTemplateListResponse
 */
import { z } from "zod";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UuidString = z.string().regex(UUID_RE, "invalid uuid");

export const CallChecklistTemplate = z.object({
  id: UuidString,
  org_id: UuidString,
  title: z.string(),
  sort_order: z.number().int(),
  active: z.boolean(),
  created_at: z.date(),
  updated_at: z.date(),
});
export type CallChecklistTemplate = z.infer<typeof CallChecklistTemplate>;

export const CallChecklistTemplateCreateInput = z.object({
  title: z.string().min(1).max(200),
  sort_order: z.number().int().min(0).max(10000).optional(),
  active: z.boolean().optional(),
});
export type CallChecklistTemplateCreateInput = z.infer<
  typeof CallChecklistTemplateCreateInput
>;

export const CallChecklistTemplatePatchInput = z.object({
  title: z.string().min(1).max(200).optional(),
  sort_order: z.number().int().min(0).max(10000).optional(),
  active: z.boolean().optional(),
});
export type CallChecklistTemplatePatchInput = z.infer<
  typeof CallChecklistTemplatePatchInput
>;

export const CallChecklistTemplateListResponse = z.object({
  items: z.array(CallChecklistTemplate),
});
export type CallChecklistTemplateListResponse = z.infer<
  typeof CallChecklistTemplateListResponse
>;

/* call checklist item shared types — Phase 5 Step 3.
 *
 * Server source-of-truth: server/src/types/callChecklistItem.ts.
 * Browser JSDoc mirror:   platform/types/callChecklistItem.js.
 *
 * Sync target schemas (top-level `export const X = z.object({ ... })`):
 *   - CallChecklistItem
 *   - CallChecklistItemStatusInput
 *   - CallChecklistItemListResponse
 */
import { z } from "zod";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UuidString = z.string().regex(UUID_RE, "invalid uuid");

export const CallChecklistStatus = z.enum(["open", "done"]);
export type CallChecklistStatus = z.infer<typeof CallChecklistStatus>;

export const CallChecklistItem = z.object({
  id: UuidString,
  call_id: UuidString,
  template_id: UuidString,
  org_id: UuidString,
  status: CallChecklistStatus,
  checked_at: z.date().nullable(),
  checked_by_user_id: UuidString.nullable(),
  created_at: z.date(),
  updated_at: z.date(),
});
export type CallChecklistItem = z.infer<typeof CallChecklistItem>;

export const CallChecklistItemStatusInput = z.object({
  status: CallChecklistStatus,
});
export type CallChecklistItemStatusInput = z.infer<
  typeof CallChecklistItemStatusInput
>;

export const CallChecklistItemListResponse = z.object({
  items: z.array(CallChecklistItem),
});
export type CallChecklistItemListResponse = z.infer<
  typeof CallChecklistItemListResponse
>;

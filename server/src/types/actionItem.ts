/* call_action_items shared types — Phase 4 Step 3.
 *
 * Server source-of-truth: server/src/types/actionItem.ts.
 * Browser JSDoc mirror:   platform/types/actionItem.js.
 *
 * Sync target schemas (top-level `export const X = z.object({ ... })`):
 *   - CallActionItem
 *   - ActionItemCreateInput
 *   - ActionItemStatusInput
 *   - ActionItemAssigneeInput
 */
import { z } from "zod";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UuidString = z.string().regex(UUID_RE, "invalid uuid");

export const CallActionItemStatus = z.enum(["open", "done", "dropped"]);
export type CallActionItemStatus = z.infer<typeof CallActionItemStatus>;

// pg returns DATE as a YYYY-MM-DD string. Inputs accept ISO date strings.
const DateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "invalid date (expected YYYY-MM-DD)");

export const CallActionItem = z.object({
  id: UuidString,
  call_id: UuidString,
  org_id: UuidString,
  title: z.string(),
  due_date: z.string().nullable(),
  assignee_user_id: UuidString.nullable(),
  status: CallActionItemStatus,
  completed_at: z.date().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
});
export type CallActionItem = z.infer<typeof CallActionItem>;

export const ActionItemCreateInput = z.object({
  title: z.string().min(1).max(500),
  due_date: DateString.nullable().optional(),
  assignee_user_id: UuidString.nullable().optional(),
});
export type ActionItemCreateInput = z.infer<typeof ActionItemCreateInput>;

export const ActionItemStatusInput = z.object({
  status: CallActionItemStatus,
});
export type ActionItemStatusInput = z.infer<typeof ActionItemStatusInput>;

export const ActionItemAssigneeInput = z.object({
  assignee_user_id: UuidString.nullable(),
});
export type ActionItemAssigneeInput = z.infer<typeof ActionItemAssigneeInput>;

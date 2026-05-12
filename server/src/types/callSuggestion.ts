/* call suggestion shared types — Phase 5 Step 3.
 *
 * Server source-of-truth: server/src/types/callSuggestion.ts.
 * Browser JSDoc mirror:   platform/types/callSuggestion.js.
 *
 * Sync target schemas (top-level `export const X = z.object({ ... })`):
 *   - CallSuggestion
 *   - CallSuggestionInput
 *   - CallSuggestionGroupInput
 *   - CallSuggestionListResponse
 */
import { z } from "zod";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UuidString = z.string().regex(UUID_RE, "invalid uuid");

export const CallSuggestionTone = z.enum([
  "blue",
  "cyan",
  "amber",
  "rose",
  "emerald",
  "slate",
]);
export type CallSuggestionTone = z.infer<typeof CallSuggestionTone>;

export const CallSuggestionType = z.enum([
  "direction",
  "script",
  "alert",
  "risk",
  "next",
  "kb",
]);
export type CallSuggestionType = z.infer<typeof CallSuggestionType>;

export const CallSuggestion = z.object({
  id: UuidString,
  call_id: UuidString,
  org_id: UuidString,
  group_seq: z.number().int().nonnegative(),
  at_ms: z.number().int().nonnegative(),
  tone: CallSuggestionTone,
  type: CallSuggestionType,
  title: z.string(),
  body: z.string().nullable(),
  dismissed_at: z.date().nullable(),
  used_at: z.date().nullable(),
  created_at: z.date(),
});
export type CallSuggestion = z.infer<typeof CallSuggestion>;

export const CallSuggestionInput = z.object({
  group_seq: z.number().int().nonnegative(),
  at_ms: z.number().int().nonnegative(),
  tone: CallSuggestionTone,
  type: CallSuggestionType,
  title: z.string().min(1).max(200),
  body: z.string().max(4000).nullable().optional(),
});
export type CallSuggestionInput = z.infer<typeof CallSuggestionInput>;

export const CallSuggestionGroupInput = z.object({
  items: z.array(CallSuggestionInput).min(1).max(10),
});
export type CallSuggestionGroupInput = z.infer<typeof CallSuggestionGroupInput>;

export const CallSuggestionListResponse = z.object({
  items: z.array(CallSuggestion),
});
export type CallSuggestionListResponse = z.infer<
  typeof CallSuggestionListResponse
>;

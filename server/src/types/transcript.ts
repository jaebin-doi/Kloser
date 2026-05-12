/* transcript shared types — Phase 4 Step 3.
 *
 * Server source-of-truth: server/src/types/transcript.ts.
 * Browser JSDoc mirror:   platform/types/transcript.js.
 *
 * Sync target schemas (top-level `export const X = z.object({ ... })`):
 *   - Transcript
 *   - TranscriptAppendInput
 *   - TranscriptListResponse
 */
import { z } from "zod";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UuidString = z.string().regex(UUID_RE, "invalid uuid");

export const TranscriptSpeaker = z.enum(["agent", "customer", "system"]);
export type TranscriptSpeaker = z.infer<typeof TranscriptSpeaker>;

export const Transcript = z.object({
  id: UuidString,
  call_id: UuidString,
  org_id: UuidString,
  seq: z.number().int().nonnegative(),
  speaker: TranscriptSpeaker,
  text: z.string(),
  start_ms: z.number().int().nonnegative().nullable(),
  end_ms: z.number().int().nonnegative().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  created_at: z.date(),
});
export type Transcript = z.infer<typeof Transcript>;

export const TranscriptAppendInput = z.object({
  speaker: TranscriptSpeaker,
  text: z.string().min(1).max(10_000),
  start_ms: z.number().int().nonnegative().nullable().optional(),
  end_ms: z.number().int().nonnegative().nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
});
export type TranscriptAppendInput = z.infer<typeof TranscriptAppendInput>;

export const TranscriptListResponse = z.object({
  items: z.array(Transcript),
});
export type TranscriptListResponse = z.infer<typeof TranscriptListResponse>;

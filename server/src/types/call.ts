/* call shared types — Phase 4 Step 3.
 *
 * Server source-of-truth for the calls REST surface. Browser keeps a
 * JSDoc mirror at platform/types/call.js. test/sync_shared_types.mjs
 * diffs the field sets via the entity registry.
 *
 * Sync target schemas (must keep top-level `export const X = z.object({ ... })`
 * literal — no .extend / .merge / .partial / satisfies on these):
 *   - Call
 *   - CallCreateInput
 *   - CallListQuery
 *   - CallListResponse
 *   - CallDetailResponse
 *   - CallEndInput
 *   - CallNotesInput
 *
 * Wire format vs server-internal:
 *   - timestamps are JS Date inside service/repository code; the route
 *     layer's JSON serialization yields ISO strings, so the browser
 *     observes strings. Server entity schemas keep z.date() to preserve
 *     internal typing.
 */
import { z } from "zod";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UuidString = z.string().regex(UUID_RE, "invalid uuid");

export const CallDirection = z.enum(["inbound", "outbound", "meeting"]);
export type CallDirection = z.infer<typeof CallDirection>;

export const CallStatus = z.enum([
  "in_progress",
  "ended",
  "missed",
  "dropped",
]);
export type CallStatus = z.infer<typeof CallStatus>;

export const CallFinalStatus = z.enum(["ended", "missed", "dropped"]);
export type CallFinalStatus = z.infer<typeof CallFinalStatus>;

export const CallSentiment = z.enum([
  "positive",
  "neutral",
  "cautious",
  "negative",
]);
export type CallSentiment = z.infer<typeof CallSentiment>;

// ---------- entity ---------- //

export const Call = z.object({
  id: UuidString,
  org_id: UuidString,
  customer_id: UuidString.nullable(),
  agent_user_id: UuidString.nullable(),
  direction: CallDirection,
  status: CallStatus,
  started_at: z.date(),
  ended_at: z.date().nullable(),
  duration_seconds: z.number().int().nonnegative().nullable(),
  title: z.string().nullable(),
  summary: z.string().nullable(),
  needs: z.string().nullable(),
  issues: z.string().nullable(),
  sentiment: CallSentiment.nullable(),
  notes: z.string().nullable(),
  deleted_at: z.date().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
});
export type Call = z.infer<typeof Call>;

// ---------- inputs ---------- //

export const CallCreateInput = z.object({
  customer_id: UuidString.nullable().optional(),
  agent_user_id: UuidString.nullable().optional(),
  direction: CallDirection,
  status: z.literal("in_progress").optional(),
  title: z.string().max(200).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
});
export type CallCreateInput = z.infer<typeof CallCreateInput>;

export const CallNotesInput = z.object({
  notes: z.string().max(4000).nullable(),
});
export type CallNotesInput = z.infer<typeof CallNotesInput>;

export const CallEndInput = z.object({
  ended_at: z.preprocess((v) => {
    if (v === undefined || v === null) return v;
    if (v instanceof Date) return v;
    if (typeof v === "string") {
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? v : d;
    }
    return v;
  }, z.date().optional()),
  final_status: CallFinalStatus.optional(),
});
export type CallEndInput = z.infer<typeof CallEndInput>;

// ---------- list query ---------- //
//
// Mirrors customers list-query policy: q/sort/dir/limit/offset use
// preprocess+catch+default for silent fallback so the route layer never
// sees a ZodError on those fields. customerId / agentUserId / status
// can still throw on bad input — that surfaces as 400 invalid_input.

const ListLimit = z.preprocess((v) => {
  if (v === undefined || v === null || v === "") return 20;
  const n = typeof v === "number" ? v : Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) return 20;
  if (n < 1) return 1;
  if (n > 100) return 100;
  return Math.floor(n);
}, z.number().int().min(1).max(100));

const ListOffset = z.preprocess((v) => {
  if (v === undefined || v === null || v === "") return 0;
  const n = typeof v === "number" ? v : Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  return Math.floor(n);
}, z.number().int().min(0));

const ListQ = z.preprocess((v) => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  if (trimmed === "") return undefined;
  return trimmed.slice(0, 200);
}, z.string().max(200).optional());

const ListCustomerId = z.preprocess((v) => {
  if (v === undefined || v === "") return undefined;
  if (v === null || v === "null") return null;
  return v;
}, z.union([UuidString, z.null()]).optional());

const ListAgentUserId = z.preprocess((v) => {
  if (v === undefined || v === "") return undefined;
  if (v === null || v === "null") return null;
  return v;
}, z.union([UuidString, z.null()]).optional());

const ListStatus = z.preprocess((v) => {
  if (v === undefined || v === null || v === "") return undefined;
  return v;
}, CallStatus.optional());

export const CallListQuery = z.object({
  q: ListQ,
  customerId: ListCustomerId,
  agentUserId: ListAgentUserId,
  status: ListStatus,
  limit: ListLimit.default(20),
  offset: ListOffset.default(0),
});
export type CallListQuery = z.infer<typeof CallListQuery>;

// ---------- responses ---------- //
//
// Top-level z.object literals so sync_shared_types can diff them
// against the browser JSDoc mirror without any derived schema.

export const CallListResponse = z.object({
  items: z.array(Call),
  total: z.number().int().nonnegative(),
});
export type CallListResponse = z.infer<typeof CallListResponse>;

export const CallDetailResponse = z.object({
  call: Call,
});
export type CallDetailResponse = z.infer<typeof CallDetailResponse>;

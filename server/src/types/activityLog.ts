/* activity_log shared types — server source-of-truth.
 *
 * Phase 7 Step 3. Plan: docs/plan/phase-7/PHASE_7_STEP_3_PLAN.md §8.
 *
 * Sync target schemas (must keep top-level `export const X = z.object({ ... })`
 * literal form — no .extend / .merge / .partial / satisfies on these so
 * `test/sync_shared_types.mjs`'s regex parser keeps recognising the bare
 * `})` close):
 *
 *   - ActivityLog
 *   - ActivityLogListQuery
 *   - ActivityLogListResponse
 *
 * Field naming follows backend snake_case (`org_id`, `user_id`,
 * `target_type`, `target_id`, `created_at`) for the row payload, and
 * camelCase for the list query parameters (`beforeCreatedAt`,
 * `beforeId`, `targetType`, `targetId`, `userId`, `createdFrom`,
 * `createdTo`) so the wire shape matches the route's zod query schema
 * one-for-one and JS callers don't have to translate.
 *
 * `payload` is `z.record(z.string(), z.unknown())` — the DB enforces
 * `jsonb_typeof(payload) = 'object'` (CHECK in migration 1715000024000),
 * the service-layer sanitizer enforces forbidden-key/value-shape rules
 * (`services/activityLog.ts`), and admin-facing audit values are
 * rendered via `textContent` in the settings UI. So this layer
 * stays maximally permissive about value types while still pinning
 * the top-level "object, not array/string/null" contract.
 *
 * `nextCursor` is a nested object so it gets its own top-level
 * `z.object({})` literal; `ActivityLogListResponse` then references
 * it via `ActivityLogCursor.nullable()`. The sync parser only checks
 * field NAMES inside the outer `z.object`, so referencing another
 * schema as a value works — the browser JSDoc just needs to mirror
 * the same field names.
 *
 * `action` and `target_type` are declared as `z.string()` rather than
 * z.enum, because the source-of-truth allow-list lives in
 * `repositories/activityLog.ts` (mirrored into the DB CHECK). Re-
 * declaring the union here would double the maintenance surface; the
 * route validates against repository's exported unions when the query
 * arrives.
 */
import { z } from "zod";

// Same permissive 8-4-4-4-12 hex UUID regex the repository layer uses
// (AGENTS.md Backend Conventions). z.string().uuid() is stricter than
// the seed UUIDs and would 400 some legitimate ids.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UuidString = z.string().regex(UUID_RE, "invalid uuid");

// ---------------------------------------------------------------- //
// Row
// ---------------------------------------------------------------- //

export const ActivityLog = z.object({
  id: UuidString,
  org_id: UuidString,
  user_id: UuidString.nullable(),
  action: z.string(),
  target_type: z.string().nullable(),
  target_id: UuidString.nullable(),
  payload: z.record(z.string(), z.unknown()),
  created_at: z.string(),
});
export type ActivityLog = z.infer<typeof ActivityLog>;

// ---------------------------------------------------------------- //
// List query — admin-only via GET /activity-log
// ---------------------------------------------------------------- //

export const ActivityLogListQuery = z.object({
  limit: z.number().int().positive().max(100).optional(),
  beforeCreatedAt: z.string().optional(),
  beforeId: UuidString.optional(),
  action: z.string().optional(),
  targetType: z.string().optional(),
  targetId: UuidString.optional(),
  userId: UuidString.optional(),
  createdFrom: z.string().optional(),
  createdTo: z.string().optional(),
});
export type ActivityLogListQuery = z.infer<typeof ActivityLogListQuery>;

// ---------------------------------------------------------------- //
// List response
// ---------------------------------------------------------------- //

export const ActivityLogCursor = z.object({
  beforeCreatedAt: z.string(),
  beforeId: UuidString,
});
export type ActivityLogCursor = z.infer<typeof ActivityLogCursor>;

export const ActivityLogListResponse = z.object({
  items: z.array(ActivityLog),
  nextCursor: ActivityLogCursor.nullable(),
});
export type ActivityLogListResponse = z.infer<typeof ActivityLogListResponse>;

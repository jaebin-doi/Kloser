/* customers shared types — server source-of-truth.
 *
 * This module defines every customer-entity shape via zod schemas, with
 * matching TypeScript types derived through `z.infer<typeof X>`. The
 * server uses zod schemas for boundary validation (route bodies and
 * query strings); repository and service modules import the inferred TS
 * types only.
 *
 * The browser keeps a JSDoc-only mirror at `platform/types/customers.js`.
 * `test/sync_shared_types.mjs` diffs the two field sets at the top-level
 * z.object literals listed in §6 of `docs/plan/PHASE_2_STEP_3_SHARED_TYPES.md`.
 *
 * Sync target schemas (must keep top-level `export const X = z.object({ ... })`
 * literal form — no .extend / .merge / .partial / satisfies on these):
 *   - Customer
 *   - CustomerCreateInput
 *   - CustomerListQuery
 *   - CustomerStats
 *
 * Derived schemas (CustomerPatchBase / CustomerPatch) are out of sync scope.
 */
import { z } from "zod";

// UUID regex matching Phase 1 convention (Phase 1 services/auth.ts UUID_RE).
// Permissive 32-hex-with-dashes — does NOT enforce RFC 4122 version/variant
// bits because seed UUIDs (e.g. "eeeeeeee-1111-0001-0001-eeeeeeeeeeee") use
// deterministic patterns that fail zod 4.x `.uuid()` strict validation.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const UuidString = z.string().regex(UUID_RE, "invalid uuid");

// ---------- enums ---------- //

export const CustomerStatus = z.enum(["active", "review", "pending"]);
export type CustomerStatus = z.infer<typeof CustomerStatus>;

// `CustomerPlan` (Starter/Pro/Enterprise) was removed in
// migrations/1715000003000_drop_customers_plan.sql — it collided with
// `organizations.plan` (the Kloser tenant subscription tier). Customer
// rows no longer carry a Kloser plan attribute.

export const CustomerSortKey = z.enum([
  "name",
  "created_at",
  "last_contacted_at",
]);
export type CustomerSortKey = z.infer<typeof CustomerSortKey>;

export const SortDirection = z.enum(["asc", "desc"]);
export type SortDirection = z.infer<typeof SortDirection>;

// ---------- input preprocessing helpers ---------- //
//
// `last_contacted_at` (POST/PATCH body):
//   undefined → undefined        (field absent — `.optional()` handles)
//   null      → null             (explicit unset)
//   Date      → Date
//   ISO 8601  → Date
//   "" / number / arbitrary string → reject
const LastContactedAt = z.preprocess((v) => {
  if (v === undefined || v === null) return v;
  if (v === "") return v; // preserved → inner z.date().nullable() rejects
  if (v instanceof Date) return v;
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : d;
  }
  return v;
}, z.date().nullable());

// ---------- input shapes ---------- //

export const CustomerCreateInput = z.object({
  name: z.string().trim().min(1).max(120),
  company: z.string().trim().max(120).nullable().optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  status: CustomerStatus.optional(),
  assigned_user_id: UuidString.nullable().optional(),
  last_contacted_at: LastContactedAt.optional(),
});
export type CustomerCreateInput = z.infer<typeof CustomerCreateInput>;

// PATCH base = same fields but all optional. Exposed for routes/tests that
// need raw partial schema (e.g., empty-patch detection split into a
// separate step). NOT a sync target — `.partial()` derived has no field
// declarations in the source text.
export const CustomerPatchBase = CustomerCreateInput.partial();
export const CustomerPatch = CustomerPatchBase.refine(
  (obj) => Object.keys(obj).length > 0,
  { message: "patch must include at least one field" },
);
export type CustomerPatch = z.infer<typeof CustomerPatch>;

// ---------- output (entity row) shape ---------- //
//
// Used for type derivation only — service does NOT runtime-parse DB rows
// through this schema (DB is a trusted boundary). Date columns stay as
// JS Date in service-internal flow; route layer serializes to ISO string
// when emitting JSON.

export const Customer = z.object({
  id: UuidString,
  org_id: UuidString,
  name: z.string(),
  company: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  status: CustomerStatus,
  assigned_user_id: UuidString.nullable(),
  last_contacted_at: z.date().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
});
export type Customer = z.infer<typeof Customer>;

// ---------- list query ---------- //
//
// Step 2 invalid-input policy preserved exactly:
//   q, sort, dir, limit, offset → preprocess/catch/default (silent fallback)
//   status, assignedUserId → reject on invalid (caller wraps to
//                            InvalidListOptionError)
//
// Invariant: `CustomerListQuery.safeParse(...)` only fails with issues
// whose path[0] is one of "status" | "assignedUserId". Schema changes
// that break this invariant violate the policy from
// PHASE_2_STEP_3_SHARED_TYPES.md §8.
//
// (`plan` was removed in 1715000003000_drop_customers_plan.sql — see
// note next to the CustomerStatus export.)

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

const ListStatus = z.preprocess((v) => {
  if (v === undefined || v === null || v === "") return undefined;
  return v;
}, CustomerStatus.optional());

const AssignedUserId = z.preprocess((v) => {
  if (v === undefined || v === "") return undefined;
  if (v === null || v === "null") return null;
  return v;
}, z.union([UuidString, z.null()]).optional());

export const CustomerListQuery = z.object({
  q: ListQ,
  status: ListStatus,
  assignedUserId: AssignedUserId,
  limit: ListLimit.default(20),
  offset: ListOffset.default(0),
  sort: CustomerSortKey.catch("created_at").default("created_at"),
  dir: SortDirection.catch("desc").default("desc"),
});
export type CustomerListQuery = z.infer<typeof CustomerListQuery>;

// ---------- stats response ---------- //

export const CustomerStats = z.object({
  total: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  review: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
});
export type CustomerStats = z.infer<typeof CustomerStats>;

// ---------- repository-internal filter subset ---------- //
//
// Used by `countForCurrentOrg(client, filters)` — same predicates as
// list, no pagination/sort. Kept here so repository imports just one
// types module, but excluded from sync registry (derived via Pick — no
// own field declarations).

export type CustomerListFilters = Pick<
  CustomerListQuery,
  "q" | "status" | "assignedUserId"
>;

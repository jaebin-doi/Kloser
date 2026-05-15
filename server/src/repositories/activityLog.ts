/* activity_log repository — Phase 7 Step 3.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_3_PLAN.md §5.
 *
 * `activity_log` has FORCE RLS with policy `(org_id = current_app_org_id())`
 * on both USING and WITH CHECK (migrations/1715000000000_init.sql §165-167).
 * Every helper assumes the caller wraps the call in `withOrgContext` (or an
 * equivalent transaction with `SET app.org_id = $1`). Bare-pool callers see
 * zero rows on SELECT and the RLS WITH CHECK rejects INSERTs.
 *
 * Schema hardening from migration 1715000024000:
 *   - action / target_type are CHECK-bound to the migration allow-lists.
 *     The TypeScript unions below MUST match those lists exactly. Drift
 *     surfaces as DB-level rejection, not silent corruption.
 *   - payload must be a JSON object (`jsonb_typeof(payload) = 'object'`).
 *     A bare array / string / number will be rejected by the DB even if
 *     it slips past TS.
 *   - composite indexes back the three list-by-discriminator queries
 *     (org+action, org+target, org+user) — buildFilterClauses below
 *     orders predicates to make the planner pick them.
 *
 * Pagination is cursor-only with `(created_at_ms, id)` under
 * `ORDER BY created_at_ms DESC, id DESC`. PostgreSQL stores timestamptz
 * at microsecond precision, while node-postgres returns JS Date values at
 * millisecond precision; truncating the DB side to milliseconds prevents a
 * cursor from dropping rows that share the same displayed timestamp.
 */
import type { PoolClient } from "pg";

// ============================================================ //
// Allow-list unions — MUST match
// migrations/1715000024000_phase7_activity_log_hardening.sql.
// Any divergence here produces a DB CHECK error at insert time
// (not a silent insert) — that is the intended fail-fast contract.
// ============================================================ //

export type ActivityAction =
  // auth
  | "auth.login"
  | "auth.logout"
  | "auth.refresh_mfa_required"
  | "auth.password_reset_requested"
  | "auth.password_reset_completed"
  | "auth.email_verified"
  | "auth.email_verification_resent"
  // mfa
  | "mfa.login_challenge_issued"
  | "mfa.login_verified"
  | "mfa.setup_started"
  | "mfa.enabled"
  | "mfa.disabled"
  | "mfa.failed_attempt"
  | "mfa.locked"
  // organization
  | "organization.mfa_required_enabled"
  | "organization.mfa_required_disabled"
  // membership
  | "membership.role_changed"
  | "membership.status_changed"
  | "membership.team_changed"
  // invitation
  | "invitation.created"
  | "invitation.resent"
  | "invitation.cancelled"
  | "invitation.accepted"
  // customer
  | "customer.created"
  | "customer.updated"
  | "customer.deleted"
  // call
  | "call.created"
  | "call.ended"
  | "call.customer_linked"
  | "call.customer_unlinked"
  | "call.notes_updated"
  | "call.manual_summary_updated"
  // call_action_item
  | "call_action_item.created"
  | "call_action_item.status_changed"
  | "call_action_item.assignee_changed"
  | "call_action_item.deleted"
  // knowledge
  | "knowledge_base.created"
  | "knowledge_base.updated"
  | "knowledge_base.deleted"
  | "knowledge_chunk.replaced"
  // checklist template
  | "checklist_template.created"
  | "checklist_template.updated"
  | "checklist_template.deleted"
  // report
  | "report.team_viewed";

export type ActivityTargetType =
  | "organization"
  | "user"
  | "membership"
  | "invitation"
  | "customer"
  | "call"
  | "call_action_item"
  | "knowledge_base"
  | "knowledge_chunk"
  | "checklist_template"
  | "auth_token"
  | "session"
  | "report";

// ============================================================ //
// Row type — `created_at` is a `Date` (pg parses timestamptz),
// `payload` is a plain JS object (pg parses jsonb). The DB CHECK
// guarantees payload is always an object, never null/array/string.
// ============================================================ //

export interface ActivityLogRow {
  id: string;
  org_id: string;
  user_id: string | null;
  action: ActivityAction;
  target_type: ActivityTargetType | null;
  target_id: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
}

const ACTIVITY_COLUMNS =
  "id, org_id, user_id, action, target_type, target_id, payload, created_at";

// ============================================================ //
// insertActivity
// ============================================================ //

export interface InsertActivityInput {
  orgId:        string;
  userId?:      string | null;
  action:       ActivityAction;
  targetType?:  ActivityTargetType | null;
  targetId?:    string | null;
  payload?:     Record<string, unknown>;
}

/** Drop top-level `undefined` keys so they never reach the jsonb column.
 *
 * pg's default jsonb serializer is `JSON.stringify`, which already drops
 * `undefined` values inside objects — but the contract here is explicit:
 * a caller passing `{ foo: undefined }` gets `{}` written, not `{ foo: null }`.
 * Deeper-nested `undefined` values are still dropped by `JSON.stringify` at
 * pg's protocol layer; this helper normalises the top level so the input
 * shape matches the row shape callers will read back.
 *
 * Deliberately shallow — the sanitizer in Step 3 service layer
 * (PHASE_7_STEP_3_PLAN.md §6) is the place to enforce deep policy
 * (forbidden key names, max length, etc.). Repository stays mechanical.
 */
function normalizePayload(
  input: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!input) return {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    const value = input[key];
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/** Insert one audit row.
 *
 * - `orgId` is written to the row; the RLS WITH CHECK then re-verifies it
 *   against `current_app_org_id()`. Passing the wrong org from inside a
 *   different org context surfaces as `row violates row-level security
 *   policy for table "activity_log"` — that is the intended trap.
 * - Defaults: `user_id`/`target_type`/`target_id` → null, `payload` → `{}`.
 * - SQL is fully parameterized — every value comes from `$N` bindings,
 *   never from string concatenation.
 */
export async function insertActivity(
  client: PoolClient,
  input: InsertActivityInput,
): Promise<ActivityLogRow> {
  const payload = normalizePayload(input.payload);
  const r = await client.query<ActivityLogRow>(
    `INSERT INTO activity_log (
        org_id, user_id, action, target_type, target_id, payload
     ) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${ACTIVITY_COLUMNS}`,
    [
      input.orgId,
      input.userId ?? null,
      input.action,
      input.targetType ?? null,
      input.targetId ?? null,
      payload,
    ],
  );
  // RETURNING on a successful INSERT always yields exactly one row.
  return r.rows[0]!;
}

/** Same INSERT as `insertActivity`, minus the RETURNING clause.
 *
 * Why a separate helper: PostgreSQL evaluates `INSERT ... RETURNING`
 * against the table's SELECT privilege as well as INSERT. The
 * `kloser_service` role (used by anonymous login-time MFA flows in
 * `services/auth.ts`) is granted INSERT-only on `activity_log`
 * (migration `1715000025000_phase7_activity_log_service_insert_grant.sql`,
 * which deliberately withholds SELECT/UPDATE/DELETE per plan §3.2).
 * Calling `insertActivity()` from a kloser_service connection fails
 * with `permission denied for table activity_log` even though the
 * INSERT itself is permitted, because RETURNING needs SELECT.
 *
 * `insertActivityVoid()` is the matching service-pool entry point:
 * same row, same sanitization contract (the service-layer caller
 * applies the sanitizer), no RETURNING, no read-back. Use it from
 * service-pool transactions only; app-pool callers should keep using
 * `insertActivity()` so they can inspect the row.
 */
export async function insertActivityVoid(
  client: PoolClient,
  input: InsertActivityInput,
): Promise<void> {
  const payload = normalizePayload(input.payload);
  await client.query(
    `INSERT INTO activity_log (
        org_id, user_id, action, target_type, target_id, payload
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.orgId,
      input.userId ?? null,
      input.action,
      input.targetType ?? null,
      input.targetId ?? null,
      payload,
    ],
  );
}

// ============================================================ //
// listForCurrentOrg / countForCurrentOrg
// ============================================================ //

export interface ActivityLogListFilters {
  action?:      ActivityAction;
  targetType?:  ActivityTargetType;
  targetId?:    string;
  userId?:      string;
  createdFrom?: Date;
  createdTo?:   Date;
}

export interface ActivityLogListQuery extends ActivityLogListFilters {
  /** Default 50, hard cap 100. The repository clamps silently — callers
   *  validating zod schemas at the route layer should match this cap. */
  limit?:           number;
  /** Cursor pair. Both must be present for the cursor to take effect;
   *  one without the other is treated as no cursor. */
  beforeCreatedAt?: Date;
  beforeId?:        string;
}

const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX     = 100;

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return LIST_LIMIT_DEFAULT;
  }
  const n = Math.floor(limit);
  if (n <= 0) return LIST_LIMIT_DEFAULT;
  if (n > LIST_LIMIT_MAX) return LIST_LIMIT_MAX;
  return n;
}

/** Build `WHERE ...` clauses + bound values for both list & count.
 *
 * Predicates land in this order so the planner's selectivity heuristic
 * picks the right partial/composite index from migration 1715000024000:
 *   action filter           → activity_log_org_action_created_idx
 *   user_id filter          → activity_log_org_user_created_idx (partial)
 *   target_type+target_id   → activity_log_org_target_created_idx (partial)
 *   date-range only         → activity_log_created_at_idx (init)
 * RLS pins `org_id = current_app_org_id()` in the policy itself, so we
 * do NOT add a `WHERE org_id = ...` clause here — that would force the
 * caller to know their own org and defeat the policy as the contract.
 */
function buildFilterClauses(
  filters: ActivityLogListFilters,
  startIndex: number,
): { clauses: string[]; values: unknown[] } {
  const clauses: string[] = [];
  const values: unknown[] = [];
  let i = startIndex;

  if (filters.action !== undefined) {
    clauses.push(`action = $${i}`);
    values.push(filters.action);
    i += 1;
  }
  if (filters.targetType !== undefined) {
    clauses.push(`target_type = $${i}`);
    values.push(filters.targetType);
    i += 1;
  }
  if (filters.targetId !== undefined) {
    clauses.push(`target_id = $${i}`);
    values.push(filters.targetId);
    i += 1;
  }
  if (filters.userId !== undefined) {
    clauses.push(`user_id = $${i}`);
    values.push(filters.userId);
    i += 1;
  }
  if (filters.createdFrom !== undefined) {
    clauses.push(`created_at >= $${i}`);
    values.push(filters.createdFrom);
    i += 1;
  }
  if (filters.createdTo !== undefined) {
    clauses.push(`created_at <= $${i}`);
    values.push(filters.createdTo);
    i += 1;
  }

  return { clauses, values };
}

/** List audit rows in the current org context, newest first, cursor-paginated.
 *
 * RLS is the only thing pinning org_id — the SELECT itself does not
 * include `WHERE org_id = ...`. Calling without `withOrgContext` (or
 * with a missing/blank `app.org_id` GUC) returns zero rows.
 *
 * Cursor semantics: row-tuple compare under DESC order.
 *   ORDER BY date_trunc('milliseconds', created_at) DESC, id DESC
 *   WHERE (date_trunc('milliseconds', created_at), id)
 *     < (date_trunc('milliseconds', beforeCreatedAt), beforeId)
 * Both cursor fields must be provided together; supplying only one
 * is treated as "no cursor" (defensive — a half-cursor is almost
 * always a caller bug).
 */
export async function listForCurrentOrg(
  client: PoolClient,
  query: ActivityLogListQuery,
): Promise<ActivityLogRow[]> {
  const { clauses, values } = buildFilterClauses(query, 1);

  if (query.beforeCreatedAt !== undefined && query.beforeId !== undefined) {
    const a = values.length + 1;
    const b = values.length + 2;
    clauses.push(
      `(date_trunc('milliseconds', created_at), id) < ` +
      `(date_trunc('milliseconds', $${a}::timestamptz), $${b}::uuid)`,
    );
    values.push(query.beforeCreatedAt, query.beforeId);
  }

  const limit = clampLimit(query.limit);
  const limitParam = `$${values.length + 1}`;
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const sql =
    `SELECT ${ACTIVITY_COLUMNS} FROM activity_log` +
    where +
    ` ORDER BY date_trunc('milliseconds', created_at) DESC, id DESC` +
    ` LIMIT ${limitParam}`;
  const r = await client.query<ActivityLogRow>(sql, [...values, limit]);
  return r.rows;
}

/** Count audit rows in the current org context matching the same filter set.
 *
 * Cursor params are intentionally ignored — count semantics ("how many
 * rows total") are independent of where the caller currently is in the
 * cursor stream. Callers wanting "remaining after this cursor" can pass
 * `createdTo: beforeCreatedAt` themselves.
 */
export async function countForCurrentOrg(
  client: PoolClient,
  filters: ActivityLogListFilters,
): Promise<number> {
  const { clauses, values } = buildFilterClauses(filters, 1);
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const sql =
    `SELECT count(*)::int AS n FROM activity_log` + where;
  const r = await client.query<{ n: number }>(sql, values);
  return r.rows[0]?.n ?? 0;
}

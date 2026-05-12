/* calls repository — Phase 4 Step 2.
 *
 * calls has FORCE ROW LEVEL SECURITY with policies built on
 * current_app_org_id() (1715000009000_phase4_calls.sql). A connection
 * running inside withOrgContext only sees its own org's rows, so reads
 * and updates do not filter by org_id explicitly — RLS is the authority.
 *
 * Inserts are the exception: the WITH CHECK policy compares the new row's
 * org_id against current_app_org_id(), so the column must be set.
 * insertInCurrentOrg takes orgId as a separate parameter — the caller
 * (service) passes actorOrgId, which RLS then re-verifies. CallCreateInput
 * deliberately has no org_id field, so request bodies cannot inject one.
 *
 * Every read/write filters `WHERE deleted_at IS NULL` so soft-deleted
 * calls stay invisible to the application even though RLS would still
 * allow same-org access.
 *
 * Composite FKs in the migration mean cross-org customer_id or
 * agent_user_id values are rejected by the database (23503), not just
 * filtered by RLS. The repository surface treats those as raw DB errors
 * for the caller to translate.
 *
 * Entity / input types are inlined here. Step 3 will move them to
 * server/src/types/calls.ts as zod schemas; until then this module is
 * the source of truth.
 */
import type { PoolClient } from "pg";

// ---------- entity + input types ---------- //

export type CallDirection = "inbound" | "outbound" | "meeting";
export type CallStatus = "in_progress" | "ended" | "missed" | "dropped";
export type CallSentiment = "positive" | "neutral" | "cautious" | "negative";
export type CallSummarySource = "ai" | "manual";
export type CallDroppedReason =
  | "browser_disconnect"
  | "server_timeout"
  | "manual";

export interface Call {
  id: string;
  org_id: string;
  customer_id: string | null;
  agent_user_id: string | null;
  direction: CallDirection;
  status: CallStatus;
  started_at: Date;
  ended_at: Date | null;
  duration_seconds: number | null;
  title: string | null;
  summary: string | null;
  needs: string | null;
  issues: string | null;
  sentiment: CallSentiment | null;
  notes: string | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
  // Phase 5 Step 1 — calls columns migration.
  summary_generated_at: Date | null;
  summary_source: CallSummarySource | null;
  last_seen_at: Date | null;
  dropped_reason: CallDroppedReason | null;
  customer_linked_at: Date | null;
  customer_linked_by_user_id: string | null;
}

export interface CallCreateInput {
  customer_id?: string | null;
  agent_user_id?: string | null;
  direction: CallDirection;
  status?: CallStatus;
  title?: string | null;
  notes?: string | null;
}

export interface CallListOptions {
  limit: number;
  offset: number;
  q?: string;
  customerId?: string | null;
  agentUserId?: string | null;
  status?: CallStatus;
}

// ---------- column projection ---------- //

const CALL_COLUMNS =
  "id, org_id, customer_id, agent_user_id, direction, status," +
  " started_at, ended_at, duration_seconds, title, summary, needs," +
  " issues, sentiment, notes, deleted_at, created_at, updated_at," +
  " summary_generated_at, summary_source, last_seen_at, dropped_reason," +
  " customer_linked_at, customer_linked_by_user_id";

// ---------- list filter clause builder ---------- //

function buildFilterClauses(
  opts: Pick<CallListOptions, "q" | "customerId" | "agentUserId" | "status">,
  startIndex: number,
): { clauses: string[]; values: unknown[] } {
  const clauses: string[] = ["deleted_at IS NULL"];
  const values: unknown[] = [];
  let i = startIndex;

  if (opts.q !== undefined && opts.q !== "") {
    // Phase 4 Step 2 scope: title/notes/summary only. Step 3 may extend to
    // joined customer name/company depending on route design.
    const pattern = "%" + opts.q.toLowerCase() + "%";
    clauses.push(
      `(lower(coalesce(title,'')) LIKE $${i}` +
        ` OR lower(coalesce(notes,'')) LIKE $${i}` +
        ` OR lower(coalesce(summary,'')) LIKE $${i})`,
    );
    values.push(pattern);
    i += 1;
  }

  if (opts.customerId !== undefined) {
    if (opts.customerId === null) {
      clauses.push("customer_id IS NULL");
    } else {
      clauses.push(`customer_id = $${i}`);
      values.push(opts.customerId);
      i += 1;
    }
  }

  if (opts.agentUserId !== undefined) {
    if (opts.agentUserId === null) {
      clauses.push("agent_user_id IS NULL");
    } else {
      clauses.push(`agent_user_id = $${i}`);
      values.push(opts.agentUserId);
      i += 1;
    }
  }

  if (opts.status !== undefined) {
    clauses.push(`status = $${i}`);
    values.push(opts.status);
    i += 1;
  }

  return { clauses, values };
}

// ---------- read ---------- //

export async function listForCurrentOrg(
  client: PoolClient,
  opts: CallListOptions,
): Promise<Call[]> {
  const { clauses, values } = buildFilterClauses(opts, 1);
  const limitParam = `$${values.length + 1}`;
  const offsetParam = `$${values.length + 2}`;
  // started_at DESC + id DESC keeps pagination stable when two rows share
  // started_at (e.g. seed data created in a single transaction). Matches
  // the partial indexes in the migration.
  const sql =
    `SELECT ${CALL_COLUMNS} FROM calls` +
    ` WHERE ${clauses.join(" AND ")}` +
    ` ORDER BY started_at DESC, id DESC` +
    ` LIMIT ${limitParam} OFFSET ${offsetParam}`;
  const r = await client.query<Call>(sql, [...values, opts.limit, opts.offset]);
  return r.rows;
}

export async function countForCurrentOrg(
  client: PoolClient,
  opts: Pick<CallListOptions, "q" | "customerId" | "agentUserId" | "status">,
): Promise<number> {
  const { clauses, values } = buildFilterClauses(opts, 1);
  const sql =
    `SELECT count(*)::int AS n FROM calls WHERE ${clauses.join(" AND ")}`;
  const r = await client.query<{ n: number }>(sql, values);
  return r.rows[0]?.n ?? 0;
}

export async function getByIdInCurrentOrg(
  client: PoolClient,
  id: string,
): Promise<Call | null> {
  const r = await client.query<Call>(
    `SELECT ${CALL_COLUMNS} FROM calls` +
      ` WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return r.rows[0] ?? null;
}

// FOR UPDATE row lock helper. Service callers (transcript append,
// endCall, action item create) use this to serialise concurrent writers
// against the same call. Returns null for cross-org / soft-deleted /
// missing ids, matching the read APIs.
export async function lockByIdInCurrentOrg(
  client: PoolClient,
  id: string,
): Promise<Call | null> {
  const r = await client.query<Call>(
    `SELECT ${CALL_COLUMNS} FROM calls` +
      ` WHERE id = $1 AND deleted_at IS NULL` +
      ` FOR UPDATE`,
    [id],
  );
  return r.rows[0] ?? null;
}

// ---------- write ---------- //

export async function insertInCurrentOrg(
  client: PoolClient,
  orgId: string,
  input: CallCreateInput,
): Promise<Call> {
  const r = await client.query<Call>(
    `INSERT INTO calls (
        org_id, customer_id, agent_user_id, direction, status,
        title, notes
     ) VALUES (
        $1, $2, $3, $4, COALESCE($5, 'in_progress'),
        $6, $7
     )
     RETURNING ${CALL_COLUMNS}`,
    [
      orgId,
      input.customer_id ?? null,
      input.agent_user_id ?? null,
      input.direction,
      input.status ?? null,
      input.title ?? null,
      input.notes ?? null,
    ],
  );
  return r.rows[0]!;
}

export async function patchNotesByIdInCurrentOrg(
  client: PoolClient,
  id: string,
  notes: string | null,
): Promise<Call | null> {
  const r = await client.query<Call>(
    `UPDATE calls SET notes = $1` +
      ` WHERE id = $2 AND deleted_at IS NULL` +
      ` RETURNING ${CALL_COLUMNS}`,
    [notes, id],
  );
  return r.rows[0] ?? null;
}

// Set status / ended_at / duration_seconds atomically. Service computes
// the final status (typically 'ended') and the ended_at timestamp before
// calling. duration_seconds is derived in SQL from ended_at - started_at
// with GREATEST(0, ...) so clock skew or a fix-up that pushes ended_at
// behind started_at still satisfies the CHECK constraint.
export async function endByIdInCurrentOrg(
  client: PoolClient,
  id: string,
  endedAt: Date,
  finalStatus: Extract<CallStatus, "ended" | "missed" | "dropped">,
): Promise<Call | null> {
  const r = await client.query<Call>(
    `UPDATE calls
        SET status           = $1,
            ended_at         = $2,
            duration_seconds = GREATEST(
                0,
                EXTRACT(EPOCH FROM ($2::timestamptz - started_at))::int
            )
      WHERE id = $3
        AND deleted_at IS NULL
      RETURNING ${CALL_COLUMNS}`,
    [finalStatus, endedAt, id],
  );
  return r.rows[0] ?? null;
}

export async function softDeleteByIdInCurrentOrg(
  client: PoolClient,
  id: string,
): Promise<boolean> {
  const r = await client.query(
    `UPDATE calls SET deleted_at = now()` +
      ` WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return (r.rowCount ?? 0) > 0;
}

// ---------- Phase 5 mutations ---------- //

// Heartbeat touch — only update last_seen_at for live, non-deleted calls.
// ended/missed/dropped calls return null so the WS heartbeat handler can
// stop pinging instead of resurrecting a closed call.
export async function touchHeartbeatInCurrentOrg(
  client: PoolClient,
  callId: string,
  seenAt: Date,
): Promise<Call | null> {
  const r = await client.query<Call>(
    `UPDATE calls
        SET last_seen_at = $1
      WHERE id = $2
        AND status = 'in_progress'
        AND deleted_at IS NULL
      RETURNING ${CALL_COLUMNS}`,
    [seenAt, callId],
  );
  return r.rows[0] ?? null;
}

// Sweep: mark in_progress calls whose last heartbeat predates `cutoff`
// as dropped/server_timeout. Returns the number of rows updated. Calls
// with last_seen_at IS NULL (no heartbeat yet) are NOT swept — Step 3
// will decide the policy for unheartbeated calls separately.
export async function markDroppedTimedOutInCurrentOrg(
  client: PoolClient,
  cutoff: Date,
  droppedAt: Date,
): Promise<number> {
  const r = await client.query(
    `UPDATE calls
        SET status           = 'dropped',
            dropped_reason   = 'server_timeout',
            ended_at         = $2,
            duration_seconds = GREATEST(
                0,
                EXTRACT(EPOCH FROM ($2::timestamptz - started_at))::int
            )
      WHERE status = 'in_progress'
        AND deleted_at IS NULL
        AND last_seen_at IS NOT NULL
        AND last_seen_at < $1`,
    [cutoff, droppedAt],
  );
  return r.rowCount ?? 0;
}

// Link / unlink a customer to an existing call. customerId === null
// clears the link (and stamps the unlink as a regular customer_linked_*
// update so audit trail records who touched it last). Wrong-org customer
// or wrong-org linker is rejected by the composite FK (23503) — repo
// surfaces the raw error for the caller to translate.
export async function linkCustomerInCurrentOrg(
  client: PoolClient,
  callId: string,
  customerId: string | null,
  linkedByUserId: string,
  linkedAt: Date,
): Promise<Call | null> {
  const r = await client.query<Call>(
    `UPDATE calls
        SET customer_id                 = $1,
            customer_linked_at          = $2,
            customer_linked_by_user_id  = $3
      WHERE id = $4
        AND deleted_at IS NULL
      RETURNING ${CALL_COLUMNS}`,
    [customerId, linkedAt, linkedByUserId, callId],
  );
  return r.rows[0] ?? null;
}

export interface CallSummaryPatch {
  summary: string | null;
  needs: string | null;
  issues: string | null;
  sentiment: CallSentiment | null;
}

// AI summary writer. Only overwrites if there is no source yet, or the
// existing source is 'ai'. summary_source='manual' is protected — the
// user's hand-written summary must survive a delayed AI worker push.
export async function updateAiSummaryInCurrentOrg(
  client: PoolClient,
  callId: string,
  patch: CallSummaryPatch,
  generatedAt: Date,
): Promise<Call | null> {
  const r = await client.query<Call>(
    `UPDATE calls
        SET summary               = $1,
            needs                 = $2,
            issues                = $3,
            sentiment             = $4,
            summary_generated_at  = $5,
            summary_source        = 'ai'
      WHERE id = $6
        AND deleted_at IS NULL
        AND (summary_source IS NULL OR summary_source = 'ai')
      RETURNING ${CALL_COLUMNS}`,
    [
      patch.summary,
      patch.needs,
      patch.issues,
      patch.sentiment,
      generatedAt,
      callId,
    ],
  );
  return r.rows[0] ?? null;
}

// Manual summary writer. Sets summary_source='manual' so a later AI
// worker push will be ignored by updateAiSummaryInCurrentOrg. We do not
// touch summary_generated_at — that column is the AI generation
// timestamp, not the last-edited timestamp (updated_at carries that).
export async function updateManualSummaryInCurrentOrg(
  client: PoolClient,
  callId: string,
  patch: CallSummaryPatch,
): Promise<Call | null> {
  const r = await client.query<Call>(
    `UPDATE calls
        SET summary        = $1,
            needs          = $2,
            issues         = $3,
            sentiment      = $4,
            summary_source = 'manual'
      WHERE id = $5
        AND deleted_at IS NULL
      RETURNING ${CALL_COLUMNS}`,
    [patch.summary, patch.needs, patch.issues, patch.sentiment, callId],
  );
  return r.rows[0] ?? null;
}

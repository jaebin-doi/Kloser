/* call_suggestions repository — Phase 5 Step 2.
 *
 * Persistent record of AI suggestion cards. Each row is one card; rows
 * sharing group_seq are the cards that surfaced at the same prompt point.
 *
 * (call_id, group_seq, type) UNIQUE means the LLM cannot push the same
 * card type into one group twice — duplicates raise 23505 from the DB.
 * The CHECK constraint forbids dismissed_at AND used_at being set at
 * the same time; a single suggestion has a single final outcome.
 *
 * Composite FK (org_id, call_id) blocks cross-org parents.
 * RLS FORCE on org_id = current_app_org_id() handles the per-org scope.
 */
import type { PoolClient } from "pg";

export type CallSuggestionTone =
  | "blue"
  | "cyan"
  | "amber"
  | "rose"
  | "emerald"
  | "slate";

export type CallSuggestionType =
  | "direction"
  | "script"
  | "alert"
  | "risk"
  | "next"
  | "kb";

export interface CallSuggestion {
  id: string;
  call_id: string;
  org_id: string;
  group_seq: number;
  at_ms: number;
  tone: CallSuggestionTone;
  type: CallSuggestionType;
  title: string;
  body: string | null;
  dismissed_at: Date | null;
  used_at: Date | null;
  created_at: Date;
}

export interface CallSuggestionInput {
  group_seq: number;
  at_ms: number;
  tone: CallSuggestionTone;
  type: CallSuggestionType;
  title: string;
  body?: string | null;
}

export interface SuggestionParentCall {
  call_id: string;
  agent_user_id: string | null;
}

const SUGGESTION_COLUMNS =
  "id, call_id, org_id, group_seq, at_ms, tone, type, title, body," +
  " dismissed_at, used_at, created_at";

async function findCallOrgId(
  client: PoolClient,
  callId: string,
): Promise<string | null> {
  const r = await client.query<{ org_id: string }>(
    `SELECT org_id FROM calls
      WHERE id = $1 AND deleted_at IS NULL`,
    [callId],
  );
  return r.rows[0]?.org_id ?? null;
}

// ---------- write ---------- //

// Insert a whole suggestion group at once. Returns null when the parent
// call is missing/cross-org/soft-deleted. Duplicate (call_id, group_seq,
// type) within `items`, or against a pre-existing row, raises 23505 from
// pg — the caller decides whether that is a real conflict or idempotent.
export async function insertGroupForCallInCurrentOrg(
  client: PoolClient,
  callId: string,
  items: CallSuggestionInput[],
): Promise<CallSuggestion[] | null> {
  const orgId = await findCallOrgId(client, callId);
  if (!orgId) return null;
  if (items.length === 0) return [];

  const inserted: CallSuggestion[] = [];
  for (const item of items) {
    const r = await client.query<CallSuggestion>(
      `INSERT INTO call_suggestions (
          org_id, call_id, group_seq, at_ms, tone, type, title, body
       ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8
       )
       RETURNING ${SUGGESTION_COLUMNS}`,
      [
        orgId,
        callId,
        item.group_seq,
        item.at_ms,
        item.tone,
        item.type,
        item.title,
        item.body ?? null,
      ],
    );
    inserted.push(r.rows[0]!);
  }
  return inserted;
}

// Mark used. Service guard rejects double-mark or mark-after-dismiss
// before this UPDATE runs — see services/callSuggestions.ts. SQL
// returns null when the suggestion doesn't exist in this org.
export async function markUsedInCurrentOrg(
  client: PoolClient,
  id: string,
  usedAt: Date,
): Promise<CallSuggestion | null> {
  const r = await client.query<CallSuggestion>(
    `UPDATE call_suggestions
        SET used_at = $1
      WHERE id = $2
        AND dismissed_at IS NULL
        AND used_at IS NULL
      RETURNING ${SUGGESTION_COLUMNS}`,
    [usedAt, id],
  );
  return r.rows[0] ?? null;
}

export async function markDismissedInCurrentOrg(
  client: PoolClient,
  id: string,
  dismissedAt: Date,
): Promise<CallSuggestion | null> {
  const r = await client.query<CallSuggestion>(
    `UPDATE call_suggestions
        SET dismissed_at = $1
      WHERE id = $2
        AND dismissed_at IS NULL
        AND used_at IS NULL
      RETURNING ${SUGGESTION_COLUMNS}`,
    [dismissedAt, id],
  );
  return r.rows[0] ?? null;
}

// ---------- read ---------- //

export async function listByCallInCurrentOrg(
  client: PoolClient,
  callId: string,
): Promise<CallSuggestion[] | null> {
  const orgId = await findCallOrgId(client, callId);
  if (!orgId) return null;
  const r = await client.query<CallSuggestion>(
    `SELECT ${SUGGESTION_COLUMNS} FROM call_suggestions
      WHERE call_id = $1
      ORDER BY group_seq ASC, at_ms ASC, type ASC, id ASC`,
    [callId],
  );
  return r.rows;
}

export async function getByIdInCurrentOrg(
  client: PoolClient,
  id: string,
): Promise<CallSuggestion | null> {
  const r = await client.query<CallSuggestion>(
    `SELECT ${SUGGESTION_COLUMNS} FROM call_suggestions
      WHERE id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

// Resolve the parent call (and its agent) from a suggestion id, for
// service-layer permission checks before use/dismiss mutations.
export async function getParentCallForSuggestion(
  client: PoolClient,
  id: string,
): Promise<SuggestionParentCall | null> {
  const r = await client.query<SuggestionParentCall>(
    `SELECT c.id           AS call_id,
            c.agent_user_id AS agent_user_id
       FROM call_suggestions s
       JOIN calls c ON c.id = s.call_id
      WHERE s.id = $1
        AND c.deleted_at IS NULL`,
    [id],
  );
  return r.rows[0] ?? null;
}

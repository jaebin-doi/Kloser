/* call_action_items repository — Phase 4 Step 2.
 *
 * Each row is one follow-up task attached to a call. Step 1 migration:
 *   - denormalises org_id (RLS authority, no JOIN)
 *   - (org_id, call_id) composite FK against calls(org_id, id) blocks
 *     cross-org pointers at the DB layer
 *   - (org_id, assignee_user_id) composite FK against
 *     memberships(org_id, user_id) — assignees must belong to the org
 *   - CHECK ((status='done' AND completed_at IS NOT NULL)
 *           OR (status<>'done' AND completed_at IS NULL))
 *
 * The CHECK constraint is the source of truth for the status/timestamp
 * relationship. The repository keeps the SQL aligned with that contract
 * so the application never tries to write a forbidden combination.
 *
 * Cross-org or missing call ids surface as `null` from create/list, and
 * `null` from patches when the action item id is invalid. This lets
 * Step 3 routes map cleanly to 404 without exposing existence.
 */
import type { PoolClient } from "pg";

// ---------- entity + input types ---------- //

export type CallActionItemStatus = "open" | "done" | "dropped";

export interface CallActionItem {
  id: string;
  call_id: string;
  org_id: string;
  title: string;
  due_date: string | null; // pg returns DATE as YYYY-MM-DD string
  assignee_user_id: string | null;
  status: CallActionItemStatus;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ActionItemCreateInput {
  title: string;
  due_date?: string | null;
  assignee_user_id?: string | null;
}

const ACTION_ITEM_COLUMNS =
  "id, call_id, org_id, title, due_date, assignee_user_id, status," +
  " completed_at, created_at, updated_at";

// ---------- helpers ---------- //

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

async function lockCallOrgId(
  client: PoolClient,
  callId: string,
): Promise<string | null> {
  const r = await client.query<{ org_id: string }>(
    `SELECT org_id FROM calls
      WHERE id = $1 AND deleted_at IS NULL
      FOR UPDATE`,
    [callId],
  );
  return r.rows[0]?.org_id ?? null;
}

// ---------- write ---------- //

export async function createForCallInCurrentOrg(
  client: PoolClient,
  callId: string,
  input: ActionItemCreateInput,
): Promise<CallActionItem | null> {
  // RLS hides cross-org calls, so a missing row here means either the
  // call really doesn't exist or it belongs to a different org. Either
  // way, callers treat the answer as "not found" without leaking which.
  const orgId = await lockCallOrgId(client, callId);
  if (!orgId) return null;

  const r = await client.query<CallActionItem>(
    `INSERT INTO call_action_items (
        org_id, call_id, title, due_date, assignee_user_id, status, completed_at
     ) VALUES (
        $1, $2, $3, $4, $5, 'open', NULL
     )
     RETURNING ${ACTION_ITEM_COLUMNS}`,
    [
      orgId,
      callId,
      input.title,
      input.due_date ?? null,
      input.assignee_user_id ?? null,
    ],
  );
  return r.rows[0]!;
}

// `done` flips completed_at to now() inside the same UPDATE so the
// CHECK constraint never sees a transient mismatch. open/dropped clear
// completed_at for the same reason.
export async function patchStatusInCurrentOrg(
  client: PoolClient,
  id: string,
  status: CallActionItemStatus,
): Promise<CallActionItem | null> {
  if (status === "done") {
    const r = await client.query<CallActionItem>(
      `UPDATE call_action_items
          SET status = 'done',
              completed_at = now()
        WHERE id = $1
          AND EXISTS (
            SELECT 1 FROM calls
             WHERE calls.id = call_action_items.call_id
               AND calls.deleted_at IS NULL
          )
        RETURNING ${ACTION_ITEM_COLUMNS}`,
      [id],
    );
    return r.rows[0] ?? null;
  }

  const r = await client.query<CallActionItem>(
    `UPDATE call_action_items
        SET status = $1,
            completed_at = NULL
      WHERE id = $2
        AND EXISTS (
          SELECT 1 FROM calls
           WHERE calls.id = call_action_items.call_id
             AND calls.deleted_at IS NULL
        )
      RETURNING ${ACTION_ITEM_COLUMNS}`,
    [status, id],
  );
  return r.rows[0] ?? null;
}

// Hard delete by id within the current org context. Phase 6 Step 3.
//
// RLS hides cross-org rows, and the EXISTS-on-calls guard mirrors the
// status / assignee patch path: a soft-deleted parent call freezes its
// action items in place too. Returns true when one row was removed,
// false otherwise (missing / cross-org / soft-deleted parent / repeated
// delete). The service layer maps `false` to a 404 so the route never
// leaks whether the action item existed in a different org.
export async function deleteByIdInCurrentOrg(
  client: PoolClient,
  id: string,
): Promise<boolean> {
  const r = await client.query<{ id: string }>(
    `DELETE FROM call_action_items
      WHERE id = $1
        AND EXISTS (
          SELECT 1 FROM calls
           WHERE calls.id = call_action_items.call_id
             AND calls.deleted_at IS NULL
        )
      RETURNING id`,
    [id],
  );
  return r.rowCount === 1;
}

// Cross-org assignee values are rejected by the composite FK at the DB
// layer (23503), so the repository does not need to pre-check. Same-org
// nulls flow through unchanged.
export async function patchAssigneeInCurrentOrg(
  client: PoolClient,
  id: string,
  assigneeUserId: string | null,
): Promise<CallActionItem | null> {
  const r = await client.query<CallActionItem>(
    `UPDATE call_action_items
        SET assignee_user_id = $1
      WHERE id = $2
        AND EXISTS (
          SELECT 1 FROM calls
           WHERE calls.id = call_action_items.call_id
             AND calls.deleted_at IS NULL
        )
      RETURNING ${ACTION_ITEM_COLUMNS}`,
    [assigneeUserId, id],
  );
  return r.rows[0] ?? null;
}

// ---------- read ---------- //

export async function listByCallInCurrentOrg(
  client: PoolClient,
  callId: string,
): Promise<CallActionItem[] | null> {
  const orgId = await findCallOrgId(client, callId);
  if (!orgId) return null;

  // due_date ASC (nulls last) + created_at to give "todo-feed" ordering
  // by deadline, falling back to creation time for ties / undated items.
  const r = await client.query<CallActionItem>(
    `SELECT ${ACTION_ITEM_COLUMNS} FROM call_action_items
      WHERE call_id = $1
      ORDER BY due_date ASC NULLS LAST, created_at ASC`,
    [callId],
  );
  return r.rows;
}

// Resolve the parent call for an action item id. Routes that mutate an
// action item by its own id (POST /call-action-items/:id/status,
// /assignee) use this to fetch the parent call so the employee-own-call
// permission check can run before the patch. Cross-org / soft-deleted
// parents return null — RLS hides the action item too, so the route's
// 404 vs 403 ordering can't distinguish the two.
//
// We return both ids and the agent so the caller does not need to chase
// another round-trip through the calls repo.
export interface ActionItemParentCall {
  call_id: string;
  agent_user_id: string | null;
}

export async function getParentCallForActionItem(
  client: PoolClient,
  actionItemId: string,
): Promise<ActionItemParentCall | null> {
  const r = await client.query<ActionItemParentCall>(
    `SELECT c.id           AS call_id,
            c.agent_user_id AS agent_user_id
       FROM call_action_items a
       JOIN calls c ON c.id = a.call_id
      WHERE a.id = $1
        AND c.deleted_at IS NULL`,
    [actionItemId],
  );
  return r.rows[0] ?? null;
}

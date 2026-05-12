/* call_checklist_items repository — Phase 5 Step 2.
 *
 * Per-call progress rows initialised from the org's active templates.
 * (call_id, template_id) UNIQUE makes the snapshot idempotent — calling
 * initializeForCallInCurrentOrg twice does not duplicate rows.
 *
 * status / checked_at consistency is enforced by a DB CHECK:
 *   (done AND checked_at IS NOT NULL) OR (open AND checked_at IS NULL).
 * markStatusInCurrentOrg always flips both fields together so the
 * constraint never sees a transient mismatch.
 *
 * Composite FKs against (org_id, call_id) and (org_id, template_id)
 * block cross-org pointers at insert time. (org_id, checked_by_user_id)
 * against memberships blocks wrong-org checkers.
 */
import type { PoolClient } from "pg";

export type CallChecklistStatus = "open" | "done";

export interface CallChecklistItem {
  id: string;
  call_id: string;
  template_id: string;
  org_id: string;
  status: CallChecklistStatus;
  checked_at: Date | null;
  checked_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ChecklistItemParentCall {
  call_id: string;
  agent_user_id: string | null;
}

const CHECKLIST_ITEM_COLUMNS =
  "id, call_id, template_id, org_id, status, checked_at," +
  " checked_by_user_id, created_at, updated_at";

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

// Copy currently-active templates into call_checklist_items as 'open'
// rows for the given call. Re-running is idempotent because of the
// (call_id, template_id) UNIQUE — ON CONFLICT DO NOTHING. Returns the
// final list of items for the call (including rows that pre-existed).
// Returns null when the call is missing/cross-org/soft-deleted.
export async function initializeForCallInCurrentOrg(
  client: PoolClient,
  callId: string,
): Promise<CallChecklistItem[] | null> {
  const orgId = await lockCallOrgId(client, callId);
  if (!orgId) return null;

  // Single INSERT ... SELECT that pulls active templates and skips rows
  // already present. RLS keeps both sides scoped to the current org.
  await client.query(
    `INSERT INTO call_checklist_items (
        org_id, call_id, template_id, status, checked_at
     )
     SELECT $1, $2, t.id, 'open', NULL
       FROM org_call_checklist_templates t
      WHERE t.active = true
     ON CONFLICT (call_id, template_id) DO NOTHING`,
    [orgId, callId],
  );

  const r = await client.query<CallChecklistItem>(
    `SELECT ${CHECKLIST_ITEM_COLUMNS} FROM call_checklist_items
      WHERE call_id = $1
      ORDER BY created_at ASC, id ASC`,
    [callId],
  );
  return r.rows;
}

export async function listByCallInCurrentOrg(
  client: PoolClient,
  callId: string,
): Promise<CallChecklistItem[] | null> {
  const orgId = await findCallOrgId(client, callId);
  if (!orgId) return null;
  const r = await client.query<CallChecklistItem>(
    `SELECT ${CHECKLIST_ITEM_COLUMNS} FROM call_checklist_items
      WHERE call_id = $1
      ORDER BY created_at ASC, id ASC`,
    [callId],
  );
  return r.rows;
}

// done → checked_at = now(), checked_by_user_id = $userId.
// open → checked_at = NULL, checked_by_user_id = NULL.
// Both fields are written together so the CHECK constraint stays valid.
export async function markStatusInCurrentOrg(
  client: PoolClient,
  itemId: string,
  status: CallChecklistStatus,
  checkedByUserId: string | null,
): Promise<CallChecklistItem | null> {
  if (status === "done") {
    const r = await client.query<CallChecklistItem>(
      `UPDATE call_checklist_items
          SET status             = 'done',
              checked_at         = now(),
              checked_by_user_id = $1
        WHERE id = $2
        RETURNING ${CHECKLIST_ITEM_COLUMNS}`,
      [checkedByUserId, itemId],
    );
    return r.rows[0] ?? null;
  }
  const r = await client.query<CallChecklistItem>(
    `UPDATE call_checklist_items
        SET status             = 'open',
            checked_at         = NULL,
            checked_by_user_id = NULL
      WHERE id = $1
      RETURNING ${CHECKLIST_ITEM_COLUMNS}`,
    [itemId],
  );
  return r.rows[0] ?? null;
}

// Resolve the parent call (and its agent) from a checklist item id.
// Used by mutation services to run assertCanMutateCall before touching
// the item itself.
export async function getParentCallForChecklistItem(
  client: PoolClient,
  itemId: string,
): Promise<ChecklistItemParentCall | null> {
  const r = await client.query<ChecklistItemParentCall>(
    `SELECT c.id           AS call_id,
            c.agent_user_id AS agent_user_id
       FROM call_checklist_items i
       JOIN calls c ON c.id = i.call_id
      WHERE i.id = $1
        AND c.deleted_at IS NULL`,
    [itemId],
  );
  return r.rows[0] ?? null;
}

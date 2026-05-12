/* org_call_checklist_templates repository — Phase 5 Step 2.
 *
 * Per-org master of "things every call should hit" — the static 5-item
 * fixture from Phase 0.5 promoted to an editable list. Active=false is
 * the soft-inactive flag: inactive items stop being copied into new
 * call_checklist_items rows but historic progress rows survive.
 *
 * RLS FORCE on org_id = current_app_org_id() — no org filter in SQL.
 * INSERT requires the caller to pass orgId for the WITH CHECK.
 */
import type { PoolClient } from "pg";

export interface CallChecklistTemplate {
  id: string;
  org_id: string;
  title: string;
  sort_order: number;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface CallChecklistTemplateCreateInput {
  title: string;
  sort_order?: number;
  active?: boolean;
}

export interface CallChecklistTemplatePatchInput {
  title?: string;
  sort_order?: number;
  active?: boolean;
}

const TEMPLATE_COLUMNS =
  "id, org_id, title, sort_order, active, created_at, updated_at";

// ---------- read ---------- //

export async function listForCurrentOrg(
  client: PoolClient,
): Promise<CallChecklistTemplate[]> {
  const r = await client.query<CallChecklistTemplate>(
    `SELECT ${TEMPLATE_COLUMNS} FROM org_call_checklist_templates
      ORDER BY sort_order ASC, created_at ASC, id ASC`,
  );
  return r.rows;
}

export async function listActiveForCurrentOrg(
  client: PoolClient,
): Promise<CallChecklistTemplate[]> {
  const r = await client.query<CallChecklistTemplate>(
    `SELECT ${TEMPLATE_COLUMNS} FROM org_call_checklist_templates
      WHERE active = true
      ORDER BY sort_order ASC, created_at ASC, id ASC`,
  );
  return r.rows;
}

export async function getByIdInCurrentOrg(
  client: PoolClient,
  id: string,
): Promise<CallChecklistTemplate | null> {
  const r = await client.query<CallChecklistTemplate>(
    `SELECT ${TEMPLATE_COLUMNS} FROM org_call_checklist_templates
      WHERE id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

// ---------- write ---------- //

export async function insertInCurrentOrg(
  client: PoolClient,
  orgId: string,
  input: CallChecklistTemplateCreateInput,
): Promise<CallChecklistTemplate> {
  const r = await client.query<CallChecklistTemplate>(
    `INSERT INTO org_call_checklist_templates (
        org_id, title, sort_order, active
     ) VALUES (
        $1, $2, COALESCE($3, 0), COALESCE($4, true)
     )
     RETURNING ${TEMPLATE_COLUMNS}`,
    [orgId, input.title, input.sort_order ?? null, input.active ?? null],
  );
  return r.rows[0]!;
}

export async function patchInCurrentOrg(
  client: PoolClient,
  id: string,
  input: CallChecklistTemplatePatchInput,
): Promise<CallChecklistTemplate | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (input.title !== undefined) {
    sets.push(`title = $${i}`);
    values.push(input.title);
    i += 1;
  }
  if (input.sort_order !== undefined) {
    sets.push(`sort_order = $${i}`);
    values.push(input.sort_order);
    i += 1;
  }
  if (input.active !== undefined) {
    sets.push(`active = $${i}`);
    values.push(input.active);
    i += 1;
  }
  if (sets.length === 0) {
    return getByIdInCurrentOrg(client, id);
  }
  values.push(id);
  const r = await client.query<CallChecklistTemplate>(
    `UPDATE org_call_checklist_templates
        SET ${sets.join(", ")}
      WHERE id = $${i}
      RETURNING ${TEMPLATE_COLUMNS}`,
    values,
  );
  return r.rows[0] ?? null;
}

export async function setActiveInCurrentOrg(
  client: PoolClient,
  id: string,
  active: boolean,
): Promise<CallChecklistTemplate | null> {
  const r = await client.query<CallChecklistTemplate>(
    `UPDATE org_call_checklist_templates
        SET active = $1
      WHERE id = $2
      RETURNING ${TEMPLATE_COLUMNS}`,
    [active, id],
  );
  return r.rows[0] ?? null;
}

export async function deleteByIdInCurrentOrg(
  client: PoolClient,
  id: string,
): Promise<boolean> {
  const r = await client.query(
    `DELETE FROM org_call_checklist_templates WHERE id = $1`,
    [id],
  );
  return (r.rowCount ?? 0) > 0;
}

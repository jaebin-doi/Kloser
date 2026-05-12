/* knowledge_bases repository — Phase 5 Step 2.
 *
 * knowledge_bases is org-scoped with FORCE ROW LEVEL SECURITY built on
 * current_app_org_id() — migrations/1715000014000_phase5_knowledge.sql.
 * A connection running inside withOrgContext only sees its own org's
 * rows, so reads/updates do not filter by org_id explicitly.
 *
 * INSERT is the exception: the WITH CHECK policy requires the new row's
 * org_id to match current_app_org_id(). insertInCurrentOrg takes orgId
 * as a separate parameter so the caller passes actorOrgId, which RLS
 * then re-verifies. KnowledgeBaseCreateInput has no org_id field.
 *
 * created_by_user_id is bound by the (org_id, user_id) composite FK
 * against memberships, so cross-org user ids surface as 23503.
 *
 * Soft delete uses deleted_at to hide from list/get without affecting
 * chunks. Hard delete would cascade to chunks; the chunks themselves
 * become invisible because list/get of the parent filter deleted_at.
 */
import type { PoolClient } from "pg";

export type KnowledgeBaseSourceType = "manual" | "file" | "url";

export interface KnowledgeBase {
  id: string;
  org_id: string;
  title: string;
  source_type: KnowledgeBaseSourceType;
  source_uri: string | null;
  created_by_user_id: string | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface KnowledgeBaseCreateInput {
  title: string;
  source_type: KnowledgeBaseSourceType;
  source_uri?: string | null;
  created_by_user_id?: string | null;
}

export interface KnowledgeBasePatchInput {
  title?: string;
  source_type?: KnowledgeBaseSourceType;
  source_uri?: string | null;
}

export interface KnowledgeBaseListOptions {
  limit: number;
  offset: number;
}

const KNOWLEDGE_BASE_COLUMNS =
  "id, org_id, title, source_type, source_uri, created_by_user_id," +
  " deleted_at, created_at, updated_at";

// ---------- read ---------- //

export async function listForCurrentOrg(
  client: PoolClient,
  opts: KnowledgeBaseListOptions,
): Promise<KnowledgeBase[]> {
  const r = await client.query<KnowledgeBase>(
    `SELECT ${KNOWLEDGE_BASE_COLUMNS} FROM knowledge_bases
      WHERE deleted_at IS NULL
      ORDER BY updated_at DESC, id DESC
      LIMIT $1 OFFSET $2`,
    [opts.limit, opts.offset],
  );
  return r.rows;
}

export async function getByIdInCurrentOrg(
  client: PoolClient,
  id: string,
): Promise<KnowledgeBase | null> {
  const r = await client.query<KnowledgeBase>(
    `SELECT ${KNOWLEDGE_BASE_COLUMNS} FROM knowledge_bases
      WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return r.rows[0] ?? null;
}

// ---------- write ---------- //

export async function insertInCurrentOrg(
  client: PoolClient,
  orgId: string,
  input: KnowledgeBaseCreateInput,
): Promise<KnowledgeBase> {
  const r = await client.query<KnowledgeBase>(
    `INSERT INTO knowledge_bases (
        org_id, title, source_type, source_uri, created_by_user_id
     ) VALUES (
        $1, $2, $3, $4, $5
     )
     RETURNING ${KNOWLEDGE_BASE_COLUMNS}`,
    [
      orgId,
      input.title,
      input.source_type,
      input.source_uri ?? null,
      input.created_by_user_id ?? null,
    ],
  );
  return r.rows[0]!;
}

export async function patchInCurrentOrg(
  client: PoolClient,
  id: string,
  input: KnowledgeBasePatchInput,
): Promise<KnowledgeBase | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (input.title !== undefined) {
    sets.push(`title = $${i}`);
    values.push(input.title);
    i += 1;
  }
  if (input.source_type !== undefined) {
    sets.push(`source_type = $${i}`);
    values.push(input.source_type);
    i += 1;
  }
  if (input.source_uri !== undefined) {
    sets.push(`source_uri = $${i}`);
    values.push(input.source_uri);
    i += 1;
  }
  if (sets.length === 0) {
    return getByIdInCurrentOrg(client, id);
  }
  values.push(id);
  const r = await client.query<KnowledgeBase>(
    `UPDATE knowledge_bases
        SET ${sets.join(", ")}
      WHERE id = $${i} AND deleted_at IS NULL
      RETURNING ${KNOWLEDGE_BASE_COLUMNS}`,
    values,
  );
  return r.rows[0] ?? null;
}

export async function softDeleteByIdInCurrentOrg(
  client: PoolClient,
  id: string,
): Promise<boolean> {
  const r = await client.query(
    `UPDATE knowledge_bases SET deleted_at = now()
      WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return (r.rowCount ?? 0) > 0;
}

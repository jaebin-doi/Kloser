/* customers repository.
 *
 * customers has FORCE ROW LEVEL SECURITY with policies built on
 * current_app_org_id() — see migrations/1715000002000_customers.sql §97-111.
 * A connection running inside withOrgContext sees only its own org's rows,
 * so SELECT/UPDATE/DELETE in this module do not filter by org_id explicitly.
 *
 * INSERT is the one exception: the policy's WITH CHECK compares the new
 * row's org_id against current_app_org_id(), so the column must be set.
 * insertInCurrentOrg takes orgId as a separate parameter — the caller
 * (service) passes actorOrgId, which RLS then re-verifies. CustomerCreateInput
 * deliberately has no org_id field, so request bodies cannot inject one.
 *
 * Every read/write filters `WHERE deleted_at IS NULL`. The six partial
 * indexes in the migration are all keyed on that predicate; missing it
 * defeats the index AND leaks soft-deleted rows.
 *
 * No `existsByIdInCurrentOrg` — PATCH and DELETE return null/false from
 * RETURNING when the row is missing/deleted, which Step 4 routes map to 404.
 */
import type { PoolClient } from "pg";
import type {
  Customer,
  CustomerCreateInput,
  CustomerListFilters,
  CustomerListQuery,
  CustomerPatch,
  CustomerSortKey,
  CustomerStats,
  SortDirection,
} from "../types/customers.js";

// Repository accepts the parsed list query directly. CustomerListQuery
// from shared types carries limit/offset/sort/dir as required (defaults
// applied by zod) plus the optional filter fields.
export type CustomerListOptions = CustomerListQuery;
export type {
  Customer,
  CustomerCreateInput,
  CustomerListFilters,
  CustomerPatch,
  CustomerSortKey,
  CustomerStats,
  SortDirection,
};

const CUSTOMER_COLUMNS =
  "id, org_id, name, company, email, phone, status," +
  " assigned_user_id, last_contacted_at, created_at, updated_at";

const SORT_EXPR: Record<CustomerSortKey, string> = {
  name: "lower(name)",
  created_at: "created_at",
  last_contacted_at: "last_contacted_at",
};

function buildOrderBy(sort: CustomerSortKey, dir: SortDirection): string {
  // sort/dir are validated by the service before reaching here, but we
  // still gate on the whitelist maps so a future caller cannot inject
  // arbitrary SQL via these structural params.
  const expr = SORT_EXPR[sort];
  const direction = dir === "asc" ? "ASC" : "DESC";
  // last_contacted_at NULLS LAST keeps recently-contacted rows at the
  // top regardless of direction; the partial indexes do not include
  // last_contacted_at so the sort is sequential either way.
  if (sort === "last_contacted_at") {
    return `ORDER BY ${expr} ${direction} NULLS LAST, id ${direction}`;
  }
  return `ORDER BY ${expr} ${direction}, id ${direction}`;
}

function buildFilterClauses(
  filters: CustomerListFilters,
  startIndex: number,
): { clauses: string[]; values: unknown[] } {
  const clauses: string[] = ["deleted_at IS NULL"];
  const values: unknown[] = [];
  let i = startIndex;

  if (filters.q !== undefined) {
    const pattern = "%" + filters.q.toLowerCase() + "%";
    // ILIKE on lower(...) lets the partial indexes on lower(name)/lower(email)/
    // lower(company) participate when the pattern is a prefix; substring
    // patterns degrade to seq scan but stay correct.
    clauses.push(
      `(lower(name) LIKE $${i} OR lower(email::text) LIKE $${i} OR lower(company) LIKE $${i})`,
    );
    values.push(pattern);
    i += 1;
  }

  if (filters.status !== undefined) {
    clauses.push(`status = $${i}`);
    values.push(filters.status);
    i += 1;
  }

  if (filters.assignedUserId !== undefined) {
    if (filters.assignedUserId === null) {
      clauses.push("assigned_user_id IS NULL");
    } else {
      clauses.push(`assigned_user_id = $${i}`);
      values.push(filters.assignedUserId);
      i += 1;
    }
  }

  return { clauses, values };
}

export async function listForCurrentOrg(
  client: PoolClient,
  opts: CustomerListOptions,
): Promise<Customer[]> {
  const { clauses, values } = buildFilterClauses(opts, 1);
  const orderBy = buildOrderBy(opts.sort, opts.dir);
  const limitParam = `$${values.length + 1}`;
  const offsetParam = `$${values.length + 2}`;
  const sql =
    `SELECT ${CUSTOMER_COLUMNS} FROM customers` +
    ` WHERE ${clauses.join(" AND ")}` +
    ` ${orderBy}` +
    ` LIMIT ${limitParam} OFFSET ${offsetParam}`;
  const r = await client.query<Customer>(sql, [...values, opts.limit, opts.offset]);
  return r.rows;
}

export async function countForCurrentOrg(
  client: PoolClient,
  filters: CustomerListFilters,
): Promise<number> {
  const { clauses, values } = buildFilterClauses(filters, 1);
  const sql =
    `SELECT count(*)::int AS n FROM customers` +
    ` WHERE ${clauses.join(" AND ")}`;
  const r = await client.query<{ n: number }>(sql, values);
  return r.rows[0]?.n ?? 0;
}

export async function statsForCurrentOrg(
  client: PoolClient,
): Promise<CustomerStats> {
  const r = await client.query<{
    total: number;
    active: number;
    review: number;
    pending: number;
  }>(
    `SELECT
        count(*)::int                                           AS total,
        count(*) FILTER (WHERE status = 'active')::int          AS active,
        count(*) FILTER (WHERE status = 'review')::int          AS review,
        count(*) FILTER (WHERE status = 'pending')::int         AS pending
       FROM customers
      WHERE deleted_at IS NULL`,
  );
  const row = r.rows[0];
  if (!row) return { total: 0, active: 0, review: 0, pending: 0 };
  return row;
}

export async function getByIdInCurrentOrg(
  client: PoolClient,
  id: string,
): Promise<Customer | null> {
  const r = await client.query<Customer>(
    `SELECT ${CUSTOMER_COLUMNS} FROM customers` +
      ` WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return r.rows[0] ?? null;
}

export async function insertInCurrentOrg(
  client: PoolClient,
  orgId: string,
  input: CustomerCreateInput,
): Promise<Customer> {
  const r = await client.query<Customer>(
    `INSERT INTO customers (
        org_id, name, company, email, phone, status,
        assigned_user_id, last_contacted_at
     ) VALUES (
        $1, $2, $3, $4, $5,
        COALESCE($6, 'pending'),
        $7, $8
     )
     RETURNING ${CUSTOMER_COLUMNS}`,
    [
      orgId,
      input.name,
      input.company ?? null,
      input.email ?? null,
      input.phone ?? null,
      input.status ?? null,
      input.assigned_user_id ?? null,
      input.last_contacted_at ?? null,
    ],
  );
  return r.rows[0]!;
}

export async function updateByIdInCurrentOrg(
  client: PoolClient,
  id: string,
  patch: CustomerPatch,
): Promise<Customer | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  const push = (column: string, value: unknown): void => {
    sets.push(`${column} = $${i}`);
    values.push(value);
    i += 1;
  };

  if (patch.name !== undefined) push("name", patch.name);
  if (patch.company !== undefined) push("company", patch.company);
  if (patch.email !== undefined) push("email", patch.email);
  if (patch.phone !== undefined) push("phone", patch.phone);
  if (patch.status !== undefined) push("status", patch.status);
  if (patch.assigned_user_id !== undefined)
    push("assigned_user_id", patch.assigned_user_id);
  if (patch.last_contacted_at !== undefined)
    push("last_contacted_at", patch.last_contacted_at);

  if (sets.length === 0) {
    // No-op patch: avoid emitting `UPDATE ... SET WHERE` (syntax error)
    // and bypass the touch_updated_at trigger when nothing changed. Fall
    // back to a SELECT so callers still get the current row (or null).
    return getByIdInCurrentOrg(client, id);
  }

  values.push(id);
  const sql =
    `UPDATE customers SET ${sets.join(", ")}` +
    ` WHERE id = $${i} AND deleted_at IS NULL` +
    ` RETURNING ${CUSTOMER_COLUMNS}`;
  const r = await client.query<Customer>(sql, values);
  return r.rows[0] ?? null;
}

export async function softDeleteByIdInCurrentOrg(
  client: PoolClient,
  id: string,
): Promise<boolean> {
  const r = await client.query(
    `UPDATE customers SET deleted_at = now()` +
      ` WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return (r.rowCount ?? 0) > 0;
}

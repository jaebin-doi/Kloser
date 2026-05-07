/* organizations repository.
 *
 * organizations does NOT have RLS — a user can belong to many orgs and
 * the membership-side RLS handles cross-org isolation. To keep this
 * surface safe we expose ONLY scoped reads; no `list()` and no plain
 * `getById()` that would let a caller fish for arbitrary orgs.
 *
 *   getCurrentOrg(client) → the org whose id matches the current
 *                           app.org_id GUC, or null if no GUC set.
 *
 * The `current_app_org_id()` SQL helper returns NULL when the GUC is
 * blank, so the WHERE clause naturally yields zero rows for missing
 * context (it is NOT an error).
 */
import type { PoolClient } from "pg";

export interface Organization {
  id: string;
  name: string;
  plan: string;
  settings: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export async function getCurrentOrg(
  client: PoolClient,
): Promise<Organization | null> {
  const r = await client.query<Organization>(
    "SELECT id, name, plan, settings, created_at, updated_at" +
    " FROM organizations WHERE id = current_app_org_id()",
  );
  return r.rows[0] ?? null;
}

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
 *
 * Phase 7 Step 2 added a per-org `mfa_required` boolean. To keep the
 * cross-org guard intact we expose ONLY current-org-scoped read and
 * update helpers — both clauses pin on `current_app_org_id()`, so an
 * Acme caller can never accidentally flip Beta's MFA toggle, even by
 * passing the wrong org id at the service layer (there's no org id
 * parameter to get wrong).
 */
import type { PoolClient } from "pg";

export interface Organization {
  id: string;
  name: string;
  plan: string;
  settings: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  mfa_required: boolean;
}

const ORG_COLUMNS =
  "id, name, plan, settings, created_at, updated_at, mfa_required";

export async function getCurrentOrg(
  client: PoolClient,
): Promise<Organization | null> {
  const r = await client.query<Organization>(
    `SELECT ${ORG_COLUMNS}
       FROM organizations
      WHERE id = current_app_org_id()`,
  );
  return r.rows[0] ?? null;
}

// Phase 7 Step 2 — narrower projection for the admin org-security
// surface. Used by `GET /organization/security` (next commit). Reading
// uses the current-org GUC so a missing/wrong context returns null
// instead of leaking data.
export interface OrganizationSecurity {
  id: string;
  mfa_required: boolean;
}

export async function getCurrentOrgSecurity(
  client: PoolClient,
): Promise<OrganizationSecurity | null> {
  const r = await client.query<OrganizationSecurity>(
    `SELECT id, mfa_required
       FROM organizations
      WHERE id = current_app_org_id()`,
  );
  return r.rows[0] ?? null;
}

// Toggle the org's `mfa_required` flag. The WHERE pins on
// `current_app_org_id()` — there is intentionally no orgId parameter,
// so a misconfigured service call can't update a different org.
//
// Returns the resulting row count so the caller can distinguish "no
// GUC set / GUC points at a non-existent org" (0) from "updated" (1).
// The migration default is `false`, so newly created orgs start un-
// required and an explicit `PATCH /organization/security` toggles it.
//
// `now` is taken via SQL `now()` because organizations.updated_at is
// touched by an existing AFTER UPDATE trigger; bumping it from app code
// would race with that trigger.
export async function setCurrentOrgMfaRequired(
  client: PoolClient,
  required: boolean,
): Promise<number> {
  const r = await client.query(
    `UPDATE organizations
        SET mfa_required = $1
      WHERE id = current_app_org_id()`,
    [required],
  );
  return r.rowCount ?? 0;
}

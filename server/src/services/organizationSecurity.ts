/* Organization security service — Phase 7 Step 2.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_2_PLAN.md §5.2.
 *
 * Two operations:
 *
 *   getOrganizationSecurity(client, { userId })
 *     → reads the current org's `mfa_required`, the caller's own
 *       `mfa_enabled_at`, and a count of active members with no MFA.
 *       Used by GET /organization/security (admin-only at the route
 *       layer).
 *
 *   setOrganizationMfaRequired(client, { userId, required })
 *     → flips the toggle. When `required=true` the caller MUST already
 *       have their own MFA enabled (plan §5.2: admin cannot impose a
 *       policy they themselves haven't satisfied). `required=false` is
 *       always allowed once the caller is admin.
 *
 * Both take a `PoolClient` whose org GUC is already set by the caller
 * (route uses `app.withOrgContext`). The repository helpers
 * (`getCurrentOrgSecurity`, `setCurrentOrgMfaRequired`) pin every query
 * on `current_app_org_id()` so a cross-org leak is impossible — no
 * `orgId` parameter is plumbed past the route boundary.
 *
 * `members_without_mfa_count` is computed via a single JOIN against
 * `memberships` (RLS-scoped → current org) + `users` (no RLS, projected
 * on `mfa_enabled_at IS NULL`). Returned on every GET/PATCH response so
 * the admin UI can show "X members still need to enrol" right next to
 * the toggle.
 */
import type { PoolClient } from "pg";
import { AuthError } from "./auth.js";
import {
  getCurrentOrgSecurity,
  setCurrentOrgMfaRequired,
} from "../repositories/organizations.js";

export interface OrganizationSecurityResult {
  mfa_required:              boolean;
  current_user_mfa_enabled:  boolean;
  members_without_mfa_count: number;
}

// Compute the response shape from current DB state. Used as the tail of
// both GET and PATCH so the route always returns a coherent snapshot
// after any mutation has committed.
async function loadResult(
  client: PoolClient,
  userId: string,
): Promise<OrganizationSecurityResult> {
  const org = await getCurrentOrgSecurity(client);
  if (!org) {
    // The org GUC was set by the route (orgContext middleware → JWT
    // orgId), so this should be unreachable in normal flow. Defensive
    // — surface as 500 rather than returning a falsified `mfa_required:
    // false` snapshot for a missing org.
    throw new AuthError(500, "org_security_unknown",
      "organization not found in current context");
  }

  const u = await client.query<{ mfa_enabled_at: Date | null }>(
    `SELECT mfa_enabled_at FROM users WHERE id = $1`,
    [userId],
  );
  const currentUserMfaEnabled = u.rows[0]?.mfa_enabled_at != null;

  // memberships is RLS-scoped — the GUC the caller pinned restricts
  // this count to the current org. JOIN users is safe because users
  // has no RLS and we filter on `mfa_enabled_at IS NULL` only (no
  // other user-facing fields exposed).
  const c = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM memberships m
       JOIN users u ON u.id = m.user_id
      WHERE m.status = 'active'
        AND u.mfa_enabled_at IS NULL`,
  );
  const membersWithoutMfaCount = c.rows[0]?.count ?? 0;

  return {
    mfa_required:              org.mfa_required,
    current_user_mfa_enabled:  currentUserMfaEnabled,
    members_without_mfa_count: membersWithoutMfaCount,
  };
}

export async function getOrganizationSecurity(
  client: PoolClient,
  input: { userId: string },
): Promise<OrganizationSecurityResult> {
  return loadResult(client, input.userId);
}

export async function setOrganizationMfaRequired(
  client: PoolClient,
  input: { userId: string; required: boolean },
): Promise<OrganizationSecurityResult> {
  if (input.required) {
    // The "admin must already have MFA" gate. Plan §5.2: locking the
    // org down while the actor themselves has no second factor would
    // lock the actor out of their own org on the next /auth/refresh.
    // Surface a distinct code so the UI can hint "enable your own MFA
    // first" instead of the generic 4xx.
    const u = await client.query<{ mfa_enabled_at: Date | null }>(
      `SELECT mfa_enabled_at FROM users WHERE id = $1`,
      [input.userId],
    );
    if (!u.rows[0]?.mfa_enabled_at) {
      throw new AuthError(409, "admin_mfa_required",
        "admin must enable their own MFA before requiring it for the org");
    }
  }

  const updated = await setCurrentOrgMfaRequired(client, input.required);
  if (updated !== 1) {
    // GUC missing or org row gone. Should be unreachable: orgContext
    // populates the GUC from the JWT's `orgId`, and orgs can't be
    // deleted at the SQL level today. Defensive.
    throw new AuthError(500, "org_security_update_failed",
      "could not update organization security");
  }

  return loadResult(client, input.userId);
}

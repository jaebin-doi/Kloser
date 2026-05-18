/* billing repository — Phase 7 Step 9.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_9_PLAN.md §5.2.
 *
 * Two surfaces:
 *
 *   1. organization_billing_profiles
 *      Org-scoped 1:1 metadata. RLS is FORCEd with
 *      `org_id = current_app_org_id()`, so every helper here
 *      assumes the caller wraps the call in `withOrgContext`. The
 *      migration role bypasses RLS, but the runtime app role does not.
 *
 *   2. organizations.plan + usage counts
 *      `organizations` is NOT RLS-scoped (a user's visibility into orgs
 *      is gated by memberships join). We still scope reads with
 *      `WHERE id = current_app_org_id()` so the helper has the same
 *      single-row guarantee.
 *
 * Usage counts pull from the org-scoped tables the rest of the app
 * already RLS-scopes. The `WHERE deleted_at IS NULL` filter and the
 * UTC-month window for time-bounded counts (calls, llm cost) match the
 * entitlement model in plan §3.2.
 */
import type { PoolClient } from "pg";
import type { BillingPlan, BillingStatus } from "../types/billing.js";

// ============================================================ //
// Row types
// ============================================================ //

export interface BillingProfileRow {
  org_id: string;
  billing_status: BillingStatus;
  billing_email: string | null;
  tax_id: string | null;
  current_period_start: Date | null;
  current_period_end: Date | null;
  trial_ends_at: Date | null;
  external_provider: string | null;
  external_customer_id: string | null;
  external_subscription_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface OrganizationPlanRow {
  id: string;
  name: string;
  plan: BillingPlan;
}

// ============================================================ //
// organizations.plan helpers
// ============================================================ //

/** Look up the current org's `{id, name, plan}` triple. Returns null if
 *  the GUC points at a row that isn't visible — RLS isn't enforced on
 *  organizations, so this is a defensive check rather than a security
 *  one (the GUC value would only mismatch on a bug). */
export async function getCurrentOrganization(
  client: PoolClient,
): Promise<OrganizationPlanRow | null> {
  const r = await client.query<OrganizationPlanRow>(
    `SELECT id, name, plan
       FROM organizations
      WHERE id = current_app_org_id()`,
  );
  return r.rows[0] ?? null;
}

/** Lock the current org row FOR UPDATE within the caller's transaction.
 *  Used by cap enforcement so concurrent mutations across the same org
 *  serialize on this row before the count → check → write sequence. */
export async function lockCurrentOrganization(
  client: PoolClient,
): Promise<OrganizationPlanRow | null> {
  const r = await client.query<OrganizationPlanRow>(
    `SELECT id, name, plan
       FROM organizations
      WHERE id = current_app_org_id()
      FOR UPDATE`,
  );
  return r.rows[0] ?? null;
}

// ============================================================ //
// organization_billing_profiles helpers
// ============================================================ //

const PROFILE_COLUMNS =
  "org_id, billing_status, billing_email, tax_id, " +
  "current_period_start, current_period_end, trial_ends_at, " +
  "external_provider, external_customer_id, external_subscription_id, " +
  "metadata, created_at, updated_at";

/** Read the current org's billing profile row. Returns null if no row
 *  exists yet — `getBillingOverview` upserts a default in that case. */
export async function getCurrentBillingProfile(
  client: PoolClient,
): Promise<BillingProfileRow | null> {
  const r = await client.query<BillingProfileRow>(
    `SELECT ${PROFILE_COLUMNS}
       FROM organization_billing_profiles
      WHERE org_id = current_app_org_id()`,
  );
  return r.rows[0] ?? null;
}

/** Insert a default 'trialing' profile if missing. Returns the resulting
 *  row whether freshly inserted or already present. ON CONFLICT DO
 *  NOTHING + re-select sidesteps the partial-RETURNING quirk of ON
 *  CONFLICT DO NOTHING (which returns no row when there is a conflict). */
export async function upsertCurrentBillingProfile(
  client: PoolClient,
): Promise<BillingProfileRow> {
  await client.query(
    `INSERT INTO organization_billing_profiles (org_id)
     VALUES (current_app_org_id())
     ON CONFLICT (org_id) DO NOTHING`,
  );
  const row = await getCurrentBillingProfile(client);
  if (!row) {
    throw new Error(
      "upsertCurrentBillingProfile: row missing after ON CONFLICT DO NOTHING",
    );
  }
  return row;
}

export interface BillingProfilePatch {
  billing_email?: string | null;
  tax_id?: string | null;
}

/** Patch billing email / tax id only. updated_at is bumped automatically.
 *  Other columns (status, periods, external_*) are intentionally NOT
 *  reachable from PATCH — they belong to provider integration paths. */
export async function patchCurrentBillingProfile(
  client: PoolClient,
  patch: BillingProfilePatch,
): Promise<BillingProfileRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [];

  // Each field uses a dedicated parameter so `null` clears it explicitly.
  // The route layer drops undefined keys before the call so an empty
  // patch never reaches here — but we still guard with an early return.
  if (Object.prototype.hasOwnProperty.call(patch, "billing_email")) {
    params.push(patch.billing_email ?? null);
    sets.push(`billing_email = $${params.length}`);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "tax_id")) {
    params.push(patch.tax_id ?? null);
    sets.push(`tax_id = $${params.length}`);
  }
  if (sets.length === 0) return null;

  sets.push("updated_at = now()");
  const sql = `
    UPDATE organization_billing_profiles
       SET ${sets.join(", ")}
     WHERE org_id = current_app_org_id()
     RETURNING ${PROFILE_COLUMNS}
  `;
  const r = await client.query<BillingProfileRow>(sql, params);
  return r.rows[0] ?? null;
}

// ============================================================ //
// Usage counts
// ============================================================ //

export interface BillingUsageRow {
  active_members: number;
  pending_invitations: number;
  customers: number;
  knowledge_bases: number;
  knowledge_chunks: number;
  monthly_calls: number;
  // null = every llm_usage_log row in the month had cost_usd_micros NULL
  //        (e.g. Clova STT). Distinct from "0" = priced rows summed to 0.
  monthly_llm_cost_usd_micros: number | null;
}

/** Compute every cap-relevant count for the current org.
 *
 *  `now` is passed in so callers can hold the same wall-clock instant
 *  across multiple count queries; cap enforcement uses this to make
 *  "monthly_calls" / "monthly_llm_cost" agree with whatever month the
 *  audit row will record. */
export async function getCurrentBillingUsage(
  client: PoolClient,
  now: Date,
): Promise<BillingUsageRow> {
  const monthStart = startOfUtcMonth(now);
  const monthEnd = startOfNextUtcMonth(now);

  // memberships and invitations share an "active seat" denominator. We
  // run them as one CTE so the planner can keep both index scans on the
  // same connection state.
  const seatsRes = await client.query<{
    active_members: number;
    pending_invitations: number;
  }>(
    `WITH am AS (
       SELECT count(*)::int AS n
         FROM memberships
        WHERE status = 'active'
     ),
     pi AS (
       -- A "pending invitation" is one that is neither accepted nor
       -- canceled. We do NOT filter by token expiry here because cap
       -- enforcement is about consumed seat intent, and an expired
       -- token is still an active invitation row until cancelled.
       SELECT count(*)::int AS n
         FROM invitations
        WHERE accepted_at IS NULL
          AND canceled_at IS NULL
     )
     SELECT (SELECT n FROM am) AS active_members,
            (SELECT n FROM pi) AS pending_invitations`,
  );
  const seats = seatsRes.rows[0]!;

  const customersRes = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM customers
      WHERE deleted_at IS NULL`,
  );

  const kbsRes = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM knowledge_bases
      WHERE deleted_at IS NULL`,
  );

  const chunksRes = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM knowledge_chunks c
       JOIN knowledge_bases kb ON kb.id = c.knowledge_base_id
                              AND kb.deleted_at IS NULL`,
  );

  const callsRes = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM calls
      WHERE deleted_at IS NULL
        AND started_at >= $1
        AND started_at <  $2`,
    [monthStart, monthEnd],
  );

  // sum_known: priced rows. unknown_count: rows where the provider
  // didn't produce a token-priced number (Clova STT, future unsupported
  // models). The route exposes a null when *every* row in the month is
  // unknown — that's a real "we don't know" rather than zero.
  const llmRes = await client.query<{
    sum_known: string | null;
    known_count: number;
    unknown_count: number;
  }>(
    `SELECT
        COALESCE(SUM(cost_usd_micros) FILTER (WHERE cost_usd_micros IS NOT NULL), 0)::bigint
                 AS sum_known,
        count(*) FILTER (WHERE cost_usd_micros IS NOT NULL)::int AS known_count,
        count(*) FILTER (WHERE cost_usd_micros IS NULL)::int     AS unknown_count
       FROM llm_usage_log
      WHERE created_at >= $1
        AND created_at <  $2`,
    [monthStart, monthEnd],
  );
  const llm = llmRes.rows[0]!;
  // BIGINT comes back from pg as a string; parse to number. The cap is
  // expressed in micro-USD per month (Step 5 unit). It's far below
  // Number.MAX_SAFE_INTEGER for the foreseeable future.
  let monthly_llm_cost_usd_micros: number | null;
  if (llm.known_count === 0 && llm.unknown_count > 0) {
    monthly_llm_cost_usd_micros = null;
  } else {
    monthly_llm_cost_usd_micros = Number.parseInt(llm.sum_known ?? "0", 10);
  }

  return {
    active_members: seats.active_members,
    pending_invitations: seats.pending_invitations,
    customers: customersRes.rows[0]?.n ?? 0,
    knowledge_bases: kbsRes.rows[0]?.n ?? 0,
    knowledge_chunks: chunksRes.rows[0]?.n ?? 0,
    monthly_calls: callsRes.rows[0]?.n ?? 0,
    monthly_llm_cost_usd_micros,
  };
}

// ============================================================ //
// UTC month helpers
// ============================================================ //

export function startOfUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export function startOfNextUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

/** "YYYY-MM" UTC label. Stable string for audit / API echo. */
export function utcMonthLabel(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  return `${y}-${m}`;
}

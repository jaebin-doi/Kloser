/* billing service — Phase 7 Step 9.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_9_PLAN.md §3, §5.3, §5.5.
 *
 * Two responsibilities:
 *
 *   1. Overview / profile API surface used by `GET /billing/overview`
 *      and `PATCH /billing/profile`. Both run in the admin
 *      transaction so the response and the audit row land or rollback
 *      as one unit.
 *
 *   2. Hard cap enforcement on mutation paths. `assertPlanAllows`
 *      runs inside the caller's transaction, locks the org row FOR
 *      UPDATE (so two concurrent invites against the same starter org
 *      serialize), counts current usage, and throws
 *      `PlanLimitExceededError` if the proposed increment would push
 *      usage past the cap.
 *
 * Hard cap policy (plan §3.2):
 *   - seats:            invitations.create / invitations.accept
 *   - customers:        customers.create
 *   - knowledge_bases:  knowledge.createKnowledgeBase
 *   - knowledge_chunks: knowledge.replaceKnowledgeChunks
 *   - monthly_calls:    calls.createCall (REST + WS share this path)
 * Soft (report-only):
 *   - monthly_llm_cost_usd_micros — surfaced in overview, NOT blocked
 *     at provider call sites in Step 9.
 *
 * Enterprise plan caps are intentionally `null` (= no cap). The helper
 * short-circuits without a count when `limit === null`.
 *
 * No `customers.plan` reintroduction. `organizations.plan` is the only
 * tenant-tier source-of-truth.
 */
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import type {
  BillingEntitlements,
  BillingLimitState,
  BillingOverviewResponse,
  BillingPlan,
  BillingProfile,
  BillingProfilePatchInput,
  BillingUsage,
} from "../types/billing.js";
import {
  getCurrentBillingProfile,
  getCurrentBillingUsage,
  getCurrentOrganization,
  lockCurrentOrganization,
  patchCurrentBillingProfile,
  upsertCurrentBillingProfile,
  utcMonthLabel,
  type BillingProfileRow,
} from "../repositories/billing.js";
import { recordActivity } from "./activityLog.js";

// ============================================================ //
// Plan limits — single source-of-truth.
// ============================================================ //

/** Cap keys the service enforces. soft/none keys are still present in
 *  the overview response (so admins see usage) but `assertPlanAllows`
 *  never throws on them. */
export type BillingLimitKey =
  | "seats"
  | "customers"
  | "knowledge_bases"
  | "knowledge_chunks"
  | "monthly_calls"
  | "monthly_llm_cost_usd_micros";

type LimitEnforcement = "hard" | "soft" | "none";

interface PlanLimits {
  seats: number | null;
  customers: number | null;
  knowledge_bases: number | null;
  knowledge_chunks: number | null;
  monthly_calls: number | null;
  monthly_llm_cost_usd_micros: number | null;
}

/** Per-plan caps. `null` means unlimited.
 *
 *  These are operational safety limits, not list prices. Real pricing
 *  lives outside the repo; this map exists so a starter org can't
 *  silently rack up 50,000 calls and surprise everyone. */
export const BILLING_PLAN_LIMITS: Record<BillingPlan, PlanLimits> = {
  starter: {
    seats: 2,
    customers: 100,
    knowledge_bases: 3,
    knowledge_chunks: 500,
    monthly_calls: 100,
    monthly_llm_cost_usd_micros: 5_000_000,
  },
  pro: {
    seats: 10,
    customers: 1_000,
    knowledge_bases: 50,
    knowledge_chunks: 10_000,
    monthly_calls: 5_000,
    monthly_llm_cost_usd_micros: 100_000_000,
  },
  enterprise: {
    seats: null,
    customers: null,
    knowledge_bases: null,
    knowledge_chunks: null,
    monthly_calls: null,
    monthly_llm_cost_usd_micros: null,
  },
};

/** Enforcement classification per cap key. Step 9 keeps soft cap on
 *  cost only — invite/customer/KB/chunk/call paths block at the limit. */
export const BILLING_LIMIT_ENFORCEMENT: Record<BillingLimitKey, LimitEnforcement> = {
  seats: "hard",
  customers: "hard",
  knowledge_bases: "hard",
  knowledge_chunks: "hard",
  monthly_calls: "hard",
  monthly_llm_cost_usd_micros: "soft",
};

// ============================================================ //
// Errors
// ============================================================ //

/** 403-class error thrown when a mutation would exceed a hard cap.
 *
 *  Carries `limitKey`, `plan`, `current`, `limit`, `attempted` so the
 *  route layer can return a structured body without leaking cross-org
 *  context. `attempted` is the post-write count the mutation would have
 *  reached (i.e. `current + increment`). */
export class PlanLimitExceededError extends Error {
  readonly code = "plan_limit_exceeded";
  readonly statusCode = 403;
  readonly limitKey: BillingLimitKey;
  readonly plan: BillingPlan;
  readonly current: number;
  readonly limit: number;
  readonly attempted: number;
  constructor(opts: {
    limitKey: BillingLimitKey;
    plan: BillingPlan;
    current: number;
    limit: number;
    attempted: number;
  }) {
    super(
      `plan limit exceeded: ${opts.limitKey} ` +
        `(plan=${opts.plan}, current=${opts.current}, ` +
        `limit=${opts.limit}, attempted=${opts.attempted})`,
    );
    this.name = "PlanLimitExceededError";
    this.limitKey = opts.limitKey;
    this.plan = opts.plan;
    this.current = opts.current;
    this.limit = opts.limit;
    this.attempted = opts.attempted;
  }
}

// ============================================================ //
// Overview
// ============================================================ //

interface BuildOverviewOptions {
  now?: Date;
}

/** Build the full `BillingOverviewResponse` for the current org. Upserts
 *  a default profile row if one is missing — the migration backfill
 *  covers pre-Step-9 orgs, but a future signup that forgets to insert a
 *  profile row still gets a sane shape here. */
export async function getBillingOverview(
  app: FastifyInstance,
  actorOrgId: string,
  actorUserId: string,
  opts: BuildOverviewOptions = {},
): Promise<BillingOverviewResponse> {
  const now = opts.now ?? new Date();
  return app.withOrgContext(actorOrgId, actorUserId, async (client) => {
    return buildOverviewInTransaction(client, now);
  });
}

/** Same as `getBillingOverview` but reuses the caller's open
 *  transaction. Used by route layer when overview + profile patch
 *  should land in one unit. */
export async function buildOverviewInTransaction(
  client: PoolClient,
  now: Date,
): Promise<BillingOverviewResponse> {
  const org = await getCurrentOrganization(client);
  if (!org) {
    // Shouldn't be reachable — withOrgContext set the GUC to a real
    // org. A null here means the org row itself was deleted between
    // the GUC set and this SELECT, which is a 404 to the caller.
    throw new BillingNotFoundError("organization not found");
  }

  const profileRow = await upsertCurrentBillingProfile(client);
  const usageRow = await getCurrentBillingUsage(client, now);

  const entitlements: BillingEntitlements = { ...BILLING_PLAN_LIMITS[org.plan] };
  const usage: BillingUsage = {
    seats: usageRow.active_members + usageRow.pending_invitations,
    active_members: usageRow.active_members,
    pending_invitations: usageRow.pending_invitations,
    customers: usageRow.customers,
    knowledge_bases: usageRow.knowledge_bases,
    knowledge_chunks: usageRow.knowledge_chunks,
    monthly_calls: usageRow.monthly_calls,
    monthly_llm_cost_usd_micros: usageRow.monthly_llm_cost_usd_micros,
    usage_month: utcMonthLabel(now),
  };

  return {
    organization: {
      id: org.id,
      name: org.name,
      plan: org.plan,
    },
    profile: toBillingProfile(profileRow),
    entitlements,
    usage,
    limits: buildLimitStates(entitlements, usage),
  };
}

/** Render a profile row for the wire. Strips external_customer_id /
 *  external_subscription_id / external_provider / metadata — those stay
 *  backend-only. The `external_provider_configured` boolean is the only
 *  signal admins get about provider linkage. */
function toBillingProfile(row: BillingProfileRow): BillingProfile {
  return {
    billing_status: row.billing_status,
    billing_email: row.billing_email,
    tax_id: row.tax_id,
    current_period_start: row.current_period_start,
    current_period_end: row.current_period_end,
    trial_ends_at: row.trial_ends_at,
    external_provider_configured:
      Boolean(row.external_provider) && Boolean(row.external_customer_id),
  };
}

export function buildLimitStates(
  entitlements: BillingEntitlements,
  usage: BillingUsage,
): BillingLimitState[] {
  const pairs: Array<[BillingLimitKey, number | null]> = [
    ["seats", usage.seats],
    ["customers", usage.customers],
    ["knowledge_bases", usage.knowledge_bases],
    ["knowledge_chunks", usage.knowledge_chunks],
    ["monthly_calls", usage.monthly_calls],
    ["monthly_llm_cost_usd_micros", usage.monthly_llm_cost_usd_micros],
  ];
  return pairs.map(([key, current]) => {
    const limit = entitlements[key];
    let percent: number | null;
    let exceeded: boolean;
    if (current === null || limit === null) {
      percent = null;
      exceeded = false;
    } else if (limit === 0) {
      // Defensive: any non-zero usage against a 0 limit is exceeded.
      percent = current > 0 ? 100 : 0;
      exceeded = current > 0;
    } else {
      percent = Math.min(100, Math.round((current / limit) * 100));
      exceeded = current > limit;
    }
    return {
      key,
      current,
      limit,
      percent,
      exceeded,
      enforcement: BILLING_LIMIT_ENFORCEMENT[key],
    };
  });
}

// ============================================================ //
// Profile patch
// ============================================================ //

/** Apply a profile patch and write the audit row in one transaction.
 *  Returns the post-patch profile. `400 invalid_input` is enforced at
 *  the route layer (zod), `404 not_found` here only when the org row
 *  itself disappeared (extremely unlikely race). */
export async function patchBillingProfile(
  app: FastifyInstance,
  actorOrgId: string,
  actorUserId: string,
  patch: BillingProfilePatchInput,
): Promise<BillingProfile> {
  return app.withOrgContext(actorOrgId, actorUserId, async (client) => {
    // Ensure a profile exists. The backfill covers pre-Step-9 orgs, but
    // a brand-new org that wasn't yet upserted (e.g. concurrent first
    // PATCH on a freshly created org) still needs a row before UPDATE.
    await upsertCurrentBillingProfile(client);

    const updated = await patchCurrentBillingProfile(client, patch);
    if (!updated) {
      // UPDATE matched zero rows — only happens if the profile row
      // disappeared between upsert and patch, which is not a normal
      // path. Treat as 404 so the route returns not_found rather than
      // 500.
      throw new BillingNotFoundError("billing profile not found");
    }

    // Audit row: payload echoes the changed field names only, never the
    // values. billing_email / tax_id are PII / semi-sensitive (plan
    // §4.3, §5.6).
    const fields = Object.keys(patch).filter(
      (k) => (patch as Record<string, unknown>)[k] !== undefined,
    );
    if (fields.length > 0) {
      await recordActivity(client, {
        orgId: actorOrgId,
        actorUserId,
        action: "billing.profile_updated",
        targetType: "organization",
        targetId: actorOrgId,
        payload: { fields },
      });
    }

    return toBillingProfile(updated);
  });
}

// ============================================================ //
// Cap enforcement
// ============================================================ //

export interface AssertPlanAllowsInput {
  limitKey: BillingLimitKey;
  /** Increment we want to add (default 1). For chunk replace this is
   *  the replacement set size — usage count is checked WITHOUT the rows
   *  being replaced, so callers compute that and pass the new total
   *  size as a fresh check via `assertPlanAllowsAbsolute` instead. */
  increment?: number;
  /** Pass-through for time-based caps (monthly_calls); defaults to
   *  `new Date()` so the same wall-clock month is used as audit. */
  now?: Date;
}

/** Hard-cap guard. Locks the current org row, computes the relevant
 *  usage count, and throws `PlanLimitExceededError` if `current +
 *  increment > limit`. Called from inside each mutation service's
 *  open transaction so the cap check and the write succeed or rollback
 *  together. */
export async function assertPlanAllows(
  client: PoolClient,
  input: AssertPlanAllowsInput,
): Promise<void> {
  const increment = input.increment ?? 1;
  if (increment <= 0) return; // nothing to allocate

  const org = await lockCurrentOrganization(client);
  if (!org) {
    throw new BillingNotFoundError("organization not found");
  }

  const limit = BILLING_PLAN_LIMITS[org.plan][input.limitKey];
  if (limit === null) return; // unlimited (enterprise) — fast exit

  const enforcement = BILLING_LIMIT_ENFORCEMENT[input.limitKey];
  if (enforcement !== "hard") return;

  const now = input.now ?? new Date();
  const current = await readCurrentUsageFor(client, input.limitKey, now);
  if (current + increment > limit) {
    throw new PlanLimitExceededError({
      limitKey: input.limitKey,
      plan: org.plan,
      current,
      limit,
      attempted: current + increment,
    });
  }
}

/** Variant for callers that replace a whole collection (chunk replace).
 *  The desired post-write absolute count is passed directly; the helper
 *  blocks only when `targetTotal > limit`. */
export async function assertPlanAllowsAbsolute(
  client: PoolClient,
  input: { limitKey: BillingLimitKey; targetTotal: number; now?: Date },
): Promise<void> {
  if (input.targetTotal <= 0) return;

  const org = await lockCurrentOrganization(client);
  if (!org) {
    throw new BillingNotFoundError("organization not found");
  }
  const limit = BILLING_PLAN_LIMITS[org.plan][input.limitKey];
  if (limit === null) return;
  const enforcement = BILLING_LIMIT_ENFORCEMENT[input.limitKey];
  if (enforcement !== "hard") return;

  if (input.targetTotal > limit) {
    throw new PlanLimitExceededError({
      limitKey: input.limitKey,
      plan: org.plan,
      // For absolute caps we don't have a "before" count handy; expose
      // the current count we'd have to remove from to fit. Cheap one
      // query — chunk replace is a low-frequency admin op.
      current: await readCurrentUsageFor(
        client,
        input.limitKey,
        input.now ?? new Date(),
      ),
      limit,
      attempted: input.targetTotal,
    });
  }
}

/** Acquire the org-level cap lock without doing a count. Use this when
 *  the caller must compute a derived absolute target (for example,
 *  "org total chunks - current KB chunks + replacement chunks") and
 *  that computation itself must be serialized against other mutations
 *  in the same org. */
export async function lockCurrentOrgForPlanLimit(
  client: PoolClient,
): Promise<void> {
  const org = await lockCurrentOrganization(client);
  if (!org) {
    throw new BillingNotFoundError("organization not found");
  }
}

async function readCurrentUsageFor(
  client: PoolClient,
  key: BillingLimitKey,
  now: Date,
): Promise<number> {
  const usage = await getCurrentBillingUsage(client, now);
  switch (key) {
    case "seats":
      return usage.active_members + usage.pending_invitations;
    case "customers":
      return usage.customers;
    case "knowledge_bases":
      return usage.knowledge_bases;
    case "knowledge_chunks":
      return usage.knowledge_chunks;
    case "monthly_calls":
      return usage.monthly_calls;
    case "monthly_llm_cost_usd_micros":
      // Soft cap is never reached here (caller checked enforcement), but
      // the fallback keeps the switch exhaustive. null cost => 0 for
      // arithmetic.
      return usage.monthly_llm_cost_usd_micros ?? 0;
    default: {
      const exhaustive: never = key;
      throw new Error(`unknown billing limit key: ${exhaustive as string}`);
    }
  }
}

// ============================================================ //
// 404 helper
// ============================================================ //

/** Maps to 404 at the route layer. Distinct error class so we don't
 *  mix it with cap rejections. */
export class BillingNotFoundError extends Error {
  readonly code = "not_found" as const;
  readonly statusCode = 404;
  constructor(message = "billing not_found") {
    super(message);
    this.name = "BillingNotFoundError";
  }
}

// Re-export for callers (route) without needing to import the row type.
export { getCurrentBillingProfile } from "../repositories/billing.js";

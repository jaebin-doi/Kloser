/* billing shared types — Phase 7 Step 9.
 *
 * Server source-of-truth: server/src/types/billing.ts.
 * Browser JSDoc mirror:   platform/types/billing.js.
 *
 * Sync target schemas (top-level `export const X = z.object({ ... })`):
 *   - BillingProfile
 *   - BillingEntitlements
 *   - BillingUsage
 *   - BillingLimitState
 *   - BillingOverviewResponse
 *   - BillingProfilePatchInput
 *
 * `organizations.plan` stays the only plan source-of-truth.
 * Entitlements + usage are computed at request time; nothing is cached
 * on the DB side. external_customer_id / external_subscription_id
 * stay backend-only — the response exposes a single
 * `external_provider_configured` boolean instead.
 */
import { z } from "zod";

export const BillingPlan = z.enum(["starter", "pro", "enterprise"]);
export type BillingPlan = z.infer<typeof BillingPlan>;

export const BillingStatus = z.enum([
  "trialing",
  "active",
  "past_due",
  "canceled",
]);
export type BillingStatus = z.infer<typeof BillingStatus>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UuidString = z.string().regex(UUID_RE, "invalid uuid");

// BillingOrganization mirrors the `organization` envelope on the
// overview response. id/name come from organizations, plan stays the
// source-of-truth.
export const BillingOrganization = z.object({
  id: UuidString,
  name: z.string(),
  plan: BillingPlan,
});
export type BillingOrganization = z.infer<typeof BillingOrganization>;

export const BillingProfile = z.object({
  billing_status: BillingStatus,
  billing_email: z.string().nullable(),
  tax_id: z.string().nullable(),
  current_period_start: z.date().nullable(),
  current_period_end: z.date().nullable(),
  trial_ends_at: z.date().nullable(),
  // True when external_provider + external_customer_id are both set
  // server-side. The raw provider ids never reach the response — this
  // boolean is the only signal admins get.
  external_provider_configured: z.boolean(),
});
export type BillingProfile = z.infer<typeof BillingProfile>;

// Caps. `null` means "no cap" (enterprise).
export const BillingEntitlements = z.object({
  seats: z.number().int().nonnegative().nullable(),
  customers: z.number().int().nonnegative().nullable(),
  knowledge_bases: z.number().int().nonnegative().nullable(),
  knowledge_chunks: z.number().int().nonnegative().nullable(),
  monthly_calls: z.number().int().nonnegative().nullable(),
  monthly_llm_cost_usd_micros: z.number().int().nonnegative().nullable(),
});
export type BillingEntitlements = z.infer<typeof BillingEntitlements>;

export const BillingUsage = z.object({
  // seats = active_members + pending_invitations (the two are also
  // exposed individually so admins see the split).
  seats: z.number().int().nonnegative(),
  active_members: z.number().int().nonnegative(),
  pending_invitations: z.number().int().nonnegative(),
  customers: z.number().int().nonnegative(),
  knowledge_bases: z.number().int().nonnegative(),
  knowledge_chunks: z.number().int().nonnegative(),
  monthly_calls: z.number().int().nonnegative(),
  // null when every llm_usage_log row in the month has cost_usd_micros
  // unset (e.g. Clova STT only). Distinguishes "we know it's zero" from
  // "we cannot price what ran".
  monthly_llm_cost_usd_micros: z.number().int().nonnegative().nullable(),
  // "YYYY-MM" UTC label so the audit / UI doesn't have to re-derive it.
  usage_month: z.string(),
});
export type BillingUsage = z.infer<typeof BillingUsage>;

export const BillingLimitEnforcement = z.enum(["hard", "soft", "none"]);
export type BillingLimitEnforcement = z.infer<typeof BillingLimitEnforcement>;

export const BillingLimitState = z.object({
  key: z.string(),
  current: z.number().int().nonnegative().nullable(),
  limit: z.number().int().nonnegative().nullable(),
  // null when current or limit is null — UI renders "—" rather than
  // pretending 0% is meaningful.
  percent: z.number().min(0).nullable(),
  exceeded: z.boolean(),
  enforcement: BillingLimitEnforcement,
});
export type BillingLimitState = z.infer<typeof BillingLimitState>;

export const BillingOverviewResponse = z.object({
  organization: BillingOrganization,
  profile: BillingProfile,
  entitlements: BillingEntitlements,
  usage: BillingUsage,
  limits: z.array(BillingLimitState),
});
export type BillingOverviewResponse = z.infer<typeof BillingOverviewResponse>;

// PATCH /billing/profile input. Both fields optional; the route layer
// rejects an empty patch as 400. `null` clears the field; `undefined`
// leaves it as-is.
export const BillingProfilePatchInput = z.object({
  billing_email: z.string().email().nullable().optional(),
  tax_id: z.string().max(64).nullable().optional(),
});
export type BillingProfilePatchInput = z.infer<typeof BillingProfilePatchInput>;

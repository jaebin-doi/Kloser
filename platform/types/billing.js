// platform/types/billing.js — JSDoc mirror of billing types.
//
// Server source-of-truth: server/src/types/billing.ts.
// Sync verification:      test/sync_shared_types.mjs.
//
// `organizations.plan` stays the only plan source-of-truth. Caps are
// computed server-side per request, never cached on the DB row.
// external_customer_id / external_subscription_id never reach the
// browser — only `external_provider_configured: boolean`.

/**
 * @typedef {Object} BillingOrganization
 * @property {string} id
 * @property {string} name
 * @property {"starter"|"pro"|"enterprise"} plan
 */

/**
 * @typedef {Object} BillingProfile
 * @property {"trialing"|"active"|"past_due"|"canceled"} billing_status
 * @property {string|null} billing_email
 * @property {string|null} tax_id
 * @property {string|null} current_period_start
 * @property {string|null} current_period_end
 * @property {string|null} trial_ends_at
 * @property {boolean} external_provider_configured
 */

/**
 * @typedef {Object} BillingEntitlements
 * @property {number|null} seats
 * @property {number|null} customers
 * @property {number|null} knowledge_bases
 * @property {number|null} knowledge_chunks
 * @property {number|null} monthly_calls
 * @property {number|null} monthly_llm_cost_usd_micros
 */

/**
 * @typedef {Object} BillingUsage
 * @property {number} seats
 * @property {number} active_members
 * @property {number} pending_invitations
 * @property {number} customers
 * @property {number} knowledge_bases
 * @property {number} knowledge_chunks
 * @property {number} monthly_calls
 * @property {number|null} monthly_llm_cost_usd_micros
 * @property {string} usage_month
 */

/**
 * @typedef {Object} BillingLimitState
 * @property {string} key
 * @property {number|null} current
 * @property {number|null} limit
 * @property {number|null} percent
 * @property {boolean} exceeded
 * @property {"hard"|"soft"|"none"} enforcement
 */

/**
 * @typedef {Object} BillingOverviewResponse
 * @property {BillingOrganization} organization
 * @property {BillingProfile} profile
 * @property {BillingEntitlements} entitlements
 * @property {BillingUsage} usage
 * @property {BillingLimitState[]} limits
 */

/**
 * @typedef {Object} BillingProfilePatchInput
 * @property {string|null} [billing_email]
 * @property {string|null} [tax_id]
 */

// platform/types/customers.js — JSDoc-only browser mirror of customers shared types.
//
// Server source-of-truth: server/src/types/customers.ts.
// Sync verification:      test/sync_shared_types.mjs.
//
// This file is NOT loaded into the browser at runtime. It exists for IDE
// JSDoc intellisense across platform/*.html — fetch responses can be
// annotated as @type {Customer[]} so authors see the field shape inline.
//
// Wire format vs server-internal:
//   - timestamps (last_contacted_at, created_at, updated_at) are ISO 8601
//     strings on the wire. The server keeps them as JS Date inside the
//     service layer; route serialization to JSON yields ISO strings, so
//     the browser only ever observes strings.
//   - validation refinements (.refine, .min, .max, .default) live on the
//     server schema only. The mirror tracks **field names** so the sync
//     test can diff both sides; type narrowing and defaults are out of
//     scope for the mirror.

/**
 * @typedef {"active" | "review" | "pending"} CustomerStatus
 */

/**
 * @typedef {"Starter" | "Pro" | "Enterprise"} CustomerPlan
 */

/**
 * @typedef {Object} Customer
 * @property {string} id
 * @property {string} org_id
 * @property {string} name
 * @property {string|null} company
 * @property {string|null} email
 * @property {string|null} phone
 * @property {CustomerStatus} status
 * @property {CustomerPlan|null} plan
 * @property {string|null} assigned_user_id
 * @property {string|null} last_contacted_at
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {Object} CustomerCreateInput
 * @property {string} name
 * @property {string|null} [company]
 * @property {string|null} [email]
 * @property {string|null} [phone]
 * @property {CustomerStatus} [status]
 * @property {CustomerPlan|null} [plan]
 * @property {string|null} [assigned_user_id]
 * @property {string|null} [last_contacted_at]
 */

/**
 * @typedef {Partial<CustomerCreateInput>} CustomerPatch
 */

/**
 * @typedef {Object} CustomerListQuery
 * @property {string} [q]
 * @property {CustomerStatus} [status]
 * @property {CustomerPlan} [plan]
 * @property {string|"null"|null} [assignedUserId]
 * @property {number} [limit]
 * @property {number} [offset]
 * @property {"name"|"created_at"|"last_contacted_at"} [sort]
 * @property {"asc"|"desc"} [dir]
 */

/**
 * @typedef {Object} CustomerStats
 * @property {number} total
 * @property {number} active
 * @property {number} review
 * @property {number} pending
 */

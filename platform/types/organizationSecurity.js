// platform/types/organizationSecurity.js — JSDoc mirror of organization
// security shared types.
//
// Server source-of-truth: server/src/types/organizationSecurity.ts.
// Sync verification:      test/sync_shared_types.mjs.
//
// This file is NOT loaded into the browser at runtime. It exists for
// IDE JSDoc intellisense across platform/settings.html and the admin
// settings UI (frontend phase, separate commit).
//
// Wire format:
//   - All booleans are JSON booleans (true/false), not strings.
//   - `members_without_mfa_count` is optional on the wire — the server
//     may omit it for non-admin or list views.
//
// Phase 7 Step 2 surface:
//   GET   /organization/security  → OrganizationSecurityResponse
//   PATCH /organization/security  → OrganizationSecurityResponse
//     body: OrganizationSecurityPatchInput (strict — `org_id` REJECTED)

/**
 * @typedef {Object} OrganizationSecurityResponse
 * @property {boolean} mfa_required
 * @property {boolean} current_user_mfa_enabled
 * @property {number} [members_without_mfa_count]
 */

/**
 * @typedef {Object} OrganizationSecurityPatchInput
 * @property {boolean} mfa_required
 */

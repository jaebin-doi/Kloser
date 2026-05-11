// platform/types/team.js — JSDoc mirror of team / membership shared types.
//
// Server source-of-truth: server/src/types/team.ts.
// Sync verification:      test/sync_shared_types.mjs.
//
// This file is NOT loaded into the browser at runtime. It exists for IDE
// JSDoc intellisense across platform/team.html (Step 6 — client wiring).
//
// Wire format:
//   - timestamps (created_at, updated_at, user_email_verified_at) are ISO
//     8601 strings on the wire. The server keeps them as JS Date inside
//     service code; JSON serialization yields ISO strings.
//   - MembershipPatchInput is server-side derived (refine: at least one of
//     role/status). The mirror does not track it.
//
// Phase 3 Step 4 surface:
//   GET    /team/members     → { members: Member[] }
//   PATCH  /memberships/:id  → { membership: Membership }
//   GET    /teams            → { teams: Team[] }
//   POST   /teams            → { team: Team }    (201)
//   PATCH  /teams/:id        → { team: Team }
//   DELETE /teams/:id        → 204 no body

/**
 * @typedef {"admin" | "manager" | "employee" | "viewer"} MembershipRole
 */
/**
 * @typedef {"active" | "disabled"} MembershipStatus
 */

/**
 * @typedef {Object} Team
 * @property {string} id
 * @property {string} org_id
 * @property {string} name
 * @property {?string} manager_id
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {Object} TeamCreateInput
 * @property {string} name
 * @property {?string} [managerId]
 */

/**
 * @typedef {Object} TeamPatchInput
 * @property {string} [name]
 * @property {?string} [managerId]
 */

/**
 * @typedef {Object} Member
 * @property {string} id
 * @property {MembershipRole} role
 * @property {MembershipStatus} status
 * @property {?string} team_id
 * @property {?string} team_name
 * @property {string} user_id
 * @property {string} user_email
 * @property {string} user_name
 * @property {?string} user_email_verified_at
 * @property {string} created_at
 * @property {string} updated_at
 */

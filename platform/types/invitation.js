// platform/types/invitation.js — JSDoc mirror of invitation shared types.
//
// Server source-of-truth: server/src/types/invitation.ts.
// Sync verification:      test/sync_shared_types.mjs.
//
// This file is NOT loaded into the browser at runtime. It exists for IDE
// JSDoc intellisense across platform/accept-invitation.html (Step 6 —
// client wiring).
//
// Wire format:
//   - timestamps (last_sent_at, token_expires_at, created_at) are ISO 8601
//     strings on the wire.
//   - InvitationAcceptInput is the body for POST /invitations/accept; the
//     response shape is AuthResult (access token + Set-Cookie refresh)
//     identical to /auth/signup — mirrored across platform/api.js.
//
// Phase 3 Step 5 surface:
//   POST   /invitations              → { invitation }   (201)
//   GET    /invitations              → { invitations: Invitation[] }
//   POST   /invitations/:id/resend   → { ok: true }
//   DELETE /invitations/:id          → 204 no body
//   POST   /invitations/accept       → AuthResult       (201 new | 200 existing)

/**
 * @typedef {"admin" | "manager" | "employee" | "viewer"} MembershipRole
 */

/**
 * @typedef {Object} Invitation
 * @property {string} id
 * @property {string} org_id
 * @property {string} email
 * @property {MembershipRole} role
 * @property {?string} team_id
 * @property {?string} team_name
 * @property {?string} invited_by_user_id
 * @property {?string} invited_by_name
 * @property {string} last_sent_at
 * @property {string} token_expires_at
 * @property {string} created_at
 */

/**
 * @typedef {Object} InvitationCreateInput
 * @property {string} email
 * @property {MembershipRole} role
 * @property {?string} [teamId]
 */

/**
 * @typedef {Object} InvitationAcceptInput
 * @property {string} token
 * @property {string} name
 * @property {string} password
 */

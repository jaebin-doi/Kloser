// platform/types/signup.js — JSDoc-only browser mirror of signup/verify shared types.
//
// Server source-of-truth: server/src/types/signup.ts.
// Sync verification:      test/sync_shared_types.mjs.
//
// This file is NOT loaded into the browser at runtime. It exists for IDE
// JSDoc intellisense across platform/signup.html / platform/verify.html
// (added in Step 6 — client wiring).
//
// Wire format:
//   - All fields are plain strings on POST bodies.
//   - Server response shape (access token, user, organization, membership)
//     is documented in PHASE_1_STEP_3_AUTH_CORE.md and is mirrored across
//     platform/api.js — not duplicated here.

/**
 * @typedef {Object} SignupInput
 * @property {string} organizationName
 * @property {string} name
 * @property {string} email
 * @property {string} password
 */

/**
 * @typedef {Object} VerifyEmailInput
 * @property {string} token
 */

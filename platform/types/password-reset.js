// platform/types/password-reset.js — JSDoc mirror of password-reset shared types.
//
// Server source-of-truth: server/src/types/password-reset.ts.
// Sync verification:      test/sync_shared_types.mjs.
//
// This file is NOT loaded into the browser at runtime. It exists for IDE
// JSDoc intellisense across platform/forgot-password.html /
// platform/reset-password.html (added in Step 6 — client wiring).
//
// Wire shape:
//   - forgot accepts { email }. Server always returns 200 { ok: true }.
//   - reset  accepts { token, newPassword }. Server returns
//     200 { ok: true } on success, 410 { error, code: 'token_invalid_or_expired' }
//     on any token failure (not_found / already_used / invalidated / expired
//     — all collapsed by the route to a single response).

/**
 * @typedef {Object} ForgotPasswordInput
 * @property {string} email
 */

/**
 * @typedef {Object} ResetPasswordInput
 * @property {string} token
 * @property {string} newPassword
 */

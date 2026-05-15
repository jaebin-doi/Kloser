// platform/types/authMfa.js - JSDoc mirror of auth MFA shared types.
//
// Server source-of-truth: server/src/types/authMfa.ts.
// Sync verification:      test/sync_shared_types.mjs.
//
// This file is NOT loaded into the browser at runtime. It exists for
// IDE JSDoc intellisense across platform/login.html, platform/settings.html,
// and platform/api.js (frontend phase, separate commit).
//
// Surface covered:
//   POST /auth/login                          -> 202 LoginMfaChallengeResponse
//                                               (200 happy path is the
//                                                pre-existing auth shape,
//                                                NOT modeled here.)
//   POST /auth/mfa/totp/verify-login          <- MfaTotpVerifyLoginInput
//                                               -> 200 auth happy-path shape
//   POST /auth/mfa/totp/setup                 <- MfaTotpSetupInput
//                                               -> 200 MfaTotpSetupResponse
//   POST /auth/mfa/totp/confirm               <- MfaTotpConfirmInput
//                                               -> 200 MfaTotpConfirmResponse
//   DELETE /auth/mfa/totp                     <- MfaTotpDisableInput
//                                               -> 204 (no body)
//   POST /auth/mfa/totp/setup-challenge       <- MfaTotpSetupChallengeInput
//                                               -> 200 MfaTotpSetupResponse
//   POST /auth/mfa/totp/confirm-challenge     <- MfaTotpConfirmChallengeInput
//                                               -> 200 auth happy-path shape
//
// Field naming notes:
//   - token / id-like fields are camelCase (`challengeToken`, `expiresAt`,
//     `otpauthUri`, `secretBase32`) - matches the existing auth surface
//     (`accessToken`).
//   - DB timestamp columns surface as snake_case (`mfa_enabled_at`) - matches
//     the organization-security wire convention.
//   - `code` is a 6-digit TOTP string; treat as a string, NOT a number.
//     Leading zeros are valid TOTP digits.
//   - `mfa_enabled_at` and `expiresAt` are ISO-8601 timestamp STRINGS over
//     the wire (already serialized server-side).

// ============================================================ //
// Request body inputs
// ============================================================ //

/**
 * @typedef {Object} MfaTotpVerifyLoginInput
 * @property {string} challengeToken
 * @property {string} code
 */

/**
 * @typedef {Object} MfaTotpSetupInput
 * @property {string} currentPassword
 */

/**
 * @typedef {Object} MfaTotpConfirmInput
 * @property {string} code
 */

/**
 * @typedef {Object} MfaTotpDisableInput
 * @property {string} currentPassword
 * @property {string} code
 */

/**
 * @typedef {Object} MfaTotpSetupChallengeInput
 * @property {string} challengeToken
 */

/**
 * @typedef {Object} MfaTotpConfirmChallengeInput
 * @property {string} challengeToken
 * @property {string} code
 */

// ============================================================ //
// Response bodies
// ============================================================ //

/**
 * Inner payload of the 202 login response. `method` is `"totp"` when
 * `kind === "mfa_required"` and `null` when
 * `kind === "mfa_setup_required"`. `expiresAt` is an ISO-8601 string.
 *
 * @typedef {Object} LoginMfaChallengePayload
 * @property {"mfa_required"|"mfa_setup_required"} kind
 * @property {"totp"|null} method
 * @property {string} challengeToken
 * @property {string} expiresAt
 */

/**
 * 202 envelope from POST /auth/login when credentials are valid but a
 * second factor is still required. No `accessToken`, no refresh cookie.
 *
 * @typedef {Object} LoginMfaChallengeResponse
 * @property {LoginMfaChallengePayload} mfa
 */

/**
 * Returned by /auth/mfa/totp/setup AND /auth/mfa/totp/setup-challenge.
 * Both fields are sensitive - render via textContent on the frontend.
 *
 * @typedef {Object} MfaTotpSetupResponse
 * @property {string} otpauthUri
 * @property {string} secretBase32
 */

/**
 * Returned by /auth/mfa/totp/confirm (authenticated enrollment).
 * /auth/mfa/totp/confirm-challenge does NOT return this shape -
 * it returns the standard auth happy-path response.
 *
 * @typedef {Object} MfaTotpConfirmResponse
 * @property {boolean} ok
 * @property {string} mfa_enabled_at
 */

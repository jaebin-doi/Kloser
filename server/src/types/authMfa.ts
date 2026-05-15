/* auth MFA shared types - Phase 7 Step 2.
 *
 * Server source-of-truth: server/src/types/authMfa.ts.
 * Browser JSDoc mirror:   platform/types/authMfa.js.
 * Sync verification:      test/sync_shared_types.mjs.
 *
 * Surface covered (request bodies + non-AuthResult responses):
 *
 *   POST /auth/login                          -> 202 LoginMfaChallengeResponse
 *                                               (200 happy path is the
 *                                                pre-existing auth shape,
 *                                                NOT modeled here.)
 *   POST /auth/mfa/totp/verify-login          <- MfaTotpVerifyLoginInput
 *                                               -> 200 auth shape
 *   POST /auth/mfa/totp/setup                 <- MfaTotpSetupInput
 *                                               -> 200 MfaTotpSetupResponse
 *   POST /auth/mfa/totp/confirm               <- MfaTotpConfirmInput
 *                                               -> 200 MfaTotpConfirmResponse
 *   DELETE /auth/mfa/totp                     <- MfaTotpDisableInput
 *                                               -> 204 (no body)
 *   POST /auth/mfa/totp/setup-challenge       <- MfaTotpSetupChallengeInput
 *                                               -> 200 MfaTotpSetupResponse
 *   POST /auth/mfa/totp/confirm-challenge     <- MfaTotpConfirmChallengeInput
 *                                               -> 200 auth shape
 *
 * The pre-existing `{ accessToken, user, organization, membership }` auth
 * happy-path response is intentionally NOT redeclared here - it predates
 * shared types and is consumed by login.html's existing wiring. /verify-
 * login and /confirm-challenge return that exact shape via the route's
 * shared `sendAuthResult()` helper.
 *
 * Field naming follows the in-tree precedent - token / id-like fields are
 * camelCase (`challengeToken`, `expiresAt`, `otpauthUri`, `secretBase32`)
 * because the auth surface already uses camelCase (`accessToken`). DB
 * timestamp columns surface as snake_case (`mfa_enabled_at`) to match the
 * organization-security wire convention.
 *
 * Sync target schemas (top-level `export const X = z.object({ ... })` -
 * no `.extend / .merge / .partial / satisfies / .strict`):
 *
 *   - MfaTotpVerifyLoginInput
 *   - MfaTotpSetupInput
 *   - MfaTotpConfirmInput
 *   - MfaTotpDisableInput
 *   - MfaTotpSetupChallengeInput
 *   - MfaTotpConfirmChallengeInput
 *   - LoginMfaChallengePayload   (the inner `mfa` object)
 *   - LoginMfaChallengeResponse  (the 202 envelope wrapping the above)
 *   - MfaTotpSetupResponse
 *   - MfaTotpConfirmResponse
 *
 * Stray-field rejection on these bodies is currently NOT enforced via
 * `.strict()` - the existing routes use Fastify's default AJV which
 * silently strips unknown keys (`removeAdditional:true`). Tightening that
 * to `.strict()` would be a wire-contract change for /auth/login,
 * /auth/mfa/* and is out of scope here. Add `.strict()` at the route
 * boundary in a follow-up if the operations review requires it.
 */
import { z } from "zod";

// --- Shared atoms (not registered; kept simple so the regex-based
//     sync_shared_types parser keeps treating outer schemas as flat
//     literals). --- //

// TOTP authenticator codes are always exactly 6 ASCII digits. Leading
// zeros are valid TOTP digits - keep this as a string, never coerce to
// number.
const TotpCode = z.string().regex(/^[0-9]{6}$/);

// `auth_tokens.token_hash` is sha256 of a raw token whose length the
// service controls. 512 is the in-tree maxLength used by every Fastify
// JSON schema that accepts a raw token (see VERIFY_LOGIN_MFA_BODY,
// SETUP_CHALLENGE_BODY, CONFIRM_CHALLENGE_BODY in routes/auth.ts).
const ChallengeToken = z.string().min(1).max(512);

// Argon2id verification is the gating cost - we cap the password length
// to keep the hash budget bounded. Matches the route-side maxLength.
const CurrentPassword = z.string().min(1).max(1024);

const LoginMfaChallengeKind = z.enum(["mfa_required", "mfa_setup_required"]);
const LoginMfaMethod         = z.enum(["totp"]);

// ============================================================ //
// Request body inputs
// ============================================================ //

export const MfaTotpVerifyLoginInput = z.object({
  challengeToken: ChallengeToken,
  code:           TotpCode,
});
export type MfaTotpVerifyLoginInput = z.infer<typeof MfaTotpVerifyLoginInput>;

export const MfaTotpSetupInput = z.object({
  currentPassword: CurrentPassword,
});
export type MfaTotpSetupInput = z.infer<typeof MfaTotpSetupInput>;

export const MfaTotpConfirmInput = z.object({
  code: TotpCode,
});
export type MfaTotpConfirmInput = z.infer<typeof MfaTotpConfirmInput>;

export const MfaTotpDisableInput = z.object({
  currentPassword: CurrentPassword,
  code:            TotpCode,
});
export type MfaTotpDisableInput = z.infer<typeof MfaTotpDisableInput>;

export const MfaTotpSetupChallengeInput = z.object({
  challengeToken: ChallengeToken,
});
export type MfaTotpSetupChallengeInput = z.infer<typeof MfaTotpSetupChallengeInput>;

export const MfaTotpConfirmChallengeInput = z.object({
  challengeToken: ChallengeToken,
  code:           TotpCode,
});
export type MfaTotpConfirmChallengeInput = z.infer<typeof MfaTotpConfirmChallengeInput>;

// ============================================================ //
// Response bodies
// ============================================================ //

// Inner payload of the 202 login response. `method` is `"totp"` when
// `kind === "mfa_required"` and explicitly `null` when
// `kind === "mfa_setup_required"` (the user has not chosen a factor
// yet - only TOTP is supported in Step 2 but the nullable shape leaves
// room for WebAuthn / recovery codes later without breaking clients).
// `expiresAt` is an ISO-8601 timestamp string (already serialized
// server-side from a Date).
export const LoginMfaChallengePayload = z.object({
  kind:           LoginMfaChallengeKind,
  method:         LoginMfaMethod.nullable(),
  challengeToken: z.string(),
  expiresAt:      z.string(),
});
export type LoginMfaChallengePayload = z.infer<typeof LoginMfaChallengePayload>;

// 202 envelope from POST /auth/login when the credentials are valid
// but a second factor is still required. No `accessToken`, no refresh
// cookie - those are issued only after /auth/mfa/totp/verify-login
// (or /auth/mfa/totp/confirm-challenge for setup-required users).
export const LoginMfaChallengeResponse = z.object({
  mfa: LoginMfaChallengePayload,
});
export type LoginMfaChallengeResponse = z.infer<typeof LoginMfaChallengeResponse>;

// Returned by /auth/mfa/totp/setup AND /auth/mfa/totp/setup-challenge.
// `otpauthUri` follows the `otpauth://totp/<issuer>:<account>?secret=...`
// format consumed by authenticator apps. `secretBase32` is the same
// secret in base32 for manual entry. Both are sensitive - render via
// `textContent` / DOMPurify on the frontend, never raw innerHTML.
export const MfaTotpSetupResponse = z.object({
  otpauthUri:   z.string(),
  secretBase32: z.string(),
});
export type MfaTotpSetupResponse = z.infer<typeof MfaTotpSetupResponse>;

// Returned by /auth/mfa/totp/confirm (authenticated enrollment confirm).
// `mfa_enabled_at` is an ISO-8601 timestamp string (snake_case to
// match the DB column name and the org-security wire convention).
// /auth/mfa/totp/confirm-challenge does NOT return this shape - it
// returns the standard auth happy-path response via sendAuthResult().
export const MfaTotpConfirmResponse = z.object({
  ok:             z.boolean(),
  mfa_enabled_at: z.string(),
});
export type MfaTotpConfirmResponse = z.infer<typeof MfaTotpConfirmResponse>;

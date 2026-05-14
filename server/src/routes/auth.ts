/* /auth/* routes — Phase 1 Step 3 §1.8.
 *
 * Surface:
 *   POST /auth/signup    — create org + admin user, set refresh cookie, 201
 *   POST /auth/login     — verify credentials, set refresh cookie, 200
 *   POST /auth/refresh   — read cookie, rotate (or grace), maybe set new cookie, 200
 *   POST /auth/logout    — read cookie if any, revoke session, clear cookie, 204
 *
 * The refresh cookie is HttpOnly, SameSite=Lax, scoped to Path=/auth so
 * it's automatically sent to /auth/refresh and /auth/logout but never to
 * /me, /api/*, or static. Secure flag is set in prod (COOKIE_SECURE=true).
 *
 * Service layer (services/auth.ts) owns the BEGIN / FOR UPDATE / grace
 * window / family-revoke logic. This file only bridges HTTP <-> service.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { authEnv } from "../config/authEnv.js";
import { requireAuth } from "../middleware/auth.js";
import { orgContext } from "../middleware/orgContext.js";
import {
  AuthError,
  confirmAuthenticatedTotp,
  confirmLoginMfaChallenge,
  disableTotp,
  login,
  logout,
  refresh,
  requestPasswordReset,
  resendVerificationEmail,
  resetPassword,
  setupLoginMfaChallenge,
  signup,
  startAuthenticatedTotpSetup,
  verifyEmail,
  verifyLoginMfa,
  type AuthResult,
} from "../services/auth.js";
import { sendAuthError, sendTokenError } from "./_tokenErrorMap.js";

const REFRESH_COOKIE_NAME = "kloser_refresh";

// Convert "30d" / "12h" / "900s" / "15m" to integer seconds. We need
// seconds for the cookie's Max-Age attribute (the service layer owns
// the absolute expires_at timestamp on the session row).
function ttlToSeconds(ttl: string): number {
  const m = /^(\d+)([smhd])$/.exec(ttl.trim());
  if (!m) throw new Error(`Unsupported TTL format: ${ttl}`);
  const n = Number.parseInt(m[1]!, 10);
  switch (m[2]) {
    case "s": return n;
    case "m": return n * 60;
    case "h": return n * 60 * 60;
    case "d": return n * 60 * 60 * 24;
    default:  throw new Error(`Unsupported TTL unit: ${m[2]}`);
  }
}

function refreshCookieOpts() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: authEnv.cookieSecure,
    path: "/auth",
    maxAge: ttlToSeconds(authEnv.refreshTokenTtl),
  };
}

function clearRefreshCookieOpts() {
  // clearCookie needs the same path/domain/secure attributes as the
  // setCookie that planted it, otherwise the browser keeps the cookie.
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: authEnv.cookieSecure,
    path: "/auth",
  };
}

function sendAuthResult(
  app: FastifyInstance,
  reply: FastifyReply,
  status: number,
  result: AuthResult,
) {
  const accessToken = app.signAccessToken(result.accessPayload);
  reply.setCookie(REFRESH_COOKIE_NAME, result.refreshToken, refreshCookieOpts());
  return reply.code(status).send({
    accessToken,
    user: result.user,
    organization: result.organization,
    membership: { id: result.membership.id, role: result.membership.role },
  });
}

const SIGNUP_BODY = {
  type: "object",
  required: ["organizationName", "name", "email", "password"],
  properties: {
    organizationName: { type: "string", minLength: 1, maxLength: 200 },
    name:             { type: "string", minLength: 1, maxLength: 200 },
    email:            { type: "string", minLength: 3, maxLength: 320 },
    password:         { type: "string", minLength: 8, maxLength: 1024 },
  },
} as const;

const VERIFY_BODY = {
  type: "object",
  required: ["token"],
  properties: {
    token: { type: "string", minLength: 1, maxLength: 512 },
  },
} as const;

interface VerifyBody {
  token: string;
}

const FORGOT_BODY = {
  type: "object",
  required: ["email"],
  properties: {
    email: { type: "string", minLength: 3, maxLength: 320 },
  },
} as const;

interface ForgotBody {
  email: string;
}

const RESET_BODY = {
  type: "object",
  required: ["token", "newPassword"],
  properties: {
    token:       { type: "string", minLength: 1, maxLength: 512 },
    newPassword: { type: "string", minLength: 8, maxLength: 1024 },
  },
} as const;

interface ResetBody {
  token:       string;
  newPassword: string;
}

const LOGIN_BODY = {
  type: "object",
  required: ["email", "password"],
  properties: {
    email:    { type: "string", minLength: 3, maxLength: 320 },
    password: { type: "string", minLength: 1, maxLength: 1024 },
    orgId:    { type: "string", maxLength: 64 },
  },
} as const;

interface SignupBody {
  organizationName: string;
  name: string;
  email: string;
  password: string;
}

interface LoginBody {
  email: string;
  password: string;
  orgId?: string;
}

async function authRoutes(app: FastifyInstance) {
  app.post<{ Body: SignupBody }>(
    "/auth/signup",
    { schema: { body: SIGNUP_BODY } },
    async (request, reply) => {
      try {
        const result = await signup({
          organizationName: request.body.organizationName.trim(),
          name:             request.body.name.trim(),
          email:            request.body.email.trim().toLowerCase(),
          password:         request.body.password,
          userAgent:        request.headers["user-agent"] ?? null,
          ip:               request.ip,
        });
        return sendAuthResult(app, reply, 201, result);
      } catch (err) {
        return sendAuthError(reply, err);
      }
    },
  );

  // Phase 7 Step 2 — second step of MFA login. The user obtained
  // challengeToken from POST /auth/login's 202 response and now sends
  // their 6-digit authenticator code. Success mints a real session
  // (access token + refresh cookie); failure goes through the standard
  // AuthError surface (401 mfa_invalid_code / 423 mfa_locked / 401
  // mfa_invalid_challenge / 500 mfa_secret_corrupt).
  //
  // Body schema pins `code` to exactly 6 digits to give zod-style
  // validation before we touch the service. The service still re-checks
  // via verifyTotp's strict regex, but the route-level guard means we
  // never burn a failed-attempt slot on a structurally malformed input.
  const VERIFY_LOGIN_MFA_BODY = {
    type: "object",
    required: ["challengeToken", "code"],
    properties: {
      challengeToken: { type: "string", minLength: 1, maxLength: 512 },
      code:           { type: "string", pattern: "^[0-9]{6}$" },
    },
  } as const;
  app.post<{ Body: { challengeToken: string; code: string } }>(
    "/auth/mfa/totp/verify-login",
    { schema: { body: VERIFY_LOGIN_MFA_BODY } },
    async (request, reply) => {
      try {
        const result = await verifyLoginMfa({
          challengeToken: request.body.challengeToken,
          code:           request.body.code,
          userAgent:      request.headers["user-agent"] ?? null,
          ip:             request.ip,
        });
        return sendAuthResult(app, reply, 200, result);
      } catch (err) {
        return sendAuthError(reply, err);
      }
    },
  );

  // Phase 7 Step 2 — authenticated MFA management.
  //
  // These three endpoints run AFTER a real session exists (requireAuth).
  // The JWT is the proof of identity; current-password gates setup +
  // disable to make stolen-cookie attackers prove they have the
  // password too. /confirm does not re-prompt for password — the user
  // just typed it into /setup seconds earlier inside the same tab.
  //
  // /setup returns secret material with NO cookie / NO access token —
  // the user is already logged in; nothing about session lifetime
  // changes at setup time. /confirm stamps the CURRENT session as
  // MFA-verified (mfa_verified_at + mfa_method='totp') so refresh +
  // downstream policy treat it as a real factor confirmation. /disable
  // clears the user's MFA secret + counters but leaves the current
  // session's stamps intact (audit fact, not live capability).

  const AUTH_MFA_SETUP_BODY = {
    type: "object",
    required: ["currentPassword"],
    properties: {
      currentPassword: { type: "string", minLength: 1, maxLength: 1024 },
    },
  } as const;
  app.post<{ Body: { currentPassword: string } }>(
    "/auth/mfa/totp/setup",
    {
      preHandler: [requireAuth, orgContext],
      schema:     { body: AUTH_MFA_SETUP_BODY },
    },
    async (request, reply) => {
      if (!request.user || !request.orgId) {
        return reply
          .code(401)
          .send({ error: "authentication required", code: "auth_required" });
      }
      try {
        const result = await startAuthenticatedTotpSetup({
          userId:          request.user.id,
          orgId:           request.orgId,
          currentPassword: request.body.currentPassword,
        });
        return reply.code(200).send({
          otpauthUri:   result.otpauthUri,
          secretBase32: result.secretBase32,
        });
      } catch (err) {
        return sendAuthError(reply, err);
      }
    },
  );

  const AUTH_MFA_CONFIRM_BODY = {
    type: "object",
    required: ["code"],
    properties: {
      code: { type: "string", pattern: "^[0-9]{6}$" },
    },
  } as const;
  app.post<{ Body: { code: string } }>(
    "/auth/mfa/totp/confirm",
    {
      preHandler: [requireAuth, orgContext],
      schema:     { body: AUTH_MFA_CONFIRM_BODY },
    },
    async (request, reply) => {
      if (!request.user || !request.orgId) {
        return reply
          .code(401)
          .send({ error: "authentication required", code: "auth_required" });
      }
      try {
        const result = await confirmAuthenticatedTotp({
          userId:    request.user.id,
          orgId:     request.orgId,
          sessionId: request.user.sessionId,
          code:      request.body.code,
        });
        return reply.code(200).send({
          ok:             true,
          mfa_enabled_at: result.mfaEnabledAt.toISOString(),
        });
      } catch (err) {
        return sendAuthError(reply, err);
      }
    },
  );

  const AUTH_MFA_DISABLE_BODY = {
    type: "object",
    required: ["currentPassword", "code"],
    properties: {
      currentPassword: { type: "string", minLength: 1, maxLength: 1024 },
      code:            { type: "string", pattern: "^[0-9]{6}$" },
    },
  } as const;
  app.delete<{ Body: { currentPassword: string; code: string } }>(
    "/auth/mfa/totp",
    {
      preHandler: [requireAuth, orgContext],
      schema:     { body: AUTH_MFA_DISABLE_BODY },
    },
    async (request, reply) => {
      if (!request.user || !request.orgId) {
        return reply
          .code(401)
          .send({ error: "authentication required", code: "auth_required" });
      }
      try {
        await disableTotp({
          userId:          request.user.id,
          orgId:           request.orgId,
          currentPassword: request.body.currentPassword,
          code:            request.body.code,
        });
        return reply.code(204).send();
      } catch (err) {
        return sendAuthError(reply, err);
      }
    },
  );

  // Phase 7 Step 2 — login-time MFA enrollment. A user whose org has
  // `mfa_required=true` but has not enrolled yet receives a 202
  // `mfa_setup_required` from POST /auth/login. They call setup-challenge
  // first to obtain `{otpauthUri, secretBase32}` (no cookie, no access
  // token — enrollment is not yet complete) and then confirm-challenge
  // with a 6-digit TOTP code from their authenticator app. Success on
  // confirm closes the loop: pending secret promoted to enabled, real
  // session minted with mfa_verified_at / mfa_method stamps, access
  // token + refresh cookie returned just like /auth/login's happy path.
  //
  // Both endpoints share `mfa_challenge` token discipline: setup does
  // NOT consume it (the user must come back for confirm), confirm
  // consumes only on success. All token-state failures collapse to
  // `mfa_invalid_challenge` so error responses don't disclose whether
  // the token was expired vs invalidated vs unknown.
  const SETUP_CHALLENGE_BODY = {
    type: "object",
    required: ["challengeToken"],
    properties: {
      challengeToken: { type: "string", minLength: 1, maxLength: 512 },
    },
  } as const;
  app.post<{ Body: { challengeToken: string } }>(
    "/auth/mfa/totp/setup-challenge",
    { schema: { body: SETUP_CHALLENGE_BODY } },
    async (request, reply) => {
      try {
        const result = await setupLoginMfaChallenge({
          challengeToken: request.body.challengeToken,
        });
        // 200 with secret material — no cookie / no access token. The
        // client renders a QR code (from otpauthUri) or shows the
        // base32 string for manual entry into the authenticator app.
        return reply.code(200).send({
          otpauthUri:   result.otpauthUri,
          secretBase32: result.secretBase32,
        });
      } catch (err) {
        return sendAuthError(reply, err);
      }
    },
  );

  const CONFIRM_CHALLENGE_BODY = {
    type: "object",
    required: ["challengeToken", "code"],
    properties: {
      challengeToken: { type: "string", minLength: 1, maxLength: 512 },
      code:           { type: "string", pattern: "^[0-9]{6}$" },
    },
  } as const;
  app.post<{ Body: { challengeToken: string; code: string } }>(
    "/auth/mfa/totp/confirm-challenge",
    { schema: { body: CONFIRM_CHALLENGE_BODY } },
    async (request, reply) => {
      try {
        const result = await confirmLoginMfaChallenge({
          challengeToken: request.body.challengeToken,
          code:           request.body.code,
          userAgent:      request.headers["user-agent"] ?? null,
          ip:             request.ip,
        });
        return sendAuthResult(app, reply, 200, result);
      } catch (err) {
        return sendAuthError(reply, err);
      }
    },
  );

  app.post<{ Body: LoginBody }>(
    "/auth/login",
    { schema: { body: LOGIN_BODY } },
    async (request, reply) => {
      try {
        const result = await login({
          email:     request.body.email.trim().toLowerCase(),
          password:  request.body.password,
          orgId:     request.body.orgId?.trim() || undefined,
          userAgent: request.headers["user-agent"] ?? null,
          ip:        request.ip,
        });
        if (result.kind === "authenticated") {
          return sendAuthResult(app, reply, 200, result.auth);
        }
        // Phase 7 Step 2 — MFA challenge branch. Status 202 (Accepted)
        // signals "credentials OK, but another step is required before
        // we can issue a session". No access token, no refresh cookie —
        // shared types + frontend wiring land in a follow-up commit.
        return reply.code(202).send({
          mfa: {
            kind: result.kind,
            method: result.kind === "mfa_required" ? result.method : null,
            challengeToken: result.challengeToken,
            expiresAt: result.expiresAt.toISOString(),
          },
        });
      } catch (err) {
        return sendAuthError(reply, err);
      }
    },
  );

  app.post("/auth/refresh", async (request, reply) => {
    const cookieValue = request.cookies?.[REFRESH_COOKIE_NAME];
    if (!cookieValue) {
      return reply
        .code(401)
        .send({ error: "missing refresh cookie", code: "missing_refresh" });
    }
    try {
      const result = await refresh(cookieValue);
      const accessToken = app.signAccessToken(result.accessPayload);
      // Happy path: service issued a new refresh token. Grace path:
      // service returned the replacement session's access token but
      // no new refresh token (the browser already received the new
      // cookie from the racing first request).
      if (result.refreshToken) {
        reply.setCookie(
          REFRESH_COOKIE_NAME,
          result.refreshToken,
          refreshCookieOpts(),
        );
      }
      return reply.code(200).send({ accessToken });
    } catch (err) {
      // On 401 from refresh (reuse, expired, etc.), invalidate the
      // browser's now-useless cookie too.
      if (err instanceof AuthError && err.statusCode === 401) {
        reply.clearCookie(REFRESH_COOKIE_NAME, clearRefreshCookieOpts());
      }
      return sendAuthError(reply, err);
    }
  });

  app.post("/auth/logout", async (request, reply) => {
    const cookieValue = request.cookies?.[REFRESH_COOKIE_NAME];
    try {
      await logout(cookieValue);
    } catch (err) {
      // Logout is idempotent at the contract level. Service-side errors
      // (DB hiccup) shouldn't strand a cookie on the client; clear it
      // and 204 anyway. Surface the underlying error as a server log.
      request.log.warn({ err }, "logout: service failure, clearing cookie anyway");
    }
    reply.clearCookie(REFRESH_COOKIE_NAME, clearRefreshCookieOpts());
    return reply.code(204).send();
  });

  // POST /auth/verify — anonymous. Body { token }. The service owns one
  // servicePool transaction that consumes the token AND sets the user's
  // email_verified_at, so the two writes commit together or roll back
  // together. All token-failure reasons collapse to a generic 410 here
  // (plan §7).
  app.post<{ Body: VerifyBody }>(
    "/auth/verify",
    { schema: { body: VERIFY_BODY } },
    async (request, reply) => {
      try {
        await verifyEmail(request.body.token);
        return reply.code(200).send({ ok: true });
      } catch (err) {
        return sendTokenError(reply, err);
      }
    },
  );

  // POST /auth/verify/resend — authenticated. No body. Invalidates the
  // caller's active verification token (if any), mints a fresh 24h one,
  // and writes a new outbox row. 409 if the user is already verified —
  // we never spam an outbox row for a verified account.
  app.post(
    "/auth/verify/resend",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!request.user) {
        return reply
          .code(401)
          .send({ error: "authentication required", code: "auth_required" });
      }
      try {
        await resendVerificationEmail({
          userId: request.user.id,
          orgId:  request.user.orgId,
        });
        return reply.code(200).send({ ok: true });
      } catch (err) {
        return sendAuthError(reply, err);
      }
    },
  );

  // POST /auth/password/forgot — anonymous. Body { email }. Always 200
  // on the expected paths (unknown email / globally disabled user / no
  // active membership) so the response shape never leaks which path the
  // server took. There is NO try/catch here: unexpected service errors
  // (DB, argon2, EmailProvider) propagate to Fastify's default handler
  // and surface as 500 — that is a real error, not an enumeration vector,
  // and operators need to see it via 50x metrics. Plan §2.2 / §5.
  app.post<{ Body: ForgotBody }>(
    "/auth/password/forgot",
    { schema: { body: FORGOT_BODY } },
    async (request, reply) => {
      await requestPasswordReset({
        email: request.body.email.trim().toLowerCase(),
      });
      return reply.code(200).send({ ok: true });
    },
  );

  // POST /auth/password/reset — anonymous. Body { token, newPassword }.
  // resetPassword owns a single servicePool transaction that consumes the
  // token, updates users.password_hash, and revokes every active session
  // for the user. Old refresh cookies 401 on next /auth/refresh; old
  // access JWTs remain valid until their TTL — documented trade-off
  // (Step 3 plan §1-10).
  //
  // Token failure reasons (not_found / already_used / invalidated /
  // expired) all collapse to a generic 410 via sendTokenError.
  app.post<{ Body: ResetBody }>(
    "/auth/password/reset",
    { schema: { body: RESET_BODY } },
    async (request, reply) => {
      try {
        await resetPassword({
          rawToken:    request.body.token,
          newPassword: request.body.newPassword,
        });
        return reply.code(200).send({ ok: true });
      } catch (err) {
        return sendTokenError(reply, err);
      }
    },
  );
}

export default authRoutes;

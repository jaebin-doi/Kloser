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
import {
  AuthError,
  login,
  logout,
  refresh,
  requestPasswordReset,
  resendVerificationEmail,
  resetPassword,
  signup,
  verifyEmail,
  type AuthResult,
} from "../services/auth.js";

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

function sendAuthError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof AuthError) {
    const body: Record<string, unknown> = {
      error: err.message,
      code: err.code,
    };
    // AuthError.details may carry e.g. `availableOrgs` for the
    // multi-membership login case — spread it onto the body so the
    // contract documented in the plan (top-level `availableOrgs`)
    // is preserved.
    if (err.details && typeof err.details === "object") {
      Object.assign(body, err.details as Record<string, unknown>);
    }
    return reply.code(err.statusCode).send(body);
  }
  // Unknown errors: let fastify's default error handler log + 500.
  throw err;
}

// Both /auth/verify and /auth/password/reset collapse every distinct
// token-failure reason into one generic 410. Internally the service
// throws AuthError with a precise code (token_not_found /
// token_already_used / token_invalidated / token_expired) so tests and
// logs can keep the granularity; the wire shape stays opaque to defeat
// timing / enumeration. Step 2 plan §7 / Step 3 plan §3.2.
const TOKEN_REASON_CODES = new Set([
  "token_not_found",
  "token_already_used",
  "token_invalidated",
  "token_expired",
]);

function sendTokenError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof AuthError && TOKEN_REASON_CODES.has(err.code)) {
    return reply.code(410).send({
      error: "token_invalid_or_expired",
      code:  "token_invalid_or_expired",
    });
  }
  return sendAuthError(reply, err);
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
        return sendAuthResult(app, reply, 200, result);
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

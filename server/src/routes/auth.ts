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
import {
  AuthError,
  login,
  logout,
  refresh,
  signup,
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
}

export default authRoutes;

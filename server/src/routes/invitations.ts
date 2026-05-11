/* /invitations/* routes — Phase 3 Step 5 §4·5·6.
 *
 * Surface (5 endpoints):
 *   POST   /invitations              — admin: create new invite + send email
 *   GET    /invitations              — admin: list active pending invites
 *   POST   /invitations/:id/resend   — admin: invalidate old token + mint new
 *   DELETE /invitations/:id          — admin: soft cancel (canceled_at + token)
 *   POST   /invitations/accept       — anonymous: token + name + password
 *                                       → new user + active membership
 *                                       → session + refresh cookie
 *
 * preHandler:
 *   - Reads (GET /invitations) → requireAuth + orgContext + requireRole('admin')
 *   - Mutations  → also requireFreshRole (막 demote된 admin 차단)
 *   - accept     → none (anonymous; raw token is the only identity)
 *
 * RLS: all org-scoped paths run inside app.withOrgContext. accept uses
 * servicePool (BYPASSRLS) — token is the only auth.
 *
 * Token-error mapping: shared sendTokenError from _tokenErrorMap collapses
 * 4 distinct codes (token_not_found / token_already_used / token_invalidated
 * / token_expired) into a single generic 410.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z, ZodError } from "zod";
import { authEnv } from "../config/authEnv.js";
import { requireAuth } from "../middleware/auth.js";
import { orgContext } from "../middleware/orgContext.js";
import { requireRole } from "../middleware/role.js";
import { requireFreshRole } from "../middleware/requireFreshRole.js";
import { AuthError, type AuthResult } from "../services/auth.js";
import {
  acceptInvitation,
  cancelInvitation,
  createInvitation,
  listActivePendingInvitations,
  resendInvitation,
} from "../services/invitations.js";
import {
  InvitationAcceptInput,
  InvitationCreateInput,
} from "../types/invitation.js";
import { sendTokenError } from "./_tokenErrorMap.js";

const REFRESH_COOKIE_NAME = "kloser_refresh";

// Permissive UUID regex matching the rest of Phase 3 (services/auth /
// team / customers shared types) — Phase 1 seed UUIDs intentionally
// violate RFC 4122 strict version/variant bits.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UuidParam = z.object({
  id: z.string().regex(UUID_RE, "invalid uuid"),
});

// ttlToSeconds + refreshCookieOpts mirror routes/auth.ts so the accept
// endpoint sets the same HttpOnly + SameSite=Lax + Path=/auth cookie
// /auth/signup plants. Keep these in sync if cookie policy changes.
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

async function invitationsRoutes(app: FastifyInstance) {
  // Plugin-scoped error handler — same shape as routes/team. ZodError →
  // 400 invalid_input. AuthError → declared statusCode/code/message.
  // Anything else falls through to Fastify's default handler (logged +
  // 500). The accept endpoint owns its own catch in the handler so it
  // can route through sendTokenError instead.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: "invalid_input",
        issues: err.flatten(),
      });
    }
    if (err instanceof AuthError) {
      const body: Record<string, unknown> = {
        error: err.message,
        code:  err.code,
      };
      if (err.details && typeof err.details === "object") {
        Object.assign(body, err.details as Record<string, unknown>);
      }
      return reply.code(err.statusCode).send(body);
    }
    reply.send(err);
  });

  // ---------------------------------------------------------------- //
  // POST /invitations
  // ---------------------------------------------------------------- //

  app.post(
    "/invitations",
    {
      preHandler: [
        requireAuth,
        orgContext,
        requireRole("admin"),
        requireFreshRole,
      ],
    },
    async (request, reply) => {
      const input = InvitationCreateInput.parse(request.body);
      const { invitation } = await app.withOrgContext(
        request.orgId!,
        (client) => createInvitation(
          client,
          request.orgId!,
          request.user!.id,
          {
            email: input.email,
            role: input.role,
            teamId: input.teamId ?? null,
          },
        ),
      );
      return reply.code(201).send({ invitation });
    },
  );

  // ---------------------------------------------------------------- //
  // GET /invitations
  // ---------------------------------------------------------------- //

  app.get(
    "/invitations",
    {
      preHandler: [
        requireAuth,
        orgContext,
        requireRole("admin"),
        // requireFreshRole intentionally omitted — read endpoint.
        // Master §2-14 / Step 5 §1-1.
      ],
    },
    async (request, reply) => {
      const invitations = await app.withOrgContext(
        request.orgId!,
        (client) => listActivePendingInvitations(client),
      );
      return reply.code(200).send({ invitations });
    },
  );

  // ---------------------------------------------------------------- //
  // POST /invitations/:id/resend
  // ---------------------------------------------------------------- //

  app.post(
    "/invitations/:id/resend",
    {
      preHandler: [
        requireAuth,
        orgContext,
        requireRole("admin"),
        requireFreshRole,
      ],
    },
    async (request, reply) => {
      const { id } = UuidParam.parse(request.params);
      await app.withOrgContext(
        request.orgId!,
        (client) => resendInvitation(client, request.orgId!, id),
      );
      return reply.code(200).send({ ok: true });
    },
  );

  // ---------------------------------------------------------------- //
  // DELETE /invitations/:id
  // ---------------------------------------------------------------- //

  app.delete(
    "/invitations/:id",
    {
      preHandler: [
        requireAuth,
        orgContext,
        requireRole("admin"),
        requireFreshRole,
      ],
    },
    async (request, reply) => {
      const { id } = UuidParam.parse(request.params);
      await app.withOrgContext(
        request.orgId!,
        (client) => cancelInvitation(client, id),
      );
      return reply.code(204).send();
    },
  );

  // ---------------------------------------------------------------- //
  // POST /invitations/accept (anonymous)
  // ---------------------------------------------------------------- //

  app.post(
    "/invitations/accept",
    // No preHandler — raw token is the only auth.
    async (request, reply) => {
      // Parse body manually so a ZodError still flows to the
      // plugin-scoped errorHandler as 400 invalid_input.
      const input = InvitationAcceptInput.parse(request.body);
      try {
        const outcome = await acceptInvitation({
          rawToken: input.token,
          name: input.name.trim(),
          password: input.password,
          userAgent: request.headers["user-agent"] ?? null,
          ip: request.ip,
        });
        return sendAuthResult(
          app,
          reply,
          outcome.created ? 201 : 200,
          outcome.result,
        );
      } catch (err) {
        // Token-failure codes → 410 generic. Everything else (409
        // already_member / account_disabled, 500 etc.) → standard
        // AuthError mapping.
        return sendTokenError(reply, err);
      }
    },
  );

}

export default invitationsRoutes;

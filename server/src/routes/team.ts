/* /team/members + /memberships/:id + /teams/* routes — Phase 3 Step 4.
 *
 * Surface (6 endpoints):
 *   GET    /team/members      — list org members (incl. user + team join)
 *   PATCH  /memberships/:id   — change role / status (admin-only mutation)
 *   GET    /teams             — list teams in current org
 *   POST   /teams             — create team (admin-only)
 *   PATCH  /teams/:id         — update name / managerId (admin-only)
 *   DELETE /teams/:id         — hard delete after clearing memberships.team_id
 *
 * preHandler:
 *   - Reads (members list / teams list) → requireAuth + orgContext
 *   - Mutations  → requireAuth + orgContext + requireRole('admin') +
 *                  requireFreshRole (so a freshly demoted admin cannot act
 *                  with their still-valid access token)
 *
 * RLS: every service call runs inside app.withOrgContext(orgId, ...).
 * Cross-org targets (memberships id from a different org, etc.) come
 * back hidden — the service surfaces them as 404 not_found, matching
 * Phase 2's "RLS leakage looks like 404" contract.
 */
import type { FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { orgContext } from "../middleware/orgContext.js";
import { requireRole } from "../middleware/role.js";
import { requireFreshRole } from "../middleware/requireFreshRole.js";
import { AuthError } from "../services/auth.js";
import {
  MembershipPatchInput,
  TeamCreateInput,
  TeamPatchInput,
} from "../types/team.js";
import { updateMembership } from "../services/memberships.js";
import {
  createTeam,
  deleteTeam,
  listTeams,
  updateTeam,
} from "../services/teams.js";
import { listForCurrentOrgWithUser } from "../repositories/memberships.js";

// Permissive UUID regex matching Phase 1 (services/auth.ts) and Phase 2
// shared types. zod 4.x .uuid() enforces RFC 4122 version/variant bits,
// which the deterministic seed UUIDs do not satisfy.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UuidParam = z.object({
  id: z.string().regex(UUID_RE, "invalid uuid"),
});

async function teamRoutes(app: FastifyInstance) {
  // Plugin-scoped error handler — same shape as customersRoutes so
  // ZodError surfaces as 400 invalid_input and AuthError surfaces as its
  // declared statusCode/code/message. Anything else falls through to
  // fastify's default handler (logged + 500).
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
  // members
  // ---------------------------------------------------------------- //

  app.get(
    "/team/members",
    { preHandler: [requireAuth, orgContext] },
    async (request, reply) => {
      const members = await app.withOrgContext(
        request.orgId!,
        (client) => listForCurrentOrgWithUser(client),
      );
      return reply.code(200).send({ members });
    },
  );

  app.patch(
    "/memberships/:id",
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
      const patch = MembershipPatchInput.parse(request.body);
      const updated = await app.withOrgContext(
        request.orgId!,
        (client) => updateMembership(client, request.orgId!, {
          membershipId: id,
          patch,
          actorUserId:  request.user!.id,
        }),
      );
      return reply.code(200).send({ membership: updated });
    },
  );

  // ---------------------------------------------------------------- //
  // teams
  // ---------------------------------------------------------------- //

  app.get(
    "/teams",
    { preHandler: [requireAuth, orgContext] },
    async (request, reply) => {
      const teams = await app.withOrgContext(
        request.orgId!,
        (client) => listTeams(client),
      );
      return reply.code(200).send({ teams });
    },
  );

  app.post(
    "/teams",
    {
      preHandler: [
        requireAuth,
        orgContext,
        requireRole("admin"),
        requireFreshRole,
      ],
    },
    async (request, reply) => {
      const input = TeamCreateInput.parse(request.body);
      const team = await app.withOrgContext(
        request.orgId!,
        (client) => createTeam(client, request.orgId!, {
          name:      input.name,
          managerId: input.managerId ?? null,
        }),
      );
      return reply.code(201).send({ team });
    },
  );

  app.patch(
    "/teams/:id",
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
      const patch = TeamPatchInput.parse(request.body);
      const team = await app.withOrgContext(
        request.orgId!,
        (client) => updateTeam(client, id, patch),
      );
      return reply.code(200).send({ team });
    },
  );

  app.delete(
    "/teams/:id",
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
        (client) => deleteTeam(client, id),
      );
      return reply.code(204).send();
    },
  );
}

export default teamRoutes;

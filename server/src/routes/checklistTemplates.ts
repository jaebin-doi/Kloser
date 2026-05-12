/* /call-checklist-templates/* routes — Phase 5 Step 3.
 *
 * Plan: docs/plan/phase-5/PHASE_5_STEP_3_ROUTES.md §2.3.
 *
 * Surface:
 *   GET    /call-checklist-templates       — list (any signed-in)
 *   POST   /call-checklist-templates       — create (admin)
 *   PATCH  /call-checklist-templates/:id   — patch (admin)
 *   DELETE /call-checklist-templates/:id   — delete (admin)
 *
 * Role: read is open to any same-org signed-in user (live.html needs
 * the active list to render the checklist). Write is admin-only — the
 * template is a per-org policy artefact.
 */
import type { FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { orgContext } from "../middleware/orgContext.js";
import { requireRole } from "../middleware/role.js";
import { requireFreshRole } from "../middleware/requireFreshRole.js";
import { requireVerified } from "../middleware/requireVerified.js";
import { AuthError } from "../services/auth.js";
import {
  CallChecklistTemplateCreateInput,
  CallChecklistTemplatePatchInput,
} from "../types/checklistTemplate.js";
import * as templatesRepo from "../repositories/callChecklistTemplates.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UuidParam = z.object({
  id: z.string().regex(UUID_RE, "invalid uuid"),
});

async function checklistTemplateRoutes(app: FastifyInstance) {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply
        .code(400)
        .send({ error: "invalid_input", issues: err.flatten() });
    }
    if (err instanceof AuthError) {
      const body: Record<string, unknown> = {
        error: err.message,
        code: err.code,
      };
      if (err.details && typeof err.details === "object") {
        Object.assign(body, err.details as Record<string, unknown>);
      }
      return reply.code(err.statusCode).send(body);
    }
    const pgCode = (err as { code?: string } | null)?.code;
    if (pgCode === "23503") {
      return reply.code(400).send({ error: "invalid_reference" });
    }
    if (pgCode === "23505") {
      return reply.code(409).send({ error: "conflict" });
    }
    if (pgCode === "23514") {
      return reply.code(400).send({ error: "invalid_state_transition" });
    }
    if (pgCode === "42501") {
      return reply.code(500).send({ error: "rls_violation" });
    }
    reply.send(err);
  });

  app.get(
    "/call-checklist-templates",
    { preHandler: [requireAuth, orgContext] },
    async (request, reply) => {
      const items = await app.withOrgContext(request.orgId!, (client) =>
        templatesRepo.listForCurrentOrg(client),
      );
      return reply.code(200).send({ items });
    },
  );

  app.post(
    "/call-checklist-templates",
    {
      preHandler: [
        requireAuth,
        orgContext,
        requireVerified,
        requireRole("admin"),
        requireFreshRole,
      ],
    },
    async (request, reply) => {
      const input = CallChecklistTemplateCreateInput.parse(request.body);
      const created = await app.withOrgContext(
        request.orgId!,
        (client) => templatesRepo.insertInCurrentOrg(client, request.orgId!, input),
      );
      return reply.code(201).send({ template: created });
    },
  );

  app.patch(
    "/call-checklist-templates/:id",
    {
      preHandler: [
        requireAuth,
        orgContext,
        requireVerified,
        requireRole("admin"),
        requireFreshRole,
      ],
    },
    async (request, reply) => {
      const { id } = UuidParam.parse(request.params);
      const input = CallChecklistTemplatePatchInput.parse(request.body);
      const updated = await app.withOrgContext(request.orgId!, (client) =>
        templatesRepo.patchInCurrentOrg(client, id, input),
      );
      if (!updated) return reply.code(404).send({ error: "not_found" });
      return reply.code(200).send({ template: updated });
    },
  );

  app.delete(
    "/call-checklist-templates/:id",
    {
      preHandler: [
        requireAuth,
        orgContext,
        requireVerified,
        requireRole("admin"),
        requireFreshRole,
      ],
    },
    async (request, reply) => {
      const { id } = UuidParam.parse(request.params);
      const ok = await app.withOrgContext(request.orgId!, (client) =>
        templatesRepo.deleteByIdInCurrentOrg(client, id),
      );
      if (!ok) return reply.code(404).send({ error: "not_found" });
      return reply.code(204).send();
    },
  );
}

export default checklistTemplateRoutes;

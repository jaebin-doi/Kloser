/* /reports/* routes — Phase 6 Step 4.
 *
 * Plan: docs/plan/phase-6/PHASE_6_STEP_4_PLAN.md §6.2.
 *
 * Single endpoint today:
 *   GET /reports/team-summary?team_id=<uuid optional>
 *
 * Authorization (master plan §5 + Step 4 plan §3):
 *   - admin   : org-wide (no team_id) or any same-org team_id.
 *   - manager : own team only. team_id mismatch → 403.
 *               team_id cross-org → 404.
 *               manager without team → 403.
 *   - employee/viewer : 403 (blocked by requireRole + service guard).
 *
 * The service throws:
 *   - PermissionError              → 403 forbidden
 *   - TeamReportNotFoundError      → 404 not_found
 * Plus the usual Zod/Auth/PG mapping for the route file.
 */
import type { FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { orgContext } from "../middleware/orgContext.js";
import { requireRole } from "../middleware/role.js";
import { requireFreshRole } from "../middleware/requireFreshRole.js";
import { requireVerified } from "../middleware/requireVerified.js";
import { AuthError } from "../services/auth.js";
import { PermissionError } from "../services/callPermissions.js";
import {
  getTeamReportSummary,
  TeamReportNotFoundError,
  type TeamReportActor,
} from "../services/teamReports.js";

// Same permissive 8-4-4-4-12 hex UUID regex the repository layer uses
// (AGENTS.md Backend Conventions). z.string().uuid() is stricter than
// the seed data and would 400 some legitimate ids.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TeamSummaryQuery = z.object({
  // team_id is optional; coerce empty string → undefined so an empty
  // query param does not 400.
  team_id: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().regex(UUID_RE, "invalid uuid").optional(),
  ),
});

async function reportsRoutes(app: FastifyInstance) {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply
        .code(400)
        .send({ error: "invalid_input", issues: err.flatten() });
    }
    if (err instanceof TeamReportNotFoundError) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (err instanceof PermissionError) {
      return reply.code(403).send({ error: "forbidden" });
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
    if (pgCode === "42501") {
      return reply.code(500).send({ error: "rls_violation" });
    }
    reply.send(err);
  });

  // -------------------------------------------------------------- //
  // GET /reports/team-summary
  // -------------------------------------------------------------- //
  app.get(
    "/reports/team-summary",
    {
      preHandler: [
        requireAuth,
        orgContext,
        requireVerified,
        requireRole("admin", "manager"),
        requireFreshRole,
      ],
    },
    async (request, reply) => {
      const { team_id } = TeamSummaryQuery.parse(request.query);
      const user = request.user!;
      const actor: TeamReportActor = {
        userId: user.id,
        orgId: user.orgId,
        role: user.role,
      };
      const summary = await getTeamReportSummary(app, actor, {
        teamId: team_id ?? null,
      });
      return reply.code(200).send(summary);
    },
  );
}

export default reportsRoutes;

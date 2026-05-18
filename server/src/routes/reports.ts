/* /reports/* routes — Phase 6 Step 4 + Phase 7 Step 7.
 *
 * Plan:
 *   - docs/plan/phase-6/PHASE_6_STEP_4_PLAN.md §6.2 (initial route).
 *   - docs/plan/phase-7/PHASE_7_STEP_7_PLAN.md §4.1 (date window + agent
 *     breakdown).
 *
 * Single endpoint today:
 *   GET /reports/team-summary
 *     ?team_id=<uuid optional>
 *     &from=YYYY-MM-DD   (optional, must be paired with `to`)
 *     &to=YYYY-MM-DD     (optional, must be paired with `from`)
 *
 * Default window when both date params are omitted: the most recent
 * 30 calendar days inclusive (UTC), ending today UTC. Half-open input
 * (only one of from/to) is rejected as 400 `invalid_input` /
 * `one_sided_window` — the silent-fill alternative buries intent in
 * the audit feed.
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
 *   - ReportWindowError            → 400 invalid_input + code field
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
  ReportWindowError,
  resolveReportWindow,
  TeamReportNotFoundError,
  type TeamReportActor,
} from "../services/teamReports.js";

// Same permissive 8-4-4-4-12 hex UUID regex the repository layer uses
// (AGENTS.md Backend Conventions). z.string().uuid() is stricter than
// the seed data and would 400 some legitimate ids.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Preprocess empty-string → undefined so callers that ship `from=` /
// `to=` without a value (e.g. uncontrolled <input type="date"> on
// initial load) are treated the same as omitted. Date shape and
// calendar-validity are both enforced by `resolveReportWindow` in the
// service, so every date-window failure can return a stable `code`
// (`invalid_date_format`, `invalid_calendar_date`, etc.).
const TeamSummaryQuery = z.object({
  team_id: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().regex(UUID_RE, "invalid uuid").optional(),
  ),
  from: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().optional(),
  ),
  to: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().optional(),
  ),
});

async function reportsRoutes(app: FastifyInstance) {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply
        .code(400)
        .send({ error: "invalid_input", issues: err.flatten() });
    }
    if (err instanceof ReportWindowError) {
      // The service-layer window resolver throws this for any
      // semantically invalid date input (calendar date, reversed
      // range, too-large range, one-sided). The `code` lets the
      // frontend show a specific banner per failure mode without
      // re-parsing the message string.
      return reply
        .code(400)
        .send({ error: "invalid_input", code: err.code });
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
      const { team_id, from, to } = TeamSummaryQuery.parse(request.query);
      // Resolve the window BEFORE we touch the DB. Any 400-class window
      // error short-circuits the request without acquiring a connection
      // or writing an audit row.
      const window = resolveReportWindow({ from, to }, new Date());
      const user = request.user!;
      const actor: TeamReportActor = {
        userId: user.id,
        orgId: user.orgId,
        role: user.role,
      };
      const summary = await getTeamReportSummary(app, actor, {
        teamId: team_id ?? null,
        window,
      });
      return reply.code(200).send(summary);
    },
  );
}

export default reportsRoutes;

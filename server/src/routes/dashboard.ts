/* /dashboard/summary route — Phase 4 Step 3.
 *
 * Plan: docs/plan/phase-4/PHASE_4_STEP_3_ROUTES.md §3.4.
 *
 * Single endpoint:
 *   GET /dashboard/summary  → DashboardSummary
 *
 * preHandler:
 *   - requireAuth + orgContext only. The dashboard is readable for every
 *     role (viewer included) — Phase 4 master §4 permission matrix.
 *
 * "Today" is the UTC day boundary (master §12). org-level timezones are
 * a Phase 6+ concern.
 *
 * SQL strategy: one pass per metric stays trivial to reason about and
 * cheap (~5 queries in one withOrgContext transaction). All counts /
 * aggregates filter `deleted_at IS NULL` so soft-deleted calls stay
 * invisible. recent_calls joins customers + users via LEFT JOIN so a
 * removed customer / agent does not drop the row from the feed.
 *
 * Error vocabulary mirrors callsRoutes for consistency.
 */
import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { orgContext } from "../middleware/orgContext.js";
import { AuthError } from "../services/auth.js";

interface SummaryAggregateRow {
  today_calls: number;
  ended_today: number;
  missed_today: number;
  active_calls: number;
  avg_duration_seconds: number | null;
}

interface RecentCallRow {
  id: string;
  customer_id: string | null;
  customer_name: string | null;
  agent_user_id: string | null;
  agent_name: string | null;
  direction: string;
  status: string;
  started_at: Date;
  ended_at: Date | null;
  duration_seconds: number | null;
  title: string | null;
  sentiment: string | null;
}

async function dashboardRoutes(app: FastifyInstance) {
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
    if (pgCode === "42501") {
      return reply.code(500).send({ error: "rls_violation" });
    }
    reply.send(err);
  });

  app.get(
    "/dashboard/summary",
    { preHandler: [requireAuth, orgContext] },
    async (request, reply) => {
      const summary = await app.withOrgContext(
        request.orgId!,
        async (client) => {
          // UTC day boundary: PostgreSQL `date_trunc('day', now() AT TIME
          // ZONE 'UTC')` produces a timestamp at 00:00 UTC. Comparing
          // started_at against `[today_start_utc, today_start_utc + 1d)`
          // captures the same set the test asserts with native Date math.
          const agg = await client.query<SummaryAggregateRow>(
            `WITH bounds AS (
                SELECT
                  date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS today_start,
                  (date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC' AS tomorrow_start
              ),
              today AS (
                SELECT * FROM calls, bounds
                 WHERE calls.deleted_at IS NULL
                   AND calls.started_at >= bounds.today_start
                   AND calls.started_at <  bounds.tomorrow_start
              )
              SELECT
                (SELECT count(*)::int FROM today)                                  AS today_calls,
                (SELECT count(*) FILTER (WHERE status = 'ended')::int  FROM today) AS ended_today,
                (SELECT count(*) FILTER (WHERE status = 'missed')::int FROM today) AS missed_today,
                (SELECT count(*)::int FROM calls
                   WHERE deleted_at IS NULL AND status = 'in_progress')            AS active_calls,
                (SELECT AVG(duration_seconds)::float
                   FROM today
                   WHERE status = 'ended' AND duration_seconds IS NOT NULL)        AS avg_duration_seconds`,
          );
          const row = agg.rows[0]!;

          // response_rate = ended / (ended + missed) for today. dropped
          // is intentionally excluded — network failures are not a
          // signal about the human's willingness to respond. Returns
          // null when there is no qualifying call today.
          const denom = row.ended_today + row.missed_today;
          const response_rate = denom > 0 ? row.ended_today / denom : null;

          const recent = await client.query<RecentCallRow>(
            `SELECT
                c.id                                  AS id,
                c.customer_id                         AS customer_id,
                cust.name                             AS customer_name,
                c.agent_user_id                       AS agent_user_id,
                u.name                                AS agent_name,
                c.direction                           AS direction,
                c.status                              AS status,
                c.started_at                          AS started_at,
                c.ended_at                            AS ended_at,
                c.duration_seconds                    AS duration_seconds,
                c.title                               AS title,
                c.sentiment                           AS sentiment
              FROM calls c
              LEFT JOIN customers cust ON cust.id = c.customer_id AND cust.deleted_at IS NULL
              LEFT JOIN users u       ON u.id    = c.agent_user_id
              WHERE c.deleted_at IS NULL
              ORDER BY c.started_at DESC, c.id DESC
              LIMIT 5`,
          );

          return {
            today_calls: row.today_calls,
            response_rate,
            avg_duration_seconds: row.avg_duration_seconds,
            active_calls: row.active_calls,
            recent_calls: recent.rows,
          };
        },
      );
      return reply.code(200).send(summary);
    },
  );
}

export default dashboardRoutes;

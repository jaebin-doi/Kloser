/* Team reports service — Phase 6 Step 4.
 *
 * Plan: docs/plan/phase-6/PHASE_6_STEP_4_PLAN.md §6.
 *
 * Single read endpoint backs `GET /reports/team-summary`. Authorization
 * narrows by role:
 *
 *   - admin    : org-wide (no team_id) or any same-org team. cross-org
 *                team_id is NotFound (404 at the route layer).
 *   - manager  : own team only. own team_id is allowed; omitted team_id
 *                falls through to "my team". any other team_id is
 *                PermissionError (403). a manager without a team
 *                membership is PermissionError as well.
 *   - employee : PermissionError. The route's requireRole gate will
 *                normally block this, but the service stays defensive.
 *   - viewer   : PermissionError.
 *
 * RLS continues to scope every row to the current org. The team filter
 * is applied in SQL by joining memberships(team_id), so even a row that
 * RLS allowed (same-org) is excluded if the agent does not belong to
 * the selected team.
 *
 * The report computes 5 metrics + a recent call list in a single
 * `withOrgContext` transaction so the values are consistent and one
 * connection acquire covers the whole call.
 */
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import {
  PermissionError,
} from "./callPermissions.js";
import type {
  TeamReportRecentCall,
  TeamReportSummary,
} from "../types/teamReport.js";

export type TeamReportRole =
  | "admin"
  | "manager"
  | "employee"
  | "viewer";

export interface TeamReportActor {
  userId: string;
  orgId: string;
  role: TeamReportRole;
}

export interface TeamReportOptions {
  teamId?: string | null;
}

// Distinct from PermissionError so the route can map team-not-visible
// to 404 (RLS opacity) without leaking existence elsewhere.
export class TeamReportNotFoundError extends Error {
  code = "not_found" as const;
  constructor(message = "not_found") {
    super(message);
    this.name = "TeamReportNotFoundError";
  }
}

interface MetricRow {
  total_calls: number;
  ended_calls: number;
  missed_calls: number;
  dropped_calls: number;
  active_calls: number;
  avg_duration_seconds: number | null;
}

interface RawRecentCallRow {
  id: string;
  customer_id: string | null;
  customer_name: string | null;
  agent_user_id: string | null;
  agent_name: string | null;
  team_id: string | null;
  team_name: string | null;
  direction: string;
  status: string;
  started_at: Date;
  ended_at: Date | null;
  duration_seconds: number | null;
  title: string | null;
  sentiment: string | null;
}

// Look up the actor's active membership team. RLS scopes the lookup to
// the actor's org and the user_id GUC pins the membership row.
async function actorTeamId(
  client: PoolClient,
  actorUserId: string,
): Promise<string | null> {
  const r = await client.query<{ team_id: string | null }>(
    `SELECT team_id FROM memberships
      WHERE user_id = $1 AND status = 'active'`,
    [actorUserId],
  );
  return r.rows[0]?.team_id ?? null;
}

// Resolve a team_id to its name within the current org. Returns null if
// the row does not exist (or is cross-org, hidden by RLS).
async function teamNameOrNull(
  client: PoolClient,
  teamId: string,
): Promise<string | null> {
  const r = await client.query<{ name: string }>(
    `SELECT name FROM teams WHERE id = $1`,
    [teamId],
  );
  return r.rows[0]?.name ?? null;
}

// Aggregate metrics. teamId === null → org-wide (all non-deleted calls).
// teamId !== null → only calls whose agent currently belongs to that team.
async function aggregateMetrics(
  client: PoolClient,
  teamId: string | null,
): Promise<MetricRow> {
  if (teamId === null) {
    const r = await client.query<MetricRow>(
      `SELECT
          count(*)::int                                              AS total_calls,
          count(*) FILTER (WHERE status = 'ended')::int              AS ended_calls,
          count(*) FILTER (WHERE status = 'missed')::int             AS missed_calls,
          count(*) FILTER (WHERE status = 'dropped')::int            AS dropped_calls,
          count(*) FILTER (WHERE status = 'in_progress')::int        AS active_calls,
          AVG(duration_seconds) FILTER (WHERE status = 'ended'
            AND duration_seconds IS NOT NULL)::float                 AS avg_duration_seconds
         FROM calls
        WHERE deleted_at IS NULL`,
    );
    return r.rows[0]!;
  }
  const r = await client.query<MetricRow>(
    `SELECT
        count(*)::int                                              AS total_calls,
        count(*) FILTER (WHERE status = 'ended')::int              AS ended_calls,
        count(*) FILTER (WHERE status = 'missed')::int             AS missed_calls,
        count(*) FILTER (WHERE status = 'dropped')::int            AS dropped_calls,
        count(*) FILTER (WHERE status = 'in_progress')::int        AS active_calls,
        AVG(duration_seconds) FILTER (WHERE status = 'ended'
          AND duration_seconds IS NOT NULL)::float                 AS avg_duration_seconds
       FROM calls c
      WHERE c.deleted_at IS NULL
        AND c.agent_user_id IN (
          SELECT m.user_id FROM memberships m
           WHERE m.team_id = $1
             AND m.status = 'active'
        )`,
    [teamId],
  );
  return r.rows[0]!;
}

async function recentCalls(
  client: PoolClient,
  teamId: string | null,
): Promise<RawRecentCallRow[]> {
  const baseFrom = `
    FROM calls c
    LEFT JOIN customers cust ON cust.id = c.customer_id AND cust.deleted_at IS NULL
    LEFT JOIN users     u    ON u.id    = c.agent_user_id
    LEFT JOIN memberships am ON am.user_id = c.agent_user_id AND am.status = 'active'
    LEFT JOIN teams     t    ON t.id   = am.team_id
   WHERE c.deleted_at IS NULL`;

  if (teamId === null) {
    const r = await client.query<RawRecentCallRow>(
      `SELECT
          c.id                                  AS id,
          c.customer_id                         AS customer_id,
          cust.name                             AS customer_name,
          c.agent_user_id                       AS agent_user_id,
          u.name                                AS agent_name,
          am.team_id                            AS team_id,
          t.name                                AS team_name,
          c.direction                           AS direction,
          c.status                              AS status,
          c.started_at                          AS started_at,
          c.ended_at                            AS ended_at,
          c.duration_seconds                    AS duration_seconds,
          c.title                               AS title,
          c.sentiment                           AS sentiment
        ${baseFrom}
        ORDER BY c.started_at DESC, c.id DESC
        LIMIT 10`,
    );
    return r.rows;
  }
  const r = await client.query<RawRecentCallRow>(
    `SELECT
        c.id                                  AS id,
        c.customer_id                         AS customer_id,
        cust.name                             AS customer_name,
        c.agent_user_id                       AS agent_user_id,
        u.name                                AS agent_name,
        am.team_id                            AS team_id,
        t.name                                AS team_name,
        c.direction                           AS direction,
        c.status                              AS status,
        c.started_at                          AS started_at,
        c.ended_at                            AS ended_at,
        c.duration_seconds                    AS duration_seconds,
        c.title                               AS title,
        c.sentiment                           AS sentiment
      ${baseFrom}
        AND c.agent_user_id IN (
          SELECT m.user_id FROM memberships m
           WHERE m.team_id = $1
             AND m.status = 'active'
        )
      ORDER BY c.started_at DESC, c.id DESC
      LIMIT 10`,
    [teamId],
  );
  return r.rows;
}

function normaliseRecentRow(row: RawRecentCallRow): TeamReportRecentCall {
  return {
    id: row.id,
    customer_id: row.customer_id,
    customer_name: row.customer_name,
    agent_user_id: row.agent_user_id,
    agent_name: row.agent_name,
    team_id: row.team_id,
    team_name: row.team_name,
    direction: row.direction as TeamReportRecentCall["direction"],
    status: row.status as TeamReportRecentCall["status"],
    started_at: row.started_at,
    ended_at: row.ended_at,
    duration_seconds: row.duration_seconds,
    title: row.title,
    sentiment: row.sentiment as TeamReportRecentCall["sentiment"],
  };
}

export async function getTeamReportSummary(
  app: FastifyInstance,
  actor: TeamReportActor,
  opts: TeamReportOptions,
): Promise<TeamReportSummary> {
  // Employee / viewer never see this report. The route also blocks
  // them via requireRole, but the service stays defensive in case it
  // is wired without the gate (tests, future internal callers).
  if (actor.role !== "admin" && actor.role !== "manager") {
    throw new PermissionError("employee / viewer cannot read team report");
  }

  const rawTeamId = (opts.teamId ?? null) || null;

  return app.withOrgContext(actor.orgId, actor.userId, async (client) => {
    // Resolve the actor's own team early — manager flows always need it
    // and admin doesn't pay for it more than one query.
    const ownTeamId = await actorTeamId(client, actor.userId);

    // Decide the scope + team_id we will actually report on.
    let scope: "org" | "team";
    let targetTeamId: string | null;
    let targetTeamName: string | null;

    if (actor.role === "manager") {
      if (!ownTeamId) {
        throw new PermissionError("manager without team cannot read report");
      }
      if (rawTeamId && rawTeamId !== ownTeamId) {
        // Could be cross-org (RLS) or same-org-other-team. Probe the
        // team row to choose the right error code:
        //   visible same-org → 403
        //   not visible      → 404
        const name = await teamNameOrNull(client, rawTeamId);
        if (name === null) throw new TeamReportNotFoundError();
        throw new PermissionError("manager other-team report denied");
      }
      targetTeamId = ownTeamId;
      targetTeamName = (await teamNameOrNull(client, ownTeamId)) ?? null;
      scope = "team";
    } else {
      // admin
      if (rawTeamId) {
        const name = await teamNameOrNull(client, rawTeamId);
        if (name === null) throw new TeamReportNotFoundError();
        targetTeamId = rawTeamId;
        targetTeamName = name;
        scope = "team";
      } else {
        targetTeamId = null;
        targetTeamName = null;
        scope = "org";
      }
    }

    const metrics = await aggregateMetrics(client, targetTeamId);
    const recent = await recentCalls(client, targetTeamId);

    // response_rate = ended / (ended + missed). dropped excluded —
    // network failures do not signal customer intent. null when the
    // denominator is zero so the UI can render "—".
    const respDenom = metrics.ended_calls + metrics.missed_calls;
    const response_rate =
      respDenom > 0 ? metrics.ended_calls / respDenom : null;

    return {
      scope,
      team_id: targetTeamId,
      team_name: targetTeamName,
      generated_at: new Date(),
      total_calls: metrics.total_calls,
      ended_calls: metrics.ended_calls,
      missed_calls: metrics.missed_calls,
      dropped_calls: metrics.dropped_calls,
      active_calls: metrics.active_calls,
      response_rate,
      avg_duration_seconds: metrics.avg_duration_seconds,
      recent_calls: recent.map(normaliseRecentRow),
    };
  });
}

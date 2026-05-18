/* Team reports service — Phase 6 Step 4 + Phase 7 Step 7.
 *
 * Plan: docs/plan/phase-6/PHASE_6_STEP_4_PLAN.md §6 (initial);
 *       docs/plan/phase-7/PHASE_7_STEP_7_PLAN.md §4 (date window
 *       + agent breakdown).
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
 * Date window (Phase 7 Step 7):
 *   - Every metric / recent_calls / agent_summaries query is bounded by
 *     `started_at >= fromInclusive AND started_at < toExclusive` where
 *     `toExclusive` is `to + 1 UTC day` (so UI date `to` is inclusive).
 *   - Default when both date params are omitted is the most recent 30
 *     calendar days inclusive (`from = today − 29d, to = today`).
 *   - Window is resolved up-front via `resolveReportWindow` so the
 *     audit payload, response metadata, and SQL filter all agree on
 *     the exact bounds.
 *
 * Agent summaries (Phase 7 Step 7):
 *   - Org scope includes a single `agent_user_id IS NULL` bucket when
 *     unassigned calls exist in the window, so the breakdown total
 *     matches the org-wide KPI counters.
 *   - Team scope excludes unassigned calls, matching the existing
 *     manager contract.
 *   - Only agents with at least one call in the window are returned.
 *     Members with zero activity stay off the report by design; a UI
 *     surface for "no calls this period" can layer on a separate
 *     members query later.
 *
 * The report computes all sections in a single `withOrgContext`
 * transaction so the values are consistent and one connection acquire
 * covers the whole call.
 */
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import {
  PermissionError,
} from "./callPermissions.js";
import type {
  TeamReportAgentSummary,
  TeamReportRecentCall,
  TeamReportSummary,
  TeamReportWindow,
} from "../types/teamReport.js";
import { recordReportTeamViewed } from "./activityLog.js";

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
  window?: TeamReportWindow;
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

// 400-class errors raised by the window resolver. Route layer maps to
// `{ error: 'invalid_input', code: <reason> }` so the frontend can show
// a specific banner per failure mode.
export type ReportWindowErrorCode =
  | "invalid_date_format"
  | "invalid_calendar_date"
  | "from_after_to"
  | "window_too_large"
  | "one_sided_window";

export class ReportWindowError extends Error {
  readonly code: ReportWindowErrorCode;
  constructor(code: ReportWindowErrorCode, message: string) {
    super(message);
    this.name = "ReportWindowError";
    this.code = code;
  }
}

// Default report window in calendar days when both ?from and ?to are
// omitted. Exposed for the route + tests so they don't drift apart.
export const DEFAULT_REPORT_WINDOW_DAYS = 30;
// Hard cap so a runaway query (manual URL tampering, accidental year
// range) cannot scan the whole table. Picked to comfortably cover
// "last 12 months" usage without inviting full-table reads.
export const MAX_REPORT_WINDOW_DAYS = 366;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Build a Date at the UTC midnight start of the given YYYY-MM-DD. The
// component round-trip catches inputs like `2026-02-31` that
// `new Date("2026-02-31")` would silently normalise to March 3.
function parseUtcDateOnly(raw: string): Date {
  if (!DATE_ONLY_RE.test(raw)) {
    throw new ReportWindowError(
      "invalid_date_format",
      `expected YYYY-MM-DD, got ${JSON.stringify(raw)}`,
    );
  }
  // The DATE_ONLY_RE guard above guarantees three components; assert
  // non-undefined for tsc's strict-undefined-array-index pass.
  const parts = raw.split("-") as [string, string, string];
  const y = Number.parseInt(parts[0], 10);
  const m = Number.parseInt(parts[1], 10);
  const d = Number.parseInt(parts[2], 10);
  const candidate = new Date(Date.UTC(y, m - 1, d));
  if (
    Number.isNaN(candidate.getTime())
    || candidate.getUTCFullYear() !== y
    || candidate.getUTCMonth() !== m - 1
    || candidate.getUTCDate() !== d
  ) {
    throw new ReportWindowError(
      "invalid_calendar_date",
      `not a real calendar date: ${raw}`,
    );
  }
  return candidate;
}

// Truncate a Date to that UTC day's start. Used to derive the default
// window from `now` without inheriting hour/minute/second drift.
function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
  ));
}

function formatUtcDateOnly(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export interface ResolveReportWindowInput {
  from?: string | null;
  to?: string | null;
}

/** Resolve the report window from raw query string values + a `now`
 *  reference. Centralises every date rule:
 *
 *    - both omitted → last 30 calendar days inclusive ending today UTC.
 *    - one-sided   → 400 `one_sided_window`. The plan accepts this as
 *                    the safer default: a half-open range is almost
 *                    always a frontend bug, and silently filling the
 *                    other side hides intent from the audit payload.
 *    - both present:
 *        invalid format / calendar    → 400
 *        from > to                    → 400 from_after_to
 *        (to - from) + 1 > 366 days   → 400 window_too_large
 *
 *  Returns the wire-shape TeamReportWindow that the route echoes back
 *  to the caller and that the audit payload references for `from`,
 *  `to`, and `window_days`.
 */
export function resolveReportWindow(
  input: ResolveReportWindowInput,
  now: Date,
): TeamReportWindow {
  const hasFrom = typeof input.from === "string" && input.from.length > 0;
  const hasTo = typeof input.to === "string" && input.to.length > 0;

  if (!hasFrom && !hasTo) {
    const today = utcDayStart(now);
    const fromInclusive = new Date(
      today.getTime() - (DEFAULT_REPORT_WINDOW_DAYS - 1) * ONE_DAY_MS,
    );
    return buildWindow(fromInclusive, today);
  }

  if (hasFrom !== hasTo) {
    throw new ReportWindowError(
      "one_sided_window",
      "from and to must be provided together",
    );
  }

  const fromInclusive = parseUtcDateOnly(input.from as string);
  const toInclusive = parseUtcDateOnly(input.to as string);

  if (fromInclusive.getTime() > toInclusive.getTime()) {
    throw new ReportWindowError(
      "from_after_to",
      "from must be on or before to",
    );
  }

  const days =
    Math.round(
      (toInclusive.getTime() - fromInclusive.getTime()) / ONE_DAY_MS,
    ) + 1;
  if (days > MAX_REPORT_WINDOW_DAYS) {
    throw new ReportWindowError(
      "window_too_large",
      `window exceeds ${MAX_REPORT_WINDOW_DAYS} days`,
    );
  }

  return buildWindow(fromInclusive, toInclusive);
}

function buildWindow(
  fromInclusive: Date,
  toInclusive: Date,
): TeamReportWindow {
  const toExclusive = new Date(toInclusive.getTime() + ONE_DAY_MS);
  const days =
    Math.round(
      (toInclusive.getTime() - fromInclusive.getTime()) / ONE_DAY_MS,
    ) + 1;
  return {
    from: formatUtcDateOnly(fromInclusive),
    to: formatUtcDateOnly(toInclusive),
    from_inclusive: fromInclusive,
    to_exclusive: toExclusive,
    days,
  };
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

interface RawAgentSummaryRow {
  agent_user_id: string | null;
  agent_name: string | null;
  team_id: string | null;
  team_name: string | null;
  total_calls: number;
  ended_calls: number;
  missed_calls: number;
  dropped_calls: number;
  active_calls: number;
  avg_duration_seconds: number | null;
  latest_call_at: Date | null;
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

// Aggregate metrics. teamId === null → org-wide (all non-deleted calls
// in window). teamId !== null → only calls whose agent currently belongs
// to that team.
async function aggregateMetrics(
  client: PoolClient,
  teamId: string | null,
  window: TeamReportWindow,
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
        WHERE deleted_at IS NULL
          AND started_at >= $1
          AND started_at <  $2`,
      [window.from_inclusive, window.to_exclusive],
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
        AND c.started_at >= $2
        AND c.started_at <  $3
        AND c.agent_user_id IN (
          SELECT m.user_id FROM memberships m
           WHERE m.team_id = $1
             AND m.status = 'active'
        )`,
    [teamId, window.from_inclusive, window.to_exclusive],
  );
  return r.rows[0]!;
}

async function recentCalls(
  client: PoolClient,
  teamId: string | null,
  window: TeamReportWindow,
): Promise<RawRecentCallRow[]> {
  const baseFrom = `
    FROM calls c
    LEFT JOIN customers cust ON cust.id = c.customer_id AND cust.deleted_at IS NULL
    LEFT JOIN users     u    ON u.id    = c.agent_user_id
    LEFT JOIN memberships am ON am.user_id = c.agent_user_id AND am.status = 'active'
    LEFT JOIN teams     t    ON t.id   = am.team_id
   WHERE c.deleted_at IS NULL
     AND c.started_at >= $1
     AND c.started_at <  $2`;

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
      [window.from_inclusive, window.to_exclusive],
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
           WHERE m.team_id = $3
             AND m.status = 'active'
        )
      ORDER BY c.started_at DESC, c.id DESC
      LIMIT 10`,
    [window.from_inclusive, window.to_exclusive, teamId],
  );
  return r.rows;
}

// Per-agent breakdown. Org scope includes the unassigned bucket
// (`agent_user_id IS NULL`) so the row totals reconcile with the org-
// wide KPI counters; team scope joins memberships(team_id=$3) so it
// only returns agents currently active in the requested team, which
// also drops the unassigned bucket automatically (NULL agent has no
// membership row).
async function agentSummaries(
  client: PoolClient,
  teamId: string | null,
  window: TeamReportWindow,
): Promise<RawAgentSummaryRow[]> {
  if (teamId === null) {
    const r = await client.query<RawAgentSummaryRow>(
      `SELECT
          c.agent_user_id                                            AS agent_user_id,
          u.name                                                     AS agent_name,
          am.team_id                                                 AS team_id,
          t.name                                                     AS team_name,
          count(*)::int                                              AS total_calls,
          count(*) FILTER (WHERE c.status = 'ended')::int            AS ended_calls,
          count(*) FILTER (WHERE c.status = 'missed')::int           AS missed_calls,
          count(*) FILTER (WHERE c.status = 'dropped')::int          AS dropped_calls,
          count(*) FILTER (WHERE c.status = 'in_progress')::int      AS active_calls,
          AVG(c.duration_seconds) FILTER (WHERE c.status = 'ended'
            AND c.duration_seconds IS NOT NULL)::float               AS avg_duration_seconds,
          MAX(c.started_at)                                          AS latest_call_at
         FROM calls c
         LEFT JOIN users       u  ON u.id  = c.agent_user_id
         LEFT JOIN memberships am ON am.user_id = c.agent_user_id AND am.status = 'active'
         LEFT JOIN teams       t  ON t.id  = am.team_id
        WHERE c.deleted_at IS NULL
          AND c.started_at >= $1
          AND c.started_at <  $2
        GROUP BY c.agent_user_id, u.name, am.team_id, t.name
        ORDER BY total_calls DESC,
                 latest_call_at DESC NULLS LAST,
                 agent_name ASC NULLS LAST`,
      [window.from_inclusive, window.to_exclusive],
    );
    return r.rows;
  }
  const r = await client.query<RawAgentSummaryRow>(
    `SELECT
        c.agent_user_id                                            AS agent_user_id,
        u.name                                                     AS agent_name,
        am.team_id                                                 AS team_id,
        t.name                                                     AS team_name,
        count(*)::int                                              AS total_calls,
        count(*) FILTER (WHERE c.status = 'ended')::int            AS ended_calls,
        count(*) FILTER (WHERE c.status = 'missed')::int           AS missed_calls,
        count(*) FILTER (WHERE c.status = 'dropped')::int          AS dropped_calls,
        count(*) FILTER (WHERE c.status = 'in_progress')::int      AS active_calls,
        AVG(c.duration_seconds) FILTER (WHERE c.status = 'ended'
          AND c.duration_seconds IS NOT NULL)::float               AS avg_duration_seconds,
        MAX(c.started_at)                                          AS latest_call_at
       FROM calls c
       JOIN  memberships am ON am.user_id = c.agent_user_id
                            AND am.status = 'active'
                            AND am.team_id = $3
       LEFT JOIN users       u  ON u.id  = c.agent_user_id
       LEFT JOIN teams       t  ON t.id  = am.team_id
      WHERE c.deleted_at IS NULL
        AND c.started_at >= $1
        AND c.started_at <  $2
      GROUP BY c.agent_user_id, u.name, am.team_id, t.name
      ORDER BY total_calls DESC,
               latest_call_at DESC NULLS LAST,
               agent_name ASC NULLS LAST`,
    [window.from_inclusive, window.to_exclusive, teamId],
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

function normaliseAgentSummary(
  row: RawAgentSummaryRow,
): TeamReportAgentSummary {
  const respDenom = row.ended_calls + row.missed_calls;
  const response_rate =
    respDenom > 0 ? row.ended_calls / respDenom : null;
  return {
    agent_user_id: row.agent_user_id,
    agent_name: row.agent_name,
    team_id: row.team_id,
    team_name: row.team_name,
    total_calls: row.total_calls,
    ended_calls: row.ended_calls,
    missed_calls: row.missed_calls,
    dropped_calls: row.dropped_calls,
    active_calls: row.active_calls,
    response_rate,
    avg_duration_seconds: row.avg_duration_seconds,
    latest_call_at: row.latest_call_at,
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
  const window =
    opts.window ?? resolveReportWindow({ from: null, to: null }, new Date());

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

    const metrics = await aggregateMetrics(client, targetTeamId, window);
    const recent = await recentCalls(client, targetTeamId, window);
    const agents = await agentSummaries(client, targetTeamId, window);

    // response_rate = ended / (ended + missed). dropped excluded —
    // network failures do not signal customer intent. null when the
    // denominator is zero so the UI can render "—".
    const respDenom = metrics.ended_calls + metrics.missed_calls;
    const response_rate =
      respDenom > 0 ? metrics.ended_calls / respDenom : null;

    // Phase 7 Step 3 — best-effort audit. tryRecordActivity inside the
    // helper wraps the INSERT in a SAVEPOINT so any sanitizer / DB
    // failure stays local: the report response is unaffected. The
    // boolean return is intentionally discarded — losing one audit row
    // must never block a user-visible read. Phase 7 Step 7 expands the
    // payload with the resolved window so auditors can see WHICH date
    // range was viewed, not just that the view was opened.
    await recordReportTeamViewed(client, {
      orgId:       actor.orgId,
      actorUserId: actor.userId,
      scope,
      teamId:      targetTeamId,
      from:        window.from,
      to:          window.to,
      windowDays:  window.days,
    });

    return {
      scope,
      team_id: targetTeamId,
      team_name: targetTeamName,
      generated_at: new Date(),
      window,
      total_calls: metrics.total_calls,
      ended_calls: metrics.ended_calls,
      missed_calls: metrics.missed_calls,
      dropped_calls: metrics.dropped_calls,
      active_calls: metrics.active_calls,
      response_rate,
      avg_duration_seconds: metrics.avg_duration_seconds,
      recent_calls: recent.map(normaliseRecentRow),
      agent_summaries: agents.map(normaliseAgentSummary),
    };
  });
}

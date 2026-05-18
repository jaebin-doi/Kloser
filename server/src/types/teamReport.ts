/* team report shared types — Phase 6 Step 4 + Phase 7 Step 7.
 *
 * Server source-of-truth: server/src/types/teamReport.ts.
 * Browser JSDoc mirror:   platform/types/teamReport.js.
 *
 * Sync target schemas (top-level `export const X = z.object({ ... })`):
 *   - TeamReportSummary
 *   - TeamReportRecentCall
 *   - TeamReportQuery        (Phase 7 Step 7)
 *   - TeamReportWindow       (Phase 7 Step 7)
 *   - TeamReportAgentSummary (Phase 7 Step 7)
 *
 * `scope` is "org" for admin org-wide reports and "team" when a single
 * team's metrics are returned (admin with explicit team_id, manager).
 *
 * `response_rate` and `avg_duration_seconds` are nullable so the route
 * can return null when the denominator is empty rather than 0 — the
 * frontend must distinguish "no signal" from "0%".
 *
 * Phase 7 Step 7 — date window + agent breakdown:
 *   - All metrics, recent_calls, and agent_summaries respect the same
 *     `[from, to+1d)` UTC window. Default window is the most recent
 *     30 calendar days inclusive when both `from` and `to` are omitted.
 *   - `agent_summaries` includes a single `agent_user_id=null` bucket
 *     for unassigned calls in org-wide reports. Team-scoped reports
 *     exclude unassigned calls to match the existing manager contract.
 */
import { z } from "zod";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UuidString = z.string().regex(UUID_RE, "invalid uuid");

// YYYY-MM-DD literal. Calendar-validity (e.g. rejecting 2026-02-31)
// happens in the service window resolver — zod regex alone cannot
// enforce it because the values "02", "31" both individually parse
// fine.
export const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

const Direction = z.enum(["inbound", "outbound", "meeting"]);
const Status = z.enum(["in_progress", "ended", "missed", "dropped"]);
const Sentiment = z.enum(["positive", "neutral", "cautious", "negative"]);
const ReportScope = z.enum(["org", "team"]);

export const TeamReportRecentCall = z.object({
  id: UuidString,
  customer_id: UuidString.nullable(),
  customer_name: z.string().nullable(),
  agent_user_id: UuidString.nullable(),
  agent_name: z.string().nullable(),
  team_id: UuidString.nullable(),
  team_name: z.string().nullable(),
  direction: Direction,
  status: Status,
  started_at: z.date(),
  ended_at: z.date().nullable(),
  duration_seconds: z.number().int().nonnegative().nullable(),
  title: z.string().nullable(),
  sentiment: Sentiment.nullable(),
});
export type TeamReportRecentCall = z.infer<typeof TeamReportRecentCall>;

// Phase 7 Step 7 — route query input. Mirrors the request surface only;
// the server resolves a default 30-day window when both date fields are
// omitted, and rejects partial / reversed / oversized ranges with 400.
export const TeamReportQuery = z.object({
  team_id: UuidString.optional(),
  // The route intentionally accepts raw strings here and lets
  // resolveReportWindow classify bad dates into stable API error codes
  // (`invalid_date_format`, `invalid_calendar_date`, etc.).
  from: z.string().optional(),
  to: z.string().optional(),
});
export type TeamReportQuery = z.infer<typeof TeamReportQuery>;

// Phase 7 Step 7 — window metadata that ships back to the client. The
// two Date fields use exclusive-end semantics in SQL (`>= from_inclusive
// AND < to_exclusive`) even though the UI presents `to` as inclusive;
// keeping both representations on the wire avoids any drift between the
// audit payload, the UI controls, and the SQL filter.
export const TeamReportWindow = z.object({
  from: z.string(),
  to: z.string(),
  from_inclusive: z.date(),
  to_exclusive: z.date(),
  days: z.number().int().positive(),
});
export type TeamReportWindow = z.infer<typeof TeamReportWindow>;

// Phase 7 Step 7 — per-agent KPI breakdown for the resolved window.
// agent_user_id=null is the "unassigned" bucket (org scope only); the
// team/team_name fields stay null for that row because there is no
// membership to join. response_rate / avg_duration follow the same
// null-when-empty-denominator policy as the top-level KPIs.
export const TeamReportAgentSummary = z.object({
  agent_user_id: UuidString.nullable(),
  agent_name: z.string().nullable(),
  team_id: UuidString.nullable(),
  team_name: z.string().nullable(),
  total_calls: z.number().int().nonnegative(),
  ended_calls: z.number().int().nonnegative(),
  missed_calls: z.number().int().nonnegative(),
  dropped_calls: z.number().int().nonnegative(),
  active_calls: z.number().int().nonnegative(),
  response_rate: z.number().min(0).max(1).nullable(),
  avg_duration_seconds: z.number().nonnegative().nullable(),
  latest_call_at: z.date().nullable(),
});
export type TeamReportAgentSummary = z.infer<typeof TeamReportAgentSummary>;

export const TeamReportSummary = z.object({
  scope: ReportScope,
  team_id: UuidString.nullable(),
  team_name: z.string().nullable(),
  generated_at: z.date(),
  window: TeamReportWindow,
  total_calls: z.number().int().nonnegative(),
  ended_calls: z.number().int().nonnegative(),
  missed_calls: z.number().int().nonnegative(),
  dropped_calls: z.number().int().nonnegative(),
  active_calls: z.number().int().nonnegative(),
  response_rate: z.number().min(0).max(1).nullable(),
  avg_duration_seconds: z.number().nonnegative().nullable(),
  recent_calls: z.array(TeamReportRecentCall),
  agent_summaries: z.array(TeamReportAgentSummary),
});
export type TeamReportSummary = z.infer<typeof TeamReportSummary>;

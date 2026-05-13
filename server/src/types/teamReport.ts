/* team report shared types — Phase 6 Step 4.
 *
 * Server source-of-truth: server/src/types/teamReport.ts.
 * Browser JSDoc mirror:   platform/types/teamReport.js.
 *
 * Sync target schemas (top-level `export const X = z.object({ ... })`):
 *   - TeamReportSummary
 *   - TeamReportRecentCall
 *
 * `scope` is "org" for admin org-wide reports and "team" when a single
 * team's metrics are returned (admin with explicit team_id, manager).
 *
 * `response_rate` and `avg_duration_seconds` are nullable so the route
 * can return null when the denominator is empty rather than 0 — the
 * frontend must distinguish "no signal" from "0%".
 */
import { z } from "zod";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UuidString = z.string().regex(UUID_RE, "invalid uuid");

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

export const TeamReportSummary = z.object({
  scope: ReportScope,
  team_id: UuidString.nullable(),
  team_name: z.string().nullable(),
  generated_at: z.date(),
  total_calls: z.number().int().nonnegative(),
  ended_calls: z.number().int().nonnegative(),
  missed_calls: z.number().int().nonnegative(),
  dropped_calls: z.number().int().nonnegative(),
  active_calls: z.number().int().nonnegative(),
  response_rate: z.number().min(0).max(1).nullable(),
  avg_duration_seconds: z.number().nonnegative().nullable(),
  recent_calls: z.array(TeamReportRecentCall),
});
export type TeamReportSummary = z.infer<typeof TeamReportSummary>;

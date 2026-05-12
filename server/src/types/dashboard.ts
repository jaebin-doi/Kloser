/* dashboard summary shared types — Phase 4 Step 3.
 *
 * Server source-of-truth: server/src/types/dashboard.ts.
 * Browser JSDoc mirror:   platform/types/dashboard.js.
 *
 * Sync target schemas (top-level `export const X = z.object({ ... })`):
 *   - DashboardSummary
 *   - DashboardRecentCall
 *
 * `response_rate` and `avg_duration_seconds` are nullable for orgs whose
 * "today" window has no qualifying calls (denominator = 0). Routes /
 * frontend must distinguish nullish from 0.
 */
import { z } from "zod";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UuidString = z.string().regex(UUID_RE, "invalid uuid");

const Direction = z.enum(["inbound", "outbound", "meeting"]);
const Status = z.enum(["in_progress", "ended", "missed", "dropped"]);
const Sentiment = z.enum(["positive", "neutral", "cautious", "negative"]);

export const DashboardRecentCall = z.object({
  id: UuidString,
  customer_id: UuidString.nullable(),
  customer_name: z.string().nullable(),
  agent_user_id: UuidString.nullable(),
  agent_name: z.string().nullable(),
  direction: Direction,
  status: Status,
  started_at: z.date(),
  ended_at: z.date().nullable(),
  duration_seconds: z.number().int().nonnegative().nullable(),
  title: z.string().nullable(),
  sentiment: Sentiment.nullable(),
});
export type DashboardRecentCall = z.infer<typeof DashboardRecentCall>;

export const DashboardSummary = z.object({
  today_calls: z.number().int().nonnegative(),
  response_rate: z.number().min(0).max(1).nullable(),
  avg_duration_seconds: z.number().nonnegative().nullable(),
  active_calls: z.number().int().nonnegative(),
  recent_calls: z.array(DashboardRecentCall),
});
export type DashboardSummary = z.infer<typeof DashboardSummary>;

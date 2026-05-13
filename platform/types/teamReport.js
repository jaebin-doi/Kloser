// platform/types/teamReport.js — JSDoc mirror of team report types.
//
// Server source-of-truth: server/src/types/teamReport.ts.
// Sync verification:      test/sync_shared_types.mjs.
//
// scope = "org" for admin org-wide reports, "team" for single-team
// reports (admin with team_id, manager). response_rate and
// avg_duration_seconds are nullable when the denominator is empty —
// callers must distinguish nullish from 0.

/**
 * @typedef {Object} TeamReportRecentCall
 * @property {string} id
 * @property {string|null} customer_id
 * @property {string|null} customer_name
 * @property {string|null} agent_user_id
 * @property {string|null} agent_name
 * @property {string|null} team_id
 * @property {string|null} team_name
 * @property {"inbound"|"outbound"|"meeting"} direction
 * @property {"in_progress"|"ended"|"missed"|"dropped"} status
 * @property {string} started_at
 * @property {string|null} ended_at
 * @property {number|null} duration_seconds
 * @property {string|null} title
 * @property {"positive"|"neutral"|"cautious"|"negative"|null} sentiment
 */

/**
 * @typedef {Object} TeamReportSummary
 * @property {"org"|"team"} scope
 * @property {string|null} team_id
 * @property {string|null} team_name
 * @property {string} generated_at
 * @property {number} total_calls
 * @property {number} ended_calls
 * @property {number} missed_calls
 * @property {number} dropped_calls
 * @property {number} active_calls
 * @property {number|null} response_rate
 * @property {number|null} avg_duration_seconds
 * @property {TeamReportRecentCall[]} recent_calls
 */

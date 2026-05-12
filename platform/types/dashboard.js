// platform/types/dashboard.js — JSDoc mirror of dashboard summary types.
//
// Server source-of-truth: server/src/types/dashboard.ts.
// Sync verification:      test/sync_shared_types.mjs.
//
// today_calls / response_rate / avg_duration_seconds / active_calls are
// computed on the server against an UTC day boundary (Phase 4 master
// §12 decision). response_rate and avg_duration_seconds are nullable
// when the denominator is empty.

/**
 * @typedef {Object} DashboardRecentCall
 * @property {string} id
 * @property {string|null} customer_id
 * @property {string|null} customer_name
 * @property {string|null} agent_user_id
 * @property {string|null} agent_name
 * @property {"inbound"|"outbound"|"meeting"} direction
 * @property {"in_progress"|"ended"|"missed"|"dropped"} status
 * @property {string} started_at
 * @property {string|null} ended_at
 * @property {number|null} duration_seconds
 * @property {string|null} title
 * @property {"positive"|"neutral"|"cautious"|"negative"|null} sentiment
 */

/**
 * @typedef {Object} DashboardSummary
 * @property {number} today_calls
 * @property {number|null} response_rate
 * @property {number|null} avg_duration_seconds
 * @property {number} active_calls
 * @property {DashboardRecentCall[]} recent_calls
 */

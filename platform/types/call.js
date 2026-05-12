// platform/types/call.js — JSDoc-only browser mirror of call shared types.
//
// Server source-of-truth: server/src/types/call.ts.
// Sync verification:      test/sync_shared_types.mjs.
//
// This file is NOT loaded into the browser at runtime. It exists for IDE
// JSDoc intellisense across platform/calls.html / live.html (Step 4
// frontend wiring).
//
// Wire format vs server-internal:
//   - timestamps (started_at, ended_at, deleted_at, created_at,
//     updated_at) are ISO 8601 strings on the wire. The server keeps
//     them as JS Date inside service code; JSON serialization yields
//     ISO strings.
//   - validation refinements (.refine, .min, .max, .default) live on
//     the server schema only. The mirror tracks **field names**.

/**
 * @typedef {"inbound" | "outbound" | "meeting"} CallDirection
 */
/**
 * @typedef {"in_progress" | "ended" | "missed" | "dropped"} CallStatus
 */
/**
 * @typedef {"ended" | "missed" | "dropped"} CallFinalStatus
 */
/**
 * @typedef {"positive" | "neutral" | "cautious" | "negative"} CallSentiment
 */

/**
 * @typedef {Object} Call
 * @property {string} id
 * @property {string} org_id
 * @property {string|null} customer_id
 * @property {string|null} agent_user_id
 * @property {CallDirection} direction
 * @property {CallStatus} status
 * @property {string} started_at
 * @property {string|null} ended_at
 * @property {number|null} duration_seconds
 * @property {string|null} title
 * @property {string|null} summary
 * @property {string|null} needs
 * @property {string|null} issues
 * @property {CallSentiment|null} sentiment
 * @property {string|null} notes
 * @property {string|null} deleted_at
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {Object} CallCreateInput
 * @property {string|null} [customer_id]
 * @property {string|null} [agent_user_id]
 * @property {CallDirection} direction
 * @property {"in_progress"} [status]
 * @property {string|null} [title]
 * @property {string|null} [notes]
 */

/**
 * @typedef {Object} CallNotesInput
 * @property {string|null} notes
 */

/**
 * @typedef {Object} CallEndInput
 * @property {string} [ended_at]
 * @property {CallFinalStatus} [final_status]
 */

/**
 * @typedef {Object} CallListQuery
 * @property {string} [q]
 * @property {string|"null"|null} [customerId]
 * @property {string|"null"|null} [agentUserId]
 * @property {CallStatus} [status]
 * @property {number} [limit]
 * @property {number} [offset]
 */

/**
 * @typedef {Object} CallListResponse
 * @property {Call[]} items
 * @property {number} total
 */

/**
 * @typedef {Object} CallDetailResponse
 * @property {Call} call
 */

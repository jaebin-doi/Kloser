// platform/types/callSuggestion.js — JSDoc mirror of call suggestion shared types.
//
// Server source-of-truth: server/src/types/callSuggestion.ts.
// Sync verification:      test/sync_shared_types.mjs.

/**
 * @typedef {"blue" | "cyan" | "amber" | "rose" | "emerald" | "slate"} CallSuggestionTone
 */

/**
 * @typedef {"direction" | "script" | "alert" | "risk" | "next" | "kb"} CallSuggestionType
 */

/**
 * @typedef {Object} CallSuggestion
 * @property {string} id
 * @property {string} call_id
 * @property {string} org_id
 * @property {number} group_seq
 * @property {number} at_ms
 * @property {CallSuggestionTone} tone
 * @property {CallSuggestionType} type
 * @property {string} title
 * @property {string|null} body
 * @property {string|null} dismissed_at
 * @property {string|null} used_at
 * @property {string} created_at
 */

/**
 * @typedef {Object} CallSuggestionInput
 * @property {number} group_seq
 * @property {number} at_ms
 * @property {CallSuggestionTone} tone
 * @property {CallSuggestionType} type
 * @property {string} title
 * @property {string|null} [body]
 */

/**
 * @typedef {Object} CallSuggestionGroupInput
 * @property {CallSuggestionInput[]} items
 */

/**
 * @typedef {Object} CallSuggestionListResponse
 * @property {CallSuggestion[]} items
 */

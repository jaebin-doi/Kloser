// platform/types/actionItem.js — JSDoc mirror of call_action_items shared types.
//
// Server source-of-truth: server/src/types/actionItem.ts.
// Sync verification:      test/sync_shared_types.mjs.

/**
 * @typedef {"open" | "done" | "dropped"} CallActionItemStatus
 */

/**
 * @typedef {Object} CallActionItem
 * @property {string} id
 * @property {string} call_id
 * @property {string} org_id
 * @property {string} title
 * @property {string|null} due_date
 * @property {string|null} assignee_user_id
 * @property {CallActionItemStatus} status
 * @property {string|null} completed_at
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {Object} ActionItemCreateInput
 * @property {string} title
 * @property {string|null} [due_date]
 * @property {string|null} [assignee_user_id]
 */

/**
 * @typedef {Object} ActionItemStatusInput
 * @property {CallActionItemStatus} status
 */

/**
 * @typedef {Object} ActionItemAssigneeInput
 * @property {string|null} assignee_user_id
 */

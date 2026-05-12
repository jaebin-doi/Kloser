// platform/types/callChecklistItem.js — JSDoc mirror of call checklist item shared types.
//
// Server source-of-truth: server/src/types/callChecklistItem.ts.
// Sync verification:      test/sync_shared_types.mjs.

/**
 * @typedef {"open" | "done"} CallChecklistStatus
 */

/**
 * @typedef {Object} CallChecklistItem
 * @property {string} id
 * @property {string} call_id
 * @property {string} template_id
 * @property {string} org_id
 * @property {CallChecklistStatus} status
 * @property {string|null} checked_at
 * @property {string|null} checked_by_user_id
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {Object} CallChecklistItemStatusInput
 * @property {CallChecklistStatus} status
 */

/**
 * @typedef {Object} CallChecklistItemListResponse
 * @property {CallChecklistItem[]} items
 */

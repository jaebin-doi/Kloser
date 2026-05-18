// platform/types/activityLog.js — JSDoc mirror of activity_log
// shared types.
//
// Server source-of-truth: server/src/types/activityLog.ts.
// Sync verification:      test/sync_shared_types.mjs.
//
// This file is NOT loaded into the browser at runtime. It exists for
// IDE JSDoc intellisense across platform/settings.html and the admin
// audit log panel.
//
// Wire format:
//   - `created_at`, `beforeCreatedAt`, `createdFrom`, `createdTo` are
//     ISO-8601 strings on the wire (the server stores timestamptz; the
//     JSON serializer renders them as strings). The JSDoc declares
//     string, not Date.
//   - `payload` is a plain JSON object. Values can be any JSON-safe
//     type the audit hook produced; the settings UI renders them via
//     textContent and does not assume shape.
//   - `nextCursor` is null when the current page is the last page.
//
// Phase 7 Step 3 surface (admin-only):
//   GET /activity-log?limit&beforeCreatedAt&beforeId
//                    &action&targetType&targetId&userId
//                    &createdFrom&createdTo
//     → ActivityLogListResponse

/**
 * @typedef {Object} ActivityLog
 * @property {string} id
 * @property {string} org_id
 * @property {string|null} user_id
 * @property {string} action
 * @property {string|null} target_type
 * @property {string|null} target_id
 * @property {Object<string, unknown>} payload
 * @property {string} created_at
 */

/**
 * @typedef {Object} ActivityLogListQuery
 * @property {number} [limit]
 * @property {string} [beforeCreatedAt]
 * @property {string} [beforeId]
 * @property {string} [action]
 * @property {string} [targetType]
 * @property {string} [targetId]
 * @property {string} [userId]
 * @property {string} [createdFrom]
 * @property {string} [createdTo]
 */

/**
 * @typedef {Object} ActivityLogCursor
 * @property {string} beforeCreatedAt
 * @property {string} beforeId
 */

/**
 * @typedef {Object} ActivityLogListResponse
 * @property {ActivityLog[]} items
 * @property {ActivityLogCursor|null} nextCursor
 */

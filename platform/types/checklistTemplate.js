// platform/types/checklistTemplate.js — JSDoc mirror of checklist template shared types.
//
// Server source-of-truth: server/src/types/checklistTemplate.ts.
// Sync verification:      test/sync_shared_types.mjs.

/**
 * @typedef {Object} CallChecklistTemplate
 * @property {string} id
 * @property {string} org_id
 * @property {string} title
 * @property {number} sort_order
 * @property {boolean} active
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {Object} CallChecklistTemplateCreateInput
 * @property {string} title
 * @property {number} [sort_order]
 * @property {boolean} [active]
 */

/**
 * @typedef {Object} CallChecklistTemplatePatchInput
 * @property {string} [title]
 * @property {number} [sort_order]
 * @property {boolean} [active]
 */

/**
 * @typedef {Object} CallChecklistTemplateListResponse
 * @property {CallChecklistTemplate[]} items
 */

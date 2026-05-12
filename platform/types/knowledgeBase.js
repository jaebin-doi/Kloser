// platform/types/knowledgeBase.js — JSDoc mirror of knowledge base shared types.
//
// Server source-of-truth: server/src/types/knowledgeBase.ts.
// Sync verification:      test/sync_shared_types.mjs.

/**
 * @typedef {"manual" | "file" | "url"} KnowledgeBaseSourceType
 */

/**
 * @typedef {Object} KnowledgeBase
 * @property {string} id
 * @property {string} org_id
 * @property {string} title
 * @property {KnowledgeBaseSourceType} source_type
 * @property {string|null} source_uri
 * @property {string|null} created_by_user_id
 * @property {string|null} deleted_at
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {Object} KnowledgeBaseCreateInput
 * @property {string} title
 * @property {KnowledgeBaseSourceType} source_type
 * @property {string|null} [source_uri]
 */

/**
 * @typedef {Object} KnowledgeBasePatchInput
 * @property {string} [title]
 * @property {KnowledgeBaseSourceType} [source_type]
 * @property {string|null} [source_uri]
 */

/**
 * @typedef {Object} KnowledgeBaseListResponse
 * @property {KnowledgeBase[]} items
 */

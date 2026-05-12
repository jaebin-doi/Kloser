// platform/types/knowledgeChunk.js — JSDoc mirror of knowledge chunk shared types.
//
// Server source-of-truth: server/src/types/knowledgeChunk.ts.
// Sync verification:      test/sync_shared_types.mjs.

/**
 * @typedef {Object} KnowledgeChunk
 * @property {string} id
 * @property {string} knowledge_base_id
 * @property {string} org_id
 * @property {number} position
 * @property {string} text
 * @property {string|null} embedding
 * @property {number|null} token_count
 * @property {string} created_at
 */

/**
 * @typedef {Object} KnowledgeChunkInput
 * @property {number} position
 * @property {string} text
 * @property {number[]|null} [embedding]
 * @property {number|null} [token_count]
 */

/**
 * @typedef {Object} KnowledgeChunkReplaceInput
 * @property {KnowledgeChunkInput[]} chunks
 */

/**
 * @typedef {Object} KnowledgeChunkSearchQuery
 * @property {string} query
 * @property {number} [limit]
 */

/**
 * @typedef {Object} KnowledgeChunkSearchResultItem
 * @property {string} id
 * @property {string} knowledge_base_id
 * @property {string} org_id
 * @property {number} position
 * @property {string} text
 * @property {string|null} embedding
 * @property {number|null} token_count
 * @property {string} created_at
 * @property {number} distance
 */

/**
 * @typedef {Object} KnowledgeChunkSearchResponse
 * @property {KnowledgeChunkSearchResultItem[]} items
 */

// platform/types/transcript.js — JSDoc mirror of transcript shared types.
//
// Server source-of-truth: server/src/types/transcript.ts.
// Sync verification:      test/sync_shared_types.mjs.

/**
 * @typedef {"agent" | "customer" | "system"} TranscriptSpeaker
 */

/**
 * @typedef {Object} Transcript
 * @property {string} id
 * @property {string} call_id
 * @property {string} org_id
 * @property {number} seq
 * @property {TranscriptSpeaker} speaker
 * @property {string} text
 * @property {number|null} start_ms
 * @property {number|null} end_ms
 * @property {number|null} confidence
 * @property {string} created_at
 */

/**
 * @typedef {Object} TranscriptAppendInput
 * @property {TranscriptSpeaker} speaker
 * @property {string} text
 * @property {number|null} [start_ms]
 * @property {number|null} [end_ms]
 * @property {number|null} [confidence]
 */

/**
 * @typedef {Object} TranscriptListResponse
 * @property {Transcript[]} items
 */

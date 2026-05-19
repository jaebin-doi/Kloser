// platform/types/callRecording.js — JSDoc-only browser mirror of call_recordings shared types.
//
// Server source-of-truth: server/src/types/callRecording.ts.
// Sync verification:      test/sync_shared_types.mjs.
//
// This file is NOT loaded into the browser at runtime. It exists for IDE
// JSDoc intellisense across platform/calls.html / live.html (Step 4
// frontend wiring).
//
// Wire format vs server-internal:
//   - timestamps (recorded_at, uploaded_at, deleted_at, created_at,
//     updated_at, expires_at) are ISO 8601 strings on the wire. The
//     server keeps them as JS Date inside service code; JSON
//     serialization yields ISO strings.
//   - object_key, storage_bucket, storage_provider, object_version,
//     checksum_sha256, metadata, org_id are intentionally NOT exposed.
//     Those are internal locators / config / operational data.

/**
 * @typedef {"upload_pending" | "uploaded" | "processing" | "available" | "delete_pending" | "deleted" | "failed"} CallRecordingStatus
 */
/**
 * @typedef {"audio/webm" | "audio/ogg" | "audio/mpeg" | "audio/mp4" | "audio/wav"} RecordingContentType
 */

/**
 * @typedef {Object} CallRecording
 * @property {string} id
 * @property {string} call_id
 * @property {CallRecordingStatus} status
 * @property {RecordingContentType} content_type
 * @property {string|null} codec
 * @property {number|null} duration_seconds
 * @property {number|null} size_bytes
 * @property {string|null} recorded_at
 * @property {string|null} uploaded_at
 * @property {string|null} deleted_at
 * @property {string|null} error_message
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {Object} CallRecordingUploadInput
 * @property {RecordingContentType} content_type
 * @property {string|null} [codec]
 * @property {string|null} [recorded_at]
 * @property {number|null} [duration_seconds]
 * @property {number|null} [size_bytes]
 * @property {string|null} [checksum_sha256]
 */

/**
 * @typedef {Object} CallRecordingFinalizeInput
 * @property {string|null} [object_version]
 * @property {number|null} [duration_seconds]
 * @property {number|null} [size_bytes]
 * @property {string|null} [checksum_sha256]
 */

/**
 * @typedef {Object} SignedRecordingUrl
 * @property {"PUT" | "GET"} method
 * @property {string} url
 * @property {Object.<string,string>} headers
 * @property {string} expires_at
 */

/**
 * @typedef {Object} CallRecordingUploadResponse
 * @property {CallRecording} recording
 * @property {SignedRecordingUrl} upload
 */

/**
 * @typedef {Object} CallRecordingFinalizeResponse
 * @property {CallRecording} recording
 */

/**
 * @typedef {Object} CallRecordingListResponse
 * @property {CallRecording[]} items
 */

/**
 * @typedef {Object} CallRecordingPlaybackUrlResponse
 * @property {SignedRecordingUrl} playback
 */

// platform/types/wsAudio.js — JSDoc mirror of WS audio shared types.
//
// Server source-of-truth: server/src/types/wsAudio.ts.
// Sync verification:      test/sync_shared_types.mjs.
//
// Phase 9 Step 2 — desktop / browser clients use these typedefs as the
// audio ingest contract. The binary `audio_chunk` PCM buffer is sent as
// the second positional argument to `socket.emit("audio_chunk", meta, pcm)`
// and is intentionally NOT part of any typedef — it must never be
// stringified, persisted, or logged.

/**
 * @typedef {"agent_mic" | "system_loopback"} AudioSource
 */

/**
 * @typedef {"pcm_s16le"} AudioCodec
 */

/**
 * @typedef {16000} AudioSampleRateHz
 */

/**
 * @typedef {1} AudioChannels
 */

/**
 * @typedef {20 | 40 | 60 | 80 | 100} AudioFrameMs
 */

/**
 * @typedef {"normal" | "pause" | "device_lost" | "network_reconnect"} AudioEndReason
 */

/**
 * @typedef {Object} AudioStart
 * @property {"audio_start"} type
 * @property {string} [call_id]
 * @property {AudioSource[]} sources
 * @property {AudioCodec} codec
 * @property {AudioSampleRateHz} sample_rate_hz
 * @property {AudioChannels} channels
 * @property {AudioFrameMs} frame_ms
 * @property {string} app_version
 * @property {string} [device_id]
 */

/**
 * @typedef {Object} AudioChunkMeta
 * @property {"audio_chunk"} type
 * @property {number} seq
 * @property {AudioSource} source
 * @property {AudioCodec} codec
 * @property {AudioSampleRateHz} sample_rate_hz
 * @property {AudioChannels} channels
 * @property {number} duration_ms
 * @property {number} started_at_ms
 */

/**
 * @typedef {Object} AudioEnd
 * @property {"audio_end"} type
 * @property {AudioEndReason} [reason]
 */

/**
 * @typedef {Object} AudioPartialTranscript
 * @property {string} callId
 * @property {AudioSource} source
 * @property {"agent" | "customer"} who
 * @property {string} text
 * @property {number} atMs
 * @property {number} serverSentAt
 */

/**
 * Runtime error codes emitted via `socket.on("error", payload)`.
 * Kept here as a JSDoc-only union so client handlers can branch on it.
 *
 * @typedef {(
 *   "no_active_call" |
 *   "no_active_audio" |
 *   "audio_already_started" |
 *   "BAD_PAYLOAD" |
 *   "AUDIO_CHUNK_TOO_LARGE" |
 *   "AUDIO_BACKPRESSURE" |
 *   "AUDIO_SEQ_OUT_OF_ORDER" |
 *   "call_not_found" |
 *   "persistence_failed"
 * )} AudioRuntimeErrorCode
 */

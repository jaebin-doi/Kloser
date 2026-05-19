/* WS audio shared types — Phase 9 Step 2.
 *
 * Server source-of-truth: server/src/types/wsAudio.ts.
 * Browser JSDoc mirror:   platform/types/wsAudio.js.
 *
 * Sync target schemas (top-level `export const X = z.object({ ... })`):
 *   - AudioStart
 *   - AudioChunkMeta
 *   - AudioEnd
 *   - AudioPartialTranscript
 *
 * Plan reference: docs/plan/phase-9/PHASE_9_STEP_2_PLAN.md §3.2 / §5 / §7.
 *
 * The wire contract for `audio_chunk` is `socket.emit("audio_chunk", meta, pcm)`:
 * `AudioChunkMeta` describes the meta object only. The PCM Buffer is the
 * second positional argument and is intentionally NOT part of any schema —
 * it must never be stringified, persisted, or logged.
 */
import { z } from "zod";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const AudioSource = z.enum(["agent_mic", "system_loopback"]);
export type AudioSource = z.infer<typeof AudioSource>;

export const AudioCodec = z.literal("pcm_s16le");
export type AudioCodec = z.infer<typeof AudioCodec>;

export const AudioSampleRateHz = z.literal(16000);
export type AudioSampleRateHz = z.infer<typeof AudioSampleRateHz>;

export const AudioChannels = z.literal(1);
export type AudioChannels = z.infer<typeof AudioChannels>;

// Allowed declared frame sizes. Per chunk duration_ms is a separate range
// (1..500ms) so jitter is tolerated regardless of declared frame.
export const AudioFrameMs = z.union([
  z.literal(20),
  z.literal(40),
  z.literal(60),
  z.literal(80),
  z.literal(100),
]);
export type AudioFrameMs = z.infer<typeof AudioFrameMs>;

export const AudioEndReason = z.enum([
  "normal",
  "pause",
  "device_lost",
  "network_reconnect",
]);
export type AudioEndReason = z.infer<typeof AudioEndReason>;

// ---------------------------------------------------------------------------
// Client -> Server: audio_start
// ---------------------------------------------------------------------------
export const AudioStart = z.object({
  type: z.literal("audio_start"),
  call_id: z.string().regex(UUID_RE).optional(),
  sources: z.array(AudioSource).min(1).max(2),
  codec: AudioCodec,
  sample_rate_hz: AudioSampleRateHz,
  channels: AudioChannels,
  frame_ms: AudioFrameMs,
  app_version: z.string().min(1).max(128),
  device_id: z.string().min(1).max(256).optional(),
});
export type AudioStart = z.infer<typeof AudioStart>;

// ---------------------------------------------------------------------------
// Client -> Server: audio_chunk meta (binary buffer is the second arg)
// ---------------------------------------------------------------------------
export const AudioChunkMeta = z.object({
  type: z.literal("audio_chunk"),
  seq: z.number().int().positive(),
  source: AudioSource,
  codec: AudioCodec,
  sample_rate_hz: AudioSampleRateHz,
  channels: AudioChannels,
  duration_ms: z.number().int().min(1).max(500),
  started_at_ms: z.number().int().nonnegative(),
});
export type AudioChunkMeta = z.infer<typeof AudioChunkMeta>;

// ---------------------------------------------------------------------------
// Client -> Server: audio_end
// ---------------------------------------------------------------------------
export const AudioEnd = z.object({
  type: z.literal("audio_end"),
  reason: AudioEndReason.optional(),
});
export type AudioEnd = z.infer<typeof AudioEnd>;

// ---------------------------------------------------------------------------
// Server -> Client: transcript.partial emit payload (Plan §7)
//
// Final transcripts use the existing `"transcript"` event surface; this
// schema covers only the partial channel, which never persists.
// ---------------------------------------------------------------------------
export const AudioPartialTranscript = z.object({
  callId: z.string().regex(UUID_RE),
  source: AudioSource,
  who: z.enum(["agent", "customer"]),
  text: z.string().min(1).max(10_000),
  atMs: z.number().int().nonnegative(),
  serverSentAt: z.number().int().nonnegative(),
});
export type AudioPartialTranscript = z.infer<typeof AudioPartialTranscript>;

// ---------------------------------------------------------------------------
// Runtime error codes emitted via `socket.emit("error", { code, message })`.
// Centralised here so the WS handler and tests share one vocabulary. Not a
// sync target (no field set) — kept as a type literal union.
// ---------------------------------------------------------------------------
export type AudioRuntimeErrorCode =
  | "no_active_call"
  | "no_active_audio"
  | "audio_already_started"
  | "BAD_PAYLOAD"
  | "AUDIO_CHUNK_TOO_LARGE"
  | "AUDIO_BACKPRESSURE"
  | "AUDIO_SEQ_OUT_OF_ORDER"
  | "call_not_found"
  | "persistence_failed";

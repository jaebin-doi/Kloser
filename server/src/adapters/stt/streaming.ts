/* STT streaming adapter interface — Phase 9 Step 2.
 *
 * Plan: docs/plan/phase-9/PHASE_9_STEP_2_PLAN.md §7 / §10.
 *
 * The existing one-shot `STTAdapter.transcribeChunk` (./index.ts) covers
 * Phase 5/6 batch fixtures and one-utterance Clova calls. WS-driven
 * audio ingest is a different shape: many small frames arrive per
 * source, the session emits live partial events, and the final utterance
 * is only known at `audio_end` / `end_call` flush.
 *
 * This module defines the streaming surface only. The Step 2 mock
 * implementation lives in `./mockStreaming.ts`. Azure live streaming
 * will replace the mock in a later step behind the same interface, so
 * `ws/calls.ts` does not have to change to swap providers.
 *
 * Guarantees the implementation must keep:
 *   - PCM Buffers are processed in memory. They must not be stringified,
 *     persisted in DB or logs, attached to error messages, or returned
 *     to callers as fields.
 *   - The session is per-source (`agent_mic` / `system_loopback`); a
 *     single audio_start that declares both sources opens two sessions.
 *   - `flush()` is idempotent at the caller level — see Plan §5.9. The
 *     adapter does not have to track its own idempotency, but it must
 *     remain safe if called once.
 */
import type { ProviderUsage } from "../usage.js";
import type { AudioSource } from "../../types/wsAudio.js";

export type SttStreamingSpeaker = "agent" | "customer";

export interface SttStreamingSessionInit {
  /** Authenticated org id from the socket handshake. RLS authority. */
  orgId: string;
  /** Active call id from socket-local CallContext. */
  callId: string;
  source: AudioSource;
  who: SttStreamingSpeaker;
  /** Declared frame size from audio_start. Adapter may ignore. */
  frameMs: number;
  sampleRateHz: number;
  channels: number;
  /** ms since the audio_start handler bound the session. */
  startedAtMs: number;
}

export interface SttStreamingPartial {
  /** Live transcript text. Never persisted; emit-only via socket. */
  text: string;
  /** ms since `startedAtMs`. */
  atMs: number;
}

export interface SttStreamingFinal {
  /** Final utterance text. The caller persists this via
   *  `callsService.appendTranscript`. */
  text: string;
}

export interface SttStreamingFlushResult {
  /** Null when no valid chunks were accepted. */
  final: SttStreamingFinal | null;
  /** Number of partial events emitted during the session. */
  partialCount: number;
  /** Number of final utterances produced (0 or 1 in v1). */
  finalCount: number;
  /** Aggregate `duration_ms` summed across accepted chunks. */
  audioDurationMsSent: number;
}

export interface SttStreamingSession {
  readonly init: SttStreamingSessionInit;

  /** Accept one frame. Returns a partial event when the implementation
   *  wants the caller to emit it; null otherwise. Implementations MUST
   *  NOT retain references to `buffer` past return; the caller owns its
   *  lifetime. */
  acceptChunk(
    buffer: Buffer,
    meta: { seq: number; durationMs: number },
  ): SttStreamingPartial | null;

  /** Close the session and return the flush result + a usage envelope
   *  the caller hands to `services/llmUsage.recordProviderUsage`. The
   *  envelope's `costUsdMicros` is null in Step 2 (mock); Phase 7 Step 5
   *  pricing decision applies — STT cost is audio-duration based, not
   *  token based, and the Azure adapter will fill it later. */
  flush(): { result: SttStreamingFlushResult; usage: ProviderUsage };
}

export interface SttStreamingProvider {
  readonly name: "mock" | "azure";
  createSession(init: SttStreamingSessionInit): SttStreamingSession;
}

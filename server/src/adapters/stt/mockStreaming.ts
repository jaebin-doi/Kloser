/* Mock streaming STT — Phase 9 Step 2.
 *
 * Plan: docs/plan/phase-9/PHASE_9_STEP_2_PLAN.md §7.
 *
 * Deterministic per-source mock so tests can pin exact final transcript
 * text. The session does not parse the PCM Buffer; it only inspects
 * length to drive the partial-emit heuristic and accumulates duration
 * counters for the usage row.
 *
 * Determinism contract (Plan §7):
 *   - First accepted chunk -> one partial event with deterministic text.
 *   - Subsequent chunks -> no partial event (silence on the wire).
 *   - flush() with at least one accepted chunk -> one final utterance,
 *     deterministic per source.
 *   - flush() with zero chunks -> final=null and finalCount=0; the
 *     caller skips `appendTranscript` but still records a usage row
 *     (Plan §8 — usage rows are not optional per flush).
 *
 * Buffer handling: we read `buffer.length` to add to the duration accounting
 * envelope and otherwise drop the reference. We never JSON.stringify the
 * buffer, never push it into any array, and never include it in usage.
 */
import type {
  SttStreamingFlushResult,
  SttStreamingPartial,
  SttStreamingProvider,
  SttStreamingSession,
  SttStreamingSessionInit,
} from "./streaming.js";
import type { ProviderUsage } from "../usage.js";

const MODEL = "mock-streaming-stt-v1";

function finalTextForSource(
  source: SttStreamingSessionInit["source"],
): string {
  // Deterministic per Plan §7. Tests assert these exact strings.
  return source === "agent_mic"
    ? "Mock agent audio transcript"
    : "Mock customer audio transcript";
}

function partialTextForSource(
  source: SttStreamingSessionInit["source"],
): string {
  return source === "agent_mic"
    ? "Mock agent partial"
    : "Mock customer partial";
}

class MockSttStreamingSession implements SttStreamingSession {
  readonly init: SttStreamingSessionInit;
  private chunkCount = 0;
  private partialCount = 0;
  private audioDurationMsSent = 0;
  private flushed = false;

  constructor(init: SttStreamingSessionInit) {
    this.init = init;
  }

  acceptChunk(
    buffer: Buffer,
    meta: { seq: number; durationMs: number },
  ): SttStreamingPartial | null {
    // Defensive: drop the reference immediately. The handler validated
    // the buffer; we only need its size for the usage envelope.
    void buffer;
    void meta.seq;
    this.audioDurationMsSent += meta.durationMs;
    this.chunkCount += 1;
    if (this.chunkCount === 1) {
      this.partialCount += 1;
      return {
        text: partialTextForSource(this.init.source),
        atMs: 0,
      };
    }
    return null;
  }

  flush(): { result: SttStreamingFlushResult; usage: ProviderUsage } {
    // Idempotency: if the caller flushes twice, return a zeroed usage
    // envelope on the second call so a stray `end_call` after a clean
    // `audio_end` cannot double-write. The session-level idempotency
    // flag in ws/calls.ts is the primary guard (Plan §5.9); this is
    // defense in depth.
    if (this.flushed) {
      return {
        result: {
          final: null,
          partialCount: 0,
          finalCount: 0,
          audioDurationMsSent: 0,
        },
        usage: this.usageEnvelope(0, 0, 0),
      };
    }
    this.flushed = true;
    const hadChunks = this.chunkCount > 0;
    const finalCount = hadChunks ? 1 : 0;
    const final = hadChunks
      ? { text: finalTextForSource(this.init.source) }
      : null;
    return {
      result: {
        final,
        partialCount: this.partialCount,
        finalCount,
        audioDurationMsSent: this.audioDurationMsSent,
      },
      usage: this.usageEnvelope(
        this.audioDurationMsSent,
        this.partialCount,
        finalCount,
      ),
    };
  }

  private usageEnvelope(
    audioDurationMsSent: number,
    partialCount: number,
    finalCount: number,
  ): ProviderUsage {
    return {
      provider: "mock",
      operation: "stt_transcribe",
      model: MODEL,
      status: "succeeded",
      tokensIn: null,
      tokensOut: null,
      latencyMs: null,
      costUsdMicros: null,
      metadata: {
        source: "ws:audio",
        ws_source: this.init.source,
        audio_duration_ms_sent: audioDurationMsSent,
        audio_duration_ms_suppressed_by_vad: 0,
        partial_count: partialCount,
        final_count: finalCount,
        cost_status: "mock",
      },
    };
  }
}

export class MockSttStreamingProvider implements SttStreamingProvider {
  readonly name = "mock" as const;
  createSession(init: SttStreamingSessionInit): SttStreamingSession {
    return new MockSttStreamingSession(init);
  }
}

let cachedDefault: SttStreamingProvider | null = null;

/** Default provider for Step 2. Phase 9 Step 4/5 will route Azure here. */
export function resolveSttStreamingProvider(): SttStreamingProvider {
  if (!cachedDefault) cachedDefault = new MockSttStreamingProvider();
  return cachedDefault;
}

/** Test seam — restore default resolver after a test override. */
export function __resetSttStreamingProviderForTest(): void {
  cachedDefault = null;
}

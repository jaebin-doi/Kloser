/* /calls Socket.io namespace.
 *
 * Phase 0.5 spike pumped the demo conversation via setTimeout. Phase 1
 * step 4 attaches an authenticated identity to every connection by
 * verifying a Bearer-equivalent JWT on the handshake. Phase 4 step 3
 * adds DB persistence: start_call inserts a calls row, text_chunk
 * appends a transcripts row, end_call updates the call + bumps
 * customers.last_contacted_at — all through the Step 2 service so the
 * REST and WS surfaces share one source of truth.
 *
 * Error contract (kept stable so the client can branch on `err.data.code`
 * for handshake and emit `.code` for runtime):
 *   handshake `connect_error`:
 *     - "missing_token"  — auth.token absent or empty
 *     - "expired_token"  — JWT exp passed
 *     - "invalid_token"  — bad signature, malformed payload, etc.
 *   runtime `error` event:
 *     - "no_active_call"      — text_chunk arrived before start_call
 *     - "BAD_PAYLOAD"         — text_chunk shape mismatch
 *     - "call_not_found"      — persistence target call vanished
 *                                (soft-deleted between start and chunk)
 *     - "persistence_failed"  — DB write threw mid-handler
 *   ack payloads:
 *     - start_call ack: { callId } on success, { error, code } on persistence failure
 *     - end_call   ack: { ok: true } on success, { ok: false, error } when there was no active call
 */
import type { FastifyInstance } from "fastify";
import type { Server, Socket } from "socket.io";
import { conversation, aiSequence } from "../fixtures/demo-call.js";
import {
  toAuthenticatedUser,
  validateAccessTokenPayload,
  type AuthenticatedUser,
} from "../services/auth.js";
import * as callsService from "../services/calls.js";
import * as callHeartbeatService from "../services/callHeartbeat.js";
import * as callSuggestionsService from "../services/callSuggestions.js";
import * as llmUsageService from "../services/llmUsage.js";
import { resolveLlmAdapter } from "../adapters/index.js";
import {
  AudioStart as AudioStartSchema,
  AudioChunkMeta as AudioChunkMetaSchema,
  AudioEnd as AudioEndSchema,
  type AudioSource,
} from "../types/wsAudio.js";
import { resolveSttStreamingProvider } from "../adapters/stt/mockStreaming.js";
import type { SttStreamingSession } from "../adapters/stt/streaming.js";
import type { ProviderUsage } from "../adapters/usage.js";

// Phase 6 Step 1 — env-gated knobs. Imported as constants at module
// load. Tests that need shorter intervals override the env *before*
// requiring this module.
const SUGGESTION_INTERVAL_MS = (() => {
  const raw = process.env.KLOSER_SUGGESTION_INTERVAL_MS;
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 30000;
})();

// Demo replay gate (Phase 6 Step 1 / Codex implementation plan §2.6).
//   "1" / "true"  → on
//   "0" / "false" → off
//   unset         → production=off, dev/test=on
// Re-read at scheduleDemoReplay() call time so tests can toggle the env
// per case without re-importing this module.
function shouldDemoReplay(): boolean {
  const raw = process.env.KLOSER_DEMO_REPLAY;
  if (raw !== undefined) {
    const norm = raw.trim().toLowerCase();
    if (norm === "1" || norm === "true") return true;
    if (norm === "0" || norm === "false") return false;
  }
  return process.env.NODE_ENV !== "production";
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Phase 9 Step 2 — audio ingest limits. Plan §4.
//   AUDIO_CHUNK_MAX_BYTES   : single audio_chunk binary payload cap.
//   AUDIO_QUEUE_MAX_BYTES   : rolling queued-byte cap per active audio
//                             session; exceeded -> AUDIO_BACKPRESSURE.
//   AUDIO_QUEUE_DRAIN_MS    : after this long without a chunk, the queue
//                             accounting decays back to zero. Mock STT
//                             does no async processing, so frames are
//                             effectively drained immediately, but the
//                             decay keeps the accounting honest if the
//                             real Azure adapter introduces latency.
const AUDIO_CHUNK_MAX_BYTES = 128 * 1024;
const AUDIO_QUEUE_MAX_BYTES = 1024 * 1024;
const AUDIO_QUEUE_DRAIN_MS = 1000;

interface StartCallPayload {
  customerId?: string;
}
interface TextChunkPayload {
  seq: number;
  text: string;
  clientSentAt: number;
}

// Phase 9 Step 2 — per-source streaming STT session state inside a single
// audio ingest "session" (one audio_start ... audio_end span). A single
// audio_start that declares both `agent_mic` and `system_loopback` opens
// two adapter sessions but counts as one flush event.
interface AudioSessionState {
  sources: AudioSource[];
  sessions: Map<AudioSource, SttStreamingSession>;
  startedAt: number;
  // Rolling queue accounting. Adds bytes per accepted chunk, decays back
  // to zero after AUDIO_QUEUE_DRAIN_MS of inactivity (since mock STT
  // processes synchronously; the real Azure adapter will replace this).
  queuedBytes: number;
  queueLastUpdatedAt: number;
  lastSeqBySource: Map<AudioSource, number>;
  flushed: boolean;
}

interface CallContext {
  callId: string;
  startedAt: number;
  timers: NodeJS.Timeout[];
  // Phase 6 Step 1 — suggestion timer state.
  //   suggestionTimer    : pending one-shot setTimeout id (null when idle)
  //   suggestionGroupSeq : next group_seq for persistSuggestionGroup
  //   transcriptWindow   : rolling array of recently-seen text_chunk text
  suggestionTimer: NodeJS.Timeout | null;
  suggestionGroupSeq: number;
  transcriptWindow: string[];
  // Phase 9 Step 2 — null until audio_start, reset to null on flush.
  audio: AudioSessionState | null;
}

function sourceToSpeaker(source: AudioSource): "agent" | "customer" {
  return source === "agent_mic" ? "agent" : "customer";
}

// One in-flight call per socket. Presence in this map IS the
// `callStarted` invariant — text_chunk requires a hit here.
const calls = new WeakMap<Socket, CallContext>();

function clearCall(socket: Socket): void {
  const ctx = calls.get(socket);
  if (!ctx) return;
  for (const t of ctx.timers) clearTimeout(t);
  ctx.timers.length = 0;
  if (ctx.suggestionTimer) {
    clearTimeout(ctx.suggestionTimer);
    ctx.suggestionTimer = null;
  }
  // Drop audio session state. Final transcript / usage row must already
  // have been written by audio_end or end_call before clearCall runs;
  // this block exists for hard-reset paths (start_call after a stale
  // session, disconnect mid-stream) where we just want to discard the
  // in-memory adapter state without further DB writes.
  if (ctx.audio) {
    ctx.audio.sessions.clear();
    ctx.audio = null;
  }
  calls.delete(socket);
}

class HandshakeAuthError extends Error {
  // socket.io-client surfaces this on `connect_error` as `err.data`.
  data: { code: string };
  constructor(code: string) {
    super(code);
    this.name = "HandshakeAuthError";
    this.data = { code };
  }
}

function scheduleDemoReplay(socket: Socket, ctx: CallContext): void {
  // transcript pushes — server-driven, no clientSentAt (latency badge guards it)
  for (let i = 0; i < conversation.length; i++) {
    const line = conversation[i];
    if (!line) continue;
    const seq = i + 1;
    ctx.timers.push(
      setTimeout(() => {
        socket.emit("transcript", {
          seq,
          who: line.who,
          text: line.text,
          serverSentAt: Date.now(),
        });
      }, line.delay),
    );
  }

  // suggestion + (optional) sentiment pushes
  for (const group of aiSequence) {
    ctx.timers.push(
      setTimeout(() => {
        socket.emit("suggestion", {
          at: group.at,
          suggestions: group.suggestions,
        });
        if (group.sentiment) {
          socket.emit("sentiment", group.sentiment);
        }
      }, group.at),
    );
  }
}

export function registerCallsNamespace(io: Server, app: FastifyInstance): void {
  const ns = io.of("/calls");

  // Phase 6 Step 1 — suggestion timer handler. Reads the current
  // transcript window from the socket's CallContext, asks the mock
  // LLM (Phase 5 adapter resolver returns a deterministic stub) for
  // a suggestion group, persists the result via the service, and
  // emits the persisted rows (with id) back over WS.
  //
  // Failure modes are all silent-success: the call may have ended,
  // soft-deleted, vanished cross-org, or the LLM may return 0 items.
  // None of those should kill the live socket. Persistence errors
  // are logged + the timer is rearmed for the next window.
  const llm = resolveLlmAdapter();
  // Phase 9 Step 2 — mock streaming STT provider. The adapter boundary
  // is intentionally narrow (Plan §10) so Step 4/5 can swap in Azure
  // streaming behind the same `createSession` shape without touching
  // this file.
  const sttStreaming = resolveSttStreamingProvider();

  // Aggregate flush coordinator. Used by both `audio_end` and `end_call`
  // (Plan §5.5). Idempotent at the ctx-level via `audio.flushed`.
  //   1. mark flushed=true (so a follow-up end_call cannot double-write)
  //   2. flush each per-source mock session, aggregate counters
  //   3. persist final transcript per source that emitted one
  //   4. record ONE aggregate llm_usage_log row (Plan §8)
  //   5. drop ctx.audio
  //
  // Returns ok=true on persistence success or "no audio active" no-op.
  // Returns ok=false + error="persistence_failed" if any transcript
  // append throws. The usage row is still attempted in the failure path
  // so the cost-accounting trail does not silently disappear (Plan §8
  // "do not leave usage metadata as a dead path").
  async function flushAudioSession(
    socket: Socket,
    ctx: CallContext,
    user: AuthenticatedUser,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const audio = ctx.audio;
    if (!audio || audio.flushed) return { ok: true };
    audio.flushed = true;

    let totalDurationMs = 0;
    let totalPartials = 0;
    let totalFinals = 0;
    let persistError: Error | null = null;
    let callNotFound = false;

    for (const [source, session] of audio.sessions) {
      const { result } = session.flush();
      totalDurationMs += result.audioDurationMsSent;
      totalPartials += result.partialCount;
      totalFinals += result.finalCount;
      if (!result.final) continue;
      try {
        const persisted = await callsService.appendTranscript(
          app,
          user.orgId,
          ctx.callId,
          {
            speaker: sourceToSpeaker(source),
            text: result.final.text,
          },
        );
        if (!persisted) {
          // Call vanished mid-stream (soft-deleted cross-org). Keep
          // aggregating so usage is still recorded, but surface the same
          // runtime error vocabulary as text_chunk after the flush.
          callNotFound = true;
          socket.data.log("audio flush call_not_found", {
            callId: ctx.callId,
            source,
          });
        }
      } catch (err) {
        persistError = err as Error;
        socket.data.log("audio flush persistence_failed", {
          err: persistError.message,
          callId: ctx.callId,
          source,
        });
      }
    }

    // Plan §8 — one aggregate usage row per flush. The mock counters
    // are summed across per-source sessions. `recordProviderUsage`
    // swallows its own errors, so a logging failure cannot mask a
    // transcript failure that we still want to surface to the caller.
    const usage: ProviderUsage = {
      provider: "mock",
      operation: "stt_transcribe",
      model: "mock-streaming-stt-v1",
      status: "succeeded",
      tokensIn: null,
      tokensOut: null,
      latencyMs: null,
      costUsdMicros: null,
    };
    await llmUsageService.recordProviderUsage(
      app,
      user.orgId,
      ctx.callId,
      usage,
      {
        metadata: {
          source: "ws:audio",
          audio_duration_ms_sent: totalDurationMs,
          audio_duration_ms_suppressed_by_vad: 0,
          partial_count: totalPartials,
          final_count: totalFinals,
          cost_status: "mock",
        },
      },
    );

    audio.sessions.clear();
    ctx.audio = null;

    if (callNotFound) return { ok: false, error: "call_not_found" };
    if (persistError) return { ok: false, error: "persistence_failed" };
    return { ok: true };
  }

  async function fireSuggestion(socket: Socket): Promise<void> {
    const ctx = calls.get(socket);
    if (!ctx) return;
    // Always clear the timer slot first so a long LLM call cannot
    // block subsequent text_chunk-driven re-arms.
    ctx.suggestionTimer = null;
    const user = socket.data.user as AuthenticatedUser | undefined;
    if (!user) return;
    const transcriptJoined = ctx.transcriptWindow.join("\n");
    if (!transcriptJoined) return;
    const atMs = Math.max(0, Date.now() - ctx.startedAt);
    const groupSeq = ctx.suggestionGroupSeq;
    try {
      // Phase 6 Step 2: adapter returns ProviderResult. Unwrap the
      // domain value for suggestion persistence and hand the usage
      // envelope to services/llmUsage. The logging service swallows
      // its own failures so suggestion emit / DB writes proceed
      // regardless. The order here matters: log the cost as soon as
      // the provider call returns (even if downstream emit drops the
      // group) so we never under-count what the provider charged us.
      const result = await llm.suggestForUtterance({
        transcript: transcriptJoined,
        groupSeq,
        atMs,
      });
      if (result.usage) {
        await llmUsageService.recordProviderUsage(
          app,
          user.orgId,
          ctx.callId,
          result.usage,
          {
            metadata: {
              source: "ws:suggestion",
              group_seq: groupSeq,
              at_ms: atMs,
            },
          },
        );
      }
      const generated = result.value;
      if (!generated || generated.length === 0) return;
      const persisted = await callSuggestionsService.persistSuggestionGroup(
        app,
        user.orgId,
        ctx.callId,
        generated,
      );
      if (!persisted || persisted.length === 0) return;
      ctx.suggestionGroupSeq = groupSeq + 1;
      socket.emit("suggestion", {
        at: atMs,
        suggestions: persisted.map((s) => ({
          id: s.id,
          group_seq: s.group_seq,
          at_ms: s.at_ms,
          tone: s.tone,
          type: s.type,
          title: s.title,
          body: s.body,
        })),
      });
    } catch (err) {
      socket.data.log("suggestion persistence_failed", {
        err: (err as Error)?.message,
        callId: ctx.callId,
      });
    }
  }

  // Handshake auth — runs before any `connection` event. Failures pass
  // a HandshakeAuthError to next(), which socket.io serialises onto the
  // client's `connect_error` event with the embedded `data.code`.
  ns.use(async (socket, next) => {
    const raw = socket.handshake.auth?.token;
    const token = typeof raw === "string" ? raw.trim() : "";
    if (!token) {
      next(new HandshakeAuthError("missing_token"));
      return;
    }
    try {
      const decoded = await app.jwt.verify(token);
      const payload = validateAccessTokenPayload(decoded);
      socket.data.user = toAuthenticatedUser(payload);
      next();
    } catch (err) {
      const e = err as { code?: string; name?: string };
      if (e?.code === "FAST_JWT_EXPIRED" || e?.name === "TokenExpiredError") {
        next(new HandshakeAuthError("expired_token"));
      } else {
        next(new HandshakeAuthError("invalid_token"));
      }
    }
  });

  ns.on("connection", (socket) => {
    const user = socket.data.user as AuthenticatedUser;
    socket.data.log = (msg: string, extra?: unknown) => {
      const tag = `[ws/calls socket=${socket.id} user=${user.id} org=${user.orgId}]`;
      if (extra !== undefined) console.log(tag, msg, extra);
      else console.log(tag, msg);
    };
    socket.data.log("connection");

    socket.on("start_call", async (payload: StartCallPayload | undefined, ack?: (resp: unknown) => void) => {
      // Clear any prior call on the same socket (reconnect / repeat start_call).
      clearCall(socket);

      // Validate customerId before sending it to the service. The
      // composite FK would reject a non-UUID anyway, but checking here
      // lets us produce a clean validation error for the typical
      // client mistake without making the round-trip first.
      const rawCustomerId = payload?.customerId;
      const customerId =
        typeof rawCustomerId === "string" && UUID_RE.test(rawCustomerId)
          ? rawCustomerId
          : null;

      try {
        const call = await callsService.createCall(app, user.orgId, user.id, {
          customer_id: customerId,
          agent_user_id: user.id,
          direction: "inbound",
        });
        const ctx: CallContext = {
          callId: call.id,
          startedAt: Date.now(),
          timers: [],
          suggestionTimer: null,
          suggestionGroupSeq: 0,
          transcriptWindow: [],
          audio: null,
        };
        calls.set(socket, ctx);
        socket.data.log("start_call", { callId: call.id, customerId });

        // Phase 6 Step 1 — demo replay only when explicitly enabled
        // (default on in dev/test, off in production). Existing Phase
        // 0.5/4/5 e2e depend on the fixture so dev default stays on.
        if (shouldDemoReplay()) {
          scheduleDemoReplay(socket, ctx);
        }
        if (typeof ack === "function") ack({ callId: call.id });
      } catch (err) {
        // Phase 7 Step 9 — monthly_calls cap rejection. createCall throws
        // PlanLimitExceededError; surface a structured ack so the frontend
        // can show a banner instead of treating the failure as a generic
        // persistence error.
        if (
          err && typeof err === "object" &&
          (err as { code?: string }).code === "plan_limit_exceeded"
        ) {
          const limitErr = err as {
            limitKey?: string;
            plan?: string;
            current?: number;
            limit?: number;
            attempted?: number;
          };
          socket.data.log("start_call plan_limit_exceeded", {
            limitKey: limitErr.limitKey,
            plan: limitErr.plan,
          });
          if (typeof ack === "function") {
            ack({
              error: "plan_limit_exceeded",
              code: "plan_limit_exceeded",
              limit_key: limitErr.limitKey,
              plan: limitErr.plan,
              current: limitErr.current,
              limit: limitErr.limit,
              attempted: limitErr.attempted,
            });
          }
          return;
        }
        socket.data.log("start_call persistence_failed", {
          err: (err as Error)?.message,
        });
        if (typeof ack === "function") {
          ack({ error: "persistence_failed", code: "persistence_failed" });
        }
      }
    });

    socket.on("text_chunk", async (payload: TextChunkPayload | undefined) => {
      // Invariant: a text_chunk only makes sense inside an active call.
      const ctx = calls.get(socket);
      if (!ctx) {
        socket.emit("error", {
          code: "no_active_call",
          message: "text_chunk requires a prior start_call",
        });
        return;
      }
      if (
        !payload ||
        typeof payload.seq !== "number" ||
        typeof payload.text !== "string" ||
        typeof payload.clientSentAt !== "number"
      ) {
        socket.emit("error", {
          code: "BAD_PAYLOAD",
          message: "text_chunk requires { seq:number, text:string, clientSentAt:number }",
        });
        return;
      }
      const who: "agent" | "customer" = payload.seq % 2 === 0 ? "agent" : "customer";

      // Persist first, then echo. If the call vanished (soft-deleted
      // mid-stream), the repository returns null and we surface
      // call_not_found instead of pretending the chunk landed.
      try {
        const persisted = await callsService.appendTranscript(
          app,
          user.orgId,
          ctx.callId,
          { speaker: who, text: payload.text },
        );
        if (!persisted) {
          socket.emit("error", {
            code: "call_not_found",
            message: "call no longer available for transcript append",
          });
          return;
        }
      } catch (err) {
        socket.data.log("text_chunk persistence_failed", {
          err: (err as Error)?.message,
          callId: ctx.callId,
        });
        socket.emit("error", {
          code: "persistence_failed",
          message: "transcript persistence failed",
        });
        return;
      }

      // Echo keeps the Phase 0.5 contract: `seq` mirrors the client's
      // own counter, not the DB-side per-call seq. Clients that need
      // the persisted seq can GET /calls/:id/transcript.
      socket.emit("transcript", {
        seq: payload.seq,
        who,
        text: payload.text,
        clientSentAt: payload.clientSentAt,
        serverSentAt: Date.now(),
      });

      // Phase 6 Step 1 — accumulate transcript window + schedule a
      // suggestion generation on a debounce timer. Real LLM streaming
      // belongs to Phase 7+; here we coalesce N text_chunks into a
      // single LLM call every KLOSER_SUGGESTION_INTERVAL_MS.
      ctx.transcriptWindow.push(payload.text);
      // Keep the window bounded so a long call doesn't grow forever.
      if (ctx.transcriptWindow.length > 50) {
        ctx.transcriptWindow.splice(0, ctx.transcriptWindow.length - 50);
      }
      if (!ctx.suggestionTimer) {
        ctx.suggestionTimer = setTimeout(
          () => { void fireSuggestion(socket); },
          SUGGESTION_INTERVAL_MS,
        );
      }
    });

    socket.on("end_call", async (_payload: unknown, ack?: (resp: unknown) => void) => {
      const ctx = calls.get(socket);
      if (!ctx) {
        socket.data.log("end_call no_active_call");
        if (typeof ack === "function") {
          ack({ ok: false, error: "no_active_call" });
        }
        return;
      }
      socket.data.log("end_call", { callId: ctx.callId });

      // Phase 9 Step 2 — flush any open audio session before tearing the
      // call down (Plan §5.5). If the audio flush fails, surface that as
      // the error and still clear local state so the socket is not
      // stuck thinking a call is active.
      if (ctx.audio) {
        const flush = await flushAudioSession(socket, ctx, user);
        if (!flush.ok) {
          clearCall(socket);
          if (typeof ack === "function") {
            ack({ ok: false, error: flush.error });
          }
          return;
        }
      }

      try {
        await callsService.endCall(app, user.orgId, user.id, ctx.callId);
      } catch (err) {
        socket.data.log("end_call persistence_failed", {
          err: (err as Error)?.message,
          callId: ctx.callId,
        });
        // Even on persistence failure, clear local state so the socket
        // is not stuck thinking a call is active.
        clearCall(socket);
        if (typeof ack === "function") {
          ack({ ok: false, error: "persistence_failed" });
        }
        return;
      }
      clearCall(socket);
      if (typeof ack === "function") ack({ ok: true });
    });

    // -------------------------------------------------------------- //
    // Phase 9 Step 2 — audio ingest handlers (Plan §3 / §5).
    //
    // Wire shape:
    //   socket.emit("audio_start", { sources, codec, ... })
    //   socket.emit("audio_chunk", meta, pcmBuffer)
    //   socket.emit("audio_end",   { reason? })
    //
    // Runtime error contract via `socket.emit("error", { code, message })`:
    //   no_active_call         — audio_* arrived before start_call
    //   no_active_audio        — audio_chunk arrived before audio_start
    //   audio_already_started  — duplicate audio_start
    //   BAD_PAYLOAD            — zod validation / source membership fail
    //   AUDIO_CHUNK_TOO_LARGE  — single chunk > 128 KiB
    //   AUDIO_BACKPRESSURE     — rolling queue > 1 MiB
    //   AUDIO_SEQ_OUT_OF_ORDER — duplicate/decreasing per-source seq
    //
    // Raw PCM Buffer is consumed by the streaming adapter in memory and
    // is never persisted, logged, audited, or stringified. The session
    // accounting tracks size+duration only.
    // -------------------------------------------------------------- //

    socket.on("audio_start", (payload: unknown) => {
      const ctx = calls.get(socket);
      if (!ctx) {
        socket.emit("error", {
          code: "no_active_call",
          message: "audio_start requires a prior start_call",
        });
        return;
      }
      if (ctx.audio) {
        socket.emit("error", {
          code: "audio_already_started",
          message: "audio_start already received for this call",
        });
        return;
      }
      const parsed = AudioStartSchema.safeParse(payload);
      if (!parsed.success) {
        socket.emit("error", {
          code: "BAD_PAYLOAD",
          message: "audio_start payload failed validation",
        });
        return;
      }
      const start = parsed.data;
      // De-duplicate the declared sources just in case the client
      // double-listed agent_mic. Set-based membership still works.
      const declared = Array.from(new Set(start.sources)) as AudioSource[];
      const startedAt = Date.now();
      const sessions = new Map<AudioSource, SttStreamingSession>();
      for (const src of declared) {
        const session = sttStreaming.createSession({
          orgId: user.orgId,
          callId: ctx.callId,
          source: src,
          who: sourceToSpeaker(src),
          frameMs: start.frame_ms,
          sampleRateHz: start.sample_rate_hz,
          channels: start.channels,
          startedAtMs: startedAt,
        });
        sessions.set(src, session);
      }
      ctx.audio = {
        sources: declared,
        sessions,
        startedAt,
        queuedBytes: 0,
        queueLastUpdatedAt: startedAt,
        lastSeqBySource: new Map(),
        flushed: false,
      };
      socket.data.log("audio_start", {
        callId: ctx.callId,
        sources: declared,
        frame_ms: start.frame_ms,
      });
    });

    socket.on("audio_chunk", (meta: unknown, buffer: unknown) => {
      const ctx = calls.get(socket);
      if (!ctx) {
        socket.emit("error", {
          code: "no_active_call",
          message: "audio_chunk requires a prior start_call",
        });
        return;
      }
      if (!ctx.audio) {
        socket.emit("error", {
          code: "no_active_audio",
          message: "audio_chunk requires a prior audio_start",
        });
        return;
      }
      const audio = ctx.audio;

      // Buffer arrives as Node Buffer (socket.io binary attachment).
      // ArrayBuffer is also accepted by being wrapped. Anything else is
      // a client framing bug.
      let pcm: Buffer;
      if (Buffer.isBuffer(buffer)) {
        pcm = buffer;
      } else if (buffer instanceof ArrayBuffer) {
        pcm = Buffer.from(buffer);
      } else {
        socket.emit("error", {
          code: "BAD_PAYLOAD",
          message: "audio_chunk requires (meta, Buffer)",
        });
        return;
      }

      if (pcm.length === 0) {
        socket.emit("error", {
          code: "BAD_PAYLOAD",
          message: "audio_chunk buffer is empty",
        });
        return;
      }

      if (pcm.length > AUDIO_CHUNK_MAX_BYTES) {
        socket.emit("error", {
          code: "AUDIO_CHUNK_TOO_LARGE",
          message: `audio_chunk exceeds ${AUDIO_CHUNK_MAX_BYTES} bytes`,
        });
        return;
      }

      const parsed = AudioChunkMetaSchema.safeParse(meta);
      if (!parsed.success) {
        socket.emit("error", {
          code: "BAD_PAYLOAD",
          message: "audio_chunk meta failed validation",
        });
        return;
      }
      const m = parsed.data;

      if (!audio.sources.includes(m.source)) {
        socket.emit("error", {
          code: "BAD_PAYLOAD",
          message: "audio_chunk source not declared in audio_start.sources",
        });
        return;
      }

      // Per-source seq monotonicity. Gaps are OK (client drop / reconnect).
      const last = audio.lastSeqBySource.get(m.source);
      if (last !== undefined && m.seq <= last) {
        socket.emit("error", {
          code: "AUDIO_SEQ_OUT_OF_ORDER",
          message: `audio_chunk seq ${m.seq} not greater than last ${last} for source ${m.source}`,
        });
        return;
      }

      // Backpressure accounting with linear time-decay so a transient
      // burst does not poison the session forever. Mock STT processes
      // synchronously so steady-state queuedBytes hovers near zero.
      const now = Date.now();
      const elapsed = Math.max(0, now - audio.queueLastUpdatedAt);
      if (elapsed >= AUDIO_QUEUE_DRAIN_MS) {
        audio.queuedBytes = 0;
      } else if (elapsed > 0) {
        const decay = Math.floor(
          (audio.queuedBytes * elapsed) / AUDIO_QUEUE_DRAIN_MS,
        );
        audio.queuedBytes = Math.max(0, audio.queuedBytes - decay);
      }
      if (audio.queuedBytes + pcm.length > AUDIO_QUEUE_MAX_BYTES) {
        socket.emit("error", {
          code: "AUDIO_BACKPRESSURE",
          message: `audio session queued bytes exceeds ${AUDIO_QUEUE_MAX_BYTES}`,
        });
        return;
      }
      audio.queuedBytes += pcm.length;
      audio.queueLastUpdatedAt = now;
      audio.lastSeqBySource.set(m.source, m.seq);

      const session = audio.sessions.get(m.source);
      if (!session) {
        // Defensive: should not happen because we already checked source
        // membership against the declared set.
        socket.emit("error", {
          code: "BAD_PAYLOAD",
          message: "audio_chunk source has no active session",
        });
        return;
      }

      const partial = session.acceptChunk(pcm, {
        seq: m.seq,
        durationMs: m.duration_ms,
      });
      // Mock adapter consumed the buffer synchronously. Release our
      // reference; do not stringify or persist it.
      pcm = Buffer.alloc(0);
      if (partial) {
        socket.emit("transcript.partial", {
          callId: ctx.callId,
          source: m.source,
          who: sourceToSpeaker(m.source),
          text: partial.text,
          atMs: partial.atMs,
          serverSentAt: Date.now(),
        });
      }
    });

    socket.on("audio_end", async (payload: unknown) => {
      const ctx = calls.get(socket);
      if (!ctx) {
        socket.emit("error", {
          code: "no_active_call",
          message: "audio_end requires a prior start_call",
        });
        return;
      }
      // audio_end is OK even before audio_start in the sense that the
      // client may be sending one for cleanup; we treat it as a no-op
      // rather than emitting an error to keep client cleanup simple.
      if (!ctx.audio) {
        socket.data.log("audio_end no_active_audio (no-op)");
        return;
      }
      // Validate the envelope (optional reason). Reject only if the
      // payload is malformed structurally; a missing payload is fine.
      if (payload !== undefined && payload !== null) {
        const parsed = AudioEndSchema.safeParse(payload);
        if (!parsed.success) {
          socket.emit("error", {
            code: "BAD_PAYLOAD",
            message: "audio_end payload failed validation",
          });
          return;
        }
      }
      const flush = await flushAudioSession(socket, ctx, user);
      if (!flush.ok) {
        socket.emit("error", {
          code: flush.error,
          message: "audio_end flush failed",
        });
        return;
      }
      socket.data.log("audio_end ok", { callId: ctx.callId });
    });

    // -------------------------------------------------------------- //
    // heartbeat — Phase 5 Step 3.
    //
    // Client pings every 20s (master plan §2 decision 11). The handler
    // refreshes calls.last_seen_at via the service. ack contract:
    //   { ok: true,  lastSeenAt }              — heartbeat applied
    //   { ok: false, error: "no_active_call" } — start_call not yet
    //   { ok: false, error: "call_ended" }     — call marked ended/missed/dropped
    //   { ok: false, error: "persistence_failed" } — DB error; client retries
    //
    // The disconnect handler still does NOT mark the call dropped on
    // its own — that's the sweep service's job, gated by the 60s cutoff
    // (master plan §2 decision 10).
    // -------------------------------------------------------------- //
    socket.on("heartbeat", async (_payload: unknown, ack?: (resp: unknown) => void) => {
      const ctx = calls.get(socket);
      if (!ctx) {
        if (typeof ack === "function") {
          ack({ ok: false, error: "no_active_call" });
        }
        return;
      }
      try {
        const updated = await callHeartbeatService.touchCallHeartbeat(
          app,
          user.orgId,
          ctx.callId,
        );
        if (!updated) {
          // Call exists but is no longer in_progress (ended / missed /
          // dropped / soft-deleted). Signal the client to stop pinging.
          if (typeof ack === "function") {
            ack({ ok: false, error: "call_ended" });
          }
          return;
        }
        if (typeof ack === "function") {
          ack({
            ok: true,
            lastSeenAt:
              updated.last_seen_at instanceof Date
                ? updated.last_seen_at.toISOString()
                : updated.last_seen_at,
          });
        }
      } catch (err) {
        socket.data.log("heartbeat persistence_failed", {
          err: (err as Error)?.message,
          callId: ctx.callId,
        });
        if (typeof ack === "function") {
          ack({ ok: false, error: "persistence_failed" });
        }
      }
    });

    socket.on("disconnect", (reason) => {
      socket.data.log("disconnect", { reason });
      clearCall(socket);
    });
  });

  console.log("[ws/calls] namespace registered at /calls (handshake auth ON)");
}

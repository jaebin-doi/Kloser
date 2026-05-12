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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface StartCallPayload {
  customerId?: string;
}
interface TextChunkPayload {
  seq: number;
  text: string;
  clientSentAt: number;
}

interface CallContext {
  callId: string;
  startedAt: number;
  timers: NodeJS.Timeout[];
}

// One in-flight call per socket. Presence in this map IS the
// `callStarted` invariant — text_chunk requires a hit here.
const calls = new WeakMap<Socket, CallContext>();

function clearCall(socket: Socket): void {
  const ctx = calls.get(socket);
  if (!ctx) return;
  for (const t of ctx.timers) clearTimeout(t);
  ctx.timers.length = 0;
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
        const call = await callsService.createCall(app, user.orgId, {
          customer_id: customerId,
          agent_user_id: user.id,
          direction: "inbound",
        });
        const ctx: CallContext = {
          callId: call.id,
          startedAt: Date.now(),
          timers: [],
        };
        calls.set(socket, ctx);
        socket.data.log("start_call", { callId: call.id, customerId });

        scheduleDemoReplay(socket, ctx);
        if (typeof ack === "function") ack({ callId: call.id });
      } catch (err) {
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
      try {
        await callsService.endCall(app, user.orgId, ctx.callId);
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

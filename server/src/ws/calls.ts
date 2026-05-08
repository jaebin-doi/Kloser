/* /calls Socket.io namespace.
 *
 * Phase 0.5 spike pumped the demo conversation via setTimeout. Phase 1
 * step 4 attaches an authenticated identity to every connection by
 * verifying a Bearer-equivalent JWT on the handshake. The `userId`
 * query parameter from the spike is gone — the token is the only
 * trust boundary now.
 *
 * Error contract (kept stable so the client can branch on `err.data.code`
 * for handshake and emit `.code` for runtime):
 *   handshake `connect_error`:
 *     - "missing_token"  — auth.token absent or empty
 *     - "expired_token"  — JWT exp passed
 *     - "invalid_token"  — bad signature, malformed payload, etc.
 *   runtime `error` event:
 *     - "no_active_call" — text_chunk arrived before start_call
 *     - "BAD_PAYLOAD"    — text_chunk shape mismatch (preserved from spike)
 */
import type { FastifyInstance } from "fastify";
import type { Server, Socket } from "socket.io";
import { randomUUID } from "node:crypto";
import { conversation, aiSequence } from "../fixtures/demo-call.js";
import {
  toAuthenticatedUser,
  validateAccessTokenPayload,
  type AuthenticatedUser,
} from "../services/auth.js";

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

    socket.on("start_call", (payload: StartCallPayload | undefined, ack?: (resp: unknown) => void) => {
      // Clear any prior call on the same socket (e.g., reconnect / repeat start_call)
      clearCall(socket);

      const callId = randomUUID();
      const ctx: CallContext = { callId, startedAt: Date.now(), timers: [] };
      calls.set(socket, ctx);
      socket.data.log("start_call", { callId, customerId: payload?.customerId });

      scheduleDemoReplay(socket, ctx);

      if (typeof ack === "function") ack({ callId });
    });

    socket.on("text_chunk", (payload: TextChunkPayload | undefined) => {
      // Invariant: a text_chunk only makes sense inside an active call.
      // A normal client emits text_chunk only after the start_call ack,
      // so this check protects against client bugs and probe scripts.
      if (!calls.has(socket)) {
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
      socket.emit("transcript", {
        seq: payload.seq,
        who,
        text: payload.text,
        clientSentAt: payload.clientSentAt,
        serverSentAt: Date.now(),
      });
    });

    socket.on("end_call", (_payload: unknown, ack?: (resp: unknown) => void) => {
      const ctx = calls.get(socket);
      socket.data.log("end_call", { callId: ctx?.callId });
      clearCall(socket);
      if (typeof ack === "function") ack({ ok: true });
    });

    socket.on("disconnect", (reason) => {
      socket.data.log("disconnect", { reason });
      clearCall(socket);
    });
  });

  console.log("[ws/calls] namespace registered at /calls (handshake auth ON)");
}

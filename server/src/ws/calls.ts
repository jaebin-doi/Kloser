import type { Server, Socket } from "socket.io";
import { randomUUID } from "node:crypto";
import { conversation, aiSequence } from "../fixtures/demo-call.js";

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

const calls = new WeakMap<Socket, CallContext>();

function clearCall(socket: Socket): void {
  const ctx = calls.get(socket);
  if (!ctx) return;
  for (const t of ctx.timers) clearTimeout(t);
  ctx.timers.length = 0;
  calls.delete(socket);
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

export function registerCallsNamespace(io: Server): void {
  const ns = io.of("/calls");

  ns.on("connection", (socket) => {
    const userId = String(socket.handshake.query.userId ?? "anonymous");
    socket.data.userId = userId;
    socket.data.log = (msg: string, extra?: unknown) => {
      const tag = `[ws/calls socket=${socket.id} user=${userId}]`;
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
      // Phase 1 TODO: enforce that start_call ran first (require ctx in `calls`).
      // Spike intentionally allows standalone echo for manual probes.
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

  console.log("[ws/calls] namespace registered at /calls");
}

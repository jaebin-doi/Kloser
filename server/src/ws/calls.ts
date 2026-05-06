import type { Server, Socket } from "socket.io";
import { randomUUID } from "node:crypto";

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
}

const calls = new WeakMap<Socket, CallContext>();

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
      const callId = randomUUID();
      const ctx: CallContext = { callId, startedAt: Date.now() };
      calls.set(socket, ctx);
      socket.data.log("start_call", { callId, customerId: payload?.customerId });
      if (typeof ack === "function") ack({ callId });
    });

    socket.on("text_chunk", (payload: TextChunkPayload | undefined) => {
      if (!payload || typeof payload.seq !== "number" || typeof payload.text !== "string") {
        socket.emit("error", { code: "BAD_PAYLOAD", message: "text_chunk requires { seq, text, clientSentAt }" });
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
      calls.delete(socket);
      if (typeof ack === "function") ack({ ok: true });
    });

    socket.on("disconnect", (reason) => {
      calls.delete(socket);
      socket.data.log("disconnect", { reason });
    });
  });

  console.log("[ws/calls] namespace registered at /calls");
}

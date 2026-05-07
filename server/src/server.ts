// dotenv MUST load before any module that reads process.env at top level
// (notably ./db/pool.js). Keep this on line 1.
import "dotenv/config";

import Fastify from "fastify";
import cors from "@fastify/cors";
import { Server as IOServer } from "socket.io";
import { registerCallsNamespace } from "./ws/calls.js";
import dbPlugin from "./plugins/db.js";

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? "0.0.0.0";
const STATIC_ORIGIN = process.env.STATIC_ORIGIN ?? "http://localhost:8765";

const app = Fastify({
  logger: { level: "info" },
});

await app.register(cors, {
  origin: [STATIC_ORIGIN, "http://127.0.0.1:8765"],
  credentials: true,
});

await app.register(dbPlugin);

app.get("/health", async () => ({
  ok: true,
  version: "0.5-spike",
  uptimeSec: Math.round(process.uptime()),
}));

await app.listen({ port: PORT, host: HOST });

const io = new IOServer(app.server, {
  cors: {
    origin: [STATIC_ORIGIN, "http://127.0.0.1:8765"],
    credentials: true,
  },
});
registerCallsNamespace(io);

app.log.info({ port: PORT, staticOrigin: STATIC_ORIGIN }, "kloser-server listening");

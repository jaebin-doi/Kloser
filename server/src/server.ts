import Fastify from "fastify";
import cors from "@fastify/cors";

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

app.get("/health", async () => ({
  ok: true,
  version: "0.5-spike",
  uptimeSec: Math.round(process.uptime()),
}));

await app.listen({ port: PORT, host: HOST });
app.log.info({ port: PORT, staticOrigin: STATIC_ORIGIN }, "kloser-server listening");

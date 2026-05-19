// dotenv MUST load before any module that reads process.env at top level
// (notably ./db/pool.js, ./config/authEnv.js). Keep this on line 1.
import "dotenv/config";

// Import side-effect: ./config/authEnv validates JWT_SECRET (and friends)
// at module load. A missing/short secret throws here, before listen().
import "./config/authEnv.js";

import Fastify from "fastify";
import cors from "@fastify/cors";
import { Server as IOServer } from "socket.io";
import { registerCallsNamespace } from "./ws/calls.js";
import authPlugin from "./plugins/auth.js";
import dbPlugin from "./plugins/db.js";
import recordingStoragePlugin from "./plugins/recordingStorage.js";
import activityLogRoutes from "./routes/activityLog.js";
import authRoutes from "./routes/auth.js";
import billingRoutes from "./routes/billing.js";
import callsRoutes from "./routes/calls.js";
import callsPhase5Routes from "./routes/callsPhase5.js";
import callRecordingsRoutes from "./routes/callRecordings.js";
import checklistTemplatesRoutes from "./routes/checklistTemplates.js";
import customersRoutes from "./routes/customers.js";
import dashboardRoutes from "./routes/dashboard.js";
import invitationsRoutes from "./routes/invitations.js";
import knowledgeBasesRoutes from "./routes/knowledgeBases.js";
import meRoutes from "./routes/me.js";
import organizationSecurityRoutes from "./routes/organizationSecurity.js";
import reportsRoutes from "./routes/reports.js";
import teamRoutes from "./routes/team.js";

const PORT = Number(process.env.PORT ?? 32173);
const HOST = process.env.HOST ?? "0.0.0.0";
const STATIC_ORIGIN = process.env.STATIC_ORIGIN ?? "http://localhost:8765";

const app = Fastify({
  logger: { level: "info" },
});

// CORS allow-list:
//   - STATIC_ORIGIN          → split-origin dev default (http://localhost:8765).
//                                Override per env for prod / staging deploys.
//   - 127.0.0.1:8765          → equivalent IPv4 host for the static server.
//   - https://localhost       → forward-compat for Phase 1 Step 5 Caddy
//   - https://127.0.0.1         single-origin variant AND HTTPS dev proxies
//                                (VS Code Dev Tunnels, ngrok, etc.). Caddy
//                                same-origin requests don't reach this list —
//                                CORS isn't triggered same-origin — so this
//                                is purely a safety net for direct API calls
//                                from those origins.
await app.register(cors, {
  origin: [
    STATIC_ORIGIN,
    "http://127.0.0.1:8765",
    "https://localhost",
    "https://127.0.0.1",
  ],
  credentials: true,
});

await app.register(authPlugin);
await app.register(dbPlugin);
await app.register(recordingStoragePlugin);

await app.register(authRoutes);
await app.register(meRoutes);
await app.register(customersRoutes);
await app.register(teamRoutes);
await app.register(invitationsRoutes);
await app.register(callsRoutes);
await app.register(callsPhase5Routes);
await app.register(callRecordingsRoutes);
await app.register(checklistTemplatesRoutes);
await app.register(knowledgeBasesRoutes);
await app.register(dashboardRoutes);
await app.register(reportsRoutes);
await app.register(organizationSecurityRoutes);
await app.register(activityLogRoutes);
await app.register(billingRoutes);

app.get("/health", async () => ({
  ok: true,
  version: "0.5-spike",
  uptimeSec: Math.round(process.uptime()),
}));

await app.listen({ port: PORT, host: HOST });

const io = new IOServer(app.server, {
  cors: {
    origin: [
      STATIC_ORIGIN,
      "http://127.0.0.1:8765",
      "https://localhost",
      "https://127.0.0.1",
    ],
    credentials: true,
  },
});
registerCallsNamespace(io, app);

app.log.info({ port: PORT, staticOrigin: STATIC_ORIGIN }, "kloser-server listening");

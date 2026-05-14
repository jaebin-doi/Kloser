/* Worker entrypoint — Phase 6 Step 1.
 *
 * Spins up a minimal Fastify instance (db plugin only — no routes, no
 * WS) so the workers share the same connection pool and helper API as
 * the live server. Then registers:
 *   - callSummary BullMQ Worker (consumer)
 *   - heartbeatSweep BullMQ Worker (consumer)
 *   - heartbeatSweep singleton repeatable job (producer-side schedule)
 *
 * Lifecycle:
 *   - Boot logs queue + cutoff config.
 *   - SIGINT / SIGTERM closes workers → queues → Redis → app, in that
 *     order, then exits 0.
 *   - Any unhandled error in boot exits 1.
 *
 * Used by `npm run dev:worker` and `npm run start:worker`.
 */
import "dotenv/config";
import Fastify from "fastify";
import dbPlugin from "../plugins/db.js";
import { createCallSummaryWorker } from "./callSummary.worker.js";
import { createHeartbeatSweepWorker } from "./heartbeatSweep.worker.js";
import {
  createEmailDeliveryWorker,
  loadEmailDeliveryConfigFromEnv,
} from "./emailDelivery.worker.js";
import {
  closeQueues,
  closeRedis,
  scheduleEmailDelivery,
  scheduleHeartbeatSweep,
} from "../queue/index.js";

const SWEEP_INTERVAL_MS =
  Number.parseInt(process.env.KLOSER_HEARTBEAT_SWEEP_INTERVAL_SEC ?? "30", 10) * 1000;

// Phase 7 Step 1 — email delivery tick interval. Default 10s matches
// Plan §2.4. Only used when EMAIL_PROVIDER=resend; otherwise the
// scheduler entry is skipped.
const EMAIL_DELIVERY_INTERVAL_MS =
  Number.parseInt(process.env.KLOSER_EMAIL_DELIVERY_INTERVAL_SEC ?? "10", 10) * 1000;

async function main(): Promise<void> {
  const app = Fastify({ logger: { level: "info" } });
  // db plugin only — workers don't serve HTTP.
  await app.register(dbPlugin);

  const summaryWorker = createCallSummaryWorker(app);
  const sweepWorker = createHeartbeatSweepWorker(app);

  // Email delivery: resolve config from env. Returns null for the dev
  // provider. Unknown providers, or resend with missing/invalid env,
  // fail boot so production cannot silently stop sending. The Worker is
  // created either way; with null config the processor returns no-op and
  // we skip the repeatable schedule.
  let emailDeliveryConfig: ReturnType<typeof loadEmailDeliveryConfigFromEnv>;
  try {
    emailDeliveryConfig = loadEmailDeliveryConfigFromEnv();
  } catch (err) {
    // EmailDeliveryConfigError / EmailEncryptionConfigError surface here.
    // Fail the worker boot; silent real-provider fallback is not allowed.
    console.error(
      `[workers] email-delivery config invalid: ${(err as Error).message}`,
    );
    throw err;
  }
  const emailWorker = createEmailDeliveryWorker(app, emailDeliveryConfig);

  // Register the singleton repeatable sweep. Idempotent across boots.
  await scheduleHeartbeatSweep(SWEEP_INTERVAL_MS);
  if (emailDeliveryConfig) {
    await scheduleEmailDelivery(EMAIL_DELIVERY_INTERVAL_MS);
  }

  const emailMode = emailDeliveryConfig
    ? `resend (interval=${EMAIL_DELIVERY_INTERVAL_MS}ms, max=${emailDeliveryConfig.maxAttempts})`
    : "no-op (EMAIL_PROVIDER=dev_outbox)";
  console.log(
    `[workers] up — call-summary + heartbeat-sweep (interval=${SWEEP_INTERVAL_MS}ms, cutoff=${process.env.KLOSER_HEARTBEAT_CUTOFF_SEC ?? "60"}s) + email-delivery ${emailMode}`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[workers] received ${signal}; shutting down`);
    try {
      await summaryWorker.close();
      await sweepWorker.close();
      await emailWorker.close();
      await closeQueues();
      await closeRedis();
      await app.close();
    } catch (err) {
      console.error("[workers] shutdown error:", (err as Error).message);
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
}

main().catch((err) => {
  console.error("[workers] boot failed:", err);
  process.exit(1);
});

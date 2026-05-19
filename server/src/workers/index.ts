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
// Phase 8 Step 5 — retention worker runs recording object deletes
// through app.recordingStorage. Register the plugin here so worker
// boot fails fast if a real provider is misconfigured.
import recordingStoragePlugin from "../plugins/recordingStorage.js";
import { createCallSummaryWorker } from "./callSummary.worker.js";
import { createHeartbeatSweepWorker } from "./heartbeatSweep.worker.js";
import {
  createEmailDeliveryWorker,
  loadEmailDeliveryConfigFromEnv,
} from "./emailDelivery.worker.js";
import { createRetentionSweepWorker } from "./retentionSweep.worker.js";
import { loadRetentionConfigFromEnv } from "../services/retention.js";
import {
  closeQueues,
  closeRedis,
  scheduleEmailDelivery,
  scheduleHeartbeatSweep,
  scheduleRetentionSweep,
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
  // recordingStorage decorator — retention sweep needs adapter.deleteObject.
  // Plugin resolves provider from env at boot (RECORDING_STORAGE_PROVIDER,
  // local default in non-production).
  await app.register(recordingStoragePlugin);

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

  // Phase 7 Step 4 — retention sweep. Config loader throws
  // RetentionConfigError on out-of-range env values; that bubble lets
  // the worker boot fail fast rather than silently dropping retention.
  // The Worker instance is created even when disabled so shutdown can
  // close it cleanly and manual job triggers in dev have a target.
  const retentionConfig = loadRetentionConfigFromEnv();
  const retentionWorker = createRetentionSweepWorker(app, retentionConfig);

  // Register the singleton repeatable sweeps. Idempotent across boots.
  await scheduleHeartbeatSweep(SWEEP_INTERVAL_MS);
  if (emailDeliveryConfig) {
    await scheduleEmailDelivery(EMAIL_DELIVERY_INTERVAL_MS);
  }
  if (retentionConfig.enabled) {
    await scheduleRetentionSweep(retentionConfig.intervalSec * 1000);
  }

  const emailMode = emailDeliveryConfig
    ? `resend (interval=${EMAIL_DELIVERY_INTERVAL_MS}ms, max=${emailDeliveryConfig.maxAttempts})`
    : "no-op (EMAIL_PROVIDER=dev_outbox)";
  const retentionMode = retentionConfig.enabled
    ? `enabled (interval=${retentionConfig.intervalSec}s, transcriptDays=${retentionConfig.transcriptRetentionDays})`
    : "disabled";
  console.log(
    `[workers] up — call-summary + heartbeat-sweep (interval=${SWEEP_INTERVAL_MS}ms, cutoff=${process.env.KLOSER_HEARTBEAT_CUTOFF_SEC ?? "60"}s) + email-delivery ${emailMode} + retention-sweep ${retentionMode}`,
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
      await retentionWorker.close();
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

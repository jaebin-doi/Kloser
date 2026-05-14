/* phase6 e2e drain helper — Phase 6 Step 5.
 *
 * Phase 6 e2e (`test/phase_6_e2e.mjs`) runs as pure .mjs and cannot import
 * the worker's TypeScript module graph directly. This script gives the
 * e2e a deterministic way to exercise the Step 1 worker / heartbeat
 * service paths inline (no Redis BullMQ loop, no second process).
 *
 * Subcommands:
 *
 *   summary <orgId> <callId>
 *     Invokes `makeCallSummaryProcessor(app)({ data: { orgId, callId } })`.
 *     Mirrors what BullMQ would call for a queued job. Prints the job
 *     result as a single JSON line on stdout.
 *
 *   sweep <orgId> <cutoffEpochMs>
 *     Calls `callHeartbeatService.markTimedOutCallsDropped(app, orgId, cutoff)`.
 *     `cutoffEpochMs` is the absolute ms timestamp such that any
 *     `last_seen_at < cutoff` AND `status='in_progress'` is marked dropped
 *     (`dropped_reason='server_timeout'`). Prints the affected row count.
 *
 * Exit codes:
 *   0 — success
 *   1 — usage error
 *   2 — boot or processor threw
 */
import "dotenv/config";
import Fastify from "fastify";
import dbPlugin from "../src/plugins/db.js";
import { makeCallSummaryProcessor } from "../src/workers/callSummary.worker.js";
import * as callHeartbeatService from "../src/services/callHeartbeat.js";

function usage(): never {
  console.error(
    "usage: phase6E2eDrain summary <orgId> <callId>",
    "\n       phase6E2eDrain sweep   <orgId> <cutoffEpochMs>",
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const [cmd, a, b] = process.argv.slice(2);
  if (!cmd || !a || !b) usage();

  const app = Fastify({ logger: false });
  await app.register(dbPlugin);

  try {
    if (cmd === "summary") {
      const processor = makeCallSummaryProcessor(app);
      const result = await processor({ data: { orgId: a, callId: b } });
      process.stdout.write(JSON.stringify(result ?? {}) + "\n");
    } else if (cmd === "sweep") {
      const cutoffMs = Number.parseInt(b, 10);
      if (!Number.isFinite(cutoffMs)) usage();
      const cutoff = new Date(cutoffMs);
      const affected = await callHeartbeatService.markTimedOutCallsDropped(
        app,
        a,
        cutoff,
      );
      process.stdout.write(JSON.stringify({ affected }) + "\n");
    } else {
      usage();
    }
  } catch (err) {
    console.error(
      "phase6E2eDrain processor threw:",
      (err as Error)?.message ?? err,
    );
    await app.close().catch(() => undefined);
    process.exit(2);
  }
  await app.close();
}

main().catch((err) => {
  console.error("phase6E2eDrain boot failed:", err);
  process.exit(2);
});

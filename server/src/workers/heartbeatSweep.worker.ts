/* Heartbeat sweep worker — Phase 6 Step 1.
 *
 * Consumes the `heartbeat-sweep` queue (singleton repeatable job). For
 * each run:
 *   1. Read cutoff seconds from `KLOSER_HEARTBEAT_CUTOFF_SEC` (default
 *      60s, Phase 5 master plan §2 decision 10).
 *   2. Enumerate all org ids via the worker-internal repository.
 *   3. For each org, enter `withOrgContext(orgId)` and call
 *      `markDroppedTimedOutInCurrentOrg(client, cutoff, now)`.
 *   4. Log the per-org count.
 *
 * Race safety:
 *   - sweep SQL filters `WHERE status='in_progress'`. An endCall on
 *     the same row also filters `status='in_progress'` so whichever
 *     UPDATE lands first leaves the other's WHERE matching 0 rows.
 *     No CHECK violation possible (Phase 5 Step 1 schema review).
 *
 * Failure handling:
 *   - Per-org error caught and logged; the sweep continues for the
 *     rest of the orgs. BullMQ marks the job as completed (attempts=1
 *     per queue default — repeatable runs on the next interval).
 */
import type { FastifyInstance } from "fastify";
import { Worker, type Job } from "bullmq";
import { getRedisConnection } from "../queue/redis.js";
import {
  HEARTBEAT_SWEEP_QUEUE,
  type HeartbeatSweepJobData,
} from "../queue/queues.js";
import * as callHeartbeatService from "../services/callHeartbeat.js";
import { listAllOrgIds } from "../repositories/orgs.js";

function readCutoffSec(jobData: HeartbeatSweepJobData | undefined): number {
  const fromJob = jobData?.cutoffSec;
  if (typeof fromJob === "number" && Number.isFinite(fromJob) && fromJob > 0) {
    return Math.floor(fromJob);
  }
  const env = process.env.KLOSER_HEARTBEAT_CUTOFF_SEC;
  if (env) {
    const n = Number.parseInt(env, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 60;
}

export function createHeartbeatSweepWorker(app: FastifyInstance): Worker<HeartbeatSweepJobData> {
  return new Worker<HeartbeatSweepJobData>(
    HEARTBEAT_SWEEP_QUEUE,
    async (job: Job<HeartbeatSweepJobData>) => {
      const cutoffSec = readCutoffSec(job.data);
      const now = new Date();
      const cutoff = new Date(now.getTime() - cutoffSec * 1000);

      // organizations has no RLS, so a bare pool client is sufficient.
      // Worker-internal repo — never exposed to routes.
      const orgClient = await app.pg.connect();
      let orgIds: string[];
      try {
        orgIds = await listAllOrgIds(orgClient);
      } finally {
        orgClient.release();
      }

      let totalDropped = 0;
      for (const orgId of orgIds) {
        try {
          const n = await callHeartbeatService.markTimedOutCallsDropped(
            app,
            orgId,
            cutoff,
            now,
          );
          totalDropped += n;
          if (n > 0) {
            console.log(`[heartbeat-sweep] org=${orgId} dropped=${n}`);
          }
        } catch (err) {
          console.error(
            `[heartbeat-sweep] org=${orgId} failed:`,
            (err as Error).message,
          );
        }
      }
      return { orgs: orgIds.length, totalDropped, cutoffSec };
    },
    {
      connection: getRedisConnection(),
      concurrency: 1,
    },
  );
}

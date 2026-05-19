/* Retention sweep worker — Phase 7 Step 4.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_4_PLAN.md §7.2.
 *
 * Consumes the `retention-sweep` queue (singleton repeatable job).
 * The processor is exported standalone so tests can drive one tick
 * deterministically without going through BullMQ.
 *
 * Behavior:
 *   - When `config.enabled === false`: no-op result
 *     `{ skipped: true, reason: 'disabled' }`. The worker is still
 *     constructed (so the BullMQ Worker instance can be `.close()`'d
 *     cleanly at shutdown) but the processor does nothing.
 *   - When enabled: delegates to `runRetentionTick`, which iterates
 *     orgs, deletes expired transcripts, recovers stuck `sending`
 *     emails, and records aggregate audit rows in the same per-org
 *     transaction (Plan §6).
 *   - Per-org failures are isolated inside `runRetentionTick`, never
 *     bubbled to BullMQ. The job always completes; the next tick
 *     picks up whatever this one missed.
 *
 * Race safety:
 *   - Transcript delete + email recovery both use
 *     `FOR UPDATE SKIP LOCKED` in their CTEs, so two retention workers
 *     (or this worker + a concurrent delivery worker for the email
 *     case) don't block each other.
 *
 * `now` injection:
 *   - Production passes `new Date()` per tick.
 *   - Tests pass a fixed Date through `MakeRetentionSweepProcessorOptions.now`.
 *     The job payload `nowIso` is honored only as a one-off override
 *     (manual cron triggers, debug runs); the processor option wins
 *     when both are provided.
 */
import type { FastifyInstance } from "fastify";
import { Worker, type Job } from "bullmq";
import { getRedisConnection } from "../queue/redis.js";
import {
  RETENTION_SWEEP_QUEUE,
  type RetentionSweepJobData,
} from "../queue/queues.js";
import {
  runRetentionTick,
  type RetentionConfig,
  type RetentionTickResult,
} from "../services/retention.js";

export interface MakeRetentionSweepProcessorOptions {
  config: RetentionConfig;
  /** Optional `now` injection for deterministic tests. Defaults to
   *  `() => new Date()` so production code never has to pass it. */
  now?: () => Date;
}

export function makeRetentionSweepProcessor(
  app: FastifyInstance,
  opts: MakeRetentionSweepProcessorOptions,
) {
  const { config } = opts;
  const nowFn = opts.now ?? (() => new Date());

  return async function processor(
    job?: Pick<Job<RetentionSweepJobData>, "data">,
  ): Promise<RetentionTickResult> {
    // Processor-side disable. Even when the scheduler is off (default
    // in dev/test), a manually triggered job with the worker present
    // should still respect the env-derived enable flag.
    if (!config.enabled) {
      return {
        skipped: true,
        reason: "disabled",
        orgsScanned: 0,
        transcriptsDeleted: 0,
        emailOutboxRecovered: 0,
        recordingsDeleted: 0,
        recordingObjectNotFound: 0,
        recordingDeleteFailures: 0,
        failedOrgs: [],
      };
    }

    // Job payload `nowIso` is a manual override; tests inject through
    // the processor option instead.
    const jobNowIso = job?.data?.nowIso;
    let effectiveNow = nowFn();
    if (typeof jobNowIso === "string" && jobNowIso.length > 0) {
      const parsed = new Date(jobNowIso);
      if (!Number.isNaN(parsed.getTime())) {
        effectiveNow = parsed;
      }
    }

    const result = await runRetentionTick(app, config, effectiveNow);

    // Single aggregate log line per tick — matches heartbeat-sweep /
    // email-delivery style. No per-org spam; per-org details are in
    // activity_log rows for admin queries.
    // Aggregate-only log. No object key, recording id, call id, signed
    // URL, or raw storage error body.
    console.log(
      `[retention-sweep] orgs=${result.orgsScanned}` +
        ` transcriptsDeleted=${result.transcriptsDeleted}` +
        ` emailRecovered=${result.emailOutboxRecovered}` +
        ` recordingsDeleted=${result.recordingsDeleted}` +
        ` recordingObjectNotFound=${result.recordingObjectNotFound}` +
        ` recordingDeleteFailures=${result.recordingDeleteFailures}` +
        ` failedOrgs=${result.failedOrgs.length}`,
    );

    return result;
  };
}

export function createRetentionSweepWorker(
  app: FastifyInstance,
  config: RetentionConfig,
): Worker<RetentionSweepJobData> {
  const processor = makeRetentionSweepProcessor(app, { config });
  return new Worker<RetentionSweepJobData>(
    RETENTION_SWEEP_QUEUE,
    async (job) => processor(job),
    {
      connection: getRedisConnection(),
      // Concurrency 1: the singleton repeatable tick should never run
      // overlapping copies on the same worker process. Per-org
      // SKIP LOCKED handles inter-process concurrency.
      concurrency: 1,
    },
  );
}

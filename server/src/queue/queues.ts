/* BullMQ queue definitions — Phase 6 Step 1.
 *
 * Two queues:
 *   - call-summary  : per-call AI summary job. Triggered by endCall().
 *   - heartbeat-sweep: singleton repeatable job that marks stale
 *                      in_progress calls as dropped.
 *
 * Queue handles are lazily constructed via `getXxxQueue()` so that
 * importing this module from a Fastify boot path does not eagerly
 * connect Redis (Phase 5 server boot must not fail when Redis is
 * unreachable — the API and WS continue without the queue).
 *
 * Module is worker-internal + service-internal. Not exposed through any
 * route or browser-facing API.
 */
import { Queue, type Queue as BullQueue } from "bullmq";
import { getRedisConnection } from "./redis.js";

export const CALL_SUMMARY_QUEUE = "call-summary";
export const HEARTBEAT_SWEEP_QUEUE = "heartbeat-sweep";

export interface CallSummaryJobData {
  orgId: string;
  callId: string;
}

export interface HeartbeatSweepJobData {
  cutoffSec?: number;
}

let callSummaryQueue: BullQueue<CallSummaryJobData> | null = null;
let heartbeatSweepQueue: BullQueue<HeartbeatSweepJobData> | null = null;

export function getCallSummaryQueue(): BullQueue<CallSummaryJobData> {
  if (callSummaryQueue) return callSummaryQueue;
  callSummaryQueue = new Queue<CallSummaryJobData>(CALL_SUMMARY_QUEUE, {
    connection: getRedisConnection(),
    // Default job options. Workers can override per-job, but these
    // defaults match the Phase 5 graceful-degrade decision (decision
    // 21) — three attempts, exponential backoff, then dead-letter
    // (BullMQ moves failed jobs into the "failed" set automatically).
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 },
    },
  });
  return callSummaryQueue;
}

export function getHeartbeatSweepQueue(): BullQueue<HeartbeatSweepJobData> {
  if (heartbeatSweepQueue) return heartbeatSweepQueue;
  heartbeatSweepQueue = new Queue<HeartbeatSweepJobData>(HEARTBEAT_SWEEP_QUEUE, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: 1, // sweep is idempotent; re-running on the next tick is fine
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 },
    },
  });
  return heartbeatSweepQueue;
}

export async function closeQueues(): Promise<void> {
  const tasks: Array<Promise<void>> = [];
  if (callSummaryQueue) {
    tasks.push(callSummaryQueue.close());
    callSummaryQueue = null;
  }
  if (heartbeatSweepQueue) {
    tasks.push(heartbeatSweepQueue.close());
    heartbeatSweepQueue = null;
  }
  await Promise.all(tasks);
}

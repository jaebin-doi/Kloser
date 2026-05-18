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
// Phase 7 Step 1 — email delivery queue. Singleton repeatable job ticks
// every KLOSER_EMAIL_DELIVERY_INTERVAL_SEC and the worker processes due
// rows from email_outbox. Only scheduled when EMAIL_PROVIDER=resend
// (see workers/index.ts).
export const EMAIL_DELIVERY_QUEUE = "email-delivery";
// Phase 7 Step 4 — retention sweep queue. Singleton repeatable job that
// ticks once per KLOSER_RETENTION_INTERVAL_SEC. Worker deletes expired
// transcripts and recovers stuck `sending` email_outbox rows. Only
// scheduled when KLOSER_RETENTION_ENABLED=true (see workers/index.ts).
export const RETENTION_SWEEP_QUEUE = "retention-sweep";

export interface CallSummaryJobData {
  orgId: string;
  callId: string;
}

export interface HeartbeatSweepJobData {
  cutoffSec?: number;
}

export interface EmailDeliveryJobData {
  // Reserved for future per-org or per-row scheduling. Empty for the
  // singleton repeatable tick that scans every org.
  orgId?: string;
}

export interface RetentionSweepJobData {
  // Optional deterministic `now` (ISO string) used by tests / manual
  // runs to drive the cutoff without sleeping the wall clock. Empty
  // for the singleton repeatable tick (production uses `new Date()`).
  nowIso?: string;
}

let callSummaryQueue: BullQueue<CallSummaryJobData> | null = null;
let heartbeatSweepQueue: BullQueue<HeartbeatSweepJobData> | null = null;
let emailDeliveryQueue: BullQueue<EmailDeliveryJobData> | null = null;
let retentionSweepQueue: BullQueue<RetentionSweepJobData> | null = null;

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

export function getEmailDeliveryQueue(): BullQueue<EmailDeliveryJobData> {
  if (emailDeliveryQueue) return emailDeliveryQueue;
  emailDeliveryQueue = new Queue<EmailDeliveryJobData>(EMAIL_DELIVERY_QUEUE, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      // The processor itself does row-level retry/dead-letter through
      // email_outbox.attempt_count + KLOSER_EMAIL_MAX_ATTEMPTS. Job-level
      // retry would double-count, so we keep attempts=1 — re-running on
      // the next interval is fine because leases skip 'sending' rows.
      attempts: 1,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 },
    },
  });
  return emailDeliveryQueue;
}

export function getRetentionSweepQueue(): BullQueue<RetentionSweepJobData> {
  if (retentionSweepQueue) return retentionSweepQueue;
  retentionSweepQueue = new Queue<RetentionSweepJobData>(RETENTION_SWEEP_QUEUE, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      // Retention sweep is idempotent: re-running on the next interval
      // is safe (already-deleted rows are gone, already-recovered
      // sending rows are now 'failed' and out of the WHERE). Job-level
      // attempts=1 matches heartbeat-sweep / email-delivery.
      attempts: 1,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 },
    },
  });
  return retentionSweepQueue;
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
  if (emailDeliveryQueue) {
    tasks.push(emailDeliveryQueue.close());
    emailDeliveryQueue = null;
  }
  if (retentionSweepQueue) {
    tasks.push(retentionSweepQueue.close());
    retentionSweepQueue = null;
  }
  await Promise.all(tasks);
}

/* Queue producer surface — Phase 6 Step 1.
 *
 * `enqueueCallSummary({ orgId, callId })` is the only entry the service
 * layer needs. The deterministic `jobId` is `call-summary:{orgId}:{callId}`
 * so duplicate enqueues (e.g. a retry of endCall) coalesce to a single
 * job. BullMQ silently no-ops duplicate jobIds, which matches our intent:
 * "fire-and-forget; worker decides whether to actually run".
 *
 * `scheduleHeartbeatSweep()` registers a singleton repeatable job. Called
 * once at worker boot. The actual processor lives in
 * `workers/heartbeatSweep.worker.ts`.
 *
 * NOT exported through any Fastify route. Service layer + worker entry
 * only.
 */
import {
  getCallSummaryQueue,
  getEmailDeliveryQueue,
  getHeartbeatSweepQueue,
  type CallSummaryJobData,
  type EmailDeliveryJobData,
  type HeartbeatSweepJobData,
  EMAIL_DELIVERY_QUEUE,
  HEARTBEAT_SWEEP_QUEUE,
} from "./queues.js";

export { closeQueues } from "./queues.js";
export { closeRedis } from "./redis.js";
export type { CallSummaryJobData, EmailDeliveryJobData, HeartbeatSweepJobData };

export async function enqueueCallSummary(
  data: CallSummaryJobData,
): Promise<void> {
  if (!data || typeof data.orgId !== "string" || typeof data.callId !== "string") {
    throw new Error(
      "[queue] enqueueCallSummary requires { orgId, callId } strings",
    );
  }
  const queue = getCallSummaryQueue();
  await queue.add("apply-summary", data, {
    jobId: `call-summary:${data.orgId}:${data.callId}`,
  });
}

const HEARTBEAT_SWEEP_REPEAT_KEY = "heartbeat-sweep-singleton";

export async function scheduleHeartbeatSweep(intervalMs: number): Promise<void> {
  const queue = getHeartbeatSweepQueue();
  // Repeatable jobId is the dedupe key — BullMQ ensures only one
  // schedule exists per (queue, jobId). Calling this on every worker
  // boot is safe and idempotent.
  await queue.add(
    HEARTBEAT_SWEEP_REPEAT_KEY,
    {},
    {
      repeat: { every: intervalMs },
      jobId: HEARTBEAT_SWEEP_REPEAT_KEY,
    },
  );
}

const EMAIL_DELIVERY_REPEAT_KEY = "email-delivery-singleton";

export async function scheduleEmailDelivery(intervalMs: number): Promise<void> {
  const queue = getEmailDeliveryQueue();
  // Same singleton-repeatable pattern as heartbeat sweep. Idempotent
  // across boots: BullMQ dedupes on (queue, jobId).
  await queue.add(
    EMAIL_DELIVERY_REPEAT_KEY,
    {},
    {
      repeat: { every: intervalMs },
      jobId: EMAIL_DELIVERY_REPEAT_KEY,
    },
  );
}

export const QUEUE_NAMES = {
  callSummary: "call-summary",
  heartbeatSweep: HEARTBEAT_SWEEP_QUEUE,
  emailDelivery: EMAIL_DELIVERY_QUEUE,
} as const;

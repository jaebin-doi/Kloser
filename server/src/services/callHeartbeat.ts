/* Call heartbeat service — Phase 5 Step 2.
 *
 * Two surfaces:
 *   - touchCallHeartbeat: WS handler (Step 3) calls this every 20s to
 *     refresh last_seen_at for the live call. Only in_progress calls
 *     are touched; ended/missed/dropped/soft-deleted calls return null,
 *     signalling the WS handler to stop pinging.
 *   - markTimedOutCallsDropped: periodic sweep for one org. Step 2
 *     keeps the API per-org so the test can build acme + beta data and
 *     assert the sweep ignores cross-org rows. Multi-org cron scheduling
 *     is Step 3+.
 *
 * No permission check: heartbeat originates from the same agent who
 * owns the call (Step 3 WS auth verifies that on connect). The sweep
 * is a background job, not an authenticated mutation.
 */
import type { FastifyInstance } from "fastify";
import * as callsRepo from "../repositories/calls.js";
import type { Call } from "../repositories/calls.js";

export async function touchCallHeartbeat(
  app: FastifyInstance,
  actorOrgId: string,
  callId: string,
  seenAt: Date = new Date(),
): Promise<Call | null> {
  return app.withOrgContext(actorOrgId, (client) =>
    callsRepo.touchHeartbeatInCurrentOrg(client, callId, seenAt),
  );
}

export async function markTimedOutCallsDropped(
  app: FastifyInstance,
  actorOrgId: string,
  cutoff: Date,
  droppedAt: Date = new Date(),
): Promise<number> {
  return app.withOrgContext(actorOrgId, (client) =>
    callsRepo.markDroppedTimedOutInCurrentOrg(client, cutoff, droppedAt),
  );
}

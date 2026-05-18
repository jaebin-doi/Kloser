/* calls service — Phase 4 Step 2.
 *
 * Step 3 routes will import these functions. The service is the
 * transaction boundary: every call opens app.withOrgContext(actorOrgId)
 * exactly once, runs repository work against the same client, and lets
 * the plugin commit or roll back as one unit.
 *
 * endCall is the most consequential function: it updates the calls row
 * AND the matching customers.last_contacted_at in the same transaction
 * so that a partial failure cannot leave the customer timeline ahead of
 * (or behind) the actual call state. RLS limits the customer update to
 * the same org as the GUC, and `GREATEST(COALESCE(...,'epoch'), ...)`
 * keeps last_contacted_at monotonically increasing across re-processing.
 *
 * Out of scope (Step 3+):
 *   - HTTP / WS surface mapping (404, 403, 400)
 *   - body validation via shared zod schemas
 *   - role checks
 */
import type { FastifyInstance } from "fastify";
import * as callsRepo from "../repositories/calls.js";
import * as transcriptsRepo from "../repositories/transcripts.js";
import type {
  Call,
  CallCreateInput,
  CallListOptions,
  CallStatus,
} from "../repositories/calls.js";
import type {
  Transcript,
  TranscriptAppendInput,
} from "../repositories/transcripts.js";
import { enqueueCallSummary } from "../queue/index.js";
import {
  recordCallCreated,
  recordCallEnded,
} from "./activityLog.js";
import { assertPlanAllows } from "./billing.js";

export interface CallListResult {
  items: Call[];
  total: number;
}

export async function listCalls(
  app: FastifyInstance,
  actorOrgId: string,
  opts: CallListOptions,
): Promise<CallListResult> {
  return app.withOrgContext(actorOrgId, async (client) => {
    const items = await callsRepo.listForCurrentOrg(client, opts);
    const total = await callsRepo.countForCurrentOrg(client, opts);
    return { items, total };
  });
}

export async function getCallById(
  app: FastifyInstance,
  actorOrgId: string,
  id: string,
): Promise<Call | null> {
  return app.withOrgContext(actorOrgId, (client) =>
    callsRepo.getByIdInCurrentOrg(client, id),
  );
}

export async function createCall(
  app: FastifyInstance,
  actorOrgId: string,
  actorUserId: string,
  input: CallCreateInput,
): Promise<Call> {
  return app.withOrgContext(actorOrgId, async (client) => {
    // Phase 7 Step 9 — monthly_calls cap. Both REST POST /calls and the
    // WebSocket start-call path route through this service, so the
    // guard fires on every legitimate call-creation surface in one
    // place. assertPlanAllows reads the same UTC-month window the
    // overview shows so admin-visible usage and the enforced count
    // agree.
    await assertPlanAllows(client, { limitKey: "monthly_calls", increment: 1 });
    const created = await callsRepo.insertInCurrentOrg(
      client,
      actorOrgId,
      input,
    );
    // Phase 7 Step 3 — audit. Same transaction as the INSERT so a
    // schema-mismatched audit row aborts the create together.
    await recordCallCreated(client, {
      orgId:        actorOrgId,
      actorUserId,
      callId:       created.id,
      direction:    created.direction,
      customerId:   created.customer_id,
      agentUserId:  created.agent_user_id,
    });
    return created;
  });
}

export async function appendTranscript(
  app: FastifyInstance,
  actorOrgId: string,
  callId: string,
  input: TranscriptAppendInput,
): Promise<Transcript | null> {
  return app.withOrgContext(actorOrgId, (client) =>
    transcriptsRepo.appendForCallInCurrentOrg(client, callId, input),
  );
}

export interface EndCallOptions {
  endedAt?: Date;
  finalStatus?: Extract<CallStatus, "ended" | "missed" | "dropped">;
}

// endCall sequence inside one transaction:
//   1. update the calls row — status / ended_at / duration_seconds
//   2. if customer_id is present, bump customers.last_contacted_at
//
// RLS scopes both updates to actorOrgId via the GUC. The customers
// UPDATE uses GREATEST(COALESCE(last_contacted_at,'epoch'), ended_at)
// so reprocessing an older call cannot drag the timestamp backwards.
// customer_id=NULL means the call was an unknown caller — there is no
// customer row to update, so the second statement is skipped entirely.
export async function endCall(
  app: FastifyInstance,
  actorOrgId: string,
  actorUserId: string,
  callId: string,
  opts: EndCallOptions = {},
): Promise<Call | null> {
  const endedAt = opts.endedAt ?? new Date();
  const finalStatus = opts.finalStatus ?? "ended";

  const updated = await app.withOrgContext(actorOrgId, async (client) => {
    const row = await callsRepo.endByIdInCurrentOrg(
      client,
      callId,
      endedAt,
      finalStatus,
    );
    if (!row) return null;

    if (row.customer_id) {
      await client.query(
        `UPDATE customers
            SET last_contacted_at = GREATEST(
                  COALESCE(last_contacted_at, 'epoch'::timestamptz),
                  $1::timestamptz
                )
          WHERE id = $2
            AND deleted_at IS NULL`,
        [endedAt, row.customer_id],
      );
    }

    // Phase 7 Step 3 — audit. Inside the same transaction as the calls
    // UPDATE + the conditional customers UPDATE, so a failing audit
    // row aborts every state change end-to-end.
    await recordCallEnded(client, {
      orgId:           actorOrgId,
      actorUserId,
      callId:          row.id,
      finalStatus:     row.status as ("ended" | "missed" | "dropped"),
      durationSeconds: row.duration_seconds,
    });

    return row;
  });

  // Phase 6 Step 1 — best-effort AI summary enqueue. Runs *outside* the
  // DB transaction so a Redis outage cannot block endCall (the WS /
  // REST ack must land regardless). The worker's own SQL guard
  // (`summary_source='manual'` WHERE) handles idempotency, so a
  // duplicate enqueue on retry is safe.
  if (updated) {
    try {
      await enqueueCallSummary({ orgId: actorOrgId, callId: updated.id });
    } catch (err) {
      app.log.warn(
        { err: (err as Error).message, callId: updated.id },
        "call summary enqueue failed",
      );
    }
  }

  return updated;
}

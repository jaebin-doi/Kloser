/* email_outbox stuck-sending recovery — Phase 7 Step 4.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_4_PLAN.md §5.2.
 *
 * Phase 7 Step 1 ships a lease-based delivery worker that flips
 * `email_outbox.status` from 'pending' → 'sending' inside a
 * `FOR UPDATE SKIP LOCKED` transaction, then either marks the row
 * 'delivered' / 'failed' / 'dead_lettered' after the HTTP send
 * settles. If the worker crashes mid-flight (OOM kill, container
 * restart, process panic) the row is left in 'sending' with
 * `locked_at` pointing at the doomed lease.
 *
 * This module is the recovery half: it finds rows still in 'sending'
 * after a configurable stuck threshold and rewinds them to 'failed'
 * so the next delivery tick can pick them up again. Reasons we set
 * 'failed' instead of 'pending':
 *
 *   1. 'failed' is the state the lease helper (`leaseDueEmail`)
 *      already accepts as due — putting recovered rows back into the
 *      same lane keeps the SQL machinery untouched.
 *   2. It signals "tried at least once and we don't know the outcome"
 *      truthfully — the in-flight Resend call may have succeeded,
 *      failed, or never been sent. Treating it as a fresh 'pending'
 *      would lose that nuance.
 *
 * Contract:
 *   - Caller MUST run inside `app.withOrgContext(orgId, ...)`.
 *     `email_outbox` has FORCE RLS, so no `org_id = $x` predicate is
 *     added here — RLS pins org_id via `current_app_org_id()`.
 *   - `attempt_count` is NOT incremented. This recovery is bookkeeping
 *     after a crash, not a real send attempt that should count against
 *     the dead-letter ceiling.
 *   - `sensitive_payload_*` columns are NEVER touched. The encrypted
 *     URL still belongs to the row so the next delivery tick can
 *     decrypt and send.
 *   - `lock_token` and `locked_at` are cleared. `next_attempt_at` is
 *     set to `now()` so the next lease tick picks the row up
 *     immediately. `error_message` is set to a stable, sanitized
 *     constant — never derived from any user/email/token content.
 *   - The doomed CTE uses `FOR UPDATE SKIP LOCKED` so a recovery
 *     sweep cannot collide with a delivery worker that's already
 *     re-acquired the row.
 */
import type { PoolClient } from "pg";

export interface RecoverStuckSendingInput {
  /** Strict upper bound — rows with `locked_at < cutoff` are recovered.
   *  Rows with `locked_at == cutoff` are KEPT in 'sending' (they're
   *  exactly at the threshold; one more tick gets them). */
  cutoff: Date;
  /** Timestamp written to `next_attempt_at` and `failed_at`. Tests
   *  pass a deterministic value; production passes `new Date()`. */
  now: Date;
  /** Hard cap on rows recovered per call. Bounds the transaction
   *  scope just like the transcript-retention helper. */
  limit: number;
}

export interface RecoverStuckSendingResult {
  /** Count of rows actually moved from 'sending' → 'failed'. */
  recoveredCount: number;
}

/** Stable, sanitized error message stamped into `email_outbox.error_message`
 *  for recovered rows. NEVER derived from user / email body / token / lock
 *  token content — it is a constant so logs and audit derivatives stay
 *  free of accidental leakage. Exported for the recovery service tests
 *  that assert the exact value. */
export const RECOVERY_ERROR_MESSAGE = "worker_recovered_stuck_sending";

/** Recover one batch of stuck 'sending' rows in the current org context.
 *
 *  Returns count only. lock_token / sensitive_payload / message body /
 *  raw token / provider error body are NEVER returned by this helper.
 *  The caller (`services/retention.ts`) only renders an aggregate
 *  audit row with the count; the per-row payload stays inside the DB.
 */
export async function recoverStuckSendingInCurrentOrg(
  client: PoolClient,
  input: RecoverStuckSendingInput,
): Promise<RecoverStuckSendingResult> {
  if (!(input.cutoff instanceof Date) || Number.isNaN(input.cutoff.getTime())) {
    throw new Error(
      "recoverStuckSendingInCurrentOrg: cutoff must be a valid Date",
    );
  }
  if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) {
    throw new Error(
      "recoverStuckSendingInCurrentOrg: now must be a valid Date",
    );
  }
  if (
    typeof input.limit !== "number" ||
    !Number.isFinite(input.limit) ||
    input.limit <= 0
  ) {
    throw new Error(
      "recoverStuckSendingInCurrentOrg: limit must be a positive number",
    );
  }
  const limit = Math.floor(input.limit);

  const r = await client.query<{ id: string }>(
    `WITH stuck AS (
       SELECT id
         FROM email_outbox
        WHERE status     = 'sending'
          AND locked_at IS NOT NULL
          AND locked_at  < $1::timestamptz
        ORDER BY locked_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     UPDATE email_outbox e
        SET status          = 'failed',
            failed_at       = $3::timestamptz,
            error_message   = $4,
            next_attempt_at = $3::timestamptz,
            locked_at       = NULL,
            lock_token      = NULL
       FROM stuck
      WHERE e.id = stuck.id
      RETURNING e.id`,
    [input.cutoff, limit, input.now, RECOVERY_ERROR_MESSAGE],
  );
  return { recoveredCount: r.rowCount ?? r.rows.length };
}

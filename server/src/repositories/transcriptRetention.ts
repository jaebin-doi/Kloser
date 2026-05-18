/* transcripts retention repository — Phase 7 Step 4.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_4_PLAN.md §5.1.
 *
 * Helper exposed for the retention worker only. NEVER called from a
 * route handler — exposing per-row "deleted N transcripts" to users
 * is policy data, not user-facing data.
 *
 * Contract:
 *   - Caller MUST run this inside `app.withOrgContext(orgId, ...)`. The
 *     `transcripts` table has FORCE RLS (migration 1715000010000), so
 *     the DELETE intentionally has NO `org_id = $x` predicate — RLS
 *     pins org_id via `current_app_org_id()`. A bare pool client with
 *     no `app.org_id` GUC deletes zero rows (and is the trap for any
 *     future caller that forgets the context wrapper).
 *
 *   - Transcript text is NEVER returned. Only counts and timestamps
 *     leave this helper. The CTE / RETURNING set is deliberately
 *     `created_at` only, so neither the per-row text nor speaker
 *     identity leaks into the caller's memory (and through it into
 *     audit payloads or logs).
 *
 *   - The doomed CTE uses `FOR UPDATE SKIP LOCKED` so multiple worker
 *     processes (or a future per-org parallel worker) can run the
 *     same sweep without blocking on rows another worker is already
 *     deleting. Combined with the batch LIMIT, this caps the
 *     transaction scope: each call deletes at most `limit` rows, no
 *     long-running locks.
 *
 *   - Cutoff is a JS `Date`. PostgreSQL parses it as timestamptz
 *     unambiguously when bound as `$1::timestamptz`. The `<` predicate
 *     is strict — a transcript with `created_at == cutoff` is kept
 *     (last-day boundary belongs to the retained window).
 *
 * Why hard delete:
 *   `transcripts` has no soft-delete column. Phase 4 Step 1 schema
 *   commits made transcripts append-only with no `deleted_at`; the
 *   parent `calls` row carries the deletion semantics. Retention here
 *   means "the recording-equivalent raw conversation expires" — the
 *   parent call (its summary / needs / issues / action items) stays.
 */
import type { PoolClient } from "pg";

export interface DeleteExpiredTranscriptsInput {
  /** Strict upper bound — rows with `created_at < cutoff` are deleted.
   *  Rows where `created_at == cutoff` are KEPT (boundary belongs to
   *  the retained window). */
  cutoff: Date;
  /** Hard cap on how many rows this call may delete. The service
   *  layer (`services/retention.ts`) drives the multi-batch loop; the
   *  repo refuses non-positive/non-finite values to avoid an unbounded
   *  DELETE if a caller forgets to clamp. */
  limit: number;
}

export interface DeleteExpiredTranscriptsResult {
  /** Count of rows actually deleted in this call. */
  deletedCount: number;
  /** Oldest `created_at` value among deleted rows, or null when
   *  `deletedCount === 0`. Useful for the service-layer aggregate audit
   *  row (admins want to see the deleted-range bounds, not per-row
   *  timestamps). */
  oldestDeletedAt: Date | null;
  /** Newest `created_at` value among deleted rows, or null when
   *  `deletedCount === 0`. Always `<= cutoff` by construction. */
  newestDeletedAt: Date | null;
}

/** Delete one batch of expired transcripts in the current org context.
 *
 *  Returns counts + bounds only. Transcript text / speaker / call_id
 *  are NEVER returned — the CTE projects only the columns the service
 *  layer needs to render an aggregate audit payload.
 */
export async function deleteExpiredTranscriptsInCurrentOrg(
  client: PoolClient,
  input: DeleteExpiredTranscriptsInput,
): Promise<DeleteExpiredTranscriptsResult> {
  if (!(input.cutoff instanceof Date) || Number.isNaN(input.cutoff.getTime())) {
    throw new Error(
      "deleteExpiredTranscriptsInCurrentOrg: cutoff must be a valid Date",
    );
  }
  if (
    typeof input.limit !== "number" ||
    !Number.isFinite(input.limit) ||
    input.limit <= 0
  ) {
    throw new Error(
      "deleteExpiredTranscriptsInCurrentOrg: limit must be a positive number",
    );
  }
  const limit = Math.floor(input.limit);

  const r = await client.query<{
    deleted_count: number;
    oldest_deleted_at: Date | null;
    newest_deleted_at: Date | null;
  }>(
    `WITH doomed AS (
       SELECT id, created_at
         FROM transcripts
        WHERE created_at < $1::timestamptz
        ORDER BY created_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     ),
     deleted AS (
       DELETE FROM transcripts t
        USING doomed d
        WHERE t.id = d.id
        RETURNING d.created_at AS created_at
     )
     SELECT
       count(*)::int                 AS deleted_count,
       min(created_at)               AS oldest_deleted_at,
       max(created_at)               AS newest_deleted_at
       FROM deleted`,
    [input.cutoff, limit],
  );
  const row = r.rows[0];
  return {
    deletedCount: row?.deleted_count ?? 0,
    oldestDeletedAt: row?.oldest_deleted_at ?? null,
    newestDeletedAt: row?.newest_deleted_at ?? null,
  };
}

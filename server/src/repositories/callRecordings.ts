/* call_recordings repository — Phase 8 Step 2.
 *
 * Plan: docs/plan/phase-8/PHASE_8_STEP_2_PLAN.md §3.
 *
 * call_recordings stores object-storage metadata for recorded audio
 * (Phase 8 Step 1 migration 1715000028000_phase8_call_recordings.sql).
 * The table has FORCE ROW LEVEL SECURITY with policies built on
 * current_app_org_id(), and a composite FK (org_id, call_id) ->
 * calls(org_id, id). Every helper here assumes the caller has wrapped
 * the call in `app.withOrgContext(orgId, fn)` so RLS is the authority
 * for cross-org isolation.
 *
 * Inserts are the exception: the WITH CHECK policy validates the row's
 * org_id against current_app_org_id(), so we take orgId as a separate
 * parameter (mirrors the calls/transcripts repositories). Request bodies
 * therefore cannot inject an org_id.
 *
 * `error_message` is stored verbatim. Callers MUST scrub bucket names,
 * object keys, signed URLs, provider secrets, and raw audio bytes
 * before passing the string here — those values may surface in audit
 * payloads or UI.
 *
 * Hard delete exists for retention worker use (Phase 8 Step 5). User-
 * facing routes (Step 3) should prefer markDeletePending/markDeleted
 * so the row remains for audit until the object store is reconciled.
 */
import type { PoolClient } from "pg";

// ---------- entity + input types ---------- //

export type CallRecordingStatus =
  | "upload_pending"
  | "uploaded"
  | "processing"
  | "available"
  | "delete_pending"
  | "deleted"
  | "failed";

export type RecordingStorageProvider = "local" | "s3" | "minio";

export type RecordingContentType =
  | "audio/webm"
  | "audio/ogg"
  | "audio/mpeg"
  | "audio/mp4"
  | "audio/wav";

export interface CallRecording {
  id: string;
  org_id: string;
  call_id: string;
  status: CallRecordingStatus;
  storage_provider: RecordingStorageProvider;
  storage_bucket: string | null;
  object_key: string;
  object_version: string | null;
  content_type: RecordingContentType;
  codec: string | null;
  duration_seconds: number | null;
  // bigint comes back from pg as string. We parse to number because every
  // foreseeable recording size fits inside Number.MAX_SAFE_INTEGER (2^53).
  // Step 3 will decide whether the route exposes it as number or string.
  size_bytes: number | null;
  checksum_sha256: string | null;
  recorded_at: Date | null;
  uploaded_at: Date | null;
  retention_delete_after: Date | null;
  deleted_at: Date | null;
  error_message: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface CallRecordingCreateInput {
  id?: string | null;
  call_id: string;
  storage_provider: RecordingStorageProvider;
  storage_bucket?: string | null;
  object_key: string;
  content_type: RecordingContentType;
  codec?: string | null;
  recorded_at?: Date | null;
  retention_delete_after?: Date | null;
  metadata?: Record<string, unknown>;
}

export interface CallRecordingFinalizeInput {
  object_version?: string | null;
  duration_seconds?: number | null;
  size_bytes?: number | null;
  checksum_sha256?: string | null;
  uploaded_at?: Date | null;
  metadata?: Record<string, unknown>;
}

export interface CallRecordingFailureInput {
  error_message: string;
  metadata?: Record<string, unknown>;
}

// ---------- column projection ---------- //

const RECORDING_COLUMNS =
  "id, org_id, call_id, status," +
  " storage_provider, storage_bucket, object_key, object_version," +
  " content_type, codec, duration_seconds," +
  // bigint -> string from pg by default. Parse below.
  " size_bytes," +
  " checksum_sha256, recorded_at, uploaded_at, retention_delete_after," +
  " deleted_at, error_message, metadata," +
  " created_at, updated_at";

// pg returns bigint as string. The runtime cost of parsing is negligible
// per row, and the column never exceeds Number.MAX_SAFE_INTEGER for any
// realistic recording. Step 3 may switch the route to expose a string if
// that ever changes.
type RawRow = Omit<CallRecording, "size_bytes" | "metadata"> & {
  size_bytes: string | number | null;
  metadata: Record<string, unknown> | null;
};

function hydrate(row: RawRow): CallRecording {
  let size_bytes: number | null = null;
  if (row.size_bytes !== null && row.size_bytes !== undefined) {
    const parsed =
      typeof row.size_bytes === "number"
        ? row.size_bytes
        : Number.parseInt(row.size_bytes, 10);
    size_bytes = Number.isFinite(parsed) ? parsed : null;
  }
  return {
    ...row,
    size_bytes,
    metadata: row.metadata ?? {},
  };
}

// ---------- write ---------- //

export async function insertUploadPendingInCurrentOrg(
  client: PoolClient,
  orgId: string,
  input: CallRecordingCreateInput,
): Promise<CallRecording> {
  const r = await client.query<RawRow>(
    `INSERT INTO call_recordings (
        id, org_id, call_id, status,
        storage_provider, storage_bucket, object_key,
        content_type, codec, recorded_at,
        retention_delete_after, metadata
     ) VALUES (
        COALESCE($1::uuid, gen_random_uuid()), $2, $3, 'upload_pending',
        $4, $5, $6,
        $7, $8, $9,
        $10, COALESCE($11::jsonb, '{}'::jsonb)
     )
     RETURNING ${RECORDING_COLUMNS}`,
    [
      input.id ?? null,
      orgId,
      input.call_id,
      input.storage_provider,
      input.storage_bucket ?? null,
      input.object_key,
      input.content_type,
      input.codec ?? null,
      input.recorded_at ?? null,
      input.retention_delete_after ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );
  return hydrate(r.rows[0]!);
}

// markUploadedInCurrentOrg moves an upload_pending (or, in the retry
// case, failed) row to 'uploaded' and stamps the finalize metadata. The
// state guard makes "double finalize" return null instead of silently
// overwriting an already-available recording.
export async function markUploadedInCurrentOrg(
  client: PoolClient,
  id: string,
  input: CallRecordingFinalizeInput,
): Promise<CallRecording | null> {
  const r = await client.query<RawRow>(
    `UPDATE call_recordings
        SET status         = 'uploaded',
            object_version = COALESCE($1, object_version),
            duration_seconds = COALESCE($2, duration_seconds),
            size_bytes     = COALESCE($3, size_bytes),
            checksum_sha256 = COALESCE($4, checksum_sha256),
            uploaded_at    = COALESCE($5, now()),
            metadata       = CASE
              WHEN $6::jsonb IS NULL THEN metadata
              ELSE metadata || $6::jsonb
            END,
            error_message  = NULL
      WHERE id = $7
        AND deleted_at IS NULL
        AND status IN ('upload_pending', 'failed')
      RETURNING ${RECORDING_COLUMNS}`,
    [
      input.object_version ?? null,
      input.duration_seconds ?? null,
      input.size_bytes ?? null,
      input.checksum_sha256 ?? null,
      input.uploaded_at ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      id,
    ],
  );
  return r.rows[0] ? hydrate(r.rows[0]) : null;
}

export async function markProcessingInCurrentOrg(
  client: PoolClient,
  id: string,
): Promise<CallRecording | null> {
  const r = await client.query<RawRow>(
    `UPDATE call_recordings
        SET status = 'processing'
      WHERE id = $1
        AND deleted_at IS NULL
        AND status IN ('uploaded', 'processing')
      RETURNING ${RECORDING_COLUMNS}`,
    [id],
  );
  return r.rows[0] ? hydrate(r.rows[0]) : null;
}

export async function markAvailableInCurrentOrg(
  client: PoolClient,
  id: string,
): Promise<CallRecording | null> {
  const r = await client.query<RawRow>(
    `UPDATE call_recordings
        SET status = 'available'
      WHERE id = $1
        AND deleted_at IS NULL
        AND status IN ('uploaded', 'processing', 'available')
      RETURNING ${RECORDING_COLUMNS}`,
    [id],
  );
  return r.rows[0] ? hydrate(r.rows[0]) : null;
}

export async function markFailedInCurrentOrg(
  client: PoolClient,
  id: string,
  input: CallRecordingFailureInput,
): Promise<CallRecording | null> {
  const r = await client.query<RawRow>(
    `UPDATE call_recordings
        SET status        = 'failed',
            error_message = $1,
            metadata      = CASE
              WHEN $2::jsonb IS NULL THEN metadata
              ELSE metadata || $2::jsonb
            END
      WHERE id = $3
        AND deleted_at IS NULL
        AND status <> 'deleted'
      RETURNING ${RECORDING_COLUMNS}`,
    [
      input.error_message,
      input.metadata ? JSON.stringify(input.metadata) : null,
      id,
    ],
  );
  return r.rows[0] ? hydrate(r.rows[0]) : null;
}

export async function markDeletePendingInCurrentOrg(
  client: PoolClient,
  id: string,
): Promise<CallRecording | null> {
  const r = await client.query<RawRow>(
    `UPDATE call_recordings
        SET status = 'delete_pending'
      WHERE id = $1
        AND deleted_at IS NULL
        AND status <> 'deleted'
      RETURNING ${RECORDING_COLUMNS}`,
    [id],
  );
  return r.rows[0] ? hydrate(r.rows[0]) : null;
}

// markDeletedInCurrentOrg tombstones the row. The DB CHECK constraint
// (call_recordings_deleted_status_check) requires deleted_at NOT NULL
// when status='deleted', so we set both atomically.
export async function markDeletedInCurrentOrg(
  client: PoolClient,
  id: string,
  deletedAt: Date,
): Promise<CallRecording | null> {
  const r = await client.query<RawRow>(
    `UPDATE call_recordings
        SET status     = 'deleted',
            deleted_at = $1
      WHERE id = $2
        AND deleted_at IS NULL
      RETURNING ${RECORDING_COLUMNS}`,
    [deletedAt, id],
  );
  return r.rows[0] ? hydrate(r.rows[0]) : null;
}

// hardDeleteInCurrentOrg removes the metadata row entirely. Reserved for
// retention worker use after the object has been removed from storage,
// or for test cleanup. User-facing delete routes should prefer
// markDeletePending -> markDeleted so audit/UI still see the tombstone.
export async function hardDeleteByIdInCurrentOrg(
  client: PoolClient,
  id: string,
): Promise<boolean> {
  const r = await client.query(
    `DELETE FROM call_recordings WHERE id = $1`,
    [id],
  );
  return (r.rowCount ?? 0) > 0;
}

// ---------- read ---------- //

// getByIdInCurrentOrg returns soft-deleted rows too. Routes that should
// hide tombstones use getActiveByIdInCurrentOrg.
export async function getByIdInCurrentOrg(
  client: PoolClient,
  id: string,
): Promise<CallRecording | null> {
  const r = await client.query<RawRow>(
    `SELECT ${RECORDING_COLUMNS} FROM call_recordings
      WHERE id = $1`,
    [id],
  );
  return r.rows[0] ? hydrate(r.rows[0]) : null;
}

export async function getActiveByIdInCurrentOrg(
  client: PoolClient,
  id: string,
): Promise<CallRecording | null> {
  const r = await client.query<RawRow>(
    `SELECT ${RECORDING_COLUMNS} FROM call_recordings
      WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return r.rows[0] ? hydrate(r.rows[0]) : null;
}

export async function lockByIdInCurrentOrg(
  client: PoolClient,
  id: string,
): Promise<CallRecording | null> {
  const r = await client.query<RawRow>(
    `SELECT ${RECORDING_COLUMNS} FROM call_recordings
      WHERE id = $1 AND deleted_at IS NULL
      FOR UPDATE`,
    [id],
  );
  return r.rows[0] ? hydrate(r.rows[0]) : null;
}

// listByCallInCurrentOrg returns null when the call does not exist in
// this org (matches the transcripts pattern: service maps null -> 404,
// [] -> empty list).
export async function listByCallInCurrentOrg(
  client: PoolClient,
  callId: string,
): Promise<CallRecording[] | null> {
  const callRow = await client.query<{ id: string }>(
    `SELECT id FROM calls
      WHERE id = $1 AND deleted_at IS NULL`,
    [callId],
  );
  if (callRow.rows.length === 0) return null;

  const r = await client.query<RawRow>(
    `SELECT ${RECORDING_COLUMNS} FROM call_recordings
      WHERE call_id = $1 AND deleted_at IS NULL
      ORDER BY created_at DESC, id DESC`,
    [callId],
  );
  return r.rows.map(hydrate);
}

export async function listAvailableByCallInCurrentOrg(
  client: PoolClient,
  callId: string,
): Promise<CallRecording[] | null> {
  const callRow = await client.query<{ id: string }>(
    `SELECT id FROM calls
      WHERE id = $1 AND deleted_at IS NULL`,
    [callId],
  );
  if (callRow.rows.length === 0) return null;

  const r = await client.query<RawRow>(
    `SELECT ${RECORDING_COLUMNS} FROM call_recordings
      WHERE call_id = $1
        AND deleted_at IS NULL
        AND status = 'available'
      ORDER BY created_at DESC, id DESC`,
    [callId],
  );
  return r.rows.map(hydrate);
}

// listRetentionCandidatesInCurrentOrg backs the Phase 8 Step 5
// retention worker. It returns rows that have crossed their retention
// horizon and are still in a state safe to delete.
//
// States included: uploaded / available / failed.
// States excluded:
//   - upload_pending : an upload is still in flight; finalize would race the sweeper.
//   - processing     : a future transcoder may still be writing derivatives.
//   - delete_pending : already in user-initiated delete flow; handled by
//                      listDeletePendingRetryCandidatesInCurrentOrg.
//   - deleted        : already tombstoned.
//   - rows with deleted_at IS NOT NULL : tombstoned regardless of status.
//
// Two cutoffs (Phase 8 Step 5 plan §1):
//   - explicitCutoff : applied to rows that have a per-row
//                      retention_delete_after override (legal-hold,
//                      per-tenant policy). Usually `now`.
//   - uploadedBefore : applied to rows that have no per-row override.
//                      Usually `now - recordingRetentionDays`.
//
// Mixing the two into one cutoff value would either delay explicit
// retention by N days, or expire freshly uploaded rows without an
// explicit override on day 0. Using two arguments keeps the policies
// independent.
export interface CallRecordingRetentionCandidateInput {
  /** Cutoff applied to rows whose retention_delete_after column is set.
   *  Usually `now`. */
  explicitCutoff: Date;
  /** Cutoff applied to rows whose retention_delete_after column is NULL.
   *  Usually `now - recordingRetentionDays`. */
  uploadedBefore: Date;
  /** Max rows returned per call. Positive integer; caller is responsible
   *  for the outer batch loop. */
  limit: number;
}

export async function listRetentionCandidatesInCurrentOrg(
  client: PoolClient,
  input: CallRecordingRetentionCandidateInput,
): Promise<CallRecording[]> {
  if (!(input.explicitCutoff instanceof Date) || Number.isNaN(input.explicitCutoff.getTime())) {
    throw new Error(
      "listRetentionCandidatesInCurrentOrg: explicitCutoff must be a valid Date",
    );
  }
  if (!(input.uploadedBefore instanceof Date) || Number.isNaN(input.uploadedBefore.getTime())) {
    throw new Error(
      "listRetentionCandidatesInCurrentOrg: uploadedBefore must be a valid Date",
    );
  }
  if (!Number.isInteger(input.limit) || input.limit <= 0) {
    throw new Error(
      "listRetentionCandidatesInCurrentOrg: limit must be a positive integer",
    );
  }
  const r = await client.query<RawRow>(
    `SELECT ${RECORDING_COLUMNS} FROM call_recordings
      WHERE deleted_at IS NULL
        AND status IN ('uploaded', 'available', 'failed')
        AND (
          (retention_delete_after IS NOT NULL AND retention_delete_after <= $1)
          OR (retention_delete_after IS NULL
              AND uploaded_at IS NOT NULL
              AND uploaded_at <= $2)
        )
      ORDER BY COALESCE(retention_delete_after, uploaded_at) ASC, id ASC
      LIMIT $3`,
    [input.explicitCutoff, input.uploadedBefore, input.limit],
  );
  return r.rows.map(hydrate);
}

// listDeletePendingRetryCandidatesInCurrentOrg returns delete_pending
// rows whose updated_at is older than the supplied cutoff. The
// user-facing DELETE route marks a row `delete_pending` before the
// adapter.deleteObject call; if that storage call fails the row stays
// in this state and the next retention tick retries it.
//
// `olderThan` exists so an in-flight user delete (just marked the row
// pending milliseconds ago) is not double-attempted by the worker.
export interface CallRecordingDeletePendingRetryInput {
  /** Only rows whose updated_at is at or before this instant are
   *  candidates. Usually `now - recordingDeletePendingRetryAfterSec`. */
  olderThan: Date;
  /** Max rows returned per call. Positive integer. */
  limit: number;
}

export async function listDeletePendingRetryCandidatesInCurrentOrg(
  client: PoolClient,
  input: CallRecordingDeletePendingRetryInput,
): Promise<CallRecording[]> {
  if (!(input.olderThan instanceof Date) || Number.isNaN(input.olderThan.getTime())) {
    throw new Error(
      "listDeletePendingRetryCandidatesInCurrentOrg: olderThan must be a valid Date",
    );
  }
  if (!Number.isInteger(input.limit) || input.limit <= 0) {
    throw new Error(
      "listDeletePendingRetryCandidatesInCurrentOrg: limit must be a positive integer",
    );
  }
  const r = await client.query<RawRow>(
    `SELECT ${RECORDING_COLUMNS} FROM call_recordings
      WHERE deleted_at IS NULL
        AND status = 'delete_pending'
        AND updated_at <= $1
      ORDER BY updated_at ASC, id ASC
      LIMIT $2`,
    [input.olderThan, input.limit],
  );
  return r.rows.map(hydrate);
}

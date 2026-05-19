/* call_recordings service — Phase 8 Step 3.
 *
 * Plan: docs/plan/phase-8/PHASE_8_STEP_3_PLAN.md §4.
 *
 * Sits between the repository (mechanical SQL + RLS) and the route
 * layer (zod / HTTP). Owns:
 *
 *   - call lookup + assertCanMutateCall (Phase 5 policy)
 *   - object key generation (server-known org/call/recording uuids)
 *   - storage adapter calls (signed URL / put / delete)
 *   - audit hook calls (recordRecording* helpers)
 *   - sanitized response mapping (timestamps → ISO, internal storage
 *     fields stripped)
 *
 * Storage adapter is read from `app.recordingStorage` so tests can
 * inject a local temp-dir adapter without changing env at process start.
 *
 * The service exposes a small set of typed errors. The route layer in
 * routes/callRecordings.ts maps each to a stable HTTP code:
 *
 *   RecordingNotFoundError      → 404 not_found
 *   RecordingInvalidStateError  → 409 invalid_recording_state
 *   RecordingTooLargeError      → 413 recording_too_large
 *
 * Storage adapter errors (RecordingStorageError* from
 * adapters/recordingStorage.ts) propagate up unchanged so the route
 * mapper can recognize their stable codes.
 */
import type { FastifyInstance, FastifyBaseLogger } from "fastify";
import { randomUUID } from "node:crypto";

import * as recordingsRepo from "../repositories/callRecordings.js";
import * as callsRepo from "../repositories/calls.js";
import {
  assertCanMutateCall,
  type Actor,
} from "./callPermissions.js";
import {
  recordRecordingUploadInitiated,
  recordRecordingFinalized,
  recordRecordingPlaybackUrlIssued,
  recordRecordingDeleteRequested,
  recordRecordingDeleted,
} from "./activityLog.js";
import {
  buildRecordingObjectKey,
  RecordingStorageOperationError,
  RECORDING_UPLOAD_TTL_DEFAULT_SECONDS,
  RECORDING_READ_TTL_DEFAULT_SECONDS,
} from "../adapters/recordingStorage.js";
import type {
  CallRecording as CallRecordingRow,
  CallRecordingFinalizeInput as RepoFinalizeInput,
} from "../repositories/callRecordings.js";
import type {
  CallRecording as CallRecordingResponse,
  CallRecordingUploadInput,
  CallRecordingUploadResponse,
  CallRecordingFinalizeInput,
  CallRecordingFinalizeResponse,
  CallRecordingListResponse,
  CallRecordingPlaybackUrlResponse,
  SignedRecordingUrl,
} from "../types/callRecording.js";

// ============================================================ //
// Service errors
// ============================================================ //

export class RecordingNotFoundError extends Error {
  readonly code = "not_found" as const;
  constructor(message = "recording not found") {
    super(message);
    this.name = "RecordingNotFoundError";
  }
}

export class RecordingInvalidStateError extends Error {
  readonly code = "invalid_recording_state" as const;
  constructor(
    readonly currentStatus: CallRecordingRow["status"],
    message = "recording is not in a valid state for this operation",
  ) {
    super(message);
    this.name = "RecordingInvalidStateError";
  }
}

export class RecordingTooLargeError extends Error {
  readonly code = "recording_too_large" as const;
  constructor(
    readonly attempted: number,
    readonly limit: number,
    message = "recording exceeds size limit",
  ) {
    super(message);
    this.name = "RecordingTooLargeError";
  }
}

// ============================================================ //
// Constants
// ============================================================ //

// Hard ceiling on a single recording's size_bytes. 250 MB is well above
// a 4-hour mono Opus call (~28 MB) while still small enough to make a
// runaway upload obvious. Operators can override via env.
export const RECORDING_UPLOAD_MAX_BYTES_DEFAULT = 250 * 1024 * 1024;

function resolveMaxUploadBytes(): number {
  const raw = process.env.RECORDING_UPLOAD_MAX_BYTES;
  if (!raw || raw.trim() === "") return RECORDING_UPLOAD_MAX_BYTES_DEFAULT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return RECORDING_UPLOAD_MAX_BYTES_DEFAULT;
  return n;
}

// ============================================================ //
// Response mapper
// ============================================================ //

function toCallRecordingResponse(row: CallRecordingRow): CallRecordingResponse {
  return {
    id: row.id,
    call_id: row.call_id,
    status: row.status,
    content_type: row.content_type,
    codec: row.codec,
    duration_seconds: row.duration_seconds,
    size_bytes: row.size_bytes,
    recorded_at: row.recorded_at ? row.recorded_at.toISOString() : null,
    uploaded_at: row.uploaded_at ? row.uploaded_at.toISOString() : null,
    deleted_at: row.deleted_at ? row.deleted_at.toISOString() : null,
    error_message: row.error_message,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function toSignedUrl(signed: {
  url: string;
  method: "GET" | "PUT";
  headers: Record<string, string>;
  expiresAt: Date;
}): SignedRecordingUrl {
  return {
    method: signed.method,
    url: signed.url,
    headers: signed.headers,
    expires_at: signed.expiresAt.toISOString(),
  };
}

// ============================================================ //
// initiateRecordingUpload
// ============================================================ //
//
// Flow:
//   1. Open transaction with (orgId, actorUserId) GUC so RLS scopes
//      reads + writes correctly and recordRecording* audit helpers can
//      attribute the actor.
//   2. Look up the parent call (RLS hides cross-org calls → null →
//      RecordingNotFoundError).
//   3. assertCanMutateCall — viewer / employee-non-owner / manager-
//      wrong-team / manager-unassigned all throw PermissionError, which
//      the route layer maps to 403.
//   4. Enforce route-level size cap (DB does not constrain this; the
//      cap is operator policy).
//   5. Mint a server-known object key with buildRecordingObjectKey.
//   6. Insert metadata row in upload_pending status.
//   7. Audit recording.upload_initiated in the same transaction.
//   8. Generate signed PUT URL via the storage adapter.
//   9. Return the response. Upload URL bytes go straight to the
//      adapter's bucket; finalize is called by the client after the
//      PUT succeeds.

export async function initiateRecordingUpload(
  app: FastifyInstance,
  actor: Actor,
  callId: string,
  input: CallRecordingUploadInput,
): Promise<CallRecordingUploadResponse> {
  const maxBytes = resolveMaxUploadBytes();
  if (
    input.size_bytes !== undefined &&
    input.size_bytes !== null &&
    input.size_bytes > maxBytes
  ) {
    throw new RecordingTooLargeError(input.size_bytes, maxBytes);
  }

  const recordingId = randomUUID();
  const now = new Date();
  const objectKey = buildRecordingObjectKey({
    orgId: actor.orgId,
    callId,
    recordingId,
    contentType: input.content_type,
    now,
  });

  const row = await app.withOrgContext(
    actor.orgId,
    actor.id,
    async (client) => {
      const call = await callsRepo.lockByIdInCurrentOrg(client, callId);
      if (!call) {
        throw new RecordingNotFoundError("parent call not found");
      }
      await assertCanMutateCall(client, actor, {
        agent_user_id: call.agent_user_id,
      });
      const inserted = await recordingsRepo.insertUploadPendingInCurrentOrg(
        client,
        actor.orgId,
        {
          id: recordingId,
          call_id: callId,
          storage_provider: app.recordingStorage.provider,
          // Service does not expose bucket name on response; the row
          // keeps it null when adapter manages bucket internally (the
          // S3 adapter holds its bucket inside the SDK client).
          storage_bucket: null,
          object_key: objectKey,
          content_type: input.content_type,
          codec: input.codec ?? null,
          recorded_at: input.recorded_at
            ? new Date(input.recorded_at)
            : null,
        },
      );
      await recordRecordingUploadInitiated(client, {
        orgId:           actor.orgId,
        actorUserId:     actor.id,
        callId:          inserted.call_id,
        recordingId:     inserted.id,
        contentType:     inserted.content_type,
        sizeBytes:       input.size_bytes ?? null,
        durationSeconds: input.duration_seconds ?? null,
        ttlSeconds:      RECORDING_UPLOAD_TTL_DEFAULT_SECONDS,
      });
      return inserted;
    },
  );

  const signed = await app.recordingStorage.createUploadUrl({
    bucket: null,
    objectKey,
    contentType: input.content_type,
    expiresInSeconds: RECORDING_UPLOAD_TTL_DEFAULT_SECONDS,
    sizeBytes: input.size_bytes ?? null,
    checksumSha256: input.checksum_sha256 ?? null,
  });

  return {
    recording: toCallRecordingResponse(row),
    upload: toSignedUrl(signed),
  };
}

// ============================================================ //
// finalizeRecordingUpload
// ============================================================ //
//
// Flow:
//   1. Open transaction with (orgId, actorUserId).
//   2. Look up the parent call (cross-org → 404).
//   3. assertCanMutateCall.
//   4. Lock the recording row by id. Cross-org or already-deleted → 404.
//   5. Verify recording.call_id === route's callId. Mismatch → 404 (do
//      not leak whether the recording exists under a different call).
//   6. Enforce size cap (defense in depth — client-supplied at finalize).
//   7. Reject finalize on deleted / delete_pending. The repo state guard
//      additionally rejects already-uploaded/available rows; we treat
//      those as RecordingInvalidStateError so the client sees 409.
//   8. markUploaded → markAvailable for v1 (no transcoding pipeline).
//   9. Audit recording.finalized in same transaction.

export async function finalizeRecordingUpload(
  app: FastifyInstance,
  actor: Actor,
  callId: string,
  recordingId: string,
  input: CallRecordingFinalizeInput,
): Promise<CallRecordingFinalizeResponse> {
  const maxBytes = resolveMaxUploadBytes();
  if (
    input.size_bytes !== undefined &&
    input.size_bytes !== null &&
    input.size_bytes > maxBytes
  ) {
    throw new RecordingTooLargeError(input.size_bytes, maxBytes);
  }

  const row = await app.withOrgContext(
    actor.orgId,
    actor.id,
    async (client) => {
      const call = await callsRepo.lockByIdInCurrentOrg(client, callId);
      if (!call) {
        throw new RecordingNotFoundError("parent call not found");
      }
      await assertCanMutateCall(client, actor, {
        agent_user_id: call.agent_user_id,
      });

      const existing = await recordingsRepo.lockByIdInCurrentOrg(
        client,
        recordingId,
      );
      if (!existing || existing.call_id !== callId) {
        // Either cross-org (RLS hid the row), already tombstoned, or the
        // (callId, recordingId) pair doesn't match. All collapse to 404
        // so the caller cannot probe for recording existence under
        // other calls.
        throw new RecordingNotFoundError();
      }
      if (
        existing.status === "deleted" ||
        existing.status === "delete_pending"
      ) {
        // markUploaded would already refuse, but we surface the typed
        // error here so the route returns a meaningful 409 rather than
        // a generic 404.
        throw new RecordingInvalidStateError(existing.status);
      }
      const finalizeInput: RepoFinalizeInput = {
        duration_seconds: input.duration_seconds ?? null,
        size_bytes: input.size_bytes ?? null,
        checksum_sha256: input.checksum_sha256 ?? null,
        object_version: input.object_version ?? null,
      };
      const uploaded = await recordingsRepo.markUploadedInCurrentOrg(
        client,
        recordingId,
        finalizeInput,
      );
      if (!uploaded) {
        // Repo state guard refused (already uploaded/available) — surface
        // as 409 instead of 404 so the client can react.
        throw new RecordingInvalidStateError(existing.status);
      }
      const available = await recordingsRepo.markAvailableInCurrentOrg(
        client,
        recordingId,
      );
      const finalRow = available ?? uploaded;
      await recordRecordingFinalized(client, {
        orgId:           actor.orgId,
        actorUserId:     actor.id,
        callId:          finalRow.call_id,
        recordingId:     finalRow.id,
        contentType:     finalRow.content_type,
        sizeBytes:       finalRow.size_bytes,
        durationSeconds: finalRow.duration_seconds,
      });
      return finalRow;
    },
  );

  return { recording: toCallRecordingResponse(row) };
}

// ============================================================ //
// listCallRecordings
// ============================================================ //
//
// Read-only. Same-org authenticated role can read; cross-org returns
// null so the route maps to 404. tombstoned rows are hidden.

export async function listCallRecordings(
  app: FastifyInstance,
  actorOrgId: string,
  callId: string,
): Promise<CallRecordingListResponse | null> {
  return app.withOrgContext(actorOrgId, async (client) => {
    const rows = await recordingsRepo.listByCallInCurrentOrg(client, callId);
    if (rows === null) return null;
    return { items: rows.map(toCallRecordingResponse) };
  });
}

// ============================================================ //
// createRecordingPlaybackUrl
// ============================================================ //
//
// Only `status='available'` AND `deleted_at IS NULL` rows are playable.
// Other lifecycle states return RecordingInvalidStateError (409) so the
// client can distinguish "still processing" from "gone".

export async function createRecordingPlaybackUrl(
  app: FastifyInstance,
  actorOrgId: string,
  actorUserId: string,
  callId: string,
  recordingId: string,
): Promise<CallRecordingPlaybackUrlResponse> {
  const recording = await app.withOrgContext(
    actorOrgId,
    actorUserId,
    async (client) => {
      const call = await callsRepo.getByIdInCurrentOrg(client, callId);
      if (!call) throw new RecordingNotFoundError("parent call not found");

      const row = await recordingsRepo.getActiveByIdInCurrentOrg(
        client,
        recordingId,
      );
      if (!row || row.call_id !== callId) {
        throw new RecordingNotFoundError();
      }
      if (row.status !== "available") {
        throw new RecordingInvalidStateError(row.status);
      }
      await recordRecordingPlaybackUrlIssued(client, {
        orgId:       actorOrgId,
        actorUserId,
        callId:      row.call_id,
        recordingId: row.id,
        ttlSeconds:  RECORDING_READ_TTL_DEFAULT_SECONDS,
      });
      return row;
    },
  );

  const signed = await app.recordingStorage.createReadUrl({
    bucket: null,
    objectKey: recording.object_key,
    expiresInSeconds: RECORDING_READ_TTL_DEFAULT_SECONDS,
    responseContentType: recording.content_type,
  });

  return { playback: toSignedUrl(signed) };
}

// ============================================================ //
// deleteRecording
// ============================================================ //
//
// Two-phase delete with audit on both transitions:
//
//   tx1:
//     - assertCanMutateCall against parent call
//     - load + lock the recording row
//     - already-deleted → 404 (idempotent from caller's perspective)
//     - already-delete_pending → continue (caller can retry the object
//       deletion)
//     - markDeletePendingInCurrentOrg
//     - recordRecordingDeleteRequested (with previous_status)
//
//   between tx1 and tx2:
//     - adapter.deleteObject. ObjectNotFound is idempotent success.
//       Any other RecordingStorageOperationError propagates so the
//       route returns 502. The DB row stays in delete_pending; a future
//       retention sweep / reconciliation worker (Step 5) can retry.
//
//   tx2:
//     - markDeletedInCurrentOrg (status='deleted', deleted_at=now)
//     - recordRecordingDeleted

export interface DeleteRecordingResult {
  deleted: boolean;
}

export async function deleteRecording(
  app: FastifyInstance,
  actor: Actor,
  callId: string,
  recordingId: string,
): Promise<DeleteRecordingResult> {
  const tx1 = await app.withOrgContext(
    actor.orgId,
    actor.id,
    async (client) => {
      const call = await callsRepo.lockByIdInCurrentOrg(client, callId);
      if (!call) throw new RecordingNotFoundError("parent call not found");
      await assertCanMutateCall(client, actor, {
        agent_user_id: call.agent_user_id,
      });

      const existing = await recordingsRepo.lockByIdInCurrentOrg(
        client,
        recordingId,
      );
      // lockByIdInCurrentOrg filters `deleted_at IS NULL`, so an
      // already-tombstoned recording surfaces as null → 404. That
      // matches the call_action_items DELETE contract: once the row is
      // gone from the user-facing surface, a second DELETE is 404, not
      // 204. The DB row stays for audit.
      if (!existing || existing.call_id !== callId) {
        throw new RecordingNotFoundError();
      }
      const previousStatus = existing.status;
      const pending = await recordingsRepo.markDeletePendingInCurrentOrg(
        client,
        recordingId,
      );
      if (!pending) {
        throw new RecordingInvalidStateError(existing.status);
      }
      await recordRecordingDeleteRequested(client, {
        orgId:          actor.orgId,
        actorUserId:    actor.id,
        callId:         pending.call_id,
        recordingId:    pending.id,
        previousStatus,
      });
      return { existing: pending };
    },
  );

  // Object deletion is outside the DB transaction. Storage failure here
  // leaves the row in `delete_pending`, surfacing as a 502 from the
  // route mapper. The retention worker (Phase 8 Step 5) is responsible
  // for retrying.
  try {
    await app.recordingStorage.deleteObject({
      bucket: null,
      objectKey: tx1.existing.object_key,
      objectVersion: tx1.existing.object_version,
    });
  } catch (err) {
    if (
      err instanceof RecordingStorageOperationError &&
      err.code === "storage_object_not_found"
    ) {
      // Object already absent — idempotent. Tombstone the row anyway.
      logStorageEvent(app.log, "delete_object_absent", tx1.existing.id);
    } else {
      throw err;
    }
  }

  await app.withOrgContext(actor.orgId, actor.id, async (client) => {
    const deleted = await recordingsRepo.markDeletedInCurrentOrg(
      client,
      recordingId,
      new Date(),
    );
    if (!deleted) {
      // Another transaction beat us to the tombstone. Still a successful
      // outcome from the caller's perspective.
      return;
    }
    await recordRecordingDeleted(client, {
      orgId:       actor.orgId,
      actorUserId: actor.id,
      callId:      deleted.call_id,
      recordingId: deleted.id,
    });
  });

  return { deleted: true };
}

function logStorageEvent(
  log: FastifyBaseLogger,
  event: string,
  recordingId: string,
): void {
  // Never log object_key, bucket, signed URLs, or audio bytes. The
  // recording id is internal and safe; we use it for retention worker
  // diagnostics.
  log.info({ event, recording_id: recordingId }, "recording storage event");
}

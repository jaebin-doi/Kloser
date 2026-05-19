/* call_recordings shared types — Phase 8 Step 3.
 *
 * Plan: docs/plan/phase-8/PHASE_8_STEP_3_PLAN.md §3.
 *
 * Server source-of-truth for the recording REST surface. Browser keeps a
 * JSDoc mirror at platform/types/callRecording.js.
 * test/sync_shared_types.mjs diffs the field sets via the entity registry.
 *
 * Sync target schemas (top-level `export const X = z.object({ ... })`
 * literals, no .extend / .merge / .partial / satisfies):
 *   - CallRecording
 *   - CallRecordingUploadInput
 *   - CallRecordingUploadResponse
 *   - CallRecordingFinalizeInput
 *   - CallRecordingFinalizeResponse
 *   - CallRecordingListResponse
 *   - CallRecordingPlaybackUrlResponse
 *
 * Wire response shape:
 *   - timestamps are ISO 8601 strings (route mapper converts the Date
 *     columns; clients see strings).
 *   - object_key, storage_bucket, storage_provider, object_version,
 *     checksum_sha256, metadata, org_id are NOT exposed. These are
 *     internal locators / config / operational data and stay backend.
 */
import { z } from "zod";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UuidString = z.string().regex(UUID_RE, "invalid uuid");
const Sha256HexString = z.string().regex(/^[0-9a-f]{64}$/, "invalid sha256");

export const CallRecordingStatus = z.enum([
  "upload_pending",
  "uploaded",
  "processing",
  "available",
  "delete_pending",
  "deleted",
  "failed",
]);
export type CallRecordingStatus = z.infer<typeof CallRecordingStatus>;

export const RecordingContentType = z.enum([
  "audio/webm",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
]);
export type RecordingContentType = z.infer<typeof RecordingContentType>;

// ---------- entity ---------- //

export const CallRecording = z.object({
  id: UuidString,
  call_id: UuidString,
  status: CallRecordingStatus,
  content_type: RecordingContentType,
  codec: z.string().nullable(),
  duration_seconds: z.number().int().nonnegative().nullable(),
  size_bytes: z.number().int().nonnegative().nullable(),
  recorded_at: z.string().nullable(),
  uploaded_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
  error_message: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type CallRecording = z.infer<typeof CallRecording>;

// ---------- inputs ---------- //

export const CallRecordingUploadInput = z.object({
  content_type: RecordingContentType,
  codec: z.string().max(80).nullable().optional(),
  recorded_at: z.string().datetime().nullable().optional(),
  duration_seconds: z.number().int().nonnegative().nullable().optional(),
  size_bytes: z.number().int().nonnegative().nullable().optional(),
  checksum_sha256: Sha256HexString.nullable().optional(),
});
export type CallRecordingUploadInput = z.infer<typeof CallRecordingUploadInput>;

export const CallRecordingFinalizeInput = z.object({
  object_version: z.string().max(256).nullable().optional(),
  duration_seconds: z.number().int().nonnegative().nullable().optional(),
  size_bytes: z.number().int().nonnegative().nullable().optional(),
  checksum_sha256: Sha256HexString.nullable().optional(),
});
export type CallRecordingFinalizeInput = z.infer<typeof CallRecordingFinalizeInput>;

// ---------- responses ---------- //

// Signed URL response shape used by upload + playback. Method is exposed
// because PUT and GET need different client treatment.
export const SignedRecordingUrl = z.object({
  method: z.enum(["PUT", "GET"]),
  url: z.string(),
  headers: z.record(z.string(), z.string()),
  expires_at: z.string(),
});
export type SignedRecordingUrl = z.infer<typeof SignedRecordingUrl>;

export const CallRecordingUploadResponse = z.object({
  recording: CallRecording,
  upload: SignedRecordingUrl,
});
export type CallRecordingUploadResponse = z.infer<typeof CallRecordingUploadResponse>;

export const CallRecordingFinalizeResponse = z.object({
  recording: CallRecording,
});
export type CallRecordingFinalizeResponse = z.infer<typeof CallRecordingFinalizeResponse>;

export const CallRecordingListResponse = z.object({
  items: z.array(CallRecording),
});
export type CallRecordingListResponse = z.infer<typeof CallRecordingListResponse>;

export const CallRecordingPlaybackUrlResponse = z.object({
  playback: SignedRecordingUrl,
});
export type CallRecordingPlaybackUrlResponse = z.infer<typeof CallRecordingPlaybackUrlResponse>;

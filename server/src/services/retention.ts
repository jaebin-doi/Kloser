/* retention service — Phase 7 Step 4.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_4_PLAN.md §6.
 *
 * Two responsibilities:
 *
 *   1. Load + validate retention config from env. Invalid env throws
 *      `RetentionConfigError` so the worker boot fails fast — silent
 *      fallback to "no retention" would be a compliance failure.
 *
 *   2. Run the actual sweep per org:
 *        - delete expired transcripts in batches, up to
 *          maxBatchesPerOrg per tick
 *        - recover stuck-sending email_outbox rows once per tick
 *        - record one aggregate audit row per kind (transcript /
 *          email) only when count > 0
 *
 * Audit payload hygiene (Plan §3.4 / §8.1):
 *
 *   - aggregate-only — never per-row.
 *   - actor is null (system); `actor_type='system'` in payload.
 *   - payload keys are summary stats (counts, cutoff iso, days /
 *     batch size). NO raw token, NO email body, NO transcript text,
 *     NO ciphertext, NO lock token, NO error body. The `services/
 *     activityLog.ts` sanitizer would reject any value under a key
 *     containing `token` / `secret` / `password` / `ciphertext` /
 *     `key` / `raw`, so this layer keys things by safe nouns:
 *     `deleted_count`, `recovered_count`, `retention_days`,
 *     `stuck_after_seconds`.
 *
 * Failure isolation:
 *
 *   - `runRetentionTick` catches per-org errors and continues. One
 *     poisoned org never blocks the others. Failed org ids surface in
 *     the tick result (with sanitized error name only — no message
 *     body to keep PG / Resend internals out of logs).
 */
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import {
  deleteExpiredTranscriptsInCurrentOrg,
  type DeleteExpiredTranscriptsResult,
} from "../repositories/transcriptRetention.js";
import {
  recoverStuckSendingInCurrentOrg,
  type RecoverStuckSendingResult,
} from "../repositories/emailOutboxRecovery.js";
import {
  listRetentionCandidatesInCurrentOrg,
  listDeletePendingRetryCandidatesInCurrentOrg,
  markDeletedInCurrentOrg,
  type CallRecording,
  type RecordingStorageProvider,
} from "../repositories/callRecordings.js";
import { RecordingStorageOperationError } from "../adapters/recordingStorage.js";
import { recordActivity } from "./activityLog.js";
import { listAllOrgIds } from "../repositories/orgs.js";

// ============================================================ //
// Config
// ============================================================ //

export interface RetentionConfig {
  /** Master enable flag. Drives ONLY the scheduler / repeatable job.
   *  When false, the worker processor is still callable (tests + manual
   *  runs go through it) but `enabled === false` makes it a no-op. */
  enabled: boolean;
  /** Repeatable tick interval. Validated to a sane range so a mis-set
   *  env can't accidentally hammer the DB once a second. */
  intervalSec: number;
  /** Transcript retention period in days. Default 3 years. */
  transcriptRetentionDays: number;
  /** Max transcripts deleted per repository call. */
  transcriptBatchSize: number;
  /** Max repository calls per org per tick. The total bound on rows
   *  deleted per org per tick is `transcriptBatchSize * maxBatchesPerOrg`. */
  maxBatchesPerOrg: number;
  /** A row is considered "stuck in sending" if its `locked_at` is older
   *  than `now() - emailStuckSendingAfterSec`. */
  emailStuckSendingAfterSec: number;
  /** Max rows recovered per org per tick. Keeps the recovery
   *  transaction bounded. */
  emailRecoveryBatchSize: number;
  // Phase 8 Step 5 — call recording retention.
  /** Recording retention period in days for rows without an explicit
   *  `retention_delete_after` override. Default 90. */
  recordingRetentionDays: number;
  /** Max rows per repository call for both normal expiry and
   *  delete_pending retry. Recording deletion incurs an object-storage
   *  HTTP call per row, so this is intentionally smaller than the
   *  transcript batch size. */
  recordingBatchSize: number;
  /** A `delete_pending` row whose `updated_at` is older than
   *  `now - recordingDeletePendingRetryAfterSec` is retried by the
   *  worker. The floor prevents racing in-flight user delete requests. */
  recordingDeletePendingRetryAfterSec: number;
}

export class RetentionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetentionConfigError";
  }
}

// Default values — match Plan §3.2 / §3.3.
const DEFAULT_INTERVAL_SEC = 86400; // 1 day
const DEFAULT_TRANSCRIPT_DAYS = 1095; // 3 years
const DEFAULT_TRANSCRIPT_BATCH_SIZE = 500;
const DEFAULT_MAX_BATCHES_PER_ORG = 20;
const DEFAULT_EMAIL_STUCK_AFTER_SEC = 900; // 15 minutes
const DEFAULT_EMAIL_RECOVERY_BATCH_SIZE = 200;
// Phase 8 Step 5 — recording retention defaults.
const DEFAULT_RECORDING_DAYS = 90;
const DEFAULT_RECORDING_BATCH_SIZE = 100;
const DEFAULT_RECORDING_DELETE_PENDING_RETRY_SEC = 900; // 15 minutes

// Sane ranges — Plan §6 "Config validation".
const INTERVAL_MIN = 60;
const INTERVAL_MAX = 86400;
const TRANSCRIPT_DAYS_MIN = 1;
const TRANSCRIPT_DAYS_MAX = 36500; // 100 years — generous upper bound
const TRANSCRIPT_BATCH_MIN = 1;
const TRANSCRIPT_BATCH_MAX = 5000;
const MAX_BATCHES_MIN = 1;
const MAX_BATCHES_MAX = 100;
const EMAIL_STUCK_MIN = 60;
const EMAIL_STUCK_MAX = 86400;
const EMAIL_RECOVERY_BATCH_MIN = 1;
const EMAIL_RECOVERY_BATCH_MAX = 5000;
const RECORDING_DAYS_MIN = 1;
const RECORDING_DAYS_MAX = 36500;
const RECORDING_BATCH_MIN = 1;
const RECORDING_BATCH_MAX = 1000;
const RECORDING_DELETE_PENDING_RETRY_MIN = 60;
const RECORDING_DELETE_PENDING_RETRY_MAX = 86400;

function parseBoolEnv(raw: string | undefined): boolean {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return false;
  }
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new RetentionConfigError(
    `KLOSER_RETENTION_ENABLED must be a boolean-like value, got: ${raw}`,
  );
}

function parsePositiveIntInRange(
  raw: string | undefined,
  fallback: number,
  fieldName: string,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return fallback;
  }
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) {
    throw new RetentionConfigError(
      `${fieldName} must be an integer in [${min}, ${max}], got: ${raw}`,
    );
  }
  const n = Number.parseInt(text, 10);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new RetentionConfigError(
      `${fieldName} must be an integer in [${min}, ${max}], got: ${raw}`,
    );
  }
  return n;
}

/** Load retention config from process.env (or an injected env map for
 *  tests). Throws RetentionConfigError on out-of-range values. Always
 *  returns a config object, even with `enabled === false`, so the
 *  worker processor can still be invoked deterministically from tests. */
export function loadRetentionConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RetentionConfig {
  return {
    enabled: parseBoolEnv(env.KLOSER_RETENTION_ENABLED),
    intervalSec: parsePositiveIntInRange(
      env.KLOSER_RETENTION_INTERVAL_SEC,
      DEFAULT_INTERVAL_SEC,
      "KLOSER_RETENTION_INTERVAL_SEC",
      INTERVAL_MIN,
      INTERVAL_MAX,
    ),
    transcriptRetentionDays: parsePositiveIntInRange(
      env.KLOSER_RETENTION_TRANSCRIPT_DAYS,
      DEFAULT_TRANSCRIPT_DAYS,
      "KLOSER_RETENTION_TRANSCRIPT_DAYS",
      TRANSCRIPT_DAYS_MIN,
      TRANSCRIPT_DAYS_MAX,
    ),
    transcriptBatchSize: parsePositiveIntInRange(
      env.KLOSER_RETENTION_TRANSCRIPT_BATCH_SIZE,
      DEFAULT_TRANSCRIPT_BATCH_SIZE,
      "KLOSER_RETENTION_TRANSCRIPT_BATCH_SIZE",
      TRANSCRIPT_BATCH_MIN,
      TRANSCRIPT_BATCH_MAX,
    ),
    maxBatchesPerOrg: parsePositiveIntInRange(
      env.KLOSER_RETENTION_MAX_BATCHES_PER_ORG,
      DEFAULT_MAX_BATCHES_PER_ORG,
      "KLOSER_RETENTION_MAX_BATCHES_PER_ORG",
      MAX_BATCHES_MIN,
      MAX_BATCHES_MAX,
    ),
    emailStuckSendingAfterSec: parsePositiveIntInRange(
      env.KLOSER_EMAIL_STUCK_SENDING_AFTER_SEC,
      DEFAULT_EMAIL_STUCK_AFTER_SEC,
      "KLOSER_EMAIL_STUCK_SENDING_AFTER_SEC",
      EMAIL_STUCK_MIN,
      EMAIL_STUCK_MAX,
    ),
    emailRecoveryBatchSize: parsePositiveIntInRange(
      env.KLOSER_EMAIL_STUCK_RECOVERY_BATCH_SIZE,
      DEFAULT_EMAIL_RECOVERY_BATCH_SIZE,
      "KLOSER_EMAIL_STUCK_RECOVERY_BATCH_SIZE",
      EMAIL_RECOVERY_BATCH_MIN,
      EMAIL_RECOVERY_BATCH_MAX,
    ),
    // Phase 8 Step 5 — recording retention envs.
    recordingRetentionDays: parsePositiveIntInRange(
      env.KLOSER_RETENTION_RECORDING_DAYS,
      DEFAULT_RECORDING_DAYS,
      "KLOSER_RETENTION_RECORDING_DAYS",
      RECORDING_DAYS_MIN,
      RECORDING_DAYS_MAX,
    ),
    recordingBatchSize: parsePositiveIntInRange(
      env.KLOSER_RETENTION_RECORDING_BATCH_SIZE,
      DEFAULT_RECORDING_BATCH_SIZE,
      "KLOSER_RETENTION_RECORDING_BATCH_SIZE",
      RECORDING_BATCH_MIN,
      RECORDING_BATCH_MAX,
    ),
    recordingDeletePendingRetryAfterSec: parsePositiveIntInRange(
      env.KLOSER_RETENTION_RECORDING_DELETE_PENDING_RETRY_AFTER_SEC,
      DEFAULT_RECORDING_DELETE_PENDING_RETRY_SEC,
      "KLOSER_RETENTION_RECORDING_DELETE_PENDING_RETRY_AFTER_SEC",
      RECORDING_DELETE_PENDING_RETRY_MIN,
      RECORDING_DELETE_PENDING_RETRY_MAX,
    ),
  };
}

// ============================================================ //
// Per-org runner
// ============================================================ //

export interface RetentionOrgResult {
  orgId: string;
  transcriptsDeleted: number;
  transcriptBatches: number;
  emailOutboxRecovered: number;
  // Phase 8 Step 5 — call recording sweep aggregates.
  recordingsDeleted: number;
  recordingBatches: number;
  recordingObjectNotFound: number;
  recordingDeleteFailures: number;
  recordingDeletePendingRetried: number;
}

/** Run the full Step 4 sweep for ONE org under its own withOrgContext.
 *
 *  Order inside the transaction matters:
 *    1. Loop: delete expired transcripts in batches until count is 0
 *       OR maxBatchesPerOrg reached. Each batch is one repo call inside
 *       the same outer transaction (Plan §6 decision: one org tx
 *       containing all batches + audit row).
 *    2. Recover stuck email_outbox 'sending' rows once.
 *    3. recordActivity for transcript deletes (count > 0 only).
 *    4. recordActivity for email recovery (count > 0 only).
 *
 *  If ANY step throws, the whole org transaction rolls back — partial
 *  deletes without an audit row are not allowed. The aggregate audit
 *  is part of the same unit of work as the mutation it describes. */
export async function runRetentionForOrg(
  app: FastifyInstance,
  orgId: string,
  config: RetentionConfig,
  now: Date = new Date(),
): Promise<RetentionOrgResult> {
  const transcriptCutoff = new Date(
    now.getTime() - config.transcriptRetentionDays * 24 * 60 * 60 * 1000,
  );
  const emailCutoff = new Date(
    now.getTime() - config.emailStuckSendingAfterSec * 1000,
  );

  // Phase 8 Step 5 — recording sweep runs OUTSIDE the long transcript+email
  // transaction because it issues object storage HTTP calls per row.
  // Holding a DB transaction across network IO is the wrong pattern.
  const transcriptEmail = await app.withOrgContext(orgId, async (client: PoolClient) => {
    // ── Transcript batches ───────────────────────────────────
    let transcriptsDeleted = 0;
    let transcriptBatches = 0;
    for (let batch = 0; batch < config.maxBatchesPerOrg; batch++) {
      const r: DeleteExpiredTranscriptsResult =
        await deleteExpiredTranscriptsInCurrentOrg(client, {
          cutoff: transcriptCutoff,
          limit: config.transcriptBatchSize,
        });
      if (r.deletedCount === 0) break;
      transcriptsDeleted += r.deletedCount;
      transcriptBatches += 1;
      // If we got back fewer than a full batch, the table is drained
      // for this cutoff — bail out early instead of spinning on empty
      // batches.
      if (r.deletedCount < config.transcriptBatchSize) break;
    }

    // ── Email outbox stuck recovery ──────────────────────────
    const rec: RecoverStuckSendingResult = await recoverStuckSendingInCurrentOrg(
      client,
      {
        cutoff: emailCutoff,
        now,
        limit: config.emailRecoveryBatchSize,
      },
    );

    // ── Audit rows — aggregate, only when count > 0 ──────────
    if (transcriptsDeleted > 0) {
      await recordActivity(client, {
        orgId,
        actorUserId: null,
        action: "retention.transcripts_deleted",
        targetType: "organization",
        targetId: orgId,
        payload: {
          actor_type: "system",
          cutoff: transcriptCutoff.toISOString(),
          deleted_count: transcriptsDeleted,
          batch_size: config.transcriptBatchSize,
          batches: transcriptBatches,
          retention_days: config.transcriptRetentionDays,
        },
      });
    }

    if (rec.recoveredCount > 0) {
      await recordActivity(client, {
        orgId,
        actorUserId: null,
        action: "email_outbox.sending_recovered",
        targetType: "organization",
        targetId: orgId,
        payload: {
          actor_type: "system",
          cutoff: emailCutoff.toISOString(),
          recovered_count: rec.recoveredCount,
          stuck_after_seconds: config.emailStuckSendingAfterSec,
        },
      });
    }

    return {
      transcriptsDeleted,
      transcriptBatches,
      emailOutboxRecovered: rec.recoveredCount,
    };
  });

  // Recording sweep — separate per-row short transactions after the
  // adapter object delete. Failures from one recording must not roll
  // back transcripts/email work that already committed above.
  const recordingResult = await runRecordingRetentionForOrg(
    app,
    orgId,
    config,
    now,
  );

  return {
    orgId,
    transcriptsDeleted: transcriptEmail.transcriptsDeleted,
    transcriptBatches: transcriptEmail.transcriptBatches,
    emailOutboxRecovered: transcriptEmail.emailOutboxRecovered,
    recordingsDeleted: recordingResult.recordingsDeleted,
    recordingBatches: recordingResult.recordingBatches,
    recordingObjectNotFound: recordingResult.recordingObjectNotFound,
    recordingDeleteFailures: recordingResult.recordingDeleteFailures,
    recordingDeletePendingRetried: recordingResult.recordingDeletePendingRetried,
  };
}

// ============================================================ //
// Recording retention sweep (Phase 8 Step 5)
// ============================================================ //

interface RecordingRetentionOrgResult {
  recordingsDeleted: number;
  recordingBatches: number;
  recordingObjectNotFound: number;
  recordingDeleteFailures: number;
  recordingDeletePendingRetried: number;
}

// runRecordingRetentionForOrg is exported for test injection; production
// callers go through runRetentionForOrg above.
//
// Two candidate sources per batch:
//   - normal expiry  : listRetentionCandidatesInCurrentOrg with
//                      explicitCutoff=now and uploadedBefore=now-N days.
//   - delete_pending : listDeletePendingRetryCandidatesInCurrentOrg with
//                      olderThan=now-recordingDeletePendingRetryAfterSec.
//
// Per row:
//   1. Call adapter.deleteObject(bucket, objectKey, objectVersion).
//   2. Success or `storage_object_not_found` → short org tx → markDeleted.
//   3. Any other storage error → leave row, increment failure count, continue.
//
// One aggregate audit row at the end of the org tick (count > 0 only).
// Audit payload omits per-row identifiers entirely.
export async function runRecordingRetentionForOrg(
  app: FastifyInstance,
  orgId: string,
  config: RetentionConfig,
  now: Date = new Date(),
): Promise<RecordingRetentionOrgResult> {
  const explicitCutoff = now;
  const uploadedBefore = new Date(
    now.getTime() - config.recordingRetentionDays * 24 * 60 * 60 * 1000,
  );
  const deletePendingOlderThan = new Date(
    now.getTime() - config.recordingDeletePendingRetryAfterSec * 1000,
  );

  let recordingsDeleted = 0;
  let recordingBatches = 0;
  let recordingObjectNotFound = 0;
  let recordingDeleteFailures = 0;
  let recordingDeletePendingRetried = 0;
  const providerCounts: Record<RecordingStorageProvider, number> = {
    local: 0,
    s3: 0,
    minio: 0,
  };
  // Rows that failed object delete in THIS tick are not retried again
  // before the next tick — otherwise a permanently-failing row would
  // be re-attempted every batch within the same tick. Failed rows stay
  // eligible for the next tick because their DB state is unchanged.
  const failedThisTick = new Set<string>();

  const adapter = app.recordingStorage;
  if (!adapter) {
    // Treat as a programmer / boot error. The worker bootstrap must
    // register recordingStoragePlugin before invoking retention.
    throw new Error(
      "runRecordingRetentionForOrg: app.recordingStorage is not registered",
    );
  }

  for (let batch = 0; batch < config.maxBatchesPerOrg; batch++) {
    // Read candidate batches under their own short transactions so the
    // object storage HTTP calls below run with no DB lock held.
    const { expired, pending } = await app.withOrgContext(orgId, async (client) => {
      const expiredRows = await listRetentionCandidatesInCurrentOrg(client, {
        explicitCutoff,
        uploadedBefore,
        limit: config.recordingBatchSize,
      });
      const pendingCapacity = Math.max(0, config.recordingBatchSize - expiredRows.length);
      const pendingRows = pendingCapacity > 0
        ? await listDeletePendingRetryCandidatesInCurrentOrg(client, {
            olderThan: deletePendingOlderThan,
            limit: pendingCapacity,
          })
        : [];
      return { expired: expiredRows, pending: pendingRows };
    });

    if (expired.length === 0 && pending.length === 0) break;
    recordingBatches += 1;

    let batchSuccesses = 0;
    for (const row of [...expired, ...pending]) {
      // Skip rows that already failed this tick — DB state unchanged so
      // the candidate query keeps returning them. Re-attempting wastes
      // adapter calls and inflates the failure counter.
      if (failedThisTick.has(row.id)) continue;
      const wasPending = row.status === "delete_pending";

      if (row.storage_provider !== adapter.provider) {
        // Provider drift means the current worker is not authoritative
        // for this object location. Leave metadata unchanged for a
        // correctly configured worker / operator fix, and keep the
        // audit signal aggregate-only.
        recordingDeleteFailures += 1;
        if (wasPending) recordingDeletePendingRetried += 1;
        failedThisTick.add(row.id);
        continue;
      }

      let storageOutcome: "deleted" | "not_found" | "failed";
      try {
        await adapter.deleteObject({
          bucket: row.storage_bucket,
          objectKey: row.object_key,
          objectVersion: row.object_version,
        });
        storageOutcome = "deleted";
      } catch (err) {
        if (
          err instanceof RecordingStorageOperationError &&
          err.code === "storage_object_not_found"
        ) {
          storageOutcome = "not_found";
        } else {
          // Increment failure counter and leave row eligible. We MUST
          // NOT log object_key, bucket, signed URL, or raw SDK error
          // bodies — Phase 8 Step 5 plan §12. Aggregate diagnostics
          // surface through `recordingDeleteFailures` only.
          recordingDeleteFailures += 1;
          if (wasPending) recordingDeletePendingRetried += 1;
          failedThisTick.add(row.id);
          continue;
        }
      }

      // Tombstone metadata under a fresh org context. Only a row this
      // worker actually tombstoned contributes to this tick's aggregate
      // delete counters; a concurrent worker may have already counted it.
      const tombstoned = await app.withOrgContext(orgId, async (client) =>
        markDeletedInCurrentOrg(client, row.id, now),
      );
      if (tombstoned) {
        recordingsDeleted += 1;
        batchSuccesses += 1;
        if (storageOutcome === "not_found") recordingObjectNotFound += 1;
        if (wasPending) recordingDeletePendingRetried += 1;
        providerCounts[row.storage_provider] =
          (providerCounts[row.storage_provider] ?? 0) + 1;
      }
    }
    // Loop break condition: if the candidate query keeps returning the
    // same failing rows (none could be tombstoned), the next batch would
    // pick them up again forever. Stop and let the next tick retry.
    if (batchSuccesses === 0) break;
  }

  // Aggregate audit — one row per tick when anything was processed.
  if (recordingsDeleted > 0 || recordingDeleteFailures > 0) {
    await app.withOrgContext(orgId, async (client) =>
      recordActivity(client, {
        orgId,
        actorUserId: null,
        action: "retention.recordings_deleted",
        targetType: "organization",
        targetId: orgId,
        payload: {
          actor_type: "system",
          cutoff: explicitCutoff.toISOString(),
          uploaded_before: uploadedBefore.toISOString(),
          retention_days: config.recordingRetentionDays,
          deleted_count: recordingsDeleted,
          object_not_found_count: recordingObjectNotFound,
          failed_count: recordingDeleteFailures,
          delete_pending_retried_count: recordingDeletePendingRetried,
          batch_size: config.recordingBatchSize,
          batches: recordingBatches,
          storage_provider_counts: providerCounts,
        },
      }),
    );
  }

  return {
    recordingsDeleted,
    recordingBatches,
    recordingObjectNotFound,
    recordingDeleteFailures,
    recordingDeletePendingRetried,
  };
}

// CallRecording is re-used internally for typing; explicit re-export to
// keep service consumers from importing the repository module directly.
export type { CallRecording };

// ============================================================ //
// Tick runner — iterates all orgs with per-org failure isolation
// ============================================================ //

export interface RetentionTickResult {
  skipped?: boolean;
  reason?: "disabled";
  orgsScanned: number;
  transcriptsDeleted: number;
  emailOutboxRecovered: number;
  // Phase 8 Step 5 — recording sweep aggregates.
  recordingsDeleted: number;
  recordingObjectNotFound: number;
  recordingDeleteFailures: number;
  /** Org ids whose runRetentionForOrg threw. Element value is the
   *  error class name only (e.g. "DatabaseError") — never the error
   *  message body. */
  failedOrgs: Array<{ orgId: string; errorName: string }>;
}

/** Run one retention tick over every organization.
 *
 *  When `config.enabled` is false the processor short-circuits with
 *  `skipped: true`. Tests pass `enabled: true` explicitly even though
 *  the env default keeps the scheduler off in dev / CI.
 *
 *  Per-org failures are caught and added to `failedOrgs`. The tick
 *  ALWAYS returns a result; it does not throw. The worker should log
 *  the result and let BullMQ mark the job completed (attempts=1 per
 *  queue default — the next tick handles whatever this one missed).
 */
export async function runRetentionTick(
  app: FastifyInstance,
  config: RetentionConfig,
  now: Date = new Date(),
): Promise<RetentionTickResult> {
  if (!config.enabled) {
    return {
      skipped: true,
      reason: "disabled",
      orgsScanned: 0,
      transcriptsDeleted: 0,
      emailOutboxRecovered: 0,
      recordingsDeleted: 0,
      recordingObjectNotFound: 0,
      recordingDeleteFailures: 0,
      failedOrgs: [],
    };
  }

  // organizations has no RLS — bare pool client is fine.
  const orgClient = await app.pg.connect();
  let orgIds: string[];
  try {
    orgIds = await listAllOrgIds(orgClient);
  } finally {
    orgClient.release();
  }

  const result: RetentionTickResult = {
    orgsScanned: orgIds.length,
    transcriptsDeleted: 0,
    emailOutboxRecovered: 0,
    recordingsDeleted: 0,
    recordingObjectNotFound: 0,
    recordingDeleteFailures: 0,
    failedOrgs: [],
  };

  for (const orgId of orgIds) {
    try {
      const r = await runRetentionForOrg(app, orgId, config, now);
      result.transcriptsDeleted += r.transcriptsDeleted;
      result.emailOutboxRecovered += r.emailOutboxRecovered;
      result.recordingsDeleted += r.recordingsDeleted;
      result.recordingObjectNotFound += r.recordingObjectNotFound;
      result.recordingDeleteFailures += r.recordingDeleteFailures;
    } catch (err) {
      const errorName = (err as { name?: string })?.name ?? "Error";
      result.failedOrgs.push({ orgId, errorName });
    }
  }

  return result;
}

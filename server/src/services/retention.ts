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

  return app.withOrgContext(orgId, async (client: PoolClient) => {
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
      orgId,
      transcriptsDeleted,
      transcriptBatches,
      emailOutboxRecovered: rec.recoveredCount,
    };
  }) as Promise<RetentionOrgResult>;
}

// ============================================================ //
// Tick runner — iterates all orgs with per-org failure isolation
// ============================================================ //

export interface RetentionTickResult {
  skipped?: boolean;
  reason?: "disabled";
  orgsScanned: number;
  transcriptsDeleted: number;
  emailOutboxRecovered: number;
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
    failedOrgs: [],
  };

  for (const orgId of orgIds) {
    try {
      const r = await runRetentionForOrg(app, orgId, config, now);
      result.transcriptsDeleted += r.transcriptsDeleted;
      result.emailOutboxRecovered += r.emailOutboxRecovered;
    } catch (err) {
      const errorName = (err as { name?: string })?.name ?? "Error";
      result.failedOrgs.push({ orgId, errorName });
    }
  }

  return result;
}

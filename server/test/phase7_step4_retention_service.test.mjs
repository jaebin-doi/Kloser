/* Phase 7 Step 4 — retention service tests.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_4_PLAN.md §8.1.
 *
 * Covered surface:
 *   - loadRetentionConfigFromEnv (config validation, defaults, ranges)
 *   - runRetentionForOrg (transcript batch delete + email recovery +
 *     aggregate audit; per-org transactional)
 *
 * Test scenarios:
 *    1. Transcript older than cutoff is deleted.
 *    2. Transcript newer than cutoff remains.
 *    3. Batch limit + maxBatches caps total deletes per org per tick.
 *    4. Cross-org isolation — Acme sweep does NOT touch Beta transcripts.
 *    5. Audit row written only when transcript delete count > 0.
 *    6. Audit payload omits transcript text / speaker / call_id.
 *    7. Old `sending` email_outbox row recovers to `failed` with
 *       lock metadata cleared and next_attempt_at set.
 *    8. Fresh `sending` row remains untouched.
 *    9. Non-sending rows (pending / delivered) remain untouched.
 *   10. Email recovery audit row omits lock_token, body, sensitive
 *       payload, raw token, ciphertext.
 *   11. Invalid env config throws RetentionConfigError.
 *
 * Fixture strategy:
 *   - Per-run TEST_RUN_ID stamped in:
 *       - transcripts.text  (prefix)
 *       - call.title        (prefix)
 *       - email_outbox.subject + body_text (prefix)
 *       - activity_log.payload (`_test_run` key)
 *   - after() sweeps anything tagged with the run id from BOTH orgs.
 *   - Direct SQL inserts let us set `created_at` / `locked_at` /
 *     `status` precisely so deterministic cutoffs work without sleep.
 *
 * Run: cd server && npm test
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pool } from "../src/db/pool.js";
import dbPlugin from "../src/plugins/db.js";
import {
  loadRetentionConfigFromEnv,
  runRetentionForOrg,
  RetentionConfigError,
} from "../src/services/retention.js";
// Phase 8 Step 5 wired call recording sweep into runRetentionForOrg.
// The service reads app.recordingStorage so we inject a local temp-dir
// adapter to keep these Phase 7 regression tests offline.
import { createLocalRecordingStorageAdapter } from "../src/adapters/recordingStorage.ts";

const ORG_ACME = "11111111-1111-1111-1111-111111111111";
const ORG_BETA = "22222222-2222-2222-2222-222222222222";
const USER_ACME_ADMIN = "aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa";

const TEST_RUN_ID = `phase7-step4-retention-${randomUUID()}`;
const PREFIX = `phase7-step4-${randomUUID().slice(0, 8)}`;

const DAY_MS = 24 * 60 * 60 * 1000;

// Reusable "now" — all tests anchor cutoffs against this so changing
// system clock between tests can't flake assertions.
const NOW = new Date("2026-05-18T12:00:00.000Z");

let app;
let recordingStorageRoot;

before(async () => {
  recordingStorageRoot = await mkdtemp(path.join(tmpdir(), "phase7-step4-rec-"));
  app = Fastify({ logger: false });
  await app.register(dbPlugin);
  app.decorate(
    "recordingStorage",
    createLocalRecordingStorageAdapter({
      rootDir: recordingStorageRoot,
      publicBaseUrl: null,
    }),
  );
});

after(async () => {
  try { await rm(recordingStorageRoot, { recursive: true, force: true }); }
  catch (_err) { /* best effort */ }
  // Sweep audit rows tagged with our run id from both orgs.
  for (const orgId of [ORG_ACME, ORG_BETA]) {
    try {
      await app.withOrgContext(orgId, async (client) => {
        await client.query(
          `DELETE FROM activity_log WHERE payload->>'_test_run' = $1`,
          [TEST_RUN_ID],
        );
        // Aggregate retention audit rows produced by runRetentionForOrg
        // don't carry our tag (production code doesn't know about it),
        // so wipe by action + target_id pointing at the test orgs in
        // the small recent window. The action / target filter scope is
        // narrow enough to avoid clobbering unrelated audit rows.
        await client.query(
          `DELETE FROM activity_log
            WHERE action IN ('retention.transcripts_deleted','email_outbox.sending_recovered')
              AND target_id = $1
              AND created_at >= $2`,
          [orgId, new Date(NOW.getTime() - DAY_MS).toISOString()],
        );
        // Transcripts + calls fixtures.
        await client.query(
          `DELETE FROM transcripts
            WHERE call_id IN (SELECT id FROM calls WHERE title LIKE $1)`,
          [`${PREFIX}%`],
        );
        await client.query(
          `DELETE FROM calls WHERE title LIKE $1`,
          [`${PREFIX}%`],
        );
        // Email outbox fixtures.
        await client.query(
          `DELETE FROM email_outbox WHERE subject LIKE $1`,
          [`${PREFIX}%`],
        );
      });
    } catch (_) { /* best-effort */ }
  }
  await app.close();
});

// ---------------------------------------------------------------------- //
// helpers
// ---------------------------------------------------------------------- //

async function insertCallRaw(orgId, { title }) {
  return app.withOrgContext(orgId, async (client) => {
    const r = await client.query(
      `INSERT INTO calls (org_id, agent_user_id, direction, status, title, started_at)
       VALUES ($1, $2, 'inbound', 'ended', $3, now())
       RETURNING id`,
      [orgId, orgId === ORG_ACME ? USER_ACME_ADMIN : null, title],
    );
    return r.rows[0].id;
  });
}

async function insertTranscriptAt(orgId, callId, createdAt, text) {
  return app.withOrgContext(orgId, async (client) => {
    const r = await client.query(
      `INSERT INTO transcripts (call_id, org_id, seq, speaker, text, created_at)
       VALUES ($1, $2,
               (SELECT COALESCE(MAX(seq)+1, 0) FROM transcripts WHERE call_id = $1),
               'agent', $3, $4)
       RETURNING id`,
      [callId, orgId, text, createdAt],
    );
    return r.rows[0].id;
  });
}

async function countTranscriptsByCall(orgId, callId) {
  return app.withOrgContext(orgId, async (client) => {
    const r = await client.query(
      `SELECT count(*)::int AS n FROM transcripts WHERE call_id = $1`,
      [callId],
    );
    return r.rows[0]?.n ?? 0;
  });
}

async function insertStuckSendingEmail(orgId, lockedAt, subjectSuffix) {
  return app.withOrgContext(orgId, async (client) => {
    const r = await client.query(
      `INSERT INTO email_outbox (
         org_id, to_email, subject, body_text, template, metadata,
         status, provider, attempt_count, locked_at, lock_token,
         sensitive_payload_ciphertext, sensitive_payload_iv,
         sensitive_payload_tag, sensitive_payload_key_version
       ) VALUES (
         $1, 'stuck@example.test', $2, 'body redacted',
         'email_verification', '{}'::jsonb,
         'sending', 'resend', 1, $3, gen_random_uuid(),
         'ciphertext-bytes', 'iv-bytes', 'tag-bytes', 1
       )
       RETURNING id`,
      [orgId, `${PREFIX} ${subjectSuffix}`, lockedAt],
    );
    return r.rows[0].id;
  });
}

async function insertPendingEmail(orgId, subjectSuffix) {
  return app.withOrgContext(orgId, async (client) => {
    const r = await client.query(
      `INSERT INTO email_outbox (
         org_id, to_email, subject, body_text, template,
         status, provider, attempt_count
       ) VALUES (
         $1, 'pending@example.test', $2, 'body', 'email_verification',
         'pending', 'resend', 0
       )
       RETURNING id`,
      [orgId, `${PREFIX} ${subjectSuffix}`],
    );
    return r.rows[0].id;
  });
}

async function readEmail(orgId, id) {
  return app.withOrgContext(orgId, async (client) => {
    const r = await client.query(
      `SELECT id, status, locked_at, lock_token, next_attempt_at,
              error_message, attempt_count,
              sensitive_payload_ciphertext, sensitive_payload_iv,
              sensitive_payload_tag
         FROM email_outbox WHERE id = $1`,
      [id],
    );
    return r.rows[0] ?? null;
  });
}

async function listAuditRowsByTargetSince(orgId, targetId, since) {
  return app.withOrgContext(orgId, async (client) => {
    const r = await client.query(
      `SELECT id, action, target_type, target_id, user_id, payload, created_at
         FROM activity_log
        WHERE target_id = $1 AND created_at >= $2
        ORDER BY created_at DESC, id DESC`,
      [targetId, since.toISOString()],
    );
    return r.rows;
  });
}

function defaultConfig(overrides = {}) {
  // Always returns enabled=true here — `runRetentionForOrg` doesn't
  // gate on enabled (the tick processor does). Tests that need the
  // disabled path call the processor directly.
  return {
    enabled: true,
    intervalSec: 86400,
    transcriptRetentionDays: 1095,
    transcriptBatchSize: 500,
    maxBatchesPerOrg: 20,
    emailStuckSendingAfterSec: 900,
    emailRecoveryBatchSize: 200,
    // Phase 8 Step 5 — recording sweep config. These defaults match
    // production env defaults and keep recording sweeps a no-op when
    // the test does not create call_recordings rows.
    recordingRetentionDays: 90,
    recordingBatchSize: 100,
    recordingDeletePendingRetryAfterSec: 900,
    ...overrides,
  };
}

// =============================================================
//                  Config loader / validation
// =============================================================

test("loadRetentionConfigFromEnv returns defaults when no env is set", () => {
  const cfg = loadRetentionConfigFromEnv({});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.intervalSec, 86400);
  assert.equal(cfg.transcriptRetentionDays, 1095);
  assert.equal(cfg.transcriptBatchSize, 500);
  assert.equal(cfg.maxBatchesPerOrg, 20);
  assert.equal(cfg.emailStuckSendingAfterSec, 900);
  assert.equal(cfg.emailRecoveryBatchSize, 200);
});

test("loadRetentionConfigFromEnv honors valid overrides", () => {
  const cfg = loadRetentionConfigFromEnv({
    KLOSER_RETENTION_ENABLED: "true",
    KLOSER_RETENTION_INTERVAL_SEC: "3600",
    KLOSER_RETENTION_TRANSCRIPT_DAYS: "30",
    KLOSER_RETENTION_TRANSCRIPT_BATCH_SIZE: "10",
    KLOSER_RETENTION_MAX_BATCHES_PER_ORG: "2",
    KLOSER_EMAIL_STUCK_SENDING_AFTER_SEC: "300",
    KLOSER_EMAIL_STUCK_RECOVERY_BATCH_SIZE: "50",
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.intervalSec, 3600);
  assert.equal(cfg.transcriptRetentionDays, 30);
  assert.equal(cfg.transcriptBatchSize, 10);
  assert.equal(cfg.maxBatchesPerOrg, 2);
  assert.equal(cfg.emailStuckSendingAfterSec, 300);
  assert.equal(cfg.emailRecoveryBatchSize, 50);
});

test("loadRetentionConfigFromEnv rejects out-of-range value with RetentionConfigError", () => {
  assert.throws(
    () => loadRetentionConfigFromEnv({
      KLOSER_RETENTION_TRANSCRIPT_BATCH_SIZE: "0",
    }),
    (err) => err instanceof RetentionConfigError &&
      /TRANSCRIPT_BATCH_SIZE/.test(err.message),
  );
  assert.throws(
    () => loadRetentionConfigFromEnv({
      KLOSER_RETENTION_INTERVAL_SEC: "10",
    }),
    (err) => err instanceof RetentionConfigError,
  );
  assert.throws(
    () => loadRetentionConfigFromEnv({
      KLOSER_RETENTION_TRANSCRIPT_DAYS: "abc",
    }),
    (err) => err instanceof RetentionConfigError,
  );
  assert.throws(
    () => loadRetentionConfigFromEnv({
      KLOSER_RETENTION_INTERVAL_SEC: "3600abc",
    }),
    (err) => err instanceof RetentionConfigError,
  );
  assert.throws(
    () => loadRetentionConfigFromEnv({
      KLOSER_RETENTION_ENABLED: "definitely",
    }),
    (err) => err instanceof RetentionConfigError,
  );
});

// =============================================================
//                Transcript retention behavior
// =============================================================

test("transcripts older than cutoff are deleted; newer ones remain", async () => {
  const callId = await insertCallRaw(ORG_ACME, { title: `${PREFIX}cutoff` });
  // 4 years old → deleted (cutoff = NOW - 1095 days).
  const oldId = await insertTranscriptAt(
    ORG_ACME, callId, new Date(NOW.getTime() - 4 * 365 * DAY_MS),
    `${TEST_RUN_ID}-old`,
  );
  // 1 year old → kept.
  const newId = await insertTranscriptAt(
    ORG_ACME, callId, new Date(NOW.getTime() - 365 * DAY_MS),
    `${TEST_RUN_ID}-new`,
  );
  assert.ok(oldId);
  assert.ok(newId);

  const r = await runRetentionForOrg(app, ORG_ACME, defaultConfig(), NOW);
  assert.equal(r.transcriptsDeleted, 1);

  const remaining = await countTranscriptsByCall(ORG_ACME, callId);
  assert.equal(remaining, 1, "the recent transcript should remain");
});

test("batch + maxBatches cap total deletes per tick", async () => {
  const callId = await insertCallRaw(ORG_ACME, { title: `${PREFIX}batch` });
  // 7 old transcripts.
  for (let i = 0; i < 7; i++) {
    await insertTranscriptAt(
      ORG_ACME, callId,
      new Date(NOW.getTime() - (4 * 365 + i) * DAY_MS),
      `${TEST_RUN_ID}-batch-${i}`,
    );
  }
  // batchSize=3, maxBatches=2 → at most 6 deleted per tick.
  const r = await runRetentionForOrg(
    app, ORG_ACME,
    defaultConfig({ transcriptBatchSize: 3, maxBatchesPerOrg: 2 }),
    NOW,
  );
  assert.equal(r.transcriptsDeleted, 6);
  assert.equal(r.transcriptBatches, 2);
  const left = await countTranscriptsByCall(ORG_ACME, callId);
  assert.equal(left, 1, "1 transcript should remain after the cap");
});

test("Acme sweep does NOT delete Beta transcripts (cross-org isolation)", async () => {
  const acmeCallId = await insertCallRaw(ORG_ACME, { title: `${PREFIX}acme-xorg` });
  const betaCallId = await insertCallRaw(ORG_BETA, { title: `${PREFIX}beta-xorg` });
  await insertTranscriptAt(
    ORG_ACME, acmeCallId,
    new Date(NOW.getTime() - 4 * 365 * DAY_MS),
    `${TEST_RUN_ID}-acme`,
  );
  await insertTranscriptAt(
    ORG_BETA, betaCallId,
    new Date(NOW.getTime() - 4 * 365 * DAY_MS),
    `${TEST_RUN_ID}-beta`,
  );

  await runRetentionForOrg(app, ORG_ACME, defaultConfig(), NOW);

  const acmeLeft = await countTranscriptsByCall(ORG_ACME, acmeCallId);
  const betaLeft = await countTranscriptsByCall(ORG_BETA, betaCallId);
  assert.equal(acmeLeft, 0, "Acme transcript should be deleted");
  assert.equal(betaLeft, 1, "Beta transcript should be untouched");
});

test("audit row is written ONLY when transcript delete count > 0", async () => {
  // Org with NO old transcripts — no audit row should appear.
  const callId = await insertCallRaw(ORG_ACME, { title: `${PREFIX}noop` });
  await insertTranscriptAt(
    ORG_ACME, callId,
    new Date(NOW.getTime() - 365 * DAY_MS), // 1 year old → kept
    `${TEST_RUN_ID}-noop`,
  );
  const since = new Date(NOW.getTime() - DAY_MS);
  const before = await listAuditRowsByTargetSince(ORG_ACME, ORG_ACME, since);
  const beforeCount = before.filter(
    (r) => r.action === "retention.transcripts_deleted",
  ).length;

  const r = await runRetentionForOrg(app, ORG_ACME, defaultConfig(), NOW);
  assert.equal(r.transcriptsDeleted, 0);

  const after = await listAuditRowsByTargetSince(ORG_ACME, ORG_ACME, since);
  const afterCount = after.filter(
    (r) => r.action === "retention.transcripts_deleted",
  ).length;
  assert.equal(
    afterCount, beforeCount,
    "no transcript audit row should be added when nothing was deleted",
  );
});

test("transcript audit payload contains only safe summary keys", async () => {
  const callId = await insertCallRaw(ORG_ACME, { title: `${PREFIX}audit-shape` });
  const SENSITIVE_TEXT = `${TEST_RUN_ID}-sensitive-customer-pii-9876`;
  await insertTranscriptAt(
    ORG_ACME, callId,
    new Date(NOW.getTime() - 4 * 365 * DAY_MS),
    SENSITIVE_TEXT,
  );
  const since = new Date(NOW.getTime() - DAY_MS);

  await runRetentionForOrg(app, ORG_ACME, defaultConfig(), NOW);

  const rows = await listAuditRowsByTargetSince(ORG_ACME, ORG_ACME, since);
  const row = rows.find(
    (r) => r.action === "retention.transcripts_deleted" &&
      r.payload?.deleted_count === 1,
  );
  assert.ok(row, "expected an audit row for the single delete");
  assert.equal(row.user_id, null, "actor user must be null for system events");
  assert.equal(row.target_type, "organization");
  assert.equal(row.target_id, ORG_ACME);

  const keys = Object.keys(row.payload).sort();
  assert.deepEqual(
    keys.sort(),
    [
      "actor_type",
      "batch_size",
      "batches",
      "cutoff",
      "deleted_count",
      "retention_days",
    ].sort(),
    "audit payload keys must be the safe summary set only",
  );

  const serialized = JSON.stringify(row.payload);
  assert.ok(
    !serialized.includes(SENSITIVE_TEXT),
    "transcript text must NEVER appear in the audit payload",
  );
  assert.ok(
    !serialized.includes(callId),
    "transcript's parent call_id must NEVER appear in the audit payload",
  );
});

// =============================================================
//                  Email outbox stuck recovery
// =============================================================

test("old sending email_outbox row recovers to failed; fresh sending stays", async () => {
  const old = await insertStuckSendingEmail(
    ORG_ACME,
    new Date(NOW.getTime() - 30 * 60 * 1000), // 30 min ago — past 15-min cutoff
    "old",
  );
  const fresh = await insertStuckSendingEmail(
    ORG_ACME,
    new Date(NOW.getTime() - 60 * 1000), // 1 min ago — still within window
    "fresh",
  );

  const r = await runRetentionForOrg(app, ORG_ACME, defaultConfig(), NOW);
  assert.equal(r.emailOutboxRecovered, 1);

  const oldRow = await readEmail(ORG_ACME, old);
  assert.equal(oldRow.status, "failed");
  assert.equal(oldRow.locked_at, null);
  assert.equal(oldRow.lock_token, null);
  assert.ok(oldRow.next_attempt_at instanceof Date);
  assert.equal(oldRow.next_attempt_at.getTime(), NOW.getTime(),
    "next_attempt_at should be set to the deterministic NOW");
  assert.equal(oldRow.attempt_count, 1,
    "attempt_count must NOT be incremented by recovery");
  assert.equal(oldRow.error_message, "worker_recovered_stuck_sending");
  // Sensitive payload columns must be preserved — the next delivery
  // tick needs to decrypt and send.
  assert.equal(oldRow.sensitive_payload_ciphertext, "ciphertext-bytes");
  assert.equal(oldRow.sensitive_payload_iv, "iv-bytes");
  assert.equal(oldRow.sensitive_payload_tag, "tag-bytes");

  const freshRow = await readEmail(ORG_ACME, fresh);
  assert.equal(freshRow.status, "sending", "fresh sending row must stay 'sending'");
  assert.ok(freshRow.locked_at instanceof Date);
  assert.ok(freshRow.lock_token);
});

test("non-sending rows (pending) are untouched by recovery sweep", async () => {
  const pending = await insertPendingEmail(ORG_ACME, "pending-untouched");
  await runRetentionForOrg(app, ORG_ACME, defaultConfig(), NOW);
  const row = await readEmail(ORG_ACME, pending);
  assert.equal(row.status, "pending");
  assert.equal(row.attempt_count, 0);
});

test("email recovery audit payload omits lock_token / body / ciphertext", async () => {
  const lockedAt = new Date(NOW.getTime() - 30 * 60 * 1000);
  await insertStuckSendingEmail(ORG_ACME, lockedAt, "audit-hygiene");
  const since = new Date(NOW.getTime() - DAY_MS);

  await runRetentionForOrg(app, ORG_ACME, defaultConfig(), NOW);

  const rows = await listAuditRowsByTargetSince(ORG_ACME, ORG_ACME, since);
  const row = rows.find(
    (r) => r.action === "email_outbox.sending_recovered",
  );
  assert.ok(row, "expected an email recovery audit row");
  assert.equal(row.user_id, null);
  assert.equal(row.target_type, "organization");
  assert.equal(row.target_id, ORG_ACME);

  const keys = Object.keys(row.payload).sort();
  assert.deepEqual(
    keys.sort(),
    [
      "actor_type",
      "cutoff",
      "recovered_count",
      "stuck_after_seconds",
    ].sort(),
    "audit payload keys must be the safe summary set only",
  );
  const serialized = JSON.stringify(row.payload);
  assert.ok(!/ciphertext/.test(serialized));
  assert.ok(!/lock_token/.test(serialized));
  assert.ok(!/body/.test(serialized));
  assert.ok(!/redacted/.test(serialized));
});

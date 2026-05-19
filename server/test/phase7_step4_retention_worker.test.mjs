/* Phase 7 Step 4 — retention sweep worker processor tests.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_4_PLAN.md §8.2.
 *
 * Covered surface:
 *   - makeRetentionSweepProcessor(app, { config, now })
 *
 * Test scenarios:
 *    1. Processor with config.enabled=false returns a skipped result and
 *       performs no DB mutation.
 *    2. Processor with config.enabled=true scans every org and aggregates
 *       counts across them. Per-org failures don't leak through.
 *    3. Deterministic `now` drives the cutoff — same-day fixture verifies
 *       the transcript that would otherwise sit just outside the cutoff
 *       is deleted when `now` is moved forward.
 *
 * Fixture strategy:
 *   - Same patterns as `phase7_step4_retention_service.test.mjs`:
 *     per-run TEST_RUN_ID prefix on transcripts.text + calls.title +
 *     email subject + activity payload tag for cleanup.
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
import { makeRetentionSweepProcessor } from "../src/workers/retentionSweep.worker.js";
// Phase 8 Step 5 — worker now wires recording sweep through
// app.recordingStorage. Inject a local temp-dir adapter to keep the
// Phase 7 regression assertions offline.
import { createLocalRecordingStorageAdapter } from "../src/adapters/recordingStorage.ts";

const ORG_ACME = "11111111-1111-1111-1111-111111111111";
const ORG_BETA = "22222222-2222-2222-2222-222222222222";
const USER_ACME_ADMIN = "aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa";

const TEST_RUN_ID = `phase7-step4-retention-worker-${randomUUID()}`;
const PREFIX = `phase7-step4-worker-${randomUUID().slice(0, 8)}`;

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-05-18T12:00:00.000Z");

let app;
let recordingStorageRoot;

before(async () => {
  recordingStorageRoot = await mkdtemp(path.join(tmpdir(), "phase7-step4-worker-rec-"));
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
  for (const orgId of [ORG_ACME, ORG_BETA]) {
    try {
      await app.withOrgContext(orgId, async (client) => {
        await client.query(
          `DELETE FROM activity_log WHERE payload->>'_test_run' = $1`,
          [TEST_RUN_ID],
        );
        await client.query(
          `DELETE FROM activity_log
            WHERE action IN ('retention.transcripts_deleted','email_outbox.sending_recovered')
              AND target_id = $1
              AND created_at >= $2`,
          [orgId, new Date(NOW.getTime() - DAY_MS).toISOString()],
        );
        await client.query(
          `DELETE FROM transcripts
            WHERE call_id IN (SELECT id FROM calls WHERE title LIKE $1)`,
          [`${PREFIX}%`],
        );
        await client.query(
          `DELETE FROM calls WHERE title LIKE $1`,
          [`${PREFIX}%`],
        );
      });
    } catch (_) { /* best-effort */ }
  }
  await app.close();
});

// ---------------------------------------------------------------------- //
// helpers (mirror the service test file)
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

function enabledConfig(overrides = {}) {
  return {
    enabled: true,
    intervalSec: 86400,
    transcriptRetentionDays: 1095,
    transcriptBatchSize: 500,
    maxBatchesPerOrg: 20,
    emailStuckSendingAfterSec: 900,
    emailRecoveryBatchSize: 200,
    // Phase 8 Step 5 — recording sweep defaults.
    recordingRetentionDays: 90,
    recordingBatchSize: 100,
    recordingDeletePendingRetryAfterSec: 900,
    ...overrides,
  };
}

// =============================================================
//                  1. disabled processor is a no-op
// =============================================================

test("processor with config.enabled=false returns skipped + does not delete", async () => {
  const callId = await insertCallRaw(ORG_ACME, { title: `${PREFIX}disabled` });
  await insertTranscriptAt(
    ORG_ACME, callId,
    new Date(NOW.getTime() - 4 * 365 * DAY_MS),
    `${TEST_RUN_ID}-disabled`,
  );

  const proc = makeRetentionSweepProcessor(app, {
    config: enabledConfig({ enabled: false }),
    now: () => NOW,
  });
  const r = await proc({ data: {} });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, "disabled");
  assert.equal(r.orgsScanned, 0);
  assert.equal(r.transcriptsDeleted, 0);
  assert.equal(r.emailOutboxRecovered, 0);

  // Mutation MUST NOT have happened.
  const remaining = await countTranscriptsByCall(ORG_ACME, callId);
  assert.equal(remaining, 1, "disabled processor must not delete transcripts");
});

// =============================================================
//                  2. enabled processor scans every org
// =============================================================

test("enabled processor scans every org and aggregates per-org counts", async () => {
  // Old transcripts in BOTH orgs.
  const acmeCallId = await insertCallRaw(ORG_ACME, { title: `${PREFIX}both-acme` });
  const betaCallId = await insertCallRaw(ORG_BETA, { title: `${PREFIX}both-beta` });
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

  const proc = makeRetentionSweepProcessor(app, {
    config: enabledConfig(),
    now: () => NOW,
  });
  const r = await proc({ data: {} });
  assert.equal(r.skipped, undefined);
  assert.ok(r.orgsScanned >= 2, "should scan at least the two seeded orgs");
  assert.ok(r.transcriptsDeleted >= 2,
    "should delete both old transcripts across orgs");
  assert.deepEqual(r.failedOrgs, [], "no per-org failures expected");

  // Both orgs drained.
  assert.equal(await countTranscriptsByCall(ORG_ACME, acmeCallId), 0);
  assert.equal(await countTranscriptsByCall(ORG_BETA, betaCallId), 0);
});

// =============================================================
//                  3. deterministic `now` drives cutoff
// =============================================================

test("deterministic now=cutoff+1 deletes the boundary transcript on the next tick", async () => {
  const callId = await insertCallRaw(ORG_ACME, { title: `${PREFIX}boundary` });

  // Transcript whose age relative to `now` controls deletion.
  // With retentionDays=10, this transcript is 9 days old vs NOW.
  // First tick (now = NOW): cutoff = NOW - 10d, transcript at NOW - 9d → KEPT.
  // Second tick (now = NOW + 2d): cutoff = NOW + 2d - 10d, transcript at NOW - 9d → DELETED.
  const tsCreatedAt = new Date(NOW.getTime() - 9 * DAY_MS);
  await insertTranscriptAt(
    ORG_ACME, callId, tsCreatedAt, `${TEST_RUN_ID}-boundary`,
  );

  const config = enabledConfig({ transcriptRetentionDays: 10 });

  // First tick — transcript is younger than cutoff, must stay.
  const proc1 = makeRetentionSweepProcessor(app, {
    config, now: () => NOW,
  });
  const r1 = await proc1({ data: {} });
  assert.equal(
    await countTranscriptsByCall(ORG_ACME, callId), 1,
    "transcript inside retention window must remain after tick 1",
  );
  assert.ok(r1.orgsScanned >= 1);

  // Second tick — push `now` forward by 2 days. Transcript is now
  // 11 days old vs NOW+2d, past the 10-day cutoff.
  const nowPlus2 = new Date(NOW.getTime() + 2 * DAY_MS);
  const proc2 = makeRetentionSweepProcessor(app, {
    config, now: () => nowPlus2,
  });
  const r2 = await proc2({ data: {} });
  assert.ok(r2.transcriptsDeleted >= 1, "transcript past cutoff must be deleted on tick 2");
  assert.equal(
    await countTranscriptsByCall(ORG_ACME, callId), 0,
    "transcript should be gone after tick 2",
  );
});

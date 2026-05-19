/* Phase 8 Step 5 — recording retention service tests.
 *
 * Plan: docs/plan/phase-8/PHASE_8_STEP_5_PLAN.md §9.2.
 *
 * Tests `runRecordingRetentionForOrg` + `runRetentionForOrg` integration:
 *   1. expired available recording → object delete + row tombstoned.
 *   2. non-expired recording is untouched.
 *   3. explicit retention_delete_after triggers deletion independently
 *      of uploaded_at.
 *   4. storage_object_not_found counts as success and tombstones.
 *   5. storage failure leaves row eligible, increments failure count,
 *      does not block siblings.
 *   6. storage provider mismatch is a failure without adapter delete.
 *   7. delete_pending older than retry cutoff is retried.
 *   8. aggregate audit row is created only when count > 0 and payload
 *      excludes recording id / object key / bucket / signed URL /
 *      checksum / raw error.
 *   9. cross-org isolation: Acme sweep does NOT touch Beta rows.
 *   10. runRetentionTick aggregates per-org recording counters and
 *      handles disabled config (no-op).
 *
 * The recording storage adapter is replaced with an in-test fake that
 * records putObject calls and can be programmed to throw, so no
 * filesystem / network IO occurs.
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import dbPlugin from "../src/plugins/db.js";
import * as calls from "../src/repositories/calls.ts";
import * as recordings from "../src/repositories/callRecordings.ts";
import {
    runRecordingRetentionForOrg,
    runRetentionForOrg,
    runRetentionTick,
} from "../src/services/retention.ts";
import { RecordingStorageOperationError } from "../src/adapters/recordingStorage.ts";

const ORG_ACME = "11111111-1111-1111-1111-111111111111";
const ORG_BETA = "22222222-2222-2222-2222-222222222222";

const SUITE_TAG = `phase8-step5-svc-${randomUUID().slice(0, 8)}`;

let app;
let adapter;

class FakeRecordingStorage {
    constructor() {
        this.provider = "local";
        this.deleted = []; // capture objectKey for assertions only — never logged.
        this.behavior = null; // optional override: (input) => "deleted" | "not_found" | Error
    }
    async createUploadUrl() { throw new Error("not used in retention tests"); }
    async createReadUrl() { throw new Error("not used in retention tests"); }
    async putObject() { throw new Error("not used in retention tests"); }
    async deleteObject(input) {
        if (typeof this.behavior === "function") {
            const outcome = this.behavior(input);
            if (outcome === "not_found") {
                throw new RecordingStorageOperationError(
                    "storage_object_not_found",
                    "object not found",
                );
            }
            if (outcome instanceof Error) throw outcome;
        }
        this.deleted.push({ bucket: input.bucket, objectKey: input.objectKey });
    }
}

before(async () => {
    app = Fastify({ logger: false });
    await app.register(dbPlugin);
    adapter = new FakeRecordingStorage();
    app.decorate("recordingStorage", adapter);
});

after(async () => {
    await wipeSuite();
    await app.close();
});

afterEach(async () => {
    adapter.deleted.length = 0;
    adapter.behavior = null;
    await wipeSuite();
});

async function wipeSuite() {
    for (const orgId of [ORG_ACME, ORG_BETA]) {
        await app.withOrgContext(orgId, async (client) => {
            await client.query(
                `DELETE FROM activity_log
                  WHERE action = 'retention.recordings_deleted'
                    AND target_id = $1
                    AND created_at >= now() - interval '5 minutes'`,
                [orgId],
            );
            await client.query(
                `DELETE FROM calls WHERE title LIKE $1`,
                [`${SUITE_TAG}%`],
            );
        });
    }
}

async function createCall(orgId, suffix) {
    return app.withOrgContext(orgId, (client) =>
        calls.insertInCurrentOrg(client, orgId, {
            direction: "inbound",
            title: `${SUITE_TAG}/${suffix}`,
        }),
    );
}

const BASE_INSERT = (callId, objectKey) => ({
    call_id: callId,
    storage_provider: "local",
    storage_bucket: null,
    object_key: objectKey,
    content_type: "audio/webm",
});

async function createAvailableRecording(orgId, callId, uploadedAt, explicitCutoff) {
    return app.withOrgContext(orgId, async (client) => {
        const row = await recordings.insertUploadPendingInCurrentOrg(client, orgId, {
            ...BASE_INSERT(callId, `${SUITE_TAG}/${randomUUID()}.webm`),
        });
        await client.query(
            `UPDATE call_recordings
                SET status='available', uploaded_at=$2, retention_delete_after=$3
              WHERE id=$1`,
            [row.id, uploadedAt, explicitCutoff ?? null],
        );
        const fresh = await recordings.getByIdInCurrentOrg(client, row.id);
        return fresh;
    });
}

function baseConfig(overrides = {}) {
    return {
        enabled: true,
        intervalSec: 86400,
        transcriptRetentionDays: 1095,
        transcriptBatchSize: 500,
        maxBatchesPerOrg: 20,
        emailStuckSendingAfterSec: 900,
        emailRecoveryBatchSize: 200,
        recordingRetentionDays: 90,
        recordingBatchSize: 100,
        recordingDeletePendingRetryAfterSec: 900,
        ...overrides,
    };
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ============================================================== //
// 1. expired available recording → tombstoned
// ============================================================== //

test("expired available recording is deleted from storage and tombstoned", async () => {
    const call = await createCall(ORG_ACME, "expired-1");
    const uploadedAt = new Date(Date.now() - 100 * DAY_MS);
    const row = await createAvailableRecording(ORG_ACME, call.id, uploadedAt);

    const result = await runRecordingRetentionForOrg(app, ORG_ACME, baseConfig(), new Date());
    assert.equal(result.recordingsDeleted, 1);
    assert.equal(result.recordingObjectNotFound, 0);
    assert.equal(result.recordingDeleteFailures, 0);
    assert.equal(adapter.deleted.length, 1);
    assert.equal(adapter.deleted[0].objectKey, row.object_key);

    const fetched = await app.withOrgContext(ORG_ACME, (client) =>
        recordings.getByIdInCurrentOrg(client, row.id),
    );
    assert.equal(fetched.status, "deleted");
    assert.ok(fetched.deleted_at instanceof Date);
});

// ============================================================== //
// 2. non-expired recording is untouched
// ============================================================== //

test("recording inside retention window is untouched", async () => {
    const call = await createCall(ORG_ACME, "fresh");
    const recent = new Date(Date.now() - 7 * DAY_MS);
    const row = await createAvailableRecording(ORG_ACME, call.id, recent);

    const result = await runRecordingRetentionForOrg(app, ORG_ACME, baseConfig(), new Date());
    assert.equal(result.recordingsDeleted, 0);
    assert.equal(adapter.deleted.length, 0);

    const fetched = await app.withOrgContext(ORG_ACME, (client) =>
        recordings.getByIdInCurrentOrg(client, row.id),
    );
    assert.equal(fetched.status, "available");
});

// ============================================================== //
// 3. explicit retention_delete_after triggers deletion
// ============================================================== //

test("explicit retention_delete_after in the past deletes even with recent uploaded_at", async () => {
    const call = await createCall(ORG_ACME, "explicit-cutoff");
    const recent = new Date(Date.now() - 60 * 1000);
    const past = new Date(Date.now() - 60 * 1000);
    const row = await createAvailableRecording(ORG_ACME, call.id, recent, past);

    const result = await runRecordingRetentionForOrg(app, ORG_ACME, baseConfig(), new Date());
    assert.equal(result.recordingsDeleted, 1);

    const fetched = await app.withOrgContext(ORG_ACME, (client) =>
        recordings.getByIdInCurrentOrg(client, row.id),
    );
    assert.equal(fetched.status, "deleted");
});

// ============================================================== //
// 4. storage_object_not_found is idempotent success
// ============================================================== //

test("storage_object_not_found counts as success and tombstones", async () => {
    const call = await createCall(ORG_ACME, "not-found");
    const uploadedAt = new Date(Date.now() - 100 * DAY_MS);
    const row = await createAvailableRecording(ORG_ACME, call.id, uploadedAt);

    adapter.behavior = () => "not_found";

    const result = await runRecordingRetentionForOrg(app, ORG_ACME, baseConfig(), new Date());
    assert.equal(result.recordingsDeleted, 1);
    assert.equal(result.recordingObjectNotFound, 1);
    assert.equal(result.recordingDeleteFailures, 0);

    const fetched = await app.withOrgContext(ORG_ACME, (client) =>
        recordings.getByIdInCurrentOrg(client, row.id),
    );
    assert.equal(fetched.status, "deleted");
});

// ============================================================== //
// 5. storage failure leaves row eligible, increments failure count,
//    does not block other rows in the same batch
// ============================================================== //

test("storage failure leaves the failing row alone but does not block siblings", async () => {
    const callA = await createCall(ORG_ACME, "fail-A");
    const callB = await createCall(ORG_ACME, "fail-B");
    const uploadedAt = new Date(Date.now() - 100 * DAY_MS);
    const rowA = await createAvailableRecording(ORG_ACME, callA.id, uploadedAt);
    const rowB = await createAvailableRecording(ORG_ACME, callB.id, uploadedAt);

    // Make A throw a non-not-found storage error; B succeeds.
    adapter.behavior = (input) => {
        if (input.objectKey === rowA.object_key) {
            return new RecordingStorageOperationError(
                "storage_upstream",
                "upstream timeout",
            );
        }
        return undefined;
    };

    const result = await runRecordingRetentionForOrg(app, ORG_ACME, baseConfig(), new Date());
    assert.equal(result.recordingDeleteFailures, 1);
    assert.equal(result.recordingsDeleted, 1);

    const fetchedA = await app.withOrgContext(ORG_ACME, (client) =>
        recordings.getByIdInCurrentOrg(client, rowA.id),
    );
    const fetchedB = await app.withOrgContext(ORG_ACME, (client) =>
        recordings.getByIdInCurrentOrg(client, rowB.id),
    );
    assert.equal(fetchedA.status, "available", "A must stay available for next tick");
    assert.equal(fetchedB.status, "deleted", "B must still be tombstoned");
});

// ============================================================== //
// 6. provider mismatch is not deleted by the wrong adapter
// ============================================================== //

test("storage provider mismatch is reported without deleting or tombstoning", async () => {
    const call = await createCall(ORG_ACME, "provider-mismatch");
    const uploadedAt = new Date(Date.now() - 100 * DAY_MS);
    const row = await createAvailableRecording(ORG_ACME, call.id, uploadedAt);

    await app.withOrgContext(ORG_ACME, (client) =>
        client.query(
            `UPDATE call_recordings
                SET storage_provider='s3',
                    storage_bucket='phase8-step5-test-bucket'
              WHERE id=$1`,
            [row.id],
        ),
    );

    const result = await runRecordingRetentionForOrg(app, ORG_ACME, baseConfig(), new Date());
    assert.equal(result.recordingsDeleted, 0);
    assert.equal(result.recordingDeleteFailures, 1);
    assert.equal(adapter.deleted.length, 0);

    const fetched = await app.withOrgContext(ORG_ACME, (client) =>
        recordings.getByIdInCurrentOrg(client, row.id),
    );
    assert.equal(fetched.status, "available");
    assert.equal(fetched.storage_provider, "s3");
});

// ============================================================== //
// 7. delete_pending older than retry cutoff is retried
// ============================================================== //

test("delete_pending row older than retry cutoff is retried and tombstoned", async () => {
    const call = await createCall(ORG_ACME, "retry");
    const recent = new Date(Date.now() - 60 * 1000);
    const row = await createAvailableRecording(ORG_ACME, call.id, recent);
    await app.withOrgContext(ORG_ACME, (client) =>
        recordings.markDeletePendingInCurrentOrg(client, row.id),
    );

    // Use very short retry cutoff so the just-marked row qualifies.
    const config = baseConfig({ recordingDeletePendingRetryAfterSec: 60 });
    // Sleep ~70ms then offset olderThan check by passing now slightly in the future.
    await new Promise((r) => setTimeout(r, 70));
    const now = new Date(Date.now() + 65 * 1000); // shift now forward to exceed retry window
    const result = await runRecordingRetentionForOrg(app, ORG_ACME, config, now);
    assert.equal(result.recordingDeletePendingRetried, 1);
    assert.equal(result.recordingsDeleted, 1);

    const fetched = await app.withOrgContext(ORG_ACME, (client) =>
        recordings.getByIdInCurrentOrg(client, row.id),
    );
    assert.equal(fetched.status, "deleted");
});

// ============================================================== //
// 8. aggregate audit row excludes sensitive identifiers
// ============================================================== //

test("aggregate audit row exists and payload omits recording id / object key / bucket / signed URL / checksum / raw error", async () => {
    const call = await createCall(ORG_ACME, "audit");
    const uploadedAt = new Date(Date.now() - 100 * DAY_MS);
    const row = await createAvailableRecording(ORG_ACME, call.id, uploadedAt);

    await runRecordingRetentionForOrg(app, ORG_ACME, baseConfig(), new Date());

    const auditRows = await app.withOrgContext(ORG_ACME, async (client) => {
        const r = await client.query(
            `SELECT payload
               FROM activity_log
              WHERE action='retention.recordings_deleted'
                AND target_id=$1
              ORDER BY created_at DESC
              LIMIT 1`,
            [ORG_ACME],
        );
        return r.rows;
    });
    assert.equal(auditRows.length, 1);
    const payload = auditRows[0].payload;
    assert.equal(payload.actor_type, "system");
    assert.equal(payload.deleted_count, 1);
    assert.equal(payload.failed_count, 0);
    assert.equal(payload.object_not_found_count, 0);
    assert.equal(payload.retention_days, 90);
    assert.equal(typeof payload.cutoff, "string");
    assert.equal(typeof payload.uploaded_before, "string");
    assert.ok(payload.storage_provider_counts);

    // Forbidden values per Step 5 plan §3.4.
    const text = JSON.stringify(payload);
    for (const needle of [
        row.id,                  // recording id
        row.object_key,          // object key (contains org + call + recording uuid)
        "recording_id",          // forbidden key
        "recording_ids",
        "call_id",
        "object_key",
        "storage_bucket",
        "signed_url",
        "checksum",
        "object_version",
        "access_key",
        "secret_access_key",
    ]) {
        assert.ok(
            !text.includes(needle),
            `audit payload must not contain '${needle}', got: ${text}`,
        );
    }
});

// ============================================================== //
// 9. cross-org isolation
// ============================================================== //

test("Acme sweep does NOT delete Beta recordings", async () => {
    const acmeCall = await createCall(ORG_ACME, "xorg-acme");
    const betaCall = await createCall(ORG_BETA, "xorg-beta");
    const oldUpload = new Date(Date.now() - 100 * DAY_MS);
    const acmeRow = await createAvailableRecording(ORG_ACME, acmeCall.id, oldUpload);
    const betaRow = await createAvailableRecording(ORG_BETA, betaCall.id, oldUpload);

    await runRecordingRetentionForOrg(app, ORG_ACME, baseConfig(), new Date());

    const acmeFetched = await app.withOrgContext(ORG_ACME, (client) =>
        recordings.getByIdInCurrentOrg(client, acmeRow.id),
    );
    const betaFetched = await app.withOrgContext(ORG_BETA, (client) =>
        recordings.getByIdInCurrentOrg(client, betaRow.id),
    );
    assert.equal(acmeFetched.status, "deleted");
    assert.equal(betaFetched.status, "available", "Beta row must survive Acme sweep");
});

// ============================================================== //
// 10. runRetentionTick aggregates + disabled no-op
// ============================================================== //

test("disabled config makes runRetentionTick a no-op with zero recording counters", async () => {
    const result = await runRetentionTick(app, baseConfig({ enabled: false }), new Date());
    assert.equal(result.skipped, true);
    assert.equal(result.recordingsDeleted, 0);
    assert.equal(result.recordingObjectNotFound, 0);
    assert.equal(result.recordingDeleteFailures, 0);
});

test("runRetentionForOrg returns merged transcript + recording counters", async () => {
    const call = await createCall(ORG_ACME, "merged");
    const uploadedAt = new Date(Date.now() - 100 * DAY_MS);
    await createAvailableRecording(ORG_ACME, call.id, uploadedAt);

    const result = await runRetentionForOrg(app, ORG_ACME, baseConfig(), new Date());
    assert.equal(result.orgId, ORG_ACME);
    assert.equal(result.recordingsDeleted, 1);
    // transcript counter is independent (this test does not create
    // expired transcripts), but the field must be present.
    assert.equal(typeof result.transcriptsDeleted, "number");
    assert.equal(typeof result.emailOutboxRecovered, "number");
});

test("aggregate audit row is NOT written when nothing happened", async () => {
    await runRecordingRetentionForOrg(app, ORG_ACME, baseConfig(), new Date());
    const r = await app.withOrgContext(ORG_ACME, async (client) => {
        const q = await client.query(
            `SELECT count(*)::int AS n
               FROM activity_log
              WHERE action='retention.recordings_deleted'
                AND target_id=$1
                AND created_at >= now() - interval '1 minute'`,
            [ORG_ACME],
        );
        return q.rows[0].n;
    });
    assert.equal(r, 0, "no audit row when count=0");
});

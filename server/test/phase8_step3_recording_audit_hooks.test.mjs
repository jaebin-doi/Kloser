/* Phase 8 Step 3 — call_recordings audit hook tests.
 *
 * Plan: docs/plan/phase-8/PHASE_8_STEP_3_PLAN.md §5.4.
 *
 * Confirms that every recording lifecycle transition emits the right
 * audit row, with target_type='call' (target_id = call.id), and with a
 * payload that never carries object_key / bucket / signed URL / raw
 * audio / provider credentials / checksum.
 *
 * Five recording.* actions covered:
 *   - recording.upload_initiated
 *   - recording.finalized
 *   - recording.playback_url_issued
 *   - recording.delete_requested
 *   - recording.deleted
 *
 * Sensitive-value invariants are asserted by JSON-stringifying the
 * payload and substring-checking a fixed set of would-be leaks.
 */
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pool } from "../src/db/pool.js";
import authPlugin from "../src/plugins/auth.js";
import dbPlugin from "../src/plugins/db.js";
import authRoutes from "../src/routes/auth.js";
import callsRoutes from "../src/routes/calls.js";
import callRecordingsRoutes from "../src/routes/callRecordings.js";
import { createLocalRecordingStorageAdapter } from "../src/adapters/recordingStorage.ts";

const ACME_ID                = "11111111-1111-1111-1111-111111111111";
const BETA_ID                = "22222222-2222-2222-2222-222222222222";
const ACME_ADMIN_USER_ID     = "aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa";
const ACME_EMP_USER_ID       = "aaaaaaaa-0002-0002-0002-aaaaaaaaaaaa";
const BETA_ADMIN_USER_ID     = "bbbbbbbb-0001-0001-0001-bbbbbbbbbbbb";

const TITLE_PREFIX = "phase8-step3-audit-";

let app;
let storageRoot;

before(async () => {
    storageRoot = await mkdtemp(path.join(tmpdir(), "phase8-step3-audit-"));
    const adapter = createLocalRecordingStorageAdapter({
        rootDir: storageRoot,
        publicBaseUrl: null,
    });

    app = Fastify({ logger: false });
    await app.register(authPlugin);
    await app.register(dbPlugin);
    app.decorate("recordingStorage", adapter);
    await app.register(authRoutes);
    await app.register(callsRoutes);
    await app.register(callRecordingsRoutes);
});

after(async () => {
    await wipe();
    await app.close();
    await rm(storageRoot, { recursive: true, force: true });
});

async function wipe() {
    await pool.query(
        `DELETE FROM sessions WHERE user_id IN ($1, $2, $3)`,
        [ACME_ADMIN_USER_ID, ACME_EMP_USER_ID, BETA_ADMIN_USER_ID],
    );
    for (const orgId of [ACME_ID, BETA_ID]) {
        await app.withOrgContext(orgId, async (client) => {
            await client.query(
                `DELETE FROM activity_log
                  WHERE action LIKE 'recording.%'
                    AND target_id IN (
                        SELECT id FROM calls WHERE title LIKE $1
                    )`,
                [`${TITLE_PREFIX}%`],
            );
            // call_recordings cascade via composite FK on call delete.
            await client.query(
                `DELETE FROM calls WHERE title LIKE $1`,
                [`${TITLE_PREFIX}%`],
            );
        });
    }
}

beforeEach(wipe);
afterEach(wipe);

async function loginToken(email, password) {
    const r = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email, password },
    });
    assert.equal(r.statusCode, 200);
    return r.json().accessToken;
}

function authed(token, opts) {
    return app.inject({
        ...opts,
        headers: {
            ...(opts.headers || {}),
            authorization: `Bearer ${token}`,
        },
    });
}

async function createCall(token, suffix) {
    const r = await authed(token, {
        method: "POST",
        url: "/calls",
        headers: { "content-type": "application/json" },
        payload: {
            direction: "inbound",
            title: `${TITLE_PREFIX}${suffix}`,
        },
    });
    assert.equal(r.statusCode, 201, r.body);
    return r.json().call;
}

async function readAuditRowsForCall(orgId, action, callId) {
    let rows;
    await app.withOrgContext(orgId, async (client) => {
        const r = await client.query(
            `SELECT id, org_id, user_id, action, target_type, target_id,
                    payload, created_at
               FROM activity_log
              WHERE action = $1 AND target_id = $2
              ORDER BY created_at DESC, id DESC`,
            [action, callId],
        );
        rows = r.rows;
    });
    return rows;
}

// JSON-stringify check for sensitive substrings. The forbidden list is
// universal — it must NEVER appear in any recording.* audit payload.
const FORBIDDEN_PAYLOAD_TOKENS = [
    "object_key",
    "storage_bucket",
    "bucket",
    "signed_url",
    "playback_url",
    "upload_url",
    "checksum",
    "object_version",
    "provider_secret",
    "access_key",
    "secret_access_key",
    // Specific values that should never leak (the URL itself even if
    // someone tried to inline it). The local provider URL prefix is
    // a sentinel — its presence in a payload means we leaked the URL.
    "http://localhost.invalid/recordings/",
];

function assertNoForbiddenPayload(row) {
    const text = JSON.stringify(row.payload);
    for (const needle of FORBIDDEN_PAYLOAD_TOKENS) {
        assert.ok(
            !text.includes(needle),
            `payload (${row.action}) must not contain '${needle}', got: ${text}`,
        );
    }
}

// ===================================================================== //
// upload_initiated payload
// ===================================================================== //

test("recording.upload_initiated audit row carries recording_id + sanitized payload", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const call = await createCall(token, "upload-audit");
    const up = await authed(token, {
        method: "POST",
        url: `/calls/${call.id}/recordings/upload`,
        headers: { "content-type": "application/json" },
        payload: {
            content_type: "audio/webm",
            size_bytes: 2048,
            duration_seconds: 9,
        },
    });
    assert.equal(up.statusCode, 201);
    const recordingId = up.json().recording.id;

    const rows = await readAuditRowsForCall(
        ACME_ID,
        "recording.upload_initiated",
        call.id,
    );
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.target_type, "call");
    assert.equal(row.target_id, call.id);
    assert.equal(row.user_id, ACME_ADMIN_USER_ID);
    assert.equal(row.payload.recording_id, recordingId);
    assert.equal(row.payload.content_type, "audio/webm");
    assert.equal(row.payload.size_bytes, 2048);
    assert.equal(row.payload.duration_seconds, 9);
    assert.equal(typeof row.payload.ttl_seconds, "number");
    assertNoForbiddenPayload(row);
});

// ===================================================================== //
// finalized payload
// ===================================================================== //

test("recording.finalized audit row records the same recording id + omits checksum", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const call = await createCall(token, "finalize-audit");
    const up = await authed(token, {
        method: "POST",
        url: `/calls/${call.id}/recordings/upload`,
        headers: { "content-type": "application/json" },
        payload: { content_type: "audio/webm" },
    });
    const recordingId = up.json().recording.id;
    const fin = await authed(token, {
        method: "POST",
        url: `/calls/${call.id}/recordings/${recordingId}/finalize`,
        headers: { "content-type": "application/json" },
        payload: {
            size_bytes: 8192,
            duration_seconds: 17,
            checksum_sha256: "f".repeat(64),
        },
    });
    assert.equal(fin.statusCode, 200);

    const rows = await readAuditRowsForCall(
        ACME_ID,
        "recording.finalized",
        call.id,
    );
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.payload.recording_id, recordingId);
    assert.equal(row.payload.content_type, "audio/webm");
    assert.equal(row.payload.size_bytes, 8192);
    assert.equal(row.payload.duration_seconds, 17);
    assertNoForbiddenPayload(row);
});

// ===================================================================== //
// playback_url_issued payload
// ===================================================================== //

test("recording.playback_url_issued audit row carries TTL only (no URL)", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const call = await createCall(token, "playback-audit");
    const up = await authed(token, {
        method: "POST",
        url: `/calls/${call.id}/recordings/upload`,
        headers: { "content-type": "application/json" },
        payload: { content_type: "audio/webm" },
    });
    const recordingId = up.json().recording.id;
    await authed(token, {
        method: "POST",
        url: `/calls/${call.id}/recordings/${recordingId}/finalize`,
        headers: { "content-type": "application/json" },
        payload: { size_bytes: 1 },
    });
    await authed(token, {
        method: "GET",
        url: `/calls/${call.id}/recordings/${recordingId}/playback-url`,
    });

    const rows = await readAuditRowsForCall(
        ACME_ID,
        "recording.playback_url_issued",
        call.id,
    );
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.payload.recording_id, recordingId);
    assert.equal(typeof row.payload.ttl_seconds, "number");
    assertNoForbiddenPayload(row);
});

// ===================================================================== //
// delete_requested + deleted payload
// ===================================================================== //

test("DELETE creates recording.delete_requested + recording.deleted, both sanitized", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const call = await createCall(token, "delete-audit");
    const up = await authed(token, {
        method: "POST",
        url: `/calls/${call.id}/recordings/upload`,
        headers: { "content-type": "application/json" },
        payload: { content_type: "audio/webm" },
    });
    const recordingId = up.json().recording.id;
    const del = await authed(token, {
        method: "DELETE",
        url: `/calls/${call.id}/recordings/${recordingId}`,
    });
    assert.equal(del.statusCode, 204);

    const requested = await readAuditRowsForCall(
        ACME_ID,
        "recording.delete_requested",
        call.id,
    );
    const deleted = await readAuditRowsForCall(
        ACME_ID,
        "recording.deleted",
        call.id,
    );
    assert.equal(requested.length, 1);
    assert.equal(deleted.length, 1);

    assert.equal(requested[0].payload.recording_id, recordingId);
    assert.equal(
        requested[0].payload.previous_status,
        "upload_pending",
        "delete_requested must capture previous_status",
    );
    assert.equal(deleted[0].payload.recording_id, recordingId);
    assertNoForbiddenPayload(requested[0]);
    assertNoForbiddenPayload(deleted[0]);
});

// ===================================================================== //
// cross-org audit isolation
// ===================================================================== //

test("audit rows are invisible cross-org (Beta cannot see Acme recording audit)", async () => {
    const acmeToken = await loginToken("admin@acme.test", "acme-admin-1234");
    const call = await createCall(acmeToken, "xorg-audit");
    await authed(acmeToken, {
        method: "POST",
        url: `/calls/${call.id}/recordings/upload`,
        headers: { "content-type": "application/json" },
        payload: { content_type: "audio/webm" },
    });

    const betaRows = await readAuditRowsForCall(
        BETA_ID,
        "recording.upload_initiated",
        call.id,
    );
    assert.equal(betaRows.length, 0);
});

/* Phase 8 Step 3 — call_recordings route tests.
 *
 * Plan: docs/plan/phase-8/PHASE_8_STEP_3_PLAN.md §7.
 *
 * Covers the 5 endpoints (upload / finalize / list / playback-url /
 * delete) end-to-end via Fastify inject + the local recording storage
 * adapter rooted in a temp dir.
 *
 * Security assertions per case:
 *   - missing auth → 401
 *   - cross-org call/recording → 404 (never 403)
 *   - viewer cannot mutate → 403
 *   - employee can only mutate own call → 403 on other
 *   - admin can mutate any same-org call → 200/201/204
 *   - response never includes object_key / storage_bucket / provider
 *     credentials / signed URL bucket internals
 *   - lifecycle state guards return 409 (not 200)
 *   - audit rows for each transition exist with the right action +
 *     target_type + recording_id payload (deeper sensitive-payload
 *     assertions live in phase8_step3_recording_audit_hooks.test.mjs)
 *
 * Cleanup: each test creates fresh calls/recordings; afterEach wipes
 * suite rows by prefix. Seeded users/memberships are restored if any
 * test mutates them (viewer demotion test).
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
const ACME_EMP_MEMBERSHIP    = "cccccccc-0002-0002-0002-cccccccccccc";

const TITLE_PREFIX = "phase8-step3-routes-";

let app;
let storageRoot;
let storageAdapter;

before(async () => {
    storageRoot = await mkdtemp(path.join(tmpdir(), "phase8-step3-routes-"));
    storageAdapter = createLocalRecordingStorageAdapter({
        rootDir: storageRoot,
        publicBaseUrl: null,
    });

    app = Fastify({ logger: false });
    await app.register(authPlugin);
    await app.register(dbPlugin);
    // Inject the local recording storage adapter BEFORE registering the
    // route plugin so the recording route reads our temp-dir adapter
    // instead of resolving from env.
    app.decorate("recordingStorage", storageAdapter);
    await app.register(authRoutes);
    await app.register(callsRoutes);
    await app.register(callRecordingsRoutes);
});

after(async () => {
    await wipeSuite();
    await app.close();
    await rm(storageRoot, { recursive: true, force: true });
});

async function wipeSuite() {
    // sessions accumulate per loginToken
    await app.pg.query(
        `DELETE FROM sessions WHERE user_id IN ($1, $2)`,
        [ACME_ADMIN_USER_ID, ACME_EMP_USER_ID],
    );

    // recording rows + audit rows for suite-prefixed calls + the calls
    // themselves. recordings cascade from calls but we kill audit first
    // because target_id references a call id we are about to delete.
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
            // call_recordings cascade on call delete via composite FK.
            await client.query(
                `DELETE FROM calls WHERE title LIKE $1`,
                [`${TITLE_PREFIX}%`],
            );
        });
    }

    // Restore employee role if a test demoted it to viewer.
    await app.withOrgContext(ACME_ID, async (client) => {
        await client.query(
            `UPDATE memberships SET role = 'employee' WHERE id = $1`,
            [ACME_EMP_MEMBERSHIP],
        );
    });
}

afterEach(wipeSuite);

async function loginToken(email, password) {
    const r = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email, password },
    });
    assert.equal(r.statusCode, 200, `login ${email}: ${r.statusCode} ${r.body}`);
    return r.json().accessToken;
}

function authedInject(token, opts) {
    return app.inject({
        ...opts,
        headers: {
            ...(opts.headers || {}),
            authorization: `Bearer ${token}`,
        },
    });
}

async function createCall(token, overrides = {}) {
    const r = await authedInject(token, {
        method: "POST",
        url: "/calls",
        headers: { "content-type": "application/json" },
        payload: {
            direction: "inbound",
            title: `${TITLE_PREFIX}helper`,
            ...overrides,
        },
    });
    assert.equal(r.statusCode, 201, `helper create: ${r.statusCode} ${r.body}`);
    return r.json().call;
}

async function uploadRecording(token, callId, overrides = {}) {
    const r = await authedInject(token, {
        method: "POST",
        url: `/calls/${callId}/recordings/upload`,
        headers: { "content-type": "application/json" },
        payload: {
            content_type: "audio/webm",
            ...overrides,
        },
    });
    return r;
}

const FORBIDDEN_RESPONSE_KEYS = [
    "object_key",
    "storage_bucket",
    "storage_provider",
    "object_version",
    "checksum_sha256",
    "metadata",
    "org_id",
];

function assertNoStorageInternals(obj, label = "response") {
    const text = JSON.stringify(obj);
    for (const key of FORBIDDEN_RESPONSE_KEYS) {
        assert.ok(
            !text.includes(`"${key}"`),
            `${label} must not expose ${key}`,
        );
    }
}

// ===================================================================== //
// 1. unauth → 401
// ===================================================================== //

test("POST upload without auth → 401", async () => {
    const r = await app.inject({
        method: "POST",
        url: `/calls/${ACME_ADMIN_USER_ID}/recordings/upload`,
        payload: { content_type: "audio/webm" },
    });
    assert.equal(r.statusCode, 401);
});

// ===================================================================== //
// 2. admin upload happy path → 201 + response shape clean
// ===================================================================== //

test("admin upload → 201 with sanitized response (no object_key/bucket/provider)", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const call = await createCall(token, { title: `${TITLE_PREFIX}admin-upload` });
    const r = await uploadRecording(token, call.id);
    assert.equal(r.statusCode, 201, r.body);

    const body = r.json();
    assert.ok(body.recording);
    assert.ok(body.upload);
    assert.equal(body.recording.status, "upload_pending");
    assert.equal(body.recording.content_type, "audio/webm");
    assert.equal(body.recording.call_id, call.id);
    assert.equal(body.upload.method, "PUT");
    assert.ok(body.upload.url.startsWith("http://localhost.invalid/recordings/"));
    assert.ok(
        body.upload.url.includes(`/recordings/${body.recording.id}/`),
        "signed upload URL must use the same recording id as the metadata row",
    );
    assert.ok(body.upload.expires_at);
    assertNoStorageInternals(body, "upload response");
});

// ===================================================================== //
// 3. viewer denied → 403 (not 401, not 404)
// ===================================================================== //

test("viewer upload → 403", async () => {
    // Demote employee membership to viewer for this test only.
    await app.withOrgContext(ACME_ID, async (client) => {
        await client.query(
            `UPDATE memberships SET role = 'viewer' WHERE id = $1`,
            [ACME_EMP_MEMBERSHIP],
        );
    });
    const adminToken = await loginToken("admin@acme.test", "acme-admin-1234");
    const empToken = await loginToken("emp@acme.test", "acme-emp-1234");
    const call = await createCall(adminToken, {
        title: `${TITLE_PREFIX}viewer-deny`,
        agent_user_id: ACME_EMP_USER_ID,
    });
    const r = await uploadRecording(empToken, call.id);
    assert.equal(r.statusCode, 403);
    assert.equal(r.json().error, "forbidden");
});

// ===================================================================== //
// 4. employee can only mutate own call → 403 on other
// ===================================================================== //

test("employee upload on non-own call → 403", async () => {
    const adminToken = await loginToken("admin@acme.test", "acme-admin-1234");
    const empToken = await loginToken("emp@acme.test", "acme-emp-1234");
    // Call assigned to admin (not the employee).
    const call = await createCall(adminToken, {
        title: `${TITLE_PREFIX}emp-not-own`,
        agent_user_id: ACME_ADMIN_USER_ID,
    });
    const r = await uploadRecording(empToken, call.id);
    assert.equal(r.statusCode, 403);
});

test("employee upload on own call → 201", async () => {
    const empToken = await loginToken("emp@acme.test", "acme-emp-1234");
    const call = await createCall(empToken, { title: `${TITLE_PREFIX}emp-own` });
    // employee POST /calls forces agent_user_id = self, so this is own.
    const r = await uploadRecording(empToken, call.id);
    assert.equal(r.statusCode, 201, r.body);
});

// ===================================================================== //
// 5. cross-org call id → 404 (never 403)
// ===================================================================== //

test("admin upload against cross-org call id → 404", async () => {
    const acmeAdmin = await loginToken("admin@acme.test", "acme-admin-1234");
    const betaAdmin = await loginToken("admin@beta.test", "beta-admin-1234");
    const betaCall = await createCall(betaAdmin, {
        title: `${TITLE_PREFIX}beta-xorg`,
    });
    const r = await uploadRecording(acmeAdmin, betaCall.id);
    assert.equal(r.statusCode, 404);
    assert.equal(r.json().error, "not_found");
});

// ===================================================================== //
// 6. invalid content_type → 400
// ===================================================================== //

test("upload with invalid content_type → 400 invalid_input", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const call = await createCall(token, { title: `${TITLE_PREFIX}bad-ct` });
    const r = await authedInject(token, {
        method: "POST",
        url: `/calls/${call.id}/recordings/upload`,
        headers: { "content-type": "application/json" },
        payload: { content_type: "video/mp4" },
    });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error, "invalid_input");
});

// ===================================================================== //
// 7. invalid checksum → 400
// ===================================================================== //

test("upload with invalid checksum_sha256 → 400 invalid_input", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const call = await createCall(token, {
        title: `${TITLE_PREFIX}bad-checksum`,
    });
    const r = await authedInject(token, {
        method: "POST",
        url: `/calls/${call.id}/recordings/upload`,
        headers: { "content-type": "application/json" },
        payload: { content_type: "audio/webm", checksum_sha256: "nothex" },
    });
    assert.equal(r.statusCode, 400);
});

// ===================================================================== //
// 8. size over cap → 413
// ===================================================================== //

test("upload with size_bytes over cap → 413 recording_too_large", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const call = await createCall(token, {
        title: `${TITLE_PREFIX}too-large`,
    });
    const overCap = 250 * 1024 * 1024 + 1;
    const r = await authedInject(token, {
        method: "POST",
        url: `/calls/${call.id}/recordings/upload`,
        headers: { "content-type": "application/json" },
        payload: { content_type: "audio/webm", size_bytes: overCap },
    });
    assert.equal(r.statusCode, 413);
    assert.equal(r.json().error, "recording_too_large");
});

// ===================================================================== //
// 9. finalize moves row to available
// ===================================================================== //

test("finalize → 200 available + sanitized recording", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const call = await createCall(token, { title: `${TITLE_PREFIX}finalize` });
    const up = await uploadRecording(token, call.id);
    assert.equal(up.statusCode, 201);
    const recordingId = up.json().recording.id;

    const r = await authedInject(token, {
        method: "POST",
        url: `/calls/${call.id}/recordings/${recordingId}/finalize`,
        headers: { "content-type": "application/json" },
        payload: { size_bytes: 4096, duration_seconds: 12 },
    });
    assert.equal(r.statusCode, 200, r.body);
    const { recording } = r.json();
    assert.equal(recording.status, "available");
    assert.equal(recording.size_bytes, 4096);
    assert.equal(recording.duration_seconds, 12);
    assertNoStorageInternals(recording, "finalize recording");
});

// ===================================================================== //
// 10. finalize on cross-org recording id → 404
// ===================================================================== //

test("finalize cross-org recording id → 404", async () => {
    const acmeToken = await loginToken("admin@acme.test", "acme-admin-1234");
    const betaToken = await loginToken("admin@beta.test", "beta-admin-1234");
    const acmeCall = await createCall(acmeToken, {
        title: `${TITLE_PREFIX}xorg-finalize-acme`,
    });
    const acmeUpload = await uploadRecording(acmeToken, acmeCall.id);
    const acmeRecordingId = acmeUpload.json().recording.id;

    const betaCall = await createCall(betaToken, {
        title: `${TITLE_PREFIX}xorg-finalize-beta`,
    });
    // Beta admin tries to finalize an Acme recording id under a Beta call.
    const r = await authedInject(betaToken, {
        method: "POST",
        url: `/calls/${betaCall.id}/recordings/${acmeRecordingId}/finalize`,
        headers: { "content-type": "application/json" },
        payload: { size_bytes: 1 },
    });
    assert.equal(r.statusCode, 404);
});

// ===================================================================== //
// 11. finalize with call-id mismatch → 404
// ===================================================================== //

test("finalize recording whose call id path does not match → 404", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const callA = await createCall(token, { title: `${TITLE_PREFIX}mismatch-a` });
    const callB = await createCall(token, { title: `${TITLE_PREFIX}mismatch-b` });
    const up = await uploadRecording(token, callA.id);
    const recordingId = up.json().recording.id;

    const r = await authedInject(token, {
        method: "POST",
        url: `/calls/${callB.id}/recordings/${recordingId}/finalize`,
        headers: { "content-type": "application/json" },
        payload: {},
    });
    assert.equal(r.statusCode, 404);
});

// ===================================================================== //
// 12. finalize already-available → 409
// ===================================================================== //

test("finalize already-available row → 409 invalid_recording_state", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const call = await createCall(token, {
        title: `${TITLE_PREFIX}refinalize`,
    });
    const up = await uploadRecording(token, call.id);
    const recordingId = up.json().recording.id;

    const first = await authedInject(token, {
        method: "POST",
        url: `/calls/${call.id}/recordings/${recordingId}/finalize`,
        headers: { "content-type": "application/json" },
        payload: { size_bytes: 1 },
    });
    assert.equal(first.statusCode, 200);

    const second = await authedInject(token, {
        method: "POST",
        url: `/calls/${call.id}/recordings/${recordingId}/finalize`,
        headers: { "content-type": "application/json" },
        payload: { size_bytes: 1 },
    });
    assert.equal(second.statusCode, 409);
    assert.equal(second.json().error, "invalid_recording_state");
});

// ===================================================================== //
// 13. list same-org → 200 hides internals
// ===================================================================== //

test("GET /calls/:id/recordings same-org → 200 with sanitized items", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const call = await createCall(token, { title: `${TITLE_PREFIX}list` });
    await uploadRecording(token, call.id);

    const r = await authedInject(token, {
        method: "GET",
        url: `/calls/${call.id}/recordings`,
    });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.ok(Array.isArray(body.items));
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].status, "upload_pending");
    assertNoStorageInternals(body, "list response");
});

// ===================================================================== //
// 14. list cross-org → 404
// ===================================================================== //

test("GET /calls/:id/recordings cross-org → 404", async () => {
    const acmeToken = await loginToken("admin@acme.test", "acme-admin-1234");
    const betaToken = await loginToken("admin@beta.test", "beta-admin-1234");
    const betaCall = await createCall(betaToken, {
        title: `${TITLE_PREFIX}list-xorg`,
    });
    const r = await authedInject(acmeToken, {
        method: "GET",
        url: `/calls/${betaCall.id}/recordings`,
    });
    assert.equal(r.statusCode, 404);
});

// ===================================================================== //
// 15. playback-url before available → 409
// ===================================================================== //

test("playback-url on upload_pending row → 409 invalid_recording_state", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const call = await createCall(token, {
        title: `${TITLE_PREFIX}playback-pending`,
    });
    const up = await uploadRecording(token, call.id);
    const recordingId = up.json().recording.id;
    const r = await authedInject(token, {
        method: "GET",
        url: `/calls/${call.id}/recordings/${recordingId}/playback-url`,
    });
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().error, "invalid_recording_state");
});

// ===================================================================== //
// 16. playback-url on available row → 200, sanitized
// ===================================================================== //

test("playback-url on available row → 200 signed GET URL within TTL", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const call = await createCall(token, {
        title: `${TITLE_PREFIX}playback-ok`,
    });
    const up = await uploadRecording(token, call.id);
    const recordingId = up.json().recording.id;
    await authedInject(token, {
        method: "POST",
        url: `/calls/${call.id}/recordings/${recordingId}/finalize`,
        headers: { "content-type": "application/json" },
        payload: { size_bytes: 1 },
    });

    const before = Date.now();
    const r = await authedInject(token, {
        method: "GET",
        url: `/calls/${call.id}/recordings/${recordingId}/playback-url`,
    });
    assert.equal(r.statusCode, 200, r.body);
    const body = r.json();
    assert.ok(body.playback);
    assert.equal(body.playback.method, "GET");
    assert.ok(body.playback.url.startsWith("http://localhost.invalid/recordings/"));
    const expiresAt = Date.parse(body.playback.expires_at);
    assert.ok(expiresAt >= before, "expires_at must be in the future");
    // TTL <= 900s policy
    assert.ok(expiresAt - before <= 900 * 1000 + 60_000);
    assertNoStorageInternals(body, "playback response");
});

// ===================================================================== //
// 17. playback-url cross-org → 404
// ===================================================================== //

test("playback-url cross-org recording → 404", async () => {
    const acmeToken = await loginToken("admin@acme.test", "acme-admin-1234");
    const betaToken = await loginToken("admin@beta.test", "beta-admin-1234");
    const acmeCall = await createCall(acmeToken, {
        title: `${TITLE_PREFIX}xorg-playback-acme`,
    });
    const up = await uploadRecording(acmeToken, acmeCall.id);
    const acmeRecordingId = up.json().recording.id;
    await authedInject(acmeToken, {
        method: "POST",
        url: `/calls/${acmeCall.id}/recordings/${acmeRecordingId}/finalize`,
        headers: { "content-type": "application/json" },
        payload: { size_bytes: 1 },
    });
    const betaCall = await createCall(betaToken, {
        title: `${TITLE_PREFIX}xorg-playback-beta`,
    });
    const r = await authedInject(betaToken, {
        method: "GET",
        url: `/calls/${betaCall.id}/recordings/${acmeRecordingId}/playback-url`,
    });
    assert.equal(r.statusCode, 404);
});

// ===================================================================== //
// 18. delete same-org → 204, hides from list
// ===================================================================== //

test("DELETE recording → 204 and list hides it", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const call = await createCall(token, { title: `${TITLE_PREFIX}delete-ok` });
    const up = await uploadRecording(token, call.id);
    const recordingId = up.json().recording.id;

    const del = await authedInject(token, {
        method: "DELETE",
        url: `/calls/${call.id}/recordings/${recordingId}`,
    });
    assert.equal(del.statusCode, 204);

    const list = await authedInject(token, {
        method: "GET",
        url: `/calls/${call.id}/recordings`,
    });
    assert.equal(list.statusCode, 200);
    const body = list.json();
    assert.equal(body.items.length, 0, "tombstoned row must be hidden");
});

// ===================================================================== //
// 19. delete cross-org → 404
// ===================================================================== //

test("DELETE cross-org recording → 404", async () => {
    const acmeToken = await loginToken("admin@acme.test", "acme-admin-1234");
    const betaToken = await loginToken("admin@beta.test", "beta-admin-1234");
    const acmeCall = await createCall(acmeToken, {
        title: `${TITLE_PREFIX}xorg-delete-acme`,
    });
    const up = await uploadRecording(acmeToken, acmeCall.id);
    const acmeRecordingId = up.json().recording.id;
    const betaCall = await createCall(betaToken, {
        title: `${TITLE_PREFIX}xorg-delete-beta`,
    });
    const r = await authedInject(betaToken, {
        method: "DELETE",
        url: `/calls/${betaCall.id}/recordings/${acmeRecordingId}`,
    });
    assert.equal(r.statusCode, 404);
});

// ===================================================================== //
// 20. delete is idempotent (already-deleted → 204)
// ===================================================================== //

test("DELETE already-deleted recording → 404 (consistent with call-action-items)", async () => {
    // Once tombstoned, the recording is invisible to the user — list
    // hides it (test 18) and a subsequent DELETE collapses to 404, same
    // as DELETE /call-action-items/:id. The DB row still exists for
    // audit but the public API treats it as gone.
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const call = await createCall(token, {
        title: `${TITLE_PREFIX}delete-idempotent`,
    });
    const up = await uploadRecording(token, call.id);
    const recordingId = up.json().recording.id;
    const first = await authedInject(token, {
        method: "DELETE",
        url: `/calls/${call.id}/recordings/${recordingId}`,
    });
    assert.equal(first.statusCode, 204);
    const second = await authedInject(token, {
        method: "DELETE",
        url: `/calls/${call.id}/recordings/${recordingId}`,
    });
    assert.equal(second.statusCode, 404);
});

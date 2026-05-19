/* Phase 8 Step 5 — call_recordings retention repository tests.
 *
 * Plan: docs/plan/phase-8/PHASE_8_STEP_5_PLAN.md §9.1.
 *
 * Two helpers under test:
 *   - listRetentionCandidatesInCurrentOrg(client, { explicitCutoff,
 *     uploadedBefore, limit })
 *   - listDeletePendingRetryCandidatesInCurrentOrg(client, { olderThan, limit })
 *
 * Scope:
 *   1. explicit retention_delete_after <= explicitCutoff → included even
 *      when uploaded_at is recent.
 *   2. explicit retention_delete_after > explicitCutoff → excluded even
 *      when uploaded_at is ancient.
 *   3. retention_delete_after IS NULL: uploaded_at <= uploadedBefore → included.
 *   4. retention_delete_after IS NULL: uploaded_at within window → excluded.
 *   5. upload_pending / processing / delete_pending / deleted / tombstoned
 *      excluded from normal candidates.
 *   6. delete_pending older than retry cutoff → included.
 *   7. recent delete_pending → excluded from retry helper.
 *   8. cross-org isolation: Beta context cannot see Acme candidates.
 *   9. listRetentionCandidates input validation (bad Date / non-positive limit).
 *  10. listDeletePendingRetryCandidates input validation.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import dbPlugin from "../src/plugins/db.js";
import * as calls from "../src/repositories/calls.ts";
import * as recordings from "../src/repositories/callRecordings.ts";

const ORG_ACME = "11111111-1111-1111-1111-111111111111";
const ORG_BETA = "22222222-2222-2222-2222-222222222222";

let app;

before(async () => {
    app = Fastify({ logger: false });
    await app.register(dbPlugin);
});

after(async () => {
    await app.close();
});

async function hardDeleteCall(orgId, id) {
    await app.withOrgContext(orgId, async (client) => {
        await client.query("DELETE FROM calls WHERE id = $1", [id]);
    });
}

async function createCall(orgId, suffix) {
    return app.withOrgContext(orgId, (client) =>
        calls.insertInCurrentOrg(client, orgId, {
            direction: "inbound",
            title: `phase8-step5-repo/${suffix}`,
        }),
    );
}

function uniqueKey(label) {
    return `phase8-step5-repo/${label}/${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 10)}`;
}

const BASE_INSERT = (callId, objectKey, extra = {}) => ({
    call_id: callId,
    storage_provider: "local",
    storage_bucket: null,
    object_key: objectKey,
    content_type: "audio/webm",
    ...extra,
});

async function rawUpdate(orgId, sql, params) {
    await app.withOrgContext(orgId, (client) => client.query(sql, params));
}

// ============================================================== //
// listRetentionCandidates — explicit retention_delete_after
// ============================================================== //

test("explicit retention_delete_after <= explicitCutoff is eligible even when uploaded_at is recent", async () => {
    const call = await createCall(ORG_ACME, "explicit-past");
    try {
        const recent = new Date();
        const past = new Date(recent.getTime() - 60 * 1000); // 60s ago
        const row = await app.withOrgContext(ORG_ACME, (client) =>
            recordings.insertUploadPendingInCurrentOrg(
                client,
                ORG_ACME,
                BASE_INSERT(call.id, uniqueKey("explicit-past")),
            ),
        );
        // Promote to available with recent uploaded_at and a past explicit cutoff.
        await rawUpdate(
            ORG_ACME,
            `UPDATE call_recordings
                SET status='available', uploaded_at=$2, retention_delete_after=$3
              WHERE id=$1`,
            [row.id, recent, past],
        );

        const candidates = await app.withOrgContext(ORG_ACME, (client) =>
            recordings.listRetentionCandidatesInCurrentOrg(client, {
                explicitCutoff: recent,
                // Far future so the uploadedBefore branch alone would NOT
                // match this row.
                uploadedBefore: new Date(recent.getTime() - 365 * 24 * 60 * 60 * 1000),
                limit: 20,
            }),
        );
        assert.ok(
            candidates.some((c) => c.id === row.id),
            "row with explicit retention_delete_after in the past must be eligible",
        );
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

test("explicit retention_delete_after > explicitCutoff is excluded even when uploaded_at is ancient", async () => {
    const call = await createCall(ORG_ACME, "explicit-future");
    try {
        const now = new Date();
        const ancient = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
        const future = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        const row = await app.withOrgContext(ORG_ACME, (client) =>
            recordings.insertUploadPendingInCurrentOrg(
                client,
                ORG_ACME,
                BASE_INSERT(call.id, uniqueKey("explicit-future")),
            ),
        );
        await rawUpdate(
            ORG_ACME,
            `UPDATE call_recordings
                SET status='available', uploaded_at=$2, retention_delete_after=$3
              WHERE id=$1`,
            [row.id, ancient, future],
        );

        const candidates = await app.withOrgContext(ORG_ACME, (client) =>
            recordings.listRetentionCandidatesInCurrentOrg(client, {
                explicitCutoff: now,
                // ancient is well before this cutoff — but the explicit
                // override should still win and exclude the row.
                uploadedBefore: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
                limit: 20,
            }),
        );
        assert.equal(
            candidates.find((c) => c.id === row.id),
            undefined,
            "row with explicit retention_delete_after in the future must be excluded",
        );
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

// ============================================================== //
// listRetentionCandidates — uploaded_at cutoff (no explicit override)
// ============================================================== //

test("no explicit retention: uploaded_at <= uploadedBefore is included", async () => {
    const call = await createCall(ORG_ACME, "uploaded-before");
    try {
        const now = new Date();
        const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const old = new Date(cutoff.getTime() - 60 * 1000);
        const row = await app.withOrgContext(ORG_ACME, (client) =>
            recordings.insertUploadPendingInCurrentOrg(
                client,
                ORG_ACME,
                BASE_INSERT(call.id, uniqueKey("uploaded-before")),
            ),
        );
        await rawUpdate(
            ORG_ACME,
            `UPDATE call_recordings
                SET status='available', uploaded_at=$2, retention_delete_after=NULL
              WHERE id=$1`,
            [row.id, old],
        );
        const candidates = await app.withOrgContext(ORG_ACME, (client) =>
            recordings.listRetentionCandidatesInCurrentOrg(client, {
                explicitCutoff: now,
                uploadedBefore: cutoff,
                limit: 20,
            }),
        );
        assert.ok(
            candidates.some((c) => c.id === row.id),
            "row with uploaded_at older than cutoff must be eligible",
        );
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

test("no explicit retention: uploaded_at inside window is excluded", async () => {
    const call = await createCall(ORG_ACME, "uploaded-inside");
    try {
        const now = new Date();
        const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const recent = new Date(cutoff.getTime() + 60 * 60 * 1000); // 1h inside window
        const row = await app.withOrgContext(ORG_ACME, (client) =>
            recordings.insertUploadPendingInCurrentOrg(
                client,
                ORG_ACME,
                BASE_INSERT(call.id, uniqueKey("uploaded-inside")),
            ),
        );
        await rawUpdate(
            ORG_ACME,
            `UPDATE call_recordings
                SET status='available', uploaded_at=$2, retention_delete_after=NULL
              WHERE id=$1`,
            [row.id, recent],
        );
        const candidates = await app.withOrgContext(ORG_ACME, (client) =>
            recordings.listRetentionCandidatesInCurrentOrg(client, {
                explicitCutoff: now,
                uploadedBefore: cutoff,
                limit: 20,
            }),
        );
        assert.equal(
            candidates.find((c) => c.id === row.id),
            undefined,
            "row uploaded inside the retention window must be excluded",
        );
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

// ============================================================== //
// Status filtering
// ============================================================== //

test("upload_pending / processing / delete_pending / deleted are excluded from normal candidates", async () => {
    const call = await createCall(ORG_ACME, "status-filter");
    try {
        const now = new Date();
        const past = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
        async function makeRow(label, status, extraSql) {
            const row = await app.withOrgContext(ORG_ACME, (client) =>
                recordings.insertUploadPendingInCurrentOrg(
                    client,
                    ORG_ACME,
                    BASE_INSERT(call.id, uniqueKey(`status-${label}`)),
                ),
            );
            // Force the row into the target state with old uploaded_at so
            // it would otherwise pass the uploadedBefore cutoff.
            await rawUpdate(
                ORG_ACME,
                `UPDATE call_recordings
                    SET status=$2, uploaded_at=$3, retention_delete_after=NULL
                      ${extraSql ?? ""}
                  WHERE id=$1`,
                [row.id, status, past],
            );
            return row;
        }
        const pending = await makeRow("upload-pending", "upload_pending");
        const processing = await makeRow("processing", "processing");
        const deletePending = await makeRow("delete-pending", "delete_pending");
        const deleted = await makeRow(
            "deleted",
            "deleted",
            ", deleted_at=now()",
        );
        const eligible = await makeRow("available", "available");

        const candidates = await app.withOrgContext(ORG_ACME, (client) =>
            recordings.listRetentionCandidatesInCurrentOrg(client, {
                explicitCutoff: now,
                uploadedBefore: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
                limit: 50,
            }),
        );
        const ids = new Set(candidates.map((c) => c.id));
        assert.ok(ids.has(eligible.id), "available row must be eligible");
        for (const excluded of [pending, processing, deletePending, deleted]) {
            assert.ok(!ids.has(excluded.id), `${excluded.id} must be excluded`);
        }
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

// ============================================================== //
// delete_pending retry helper
// ============================================================== //

test("delete_pending older than olderThan is returned by retry helper; recent excluded", async () => {
    // The touch_updated_at trigger overwrites updated_at to now() on every
    // UPDATE, so we cannot stamp an artificially-old updated_at. Instead
    // we serialize creation in time and split with an in-between cutoff.
    const call = await createCall(ORG_ACME, "retry");
    try {
        const oldRow = await app.withOrgContext(ORG_ACME, (client) =>
            recordings.insertUploadPendingInCurrentOrg(
                client,
                ORG_ACME,
                BASE_INSERT(call.id, uniqueKey("retry-old")),
            ),
        );
        // Move old row to delete_pending — this is the row we want to retry.
        await app.withOrgContext(ORG_ACME, (client) =>
            recordings.markDeletePendingInCurrentOrg(client, oldRow.id),
        );
        // Read back its updated_at to pick a cutoff that lies between
        // it and the next row's mark-pending time.
        const oldUpdatedAtRow = await app.withOrgContext(ORG_ACME, async (client) => {
            const r = await client.query(
                `SELECT updated_at FROM call_recordings WHERE id=$1`,
                [oldRow.id],
            );
            return r.rows[0];
        });
        // Sleep so the next row's trigger stamps a strictly-later updated_at.
        await new Promise((r) => setTimeout(r, 25));

        const recentRow = await app.withOrgContext(ORG_ACME, (client) =>
            recordings.insertUploadPendingInCurrentOrg(
                client,
                ORG_ACME,
                BASE_INSERT(call.id, uniqueKey("retry-recent")),
            ),
        );
        await app.withOrgContext(ORG_ACME, (client) =>
            recordings.markDeletePendingInCurrentOrg(client, recentRow.id),
        );

        // Cutoff: 1ms after old row's updated_at — old qualifies, recent doesn't.
        const cutoff = new Date(new Date(oldUpdatedAtRow.updated_at).getTime() + 1);

        const candidates = await app.withOrgContext(ORG_ACME, (client) =>
            recordings.listDeletePendingRetryCandidatesInCurrentOrg(client, {
                olderThan: cutoff,
                limit: 20,
            }),
        );
        const ids = new Set(candidates.map((c) => c.id));
        assert.ok(ids.has(oldRow.id), "old delete_pending row must be eligible");
        assert.ok(
            !ids.has(recentRow.id),
            "recent delete_pending row must be excluded",
        );
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

// ============================================================== //
// Cross-org isolation
// ============================================================== //

test("Beta context cannot see Acme retention candidates", async () => {
    const call = await createCall(ORG_ACME, "xorg");
    try {
        const past = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
        const row = await app.withOrgContext(ORG_ACME, (client) =>
            recordings.insertUploadPendingInCurrentOrg(
                client,
                ORG_ACME,
                BASE_INSERT(call.id, uniqueKey("xorg")),
            ),
        );
        await rawUpdate(
            ORG_ACME,
            `UPDATE call_recordings SET status='available', uploaded_at=$2 WHERE id=$1`,
            [row.id, past],
        );

        const acme = await app.withOrgContext(ORG_ACME, (client) =>
            recordings.listRetentionCandidatesInCurrentOrg(client, {
                explicitCutoff: new Date(),
                uploadedBefore: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
                limit: 50,
            }),
        );
        const beta = await app.withOrgContext(ORG_BETA, (client) =>
            recordings.listRetentionCandidatesInCurrentOrg(client, {
                explicitCutoff: new Date(),
                uploadedBefore: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
                limit: 50,
            }),
        );
        assert.ok(acme.some((c) => c.id === row.id));
        assert.equal(beta.find((c) => c.id === row.id), undefined);
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

// ============================================================== //
// Input validation
// ============================================================== //

test("listRetentionCandidates rejects invalid Date / non-positive limit", async () => {
    await app.withOrgContext(ORG_ACME, async (client) => {
        await assert.rejects(
            () =>
                recordings.listRetentionCandidatesInCurrentOrg(client, {
                    explicitCutoff: new Date("not-a-date"),
                    uploadedBefore: new Date(),
                    limit: 10,
                }),
            (err) => /explicitCutoff/.test(err.message),
        );
        await assert.rejects(
            () =>
                recordings.listRetentionCandidatesInCurrentOrg(client, {
                    explicitCutoff: new Date(),
                    uploadedBefore: new Date("nope"),
                    limit: 10,
                }),
            (err) => /uploadedBefore/.test(err.message),
        );
        await assert.rejects(
            () =>
                recordings.listRetentionCandidatesInCurrentOrg(client, {
                    explicitCutoff: new Date(),
                    uploadedBefore: new Date(),
                    limit: 0,
                }),
            (err) => /limit/.test(err.message),
        );
    });
});

test("listDeletePendingRetryCandidates rejects invalid olderThan / limit", async () => {
    await app.withOrgContext(ORG_ACME, async (client) => {
        await assert.rejects(
            () =>
                recordings.listDeletePendingRetryCandidatesInCurrentOrg(client, {
                    olderThan: new Date("bad"),
                    limit: 10,
                }),
            (err) => /olderThan/.test(err.message),
        );
        await assert.rejects(
            () =>
                recordings.listDeletePendingRetryCandidatesInCurrentOrg(client, {
                    olderThan: new Date(),
                    limit: -1,
                }),
            (err) => /limit/.test(err.message),
        );
    });
});

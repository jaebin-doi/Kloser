/* Phase 8 Step 2 — call_recordings repository tests.
 *
 * Plan: docs/plan/phase-8/PHASE_8_STEP_2_PLAN.md §6.
 *
 * Scope:
 *   - RLS: bare pool (no GUC) sees 0 rows, cross-org context returns
 *     null/empty/false, raw cross-org INSERT raises 42501 (WITH CHECK)
 *     or 23503 (composite FK against calls).
 *   - Composite FK: (org_id, call_id) drift between calls and
 *     call_recordings raises 23503.
 *   - CHECK constraints: invalid content_type / status='deleted' with
 *     deleted_at=NULL raise 23514. Invalid checksum hex raises 23514.
 *     Bad object_key length raises 23514 too via length(...)>0 check.
 *   - UNIQUE (org_id, object_key): duplicate inserts raise 23505. The
 *     same key is allowed in a different org context.
 *   - Lifecycle helpers: pending -> uploaded -> available transitions,
 *     failed/markFailed metadata, soft delete + hard delete, and
 *     listByCall behaviour after each.
 *   - Retention candidate filter: only uploaded/available/failed rows
 *     past their retention horizon surface; upload_pending,
 *     delete_pending, deleted, and tombstoned rows are excluded.
 *   - Cascade: hard-deleting the parent call removes its recordings.
 *
 * Cleanup: each test creates a fresh call (and recordings underneath),
 * then hard-deletes the call in finally — recordings cascade via the
 * composite FK ON DELETE CASCADE. No seeded row is mutated.
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

// Test helper: hard-delete a parent call so the FK cascade also removes
// any call_recordings rows that the test created underneath it.
async function hardDeleteCall(orgId, id) {
    await app.withOrgContext(orgId, async (client) => {
        await client.query("DELETE FROM calls WHERE id = $1", [id]);
    });
}

async function createCall(orgId, suffix) {
    return app.withOrgContext(orgId, (client) =>
        calls.insertInCurrentOrg(client, orgId, {
            direction: "inbound",
            title: `phase8-step2-repo/${suffix}`,
        }),
    );
}

function uniqueKey(label) {
    return `phase8-step2-repo/${label}/${Date.now()}-${Math.random()
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

// ---------- 1. RLS: bare pool sees nothing ---------- //

test("bare pool (no withOrgContext, no GUC) → call_recordings SELECT returns 0", async () => {
    const r = await app.pg.query(
        "SELECT count(*)::int AS n FROM call_recordings",
    );
    assert.equal(r.rows[0].n, 0);
});

// ---------- 2. insert + get + listByCall ---------- //

test("Acme: insertUploadPending + getById + listByCall round-trip", async () => {
    const call = await createCall(ORG_ACME, "insert");
    try {
        const objectKey = uniqueKey("acme-insert");
        const created = await app.withOrgContext(ORG_ACME, (client) =>
            recordings.insertUploadPendingInCurrentOrg(
                client,
                ORG_ACME,
                BASE_INSERT(call.id, objectKey),
            ),
        );
        assert.equal(created.org_id, ORG_ACME);
        assert.equal(created.call_id, call.id);
        assert.equal(created.status, "upload_pending");
        assert.equal(created.storage_provider, "local");
        assert.equal(created.object_key, objectKey);
        assert.equal(created.content_type, "audio/webm");
        assert.equal(created.size_bytes, null);
        assert.equal(created.uploaded_at, null);
        assert.equal(created.deleted_at, null);
        assert.deepEqual(created.metadata, {});

        const fetched = await app.withOrgContext(ORG_ACME, (client) =>
            recordings.getByIdInCurrentOrg(client, created.id),
        );
        assert.equal(fetched?.id, created.id);

        const list = await app.withOrgContext(ORG_ACME, (client) =>
            recordings.listByCallInCurrentOrg(client, call.id),
        );
        assert.ok(list);
        assert.equal(list.length, 1);
        assert.equal(list[0].id, created.id);
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

// ---------- 3. cross-org isolation ---------- //

test("Beta cannot see / patch / delete Acme recording", async () => {
    const call = await createCall(ORG_ACME, "cross-org");
    try {
        const created = await app.withOrgContext(ORG_ACME, (client) =>
            recordings.insertUploadPendingInCurrentOrg(
                client,
                ORG_ACME,
                BASE_INSERT(call.id, uniqueKey("cross-org")),
            ),
        );

        const betaGet = await app.withOrgContext(ORG_BETA, (client) =>
            recordings.getByIdInCurrentOrg(client, created.id),
        );
        assert.equal(betaGet, null);

        const betaListByCall = await app.withOrgContext(ORG_BETA, (client) =>
            recordings.listByCallInCurrentOrg(client, call.id),
        );
        assert.equal(betaListByCall, null);

        const betaUpload = await app.withOrgContext(ORG_BETA, (client) =>
            recordings.markUploadedInCurrentOrg(client, created.id, {
                size_bytes: 1,
            }),
        );
        assert.equal(betaUpload, null);

        const betaDelete = await app.withOrgContext(ORG_BETA, (client) =>
            recordings.hardDeleteByIdInCurrentOrg(client, created.id),
        );
        assert.equal(betaDelete, false);

        // Acme row still visible and untouched.
        const stillThere = await app.withOrgContext(ORG_ACME, (client) =>
            recordings.getByIdInCurrentOrg(client, created.id),
        );
        assert.equal(stillThere?.status, "upload_pending");
        assert.equal(stillThere?.size_bytes, null);
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

// ---------- 4. RLS WITH CHECK on insert ---------- //

test("Acme context + insertUploadPending(client, ORG_BETA, ...) → 42501", async () => {
    const call = await createCall(ORG_ACME, "wrong-org-insert");
    try {
        await assert.rejects(
            app.withOrgContext(ORG_ACME, (client) =>
                recordings.insertUploadPendingInCurrentOrg(
                    client,
                    ORG_BETA,
                    BASE_INSERT(call.id, uniqueKey("wrong-org-insert")),
                ),
            ),
            (err) => {
                assert.equal(err.code, "42501", `expected 42501, got ${err.code}`);
                return true;
            },
        );
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

// ---------- 5. composite FK: Acme context, Acme org, but call from another org ---------- //

test("Acme recording referencing a Beta call_id raises 23503 (FK fails because RLS hides the Beta call from this transaction)", async () => {
    const betaCall = await createCall(ORG_BETA, "cross-org-call-fk");
    try {
        await assert.rejects(
            app.withOrgContext(ORG_ACME, (client) =>
                recordings.insertUploadPendingInCurrentOrg(
                    client,
                    ORG_ACME,
                    BASE_INSERT(betaCall.id, uniqueKey("cross-org-fk")),
                ),
            ),
            (err) => {
                assert.equal(
                    err.code,
                    "23503",
                    `expected 23503, got ${err.code}`,
                );
                return true;
            },
        );
    } finally {
        await hardDeleteCall(ORG_BETA, betaCall.id);
    }
});

// ---------- 6. raw drift: org/call mismatch is rejected by composite FK ---------- //

test("raw INSERT with mismatched (org_id, call_id) → 23503", async () => {
    // Acme call. Under Beta context try to insert a recording whose
    // call_id points at the Acme call but org_id=Beta. Composite FK
    // (org_id, call_id) → calls(org_id, id) is unresolvable: 23503.
    const acmeCall = await createCall(ORG_ACME, "raw-drift");
    try {
        await assert.rejects(
            app.withOrgContext(ORG_BETA, (client) =>
                client.query(
                    `INSERT INTO call_recordings (
                         org_id, call_id, status,
                         storage_provider, object_key, content_type
                     ) VALUES ($1, $2, 'upload_pending', 'local', $3, 'audio/webm')`,
                    [ORG_BETA, acmeCall.id, uniqueKey("raw-drift")],
                ),
            ),
            (err) => {
                assert.equal(
                    err.code,
                    "23503",
                    `expected 23503, got ${err.code}`,
                );
                return true;
            },
        );
    } finally {
        await hardDeleteCall(ORG_ACME, acmeCall.id);
    }
});

// ---------- 7. lifecycle: upload_pending → uploaded → available ---------- //

test("lifecycle markUploaded → markAvailable transitions row state and finalize metadata", async () => {
    const call = await createCall(ORG_ACME, "lifecycle");
    try {
        const created = await app.withOrgContext(ORG_ACME, (client) =>
            recordings.insertUploadPendingInCurrentOrg(
                client,
                ORG_ACME,
                BASE_INSERT(call.id, uniqueKey("lifecycle")),
            ),
        );

        const uploaded = await app.withOrgContext(ORG_ACME, (client) =>
            recordings.markUploadedInCurrentOrg(client, created.id, {
                size_bytes: 4096,
                duration_seconds: 12,
                checksum_sha256: "a".repeat(64),
                object_version: "v1",
            }),
        );
        assert.ok(uploaded);
        assert.equal(uploaded.status, "uploaded");
        assert.equal(uploaded.size_bytes, 4096);
        assert.equal(uploaded.duration_seconds, 12);
        assert.equal(uploaded.checksum_sha256, "a".repeat(64));
        assert.equal(uploaded.object_version, "v1");
        assert.ok(uploaded.uploaded_at instanceof Date);

        const available = await app.withOrgContext(ORG_ACME, (client) =>
            recordings.markAvailableInCurrentOrg(client, created.id),
        );
        assert.equal(available?.status, "available");

        // markUploaded on an already-available row should return null
        // (state guard: only upload_pending|failed can move to uploaded).
        const noOp = await app.withOrgContext(ORG_ACME, (client) =>
            recordings.markUploadedInCurrentOrg(client, created.id, {
                size_bytes: 1,
            }),
        );
        assert.equal(noOp, null);
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

// ---------- 8. markFailed → status='failed' + error_message ---------- //

test("markFailed stores bounded error_message and surfaces it as 'failed'", async () => {
    const call = await createCall(ORG_ACME, "fail");
    try {
        const created = await app.withOrgContext(ORG_ACME, (client) =>
            recordings.insertUploadPendingInCurrentOrg(
                client,
                ORG_ACME,
                BASE_INSERT(call.id, uniqueKey("fail")),
            ),
        );
        const failed = await app.withOrgContext(ORG_ACME, (client) =>
            recordings.markFailedInCurrentOrg(client, created.id, {
                error_message: "storage_upstream_timeout",
                metadata: { attempt: 1 },
            }),
        );
        assert.equal(failed?.status, "failed");
        assert.equal(failed?.error_message, "storage_upstream_timeout");
        assert.equal(failed?.metadata.attempt, 1);
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

// ---------- 9. soft delete (markDeleted) ---------- //

test("markDeleted tombstones row; listByCall hides it but getById still surfaces it for audit", async () => {
    const call = await createCall(ORG_ACME, "soft-delete");
    try {
        const created = await app.withOrgContext(ORG_ACME, (client) =>
            recordings.insertUploadPendingInCurrentOrg(
                client,
                ORG_ACME,
                BASE_INSERT(call.id, uniqueKey("soft-delete")),
            ),
        );
        const deletedAt = new Date();
        const deleted = await app.withOrgContext(ORG_ACME, (client) =>
            recordings.markDeletedInCurrentOrg(client, created.id, deletedAt),
        );
        assert.equal(deleted?.status, "deleted");
        assert.ok(deleted?.deleted_at instanceof Date);

        const list = await app.withOrgContext(ORG_ACME, (client) =>
            recordings.listByCallInCurrentOrg(client, call.id),
        );
        assert.ok(list);
        assert.equal(list.length, 0);

        const stillVisibleForAudit = await app.withOrgContext(
            ORG_ACME,
            (client) => recordings.getByIdInCurrentOrg(client, created.id),
        );
        assert.equal(stillVisibleForAudit?.status, "deleted");

        const active = await app.withOrgContext(ORG_ACME, (client) =>
            recordings.getActiveByIdInCurrentOrg(client, created.id),
        );
        assert.equal(active, null);
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

// ---------- 10. raw UPDATE → status='deleted' with deleted_at=NULL violates CHECK ---------- //

test("raw UPDATE to status='deleted' without deleted_at → 23514", async () => {
    const call = await createCall(ORG_ACME, "bad-deleted-check");
    try {
        const created = await app.withOrgContext(ORG_ACME, (client) =>
            recordings.insertUploadPendingInCurrentOrg(
                client,
                ORG_ACME,
                BASE_INSERT(call.id, uniqueKey("bad-deleted-check")),
            ),
        );
        await assert.rejects(
            app.withOrgContext(ORG_ACME, (client) =>
                client.query(
                    `UPDATE call_recordings
                        SET status='deleted', deleted_at=NULL
                      WHERE id=$1`,
                    [created.id],
                ),
            ),
            (err) => {
                assert.equal(err.code, "23514", `expected 23514, got ${err.code}`);
                return true;
            },
        );
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

// ---------- 11. UNIQUE (org_id, object_key) duplicate ---------- //

test("duplicate (org_id, object_key) → 23505; same key in another org is fine", async () => {
    const acmeCall = await createCall(ORG_ACME, "dup-acme");
    const betaCall = await createCall(ORG_BETA, "dup-beta");
    const objectKey = uniqueKey("dup");
    try {
        await app.withOrgContext(ORG_ACME, (client) =>
            recordings.insertUploadPendingInCurrentOrg(
                client,
                ORG_ACME,
                BASE_INSERT(acmeCall.id, objectKey),
            ),
        );
        await assert.rejects(
            app.withOrgContext(ORG_ACME, (client) =>
                recordings.insertUploadPendingInCurrentOrg(
                    client,
                    ORG_ACME,
                    BASE_INSERT(acmeCall.id, objectKey),
                ),
            ),
            (err) => {
                assert.equal(err.code, "23505", `expected 23505, got ${err.code}`);
                return true;
            },
        );

        // Same object_key inside a different org is allowed — the
        // UNIQUE constraint is scoped (org_id, object_key).
        const beta = await app.withOrgContext(ORG_BETA, (client) =>
            recordings.insertUploadPendingInCurrentOrg(
                client,
                ORG_BETA,
                BASE_INSERT(betaCall.id, objectKey),
            ),
        );
        assert.equal(beta.org_id, ORG_BETA);
    } finally {
        await hardDeleteCall(ORG_ACME, acmeCall.id);
        await hardDeleteCall(ORG_BETA, betaCall.id);
    }
});

// ---------- 12. invalid content_type rejected by CHECK ---------- //

test("invalid content_type → 23514", async () => {
    const call = await createCall(ORG_ACME, "bad-ct");
    try {
        await assert.rejects(
            app.withOrgContext(ORG_ACME, (client) =>
                client.query(
                    `INSERT INTO call_recordings (
                         org_id, call_id, status,
                         storage_provider, object_key, content_type
                     ) VALUES ($1, $2, 'upload_pending', 'local', $3, 'video/mp4')`,
                    [ORG_ACME, call.id, uniqueKey("bad-ct")],
                ),
            ),
            (err) => {
                assert.equal(err.code, "23514", `expected 23514, got ${err.code}`);
                return true;
            },
        );
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

// ---------- 13. invalid checksum hex rejected by CHECK ---------- //

test("invalid checksum_sha256 (not 64 hex) → 23514", async () => {
    const call = await createCall(ORG_ACME, "bad-checksum");
    try {
        const created = await app.withOrgContext(ORG_ACME, (client) =>
            recordings.insertUploadPendingInCurrentOrg(
                client,
                ORG_ACME,
                BASE_INSERT(call.id, uniqueKey("bad-checksum")),
            ),
        );
        await assert.rejects(
            app.withOrgContext(ORG_ACME, (client) =>
                client.query(
                    `UPDATE call_recordings SET checksum_sha256 = $1 WHERE id = $2`,
                    ["zz".repeat(32), created.id],
                ),
            ),
            (err) => {
                assert.equal(err.code, "23514", `expected 23514, got ${err.code}`);
                return true;
            },
        );
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

// ---------- 14. retention candidate filter ---------- //

test("listRetentionCandidates includes uploaded/available/failed past cutoff and excludes pending/deleted", async () => {
    const call = await createCall(ORG_ACME, "retention");
    try {
        const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const future = new Date(Date.now() + 24 * 60 * 60 * 1000);

        async function makeRow(label, mutate) {
            return app.withOrgContext(ORG_ACME, async (client) => {
                const r = await recordings.insertUploadPendingInCurrentOrg(
                    client,
                    ORG_ACME,
                    BASE_INSERT(call.id, uniqueKey(`retention-${label}`)),
                );
                if (mutate) await mutate(client, r);
                return r;
            });
        }

        // (a) eligible: uploaded + retention_delete_after in the past
        const a = await makeRow("a", async (client, row) => {
            await client.query(
                `UPDATE call_recordings
                    SET status='uploaded',
                        uploaded_at=$2,
                        retention_delete_after=$2
                  WHERE id=$1`,
                [row.id, past],
            );
        });

        // (b) eligible: available with no explicit cutoff but uploaded_at in the past
        const b = await makeRow("b", async (client, row) => {
            await client.query(
                `UPDATE call_recordings
                    SET status='available', uploaded_at=$2,
                        retention_delete_after=NULL
                  WHERE id=$1`,
                [row.id, past],
            );
        });

        // (c) eligible: failed with retention_delete_after in the past
        const c = await makeRow("c", async (client, row) => {
            await client.query(
                `UPDATE call_recordings
                    SET status='failed',
                        retention_delete_after=$2
                  WHERE id=$1`,
                [row.id, past],
            );
        });

        // (d) excluded: still upload_pending even if uploaded_at in the past
        const d = await makeRow("d", async (client, row) => {
            await client.query(
                `UPDATE call_recordings
                    SET uploaded_at=$2,
                        retention_delete_after=$2
                  WHERE id=$1`,
                [row.id, past],
            );
        });

        // (e) excluded: tombstoned via markDeleted
        const e = await makeRow("e", async (client, row) => {
            await client.query(
                `UPDATE call_recordings
                    SET status='available', uploaded_at=$2,
                        retention_delete_after=$2
                  WHERE id=$1`,
                [row.id, past],
            );
            await client.query(
                `UPDATE call_recordings
                    SET status='deleted', deleted_at=now()
                  WHERE id=$1`,
                [row.id],
            );
        });

        // (f) excluded: retention_delete_after in the future
        const f = await makeRow("f", async (client, row) => {
            await client.query(
                `UPDATE call_recordings
                    SET status='uploaded',
                        uploaded_at=$2,
                        retention_delete_after=$3
                  WHERE id=$1`,
                [row.id, past, future],
            );
        });

        // Phase 8 Step 5 split this helper into explicit + uploadedBefore
        // cutoffs. For the Step 2 regression case we set both to `now`
        // since the test rows already pre-stamp uploaded_at to `past`.
        const cutoff = new Date();
        const candidates = await app.withOrgContext(ORG_ACME, (client) =>
            recordings.listRetentionCandidatesInCurrentOrg(client, {
                explicitCutoff: cutoff,
                uploadedBefore: cutoff,
                limit: 50,
            }),
        );
        const ids = new Set(candidates.map((row) => row.id));
        assert.ok(ids.has(a.id), "uploaded row past cutoff should be eligible");
        assert.ok(ids.has(b.id), "available row past cutoff should be eligible");
        assert.ok(ids.has(c.id), "failed row past cutoff should be eligible");
        assert.ok(!ids.has(d.id), "upload_pending must be excluded");
        assert.ok(!ids.has(e.id), "deleted row must be excluded");
        assert.ok(!ids.has(f.id), "future cutoff must be excluded");
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

// ---------- 15. cascade: hard delete of parent call removes recordings ---------- //

test("hard delete of parent call cascades to call_recordings", async () => {
    const call = await createCall(ORG_ACME, "cascade");
    const created = await app.withOrgContext(ORG_ACME, (client) =>
        recordings.insertUploadPendingInCurrentOrg(
            client,
            ORG_ACME,
            BASE_INSERT(call.id, uniqueKey("cascade")),
        ),
    );
    assert.ok(created);

    await hardDeleteCall(ORG_ACME, call.id);

    // Recording row should also be gone.
    const afterCascade = await app.withOrgContext(ORG_ACME, (client) =>
        recordings.getByIdInCurrentOrg(client, created.id),
    );
    assert.equal(afterCascade, null);
});

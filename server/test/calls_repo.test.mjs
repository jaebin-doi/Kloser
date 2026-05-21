/* Phase 4 Step 2 — repository tests for calls / transcripts /
 * call_action_items.
 *
 * Scope (Step 2 plan §5.1):
 *   - RLS: bare pool sees 0, cross-org reads return null/empty/false,
 *     cross-org INSERT raises 42501.
 *   - Composite FKs: cross-org customer / agent / assignee raise 23503.
 *   - Soft delete: hidden from list/get, idempotent.
 *   - Transcript seq: serial appends produce 0, 1, ..., and Promise.all
 *     of two appends against the same call produces exactly two distinct
 *     consecutive seqs with no unique violation.
 *   - Action item CHECK: status='done' without completed_at raises 23514.
 *     Patches are hidden once the parent call is soft-deleted.
 *     when written via raw SQL.
 *   - Cascade: hard delete of a call removes its transcripts and action
 *     items.
 *
 * Cleanup pattern: every test that inserts a call wraps its work in a
 * try/finally and hard-deletes the call (CASCADE removes child rows).
 * No seed rows are modified.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import dbPlugin from "../src/plugins/db.js";
import * as calls from "../src/repositories/calls.js";
import * as transcripts from "../src/repositories/transcripts.js";
import * as actionItems from "../src/repositories/callActionItems.js";

const ORG_ACME = "11111111-1111-1111-1111-111111111111";
const ORG_BETA = "22222222-2222-2222-2222-222222222222";

const USER_ACME_ADMIN = "aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa";
const USER_ACME_EMP   = "aaaaaaaa-0002-0002-0002-aaaaaaaaaaaa";
const USER_BETA_ADMIN = "bbbbbbbb-0001-0001-0001-bbbbbbbbbbbb";

const CUSTOMER_ACME_KIM  = "eeeeeeee-1111-0001-0001-eeeeeeeeeeee";
const CUSTOMER_BETA_JUNG = "ffffffff-2222-0001-0001-ffffffffffff";

const DEFAULT_LIST = { limit: 100, offset: 0 };

let app;

before(async () => {
    app = Fastify({ logger: false });
    await app.register(dbPlugin);
});

after(async () => {
    await app.close();
});

// Test-only hard delete. Production never hard-deletes a call — the repo
// exposes soft delete. Hard delete is the cheap way to undo INSERTs
// between cases, and it cascades to transcripts + call_action_items so
// children clean themselves up.
async function hardDeleteCall(orgId, id) {
    await app.withOrgContext(orgId, async (client) => {
        await client.query("DELETE FROM calls WHERE id = $1", [id]);
    });
}

// ---------- 1. RLS: bare pool sees nothing ---------- //

test("bare pool (no withOrgContext, no GUC) → calls SELECT returns 0", async () => {
    const r = await app.pg.query("SELECT count(*)::int AS n FROM calls");
    assert.equal(r.rows[0].n, 0);
});

// ---------- 2. Acme insert + list + get round-trip ---------- //

test("Acme: insert + list + get round-trip", async () => {
    const created = await app.withOrgContext(ORG_ACME, (client) =>
        calls.insertInCurrentOrg(client, ORG_ACME, {
            customer_id: CUSTOMER_ACME_KIM,
            agent_user_id: USER_ACME_ADMIN,
            direction: "inbound",
            title: "phase4-repo-test/acme-insert",
        }),
    );
    try {
        assert.equal(created.org_id, ORG_ACME);
        assert.equal(created.customer_id, CUSTOMER_ACME_KIM);
        assert.equal(created.direction, "inbound");
        assert.equal(created.status, "in_progress");
        assert.equal(created.duration_seconds, null);
        assert.equal(created.ended_at, null);
        assert.equal(created.deleted_at, null);

        const fetched = await app.withOrgContext(ORG_ACME, (client) =>
            calls.getByIdInCurrentOrg(client, created.id),
        );
        assert.ok(fetched);
        assert.equal(fetched.id, created.id);

        const list = await app.withOrgContext(ORG_ACME, (client) =>
            calls.listForCurrentOrg(client, DEFAULT_LIST),
        );
        assert.ok(list.find((c) => c.id === created.id));
    } finally {
        await hardDeleteCall(ORG_ACME, created.id);
    }
});

test("Acme: ended calls list by most recent ended_at first", async () => {
    const titlePrefix = `phase9-ended-order-${Date.now()}`;
    const created = await app.withOrgContext(ORG_ACME, async (client) => {
        const r = await client.query(
            `INSERT INTO calls (
                org_id, direction, status, title, started_at, ended_at, duration_seconds
             ) VALUES
                ($1, 'inbound', 'ended', $2, $3, $4, 300),
                ($1, 'inbound', 'ended', $5, $6, $7, 300)
             RETURNING id, title`,
            [
                ORG_ACME,
                `${titlePrefix}/started-newer-ended-older`,
                new Date("2026-01-02T00:00:00.000Z"),
                new Date("2026-01-02T00:05:00.000Z"),
                `${titlePrefix}/started-older-ended-newer`,
                new Date("2026-01-01T00:00:00.000Z"),
                new Date("2026-01-03T00:00:00.000Z"),
            ],
        );
        return r.rows;
    });

    try {
        const list = await app.withOrgContext(ORG_ACME, (client) =>
            calls.listForCurrentOrg(client, {
                ...DEFAULT_LIST,
                q: titlePrefix,
                status: "ended",
            }),
        );

        assert.deepEqual(
            list.map((c) => c.title),
            [
                `${titlePrefix}/started-older-ended-newer`,
                `${titlePrefix}/started-newer-ended-older`,
            ],
        );
    } finally {
        await Promise.all(created.map((row) => hardDeleteCall(ORG_ACME, row.id)));
    }
});

// ---------- 3. Cross-org read isolation ---------- //

test("Beta cannot see / update / soft-delete an Acme call", async () => {
    const acmeCall = await app.withOrgContext(ORG_ACME, (client) =>
        calls.insertInCurrentOrg(client, ORG_ACME, {
            direction: "outbound",
            title: "phase4-repo-test/cross-org-target",
        }),
    );
    try {
        const beta_get = await app.withOrgContext(ORG_BETA, (client) =>
            calls.getByIdInCurrentOrg(client, acmeCall.id),
        );
        assert.equal(beta_get, null);

        const beta_patch = await app.withOrgContext(ORG_BETA, (client) =>
            calls.patchNotesByIdInCurrentOrg(client, acmeCall.id, "x"),
        );
        assert.equal(beta_patch, null);

        const beta_end = await app.withOrgContext(ORG_BETA, (client) =>
            calls.endByIdInCurrentOrg(client, acmeCall.id, new Date(), "ended"),
        );
        assert.equal(beta_end, null);

        const beta_soft = await app.withOrgContext(ORG_BETA, (client) =>
            calls.softDeleteByIdInCurrentOrg(client, acmeCall.id),
        );
        assert.equal(beta_soft, false);

        // Acme row still intact.
        const stillThere = await app.withOrgContext(ORG_ACME, (client) =>
            calls.getByIdInCurrentOrg(client, acmeCall.id),
        );
        assert.ok(stillThere);
        assert.equal(stillThere.deleted_at, null);
    } finally {
        await hardDeleteCall(ORG_ACME, acmeCall.id);
    }
});

// ---------- 4. RLS WITH CHECK on insert ---------- //

test("Acme context + insertInCurrentOrg(client, ORG_BETA, ...) → 42501", async () => {
    await assert.rejects(
        app.withOrgContext(ORG_ACME, (client) =>
            calls.insertInCurrentOrg(client, ORG_BETA, {
                direction: "inbound",
            }),
        ),
        (err) => {
            assert.equal(err.code, "42501", `expected 42501, got ${err.code}`);
            return true;
        },
    );
});

// ---------- 5. Composite FK: Acme call cannot reference Beta customer ---------- //

test("Acme call referencing Beta customer_id → 23503", async () => {
    await assert.rejects(
        app.withOrgContext(ORG_ACME, (client) =>
            calls.insertInCurrentOrg(client, ORG_ACME, {
                customer_id: CUSTOMER_BETA_JUNG,
                direction: "inbound",
            }),
        ),
        (err) => {
            assert.equal(err.code, "23503", `expected 23503, got ${err.code}`);
            return true;
        },
    );
});

// ---------- 6. Composite FK: Acme call cannot reference Beta agent ---------- //

test("Acme call referencing Beta agent_user_id → 23503", async () => {
    await assert.rejects(
        app.withOrgContext(ORG_ACME, (client) =>
            calls.insertInCurrentOrg(client, ORG_ACME, {
                agent_user_id: USER_BETA_ADMIN,
                direction: "outbound",
            }),
        ),
        (err) => {
            assert.equal(err.code, "23503", `expected 23503, got ${err.code}`);
            return true;
        },
    );
});

// ---------- 7. Soft delete: hidden, idempotent ---------- //

test("softDelete hides row from list/get and is idempotent", async () => {
    const created = await app.withOrgContext(ORG_ACME, (client) =>
        calls.insertInCurrentOrg(client, ORG_ACME, {
            direction: "inbound",
            title: "phase4-repo-test/soft-delete",
        }),
    );
    try {
        const first = await app.withOrgContext(ORG_ACME, (client) =>
            calls.softDeleteByIdInCurrentOrg(client, created.id),
        );
        assert.equal(first, true);

        const fetched = await app.withOrgContext(ORG_ACME, (client) =>
            calls.getByIdInCurrentOrg(client, created.id),
        );
        assert.equal(fetched, null);

        const list = await app.withOrgContext(ORG_ACME, (client) =>
            calls.listForCurrentOrg(client, DEFAULT_LIST),
        );
        assert.equal(list.find((c) => c.id === created.id), undefined);

        const second = await app.withOrgContext(ORG_ACME, (client) =>
            calls.softDeleteByIdInCurrentOrg(client, created.id),
        );
        assert.equal(second, false);
    } finally {
        await hardDeleteCall(ORG_ACME, created.id);
    }
});

// ---------- 8. Transcript append: seq 0 then 1 ---------- //

test("transcripts: serial appendForCall → seq 0, 1, then list ASC", async () => {
    const call = await app.withOrgContext(ORG_ACME, (client) =>
        calls.insertInCurrentOrg(client, ORG_ACME, {
            direction: "inbound",
            title: "phase4-repo-test/transcript-serial",
        }),
    );
    try {
        const first = await app.withOrgContext(ORG_ACME, (client) =>
            transcripts.appendForCallInCurrentOrg(client, call.id, {
                speaker: "agent",
                text: "안녕하세요",
            }),
        );
        assert.ok(first);
        assert.equal(first.seq, 0);
        assert.equal(first.org_id, ORG_ACME);

        const second = await app.withOrgContext(ORG_ACME, (client) =>
            transcripts.appendForCallInCurrentOrg(client, call.id, {
                speaker: "customer",
                text: "네 안녕하세요",
            }),
        );
        assert.ok(second);
        assert.equal(second.seq, 1);

        const list = await app.withOrgContext(ORG_ACME, (client) =>
            transcripts.listByCallInCurrentOrg(client, call.id),
        );
        assert.ok(list);
        assert.equal(list.length, 2);
        assert.equal(list[0].seq, 0);
        assert.equal(list[1].seq, 1);
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

// ---------- 9. Transcript append: cross-org returns null ---------- //

test("transcripts: cross-org appendForCall → null", async () => {
    const call = await app.withOrgContext(ORG_ACME, (client) =>
        calls.insertInCurrentOrg(client, ORG_ACME, {
            direction: "inbound",
        }),
    );
    try {
        const r = await app.withOrgContext(ORG_BETA, (client) =>
            transcripts.appendForCallInCurrentOrg(client, call.id, {
                speaker: "agent",
                text: "drift attempt",
            }),
        );
        assert.equal(r, null);
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

// ---------- 10. Transcript drift INSERT: composite FK 23503 ---------- //

test("transcripts: raw INSERT with mismatched (org_id, call_id) → 23503", async () => {
    // Acme creates a call, then under Beta context we try to insert a
    // transcript whose call_id points at the Acme call but org_id is Beta.
    // The composite FK transcripts(org_id, call_id) → calls(org_id, id)
    // makes that combination unresolvable: 23503.
    const call = await app.withOrgContext(ORG_ACME, (client) =>
        calls.insertInCurrentOrg(client, ORG_ACME, {
            direction: "inbound",
        }),
    );
    try {
        await assert.rejects(
            app.withOrgContext(ORG_BETA, (client) =>
                client.query(
                    `INSERT INTO transcripts (org_id, call_id, seq, speaker, text)
                     VALUES ($1, $2, 0, 'agent', 'drift')`,
                    [ORG_BETA, call.id],
                ),
            ),
            (err) => {
                assert.equal(err.code, "23503", `expected 23503, got ${err.code}`);
                return true;
            },
        );
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

// ---------- 11. Concurrent appendForCall on same call ---------- //

test("transcripts: Promise.all of two appends on same call → seqs 0 + 1, no unique violation", async () => {
    const call = await app.withOrgContext(ORG_ACME, (client) =>
        calls.insertInCurrentOrg(client, ORG_ACME, {
            direction: "inbound",
            title: "phase4-repo-test/concurrent-append",
        }),
    );
    try {
        // Each withOrgContext opens its own transaction and connection,
        // so the two appends really do run on separate clients. The FOR
        // UPDATE inside appendForCallInCurrentOrg serialises them on the
        // calls row.
        const results = await Promise.all([
            app.withOrgContext(ORG_ACME, (client) =>
                transcripts.appendForCallInCurrentOrg(client, call.id, {
                    speaker: "agent",
                    text: "concurrent-1",
                }),
            ),
            app.withOrgContext(ORG_ACME, (client) =>
                transcripts.appendForCallInCurrentOrg(client, call.id, {
                    speaker: "customer",
                    text: "concurrent-2",
                }),
            ),
        ]);
        const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
        assert.deepEqual(seqs, [0, 1], `expected [0,1], got ${JSON.stringify(seqs)}`);

        const list = await app.withOrgContext(ORG_ACME, (client) =>
            transcripts.listByCallInCurrentOrg(client, call.id),
        );
        assert.equal(list.length, 2);
        assert.equal(list[0].seq, 0);
        assert.equal(list[1].seq, 1);
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

// ---------- 12. transcripts cascade on calls hard delete ---------- //

test("transcripts cascade when parent call is hard-deleted", async () => {
    const call = await app.withOrgContext(ORG_ACME, (client) =>
        calls.insertInCurrentOrg(client, ORG_ACME, {
            direction: "inbound",
        }),
    );
    await app.withOrgContext(ORG_ACME, (client) =>
        transcripts.appendForCallInCurrentOrg(client, call.id, {
            speaker: "agent",
            text: "to be cascaded",
        }),
    );
    const before = await app.withOrgContext(ORG_ACME, (client) =>
        transcripts.countByCallInCurrentOrg(client, call.id),
    );
    assert.equal(before, 1);

    await hardDeleteCall(ORG_ACME, call.id);

    // After cascade the call itself is gone, so count helper returns
    // null (call missing). Reaching null here proves both the call and
    // its transcripts were removed by the cascade.
    const after = await app.withOrgContext(ORG_ACME, (client) =>
        transcripts.countByCallInCurrentOrg(client, call.id),
    );
    assert.equal(after, null);
});

// ---------- 13. Action item create + list (open/null completed_at) ---------- //

test("action items: create → status=open, completed_at=null", async () => {
    const call = await app.withOrgContext(ORG_ACME, (client) =>
        calls.insertInCurrentOrg(client, ORG_ACME, { direction: "inbound" }),
    );
    try {
        const item = await app.withOrgContext(ORG_ACME, (client) =>
            actionItems.createForCallInCurrentOrg(client, call.id, {
                title: "phase4-repo-test/action-create",
                assignee_user_id: USER_ACME_EMP,
            }),
        );
        assert.ok(item);
        assert.equal(item.status, "open");
        assert.equal(item.completed_at, null);
        assert.equal(item.assignee_user_id, USER_ACME_EMP);

        const list = await app.withOrgContext(ORG_ACME, (client) =>
            actionItems.listByCallInCurrentOrg(client, call.id),
        );
        assert.ok(list);
        assert.equal(list.length, 1);
        assert.equal(list[0].id, item.id);
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

// ---------- 14. Action item status flow: open → done → open ---------- //

test("action items: status flow keeps completed_at consistent with CHECK", async () => {
    const call = await app.withOrgContext(ORG_ACME, (client) =>
        calls.insertInCurrentOrg(client, ORG_ACME, { direction: "inbound" }),
    );
    try {
        const item = await app.withOrgContext(ORG_ACME, (client) =>
            actionItems.createForCallInCurrentOrg(client, call.id, {
                title: "phase4-repo-test/action-flow",
            }),
        );
        const done = await app.withOrgContext(ORG_ACME, (client) =>
            actionItems.patchStatusInCurrentOrg(client, item.id, "done"),
        );
        assert.ok(done);
        assert.equal(done.status, "done");
        assert.ok(done.completed_at instanceof Date);

        const reopened = await app.withOrgContext(ORG_ACME, (client) =>
            actionItems.patchStatusInCurrentOrg(client, item.id, "open"),
        );
        assert.ok(reopened);
        assert.equal(reopened.status, "open");
        assert.equal(reopened.completed_at, null);

        const dropped = await app.withOrgContext(ORG_ACME, (client) =>
            actionItems.patchStatusInCurrentOrg(client, item.id, "dropped"),
        );
        assert.ok(dropped);
        assert.equal(dropped.status, "dropped");
        assert.equal(dropped.completed_at, null);
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

// ---------- 15. Action item patches hide rows whose parent call is soft-deleted ---------- //

test("action items: patch returns null after parent call soft-delete", async () => {
    const call = await app.withOrgContext(ORG_ACME, (client) =>
        calls.insertInCurrentOrg(client, ORG_ACME, { direction: "inbound" }),
    );
    try {
        const item = await app.withOrgContext(ORG_ACME, (client) =>
            actionItems.createForCallInCurrentOrg(client, call.id, {
                title: "phase4-repo-test/action-parent-soft-delete",
            }),
        );
        assert.ok(item);

        const deleted = await app.withOrgContext(ORG_ACME, (client) =>
            calls.softDeleteByIdInCurrentOrg(client, call.id),
        );
        assert.equal(deleted, true);

        const patchedStatus = await app.withOrgContext(ORG_ACME, (client) =>
            actionItems.patchStatusInCurrentOrg(client, item.id, "done"),
        );
        assert.equal(patchedStatus, null);

        const patchedAssignee = await app.withOrgContext(ORG_ACME, (client) =>
            actionItems.patchAssigneeInCurrentOrg(client, item.id, USER_ACME_EMP),
        );
        assert.equal(patchedAssignee, null);

        const listed = await app.withOrgContext(ORG_ACME, (client) =>
            actionItems.listByCallInCurrentOrg(client, call.id),
        );
        assert.equal(listed, null);
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

// ---------- 16. Action item CHECK: status=done w/o completed_at → 23514 ---------- //

test("action items: raw INSERT done w/o completed_at → 23514", async () => {
    const call = await app.withOrgContext(ORG_ACME, (client) =>
        calls.insertInCurrentOrg(client, ORG_ACME, { direction: "inbound" }),
    );
    try {
        await assert.rejects(
            app.withOrgContext(ORG_ACME, (client) =>
                client.query(
                    `INSERT INTO call_action_items (
                         org_id, call_id, title, status, completed_at
                     ) VALUES ($1, $2, $3, 'done', NULL)`,
                    [ORG_ACME, call.id, "bad-done"],
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

// ---------- 17. Action item: Beta assignee_user_id → 23503 ---------- //

test("action items: Acme call + Beta assignee_user_id → 23503", async () => {
    const call = await app.withOrgContext(ORG_ACME, (client) =>
        calls.insertInCurrentOrg(client, ORG_ACME, { direction: "inbound" }),
    );
    try {
        await assert.rejects(
            app.withOrgContext(ORG_ACME, (client) =>
                actionItems.createForCallInCurrentOrg(client, call.id, {
                    title: "phase4-repo-test/cross-org-assignee",
                    assignee_user_id: USER_BETA_ADMIN,
                }),
            ),
            (err) => {
                assert.equal(err.code, "23503", `expected 23503, got ${err.code}`);
                return true;
            },
        );
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

// ---------- 18. Action item: cross-org call create/list → null ---------- //

test("action items: cross-org create/list returns null", async () => {
    const call = await app.withOrgContext(ORG_ACME, (client) =>
        calls.insertInCurrentOrg(client, ORG_ACME, { direction: "inbound" }),
    );
    try {
        const created = await app.withOrgContext(ORG_BETA, (client) =>
            actionItems.createForCallInCurrentOrg(client, call.id, {
                title: "drift",
            }),
        );
        assert.equal(created, null);

        const listed = await app.withOrgContext(ORG_BETA, (client) =>
            actionItems.listByCallInCurrentOrg(client, call.id),
        );
        assert.equal(listed, null);
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

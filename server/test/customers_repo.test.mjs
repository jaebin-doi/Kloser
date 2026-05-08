/* customers repository tests — Phase 2 Step 2 §7.
 *
 * 12 cases:
 *   RLS isolation 1-6:  bare pool, Acme list, Beta list, WITH CHECK
 *                       violation on insert, cross-org update returns null,
 *                       cross-org soft-delete returns false.
 *   CRUD/behavior 7-12: insert+list round-trip, update + trigger,
 *                       soft-delete invisibility, soft-delete idempotency,
 *                       q='kloser' search, statsForCurrentOrg.
 *
 * Each mutation case unwinds itself via try/finally. INSERT cases hard
 * delete the inserted row through a separate withOrgContext (no
 * production code path should hard-delete customers — the repository
 * deliberately exposes only soft-delete). Soft-delete cases either use
 * a freshly inserted row (cleaned up by hard delete) or restore
 * deleted_at = NULL on a seeded row.
 *
 * Pre-req: docker compose up + db:migrate up + db:seed (seeds
 * 0001_demo.sql + 0002_customers.sql apply 24 customer rows).
 *
 * Run:  cd server && npm test
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import dbPlugin from "../src/plugins/db.js";
import * as customers from "../src/repositories/customers.js";

const ORG_ACME = "11111111-1111-1111-1111-111111111111";
const ORG_BETA = "22222222-2222-2222-2222-222222222222";

const ACME_KIM_ID = "eeeeeeee-1111-0001-0001-eeeeeeeeeeee";
const BETA_JUNG_ID = "ffffffff-2222-0001-0001-ffffffffffff";

const DEFAULT_LIST_OPTS = {
    limit: 100,
    offset: 0,
    sort: "created_at",
    dir: "desc",
};

let app;

before(async () => {
    app = Fastify({ logger: false });
    await app.register(dbPlugin);
});

after(async () => {
    await app.close();
});

// Test-only hard delete. Production code never hard-deletes customers
// (the repository exposes only soft-delete), so we keep this helper out
// of src/ and use it strictly to undo INSERT mutations between cases.
async function hardDelete(orgId, id) {
    await app.withOrgContext(orgId, async (client) => {
        await client.query("DELETE FROM customers WHERE id = $1", [id]);
    });
}

async function restoreSoftDeleted(orgId, id) {
    await app.withOrgContext(orgId, async (client) => {
        await client.query(
            "UPDATE customers SET deleted_at = NULL WHERE id = $1",
            [id],
        );
    });
}

// ---------- RLS isolation (cases 1-6) ---------- //

test("1. bare pool (no withOrgContext, no GUC) → 0 rows", async () => {
    // RLS forced + helper resolves missing GUC to NULL via NULLIF, so
    // org_id = NULL never matches any row.
    const r = await app.pg.query("SELECT count(*)::int AS n FROM customers");
    assert.equal(r.rows[0].n, 0);
});

test("2. withOrgContext(Acme) → listForCurrentOrg returns 12 Acme rows", async () => {
    const rows = await app.withOrgContext(ORG_ACME, (client) =>
        customers.listForCurrentOrg(client, DEFAULT_LIST_OPTS),
    );
    assert.equal(rows.length, 12);
    for (const c of rows) {
        assert.equal(c.org_id, ORG_ACME);
    }
});

test("3. withOrgContext(Beta) → 12 Beta rows, name set disjoint from Acme", async () => {
    const acmeRows = await app.withOrgContext(ORG_ACME, (client) =>
        customers.listForCurrentOrg(client, DEFAULT_LIST_OPTS),
    );
    const betaRows = await app.withOrgContext(ORG_BETA, (client) =>
        customers.listForCurrentOrg(client, DEFAULT_LIST_OPTS),
    );
    assert.equal(betaRows.length, 12);
    for (const c of betaRows) {
        assert.equal(c.org_id, ORG_BETA);
    }
    const acmeNames = new Set(acmeRows.map((c) => c.name));
    for (const beta of betaRows) {
        assert.ok(
            !acmeNames.has(beta.name),
            `beta name ${beta.name} should not appear in acme set`,
        );
    }
});

test("4. Acme context + insertInCurrentOrg(client, ORG_BETA, ...) → 42501", async () => {
    // Repository orgId argument is tampered to point at a different org
    // than the GUC. RLS WITH CHECK must reject at the SQL layer even when
    // the application-layer caller bypasses the service.
    await assert.rejects(
        app.withOrgContext(ORG_ACME, (client) =>
            customers.insertInCurrentOrg(client, ORG_BETA, {
                name: "rls-check-violator",
            }),
        ),
        (err) => {
            assert.equal(err.code, "42501", `expected 42501, got ${err.code}`);
            return true;
        },
    );
});

test("5. Acme context + updateByIdInCurrentOrg(beta_customer_id) → null", async () => {
    const result = await app.withOrgContext(ORG_ACME, (client) =>
        customers.updateByIdInCurrentOrg(client, BETA_JUNG_ID, { name: "X" }),
    );
    assert.equal(result, null);

    // Confirm the Beta row was untouched.
    const betaRow = await app.withOrgContext(ORG_BETA, (client) =>
        customers.getByIdInCurrentOrg(client, BETA_JUNG_ID),
    );
    assert.ok(betaRow);
    assert.notEqual(betaRow.name, "X");
});

test("6. Acme context + softDeleteByIdInCurrentOrg(beta_customer_id) → false", async () => {
    const ok = await app.withOrgContext(ORG_ACME, (client) =>
        customers.softDeleteByIdInCurrentOrg(client, BETA_JUNG_ID),
    );
    assert.equal(ok, false);

    // Beta row still alive.
    const betaRow = await app.withOrgContext(ORG_BETA, (client) =>
        customers.getByIdInCurrentOrg(client, BETA_JUNG_ID),
    );
    assert.ok(betaRow);
});

// ---------- CRUD + index/trigger/soft-delete (cases 7-12) ---------- //

test("7. insertInCurrentOrg + listForCurrentOrg shows new row, total = 13", async () => {
    const inserted = await app.withOrgContext(ORG_ACME, (client) =>
        customers.insertInCurrentOrg(client, ORG_ACME, {
            name: "Phase2 Step2 case7",
            company: "TestCo",
        }),
    );
    try {
        assert.equal(inserted.org_id, ORG_ACME);
        assert.equal(inserted.name, "Phase2 Step2 case7");
        assert.equal(inserted.status, "pending");

        const rows = await app.withOrgContext(ORG_ACME, (client) =>
            customers.listForCurrentOrg(client, DEFAULT_LIST_OPTS),
        );
        assert.equal(rows.length, 13);
        assert.ok(
            rows.find((c) => c.id === inserted.id),
            "newly inserted row should be visible in list",
        );
    } finally {
        await hardDelete(ORG_ACME, inserted.id);
    }
});

test("8. updateByIdInCurrentOrg sets name + touch_updated_at trigger fires", async () => {
    const inserted = await app.withOrgContext(ORG_ACME, (client) =>
        customers.insertInCurrentOrg(client, ORG_ACME, {
            name: "case8-original",
        }),
    );
    try {
        // Separate withOrgContext = separate transaction = separate now().
        // Inside one transaction, transaction_timestamp() is constant, so
        // created_at would equal updated_at and the trigger check would
        // be vacuous.
        const updated = await app.withOrgContext(ORG_ACME, (client) =>
            customers.updateByIdInCurrentOrg(client, inserted.id, {
                name: "case8-updated",
            }),
        );
        assert.ok(updated);
        assert.equal(updated.name, "case8-updated");
        assert.ok(
            updated.updated_at.getTime() > updated.created_at.getTime(),
            "updated_at must advance past created_at via touch_updated_at trigger",
        );
    } finally {
        await hardDelete(ORG_ACME, inserted.id);
    }
});

test("9. softDelete + list → row hidden, count = 12", async () => {
    const inserted = await app.withOrgContext(ORG_ACME, (client) =>
        customers.insertInCurrentOrg(client, ORG_ACME, {
            name: "case9-soft-delete",
        }),
    );
    try {
        // Confirm baseline is 13 (12 seed + 1 inserted).
        const beforeRows = await app.withOrgContext(ORG_ACME, (client) =>
            customers.listForCurrentOrg(client, DEFAULT_LIST_OPTS),
        );
        assert.equal(beforeRows.length, 13);

        const ok = await app.withOrgContext(ORG_ACME, (client) =>
            customers.softDeleteByIdInCurrentOrg(client, inserted.id),
        );
        assert.equal(ok, true);

        const afterRows = await app.withOrgContext(ORG_ACME, (client) =>
            customers.listForCurrentOrg(client, DEFAULT_LIST_OPTS),
        );
        assert.equal(afterRows.length, 12);
        assert.equal(
            afterRows.find((c) => c.id === inserted.id),
            undefined,
            "soft-deleted row must be invisible to list",
        );

        // getByIdInCurrentOrg also filters deleted_at IS NULL.
        const fetched = await app.withOrgContext(ORG_ACME, (client) =>
            customers.getByIdInCurrentOrg(client, inserted.id),
        );
        assert.equal(fetched, null);
    } finally {
        await hardDelete(ORG_ACME, inserted.id);
    }
});

test("10. softDelete is idempotent — second call returns false", async () => {
    const inserted = await app.withOrgContext(ORG_ACME, (client) =>
        customers.insertInCurrentOrg(client, ORG_ACME, {
            name: "case10-idempotent",
        }),
    );
    try {
        const first = await app.withOrgContext(ORG_ACME, (client) =>
            customers.softDeleteByIdInCurrentOrg(client, inserted.id),
        );
        assert.equal(first, true);

        const second = await app.withOrgContext(ORG_ACME, (client) =>
            customers.softDeleteByIdInCurrentOrg(client, inserted.id),
        );
        assert.equal(
            second,
            false,
            "second soft-delete must be a no-op (rowCount=0) because deleted_at IS NULL filter excludes already-deleted rows",
        );
    } finally {
        await hardDelete(ORG_ACME, inserted.id);
    }
});

test("11. listForCurrentOrg with q='kloser' returns 1 row (Kim/Kloser Inc.)", async () => {
    // 'kloser' matches kim@kloser.com (email) AND Kloser Inc. (company)
    // — both fields belong to the same row, so the result is exactly 1.
    const rows = await app.withOrgContext(ORG_ACME, (client) =>
        customers.listForCurrentOrg(client, {
            ...DEFAULT_LIST_OPTS,
            q: "kloser",
        }),
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, ACME_KIM_ID);
    assert.equal(rows[0].company, "Kloser Inc.");
});

test("12. statsForCurrentOrg → { total: 12, active: 7, review: 3, pending: 2 } (Acme seed)", async () => {
    // From seeds/0002_customers.sql: Acme has
    //   active:  김민수, 박서준, 정유진, 강지훈, 윤서아, 조성훈, 임채영 = 7
    //   review:  이지은, 한수민, 오민재 = 3
    //   pending: 최서연, 신예린 = 2
    const stats = await app.withOrgContext(ORG_ACME, (client) =>
        customers.statsForCurrentOrg(client),
    );
    assert.deepEqual(stats, {
        total: 12,
        active: 7,
        review: 3,
        pending: 2,
    });

    // Sanity: re-do under Beta context to confirm RLS scoping at the
    // aggregate level (different distribution).
    const betaStats = await app.withOrgContext(ORG_BETA, (client) =>
        customers.statsForCurrentOrg(client),
    );
    assert.equal(betaStats.total, 12);
    assert.equal(
        betaStats.active + betaStats.review + betaStats.pending,
        12,
        "stats partition should sum to total",
    );
});

// Soft-delete-restore helper kept available for future cases that mutate
// seeded rows directly. Not used by cases above (they all insert fresh).
void restoreSoftDeleted;

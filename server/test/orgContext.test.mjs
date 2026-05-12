/* orgContext middleware — Phase 1 Step 2 §7.
 *
 * Lives under server/test/ so node_modules resolution finds fastify et al.
 * directly. Run via tsx so the .ts source imports resolve:
 *
 *   cd server && npx tsx --test test/orgContext.test.mjs
 *
 * Three contracts:
 *   - missing X-Org-Id           → 401
 *   - present but not a UUID     → 400
 *   - valid UUID                 → handler runs, request.orgId is set
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import { orgContext } from "../src/middleware/orgContext.js";
import dbPlugin from "../src/plugins/db.js";

function buildApp() {
    const app = Fastify({ logger: false });
    app.addHook("preHandler", orgContext);
    app.get("/probe", async (request) => ({ orgId: request.orgId }));
    return app;
}

test("missing X-Org-Id → 401", async () => {
    const app = buildApp();
    const r = await app.inject({ method: "GET", url: "/probe" });
    assert.equal(r.statusCode, 401);
    assert.deepEqual(r.json(), { error: "missing X-Org-Id" });
    await app.close();
});

test("malformed X-Org-Id → 400", async () => {
    const app = buildApp();
    const cases = ["", "not-a-uuid", "11111111-1111-1111-1111", "'; DROP TABLE x;--"];
    for (const value of cases) {
        const r = await app.inject({
            method: "GET",
            url: "/probe",
            headers: { "x-org-id": value },
        });
        // Empty header is treated as missing → 401 (header undefined). Bad
        // format strings → 400. Both are "rejection at the edge".
        if (value === "") {
            assert.equal(r.statusCode, 401, `empty header: ${value}`);
        } else {
            assert.equal(r.statusCode, 400, `case: ${value}`);
            assert.equal(r.json().error, "X-Org-Id is not a valid UUID");
        }
    }
    await app.close();
});

test("valid UUID → 200, request.orgId is the same value", async () => {
    const app = buildApp();
    const orgId = "11111111-1111-1111-1111-111111111111";
    const r = await app.inject({
        method: "GET",
        url: "/probe",
        headers: { "x-org-id": orgId },
    });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { orgId });
    await app.close();
});

// ---------- Phase 5 Step 2: withOrgContext overload ---------- //
//
// The Phase 5 plan adds a 3-arg form `(orgId, userId, fn)` that sets
// app.user_id GUC for the transaction. The 2-arg form must keep working
// untouched (Phase 4 routes/services already use it everywhere). Both
// GUCs must be transaction-local — set_config(..., true) — so a leaked
// pool client cannot carry the context into a later request.

const ORG_ACME       = "11111111-1111-1111-1111-111111111111";
const USER_ACME_ADMIN = "aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa";

let dbApp;

before(async () => {
    dbApp = Fastify({ logger: false });
    await dbApp.register(dbPlugin);
});

after(async () => {
    await dbApp.close();
});

test("withOrgContext old (orgId, fn) signature still works", async () => {
    const orgId = await dbApp.withOrgContext(ORG_ACME, async (client) => {
        const r = await client.query("SELECT current_app_org_id() AS v");
        return r.rows[0].v;
    });
    assert.equal(orgId, ORG_ACME);
});

test("withOrgContext old (orgId, fn) leaves app.user_id NULL", async () => {
    const userId = await dbApp.withOrgContext(ORG_ACME, async (client) => {
        const r = await client.query("SELECT current_app_user_id() AS v");
        return r.rows[0].v;
    });
    assert.equal(userId, null);
});

test("withOrgContext new (orgId, userId, fn) sets app.user_id", async () => {
    const { orgId, userId } = await dbApp.withOrgContext(
        ORG_ACME,
        USER_ACME_ADMIN,
        async (client) => {
            const r = await client.query(
                "SELECT current_app_org_id() AS org, current_app_user_id() AS u",
            );
            return { orgId: r.rows[0].org, userId: r.rows[0].u };
        },
    );
    assert.equal(orgId, ORG_ACME);
    assert.equal(userId, USER_ACME_ADMIN);
});

test("withOrgContext new form with userId=null leaves current_app_user_id() NULL", async () => {
    const userId = await dbApp.withOrgContext(ORG_ACME, null, async (client) => {
        const r = await client.query("SELECT current_app_user_id() AS v");
        return r.rows[0].v;
    });
    assert.equal(userId, null);
});

test("withOrgContext app.user_id does not leak after transaction commit", async () => {
    // First run sets app.user_id inside its transaction.
    await dbApp.withOrgContext(ORG_ACME, USER_ACME_ADMIN, async (client) => {
        const r = await client.query("SELECT current_app_user_id() AS v");
        assert.equal(r.rows[0].v, USER_ACME_ADMIN);
    });
    // Bare pool query afterwards (no withOrgContext) must see NULL —
    // set_config(..., true) is SET LOCAL semantics and the connection
    // returned to the pool should have no residual GUC.
    const bare = await dbApp.pg.query(
        "SELECT current_app_user_id() AS v",
    );
    assert.equal(bare.rows[0].v, null);
});

test("withOrgContext rollback releases client even when callback throws", async () => {
    const before = dbApp.pg.idleCount;
    await assert.rejects(
        dbApp.withOrgContext(ORG_ACME, USER_ACME_ADMIN, async (client) => {
            await client.query("SELECT 1");
            throw new Error("phase5test-callback-throw");
        }),
        (err) => err.message === "phase5test-callback-throw",
    );
    // Connection count should not grow unbounded across retries —
    // release() must have been invoked in the catch path. Allow a small
    // delta because async event ordering may not have settled.
    const after = dbApp.pg.idleCount;
    assert.ok(
        after >= before,
        `expected client returned to pool, idleCount before=${before} after=${after}`,
    );
});

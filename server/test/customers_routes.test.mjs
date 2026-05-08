/* customers REST routes — Phase 2 Step 4.
 *
 * Covers the 6 endpoints end-to-end via Fastify inject + seeded Argon2id
 * passwords from server/seeds/0001_demo.sql:
 *   - admin@acme.test / acme-admin-1234
 *   - emp@acme.test   / acme-emp-1234
 *   - admin@beta.test / beta-admin-1234
 *
 * ~14 cases per Step 4 plan §9: happy paths, 4xx (validation), viewer
 * write block (with staleness-safe token issuance), multi-org RLS
 * isolation, Date → ISO auto-serialization.
 *
 * Cleanup (afterEach):
 *   - sessions wiped (so token rows don't accumulate)
 *   - INSERTed customer rows hard-deleted (test-only — repository never
 *     exposes hard delete)
 *   - soft-deleted seed rows restored (deleted_at = NULL)
 *   - role demotions reverted (membership role='employee')
 *
 * Run: cd server && npm test
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import authPlugin from "../src/plugins/auth.js";
import dbPlugin from "../src/plugins/db.js";
import authRoutes from "../src/routes/auth.js";
import customersRoutes from "../src/routes/customers.js";

// Seed fixtures
const ACME_ID = "11111111-1111-1111-1111-111111111111";
const BETA_ID = "22222222-2222-2222-2222-222222222222";
const ACME_EMP_MEMBERSHIP = "cccccccc-0002-0002-0002-cccccccccccc";

// Seed customer rows (deterministic IDs from seeds/0002_customers.sql)
const ACME_KIM_ID = "eeeeeeee-1111-0001-0001-eeeeeeeeeeee"; // 김민수 / Kloser Inc.
const BETA_JUNG_ID = "ffffffff-2222-0001-0001-ffffffffffff"; // 정승호 / Beta Soft

const ROUTETEST_NAME_PREFIX = "routetest-";

let app;

before(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    await app.register(dbPlugin);
    await app.register(authRoutes);
    await app.register(customersRoutes);
});

after(async () => {
    await app.close();
});

// Track row ids that individual tests soft-delete on a SEED row, so we
// can restore exactly those (and not blindly UPDATE every soft-deleted
// row in the org — that would resurrect rows the seed itself wanted
// gone, or rows mutated by an unrelated suite). Currently no tests
// soft-delete a seed row (DELETE tests target freshly inserted
// routetest- rows, which are then hard-deleted). The Set is here so
// future cases can opt in by pushing their id and we keep the cleanup
// surface tight.
const softDeletedSeedIdsByOrg = new Map([[ACME_ID, new Set()], [BETA_ID, new Set()]]);

afterEach(async () => {
    // Drop refresh sessions issued during the test.
    await app.pg.query("DELETE FROM sessions");

    // Hard-delete test-inserted rows + restore opted-in soft-deleted seed rows.
    for (const orgId of [ACME_ID, BETA_ID]) {
        await app.withOrgContext(orgId, async (client) => {
            await client.query(
                "DELETE FROM customers WHERE name LIKE $1",
                [`${ROUTETEST_NAME_PREFIX}%`],
            );
            const ids = softDeletedSeedIdsByOrg.get(orgId);
            if (ids && ids.size > 0) {
                await client.query(
                    "UPDATE customers SET deleted_at = NULL WHERE id = ANY($1::uuid[])",
                    [Array.from(ids)],
                );
                ids.clear();
            }
        });
    }

    // Restore membership role demotion (viewer test).
    await app.withOrgContext(ACME_ID, async (client) => {
        await client.query(
            "UPDATE memberships SET role='employee' WHERE id=$1",
            [ACME_EMP_MEMBERSHIP],
        );
    });
});

// ---------------------------------------------------------------------- //
// Helpers
// ---------------------------------------------------------------------- //

async function loginToken(email, password, orgId) {
    const r = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email, password, ...(orgId ? { orgId } : {}) },
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

const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

// ---------------------------------------------------------------------- //
// GET /customers — list
// ---------------------------------------------------------------------- //

test("GET /customers (acme admin) → 200, 12 items, all org=acme", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const r = await authedInject(token, { method: "GET", url: "/customers" });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.total, 12);
    assert.equal(body.items.length, 12);
    for (const c of body.items) {
        assert.equal(c.org_id, ACME_ID);
    }
});

test("GET /customers (beta admin) → 200, 12 items, name set disjoint from acme", async () => {
    const acmeToken = await loginToken("admin@acme.test", "acme-admin-1234");
    const betaToken = await loginToken("admin@beta.test", "beta-admin-1234");

    const acme = (await authedInject(acmeToken, { method: "GET", url: "/customers" })).json();
    const beta = (await authedInject(betaToken, { method: "GET", url: "/customers" })).json();

    assert.equal(beta.items.length, 12);
    const acmeNames = new Set(acme.items.map((c) => c.name));
    for (const c of beta.items) {
        assert.equal(c.org_id, BETA_ID);
        assert.ok(!acmeNames.has(c.name), `beta name ${c.name} leaked into acme set`);
    }
});

test("GET /customers?status=active → 200, every row status='active'", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const r = await authedInject(token, { method: "GET", url: "/customers?status=active" });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.items.length, 7); // Acme seed has 7 active rows
    for (const c of body.items) {
        assert.equal(c.status, "active");
    }
});

test("GET /customers with invalid status/plan/assignedUserId → 400 invalid_<field> + value", async () => {
    // Step 4 plan §2-7 / §6 contract: each of the three throwable fields
    // surfaces as InvalidListOptionError → 400 invalid_<field> with the
    // raw value preserved. q/sort/dir/limit/offset never throw (silent
    // fallback) and aren't covered here.
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const cases = [
        { qs: "status=bogus", field: "status", value: "bogus" },
        { qs: "plan=Trial", field: "plan", value: "Trial" },
        { qs: "assignedUserId=not-a-uuid", field: "assignedUserId", value: "not-a-uuid" },
    ];
    for (const c of cases) {
        const r = await authedInject(token, { method: "GET", url: `/customers?${c.qs}` });
        assert.equal(r.statusCode, 400, `case ${c.qs}: status ${r.statusCode}`);
        const body = r.json();
        assert.equal(body.error, `invalid_${c.field}`, `case ${c.qs}: error`);
        assert.equal(body.value, c.value, `case ${c.qs}: value`);
    }
});

test("GET /customers?limit=9999 → 200, items.length clamped to 12 (seed total)", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const r = await authedInject(token, { method: "GET", url: "/customers?limit=9999" });
    assert.equal(r.statusCode, 200);
    // limit clamped to 100 by service; org has 12 seeds, so result is 12.
    assert.equal(r.json().items.length, 12);
});

// ---------------------------------------------------------------------- //
// GET /customers/stats
// ---------------------------------------------------------------------- //

test("GET /customers/stats (acme admin) → { total:12, active:7, review:3, pending:2 }", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const r = await authedInject(token, { method: "GET", url: "/customers/stats" });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { total: 12, active: 7, review: 3, pending: 2 });
});

// ---------------------------------------------------------------------- //
// GET /customers/:id
// ---------------------------------------------------------------------- //

test("GET /customers/:id (acme admin, acme row) → 200 + ISO timestamp serialization", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const r = await authedInject(token, {
        method: "GET",
        url: `/customers/${ACME_KIM_ID}`,
    });
    assert.equal(r.statusCode, 200);
    const { customer } = r.json();
    assert.equal(customer.id, ACME_KIM_ID);
    assert.equal(customer.company, "Kloser Inc.");
    // Date → ISO 8601 string via fastify's default JSON serialization.
    assert.equal(typeof customer.created_at, "string");
    assert.match(customer.created_at, ISO_8601_RE);
    assert.equal(typeof customer.updated_at, "string");
    assert.match(customer.updated_at, ISO_8601_RE);
});

test("GET /customers/:id (acme admin, beta row) → 404 not_found (RLS isolation)", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const r = await authedInject(token, {
        method: "GET",
        url: `/customers/${BETA_JUNG_ID}`,
    });
    assert.equal(r.statusCode, 404);
    assert.equal(r.json().error, "not_found");
});

test("GET /customers/:id with non-UUID → 400 invalid_input", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const r = await authedInject(token, {
        method: "GET",
        url: "/customers/not-a-uuid",
    });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error, "invalid_input");
});

// ---------------------------------------------------------------------- //
// POST /customers
// ---------------------------------------------------------------------- //

test("POST /customers (acme admin) → 201, new row visible in list (count=13)", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const r = await authedInject(token, {
        method: "POST",
        url: "/customers",
        headers: { "content-type": "application/json" },
        payload: {
            name: `${ROUTETEST_NAME_PREFIX}post-happy`,
            company: "RouteTest Co.",
            email: "rt@example.test",
            status: "pending",
        },
    });
    assert.equal(r.statusCode, 201);
    const { customer } = r.json();
    assert.equal(customer.org_id, ACME_ID);
    assert.equal(customer.name, `${ROUTETEST_NAME_PREFIX}post-happy`);
    assert.equal(customer.status, "pending");

    // Round-trip: list count goes from 12 → 13.
    const list = await authedInject(token, { method: "GET", url: "/customers" });
    assert.equal(list.json().total, 13);
});

test("POST /customers with empty body → 400 invalid_input (name required)", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const r = await authedInject(token, {
        method: "POST",
        url: "/customers",
        headers: { "content-type": "application/json" },
        payload: {},
    });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error, "invalid_input");
});

// ---------------------------------------------------------------------- //
// PATCH /customers/:id
// ---------------------------------------------------------------------- //

test("PATCH /customers/:id (acme admin) → 200, name updated", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const created = await authedInject(token, {
        method: "POST",
        url: "/customers",
        headers: { "content-type": "application/json" },
        payload: { name: `${ROUTETEST_NAME_PREFIX}patch-target` },
    });
    assert.equal(created.statusCode, 201);
    const id = created.json().customer.id;

    const r = await authedInject(token, {
        method: "PATCH",
        url: `/customers/${id}`,
        headers: { "content-type": "application/json" },
        payload: { name: `${ROUTETEST_NAME_PREFIX}patch-renamed` },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().customer.name, `${ROUTETEST_NAME_PREFIX}patch-renamed`);
});

test("PATCH /customers/:id (non-existent UUID) → 404 not_found", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    // Valid UUID format but no row.
    const ghost = "00000000-0000-0000-0000-000000000000";
    const r = await authedInject(token, {
        method: "PATCH",
        url: `/customers/${ghost}`,
        headers: { "content-type": "application/json" },
        payload: { name: "ghost" },
    });
    assert.equal(r.statusCode, 404);
    assert.equal(r.json().error, "not_found");
});

test("PATCH /customers/:id with empty body {} → 400 invalid_input (refine: at least one field)", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const r = await authedInject(token, {
        method: "PATCH",
        url: `/customers/${ACME_KIM_ID}`,
        headers: { "content-type": "application/json" },
        payload: {},
    });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error, "invalid_input");
});

// ---------------------------------------------------------------------- //
// DELETE /customers/:id
// ---------------------------------------------------------------------- //

test("DELETE /customers/:id (acme admin) → 204, list count returns to 12", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const created = await authedInject(token, {
        method: "POST",
        url: "/customers",
        headers: { "content-type": "application/json" },
        payload: { name: `${ROUTETEST_NAME_PREFIX}delete-target` },
    });
    assert.equal(created.statusCode, 201);
    const id = created.json().customer.id;

    // Sanity: list shows 13 before delete.
    const before = await authedInject(token, { method: "GET", url: "/customers" });
    assert.equal(before.json().total, 13);

    const r = await authedInject(token, { method: "DELETE", url: `/customers/${id}` });
    assert.equal(r.statusCode, 204);
    assert.equal(r.body, "");

    // Soft-deleted row hidden from list.
    const after = await authedInject(token, { method: "GET", url: "/customers" });
    assert.equal(after.json().total, 12);
});

// ---------------------------------------------------------------------- //
// viewer write block (token staleness-safe procedure — Step 4 plan §11)
// ---------------------------------------------------------------------- //

test("POST /customers with viewer JWT → 403 forbidden (DB demote → fresh login)", async () => {
    // Step 4 plan §11 viewer: requireRole reads request.user.role from
    // the JWT. We must demote the membership BEFORE issuing the token,
    // otherwise the test reuses an employee token and POST returns 201.
    await app.withOrgContext(ACME_ID, async (client) => {
        await client.query(
            "UPDATE memberships SET role='viewer' WHERE id=$1",
            [ACME_EMP_MEMBERSHIP],
        );
    });

    // Fresh login picks up the new role from the DB → token has role='viewer'.
    const viewerToken = await loginToken("emp@acme.test", "acme-emp-1234");

    const r = await authedInject(viewerToken, {
        method: "POST",
        url: "/customers",
        headers: { "content-type": "application/json" },
        payload: { name: `${ROUTETEST_NAME_PREFIX}viewer-attempt` },
    });
    assert.equal(r.statusCode, 403);
    assert.equal(r.json().error, "forbidden");

    // afterEach restores role='employee' on ACME_EMP_MEMBERSHIP.
});

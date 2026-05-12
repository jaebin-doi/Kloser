/* Phase 4 Step 3 — calls REST routes.
 *
 * Plan: docs/plan/phase-4/PHASE_4_STEP_3_ROUTES.md §7.2.
 *
 * Covers the 11 endpoints (calls + transcripts + action-items) end-to-end
 * via Fastify inject + seeded Argon2id passwords from 0001_demo.sql:
 *   admin@acme.test / acme-admin-1234   (admin role)
 *   emp@acme.test   / acme-emp-1234     (employee role)
 *   admin@beta.test / beta-admin-1234   (Beta admin)
 *
 * Test-data hygiene:
 *   - every route mutation tagged with TITLE_PREFIX so afterEach can
 *     hard-delete its rows (calls cascade to transcripts +
 *     call_action_items).
 *   - membership role demotions, user email_verified_at flips, and
 *     customer last_contacted_at edits are reverted in afterEach.
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import authPlugin from "../src/plugins/auth.js";
import dbPlugin from "../src/plugins/db.js";
import authRoutes from "../src/routes/auth.js";
import callsRoutes from "../src/routes/calls.js";

const ACME_ID                = "11111111-1111-1111-1111-111111111111";
const BETA_ID                = "22222222-2222-2222-2222-222222222222";
const ACME_ADMIN_USER_ID     = "aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa";
const ACME_EMP_USER_ID       = "aaaaaaaa-0002-0002-0002-aaaaaaaaaaaa";
const ACME_EMP_MEMBERSHIP    = "cccccccc-0002-0002-0002-cccccccccccc";
const ACME_ADMIN_MEMBERSHIP  = "cccccccc-0001-0001-0001-cccccccccccc";
const BETA_ADMIN_USER_ID     = "bbbbbbbb-0001-0001-0001-bbbbbbbbbbbb";
const ACME_KIM_ID            = "eeeeeeee-1111-0001-0001-eeeeeeeeeeee";
const BETA_JUNG_ID           = "ffffffff-2222-0001-0001-ffffffffffff";

const TITLE_PREFIX = "p4routetest-";

let app;

before(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    await app.register(dbPlugin);
    await app.register(authRoutes);
    await app.register(callsRoutes);
});

after(async () => {
    await app.close();
});

afterEach(async () => {
    // sessions accumulate from each loginToken; clean every cycle.
    await app.pg.query("DELETE FROM sessions");

    // calls created by this suite cascade to transcripts/action items.
    for (const orgId of [ACME_ID, BETA_ID]) {
        await app.withOrgContext(orgId, async (client) => {
            await client.query(
                `DELETE FROM calls WHERE title LIKE $1`,
                [`${TITLE_PREFIX}%`],
            );
        });
    }

    // role demotion + verify-flip restorations.
    await app.withOrgContext(ACME_ID, async (client) => {
        await client.query(
            `UPDATE memberships SET role = 'employee' WHERE id = $1`,
            [ACME_EMP_MEMBERSHIP],
        );
        await client.query(
            `UPDATE memberships SET role = 'admin' WHERE id = $1`,
            [ACME_ADMIN_MEMBERSHIP],
        );
    });

    // Re-verify any seed user we toggled.
    await app.pg.query(
        `UPDATE users SET email_verified_at = now()
          WHERE id = ANY($1::uuid[]) AND email_verified_at IS NULL`,
        [[ACME_ADMIN_USER_ID, ACME_EMP_USER_ID, BETA_ADMIN_USER_ID]],
    );
});

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

async function createAcmeCall(token, overrides = {}) {
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

async function readCustomerLastContact(orgId, customerId) {
    return app.withOrgContext(orgId, async (client) => {
        const r = await client.query(
            `SELECT last_contacted_at FROM customers WHERE id = $1`,
            [customerId],
        );
        return r.rows[0]?.last_contacted_at ?? null;
    });
}

async function setCustomerLastContact(orgId, customerId, value) {
    await app.withOrgContext(orgId, async (client) => {
        await client.query(
            `UPDATE customers SET last_contacted_at = $1 WHERE id = $2`,
            [value, customerId],
        );
    });
}

// ----------------------------------------------------------------- //
// 1. GET /calls — Acme/Beta isolation
// ----------------------------------------------------------------- //

test("GET /calls returns Acme-only rows for an Acme admin", async () => {
    const acmeToken = await loginToken("admin@acme.test", "acme-admin-1234");
    const betaToken = await loginToken("admin@beta.test", "beta-admin-1234");

    const seeded = await createAcmeCall(acmeToken, {
        title: `${TITLE_PREFIX}acme-list`,
    });

    const acmeList = await authedInject(acmeToken, {
        method: "GET",
        url: "/calls",
    });
    assert.equal(acmeList.statusCode, 200);
    const acmeBody = acmeList.json();
    assert.ok(acmeBody.items.some((c) => c.id === seeded.id));
    for (const c of acmeBody.items) assert.equal(c.org_id, ACME_ID);

    const betaList = await authedInject(betaToken, {
        method: "GET",
        url: "/calls",
    });
    assert.equal(betaList.statusCode, 200);
    const betaBody = betaList.json();
    assert.equal(
        betaBody.items.find((c) => c.id === seeded.id),
        undefined,
        "Beta admin should not see the Acme call",
    );
});

// ----------------------------------------------------------------- //
// 2. POST /calls valid → 201
// ----------------------------------------------------------------- //

test("POST /calls (admin) → 201 with org_id and default status", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const r = await authedInject(token, {
        method: "POST",
        url: "/calls",
        headers: { "content-type": "application/json" },
        payload: {
            direction: "outbound",
            customer_id: ACME_KIM_ID,
            title: `${TITLE_PREFIX}post-happy`,
        },
    });
    assert.equal(r.statusCode, 201);
    const { call } = r.json();
    assert.equal(call.org_id, ACME_ID);
    assert.equal(call.customer_id, ACME_KIM_ID);
    assert.equal(call.direction, "outbound");
    assert.equal(call.status, "in_progress");
});

test("POST /calls rejects non-start status at the route boundary", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const r = await authedInject(token, {
        method: "POST",
        url: "/calls",
        headers: { "content-type": "application/json" },
        payload: {
            direction: "inbound",
            status: "ended",
            title: `${TITLE_PREFIX}invalid-create-status`,
        },
    });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error, "invalid_input");
});

// ----------------------------------------------------------------- //
// 3. POST /calls invalid customer_id → 400 invalid_reference (composite FK)
// ----------------------------------------------------------------- //

test("POST /calls with a Beta customer_id → 400 invalid_reference", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const r = await authedInject(token, {
        method: "POST",
        url: "/calls",
        headers: { "content-type": "application/json" },
        payload: {
            direction: "inbound",
            customer_id: BETA_JUNG_ID,
            title: `${TITLE_PREFIX}xorg-customer`,
        },
    });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error, "invalid_reference");
});

// ----------------------------------------------------------------- //
// 4. POST /calls viewer → 403
// ----------------------------------------------------------------- //

test("POST /calls as a viewer → 403 forbidden", async () => {
    // Demote the seed employee membership to viewer before login so the
    // freshly-issued token carries role='viewer'.
    await app.withOrgContext(ACME_ID, async (client) => {
        await client.query(
            `UPDATE memberships SET role = 'viewer' WHERE id = $1`,
            [ACME_EMP_MEMBERSHIP],
        );
    });

    const token = await loginToken("emp@acme.test", "acme-emp-1234");
    const r = await authedInject(token, {
        method: "POST",
        url: "/calls",
        headers: { "content-type": "application/json" },
        payload: {
            direction: "inbound",
            title: `${TITLE_PREFIX}viewer-blocked`,
        },
    });
    assert.equal(r.statusCode, 403);
    assert.equal(r.json().error, "forbidden");
});

// ----------------------------------------------------------------- //
// 5. POST /calls as unverified user → 403 email_not_verified
// ----------------------------------------------------------------- //

test("POST /calls as unverified user → 403 email_not_verified", async () => {
    // Toggle the seed admin to unverified, then log in (login does NOT
    // require email verification — that's enforced at mutation time).
    await app.pg.query(
        `UPDATE users SET email_verified_at = NULL WHERE id = $1`,
        [ACME_ADMIN_USER_ID],
    );
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const r = await authedInject(token, {
        method: "POST",
        url: "/calls",
        headers: { "content-type": "application/json" },
        payload: {
            direction: "inbound",
            title: `${TITLE_PREFIX}unverified-blocked`,
        },
    });
    assert.equal(r.statusCode, 403);
    const body = r.json();
    assert.equal(body.code, "email_not_verified");
});

// ----------------------------------------------------------------- //
// 6. GET /calls/:id cross-org → 404
// ----------------------------------------------------------------- //

test("GET /calls/:id cross-org → 404 not_found", async () => {
    const acmeToken = await loginToken("admin@acme.test", "acme-admin-1234");
    const betaToken = await loginToken("admin@beta.test", "beta-admin-1234");
    const acmeCall = await createAcmeCall(acmeToken, {
        title: `${TITLE_PREFIX}xorg-get`,
    });
    const r = await authedInject(betaToken, {
        method: "GET",
        url: `/calls/${acmeCall.id}`,
    });
    assert.equal(r.statusCode, 404);
    assert.equal(r.json().error, "not_found");
});

// ----------------------------------------------------------------- //
// 7. POST /calls/:id/notes (admin) → 200
// ----------------------------------------------------------------- //

test("POST /calls/:id/notes (admin) → 200 with patched notes", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const call = await createAcmeCall(token, { title: `${TITLE_PREFIX}notes-admin` });
    const r = await authedInject(token, {
        method: "POST",
        url: `/calls/${call.id}/notes`,
        headers: { "content-type": "application/json" },
        payload: { notes: "follow-up scheduled" },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().call.notes, "follow-up scheduled");
});

// ----------------------------------------------------------------- //
// 8. POST /calls/:id/notes employee own-call → 200
// ----------------------------------------------------------------- //

test("POST /calls/:id/notes employee on own call → 200", async () => {
    const empToken = await loginToken("emp@acme.test", "acme-emp-1234");
    const call = await createAcmeCall(empToken, {
        title: `${TITLE_PREFIX}emp-own`,
    });
    // POST /calls forced agent_user_id = self for employees, so this is
    // already an own-call.
    const r = await authedInject(empToken, {
        method: "POST",
        url: `/calls/${call.id}/notes`,
        headers: { "content-type": "application/json" },
        payload: { notes: "mine" },
    });
    assert.equal(r.statusCode, 200);
});

// ----------------------------------------------------------------- //
// 9. POST /calls/:id/notes employee on another agent's call → 403
// ----------------------------------------------------------------- //

test("POST /calls/:id/notes employee on someone else's call → 403", async () => {
    const adminToken = await loginToken("admin@acme.test", "acme-admin-1234");
    const empToken   = await loginToken("emp@acme.test", "acme-emp-1234");

    // Admin creates a call assigned to themself.
    const call = await createAcmeCall(adminToken, {
        title: `${TITLE_PREFIX}admin-call-emp-blocked`,
        agent_user_id: ACME_ADMIN_USER_ID,
    });
    const r = await authedInject(empToken, {
        method: "POST",
        url: `/calls/${call.id}/notes`,
        headers: { "content-type": "application/json" },
        payload: { notes: "should not stick" },
    });
    assert.equal(r.statusCode, 403);
    assert.equal(r.json().error, "forbidden");
});

// ----------------------------------------------------------------- //
// 10. POST /calls/:id/end → 200 + customers.last_contacted_at advances
// ----------------------------------------------------------------- //

test("POST /calls/:id/end → 200 + customers.last_contacted_at advances", async () => {
    const adminToken = await loginToken("admin@acme.test", "acme-admin-1234");

    const originalContact = await readCustomerLastContact(
        ACME_ID,
        ACME_KIM_ID,
    );
    try {
        await setCustomerLastContact(
            ACME_ID,
            ACME_KIM_ID,
            new Date("2020-01-01T00:00:00Z"),
        );

        const call = await createAcmeCall(adminToken, {
            title: `${TITLE_PREFIX}end-happy`,
            customer_id: ACME_KIM_ID,
        });
        const endedAt = new Date().toISOString();
        const r = await authedInject(adminToken, {
            method: "POST",
            url: `/calls/${call.id}/end`,
            headers: { "content-type": "application/json" },
            payload: { ended_at: endedAt },
        });
        assert.equal(r.statusCode, 200);
        assert.equal(r.json().call.status, "ended");

        const after = await readCustomerLastContact(ACME_ID, ACME_KIM_ID);
        assert.ok(after instanceof Date);
        assert.equal(after.getTime(), new Date(endedAt).getTime());
    } finally {
        await setCustomerLastContact(ACME_ID, ACME_KIM_ID, originalContact);
    }
});

// ----------------------------------------------------------------- //
// 11. POST /calls/:id/end cross-org → 404
// ----------------------------------------------------------------- //

test("POST /calls/:id/end cross-org → 404", async () => {
    const acmeToken = await loginToken("admin@acme.test", "acme-admin-1234");
    const betaToken = await loginToken("admin@beta.test", "beta-admin-1234");
    const acmeCall = await createAcmeCall(acmeToken, {
        title: `${TITLE_PREFIX}xorg-end`,
    });
    const r = await authedInject(betaToken, {
        method: "POST",
        url: `/calls/${acmeCall.id}/end`,
        headers: { "content-type": "application/json" },
        payload: {},
    });
    assert.equal(r.statusCode, 404);
});

// ----------------------------------------------------------------- //
// 12. POST /calls/:id/transcript → 201 + GET ordered
// ----------------------------------------------------------------- //

test("POST + GET /calls/:id/transcript → serial seqs, ordered list", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const call = await createAcmeCall(token, { title: `${TITLE_PREFIX}transcript` });

    const a = await authedInject(token, {
        method: "POST",
        url: `/calls/${call.id}/transcript`,
        headers: { "content-type": "application/json" },
        payload: { speaker: "agent", text: "hello", confidence: 0.875 },
    });
    assert.equal(a.statusCode, 201);
    assert.equal(a.json().transcript.seq, 0);
    assert.equal(typeof a.json().transcript.confidence, "number");
    assert.equal(a.json().transcript.confidence, 0.875);

    const b = await authedInject(token, {
        method: "POST",
        url: `/calls/${call.id}/transcript`,
        headers: { "content-type": "application/json" },
        payload: { speaker: "customer", text: "world" },
    });
    assert.equal(b.statusCode, 201);
    assert.equal(b.json().transcript.seq, 1);

    const list = await authedInject(token, {
        method: "GET",
        url: `/calls/${call.id}/transcript`,
    });
    assert.equal(list.statusCode, 200);
    const items = list.json().items;
    assert.equal(items.length, 2);
    assert.equal(items[0].seq, 0);
    assert.equal(typeof items[0].confidence, "number");
    assert.equal(items[0].confidence, 0.875);
    assert.equal(items[1].seq, 1);
});

// ----------------------------------------------------------------- //
// 13. POST /calls/:id/action-items → 201
// ----------------------------------------------------------------- //

test("POST /calls/:id/action-items → 201, status=open, completed_at=null", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const call = await createAcmeCall(token, { title: `${TITLE_PREFIX}ai-create` });
    const r = await authedInject(token, {
        method: "POST",
        url: `/calls/${call.id}/action-items`,
        headers: { "content-type": "application/json" },
        payload: {
            title: "follow-up demo",
            due_date: "2026-06-01",
            assignee_user_id: ACME_EMP_USER_ID,
        },
    });
    assert.equal(r.statusCode, 201);
    const item = r.json().action_item;
    assert.equal(item.status, "open");
    assert.equal(item.completed_at, null);
    assert.equal(item.assignee_user_id, ACME_EMP_USER_ID);
});

// ----------------------------------------------------------------- //
// 14. POST /call-action-items/:id/status done/open flow
// ----------------------------------------------------------------- //

test("POST /call-action-items/:id/status: done → completed_at not null, then open → null", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const call = await createAcmeCall(token, { title: `${TITLE_PREFIX}ai-status-flow` });
    const created = await authedInject(token, {
        method: "POST",
        url: `/calls/${call.id}/action-items`,
        headers: { "content-type": "application/json" },
        payload: { title: "status-flow" },
    });
    const itemId = created.json().action_item.id;

    const done = await authedInject(token, {
        method: "POST",
        url: `/call-action-items/${itemId}/status`,
        headers: { "content-type": "application/json" },
        payload: { status: "done" },
    });
    assert.equal(done.statusCode, 200);
    assert.equal(done.json().action_item.status, "done");
    assert.notEqual(done.json().action_item.completed_at, null);

    const reopened = await authedInject(token, {
        method: "POST",
        url: `/call-action-items/${itemId}/status`,
        headers: { "content-type": "application/json" },
        payload: { status: "open" },
    });
    assert.equal(reopened.statusCode, 200);
    assert.equal(reopened.json().action_item.status, "open");
    assert.equal(reopened.json().action_item.completed_at, null);
});

// ----------------------------------------------------------------- //
// 15. POST /call-action-items/:id/assignee with cross-org user → 400 invalid_reference
// ----------------------------------------------------------------- //

test("POST /call-action-items/:id/assignee cross-org assignee → 400 invalid_reference", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const call = await createAcmeCall(token, { title: `${TITLE_PREFIX}ai-assignee-xorg` });
    const created = await authedInject(token, {
        method: "POST",
        url: `/calls/${call.id}/action-items`,
        headers: { "content-type": "application/json" },
        payload: { title: "assignee-cross-org" },
    });
    const itemId = created.json().action_item.id;

    const r = await authedInject(token, {
        method: "POST",
        url: `/call-action-items/${itemId}/assignee`,
        headers: { "content-type": "application/json" },
        payload: { assignee_user_id: BETA_ADMIN_USER_ID },
    });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error, "invalid_reference");
});

// ----------------------------------------------------------------- //
// 16. Stale role: admin → demoted to employee → mutation 401 stale_role
// ----------------------------------------------------------------- //

test("mutation with stale_role token → 401 stale_role", async () => {
    const adminToken = await loginToken("admin@acme.test", "acme-admin-1234");
    // Pre-create one valid call so the route path reaches requireFreshRole
    // (it runs after requireRole but before the handler; we just need
    // the URL to be reachable).
    const call = await createAcmeCall(adminToken, {
        title: `${TITLE_PREFIX}stale-role-target`,
    });

    // Demote the admin's membership to employee, keeping their token's
    // role='admin' frozen in the JWT.
    await app.withOrgContext(ACME_ID, async (client) => {
        await client.query(
            `UPDATE memberships SET role = 'employee' WHERE id = $1`,
            [ACME_ADMIN_MEMBERSHIP],
        );
    });

    const r = await authedInject(adminToken, {
        method: "POST",
        url: `/calls/${call.id}/notes`,
        headers: { "content-type": "application/json" },
        payload: { notes: "stale" },
    });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().code, "stale_role");
});

// ----------------------------------------------------------------- //
// 17. POST /calls/:id/transcript missing auth → 401
// ----------------------------------------------------------------- //

test("POST /calls/:id/transcript without bearer → 401", async () => {
    // Bypass loginToken so we hit the auth gate.
    const r = await app.inject({
        method: "POST",
        url: `/calls/${ACME_KIM_ID}/transcript`,
        headers: { "content-type": "application/json" },
        payload: { speaker: "agent", text: "no auth" },
    });
    assert.equal(r.statusCode, 401);
});

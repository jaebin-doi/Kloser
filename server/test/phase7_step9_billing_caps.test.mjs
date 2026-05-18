/* Phase 7 Step 9 — service-layer plan-cap enforcement tests.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_9_PLAN.md §3.2, §5.3.
 *
 * Scope: assertPlanAllows / assertPlanAllowsAbsolute fired from inside
 * the real mutation services (createCustomer, createKnowledgeBase,
 * replaceKnowledgeChunks, createCall, invitations.createInvitation).
 * The seat-cap path that the WebSocket start_call shares with the REST
 * createCall is exercised through `callsService.createCall` directly
 * because it sits behind the same service function — Step 9 plan §5.3.
 *
 * Each case temporarily forces an org plan, manufactures the at-cap
 * state, and asserts:
 *   - PlanLimitExceededError is thrown with the right limitKey + counts
 *   - the underlying mutation is NOT persisted (count unchanged)
 *
 * The Beta org is preferred for cap-tight scenarios because its
 * starter-plan caps are low. Tests that need a different plan flip
 * `organizations.plan` for the duration of the case and restore it.
 *
 * Run: cd server && npm test
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import dbPlugin from "../src/plugins/db.js";
import {
    assertPlanAllows,
    assertPlanAllowsAbsolute,
    BILLING_PLAN_LIMITS,
    PlanLimitExceededError,
} from "../src/services/billing.ts";
import * as customersService from "../src/services/customers.ts";
import * as callsService from "../src/services/calls.ts";
import * as knowledgeService from "../src/services/knowledge.ts";
import { createInvitation } from "../src/services/invitations.ts";

const ORG_ACME = "11111111-1111-1111-1111-111111111111";
const ORG_BETA = "22222222-2222-2222-2222-222222222222";
const USER_ACME_ADMIN = "aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa";
const USER_BETA_ADMIN = "bbbbbbbb-0001-0001-0001-bbbbbbbbbbbb";

const TEST_PREFIX = "phase7_step9_caps-";

let app;
const createdCustomerIds = new Set();
const createdKbIds = new Set();
const createdCallIds = new Set();
const createdInviteIds = new Set();

before(async () => {
    app = Fastify({ logger: false });
    await app.register(dbPlugin);
});

after(async () => {
    // Restore plan defaults (seed snapshot).
    await app.pg.query(
        `UPDATE organizations SET plan = CASE id
            WHEN $1 THEN 'pro'
            WHEN $2 THEN 'starter' END
          WHERE id IN ($1, $2)`,
        [ORG_ACME, ORG_BETA],
    );
    await app.close();
});

afterEach(async () => {
    for (const orgId of [ORG_ACME, ORG_BETA]) {
        await app.withOrgContext(orgId, async (client) => {
            if (createdCallIds.size) {
                await client.query(
                    `DELETE FROM calls WHERE id = ANY($1::uuid[])`,
                    [Array.from(createdCallIds)],
                );
            }
            if (createdCustomerIds.size) {
                await client.query(
                    `DELETE FROM customers WHERE id = ANY($1::uuid[])`,
                    [Array.from(createdCustomerIds)],
                );
            }
            if (createdKbIds.size) {
                await client.query(
                    `DELETE FROM knowledge_chunks WHERE knowledge_base_id = ANY($1::uuid[])`,
                    [Array.from(createdKbIds)],
                );
                await client.query(
                    `DELETE FROM knowledge_bases WHERE id = ANY($1::uuid[])`,
                    [Array.from(createdKbIds)],
                );
            }
            if (createdInviteIds.size) {
                await client.query(
                    `DELETE FROM auth_tokens WHERE invitation_id = ANY($1::uuid[])`,
                    [Array.from(createdInviteIds)],
                );
                await client.query(
                    `DELETE FROM invitations WHERE id = ANY($1::uuid[])`,
                    [Array.from(createdInviteIds)],
                );
            }
        });
    }
    createdCallIds.clear();
    createdCustomerIds.clear();
    createdKbIds.clear();
    createdInviteIds.clear();
});

async function setPlan(orgId, plan) {
    await app.pg.query(
        `UPDATE organizations SET plan = $1 WHERE id = $2`,
        [plan, orgId],
    );
}

async function withTx(orgId, fn) {
    return app.withOrgContext(orgId, fn);
}

async function countCustomers(orgId) {
    return withTx(orgId, async (c) => {
        const r = await c.query(
            `SELECT count(*)::int AS n FROM customers WHERE deleted_at IS NULL`,
        );
        return r.rows[0].n;
    });
}

async function countCallsThisMonth(orgId) {
    return withTx(orgId, async (c) => {
        const r = await c.query(
            `SELECT count(*)::int AS n FROM calls
              WHERE deleted_at IS NULL
                AND started_at >= date_trunc('month', now() AT TIME ZONE 'UTC')
                AND started_at <  date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month'`,
        );
        return r.rows[0].n;
    });
}

async function countKbs(orgId) {
    return withTx(orgId, async (c) => {
        const r = await c.query(
            `SELECT count(*)::int AS n FROM knowledge_bases WHERE deleted_at IS NULL`,
        );
        return r.rows[0].n;
    });
}

async function countInvites(orgId) {
    return withTx(orgId, async (c) => {
        const r = await c.query(
            `SELECT count(*)::int AS n FROM invitations
              WHERE accepted_at IS NULL AND canceled_at IS NULL`,
        );
        return r.rows[0].n;
    });
}

async function insertCustomer(orgId, name) {
    const id = randomUUID();
    createdCustomerIds.add(id);
    await withTx(orgId, async (client) => {
        await client.query(
            `INSERT INTO customers (id, org_id, name, status)
             VALUES ($1, current_app_org_id(), $2, 'active')`,
            [id, name],
        );
    });
    return id;
}

async function insertCallInMonth(orgId) {
    const id = randomUUID();
    createdCallIds.add(id);
    await withTx(orgId, async (client) => {
        await client.query(
            `INSERT INTO calls
                (id, org_id, agent_user_id, direction, status, started_at, title)
             VALUES ($1, current_app_org_id(), $2, 'inbound', 'in_progress', now(), $3)`,
            [id, USER_BETA_ADMIN, `${TEST_PREFIX}call`],
        );
    });
    return id;
}

async function insertKb(orgId) {
    const id = randomUUID();
    createdKbIds.add(id);
    await withTx(orgId, async (client) => {
        await client.query(
            `INSERT INTO knowledge_bases (id, org_id, title, source_type)
             VALUES ($1, current_app_org_id(), $2, 'manual')`,
            [id, `${TEST_PREFIX}kb-${id.slice(0, 8)}`],
        );
    });
    return id;
}

// =============================================================== //
// 1. BILLING_PLAN_LIMITS — sanity check on the source-of-truth map
// =============================================================== //

test("1. BILLING_PLAN_LIMITS shape (starter/pro/enterprise)", () => {
    assert.equal(BILLING_PLAN_LIMITS.starter.seats, 2);
    assert.equal(BILLING_PLAN_LIMITS.starter.customers, 100);
    assert.equal(BILLING_PLAN_LIMITS.starter.knowledge_bases, 3);
    assert.equal(BILLING_PLAN_LIMITS.starter.knowledge_chunks, 500);
    assert.equal(BILLING_PLAN_LIMITS.starter.monthly_calls, 100);
    assert.equal(BILLING_PLAN_LIMITS.starter.monthly_llm_cost_usd_micros, 5_000_000);
    assert.equal(BILLING_PLAN_LIMITS.pro.seats, 10);
    assert.equal(BILLING_PLAN_LIMITS.enterprise.seats, null);
    assert.equal(BILLING_PLAN_LIMITS.enterprise.customers, null);
});

// =============================================================== //
// 2. enterprise plan → unlimited (no throw)
// =============================================================== //

test("2. enterprise plan never throws PlanLimitExceededError", async () => {
    await setPlan(ORG_ACME, "enterprise");
    try {
        await withTx(ORG_ACME, async (client) => {
            // Pass a large increment; with enterprise null caps the helper
            // returns without counting.
            await assertPlanAllows(client, {
                limitKey: "customers",
                increment: 999_999,
            });
        });
    } finally {
        await setPlan(ORG_ACME, "pro");
    }
});

// =============================================================== //
// 3. customers cap — starter (cap 100) rejects 101st create
// =============================================================== //

test("3. customers cap blocks the 101st starter customer", async () => {
    await setPlan(ORG_BETA, "starter");
    const initialBeta = await countCustomers(ORG_BETA);
    // Manufacture rows so the count equals the cap. To stay reasonable
    // we pull just enough to reach the cap from whatever baseline Beta
    // had (seed contains a small fixture set).
    const needed = 100 - initialBeta;
    for (let i = 0; i < needed; i++) {
        await insertCustomer(ORG_BETA, `${TEST_PREFIX}fill-${i}`);
    }
    assert.equal(await countCustomers(ORG_BETA), 100);

    await assert.rejects(
        () =>
            customersService.createCustomer(app, ORG_BETA, USER_BETA_ADMIN, {
                name: `${TEST_PREFIX}overflow`,
            }),
        (err) =>
            err instanceof PlanLimitExceededError &&
            err.limitKey === "customers" &&
            err.plan === "starter" &&
            err.current === 100 &&
            err.limit === 100 &&
            err.attempted === 101,
    );
    // The rejected create must not have left a row.
    assert.equal(await countCustomers(ORG_BETA), 100);
});

// =============================================================== //
// 4. customers cap — pro (1000) allows headroom; below-cap doesn't throw
// =============================================================== //

test("4. customers cap allows creates under cap on pro plan", async () => {
    await setPlan(ORG_ACME, "pro");
    const before = await countCustomers(ORG_ACME);
    assert.ok(before < BILLING_PLAN_LIMITS.pro.customers, "pre-test invariant");

    const created = await customersService.createCustomer(
        app,
        ORG_ACME,
        USER_ACME_ADMIN,
        { name: `${TEST_PREFIX}fits` },
    );
    createdCustomerIds.add(created.id);
    assert.equal(await countCustomers(ORG_ACME), before + 1);
});

// =============================================================== //
// 5. monthly_calls cap — starter (100) blocks the 101st REST/WS call
// =============================================================== //

test("5. monthly_calls cap blocks the 101st starter call", async () => {
    await setPlan(ORG_BETA, "starter");
    const initial = await countCallsThisMonth(ORG_BETA);
    const needed = 100 - initial;
    for (let i = 0; i < needed; i++) {
        await insertCallInMonth(ORG_BETA);
    }
    assert.equal(await countCallsThisMonth(ORG_BETA), 100);

    await assert.rejects(
        () =>
            callsService.createCall(app, ORG_BETA, USER_BETA_ADMIN, {
                direction: "inbound",
            }),
        (err) =>
            err instanceof PlanLimitExceededError &&
            err.limitKey === "monthly_calls" &&
            err.plan === "starter" &&
            err.limit === 100 &&
            err.attempted === 101,
    );
    assert.equal(await countCallsThisMonth(ORG_BETA), 100);
});

// =============================================================== //
// 6. knowledge_bases cap — starter (3) blocks the 4th
// =============================================================== //

test("6. knowledge_bases cap blocks the 4th starter KB", async () => {
    await setPlan(ORG_BETA, "starter");
    const initial = await countKbs(ORG_BETA);
    const needed = Math.max(0, 3 - initial);
    for (let i = 0; i < needed; i++) {
        await insertKb(ORG_BETA);
    }
    const reached = await countKbs(ORG_BETA);
    assert.ok(reached >= 3, "should be at or above starter KB cap");

    await assert.rejects(
        () =>
            knowledgeService.createKnowledgeBase(
                app,
                ORG_BETA,
                USER_BETA_ADMIN,
                {
                    title: `${TEST_PREFIX}overflow-kb`,
                    source_type: "manual",
                    created_by_user_id: USER_BETA_ADMIN,
                },
            ),
        (err) =>
            err instanceof PlanLimitExceededError &&
            err.limitKey === "knowledge_bases" &&
            err.plan === "starter",
    );
});

// =============================================================== //
// 7. assertPlanAllowsAbsolute — chunk-replace blocks over-cap target
// =============================================================== //

test("7. assertPlanAllowsAbsolute rejects target > limit (knowledge_chunks)", async () => {
    await setPlan(ORG_BETA, "starter");
    const limit = BILLING_PLAN_LIMITS.starter.knowledge_chunks; // 500
    await assert.rejects(
        () =>
            withTx(ORG_BETA, (client) =>
                assertPlanAllowsAbsolute(client, {
                    limitKey: "knowledge_chunks",
                    targetTotal: limit + 1,
                }),
            ),
        (err) =>
            err instanceof PlanLimitExceededError &&
            err.limitKey === "knowledge_chunks" &&
            err.plan === "starter" &&
            err.limit === limit &&
            err.attempted === limit + 1,
    );

    // target == limit is allowed (boundary).
    await withTx(ORG_BETA, (client) =>
        assertPlanAllowsAbsolute(client, {
            limitKey: "knowledge_chunks",
            targetTotal: limit,
        }),
    );
});

// =============================================================== //
// 8. monthly_llm_cost_usd_micros — soft cap never throws
// =============================================================== //

test("8. assertPlanAllows on monthly_llm_cost (soft) never throws", async () => {
    await setPlan(ORG_BETA, "starter");
    // Even though we pass a giant increment, soft enforcement makes the
    // helper return early.
    await withTx(ORG_BETA, (client) =>
        assertPlanAllows(client, {
            limitKey: "monthly_llm_cost_usd_micros",
            increment: 999_999_999,
        }),
    );
});

// =============================================================== //
// 9. seats cap — invitations.createInvitation rejects over-cap
// =============================================================== //

test("9. seats cap blocks createInvitation when seat limit reached", async () => {
    await setPlan(ORG_BETA, "starter");
    // Beta already has 2 active members from the seed; starter cap = 2.
    const seats = await countInvites(ORG_BETA);
    // Pending invites are zero at start of this test (afterEach cleanup).
    assert.equal(seats, 0);

    await assert.rejects(
        () =>
            withTx(ORG_BETA, (client) =>
                createInvitation(client, ORG_BETA, USER_BETA_ADMIN, {
                    email: `${TEST_PREFIX}seat-overflow@beta.test`,
                    role: "employee",
                }),
            ),
        (err) =>
            err instanceof PlanLimitExceededError &&
            err.limitKey === "seats" &&
            err.plan === "starter" &&
            err.limit === 2 &&
            err.attempted === 3,
    );
    // No invitation row should have landed.
    assert.equal(await countInvites(ORG_BETA), 0);
});

// =============================================================== //
// 10. seats cap — pro plan headroom allows createInvitation
// =============================================================== //

test("10. seats cap allows createInvitation when under pro cap", async () => {
    await setPlan(ORG_BETA, "pro");
    const before = await countInvites(ORG_BETA);
    const inv = await withTx(ORG_BETA, (client) =>
        createInvitation(client, ORG_BETA, USER_BETA_ADMIN, {
            email: `${TEST_PREFIX}seat-fits@beta.test`,
            role: "employee",
        }),
    );
    createdInviteIds.add(inv.invitation.id);
    assert.equal(await countInvites(ORG_BETA), before + 1);
});

// =============================================================== //
// 11. PlanLimitExceededError shape
// =============================================================== //

test("11. PlanLimitExceededError exposes statusCode=403 + code=plan_limit_exceeded", () => {
    const e = new PlanLimitExceededError({
        limitKey: "seats",
        plan: "starter",
        current: 2,
        limit: 2,
        attempted: 3,
    });
    assert.equal(e.statusCode, 403);
    assert.equal(e.code, "plan_limit_exceeded");
    assert.equal(e.limitKey, "seats");
    assert.equal(e.plan, "starter");
    assert.equal(e.current, 2);
    assert.equal(e.limit, 2);
    assert.equal(e.attempted, 3);
});

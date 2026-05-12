/* Phase 5 Step 3 — /calls/:id heartbeat / link / unlink / manual summary.
 *
 * Plan: docs/plan/phase-5/PHASE_5_STEP_3_ROUTES.md §2.3, §5.3.
 *
 * Covers:
 *   - heartbeat updates last_seen_at and 404s on ended calls
 *   - link-customer enforces team-scope + composite-FK cross-org
 *   - unlink-customer keeps audit columns stamped
 *   - manual summary writes summary_source='manual', then a subsequent
 *     AI write is blocked at the repository level
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import authPlugin from "../src/plugins/auth.js";
import dbPlugin from "../src/plugins/db.js";
import authRoutes from "../src/routes/auth.js";
import callsRoutes from "../src/routes/calls.js";
import callsPhase5Routes from "../src/routes/callsPhase5.js";
import * as callSummaryService from "../src/services/callSummary.js";
import {
    ORG_ACME,
    ORG_BETA,
    USER_ACME_ADMIN,
    USER_ACME_EMP,
    USER_EMPLOYEE_TEAM_A,
    USER_EMPLOYEE_TEAM_B,
    CUSTOMER_ACME_KIM,
    CUSTOMER_BETA_JUNG,
    createFixtureUsers,
    destroyFixtureUsers,
    mintToken,
    authedInject,
    insertCallRaw,
    FIXTURE_PREFIX,
} from "./_phase5Fixture.mjs";

let app;

before(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    await app.register(dbPlugin);
    await app.register(authRoutes);
    await app.register(callsRoutes);
    await app.register(callsPhase5Routes);
    await createFixtureUsers(app);
});

after(async () => {
    if (app) {
        for (const orgId of [ORG_ACME, ORG_BETA]) {
            await app.withOrgContext(orgId, async (client) => {
                await client.query(
                    `DELETE FROM calls WHERE title LIKE $1`,
                    [`${FIXTURE_PREFIX}%`],
                );
            });
        }
        await destroyFixtureUsers(app);
        await app.pg.query(`DELETE FROM sessions`);
        await app.close();
    }
});

afterEach(async () => {
    await app.pg.query(`DELETE FROM sessions`);
});

// ============================================================
//                        Heartbeat
// ============================================================

test("POST /calls/:id/heartbeat updates last_seen_at on a live call", async () => {
    const token = mintToken(app, "acmeAdmin");
    const call = await insertCallRaw(app, ORG_ACME, {
        title: `${FIXTURE_PREFIX}hb-live`,
        agent_user_id: USER_ACME_ADMIN,
    });
    assert.equal(call.last_seen_at, null);

    const r = await authedInject(app, token, {
        method: "POST",
        url: `/calls/${call.id}/heartbeat`,
    });
    assert.equal(r.statusCode, 200);
    assert.ok(r.json().call.last_seen_at);
});

test("POST /calls/:id/heartbeat on an ended call → 404", async () => {
    const token = mintToken(app, "acmeAdmin");
    const call = await insertCallRaw(app, ORG_ACME, {
        title: `${FIXTURE_PREFIX}hb-ended`,
        agent_user_id: USER_ACME_ADMIN,
    });
    // Mark ended via the existing end route to keep state transitions valid.
    const e = await authedInject(app, token, {
        method: "POST",
        url: `/calls/${call.id}/end`,
        headers: { "content-type": "application/json" },
        payload: {},
    });
    assert.equal(e.statusCode, 200);
    const r = await authedInject(app, token, {
        method: "POST",
        url: `/calls/${call.id}/heartbeat`,
    });
    assert.equal(r.statusCode, 404);
});

// ============================================================
//                     Link / unlink customer
// ============================================================

test("POST /calls/:id/link-customer (admin) sets customer + audit cols", async () => {
    const token = mintToken(app, "acmeAdmin");
    const call = await insertCallRaw(app, ORG_ACME, {
        title: `${FIXTURE_PREFIX}link-target`,
        agent_user_id: USER_ACME_ADMIN,
    });
    const r = await authedInject(app, token, {
        method: "POST",
        url: `/calls/${call.id}/link-customer`,
        headers: { "content-type": "application/json" },
        payload: { customer_id: CUSTOMER_ACME_KIM },
    });
    assert.equal(r.statusCode, 200, r.body);
    const c = r.json().call;
    assert.equal(c.customer_id, CUSTOMER_ACME_KIM);
    assert.ok(c.customer_linked_at);
    assert.equal(c.customer_linked_by_user_id, USER_ACME_ADMIN);
});

test("POST /calls/:id/link-customer with cross-org customer_id → 400 invalid_reference", async () => {
    const token = mintToken(app, "acmeAdmin");
    const call = await insertCallRaw(app, ORG_ACME, {
        title: `${FIXTURE_PREFIX}link-xorg`,
        agent_user_id: USER_ACME_ADMIN,
    });
    const r = await authedInject(app, token, {
        method: "POST",
        url: `/calls/${call.id}/link-customer`,
        headers: { "content-type": "application/json" },
        payload: { customer_id: CUSTOMER_BETA_JUNG },
    });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error, "invalid_reference");
});

test("POST /calls/:id/link-customer as employee on other agent's call → 403", async () => {
    const adminToken = mintToken(app, "acmeAdmin");
    const empToken = mintToken(app, "acmeEmp");
    const call = await insertCallRaw(app, ORG_ACME, {
        title: `${FIXTURE_PREFIX}link-emp-blocked`,
        agent_user_id: USER_ACME_ADMIN,
    });
    const r = await authedInject(app, empToken, {
        method: "POST",
        url: `/calls/${call.id}/link-customer`,
        headers: { "content-type": "application/json" },
        payload: { customer_id: CUSTOMER_ACME_KIM },
    });
    assert.equal(r.statusCode, 403);

    // admin sanity
    const ok = await authedInject(app, adminToken, {
        method: "POST",
        url: `/calls/${call.id}/link-customer`,
        headers: { "content-type": "application/json" },
        payload: { customer_id: CUSTOMER_ACME_KIM },
    });
    assert.equal(ok.statusCode, 200);
});

test("POST /calls/:id/unlink-customer clears customer_id but keeps audit stamp", async () => {
    const token = mintToken(app, "acmeAdmin");
    const call = await insertCallRaw(app, ORG_ACME, {
        title: `${FIXTURE_PREFIX}unlink-target`,
        agent_user_id: USER_ACME_ADMIN,
    });
    const link = await authedInject(app, token, {
        method: "POST",
        url: `/calls/${call.id}/link-customer`,
        headers: { "content-type": "application/json" },
        payload: { customer_id: CUSTOMER_ACME_KIM },
    });
    assert.equal(link.statusCode, 200);

    const unlink = await authedInject(app, token, {
        method: "POST",
        url: `/calls/${call.id}/unlink-customer`,
    });
    assert.equal(unlink.statusCode, 200);
    const c = unlink.json().call;
    assert.equal(c.customer_id, null);
    // audit columns still stamped (records who last touched the binding).
    assert.ok(c.customer_linked_at);
    assert.equal(c.customer_linked_by_user_id, USER_ACME_ADMIN);
});

// ============================================================
//                       Manual summary
// ============================================================

test("POST /calls/:id/summary/manual sets summary_source='manual'", async () => {
    const token = mintToken(app, "acmeAdmin");
    const call = await insertCallRaw(app, ORG_ACME, {
        title: `${FIXTURE_PREFIX}manual-sum`,
        agent_user_id: USER_ACME_ADMIN,
    });
    const r = await authedInject(app, token, {
        method: "POST",
        url: `/calls/${call.id}/summary/manual`,
        headers: { "content-type": "application/json" },
        payload: {
            summary: "수동 요약",
            needs: "수동 needs",
            issues: null,
            sentiment: "positive",
        },
    });
    assert.equal(r.statusCode, 200, r.body);
    const c = r.json().call;
    assert.equal(c.summary, "수동 요약");
    assert.equal(c.summary_source, "manual");
});

test("manual summary blocks subsequent AI summary attempt (repo-level)", async () => {
    const token = mintToken(app, "acmeAdmin");
    const call = await insertCallRaw(app, ORG_ACME, {
        title: `${FIXTURE_PREFIX}manual-blocks-ai`,
        agent_user_id: USER_ACME_ADMIN,
    });
    const r = await authedInject(app, token, {
        method: "POST",
        url: `/calls/${call.id}/summary/manual`,
        headers: { "content-type": "application/json" },
        payload: {
            summary: "사용자가 쓴 요약",
            needs: null,
            issues: null,
            sentiment: null,
        },
    });
    assert.equal(r.statusCode, 200);

    // Service-level AI write should be a no-op (null return) on a
    // manual-sourced row. There is no REST AI-trigger in Step 3 — we
    // call the service directly to verify the protection.
    const ai = await callSummaryService.applyAiSummary(app, ORG_ACME, call.id, {
        summary: "AI가 덮어쓰려 함",
        needs: null,
        issues: null,
        sentiment: "neutral",
    });
    assert.equal(ai, null);

    // confirm the manual summary survived.
    const after = await app.withOrgContext(ORG_ACME, async (client) => {
        const x = await client.query(`SELECT summary FROM calls WHERE id = $1`, [
            call.id,
        ]);
        return x.rows[0];
    });
    assert.equal(after.summary, "사용자가 쓴 요약");
});

test("POST /calls/:id/summary/manual manager other-team → 403", async () => {
    const mgrToken = mintToken(app, "managerTeamA");
    const call = await insertCallRaw(app, ORG_ACME, {
        title: `${FIXTURE_PREFIX}sum-mgr-other`,
        agent_user_id: USER_EMPLOYEE_TEAM_B,
    });
    const r = await authedInject(app, mgrToken, {
        method: "POST",
        url: `/calls/${call.id}/summary/manual`,
        headers: { "content-type": "application/json" },
        payload: {
            summary: "다른 팀 만지려는 요약",
            needs: null,
            issues: null,
            sentiment: null,
        },
    });
    assert.equal(r.statusCode, 403);
});

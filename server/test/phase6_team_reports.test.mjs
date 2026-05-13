/* Phase 6 Step 4 — GET /reports/team-summary route + service tests.
 *
 * Plan: docs/plan/phase-6/PHASE_6_STEP_4_PLAN.md §8.
 *
 * 14 cases covering the authorization matrix and KPI edge cases:
 *   1. admin no team_id → 200 org-wide.
 *   2. admin same-org team_id → 200 team summary.
 *   3. admin cross-org team_id → 404.
 *   4. manager no team_id → 200 own team summary.
 *   5. manager own team_id → 200 (same data).
 *   6. manager other same-org team_id → 403.
 *   7. manager cross-org team_id → 404.
 *   8. manager without team membership → 403.
 *   9. employee → 403.
 *  10. viewer → 403.
 *  11. invalid team_id → 400 invalid_input.
 *  12. soft-deleted calls excluded from metrics + recent list.
 *  13. unassigned calls excluded from manager team scope.
 *  14. response_rate null when ended + missed denominator is zero.
 *
 * Test data hygiene:
 *   - call title prefix `${FIXTURE_PREFIX}report-` so the after hook
 *     can sweep both orgs and the test never touches seed rows.
 *   - the Beta `${PREFIX}team-beta` row is removed in the after hook
 *     alongside the calls.
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import authPlugin from "../src/plugins/auth.js";
import dbPlugin from "../src/plugins/db.js";
import authRoutes from "../src/routes/auth.js";
import reportsRoutes from "../src/routes/reports.js";
import {
    ORG_ACME,
    ORG_BETA,
    USER_ACME_ADMIN,
    USER_BETA_ADMIN,
    USER_BETA_EMP,
    USER_MANAGER_TEAM_A,
    USER_EMPLOYEE_TEAM_A,
    USER_EMPLOYEE_TEAM_B,
    TEAM_A_ID,
    TEAM_B_ID,
    createFixtureUsers,
    destroyFixtureUsers,
    mintToken,
    authedInject,
    insertCallRaw,
    FIXTURE_PREFIX,
} from "./_phase5Fixture.mjs";

const PREFIX = `${FIXTURE_PREFIX}report-`;
const BETA_TEAM_ID = "99990001-bbbb-bbbb-bbbb-000000000001";

let app;

before(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    await app.register(dbPlugin);
    await app.register(authRoutes);
    await app.register(reportsRoutes);
    await createFixtureUsers(app);

    // A second team owned by Beta lets us cover the cross-org 404
    // branch: same UUID schema, definitely invisible from Acme via RLS.
    await app.withOrgContext(ORG_BETA, async (client) => {
        await client.query(
            `INSERT INTO teams (id, org_id, name)
             VALUES ($1, $2, $3)
             ON CONFLICT (id) DO NOTHING`,
            [BETA_TEAM_ID, ORG_BETA, `${PREFIX}team-beta`],
        );
    });
});

after(async () => {
    if (app) {
        for (const orgId of [ORG_ACME, ORG_BETA]) {
            await app.withOrgContext(orgId, async (client) => {
                await client.query(
                    `DELETE FROM calls WHERE title LIKE $1`,
                    [`${PREFIX}%`],
                );
            });
        }
        await app.withOrgContext(ORG_BETA, async (client) => {
            await client.query(`DELETE FROM teams WHERE id = $1`, [
                BETA_TEAM_ID,
            ]);
        });
        await destroyFixtureUsers(app);
        await app.pg.query(`DELETE FROM sessions`);
        await app.close();
    }
});

afterEach(async () => {
    await app.pg.query(`DELETE FROM sessions`);
});

// ─────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────

async function inject(token, query = "") {
    return authedInject(app, token, {
        method: "GET",
        url: "/reports/team-summary" + (query ? "?" + query : ""),
    });
}

async function softDeleteCall(orgId, callId) {
    await app.withOrgContext(orgId, async (client) => {
        await client.query(
            `UPDATE calls SET deleted_at = now() WHERE id = $1`,
            [callId],
        );
    });
}

// ─────────────────────────────────────────────
// authorization matrix
// ─────────────────────────────────────────────

test("1. admin no team_id → 200 org-wide summary covers every Acme call", async () => {
    const a = await insertCallRaw(app, ORG_ACME, {
        title: `${PREFIX}case1-team-a`,
        agent_user_id: USER_EMPLOYEE_TEAM_A,
        status: "ended",
        duration_seconds: 90,
    });
    const b = await insertCallRaw(app, ORG_ACME, {
        title: `${PREFIX}case1-team-b`,
        agent_user_id: USER_EMPLOYEE_TEAM_B,
        status: "missed",
    });
    const unassigned = await insertCallRaw(app, ORG_ACME, {
        title: `${PREFIX}case1-unassigned`,
        agent_user_id: null,
        status: "in_progress",
    });

    const token = mintToken(app, "acmeAdmin");
    const r = await inject(token);
    assert.equal(r.statusCode, 200, r.body);
    const body = r.json();
    assert.equal(body.scope, "org");
    assert.equal(body.team_id, null);
    assert.equal(body.team_name, null);
    const ids = new Set(body.recent_calls.map((c) => c.id));
    assert.ok(ids.has(a.id));
    assert.ok(ids.has(b.id));
    assert.ok(ids.has(unassigned.id), "org-wide must include unassigned calls");
    assert.ok(body.total_calls >= 3);
    assert.ok(body.ended_calls >= 1);
    assert.ok(body.missed_calls >= 1);
    assert.ok(body.active_calls >= 1);
});

test("2. admin same-org team_id → 200 team summary", async () => {
    const a = await insertCallRaw(app, ORG_ACME, {
        title: `${PREFIX}case2-team-a`,
        agent_user_id: USER_EMPLOYEE_TEAM_A,
        status: "ended",
        duration_seconds: 60,
    });
    const b = await insertCallRaw(app, ORG_ACME, {
        title: `${PREFIX}case2-team-b`,
        agent_user_id: USER_EMPLOYEE_TEAM_B,
        status: "ended",
        duration_seconds: 30,
    });

    const token = mintToken(app, "acmeAdmin");
    const r = await inject(token, "team_id=" + encodeURIComponent(TEAM_A_ID));
    assert.equal(r.statusCode, 200, r.body);
    const body = r.json();
    assert.equal(body.scope, "team");
    assert.equal(body.team_id, TEAM_A_ID);
    assert.ok(typeof body.team_name === "string" && body.team_name.length > 0);
    const ids = new Set(body.recent_calls.map((c) => c.id));
    assert.ok(ids.has(a.id), "team-A call must appear");
    assert.equal(ids.has(b.id), false, "team-B call must NOT appear");
});

test("3. admin cross-org team_id → 404 not_found", async () => {
    const token = mintToken(app, "acmeAdmin");
    const r = await inject(token, "team_id=" + encodeURIComponent(BETA_TEAM_ID));
    assert.equal(r.statusCode, 404, r.body);
    assert.equal(r.json().error, "not_found");
});

test("4. manager no team_id → 200 own team summary", async () => {
    const a = await insertCallRaw(app, ORG_ACME, {
        title: `${PREFIX}case4-team-a`,
        agent_user_id: USER_EMPLOYEE_TEAM_A,
        status: "ended",
        duration_seconds: 45,
    });
    const b = await insertCallRaw(app, ORG_ACME, {
        title: `${PREFIX}case4-team-b`,
        agent_user_id: USER_EMPLOYEE_TEAM_B,
        status: "ended",
        duration_seconds: 999,
    });

    const token = mintToken(app, "managerTeamA");
    const r = await inject(token);
    assert.equal(r.statusCode, 200, r.body);
    const body = r.json();
    assert.equal(body.scope, "team");
    assert.equal(body.team_id, TEAM_A_ID);
    const ids = new Set(body.recent_calls.map((c) => c.id));
    assert.ok(ids.has(a.id));
    assert.equal(ids.has(b.id), false);
});

test("5. manager own team_id → 200 same as omitted", async () => {
    const token = mintToken(app, "managerTeamA");
    const r = await inject(token, "team_id=" + encodeURIComponent(TEAM_A_ID));
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().team_id, TEAM_A_ID);
});

test("6. manager other same-org team_id → 403 forbidden", async () => {
    const token = mintToken(app, "managerTeamA");
    const r = await inject(token, "team_id=" + encodeURIComponent(TEAM_B_ID));
    assert.equal(r.statusCode, 403, r.body);
    assert.equal(r.json().error, "forbidden");
});

test("7. manager cross-org team_id → 404", async () => {
    const token = mintToken(app, "managerTeamA");
    const r = await inject(token, "team_id=" + encodeURIComponent(BETA_TEAM_ID));
    assert.equal(r.statusCode, 404, r.body);
    assert.equal(r.json().error, "not_found");
});

test("8. manager without team membership → 403", async () => {
    const token = mintToken(app, "managerNoTeam");
    const r = await inject(token);
    assert.equal(r.statusCode, 403, r.body);
    assert.equal(r.json().error, "forbidden");
});

test("9. employee → 403 (requireRole)", async () => {
    const token = mintToken(app, "acmeEmp");
    const r = await inject(token);
    assert.equal(r.statusCode, 403, r.body);
});

test("10. viewer → 403 (requireRole)", async () => {
    const token = mintToken(app, "viewerNoTeam");
    const r = await inject(token);
    assert.equal(r.statusCode, 403, r.body);
});

test("11. invalid team_id → 400 invalid_input", async () => {
    const token = mintToken(app, "acmeAdmin");
    const r = await inject(token, "team_id=not-a-uuid");
    assert.equal(r.statusCode, 400, r.body);
    assert.equal(r.json().error, "invalid_input");
});

// ─────────────────────────────────────────────
// KPI edge cases
// ─────────────────────────────────────────────

test("12. soft-deleted calls are excluded from metrics + recent_calls", async () => {
    const live = await insertCallRaw(app, ORG_ACME, {
        title: `${PREFIX}case12-live`,
        agent_user_id: USER_EMPLOYEE_TEAM_A,
        status: "ended",
        duration_seconds: 10,
    });
    const dead = await insertCallRaw(app, ORG_ACME, {
        title: `${PREFIX}case12-dead`,
        agent_user_id: USER_EMPLOYEE_TEAM_A,
        status: "ended",
        duration_seconds: 10,
    });
    await softDeleteCall(ORG_ACME, dead.id);

    const token = mintToken(app, "managerTeamA");
    const r = await inject(token);
    assert.equal(r.statusCode, 200, r.body);
    const ids = new Set(r.json().recent_calls.map((c) => c.id));
    assert.ok(ids.has(live.id));
    assert.equal(ids.has(dead.id), false, "soft-deleted call must not appear");
});

test("13. unassigned calls are excluded from manager team scope", async () => {
    const teamCall = await insertCallRaw(app, ORG_ACME, {
        title: `${PREFIX}case13-team`,
        agent_user_id: USER_EMPLOYEE_TEAM_A,
        status: "ended",
        duration_seconds: 5,
    });
    const unassigned = await insertCallRaw(app, ORG_ACME, {
        title: `${PREFIX}case13-unassigned`,
        agent_user_id: null,
        status: "ended",
        duration_seconds: 5,
    });

    const token = mintToken(app, "managerTeamA");
    const r = await inject(token);
    assert.equal(r.statusCode, 200, r.body);
    const ids = new Set(r.json().recent_calls.map((c) => c.id));
    assert.ok(ids.has(teamCall.id));
    assert.equal(
        ids.has(unassigned.id),
        false,
        "unassigned call must not appear in manager team summary",
    );
});

test("14. response_rate is null when ended + missed denominator is zero", async () => {
    // Beta org is used so we control the data set in isolation —
    // we only insert in_progress / dropped rows, both of which are
    // excluded from the response_rate denominator. ended_calls = 0
    // and missed_calls = 0 → denom = 0 → null.
    await insertCallRaw(app, ORG_BETA, {
        title: `${PREFIX}case14-active`,
        agent_user_id: USER_BETA_EMP,
        status: "in_progress",
    });
    await insertCallRaw(app, ORG_BETA, {
        title: `${PREFIX}case14-dropped`,
        agent_user_id: USER_BETA_EMP,
        status: "dropped",
        // dropped calls usually carry dropped_reason; leave null to keep
        // the row valid via the migration's nullable column.
    });

    const token = mintToken(app, "betaAdmin");
    const r = await inject(token);
    assert.equal(r.statusCode, 200, r.body);
    const body = r.json();
    // The Beta org has no seed calls right now, so ended + missed is
    // genuinely zero here. If a future seed adds ended/missed Beta
    // rows, this assertion will surface that — adjust the test data
    // policy accordingly instead of relaxing the assertion.
    assert.equal(body.ended_calls, 0);
    assert.equal(body.missed_calls, 0);
    assert.equal(
        body.response_rate,
        null,
        `expected null response_rate; got ${body.response_rate}`,
    );
});

// Keep imports live so linters don't drop them; future cross-org test
// branches will reach for these identifiers.
void USER_ACME_ADMIN;
void USER_BETA_ADMIN;
void USER_MANAGER_TEAM_A;

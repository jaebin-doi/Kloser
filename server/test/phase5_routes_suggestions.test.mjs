/* Phase 5 Step 3 — /calls/:id/suggestions + /call-suggestions/:id/use|dismiss.
 *
 * Plan: docs/plan/phase-5/PHASE_5_STEP_3_ROUTES.md §2.3, §5.3.
 *
 * Covers:
 *   - listing is open to any same-org user (RLS scope)
 *   - use/dismiss requires writer chain + parent-call team-scope
 *   - double-use / dismiss-after-use → 409 conflict_state
 *   - cross-org → 404 not_found
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
import * as suggestionsRepo from "../src/repositories/callSuggestions.js";
import {
    ORG_ACME,
    ORG_BETA,
    USER_ACME_ADMIN,
    USER_ACME_EMP,
    USER_EMPLOYEE_TEAM_A,
    USER_EMPLOYEE_TEAM_B,
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
                    `DELETE FROM call_suggestions WHERE title LIKE $1`,
                    [`${FIXTURE_PREFIX}%`],
                );
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

async function persistSuggestion(orgId, callId, item) {
    return app.withOrgContext(orgId, async (client) => {
        const rows = await suggestionsRepo.insertGroupForCallInCurrentOrg(
            client,
            callId,
            [item],
        );
        return rows?.[0];
    });
}

// ============================================================
//                          List
// ============================================================

test("GET /calls/:id/suggestions returns the call's suggestions", async () => {
    const adminToken = mintToken(app, "acmeAdmin");
    const empToken = mintToken(app, "acmeEmp");

    const call = await insertCallRaw(app, ORG_ACME, {
        title: `${FIXTURE_PREFIX}sug-list`,
        agent_user_id: USER_ACME_ADMIN,
    });
    await persistSuggestion(ORG_ACME, call.id, {
        group_seq: 0,
        at_ms: 500,
        tone: "blue",
        type: "direction",
        title: `${FIXTURE_PREFIX}list-card`,
        body: "body",
    });
    for (const tok of [adminToken, empToken]) {
        const r = await authedInject(app, tok, {
            method: "GET",
            url: `/calls/${call.id}/suggestions`,
        });
        assert.equal(r.statusCode, 200);
        assert.equal(r.json().items.length, 1);
        assert.equal(r.json().items[0].type, "direction");
    }
});

test("GET /calls/:id/suggestions cross-org → 404", async () => {
    const betaToken = mintToken(app, "betaAdmin");
    const acmeCall = await insertCallRaw(app, ORG_ACME, {
        title: `${FIXTURE_PREFIX}sug-xorg`,
        agent_user_id: USER_ACME_ADMIN,
    });
    const r = await authedInject(app, betaToken, {
        method: "GET",
        url: `/calls/${acmeCall.id}/suggestions`,
    });
    assert.equal(r.statusCode, 404);
});

// ============================================================
//                       Use / dismiss
// ============================================================

test("POST /call-suggestions/:id/use marks used_at and dismiss after use → 409", async () => {
    const adminToken = mintToken(app, "acmeAdmin");
    const call = await insertCallRaw(app, ORG_ACME, {
        title: `${FIXTURE_PREFIX}sug-use`,
        agent_user_id: USER_ACME_ADMIN,
    });
    const s = await persistSuggestion(ORG_ACME, call.id, {
        group_seq: 0,
        at_ms: 1000,
        tone: "amber",
        type: "next",
        title: `${FIXTURE_PREFIX}use-card`,
        body: null,
    });

    const ok = await authedInject(app, adminToken, {
        method: "POST",
        url: `/call-suggestions/${s.id}/use`,
    });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.ok(ok.json().suggestion.used_at);

    const dup = await authedInject(app, adminToken, {
        method: "POST",
        url: `/call-suggestions/${s.id}/use`,
    });
    assert.equal(dup.statusCode, 409);
    assert.equal(dup.json().error, "conflict_state");

    const dismissAfterUse = await authedInject(app, adminToken, {
        method: "POST",
        url: `/call-suggestions/${s.id}/dismiss`,
    });
    assert.equal(dismissAfterUse.statusCode, 409);
});

test("POST /call-suggestions/:id/use as employee on other agent's call → 403", async () => {
    const adminToken = mintToken(app, "acmeAdmin");
    const empToken = mintToken(app, "acmeEmp");

    const call = await insertCallRaw(app, ORG_ACME, {
        title: `${FIXTURE_PREFIX}sug-emp-block`,
        agent_user_id: USER_ACME_ADMIN,
    });
    const s = await persistSuggestion(ORG_ACME, call.id, {
        group_seq: 0,
        at_ms: 2000,
        tone: "rose",
        type: "risk",
        title: `${FIXTURE_PREFIX}emp-block-card`,
        body: null,
    });

    // Sanity: admin can use.
    const ok = await authedInject(app, adminToken, {
        method: "GET",
        url: `/calls/${call.id}/suggestions`,
    });
    assert.equal(ok.statusCode, 200);

    const blocked = await authedInject(app, empToken, {
        method: "POST",
        url: `/call-suggestions/${s.id}/use`,
    });
    assert.equal(blocked.statusCode, 403);
});

test("POST /call-suggestions/:id/dismiss manager other-team → 403", async () => {
    const adminToken = mintToken(app, "acmeAdmin");
    const mgrAToken = mintToken(app, "managerTeamA");

    const callOther = await insertCallRaw(app, ORG_ACME, {
        title: `${FIXTURE_PREFIX}sug-mgr-other`,
        agent_user_id: USER_EMPLOYEE_TEAM_B,
    });
    const s = await persistSuggestion(ORG_ACME, callOther.id, {
        group_seq: 0,
        at_ms: 3000,
        tone: "slate",
        type: "alert",
        title: `${FIXTURE_PREFIX}mgr-other-card`,
        body: null,
    });
    const r = await authedInject(app, mgrAToken, {
        method: "POST",
        url: `/call-suggestions/${s.id}/dismiss`,
    });
    assert.equal(r.statusCode, 403);

    // admin should pass to confirm endpoint is reachable.
    const ok = await authedInject(app, adminToken, {
        method: "POST",
        url: `/call-suggestions/${s.id}/dismiss`,
    });
    assert.equal(ok.statusCode, 200);
    assert.ok(ok.json().suggestion.dismissed_at);
});

test("manager same-team can use a suggestion of a teammate's call", async () => {
    const mgrAToken = mintToken(app, "managerTeamA");
    const call = await insertCallRaw(app, ORG_ACME, {
        title: `${FIXTURE_PREFIX}sug-mgr-same`,
        agent_user_id: USER_EMPLOYEE_TEAM_A,
    });
    const s = await persistSuggestion(ORG_ACME, call.id, {
        group_seq: 0,
        at_ms: 4000,
        tone: "emerald",
        type: "script",
        title: `${FIXTURE_PREFIX}mgr-same-card`,
        body: null,
    });
    const r = await authedInject(app, mgrAToken, {
        method: "POST",
        url: `/call-suggestions/${s.id}/use`,
    });
    assert.equal(r.statusCode, 200, r.body);
});

/* Phase 6 Step 3 — DELETE /call-action-items/:id route + service tests.
 *
 * Plan: docs/plan/phase-6/PHASE_6_STEP_3_PLAN.md §5.
 *
 * Covers the 10 permission/error cases:
 *   1. admin same-org delete → 204, row gone
 *   2. employee own call → 204
 *   3. employee other agent's call → 403
 *   4. manager same-team call → 204
 *   5. manager other-team call → 403
 *   6. manager unassigned (agent_user_id=NULL) call → 403
 *   7. viewer → 403 (blocked at requireRole)
 *   8. cross-org id → 404 (RLS hides existence)
 *   9. invalid UUID path param → 400 invalid_input
 *  10. repeated delete of same id → 404
 *
 * Test data hygiene:
 *   - every call this suite creates carries the FIXTURE_PREFIX so the
 *     after-hook cascade-deletes them (cascade covers action_items too).
 *   - seed users, customers, memberships, teams are never touched.
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import authPlugin from "../src/plugins/auth.js";
import dbPlugin from "../src/plugins/db.js";
import authRoutes from "../src/routes/auth.js";
import callsRoutes from "../src/routes/calls.js";
import {
    ORG_ACME,
    ORG_BETA,
    USER_ACME_ADMIN,
    USER_ACME_EMP,
    USER_BETA_ADMIN,
    USER_MANAGER_TEAM_A,
    USER_EMPLOYEE_TEAM_A,
    USER_EMPLOYEE_TEAM_B,
    createFixtureUsers,
    destroyFixtureUsers,
    mintToken,
    authedInject,
    insertCallRaw,
    FIXTURE_PREFIX,
} from "./_phase5Fixture.mjs";
import * as actionItemsRepo from "../src/repositories/callActionItems.js";

const PREFIX = `${FIXTURE_PREFIX}actiondelete-`;

let app;

before(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    await app.register(dbPlugin);
    await app.register(authRoutes);
    await app.register(callsRoutes);
    await createFixtureUsers(app);
});

after(async () => {
    if (app) {
        for (const orgId of [ORG_ACME, ORG_BETA]) {
            await app.withOrgContext(orgId, async (client) => {
                // Call delete cascades into call_action_items so a single
                // sweep on the calls table is enough.
                await client.query(
                    `DELETE FROM calls WHERE title LIKE $1`,
                    [`${PREFIX}%`],
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

// ─────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────

async function createActionItem(orgId, callId, title) {
    return app.withOrgContext(orgId, async (client) => {
        const r = await client.query(
            `INSERT INTO call_action_items (
                org_id, call_id, title, status, completed_at
             ) VALUES ($1, $2, $3, 'open', NULL)
             RETURNING id, call_id, org_id, title, status`,
            [orgId, callId, title],
        );
        return r.rows[0];
    });
}

async function actionItemExists(orgId, id) {
    return app.withOrgContext(orgId, async (client) => {
        const r = await client.query(
            `SELECT 1 FROM call_action_items WHERE id = $1`,
            [id],
        );
        return r.rowCount > 0;
    });
}

async function deleteActionItem(token, id) {
    return authedInject(app, token, {
        method: "DELETE",
        url: `/call-action-items/${id}`,
    });
}

// ─────────────────────────────────────────────
// cases
// ─────────────────────────────────────────────

test("1. admin same-org delete → 204 and row gone", async () => {
    const call = await insertCallRaw(app, ORG_ACME, {
        title: `${PREFIX}admin-happy`,
        agent_user_id: USER_ACME_ADMIN,
    });
    const item = await createActionItem(ORG_ACME, call.id, "follow up");
    const token = mintToken(app, "acmeAdmin");

    const r = await deleteActionItem(token, item.id);
    assert.equal(r.statusCode, 204, r.body);
    assert.equal(r.body, "");

    assert.equal(await actionItemExists(ORG_ACME, item.id), false);
});

test("2. employee deleting their own call's action item → 204", async () => {
    const call = await insertCallRaw(app, ORG_ACME, {
        title: `${PREFIX}emp-own`,
        agent_user_id: USER_ACME_EMP,
    });
    const item = await createActionItem(ORG_ACME, call.id, "emp follow up");
    const token = mintToken(app, "acmeEmp");

    const r = await deleteActionItem(token, item.id);
    assert.equal(r.statusCode, 204, r.body);
    assert.equal(await actionItemExists(ORG_ACME, item.id), false);
});

test("3. employee deleting a different agent's action item → 403", async () => {
    const call = await insertCallRaw(app, ORG_ACME, {
        title: `${PREFIX}emp-other`,
        agent_user_id: USER_ACME_ADMIN, // owned by admin
    });
    const item = await createActionItem(ORG_ACME, call.id, "not your task");
    const empToken = mintToken(app, "acmeEmp");

    const r = await deleteActionItem(empToken, item.id);
    assert.equal(r.statusCode, 403, r.body);
    assert.equal(r.json().error, "forbidden");

    // Row must still be there.
    assert.equal(await actionItemExists(ORG_ACME, item.id), true);
});

test("4. manager deleting a same-team call's action item → 204", async () => {
    const call = await insertCallRaw(app, ORG_ACME, {
        title: `${PREFIX}mgr-team`,
        agent_user_id: USER_EMPLOYEE_TEAM_A,
    });
    const item = await createActionItem(ORG_ACME, call.id, "team task");
    const mgrToken = mintToken(app, "managerTeamA");

    const r = await deleteActionItem(mgrToken, item.id);
    assert.equal(r.statusCode, 204, r.body);
    assert.equal(await actionItemExists(ORG_ACME, item.id), false);
});

test("5. manager deleting an other-team call's action item → 403", async () => {
    const call = await insertCallRaw(app, ORG_ACME, {
        title: `${PREFIX}mgr-otherteam`,
        agent_user_id: USER_EMPLOYEE_TEAM_B,
    });
    const item = await createActionItem(ORG_ACME, call.id, "other team task");
    const mgrToken = mintToken(app, "managerTeamA");

    const r = await deleteActionItem(mgrToken, item.id);
    assert.equal(r.statusCode, 403, r.body);
    assert.equal(r.json().error, "forbidden");
    assert.equal(await actionItemExists(ORG_ACME, item.id), true);
});

test("6. manager deleting an unassigned call's action item → 403", async () => {
    const call = await insertCallRaw(app, ORG_ACME, {
        title: `${PREFIX}mgr-unassigned`,
        agent_user_id: null,
    });
    const item = await createActionItem(ORG_ACME, call.id, "no agent task");
    const mgrToken = mintToken(app, "managerTeamA");

    const r = await deleteActionItem(mgrToken, item.id);
    assert.equal(r.statusCode, 403, r.body);
    assert.equal(r.json().error, "forbidden");
    assert.equal(await actionItemExists(ORG_ACME, item.id), true);
});

test("7. viewer → 403 (blocked at requireRole)", async () => {
    const call = await insertCallRaw(app, ORG_ACME, {
        title: `${PREFIX}viewer`,
        agent_user_id: USER_ACME_ADMIN,
    });
    const item = await createActionItem(ORG_ACME, call.id, "viewer cannot touch");
    const viewerToken = mintToken(app, "viewerNoTeam");

    const r = await deleteActionItem(viewerToken, item.id);
    assert.equal(r.statusCode, 403, r.body);
    assert.equal(await actionItemExists(ORG_ACME, item.id), true);
});

test("8. cross-org id → 404 (RLS hides existence)", async () => {
    const call = await insertCallRaw(app, ORG_ACME, {
        title: `${PREFIX}xorg-acme`,
        agent_user_id: USER_ACME_ADMIN,
    });
    const item = await createActionItem(ORG_ACME, call.id, "acme owned");
    // Use a Beta admin token; the Acme action item should not exist
    // from their perspective.
    const betaToken = mintToken(app, "betaAdmin");

    const r = await deleteActionItem(betaToken, item.id);
    assert.equal(r.statusCode, 404, r.body);
    assert.equal(r.json().error, "not_found");

    // Acme row must still be there.
    assert.equal(await actionItemExists(ORG_ACME, item.id), true);
});

test("9. invalid UUID path param → 400 invalid_input", async () => {
    const token = mintToken(app, "acmeAdmin");
    const r = await authedInject(app, token, {
        method: "DELETE",
        url: "/call-action-items/not-a-uuid",
    });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error, "invalid_input");
});

test("10. repeated delete of the same id → second call returns 404", async () => {
    const call = await insertCallRaw(app, ORG_ACME, {
        title: `${PREFIX}double-delete`,
        agent_user_id: USER_ACME_ADMIN,
    });
    const item = await createActionItem(ORG_ACME, call.id, "delete twice");
    const token = mintToken(app, "acmeAdmin");

    const first = await deleteActionItem(token, item.id);
    assert.equal(first.statusCode, 204, first.body);

    const second = await deleteActionItem(token, item.id);
    assert.equal(second.statusCode, 404, second.body);
    assert.equal(second.json().error, "not_found");
});

// ─────────────────────────────────────────────
// Repository helper sanity (direct call, bypassing the route)
// ─────────────────────────────────────────────

test("repo deleteByIdInCurrentOrg returns false for an already-removed id", async () => {
    const call = await insertCallRaw(app, ORG_ACME, {
        title: `${PREFIX}repo-missing`,
        agent_user_id: USER_ACME_ADMIN,
    });
    const item = await createActionItem(ORG_ACME, call.id, "repo direct");
    const first = await app.withOrgContext(ORG_ACME, (client) =>
        actionItemsRepo.deleteByIdInCurrentOrg(client, item.id),
    );
    assert.equal(first, true);
    const second = await app.withOrgContext(ORG_ACME, (client) =>
        actionItemsRepo.deleteByIdInCurrentOrg(client, item.id),
    );
    assert.equal(second, false);
});

test("repo deleteByIdInCurrentOrg returns false for cross-org id", async () => {
    const call = await insertCallRaw(app, ORG_ACME, {
        title: `${PREFIX}repo-xorg`,
        agent_user_id: USER_ACME_ADMIN,
    });
    const item = await createActionItem(ORG_ACME, call.id, "cross-org repo");
    // Run delete under Beta context — RLS should make the row invisible.
    const result = await app.withOrgContext(ORG_BETA, (client) =>
        actionItemsRepo.deleteByIdInCurrentOrg(client, item.id),
    );
    assert.equal(result, false);
    // Row remains in Acme.
    assert.equal(await actionItemExists(ORG_ACME, item.id), true);
});

// Reference: USER_BETA_ADMIN imported for future cross-org cases; keep
// the import live so removing it requires a deliberate edit.
void USER_BETA_ADMIN;

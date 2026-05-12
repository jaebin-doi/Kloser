/* Phase 5 Step 3 — /call-checklist-templates/* + /calls/:id/checklist + /call-checklist-items.
 *
 * Plan: docs/plan/phase-5/PHASE_5_STEP_3_ROUTES.md §2.3, §5.3.
 *
 * Covers:
 *   - templates CRUD admin-only, list open to all
 *   - initialize is idempotent and gated to writer chain
 *   - GET checklist open to all same-org users
 *   - mark status: employee own ok, employee other 403, manager same-team
 *     ok, manager other-team 403, admin always
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
import checklistTemplatesRoutes from "../src/routes/checklistTemplates.js";
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
    await app.register(checklistTemplatesRoutes);
    await createFixtureUsers(app);
});

after(async () => {
    if (app) {
        for (const orgId of [ORG_ACME, ORG_BETA]) {
            await app.withOrgContext(orgId, async (client) => {
                await client.query(
                    `DELETE FROM call_checklist_items
                       WHERE call_id IN (SELECT id FROM calls WHERE title LIKE $1)`,
                    [`${FIXTURE_PREFIX}%`],
                );
                await client.query(
                    `DELETE FROM calls WHERE title LIKE $1`,
                    [`${FIXTURE_PREFIX}%`],
                );
                await client.query(
                    `DELETE FROM org_call_checklist_templates WHERE title LIKE $1`,
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

async function createTemplate(token, title, sortOrder = 0) {
    const r = await authedInject(app, token, {
        method: "POST",
        url: "/call-checklist-templates",
        headers: { "content-type": "application/json" },
        payload: { title, sort_order: sortOrder },
    });
    assert.equal(r.statusCode, 201, `create template: ${r.statusCode} ${r.body}`);
    return r.json().template;
}

// ============================================================
//                       Templates CRUD
// ============================================================

test("GET /call-checklist-templates is open to any same-org user", async () => {
    const adminToken = mintToken(app, "acmeAdmin");
    const empToken = mintToken(app, "acmeEmp");

    const tmpl = await createTemplate(adminToken, `${FIXTURE_PREFIX}item-1`, 1);
    try {
        for (const tok of [adminToken, empToken]) {
            const r = await authedInject(app, tok, {
                method: "GET",
                url: "/call-checklist-templates",
            });
            assert.equal(r.statusCode, 200);
            assert.ok(r.json().items.some((t) => t.id === tmpl.id));
        }
    } finally {
        await app.withOrgContext(ORG_ACME, async (client) => {
            await client.query(
                `DELETE FROM org_call_checklist_templates WHERE id = $1`,
                [tmpl.id],
            );
        });
    }
});

test("POST /call-checklist-templates as employee → 403", async () => {
    const token = mintToken(app, "acmeEmp");
    const r = await authedInject(app, token, {
        method: "POST",
        url: "/call-checklist-templates",
        headers: { "content-type": "application/json" },
        payload: { title: `${FIXTURE_PREFIX}emp-blocked` },
    });
    assert.equal(r.statusCode, 403);
});

test("PATCH /call-checklist-templates/:id cross-org → 404", async () => {
    const acmeToken = mintToken(app, "acmeAdmin");
    const betaToken = mintToken(app, "betaAdmin");

    const tmpl = await createTemplate(
        acmeToken,
        `${FIXTURE_PREFIX}xorg-template`,
        2,
    );
    try {
        const r = await authedInject(app, betaToken, {
            method: "PATCH",
            url: `/call-checklist-templates/${tmpl.id}`,
            headers: { "content-type": "application/json" },
            payload: { title: "should not stick" },
        });
        assert.equal(r.statusCode, 404);
    } finally {
        await app.withOrgContext(ORG_ACME, async (client) => {
            await client.query(
                `DELETE FROM org_call_checklist_templates WHERE id = $1`,
                [tmpl.id],
            );
        });
    }
});

// ============================================================
//                       Initialize + GET + mark
// ============================================================

test("initialize copies active templates into call_checklist_items (idempotent)", async () => {
    const adminToken = mintToken(app, "acmeAdmin");
    const tmpl1 = await createTemplate(
        adminToken,
        `${FIXTURE_PREFIX}init-1`,
        1,
    );
    const tmpl2 = await createTemplate(
        adminToken,
        `${FIXTURE_PREFIX}init-2`,
        2,
    );
    const call = await insertCallRaw(app, ORG_ACME, {
        title: `${FIXTURE_PREFIX}init-call`,
        agent_user_id: USER_ACME_ADMIN,
    });

    const a = await authedInject(app, adminToken, {
        method: "POST",
        url: `/calls/${call.id}/checklist/initialize`,
    });
    assert.equal(a.statusCode, 200, a.body);
    const firstCount = a.json().items.length;
    assert.ok(firstCount >= 2, `expected ≥ 2 items, got ${firstCount}`);

    // Re-run should not duplicate.
    const b = await authedInject(app, adminToken, {
        method: "POST",
        url: `/calls/${call.id}/checklist/initialize`,
    });
    assert.equal(b.statusCode, 200);
    assert.equal(b.json().items.length, firstCount);

    // GET returns the same set.
    const list = await authedInject(app, adminToken, {
        method: "GET",
        url: `/calls/${call.id}/checklist`,
    });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().items.length, firstCount);
    assert.ok(list.json().items.every((i) => i.status === "open"));

    // Clean templates used here (call cascades).
    await app.withOrgContext(ORG_ACME, async (client) => {
        await client.query(
            `DELETE FROM org_call_checklist_templates WHERE id = ANY($1::uuid[])`,
            [[tmpl1.id, tmpl2.id]],
        );
    });
});

test("initialize enforces employee-own and manager team-scope", async () => {
    const adminToken = mintToken(app, "acmeAdmin");
    const empToken = mintToken(app, "acmeEmp");
    const mgrAToken = mintToken(app, "managerTeamA");
    const tmpl = await createTemplate(
        adminToken,
        `${FIXTURE_PREFIX}init-perm`,
        3,
    );

    const employeeOwnCall = await insertCallRaw(app, ORG_ACME, {
        title: `${FIXTURE_PREFIX}init-emp-own`,
        agent_user_id: USER_ACME_EMP,
    });
    const employeeOtherCall = await insertCallRaw(app, ORG_ACME, {
        title: `${FIXTURE_PREFIX}init-emp-other`,
        agent_user_id: USER_ACME_ADMIN,
    });
    const managerSameTeamCall = await insertCallRaw(app, ORG_ACME, {
        title: `${FIXTURE_PREFIX}init-mgr-same`,
        agent_user_id: USER_EMPLOYEE_TEAM_A,
    });
    const managerOtherTeamCall = await insertCallRaw(app, ORG_ACME, {
        title: `${FIXTURE_PREFIX}init-mgr-other`,
        agent_user_id: USER_EMPLOYEE_TEAM_B,
    });

    const empOwn = await authedInject(app, empToken, {
        method: "POST",
        url: `/calls/${employeeOwnCall.id}/checklist/initialize`,
    });
    assert.equal(empOwn.statusCode, 200, empOwn.body);
    assert.ok(empOwn.json().items.some((i) => i.template_id === tmpl.id));

    const empOther = await authedInject(app, empToken, {
        method: "POST",
        url: `/calls/${employeeOtherCall.id}/checklist/initialize`,
    });
    assert.equal(empOther.statusCode, 403);

    const mgrSame = await authedInject(app, mgrAToken, {
        method: "POST",
        url: `/calls/${managerSameTeamCall.id}/checklist/initialize`,
    });
    assert.equal(mgrSame.statusCode, 200, mgrSame.body);
    assert.ok(mgrSame.json().items.some((i) => i.template_id === tmpl.id));

    const mgrOther = await authedInject(app, mgrAToken, {
        method: "POST",
        url: `/calls/${managerOtherTeamCall.id}/checklist/initialize`,
    });
    assert.equal(mgrOther.statusCode, 403);

    await app.withOrgContext(ORG_ACME, async (client) => {
        await client.query(
            `DELETE FROM org_call_checklist_templates WHERE id = $1`,
            [tmpl.id],
        );
    });
});

test("mark status: employee on own call → 200; on other agent's call → 403", async () => {
    const adminToken = mintToken(app, "acmeAdmin");
    const empToken = mintToken(app, "acmeEmp");
    const tmpl = await createTemplate(
        adminToken,
        `${FIXTURE_PREFIX}emp-perm`,
        5,
    );

    const ownCall = await insertCallRaw(app, ORG_ACME, {
        title: `${FIXTURE_PREFIX}emp-own-call`,
        agent_user_id: USER_ACME_EMP,
    });
    const otherCall = await insertCallRaw(app, ORG_ACME, {
        title: `${FIXTURE_PREFIX}admin-call`,
        agent_user_id: USER_ACME_ADMIN,
    });

    // Use admin to initialize both (admin can mutate any call).
    const ownInit = await authedInject(app, adminToken, {
        method: "POST",
        url: `/calls/${ownCall.id}/checklist/initialize`,
    });
    const otherInit = await authedInject(app, adminToken, {
        method: "POST",
        url: `/calls/${otherCall.id}/checklist/initialize`,
    });
    assert.equal(ownInit.statusCode, 200);
    assert.equal(otherInit.statusCode, 200);

    const ownItem = ownInit.json().items.find(
        (i) => i.template_id === tmpl.id,
    );
    const otherItem = otherInit.json().items.find(
        (i) => i.template_id === tmpl.id,
    );
    assert.ok(ownItem && otherItem);

    // Employee marks own → 200, done.
    const okResp = await authedInject(app, empToken, {
        method: "POST",
        url: `/call-checklist-items/${ownItem.id}/status`,
        headers: { "content-type": "application/json" },
        payload: { status: "done" },
    });
    assert.equal(okResp.statusCode, 200, okResp.body);
    assert.equal(okResp.json().item.status, "done");
    assert.equal(okResp.json().item.checked_by_user_id, USER_ACME_EMP);

    // Employee marks someone else's → 403.
    const blocked = await authedInject(app, empToken, {
        method: "POST",
        url: `/call-checklist-items/${otherItem.id}/status`,
        headers: { "content-type": "application/json" },
        payload: { status: "done" },
    });
    assert.equal(blocked.statusCode, 403);

    await app.withOrgContext(ORG_ACME, async (client) => {
        await client.query(
            `DELETE FROM org_call_checklist_templates WHERE id = $1`,
            [tmpl.id],
        );
    });
});

test("mark status: manager same-team → 200; other-team → 403", async () => {
    const adminToken = mintToken(app, "acmeAdmin");
    const mgrAToken = mintToken(app, "managerTeamA");
    const tmpl = await createTemplate(
        adminToken,
        `${FIXTURE_PREFIX}mgr-perm`,
        6,
    );

    const sameTeamCall = await insertCallRaw(app, ORG_ACME, {
        title: `${FIXTURE_PREFIX}mgr-same`,
        agent_user_id: USER_EMPLOYEE_TEAM_A,
    });
    const otherTeamCall = await insertCallRaw(app, ORG_ACME, {
        title: `${FIXTURE_PREFIX}mgr-other`,
        agent_user_id: USER_EMPLOYEE_TEAM_B,
    });
    const sameInit = await authedInject(app, adminToken, {
        method: "POST",
        url: `/calls/${sameTeamCall.id}/checklist/initialize`,
    });
    const otherInit = await authedInject(app, adminToken, {
        method: "POST",
        url: `/calls/${otherTeamCall.id}/checklist/initialize`,
    });
    const sameItem = sameInit.json().items.find(
        (i) => i.template_id === tmpl.id,
    );
    const otherItem = otherInit.json().items.find(
        (i) => i.template_id === tmpl.id,
    );

    const ok = await authedInject(app, mgrAToken, {
        method: "POST",
        url: `/call-checklist-items/${sameItem.id}/status`,
        headers: { "content-type": "application/json" },
        payload: { status: "done" },
    });
    assert.equal(ok.statusCode, 200, ok.body);

    const blocked = await authedInject(app, mgrAToken, {
        method: "POST",
        url: `/call-checklist-items/${otherItem.id}/status`,
        headers: { "content-type": "application/json" },
        payload: { status: "done" },
    });
    assert.equal(blocked.statusCode, 403);

    await app.withOrgContext(ORG_ACME, async (client) => {
        await client.query(
            `DELETE FROM org_call_checklist_templates WHERE id = $1`,
            [tmpl.id],
        );
    });
});

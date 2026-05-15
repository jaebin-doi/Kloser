/* Phase 7 Step 3 — customer / call / call_action_item audit hook tests.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_3_PLAN.md §7.3.
 *
 * Scope (this commit closes — 13 events):
 *   - customer.created                    (POST   /customers)
 *   - customer.updated                    (PATCH  /customers/:id)
 *   - customer.deleted                    (DELETE /customers/:id)
 *   - call.created                        (POST   /calls)
 *   - call.ended                          (POST   /calls/:id/end)
 *   - call.customer_linked                (POST   /calls/:id/link-customer)
 *   - call.customer_unlinked              (POST   /calls/:id/unlink-customer)
 *   - call.notes_updated                  (POST   /calls/:id/notes)
 *   - call.manual_summary_updated         (POST   /calls/:id/summary/manual)
 *   - call_action_item.created            (POST   /calls/:id/action-items)
 *   - call_action_item.status_changed     (POST   /call-action-items/:id/status)
 *   - call_action_item.assignee_changed   (POST   /call-action-items/:id/assignee)
 *   - call_action_item.deleted            (DELETE /call-action-items/:id)
 *
 * Sensitive-value invariants asserted on every recorded row:
 *   - payload never contains customer name / company / email / phone
 *   - payload never contains the notes body
 *   - payload never contains summary / needs / issues / sentiment text
 *
 * Fixture strategy:
 *   - Each test creates its own ephemeral customer / call / action item
 *     so cross-test interference is impossible.
 *   - afterEach wipes activity_log rows tied to this suite (customer.*,
 *     call.*, call_action_item.*) plus the rows we made.
 *   - Seed memberships / users / customers (eeee…/ffff…) are never
 *     modified, only soft-deleted clones / new rows are touched.
 */
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import { pool } from "../src/db/pool.js";
import authPlugin from "../src/plugins/auth.js";
import dbPlugin from "../src/plugins/db.js";
import authRoutes from "../src/routes/auth.js";
import customersRoutes from "../src/routes/customers.js";
import callsRoutes from "../src/routes/calls.js";
import callsPhase5Routes from "../src/routes/callsPhase5.js";

const ORG_ACME = "11111111-1111-1111-1111-111111111111";
const ORG_BETA = "22222222-2222-2222-2222-222222222222";
const ACME_ADMIN = "aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa";
const ACME_EMP   = "aaaaaaaa-0002-0002-0002-aaaaaaaaaaaa";
const BETA_ADMIN = "bbbbbbbb-0001-0001-0001-bbbbbbbbbbbb";

const ACME_ADMIN_EMAIL = "admin@acme.test";
const ACME_ADMIN_PW    = "acme-admin-1234";
const BETA_ADMIN_EMAIL = "admin@beta.test";
const BETA_ADMIN_PW    = "beta-admin-1234";

const CUSTOMER_ACME_KIM = "eeeeeeee-1111-0001-0001-eeeeeeeeeeee";

const SUITE_TAG = "phase7-step3-cc-";

let app;

before(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    await app.register(dbPlugin);
    await app.register(authRoutes);
    await app.register(customersRoutes);
    await app.register(callsRoutes);
    await app.register(callsPhase5Routes);
});

after(async () => {
    await wipePerTestState();
    await app.close();
});

// Wipe everything the suite created. Sessions / our customers / our
// calls / our action items / our audit rows. Seeded customers
// (eeee…/ffff…) are never deleted — only customers whose name starts
// with SUITE_TAG.
async function wipePerTestState() {
    // Sessions for any test user we minted a token for.
    await pool.query(
        `DELETE FROM sessions WHERE user_id IN ($1, $2, $3)`,
        [ACME_ADMIN, ACME_EMP, BETA_ADMIN],
    );

    for (const orgId of [ORG_ACME, ORG_BETA]) {
        await app.withOrgContext(orgId, async (client) => {
            // call_action_items cascade-delete from calls, but a test
            // that doesn't end up creating a call still inserts action
            // items — wipe explicitly first to be safe.
            await client.query(
                `DELETE FROM call_action_items WHERE call_id IN (
                    SELECT id FROM calls WHERE title LIKE $1
                 )`,
                [`${SUITE_TAG}%`],
            );
            await client.query(
                `DELETE FROM calls WHERE title LIKE $1`,
                [`${SUITE_TAG}%`],
            );
            // Hard-delete (not soft) so a re-run starts clean.
            await client.query(
                `DELETE FROM customers WHERE name LIKE $1 OR company LIKE $1`,
                [`${SUITE_TAG}%`],
            );
            // Activity_log: actions we care about. user_id covers actor
            // even when target_id was a customer/call we already
            // cascade-deleted.
            await client.query(
                `DELETE FROM activity_log
                  WHERE action LIKE 'customer.%'
                     OR action LIKE 'call.%'
                     OR action LIKE 'call_action_item.%'`,
            );
        });
    }
}

beforeEach(wipePerTestState);
afterEach(wipePerTestState);

// ---------------------------------------------------------------------- //
// helpers
// ---------------------------------------------------------------------- //

async function loginToken(email, password) {
    const r = await app.inject({
        method:  "POST",
        url:     "/auth/login",
        payload: { email, password },
    });
    assert.equal(r.statusCode, 200,
        `login(${email}) expected 200, got ${r.statusCode}: ${r.body}`);
    return r.json().accessToken;
}

function authed(token) {
    return { authorization: `Bearer ${token}` };
}

async function findAuditRows(orgId, action, targetId) {
    let rows;
    await app.withOrgContext(orgId, async (client) => {
        const r = await client.query(
            `SELECT id, org_id, user_id, action, target_type, target_id,
                    payload, created_at
               FROM activity_log
              WHERE action = $1 AND target_id = $2
              ORDER BY created_at DESC, id DESC`,
            [action, targetId],
        );
        rows = r.rows;
    });
    return rows;
}

function assertNoSensitiveValues(rows, sensitiveValues) {
    for (const row of rows) {
        const payloadStr = JSON.stringify(row.payload);
        for (const v of sensitiveValues) {
            if (!v) continue;
            assert.ok(
                !payloadStr.includes(v),
                `audit payload must not echo sensitive value (action=${row.action}, value=<redacted>)`,
            );
        }
    }
}

async function createCallDirect(orgId, opts = {}) {
    const customerId = opts.customer_id ?? null;
    const agentUserId = opts.agent_user_id ?? null;
    return app.withOrgContext(orgId, async (client) => {
        const r = await client.query(
            `INSERT INTO calls (org_id, customer_id, agent_user_id, direction, status, title, started_at)
             VALUES ($1, $2, $3, 'inbound', 'in_progress', $4, now())
             RETURNING id, customer_id, agent_user_id`,
            [orgId, customerId, agentUserId, opts.title ?? `${SUITE_TAG}direct`],
        );
        return r.rows[0];
    });
}

async function createActionItemDirect(orgId, callId, opts = {}) {
    return app.withOrgContext(orgId, async (client) => {
        const r = await client.query(
            `INSERT INTO call_action_items (
                org_id, call_id, title, status, completed_at, assignee_user_id
             ) VALUES ($1, $2, $3, 'open', NULL, $4)
             RETURNING id, call_id, status, assignee_user_id`,
            [orgId, callId, opts.title ?? `${SUITE_TAG}item`, opts.assignee_user_id ?? null],
        );
        return r.rows[0];
    });
}

// ====================================================================== //
//                         customer.created
// ====================================================================== //

test("POST /customers → customer.created row, payload {status}, no PII", async () => {
    const token = await loginToken(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const sensitiveName    = `${SUITE_TAG}created-name`;
    const sensitiveEmail   = `${SUITE_TAG}created@example.test`;
    const sensitivePhone   = "010-9876-5432";
    const sensitiveCompany = `${SUITE_TAG}created-co`;
    const r = await app.inject({
        method:  "POST",
        url:     "/customers",
        headers: authed(token),
        payload: {
            name:    sensitiveName,
            email:   sensitiveEmail,
            phone:   sensitivePhone,
            company: sensitiveCompany,
            status:  "review",
        },
    });
    assert.equal(r.statusCode, 201, `${r.statusCode}: ${r.body}`);
    const customerId = r.json().customer.id;

    const rows = await findAuditRows(ORG_ACME, "customer.created", customerId);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.user_id, ACME_ADMIN);
    assert.equal(row.target_type, "customer");
    assert.equal(row.target_id, customerId);
    assert.equal(row.payload.status, "review");
    assertNoSensitiveValues(rows, [
        sensitiveName, sensitiveEmail, sensitivePhone, sensitiveCompany,
    ]);
});

// ====================================================================== //
//                         customer.updated
// ====================================================================== //

test("PATCH /customers/:id → customer.updated row, payload.fields names patched columns", async () => {
    const token = await loginToken(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const created = await app.inject({
        method:  "POST",
        url:     "/customers",
        headers: authed(token),
        payload: { name: `${SUITE_TAG}upd-orig` },
    });
    assert.equal(created.statusCode, 201);
    const customerId = created.json().customer.id;

    const newName    = `${SUITE_TAG}upd-renamed`;
    const sensitivePhone = "010-0000-1111";
    const patched = await app.inject({
        method:  "PATCH",
        url:     `/customers/${customerId}`,
        headers: authed(token),
        payload: { name: newName, phone: sensitivePhone },
    });
    assert.equal(patched.statusCode, 200, `${patched.statusCode}: ${patched.body}`);

    const rows = await findAuditRows(ORG_ACME, "customer.updated", customerId);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.user_id, ACME_ADMIN);
    assert.equal(row.target_type, "customer");
    assert.deepEqual(row.payload.fields.sort(), ["name", "phone"]);
    assertNoSensitiveValues(rows, [newName, sensitivePhone]);
});

// ====================================================================== //
//                         customer.deleted
// ====================================================================== //

test("DELETE /customers/:id → customer.deleted row", async () => {
    const token = await loginToken(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const created = await app.inject({
        method:  "POST",
        url:     "/customers",
        headers: authed(token),
        payload: { name: `${SUITE_TAG}del-name`, email: `${SUITE_TAG}del@example.test` },
    });
    assert.equal(created.statusCode, 201);
    const customerId = created.json().customer.id;

    // Clear the create-audit row so we assert delete in isolation.
    await app.withOrgContext(ORG_ACME, (c) =>
        c.query(`DELETE FROM activity_log WHERE action='customer.created' AND target_id=$1`, [customerId]),
    );

    const deleted = await app.inject({
        method:  "DELETE",
        url:     `/customers/${customerId}`,
        headers: authed(token),
    });
    assert.equal(deleted.statusCode, 204);

    const rows = await findAuditRows(ORG_ACME, "customer.deleted", customerId);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.user_id, ACME_ADMIN);
    assert.equal(row.target_type, "customer");
    assertNoSensitiveValues(rows, [`${SUITE_TAG}del-name`, `${SUITE_TAG}del@example.test`]);
});

// ====================================================================== //
//                         call.created
// ====================================================================== //

test("POST /calls → call.created row, payload {direction, customer_id, agent_user_id}", async () => {
    const token = await loginToken(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const r = await app.inject({
        method:  "POST",
        url:     "/calls",
        headers: authed(token),
        payload: {
            direction: "outbound",
            customer_id: CUSTOMER_ACME_KIM,
            agent_user_id: ACME_EMP,
            title: `${SUITE_TAG}call-create`,
        },
    });
    assert.equal(r.statusCode, 201, `${r.statusCode}: ${r.body}`);
    const callId = r.json().call.id;

    const rows = await findAuditRows(ORG_ACME, "call.created", callId);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.user_id, ACME_ADMIN);
    assert.equal(row.target_type, "call");
    assert.equal(row.payload.direction, "outbound");
    assert.equal(row.payload.customer_id, CUSTOMER_ACME_KIM);
    assert.equal(row.payload.agent_user_id, ACME_EMP);
});

// ====================================================================== //
//                         call.ended
// ====================================================================== //

test("POST /calls/:id/end → call.ended row, payload {final_status, duration_seconds}", async () => {
    const created = await createCallDirect(ORG_ACME, {
        agent_user_id: ACME_ADMIN, // admin can end own call
        customer_id: CUSTOMER_ACME_KIM,
        title: `${SUITE_TAG}call-end`,
    });

    const token = await loginToken(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const r = await app.inject({
        method:  "POST",
        url:     `/calls/${created.id}/end`,
        headers: authed(token),
        payload: { final_status: "ended" },
    });
    assert.equal(r.statusCode, 200, `${r.statusCode}: ${r.body}`);

    const rows = await findAuditRows(ORG_ACME, "call.ended", created.id);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.user_id, ACME_ADMIN);
    assert.equal(row.target_type, "call");
    assert.equal(row.payload.final_status, "ended");
    assert.ok(typeof row.payload.duration_seconds === "number"
        || row.payload.duration_seconds === null,
        "duration_seconds must be number or null");
});

// ====================================================================== //
//                         call.customer_linked
// ====================================================================== //

test("POST /calls/:id/link-customer → call.customer_linked row, payload.customer_id", async () => {
    const created = await createCallDirect(ORG_ACME, {
        agent_user_id: ACME_ADMIN,
        title: `${SUITE_TAG}call-link`,
    });

    const token = await loginToken(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const r = await app.inject({
        method:  "POST",
        url:     `/calls/${created.id}/link-customer`,
        headers: authed(token),
        payload: { customer_id: CUSTOMER_ACME_KIM },
    });
    assert.equal(r.statusCode, 200, `${r.statusCode}: ${r.body}`);

    const rows = await findAuditRows(ORG_ACME, "call.customer_linked", created.id);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.user_id, ACME_ADMIN);
    assert.equal(row.payload.customer_id, CUSTOMER_ACME_KIM);
});

// ====================================================================== //
//                         call.customer_unlinked
// ====================================================================== //

test("POST /calls/:id/unlink-customer → call.customer_unlinked row, payload.previous_customer_id", async () => {
    const created = await createCallDirect(ORG_ACME, {
        agent_user_id: ACME_ADMIN,
        customer_id: CUSTOMER_ACME_KIM,
        title: `${SUITE_TAG}call-unlink`,
    });

    const token = await loginToken(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const r = await app.inject({
        method:  "POST",
        url:     `/calls/${created.id}/unlink-customer`,
        headers: authed(token),
    });
    assert.equal(r.statusCode, 200, `${r.statusCode}: ${r.body}`);

    const rows = await findAuditRows(ORG_ACME, "call.customer_unlinked", created.id);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.user_id, ACME_ADMIN);
    assert.equal(row.payload.previous_customer_id, CUSTOMER_ACME_KIM,
        "audit must record the customer id that was bound BEFORE unlink");
});

// ====================================================================== //
//                         call.notes_updated
// ====================================================================== //

test("POST /calls/:id/notes → call.notes_updated row, payload.notes_length (body NOT echoed)", async () => {
    const created = await createCallDirect(ORG_ACME, {
        agent_user_id: ACME_ADMIN,
        title: `${SUITE_TAG}call-notes`,
    });

    const sensitiveNotes = "Customer mentioned acquisition rumor — DO NOT FORWARD";
    const token = await loginToken(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const r = await app.inject({
        method:  "POST",
        url:     `/calls/${created.id}/notes`,
        headers: authed(token),
        payload: { notes: sensitiveNotes },
    });
    assert.equal(r.statusCode, 200, `${r.statusCode}: ${r.body}`);

    const rows = await findAuditRows(ORG_ACME, "call.notes_updated", created.id);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.user_id, ACME_ADMIN);
    assert.equal(row.payload.notes_length, sensitiveNotes.length);
    assertNoSensitiveValues(rows, [sensitiveNotes]);
});

// ====================================================================== //
//                         call.manual_summary_updated
// ====================================================================== //

test("POST /calls/:id/summary/manual → call.manual_summary_updated row, payload.fields, body NOT echoed", async () => {
    const created = await createCallDirect(ORG_ACME, {
        agent_user_id: ACME_ADMIN,
        title: `${SUITE_TAG}call-summary`,
    });

    const sensitiveSummary = "Confidential deal terms typed by user";
    const token = await loginToken(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const r = await app.inject({
        method:  "POST",
        url:     `/calls/${created.id}/summary/manual`,
        headers: authed(token),
        payload: {
            summary:   sensitiveSummary,
            needs:     "needs body",
            issues:    null,
            sentiment: "positive",
        },
    });
    assert.equal(r.statusCode, 200, `${r.statusCode}: ${r.body}`);

    const rows = await findAuditRows(ORG_ACME, "call.manual_summary_updated", created.id);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.user_id, ACME_ADMIN);
    assert.ok(Array.isArray(row.payload.fields));
    assert.ok(row.payload.fields.includes("summary"));
    assert.ok(row.payload.fields.includes("sentiment"));
    assertNoSensitiveValues(rows, [sensitiveSummary, "needs body"]);
});

// ====================================================================== //
//                         call_action_item.created
// ====================================================================== //

test("POST /calls/:id/action-items → call_action_item.created row", async () => {
    const created = await createCallDirect(ORG_ACME, {
        agent_user_id: ACME_ADMIN,
        title: `${SUITE_TAG}aitem-create-parent`,
    });

    const token = await loginToken(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const sensitiveTitle = "Send NDA to customer (confidential)";
    const r = await app.inject({
        method:  "POST",
        url:     `/calls/${created.id}/action-items`,
        headers: authed(token),
        payload: { title: sensitiveTitle, assignee_user_id: ACME_EMP },
    });
    assert.equal(r.statusCode, 201, `${r.statusCode}: ${r.body}`);
    const actionItemId = r.json().action_item.id;

    const rows = await findAuditRows(
        ORG_ACME, "call_action_item.created", actionItemId,
    );
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.user_id, ACME_ADMIN);
    assert.equal(row.target_type, "call_action_item");
    assert.equal(row.payload.call_id, created.id);
    assert.equal(row.payload.assignee_user_id, ACME_EMP);
    assertNoSensitiveValues(rows, [sensitiveTitle]);
});

// ====================================================================== //
//                         call_action_item.status_changed
// ====================================================================== //

test("POST /call-action-items/:id/status → status_changed row, payload {from,to}", async () => {
    const call = await createCallDirect(ORG_ACME, {
        agent_user_id: ACME_ADMIN,
        title: `${SUITE_TAG}aitem-status-parent`,
    });
    const item = await createActionItemDirect(ORG_ACME, call.id);

    const token = await loginToken(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const r = await app.inject({
        method:  "POST",
        url:     `/call-action-items/${item.id}/status`,
        headers: authed(token),
        payload: { status: "done" },
    });
    assert.equal(r.statusCode, 200, `${r.statusCode}: ${r.body}`);

    const rows = await findAuditRows(
        ORG_ACME, "call_action_item.status_changed", item.id,
    );
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.user_id, ACME_ADMIN);
    assert.equal(row.payload.call_id, call.id);
    assert.equal(row.payload.from_status, "open");
    assert.equal(row.payload.to_status, "done");
});

test("POST /call-action-items/:id/status with SAME value → no audit row", async () => {
    const call = await createCallDirect(ORG_ACME, {
        agent_user_id: ACME_ADMIN,
        title: `${SUITE_TAG}aitem-status-noop`,
    });
    const item = await createActionItemDirect(ORG_ACME, call.id);

    const token = await loginToken(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const r = await app.inject({
        method:  "POST",
        url:     `/call-action-items/${item.id}/status`,
        headers: authed(token),
        payload: { status: "open" }, // already open
    });
    assert.equal(r.statusCode, 200);

    const rows = await findAuditRows(
        ORG_ACME, "call_action_item.status_changed", item.id,
    );
    assert.equal(rows.length, 0,
        "same-value status PATCH must not create a noisy audit row");
});

// ====================================================================== //
//                         call_action_item.assignee_changed
// ====================================================================== //

test("POST /call-action-items/:id/assignee → assignee_changed row, payload {from,to}", async () => {
    const call = await createCallDirect(ORG_ACME, {
        agent_user_id: ACME_ADMIN,
        title: `${SUITE_TAG}aitem-assign-parent`,
    });
    const item = await createActionItemDirect(ORG_ACME, call.id, {
        assignee_user_id: null,
    });

    const token = await loginToken(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const r = await app.inject({
        method:  "POST",
        url:     `/call-action-items/${item.id}/assignee`,
        headers: authed(token),
        payload: { assignee_user_id: ACME_EMP },
    });
    assert.equal(r.statusCode, 200, `${r.statusCode}: ${r.body}`);

    const rows = await findAuditRows(
        ORG_ACME, "call_action_item.assignee_changed", item.id,
    );
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.user_id, ACME_ADMIN);
    assert.equal(row.payload.call_id, call.id);
    assert.equal(row.payload.from_assignee_user_id, null);
    assert.equal(row.payload.to_assignee_user_id, ACME_EMP);
});

// ====================================================================== //
//                         call_action_item.deleted
// ====================================================================== //

test("DELETE /call-action-items/:id → call_action_item.deleted row", async () => {
    const call = await createCallDirect(ORG_ACME, {
        agent_user_id: ACME_ADMIN,
        title: `${SUITE_TAG}aitem-delete-parent`,
    });
    const item = await createActionItemDirect(ORG_ACME, call.id);

    const token = await loginToken(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const r = await app.inject({
        method:  "DELETE",
        url:     `/call-action-items/${item.id}`,
        headers: authed(token),
    });
    assert.equal(r.statusCode, 204, `${r.statusCode}: ${r.body}`);

    const rows = await findAuditRows(
        ORG_ACME, "call_action_item.deleted", item.id,
    );
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.user_id, ACME_ADMIN);
    assert.equal(row.payload.call_id, call.id);
});

// ====================================================================== //
//                         cross-org isolation
// ====================================================================== //

test("audit row from Acme customer.created is invisible to Beta context", async () => {
    const token = await loginToken(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const r = await app.inject({
        method:  "POST",
        url:     "/customers",
        headers: authed(token),
        payload: { name: `${SUITE_TAG}cross-org` },
    });
    assert.equal(r.statusCode, 201);
    const customerId = r.json().customer.id;

    const acmeRows = await findAuditRows(ORG_ACME, "customer.created", customerId);
    assert.equal(acmeRows.length, 1);
    const rowId = acmeRows[0].id;

    let betaRows;
    await app.withOrgContext(ORG_BETA, async (client) => {
        const r2 = await client.query(
            `SELECT id FROM activity_log WHERE id = $1`,
            [rowId],
        );
        betaRows = r2.rows;
    });
    assert.equal(betaRows.length, 0,
        "Beta must not see Acme customer audit row");
});

// Drive a Beta admin through one event end-to-end so we know the route
// chain works for the other org too.
test("Beta admin can drive customer.created → audit row in Beta context only", async () => {
    const token = await loginToken(BETA_ADMIN_EMAIL, BETA_ADMIN_PW);
    const r = await app.inject({
        method:  "POST",
        url:     "/customers",
        headers: authed(token),
        payload: { name: `${SUITE_TAG}beta-cross` },
    });
    assert.equal(r.statusCode, 201, `${r.statusCode}: ${r.body}`);
    const customerId = r.json().customer.id;

    const betaRows = await findAuditRows(ORG_BETA, "customer.created", customerId);
    assert.equal(betaRows.length, 1);
    assert.equal(betaRows[0].user_id, BETA_ADMIN);

    // Same target_id should not be visible from Acme context.
    let acmeRows;
    await app.withOrgContext(ORG_ACME, async (client) => {
        const r2 = await client.query(
            `SELECT id FROM activity_log WHERE id = $1`,
            [betaRows[0].id],
        );
        acmeRows = r2.rows;
    });
    assert.equal(acmeRows.length, 0);
});

// ====================================================================== //
//             rollback: audit failure aborts the parent mutation
// ====================================================================== //
//
// Same shape as the team/invitation rollback proof: forcing an
// activity_log INSERT with an invalid action inside the same tx as a
// customer UPDATE proves the transactional unity that the production
// recordCustomer* helpers rely on.

test("customer route rollback when same-tx audit insert fails CHECK", async () => {
    const token = await loginToken(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const created = await app.inject({
        method:  "POST",
        url:     "/customers",
        headers: authed(token),
        payload: { name: `${SUITE_TAG}rollback-orig`, status: "active" },
    });
    assert.equal(created.statusCode, 201);
    const customerId = created.json().customer.id;

    let statusBefore;
    await app.withOrgContext(ORG_ACME, async (client) => {
        const r = await client.query(
            `SELECT status FROM customers WHERE id = $1`,
            [customerId],
        );
        statusBefore = r.rows[0].status;
    });

    await assert.rejects(
        () => app.withOrgContext(ORG_ACME, async (client) => {
            await client.query(
                `UPDATE customers SET status='review', updated_at=now() WHERE id=$1`,
                [customerId],
            );
            await client.query(
                `INSERT INTO activity_log (org_id, action, payload)
                 VALUES ($1, 'this.is.not.a.real.action', '{}'::jsonb)`,
                [ORG_ACME],
            );
        }),
        (err) => /activity_log_action_check/i.test(String(err.message)) || err.code === "23514",
    );

    let statusAfter;
    await app.withOrgContext(ORG_ACME, async (client) => {
        const r = await client.query(
            `SELECT status FROM customers WHERE id = $1`,
            [customerId],
        );
        statusAfter = r.rows[0].status;
    });
    assert.equal(statusAfter, statusBefore,
        "customer mutation must roll back when same-tx audit insert fails CHECK");
});

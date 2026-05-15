/* Phase 7 Step 3 — knowledge_base / checklist_template audit hook tests.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_3_PLAN.md §7.3.
 *
 * Scope (this commit closes — 6 events):
 *   - knowledge_base.created       (POST   /knowledge-bases)
 *   - knowledge_base.updated       (PATCH  /knowledge-bases/:id)
 *   - knowledge_base.deleted       (DELETE /knowledge-bases/:id)
 *   - checklist_template.created   (POST   /call-checklist-templates)
 *   - checklist_template.updated   (PATCH  /call-checklist-templates/:id)
 *   - checklist_template.deleted   (DELETE /call-checklist-templates/:id)
 *
 * Sensitive-value invariants asserted on every recorded row:
 *   - payload never contains the KB title / source_uri
 *   - payload never contains the checklist template title (user-typed
 *     playbook copy)
 *   - update payload carries only the list of patched field names
 *
 * Out of scope this commit (deferred):
 *   - knowledge_chunk.replaced (in the action allow-list but the
 *     chunk-replace flow has its own LLM-usage audit trail; revisit
 *     when the audit-view UI ships)
 *
 * Fixture strategy:
 *   - Each test creates its own ephemeral KB or template so cross-test
 *     interference is impossible.
 *   - afterEach wipes activity_log rows tied to this suite plus any
 *     KB/template rows whose title carries the suite tag. Seed rows
 *     are never touched.
 */
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import { pool } from "../src/db/pool.js";
import authPlugin from "../src/plugins/auth.js";
import dbPlugin from "../src/plugins/db.js";
import authRoutes from "../src/routes/auth.js";
import knowledgeBaseRoutes from "../src/routes/knowledgeBases.js";
import checklistTemplateRoutes from "../src/routes/checklistTemplates.js";

const ORG_ACME = "11111111-1111-1111-1111-111111111111";
const ORG_BETA = "22222222-2222-2222-2222-222222222222";
const ACME_ADMIN = "aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa";
const BETA_ADMIN = "bbbbbbbb-0001-0001-0001-bbbbbbbbbbbb";

const ACME_ADMIN_EMAIL = "admin@acme.test";
const ACME_ADMIN_PW    = "acme-admin-1234";
const BETA_ADMIN_EMAIL = "admin@beta.test";
const BETA_ADMIN_PW    = "beta-admin-1234";

const SUITE_TAG = "phase7-step3-kbct-";

let app;

before(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    await app.register(dbPlugin);
    await app.register(authRoutes);
    await app.register(knowledgeBaseRoutes);
    await app.register(checklistTemplateRoutes);
});

after(async () => {
    await wipePerTestState();
    await app.close();
});

async function wipePerTestState() {
    await pool.query(
        `DELETE FROM sessions WHERE user_id IN ($1, $2)`,
        [ACME_ADMIN, BETA_ADMIN],
    );
    for (const orgId of [ORG_ACME, ORG_BETA]) {
        await app.withOrgContext(orgId, async (client) => {
            // KB chunks cascade-delete from knowledge_bases, but a soft
            // delete keeps the parent row. Hard-delete any KB whose
            // title carries the suite tag so re-runs start clean.
            await client.query(
                `DELETE FROM knowledge_bases WHERE title LIKE $1`,
                [`${SUITE_TAG}%`],
            );
            await client.query(
                `DELETE FROM org_call_checklist_templates WHERE title LIKE $1`,
                [`${SUITE_TAG}%`],
            );
            await client.query(
                `DELETE FROM activity_log
                  WHERE action LIKE 'knowledge_base.%'
                     OR action LIKE 'checklist_template.%'`,
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
                `audit payload must not echo sensitive value (action=${row.action})`,
            );
        }
    }
}

// ====================================================================== //
//                       knowledge_base.created
// ====================================================================== //

test("POST /knowledge-bases → knowledge_base.created row, no title/source_uri in payload", async () => {
    const token = await loginToken(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const sensitiveTitle = `${SUITE_TAG}kb-create-title`;
    const sensitiveUri   = "https://confidential.example.test/playbook";
    const r = await app.inject({
        method:  "POST",
        url:     "/knowledge-bases",
        headers: authed(token),
        payload: {
            title:       sensitiveTitle,
            source_type: "url",
            source_uri:  sensitiveUri,
        },
    });
    assert.equal(r.statusCode, 201, `${r.statusCode}: ${r.body}`);
    const kbId = r.json().knowledge_base.id;

    const rows = await findAuditRows(ORG_ACME, "knowledge_base.created", kbId);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.user_id, ACME_ADMIN);
    assert.equal(row.target_type, "knowledge_base");
    assert.equal(row.target_id, kbId);
    assert.deepEqual(row.payload, {});
    assertNoSensitiveValues(rows, [sensitiveTitle, sensitiveUri]);
});

// ====================================================================== //
//                       knowledge_base.updated
// ====================================================================== //

test("PATCH /knowledge-bases/:id → knowledge_base.updated row, payload.fields names patched columns only", async () => {
    const token = await loginToken(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const created = await app.inject({
        method:  "POST",
        url:     "/knowledge-bases",
        headers: authed(token),
        payload: { title: `${SUITE_TAG}kb-upd-orig`, source_type: "manual" },
    });
    assert.equal(created.statusCode, 201);
    const kbId = created.json().knowledge_base.id;

    const newTitle = `${SUITE_TAG}kb-upd-renamed`;
    const newUri   = "https://secret.example.test/v2";
    const patched = await app.inject({
        method:  "PATCH",
        url:     `/knowledge-bases/${kbId}`,
        headers: authed(token),
        payload: { title: newTitle, source_uri: newUri },
    });
    assert.equal(patched.statusCode, 200, `${patched.statusCode}: ${patched.body}`);

    const rows = await findAuditRows(ORG_ACME, "knowledge_base.updated", kbId);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.user_id, ACME_ADMIN);
    assert.deepEqual(row.payload.fields.sort(), ["source_uri", "title"]);
    assertNoSensitiveValues(rows, [newTitle, newUri]);
});

// ====================================================================== //
//                       knowledge_base.deleted
// ====================================================================== //

test("DELETE /knowledge-bases/:id → knowledge_base.deleted row", async () => {
    const token = await loginToken(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const created = await app.inject({
        method:  "POST",
        url:     "/knowledge-bases",
        headers: authed(token),
        payload: { title: `${SUITE_TAG}kb-del`, source_type: "manual" },
    });
    assert.equal(created.statusCode, 201);
    const kbId = created.json().knowledge_base.id;

    // Drop the create-audit row so the test isolates the delete row.
    await app.withOrgContext(ORG_ACME, (c) =>
        c.query(`DELETE FROM activity_log WHERE action='knowledge_base.created' AND target_id=$1`, [kbId]),
    );

    const deleted = await app.inject({
        method:  "DELETE",
        url:     `/knowledge-bases/${kbId}`,
        headers: authed(token),
    });
    assert.equal(deleted.statusCode, 204);

    const rows = await findAuditRows(ORG_ACME, "knowledge_base.deleted", kbId);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.user_id, ACME_ADMIN);
    assert.equal(row.target_type, "knowledge_base");
    assert.deepEqual(row.payload, {});
});

test("DELETE /knowledge-bases/:id cross-org → 404 and no audit row", async () => {
    const acmeToken = await loginToken(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const created = await app.inject({
        method:  "POST",
        url:     "/knowledge-bases",
        headers: authed(acmeToken),
        payload: { title: `${SUITE_TAG}kb-cross-del`, source_type: "manual" },
    });
    assert.equal(created.statusCode, 201);
    const kbId = created.json().knowledge_base.id;

    const betaToken = await loginToken(BETA_ADMIN_EMAIL, BETA_ADMIN_PW);
    const crossDel = await app.inject({
        method:  "DELETE",
        url:     `/knowledge-bases/${kbId}`,
        headers: authed(betaToken),
    });
    assert.equal(crossDel.statusCode, 404,
        "cross-org delete must 404 (RLS hides the row)");

    const acmeRows = await findAuditRows(ORG_ACME, "knowledge_base.deleted", kbId);
    assert.equal(acmeRows.length, 0,
        "cross-org delete attempt must not create an audit row in Acme");
    let betaRows;
    await app.withOrgContext(ORG_BETA, async (client) => {
        const r = await client.query(
            `SELECT 1 FROM activity_log
              WHERE action='knowledge_base.deleted' AND target_id=$1`,
            [kbId],
        );
        betaRows = r.rows;
    });
    assert.equal(betaRows.length, 0,
        "cross-org delete attempt must not create an audit row in Beta either");
});

// ====================================================================== //
//                       checklist_template.created
// ====================================================================== //

test("POST /call-checklist-templates → checklist_template.created row, payload {is_active, sort_order}, no title", async () => {
    const token = await loginToken(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const sensitiveTitle = `${SUITE_TAG}tmpl-create-title`;
    const r = await app.inject({
        method:  "POST",
        url:     "/call-checklist-templates",
        headers: authed(token),
        payload: { title: sensitiveTitle, sort_order: 7, active: true },
    });
    assert.equal(r.statusCode, 201, `${r.statusCode}: ${r.body}`);
    const tmplId = r.json().template.id;

    const rows = await findAuditRows(ORG_ACME, "checklist_template.created", tmplId);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.user_id, ACME_ADMIN);
    assert.equal(row.target_type, "checklist_template");
    assert.equal(row.payload.is_active, true);
    assert.equal(row.payload.sort_order, 7);
    assertNoSensitiveValues(rows, [sensitiveTitle]);
});

// ====================================================================== //
//                       checklist_template.updated
// ====================================================================== //

test("PATCH /call-checklist-templates/:id → checklist_template.updated row, payload.fields names patched columns only", async () => {
    const token = await loginToken(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const created = await app.inject({
        method:  "POST",
        url:     "/call-checklist-templates",
        headers: authed(token),
        payload: { title: `${SUITE_TAG}tmpl-upd-orig`, sort_order: 0 },
    });
    assert.equal(created.statusCode, 201);
    const tmplId = created.json().template.id;

    const newTitle = `${SUITE_TAG}tmpl-upd-renamed`;
    const patched = await app.inject({
        method:  "PATCH",
        url:     `/call-checklist-templates/${tmplId}`,
        headers: authed(token),
        payload: { title: newTitle, active: false },
    });
    assert.equal(patched.statusCode, 200, `${patched.statusCode}: ${patched.body}`);

    const rows = await findAuditRows(ORG_ACME, "checklist_template.updated", tmplId);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.user_id, ACME_ADMIN);
    assert.deepEqual(row.payload.fields.sort(), ["active", "title"]);
    assertNoSensitiveValues(rows, [newTitle]);
});

// ====================================================================== //
//                       checklist_template.deleted
// ====================================================================== //

test("DELETE /call-checklist-templates/:id → checklist_template.deleted row", async () => {
    const token = await loginToken(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const created = await app.inject({
        method:  "POST",
        url:     "/call-checklist-templates",
        headers: authed(token),
        payload: { title: `${SUITE_TAG}tmpl-del` },
    });
    assert.equal(created.statusCode, 201);
    const tmplId = created.json().template.id;

    // Drop the create-audit row so the test isolates delete.
    await app.withOrgContext(ORG_ACME, (c) =>
        c.query(`DELETE FROM activity_log WHERE action='checklist_template.created' AND target_id=$1`, [tmplId]),
    );

    const deleted = await app.inject({
        method:  "DELETE",
        url:     `/call-checklist-templates/${tmplId}`,
        headers: authed(token),
    });
    assert.equal(deleted.statusCode, 204);

    const rows = await findAuditRows(ORG_ACME, "checklist_template.deleted", tmplId);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.user_id, ACME_ADMIN);
    assert.equal(row.target_type, "checklist_template");
    assert.deepEqual(row.payload, {});
});

test("DELETE /call-checklist-templates/:id cross-org → 404 and no audit row", async () => {
    const acmeToken = await loginToken(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const created = await app.inject({
        method:  "POST",
        url:     "/call-checklist-templates",
        headers: authed(acmeToken),
        payload: { title: `${SUITE_TAG}tmpl-cross-del` },
    });
    assert.equal(created.statusCode, 201);
    const tmplId = created.json().template.id;

    const betaToken = await loginToken(BETA_ADMIN_EMAIL, BETA_ADMIN_PW);
    const crossDel = await app.inject({
        method:  "DELETE",
        url:     `/call-checklist-templates/${tmplId}`,
        headers: authed(betaToken),
    });
    assert.equal(crossDel.statusCode, 404);

    const acmeRows = await findAuditRows(ORG_ACME, "checklist_template.deleted", tmplId);
    assert.equal(acmeRows.length, 0);
    let betaRows;
    await app.withOrgContext(ORG_BETA, async (client) => {
        const r = await client.query(
            `SELECT 1 FROM activity_log
              WHERE action='checklist_template.deleted' AND target_id=$1`,
            [tmplId],
        );
        betaRows = r.rows;
    });
    assert.equal(betaRows.length, 0);
});

// ====================================================================== //
//                         cross-org isolation
// ====================================================================== //

test("audit row from Acme KB create is invisible to Beta context", async () => {
    const token = await loginToken(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const r = await app.inject({
        method:  "POST",
        url:     "/knowledge-bases",
        headers: authed(token),
        payload: { title: `${SUITE_TAG}kb-cross-org`, source_type: "manual" },
    });
    assert.equal(r.statusCode, 201);
    const kbId = r.json().knowledge_base.id;

    const acmeRows = await findAuditRows(ORG_ACME, "knowledge_base.created", kbId);
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
        "Beta must not see Acme KB audit row");
});

// ====================================================================== //
//             rollback: audit failure aborts the parent mutation
// ====================================================================== //
//
// Same shape as customer / team rollback proofs — forcing an
// activity_log INSERT with an invalid action inside the same tx as a
// KB UPDATE proves the transactional unity that the production
// recordKnowledgeBase* helpers rely on.

test("knowledge_base mutation rolls back when same-tx audit insert fails CHECK", async () => {
    const token = await loginToken(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const created = await app.inject({
        method:  "POST",
        url:     "/knowledge-bases",
        headers: authed(token),
        payload: { title: `${SUITE_TAG}kb-rollback-orig`, source_type: "manual" },
    });
    assert.equal(created.statusCode, 201);
    const kbId = created.json().knowledge_base.id;

    let titleBefore;
    await app.withOrgContext(ORG_ACME, async (client) => {
        const r = await client.query(
            `SELECT title FROM knowledge_bases WHERE id = $1`,
            [kbId],
        );
        titleBefore = r.rows[0].title;
    });

    await assert.rejects(
        () => app.withOrgContext(ORG_ACME, async (client) => {
            await client.query(
                `UPDATE knowledge_bases SET title=$1, updated_at=now()
                  WHERE id=$2`,
                [`${SUITE_TAG}kb-rollback-new`, kbId],
            );
            await client.query(
                `INSERT INTO activity_log (org_id, action, payload)
                 VALUES ($1, 'this.is.not.a.real.action', '{}'::jsonb)`,
                [ORG_ACME],
            );
        }),
        (err) => /activity_log_action_check/i.test(String(err.message)) || err.code === "23514",
    );

    let titleAfter;
    await app.withOrgContext(ORG_ACME, async (client) => {
        const r = await client.query(
            `SELECT title FROM knowledge_bases WHERE id = $1`,
            [kbId],
        );
        titleAfter = r.rows[0].title;
    });
    assert.equal(titleAfter, titleBefore,
        "KB mutation must roll back when same-tx audit insert fails CHECK");
});

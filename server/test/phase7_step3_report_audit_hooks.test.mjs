/* Phase 7 Step 3 + Step 7 — report.team_viewed best-effort audit hook tests.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_3_PLAN.md §7.4 (initial);
 *       docs/plan/phase-7/PHASE_7_STEP_7_PLAN.md §4.5 (payload extension).
 *
 * Scope (this commit closes — 1 event):
 *   - report.team_viewed   (GET /reports/team-summary)
 *
 * Best-effort property:
 *   The team report is a read endpoint. Audit failure (sanitizer reject /
 *   DB constraint / RLS) must NOT surface a 500 to the user. The wired
 *   helper goes through `tryRecordActivity`, which wraps the INSERT in a
 *   SAVEPOINT so a localized failure does not poison the outer
 *   transaction. The library-level proof of SAVEPOINT semantics lives in
 *   `phase7_step3_activity_log_service.test.mjs`; this suite asserts the
 *   route-level contract end-to-end.
 *
 * Sensitive-value invariants asserted on every recorded row:
 *   - payload never contains customer name / agent name / team name /
 *     call title / sentiment / call ids — only operational scope + the
 *     resolved date window
 *   - Step 7 extends the allow-listed payload key set from
 *       ['scope','team_id']
 *     to
 *       ['scope','team_id','from','to','window_days']
 *     and the assertions below pin the exact set so future fields cannot
 *     accidentally leak result data into the audit feed.
 */
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import { pool } from "../src/db/pool.js";
import authPlugin from "../src/plugins/auth.js";
import dbPlugin from "../src/plugins/db.js";
import authRoutes from "../src/routes/auth.js";
import reportsRoutes from "../src/routes/reports.js";
import { tryRecordActivity } from "../src/services/activityLog.js";
import {
    ORG_ACME,
    ORG_BETA,
    USER_ACME_ADMIN,
    USER_BETA_ADMIN,
    USER_MANAGER_TEAM_A,
    USER_EMPLOYEE_TEAM_A,
    TEAM_A_ID,
    createFixtureUsers,
    destroyFixtureUsers,
    mintToken,
    authedInject,
    insertCallRaw,
    FIXTURE_PREFIX,
} from "./_phase5Fixture.mjs";

const SUITE_TAG = `${FIXTURE_PREFIX}reportaudit-`;

let app;

before(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    await app.register(dbPlugin);
    await app.register(authRoutes);
    await app.register(reportsRoutes);
    await createFixtureUsers(app);
});

after(async () => {
    if (app) {
        await wipeSuiteState();
        await destroyFixtureUsers(app);
        await app.pg.query(`DELETE FROM sessions`);
        await app.close();
    }
});

beforeEach(wipeSuiteState);

afterEach(async () => {
    await wipeSuiteState();
    await app.pg.query(`DELETE FROM sessions`);
});

async function wipeSuiteState() {
    for (const orgId of [ORG_ACME, ORG_BETA]) {
        await app.withOrgContext(orgId, async (client) => {
            await client.query(
                `DELETE FROM calls WHERE title LIKE $1`,
                [`${SUITE_TAG}%`],
            );
            await client.query(
                `DELETE FROM activity_log WHERE action = 'report.team_viewed'`,
            );
        });
    }
}

// ---------------------------------------------------------------------- //
// helpers
// ---------------------------------------------------------------------- //

async function findAuditRows(orgId, userId) {
    let rows;
    await app.withOrgContext(orgId, async (client) => {
        const r = await client.query(
            `SELECT id, org_id, user_id, action, target_type, target_id,
                    payload, created_at
               FROM activity_log
              WHERE action = 'report.team_viewed' AND user_id = $1
              ORDER BY created_at DESC, id DESC`,
            [userId],
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

async function inject(token, query = "") {
    return authedInject(app, token, {
        method: "GET",
        url: `/reports/team-summary${query}`,
    });
}

// ====================================================================== //
//                        admin → org-wide
// ====================================================================== //

test("GET /reports/team-summary (admin, no team_id) → report.team_viewed scope=org", async () => {
    const token = mintToken(app, "acmeAdmin");
    const r = await inject(token);
    assert.equal(r.statusCode, 200, `${r.statusCode}: ${r.body}`);
    const body = r.json();
    assert.equal(body.scope, "org");

    const rows = await findAuditRows(ORG_ACME, USER_ACME_ADMIN);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.user_id, USER_ACME_ADMIN);
    assert.equal(row.target_type, "report");
    assert.equal(row.target_id, null,
        "report target_id must stay null — the view has no row id");
    assert.equal(row.payload.scope, "org");
    assert.equal(row.payload.team_id, null);
    // Step 7 — default window is the most recent 30 calendar days, so
    // window_days is 30 and from/to are valid YYYY-MM-DD strings. We
    // don't pin specific dates because the test runs at variable wall
    // clock times; the shape and the day count are what matter.
    assert.equal(row.payload.window_days, 30);
    assert.match(row.payload.from, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(row.payload.to, /^\d{4}-\d{2}-\d{2}$/);
});

// ====================================================================== //
//                        admin → team scope
// ====================================================================== //

test("GET /reports/team-summary?team_id=<acme> (admin) → report.team_viewed scope=team, team_id set", async () => {
    const token = mintToken(app, "acmeAdmin");
    const r = await inject(token, `?team_id=${TEAM_A_ID}`);
    assert.equal(r.statusCode, 200, `${r.statusCode}: ${r.body}`);
    const body = r.json();
    assert.equal(body.scope, "team");
    assert.equal(body.team_id, TEAM_A_ID);

    const rows = await findAuditRows(ORG_ACME, USER_ACME_ADMIN);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.payload.scope, "team");
    assert.equal(row.payload.team_id, TEAM_A_ID);
});

// ====================================================================== //
//                        manager → own team only
// ====================================================================== //

test("GET /reports/team-summary (manager, no team_id) → report.team_viewed scope=team, own team_id", async () => {
    const token = mintToken(app, "managerTeamA");
    const r = await inject(token);
    assert.equal(r.statusCode, 200, `${r.statusCode}: ${r.body}`);
    const body = r.json();
    assert.equal(body.scope, "team");
    assert.equal(body.team_id, TEAM_A_ID);

    const rows = await findAuditRows(ORG_ACME, USER_MANAGER_TEAM_A);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.payload.scope, "team");
    assert.equal(row.payload.team_id, TEAM_A_ID);
});

// ====================================================================== //
//          payload hygiene — no result data echoes into audit
// ====================================================================== //

test("payload omits customer/agent/team names + call title + sentiment + ids", async () => {
    // Seed a call with strongly distinctive markers in every text column
    // that the team report can join onto. The audit row must NOT contain
    // any of these markers in its payload.
    const sensitiveTitle = `${SUITE_TAG}call-title-secret-XYZ`;
    const call = await insertCallRaw(app, ORG_ACME, {
        title: sensitiveTitle,
        agent_user_id: USER_EMPLOYEE_TEAM_A,
        // sentiment isn't a CallCreateInput field, but the recent_calls
        // SELECT includes the column — leave as-is, the title is enough
        // proof that result data isn't leaking.
    });
    const callId = call.id;

    const token = mintToken(app, "acmeAdmin");
    const r = await inject(token, `?team_id=${TEAM_A_ID}`);
    assert.equal(r.statusCode, 200);

    // Confirm the response itself contains the title (positive control
    // for the test setup — we'd otherwise have no evidence the title
    // ever reached the report at all).
    const body = r.json();
    const recentIds = body.recent_calls.map((c) => c.id);
    assert.ok(recentIds.includes(callId), "test setup: call must be in recent_calls");

    const rows = await findAuditRows(ORG_ACME, USER_ACME_ADMIN);
    assert.equal(rows.length, 1);
    assertNoSensitiveValues(rows, [
        sensitiveTitle,
        callId,
        USER_EMPLOYEE_TEAM_A, // agent user id must not appear either
    ]);
    // Positive payload contract: only the five allow-listed keys.
    // The Step 7 expansion adds the resolved-window metadata so an
    // auditor can see WHICH period was opened, but result data
    // (team_name / agent_name / customer_name / call title / recent
    // call rows) must still never reach the payload.
    assert.deepEqual(
        Object.keys(rows[0].payload).sort(),
        ["from", "scope", "team_id", "to", "window_days"],
        "payload must carry only scope + team_id + window metadata",
    );
});

// ====================================================================== //
//          Step 7 — custom date window is echoed into payload
// ====================================================================== //

test("custom from/to window is echoed into audit payload (window_days = inclusive count)", async () => {
    // Use a 7-day inclusive window so we can verify the day count
    // arithmetic instead of just the shape.
    const from = "2026-05-01";
    const to = "2026-05-07";

    const token = mintToken(app, "acmeAdmin");
    const r = await inject(token, `?from=${from}&to=${to}`);
    assert.equal(r.statusCode, 200, `${r.statusCode}: ${r.body}`);

    const rows = await findAuditRows(ORG_ACME, USER_ACME_ADMIN);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.payload.scope, "org");
    assert.equal(row.payload.team_id, null);
    assert.equal(row.payload.from, from);
    assert.equal(row.payload.to, to);
    assert.equal(row.payload.window_days, 7,
        "window_days must be inclusive (to − from + 1)");
    assert.deepEqual(
        Object.keys(row.payload).sort(),
        ["from", "scope", "team_id", "to", "window_days"],
    );
});

// ====================================================================== //
//                        cross-org isolation
// ====================================================================== //

test("audit row written under Acme is invisible from Beta context", async () => {
    const acmeToken = mintToken(app, "acmeAdmin");
    const r = await inject(acmeToken);
    assert.equal(r.statusCode, 200);

    const acmeRows = await findAuditRows(ORG_ACME, USER_ACME_ADMIN);
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
        "Beta must not see Acme report audit row");
});

// Beta admin viewing their own org-wide report should ALSO produce an
// audit row, and it must land in Beta context only (positive control
// for the cross-org isolation above).
test("Beta admin GET → audit row in Beta context only", async () => {
    const token = mintToken(app, "betaAdmin");
    const r = await inject(token);
    assert.equal(r.statusCode, 200, `${r.statusCode}: ${r.body}`);

    const betaRows = await findAuditRows(ORG_BETA, USER_BETA_ADMIN);
    assert.equal(betaRows.length, 1);
    const rowId = betaRows[0].id;

    let acmeRows;
    await app.withOrgContext(ORG_ACME, async (client) => {
        const r2 = await client.query(
            `SELECT id FROM activity_log WHERE id = $1`,
            [rowId],
        );
        acmeRows = r2.rows;
    });
    assert.equal(acmeRows.length, 0);
});

// ====================================================================== //
//          best-effort: audit failure must not poison the request
// ====================================================================== //
//
// The production wiring goes through `tryRecordActivity`, which wraps
// the INSERT in a SAVEPOINT so a failure stays local to the savepoint
// and the outer transaction continues. We assert that property end-to-
// end inside a withOrgContext, using the same primitive the report
// helper uses:
//
//   1. Inside one transaction:
//      a. attempt tryRecordActivity with a forbidden-key payload
//         (sanitizer rejects → returns false, no SQL runs at all)
//      b. attempt tryRecordActivity with a bad action string
//         (DB CHECK rejects → SAVEPOINT rolls back the failed insert)
//      c. INSERT a *good* audit row right after
//   2. Outside the transaction, confirm step c committed.
//
// If the SAVEPOINT machinery were broken, step b would leave the
// transaction in a failed state and step c would never commit. The
// presence of the row is the best-effort property's positive proof.

test("tryRecordActivity isolates audit failure from the outer transaction (best-effort property)", async () => {
    // Use a call row in this org as the sentinel target. The audit
    // helper has nothing to do with calls per se; we just need a row
    // committed via the same transaction that suffered the audit
    // failure, to prove the outer tx wasn't aborted.
    const sentinelTitle = `${SUITE_TAG}sentinel-${Date.now()}`;
    let sentinelExists;

    await app.withOrgContext(ORG_ACME, async (client) => {
        // 1a — sanitizer failure path (forbidden key `secret`).
        const sanitizerOk = await tryRecordActivity(client, {
            orgId:       ORG_ACME,
            actorUserId: USER_ACME_ADMIN,
            action:      "report.team_viewed",
            targetType:  "report",
            targetId:    null,
            payload:     { secret: "value-not-allowed" },
        });
        assert.equal(sanitizerOk, false,
            "sanitizer must reject forbidden key and return false");

        // 1b — DB CHECK failure path (action not in allow-list).
        const dbOk = await tryRecordActivity(client, {
            orgId:       ORG_ACME,
            actorUserId: USER_ACME_ADMIN,
            // Bypass the TS type check — we intentionally pass an
            // action the DB will reject so we can prove the SAVEPOINT
            // rolls back without poisoning the outer transaction.
            action:      /** @type {any} */ ("this.is.not.a.real.action"),
            targetType:  "report",
            targetId:    null,
            payload:     {},
        });
        assert.equal(dbOk, false,
            "DB CHECK must reject bogus action and return false");

        // 1c — the outer transaction must still be usable. Insert a
        // sentinel call that the after-hook can clean up by title.
        await client.query(
            `INSERT INTO calls (org_id, direction, status, title)
             VALUES ($1, 'inbound', 'in_progress', $2)`,
            [ORG_ACME, sentinelTitle],
        );
    });

    // 2 — confirm the sentinel committed. If SAVEPOINT didn't work,
    // step 1b would have left the tx in a failed state and step 1c
    // would have thrown.
    await app.withOrgContext(ORG_ACME, async (client) => {
        const r = await client.query(
            `SELECT 1 FROM calls WHERE title = $1`,
            [sentinelTitle],
        );
        sentinelExists = r.rowCount > 0;
    });
    assert.equal(sentinelExists, true,
        "outer tx must commit successfully despite two tryRecordActivity failures");
});

// And the route-level surface property: even after the audit machinery
// is exercised heavily in the same suite, the report still returns 200
// with a clean body. Catches any latent state pollution.
test("route still returns 200 after the best-effort audit machinery exercised", async () => {
    const token = mintToken(app, "acmeAdmin");
    const r = await inject(token);
    assert.equal(r.statusCode, 200, `${r.statusCode}: ${r.body}`);
    const body = r.json();
    assert.ok(typeof body.total_calls === "number");
    assert.ok(Array.isArray(body.recent_calls));
});

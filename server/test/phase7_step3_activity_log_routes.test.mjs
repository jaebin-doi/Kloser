/* Phase 7 Step 3 — GET /activity-log route tests.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_3_PLAN.md §8 / §10.
 *
 * Surface (admin-only):
 *   GET /activity-log?limit&beforeCreatedAt&beforeId
 *                    &action&targetType&targetId&userId
 *                    &createdFrom&createdTo
 *     → { items: ActivityLog[], nextCursor: cursor | null }
 *
 * Test scenarios:
 *    1. Acme admin GET → 200 with their own org rows; sees the seeded
 *       fixture row.
 *    2. Acme employee GET → 403 forbidden (requireRole gate).
 *    3. Acme admin with no membership row → 401 stale_session via
 *       requireFreshRole. We don't have a seed viewer to demote to
 *       'viewer' role, so we simulate role-drift by demoting the
 *       admin's membership status to 'inactive' (covers the same
 *       requireFreshRole code path as role demotion). The
 *       refresh-after-stale check restores it.
 *    4. Acme admin with DB-demoted membership role → 401 stale_role.
 *    5. invalid query (`?limit=foo`) → 400 invalid_input.
 *    6. invalid uuid (`?targetId=not-a-uuid`) → 400 invalid_input.
 *    7. unknown action (`?action=foo.bar`) → 400 invalid_input.
 *    8. cross-org isolation: Beta admin GET does NOT see Acme rows
 *       even when filtering by Acme user_id — the response is empty
 *       (RLS drops every row whose org_id differs from
 *       current_app_org_id()), and the route returns 200 with []
 *       not 403 (existence of the Acme row is not leaked).
 *    9. filter by action returns only rows with that action.
 *   10. filter by target returns only rows with that (type, id).
 *   11. filter by userId returns only rows with that user.
 *   12. cursor pagination: insert 5 rows, page through with limit=2.
 *
 * Fixture strategy:
 *   - Per-test-run TEST_RUN_ID tag in every fixture payload.
 *   - after() sweeps rows with that tag from BOTH orgs.
 *   - Fixture rows are inserted DIRECTLY via repository helpers under
 *     withOrgContext (we don't drive a mutation to produce them; that
 *     belongs to the audit-hook tests). This keeps the route tests
 *     focused on listing/filtering/pagination/authz.
 *
 * Run: cd server && npm test
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { pool } from "../src/db/pool.js";
import dbPlugin from "../src/plugins/db.js";
import authPlugin from "../src/plugins/auth.js";
import authRoutes from "../src/routes/auth.js";
import activityLogRoutes from "../src/routes/activityLog.js";
import { insertActivity } from "../src/repositories/activityLog.js";

const ORG_ACME = "11111111-1111-1111-1111-111111111111";
const ORG_BETA = "22222222-2222-2222-2222-222222222222";

const ACME_ADMIN_USER    = "aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa";
const ACME_EMP_USER      = "aaaaaaaa-0002-0002-0002-aaaaaaaaaaaa";
const BETA_ADMIN_USER    = "bbbbbbbb-0001-0001-0001-bbbbbbbbbbbb";

const ACME_ADMIN_MEMBERSHIP = "cccccccc-0001-0001-0001-cccccccccccc";

const ACME_ADMIN_EMAIL = "admin@acme.test";
const ACME_ADMIN_PW    = "acme-admin-1234";
const ACME_EMP_EMAIL   = "emp@acme.test";
const ACME_EMP_PW      = "acme-emp-1234";
const BETA_ADMIN_EMAIL = "admin@beta.test";
const BETA_ADMIN_PW    = "beta-admin-1234";

// Suite fingerprint. Every fixture row carries this in payload._test_run
// so after() can sweep exactly our rows even if production audit rows
// pile up underneath.
const TEST_RUN_ID = `phase7-step3-routes-${randomUUID()}`;

let app;

before(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    await app.register(dbPlugin);
    await app.register(authRoutes);
    await app.register(activityLogRoutes);
});

after(async () => {
    for (const orgId of [ORG_ACME, ORG_BETA]) {
        try {
            await app.withOrgContext(orgId, async (client) => {
                await client.query(
                    `DELETE FROM activity_log WHERE payload->>'_test_run' = $1`,
                    [TEST_RUN_ID],
                );
            });
        } catch (_) { /* best-effort */ }
    }
    // Restore admin membership row in case a stale-role test left it
    // mutated. afterEach-style scrub is overkill here because only the
    // dedicated stale-role test mutates it and that test restores it
    // immediately — this is a belt-and-suspenders. memberships is
    // FORCE RLS, so the restore must run inside an org context (a
    // bare pool.query sees zero rows under the org_isolation policy).
    try {
        await app.withOrgContext(ORG_ACME, (client) =>
            client.query(
                `UPDATE memberships SET role = 'admin', status = 'active', updated_at = now()
                  WHERE id = $1`,
                [ACME_ADMIN_MEMBERSHIP],
            ),
        );
    } catch (_) { /* best-effort */ }
    await app.close();
});

// ---------------------------------------------------------------------- //
// helpers
// ---------------------------------------------------------------------- //

async function loginAs(email, password) {
    const r = await app.inject({
        method:  "POST",
        url:     "/auth/login",
        payload: { email, password },
    });
    assert.equal(
        r.statusCode,
        200,
        `login fixture for ${email}: expected 200, got ${r.statusCode}: ${r.body}`,
    );
    return r.json().accessToken;
}

async function getActivityLog(accessToken, queryString = "") {
    return app.inject({
        method:  "GET",
        url:     `/activity-log${queryString ? `?${queryString}` : ""}`,
        headers: { authorization: `Bearer ${accessToken}` },
    });
}

/** Insert one tagged audit row through the repo (bypassing the
 *  service-layer sanitizer so we can write `_test_run` directly — the
 *  sanitizer would let `_test_run` pass anyway, but using the repo
 *  keeps these tests independent of sanitizer behaviour). */
async function insertFixture(orgId, { action, targetType, targetId, userId, extraPayload }) {
    return app.withOrgContext(orgId, async (client) => {
        return insertActivity(client, {
            orgId,
            userId: userId ?? null,
            action,
            targetType: targetType ?? null,
            targetId: targetId ?? null,
            payload: { _test_run: TEST_RUN_ID, ...(extraPayload ?? {}) },
        });
    });
}

function itemsFromBody(body) {
    return Array.isArray(body?.items) ? body.items : [];
}

// =============================================================
//                     1. admin happy path
// =============================================================

test("admin GET returns 200 with own-org rows including a seeded fixture", async () => {
    const fixtureId = randomUUID();
    const inserted = await insertFixture(ORG_ACME, {
        action: "report.team_viewed",
        targetType: "report",
        targetId: fixtureId,
        userId: ACME_ADMIN_USER,
        extraPayload: { case: "admin_happy_path" },
    });

    const token = await loginAs(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const r = await getActivityLog(token, `targetId=${fixtureId}`);
    assert.equal(r.statusCode, 200, `expected 200, got ${r.statusCode}: ${r.body}`);

    const body = r.json();
    const items = itemsFromBody(body);
    assert.equal(items.length, 1, "filter by fresh targetId should return exactly the fixture row");
    assert.equal(items[0].id, inserted.id);
    assert.equal(items[0].action, "report.team_viewed");
    assert.equal(items[0].target_type, "report");
    assert.equal(items[0].target_id, fixtureId);
    assert.equal(items[0].user_id, ACME_ADMIN_USER);
    assert.equal(items[0].payload._test_run, TEST_RUN_ID);
    assert.equal(typeof items[0].created_at, "string", "created_at should be ISO string");
    assert.equal(body.nextCursor, null, "single-row page should have no nextCursor");
});

// =============================================================
//                     2. employee → 403
// =============================================================

test("employee GET → 403 forbidden", async () => {
    const token = await loginAs(ACME_EMP_EMAIL, ACME_EMP_PW);
    const r = await getActivityLog(token);
    assert.equal(r.statusCode, 403, `expected 403, got ${r.statusCode}: ${r.body}`);
    const body = r.json();
    assert.equal(body.error, "forbidden");
});

// =============================================================
//                     3. unauth → 401
// =============================================================

test("missing Authorization → 401 (requireAuth)", async () => {
    const r = await app.inject({ method: "GET", url: "/activity-log" });
    assert.equal(r.statusCode, 401, `expected 401, got ${r.statusCode}: ${r.body}`);
});

// =============================================================
//                     4. stale admin → 401 stale_role
// =============================================================

test("admin with DB-demoted membership role → 401 stale_role", async () => {
    const token = await loginAs(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);

    // memberships has FORCE RLS, so a bare pool.query without
    // app.org_id set sees ZERO rows under the org_isolation policy
    // and the UPDATE is a silent no-op. Mirror the Phase 7 Step 2
    // org_security test pattern: wrap the demote in withOrgContext.
    try {
        await app.withOrgContext(ORG_ACME, (client) =>
            client.query(
                `UPDATE memberships SET role = 'employee', updated_at = now()
                  WHERE id = $1`,
                [ACME_ADMIN_MEMBERSHIP],
            ),
        );

        const r = await getActivityLog(token);
        // requireFreshRole fires after requireRole; since the JWT claim
        // is still admin, requireRole passes (cheap claim check), then
        // requireFreshRole sees role drift and sends 401 stale_role.
        assert.equal(r.statusCode, 401, `expected 401, got ${r.statusCode}: ${r.body}`);
        const body = r.json();
        assert.equal(body.code, "stale_role");
    } finally {
        // ALWAYS restore — otherwise downstream tests see Acme admin as
        // employee, including from other test files.
        await app.withOrgContext(ORG_ACME, (client) =>
            client.query(
                `UPDATE memberships SET role = 'admin', status = 'active', updated_at = now()
                  WHERE id = $1`,
                [ACME_ADMIN_MEMBERSHIP],
            ),
        );
    }
});

// =============================================================
//                     5. invalid query → 400
// =============================================================

test("invalid limit → 400 invalid_input", async () => {
    const token = await loginAs(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const r = await getActivityLog(token, "limit=not-a-number");
    assert.equal(r.statusCode, 400, `expected 400, got ${r.statusCode}: ${r.body}`);
    const body = r.json();
    assert.equal(body.code, "invalid_input");
});

test("invalid uuid in targetId → 400 invalid_input", async () => {
    const token = await loginAs(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const r = await getActivityLog(token, "targetId=not-a-uuid");
    assert.equal(r.statusCode, 400, `expected 400, got ${r.statusCode}: ${r.body}`);
});

test("unknown action enum → 400 invalid_input", async () => {
    const token = await loginAs(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const r = await getActivityLog(token, "action=foo.bar");
    assert.equal(r.statusCode, 400, `expected 400, got ${r.statusCode}: ${r.body}`);
});

test("limit > 100 → 400 invalid_input", async () => {
    const token = await loginAs(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const r = await getActivityLog(token, "limit=101");
    assert.equal(r.statusCode, 400, `expected 400, got ${r.statusCode}: ${r.body}`);
});

// =============================================================
//                     6. cross-org isolation
// =============================================================

test("Beta admin cannot see Acme rows — even when filtering by Acme user_id", async () => {
    const fixtureId = randomUUID();
    const inserted = await insertFixture(ORG_ACME, {
        action: "report.team_viewed",
        targetType: "report",
        targetId: fixtureId,
        userId: ACME_ADMIN_USER,
        extraPayload: { case: "cross_org" },
    });

    const betaToken = await loginAs(BETA_ADMIN_EMAIL, BETA_ADMIN_PW);
    // Try the exact target_id of an Acme row.
    const r = await getActivityLog(betaToken, `targetId=${fixtureId}`);
    assert.equal(r.statusCode, 200, `expected 200, got ${r.statusCode}: ${r.body}`);
    const body = r.json();
    assert.equal(body.items.length, 0, "Beta admin must not see Acme rows");

    // Also try filtering by the Acme admin's user id — empty for Beta.
    const r2 = await getActivityLog(betaToken, `userId=${ACME_ADMIN_USER}`);
    assert.equal(r2.statusCode, 200);
    const body2 = r2.json();
    // Other tests may have produced rows; filter to fixture id to be safe.
    const ours = body2.items.find((row) => row.id === inserted.id);
    assert.equal(ours, undefined, "Beta admin must not see the Acme fixture row by user filter");
});

// =============================================================
//                     7. filters
// =============================================================

test("filter by action returns only rows with that action", async () => {
    const ownerId = randomUUID();
    const a = await insertFixture(ORG_ACME, {
        action: "customer.created",
        targetType: "customer",
        targetId: ownerId,
        userId: ACME_ADMIN_USER,
        extraPayload: { case: "filter_action" },
    });
    await insertFixture(ORG_ACME, {
        action: "customer.updated",
        targetType: "customer",
        targetId: ownerId,
        userId: ACME_ADMIN_USER,
        extraPayload: { case: "filter_action" },
    });

    const token = await loginAs(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const r = await getActivityLog(token, `targetId=${ownerId}&action=customer.created`);
    assert.equal(r.statusCode, 200);
    const items = r.json().items;
    assert.equal(items.length, 1, "should match only the customer.created row");
    assert.equal(items[0].id, a.id);
    assert.equal(items[0].action, "customer.created");
});

test("filter by targetType + targetId returns only matching rows", async () => {
    const callId = randomUUID();
    const customerId = randomUUID();
    const callRow = await insertFixture(ORG_ACME, {
        action: "call.created",
        targetType: "call",
        targetId: callId,
        userId: ACME_ADMIN_USER,
        extraPayload: { case: "filter_target" },
    });
    await insertFixture(ORG_ACME, {
        action: "customer.created",
        targetType: "customer",
        targetId: customerId,
        userId: ACME_ADMIN_USER,
        extraPayload: { case: "filter_target" },
    });

    const token = await loginAs(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const r = await getActivityLog(
        token,
        `targetType=call&targetId=${callId}`,
    );
    assert.equal(r.statusCode, 200);
    const items = r.json().items;
    assert.equal(items.length, 1);
    assert.equal(items[0].id, callRow.id);
});

test("filter by userId returns only rows where the actor matches", async () => {
    const targetId = randomUUID();
    const adminRow = await insertFixture(ORG_ACME, {
        action: "membership.role_changed",
        targetType: "membership",
        targetId,
        userId: ACME_ADMIN_USER,
        extraPayload: { case: "filter_user" },
    });
    await insertFixture(ORG_ACME, {
        action: "membership.role_changed",
        targetType: "membership",
        targetId,
        userId: ACME_EMP_USER,
        extraPayload: { case: "filter_user" },
    });

    const token = await loginAs(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const r = await getActivityLog(
        token,
        `targetId=${targetId}&userId=${ACME_ADMIN_USER}`,
    );
    assert.equal(r.statusCode, 200);
    const items = r.json().items;
    assert.equal(items.length, 1);
    assert.equal(items[0].id, adminRow.id);
    assert.equal(items[0].user_id, ACME_ADMIN_USER);
});

// =============================================================
//                     8. cursor pagination
// =============================================================

test("cursor pagination — limit=2 walks the 5-row fixture in 3 pages", async () => {
    const sharedTargetId = randomUUID();
    // Insert 5 rows. Each insertFixture call rounds-trips to the DB so
    // the rows get distinct created_at values (microsecond resolution).
    const rows = [];
    for (let i = 0; i < 5; i++) {
        const row = await insertFixture(ORG_ACME, {
            action: "report.team_viewed",
            targetType: "report",
            targetId: sharedTargetId,
            userId: ACME_ADMIN_USER,
            extraPayload: { case: "pagination", seq: i },
        });
        rows.push(row);
    }

    // The repo lists DESC by (created_at, id). The newest insert is
    // row index 4 → expected first.
    const expectedNewestFirst = [...rows].reverse().map((r) => r.id);

    const token = await loginAs(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);

    // Page 1.
    const page1 = await getActivityLog(token, `targetId=${sharedTargetId}&limit=2`);
    assert.equal(page1.statusCode, 200);
    const body1 = page1.json();
    assert.equal(body1.items.length, 2, "page 1 should have 2 rows");
    assert.equal(body1.items[0].id, expectedNewestFirst[0]);
    assert.equal(body1.items[1].id, expectedNewestFirst[1]);
    assert.ok(body1.nextCursor, "page 1 should have nextCursor");
    assert.equal(typeof body1.nextCursor.beforeCreatedAt, "string");
    assert.equal(body1.nextCursor.beforeId, expectedNewestFirst[1]);

    // Page 2 — apply the cursor.
    const page2 = await getActivityLog(
        token,
        `targetId=${sharedTargetId}&limit=2` +
        `&beforeCreatedAt=${encodeURIComponent(body1.nextCursor.beforeCreatedAt)}` +
        `&beforeId=${body1.nextCursor.beforeId}`,
    );
    assert.equal(page2.statusCode, 200);
    const body2 = page2.json();
    assert.equal(body2.items.length, 2, "page 2 should have 2 rows");
    assert.equal(body2.items[0].id, expectedNewestFirst[2]);
    assert.equal(body2.items[1].id, expectedNewestFirst[3]);
    assert.ok(body2.nextCursor, "page 2 should still have nextCursor");

    // Page 3 — last row, no further cursor.
    const page3 = await getActivityLog(
        token,
        `targetId=${sharedTargetId}&limit=2` +
        `&beforeCreatedAt=${encodeURIComponent(body2.nextCursor.beforeCreatedAt)}` +
        `&beforeId=${body2.nextCursor.beforeId}`,
    );
    assert.equal(page3.statusCode, 200);
    const body3 = page3.json();
    assert.equal(body3.items.length, 1, "page 3 should have the last row");
    assert.equal(body3.items[0].id, expectedNewestFirst[4]);
    assert.equal(body3.nextCursor, null, "page 3 should be the last page");
});

test("cursor pagination — limit=100 still returns nextCursor when row 101 exists", async () => {
    const sharedTargetId = randomUUID();
    const rows = [];
    for (let i = 0; i < 101; i++) {
        const row = await insertFixture(ORG_ACME, {
            action: "report.team_viewed",
            targetType: "report",
            targetId: sharedTargetId,
            userId: ACME_ADMIN_USER,
            extraPayload: { case: "pagination_max_limit", seq: i },
        });
        rows.push(row);
    }

    const expectedNewestFirst = [...rows].reverse().map((r) => r.id);
    const token = await loginAs(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);

    const page1 = await getActivityLog(token, `targetId=${sharedTargetId}&limit=100`);
    assert.equal(page1.statusCode, 200, `expected 200, got ${page1.statusCode}: ${page1.body}`);
    const body1 = page1.json();
    assert.equal(body1.items.length, 100);
    assert.equal(body1.items[0].id, expectedNewestFirst[0]);
    assert.equal(body1.items[99].id, expectedNewestFirst[99]);
    assert.ok(body1.nextCursor, "100-row max-limit page must expose row 101 via nextCursor");
    assert.equal(body1.nextCursor.beforeId, expectedNewestFirst[99]);

    const page2 = await getActivityLog(
        token,
        `targetId=${sharedTargetId}&limit=100` +
        `&beforeCreatedAt=${encodeURIComponent(body1.nextCursor.beforeCreatedAt)}` +
        `&beforeId=${body1.nextCursor.beforeId}`,
    );
    assert.equal(page2.statusCode, 200);
    const body2 = page2.json();
    assert.equal(body2.items.length, 1);
    assert.equal(body2.items[0].id, expectedNewestFirst[100]);
    assert.equal(body2.nextCursor, null);
});

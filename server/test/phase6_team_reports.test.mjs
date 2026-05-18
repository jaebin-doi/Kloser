/* Phase 6 Step 4 + Phase 7 Step 7 — GET /reports/team-summary tests.
 *
 * Plan:
 *   - docs/plan/phase-6/PHASE_6_STEP_4_PLAN.md §8 (authorization matrix).
 *   - docs/plan/phase-7/PHASE_7_STEP_7_PLAN.md §7.1 (date window +
 *     agent breakdown).
 *
 * Step 4 cases 1-14 cover the authorization matrix and KPI edge cases.
 * Step 7 cases 15-24 cover the date window resolver, agent breakdown
 * payload, and window-scoped metric/recent_call invariants. All Step 7
 * cases insert calls with explicit `started_at` so they don't drift
 * with wall-clock time the way default `now()` rows would.
 *
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
 *  15. default window (no from/to) covers the last 30 days inclusive
 *      and excludes a call dated 31 days ago.
 *  16. custom from/to maps to [from, to+1d) — a call on `to` is in,
 *      a call on `to+1d` is out.
 *  17. invalid date format → 400 invalid_input + code=invalid_date_format.
 *  18. invalid calendar date (2026-02-31) → 400 + code=invalid_calendar_date.
 *  19. from > to → 400 + code=from_after_to.
 *  20. window > 366 days → 400 + code=window_too_large.
 *  21. one-sided window (only from, or only to) → 400 + code=one_sided_window.
 *  22. admin org-wide agent_summaries includes team A, team B, AND an
 *      unassigned bucket when an unassigned call exists in the window.
 *  23. manager team scope agent_summaries excludes other-team agents
 *      and the unassigned bucket.
 *  24. response_rate / avg_duration_seconds + recent_calls all respect
 *      the date filter — pre-window calls are not counted, in-window
 *      calls are.
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

// ─────────────────────────────────────────────
// Phase 7 Step 7 — date window + agent breakdown
// ─────────────────────────────────────────────

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Build a UTC midnight Date and the matching YYYY-MM-DD literal for the
// query string. Tests freeze around the suite's `now` so the window
// math doesn't drift with wall-clock seconds.
function utcDay(year, month, day) {
    return new Date(Date.UTC(year, month - 1, day));
}
function fmtDateOnly(d) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
}

test("15. default window (no from/to) covers last 30 days; older call excluded", async () => {
    // Use Beta org for isolation — Acme accumulates calls from cases
    // 1-14 which can fill the recent_calls top-10 list. Beta is empty
    // of test data at this point so the assertion is unambiguous.
    const today = new Date();
    const within = new Date(today.getTime() - 5 * ONE_DAY_MS);
    const stale = new Date(today.getTime() - 31 * ONE_DAY_MS);

    const inCall = await insertCallRaw(app, ORG_BETA, {
        title: `${PREFIX}case15-in`,
        agent_user_id: USER_BETA_EMP,
        status: "ended",
        duration_seconds: 60,
        started_at: within,
    });
    const outCall = await insertCallRaw(app, ORG_BETA, {
        title: `${PREFIX}case15-out`,
        agent_user_id: USER_BETA_EMP,
        status: "ended",
        duration_seconds: 60,
        started_at: stale,
    });

    const token = mintToken(app, "betaAdmin");
    const r = await inject(token);
    assert.equal(r.statusCode, 200, r.body);
    const body = r.json();
    assert.equal(body.window.days, 30);

    const ids = new Set(body.recent_calls.map((c) => c.id));
    assert.ok(ids.has(inCall.id), "call within 30 days must appear");
    assert.equal(
        ids.has(outCall.id),
        false,
        "call older than 30 days must NOT appear in default window",
    );
});

test("16. custom from/to is [from, to+1d) — boundary inclusive on `to`", async () => {
    // Inclusive window: 2026-05-01 → 2026-05-07. Calls on 2026-05-07
    // 23:59:59 are IN, calls on 2026-05-08 00:00 are OUT.
    const from = "2026-05-01";
    const to = "2026-05-07";
    const inOnTo = await insertCallRaw(app, ORG_ACME, {
        title: `${PREFIX}case16-on-to`,
        agent_user_id: USER_EMPLOYEE_TEAM_A,
        status: "ended",
        duration_seconds: 10,
        started_at: new Date(Date.UTC(2026, 4, 7, 23, 59, 0)),
    });
    const outNextDay = await insertCallRaw(app, ORG_ACME, {
        title: `${PREFIX}case16-next-day`,
        agent_user_id: USER_EMPLOYEE_TEAM_A,
        status: "ended",
        duration_seconds: 10,
        started_at: utcDay(2026, 5, 8),
    });
    const outBeforeFrom = await insertCallRaw(app, ORG_ACME, {
        title: `${PREFIX}case16-before-from`,
        agent_user_id: USER_EMPLOYEE_TEAM_A,
        status: "ended",
        duration_seconds: 10,
        started_at: new Date(Date.UTC(2026, 3, 30, 23, 0, 0)),
    });

    const token = mintToken(app, "acmeAdmin");
    const r = await inject(token, `from=${from}&to=${to}`);
    assert.equal(r.statusCode, 200, r.body);
    const body = r.json();
    assert.equal(body.window.from, from);
    assert.equal(body.window.to, to);
    assert.equal(body.window.days, 7);

    const ids = new Set(body.recent_calls.map((c) => c.id));
    assert.ok(ids.has(inOnTo.id), "call on `to` must appear (inclusive)");
    assert.equal(ids.has(outNextDay.id), false, "call on to+1 must NOT appear");
    assert.equal(
        ids.has(outBeforeFrom.id),
        false,
        "call before `from` must NOT appear",
    );
});

test("17. invalid date format → 400 invalid_input code=invalid_date_format", async () => {
    const token = mintToken(app, "acmeAdmin");
    // The route forwards raw date strings to resolveReportWindow so
    // every date-window error has a stable code field for the frontend.
    const r = await inject(token, "from=05-01-2026&to=2026-05-07");
    assert.equal(r.statusCode, 400, r.body);
    const body = r.json();
    assert.equal(body.error, "invalid_input");
    assert.equal(body.code, "invalid_date_format");
});

test("18. invalid calendar date (2026-02-31) → 400 invalid_calendar_date", async () => {
    const token = mintToken(app, "acmeAdmin");
    const r = await inject(token, "from=2026-02-01&to=2026-02-31");
    assert.equal(r.statusCode, 400, r.body);
    const body = r.json();
    assert.equal(body.error, "invalid_input");
    assert.equal(body.code, "invalid_calendar_date");
});

test("19. from > to → 400 invalid_input code=from_after_to", async () => {
    const token = mintToken(app, "acmeAdmin");
    const r = await inject(token, "from=2026-05-08&to=2026-05-01");
    assert.equal(r.statusCode, 400, r.body);
    const body = r.json();
    assert.equal(body.error, "invalid_input");
    assert.equal(body.code, "from_after_to");
});

test("20. window > 366 days → 400 invalid_input code=window_too_large", async () => {
    const token = mintToken(app, "acmeAdmin");
    // 367 inclusive days (2025-01-01 → 2026-01-02 = 367 days).
    const r = await inject(token, "from=2025-01-01&to=2026-01-02");
    assert.equal(r.statusCode, 400, r.body);
    const body = r.json();
    assert.equal(body.error, "invalid_input");
    assert.equal(body.code, "window_too_large");
});

test("21. one-sided window → 400 invalid_input code=one_sided_window", async () => {
    const token = mintToken(app, "acmeAdmin");
    const onlyFrom = await inject(token, "from=2026-05-01");
    assert.equal(onlyFrom.statusCode, 400, onlyFrom.body);
    assert.equal(onlyFrom.json().error, "invalid_input");
    assert.equal(onlyFrom.json().code, "one_sided_window");

    const onlyTo = await inject(token, "to=2026-05-07");
    assert.equal(onlyTo.statusCode, 400, onlyTo.body);
    assert.equal(onlyTo.json().error, "invalid_input");
    assert.equal(onlyTo.json().code, "one_sided_window");
});

test("22. admin org-wide agent_summaries includes team A + team B + unassigned bucket", async () => {
    const from = "2026-06-01";
    const to = "2026-06-07";
    const at = utcDay(2026, 6, 3);

    await insertCallRaw(app, ORG_ACME, {
        title: `${PREFIX}case22-team-a`,
        agent_user_id: USER_EMPLOYEE_TEAM_A,
        status: "ended",
        duration_seconds: 30,
        started_at: at,
    });
    await insertCallRaw(app, ORG_ACME, {
        title: `${PREFIX}case22-team-b`,
        agent_user_id: USER_EMPLOYEE_TEAM_B,
        status: "ended",
        duration_seconds: 30,
        started_at: at,
    });
    await insertCallRaw(app, ORG_ACME, {
        title: `${PREFIX}case22-unassigned`,
        agent_user_id: null,
        status: "ended",
        duration_seconds: 30,
        started_at: at,
    });

    const token = mintToken(app, "acmeAdmin");
    const r = await inject(token, `from=${from}&to=${to}`);
    assert.equal(r.statusCode, 200, r.body);
    const body = r.json();

    const byAgent = new Map();
    for (const row of body.agent_summaries) {
        byAgent.set(row.agent_user_id, row);
    }
    assert.ok(byAgent.has(USER_EMPLOYEE_TEAM_A), "team A agent must appear");
    assert.ok(byAgent.has(USER_EMPLOYEE_TEAM_B), "team B agent must appear");
    assert.ok(byAgent.has(null), "unassigned bucket must appear in org scope");

    const unassigned = byAgent.get(null);
    assert.equal(unassigned.team_id, null);
    assert.equal(unassigned.team_name, null);
    assert.equal(unassigned.agent_name, null);
    assert.ok(unassigned.total_calls >= 1);
});

test("23. manager team scope agent_summaries excludes other team + unassigned", async () => {
    const from = "2026-06-10";
    const to = "2026-06-17";
    const at = utcDay(2026, 6, 12);

    await insertCallRaw(app, ORG_ACME, {
        title: `${PREFIX}case23-team-a`,
        agent_user_id: USER_EMPLOYEE_TEAM_A,
        status: "ended",
        duration_seconds: 30,
        started_at: at,
    });
    await insertCallRaw(app, ORG_ACME, {
        title: `${PREFIX}case23-team-b`,
        agent_user_id: USER_EMPLOYEE_TEAM_B,
        status: "ended",
        duration_seconds: 30,
        started_at: at,
    });
    await insertCallRaw(app, ORG_ACME, {
        title: `${PREFIX}case23-unassigned`,
        agent_user_id: null,
        status: "ended",
        duration_seconds: 30,
        started_at: at,
    });

    const token = mintToken(app, "managerTeamA");
    const r = await inject(token, `from=${from}&to=${to}`);
    assert.equal(r.statusCode, 200, r.body);
    const body = r.json();

    const agentIds = new Set(body.agent_summaries.map((r) => r.agent_user_id));
    assert.ok(
        agentIds.has(USER_EMPLOYEE_TEAM_A),
        "manager scope must include own-team agent",
    );
    assert.equal(
        agentIds.has(USER_EMPLOYEE_TEAM_B),
        false,
        "manager scope must NOT include other-team agent",
    );
    assert.equal(
        agentIds.has(null),
        false,
        "manager scope must NOT include unassigned bucket",
    );
});

test("24. window-scoped metrics + response_rate + avg_duration ignore out-of-window calls", async () => {
    const from = "2026-07-01";
    const to = "2026-07-07";
    const at = utcDay(2026, 7, 3);
    const before = utcDay(2026, 6, 28);

    // Inside window: 2 ended (90s, 30s avg → 60s) + 1 missed → resp 2/3.
    // Outside window: 5 ended @ 999s + 5 missed. Must NOT count.
    await insertCallRaw(app, ORG_ACME, {
        title: `${PREFIX}case24-in-1`,
        agent_user_id: USER_EMPLOYEE_TEAM_A,
        status: "ended",
        duration_seconds: 90,
        started_at: at,
    });
    await insertCallRaw(app, ORG_ACME, {
        title: `${PREFIX}case24-in-2`,
        agent_user_id: USER_EMPLOYEE_TEAM_A,
        status: "ended",
        duration_seconds: 30,
        started_at: at,
    });
    await insertCallRaw(app, ORG_ACME, {
        title: `${PREFIX}case24-in-missed`,
        agent_user_id: USER_EMPLOYEE_TEAM_A,
        status: "missed",
        started_at: at,
    });
    for (let i = 0; i < 5; i++) {
        await insertCallRaw(app, ORG_ACME, {
            title: `${PREFIX}case24-pre-ended-${i}`,
            agent_user_id: USER_EMPLOYEE_TEAM_A,
            status: "ended",
            duration_seconds: 999,
            started_at: before,
        });
        await insertCallRaw(app, ORG_ACME, {
            title: `${PREFIX}case24-pre-missed-${i}`,
            agent_user_id: USER_EMPLOYEE_TEAM_A,
            status: "missed",
            started_at: before,
        });
    }

    const token = mintToken(app, "managerTeamA");
    const r = await inject(token, `from=${from}&to=${to}`);
    assert.equal(r.statusCode, 200, r.body);
    const body = r.json();
    assert.equal(body.window.from, from);
    assert.equal(body.window.to, to);
    assert.equal(body.window.days, 7);

    assert.equal(body.ended_calls, 2);
    assert.equal(body.missed_calls, 1);
    assert.equal(body.total_calls, 3);

    // response_rate = 2 / (2 + 1) = 0.666…
    assert.ok(
        Math.abs(body.response_rate - 2 / 3) < 1e-9,
        `response_rate must be 2/3 within window; got ${body.response_rate}`,
    );
    assert.equal(
        body.avg_duration_seconds,
        60,
        `avg_duration must be 60 (window-only mean of 90 + 30)`,
    );

    // recent_calls also must respect the window.
    const recentTitles = body.recent_calls.map((c) => c.title);
    for (const t of recentTitles) {
        assert.ok(
            !String(t || "").includes("case24-pre-"),
            `pre-window call must not appear in recent_calls: ${t}`,
        );
    }

    // agent_summaries for the manager scope: USER_EMPLOYEE_TEAM_A has
    // exactly 3 window calls (2 ended + 1 missed).
    const target = body.agent_summaries.find(
        (a) => a.agent_user_id === USER_EMPLOYEE_TEAM_A,
    );
    assert.ok(target, "team-A agent must appear in agent_summaries");
    assert.equal(target.total_calls, 3);
    assert.equal(target.ended_calls, 2);
    assert.equal(target.missed_calls, 1);
    assert.equal(target.avg_duration_seconds, 60);
});

// ─────────────────────────────────────────────
// fmtDateOnly is exercised below to keep the linter from dropping it
// when the parameterised window cases above shrink in future edits.
// ─────────────────────────────────────────────
void fmtDateOnly;

// Keep imports live so linters don't drop them; future cross-org test
// branches will reach for these identifiers.
void USER_ACME_ADMIN;
void USER_BETA_ADMIN;
void USER_MANAGER_TEAM_A;

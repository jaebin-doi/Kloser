/* Phase 4 Step 3 — /dashboard/summary route.
 *
 * Plan: docs/plan/phase-4/PHASE_4_STEP_3_ROUTES.md §7.3.
 *
 * Strategy:
 *   - beforeEach wipes phase-4 test calls from both orgs so each case
 *     starts from a deterministic baseline (we still allow other
 *     suites' rows to exist, but cross-test isolation is fine when
 *     every case compares its own delta).
 *   - cases insert raw rows directly via withOrgContext so we can pin
 *     started_at to specific UTC timestamps (the REST surface always
 *     stamps now()).
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import authPlugin from "../src/plugins/auth.js";
import dbPlugin from "../src/plugins/db.js";
import authRoutes from "../src/routes/auth.js";
import dashboardRoutes from "../src/routes/dashboard.js";

const ACME_ID                = "11111111-1111-1111-1111-111111111111";
const BETA_ID                = "22222222-2222-2222-2222-222222222222";
const ACME_ADMIN_USER_ID     = "aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa";
const ACME_EMP_MEMBERSHIP    = "cccccccc-0002-0002-0002-cccccccccccc";
const ACME_KIM_ID            = "eeeeeeee-1111-0001-0001-eeeeeeeeeeee";

const SEED_PREFIX = "p4dashtest-";

let app;

before(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    await app.register(dbPlugin);
    await app.register(authRoutes);
    await app.register(dashboardRoutes);
});

after(async () => {
    if (app) {
        for (const orgId of [ACME_ID, BETA_ID]) {
            await app.withOrgContext(orgId, async (client) => {
                await client.query(
                    `DELETE FROM calls WHERE title LIKE $1`,
                    [`${SEED_PREFIX}%`],
                );
            });
        }
        await app.pg.query("DELETE FROM sessions");
        await app.close();
    }
});

beforeEach(async () => {
    // Wipe any leftover dashboard fixture and any rows from earlier
    // suites that share a user — keeps active_calls / today_calls /
    // response_rate deterministic per case.
    for (const orgId of [ACME_ID, BETA_ID]) {
        await app.withOrgContext(orgId, async (client) => {
            await client.query(
                `DELETE FROM calls WHERE title LIKE $1`,
                [`${SEED_PREFIX}%`],
            );
            // Also clear anything an earlier suite may have left behind
            // tied to the Acme admin (ws_auth.test does this in its
            // after hook, but we double up here for safety).
            await client.query(
                `DELETE FROM calls WHERE agent_user_id = $1
                   AND title IS NULL`,
                [ACME_ADMIN_USER_ID],
            );
        });
    }
    // restore membership role to employee for ACME_EMP_MEMBERSHIP
    await app.withOrgContext(ACME_ID, async (client) => {
        await client.query(
            `UPDATE memberships SET role = 'employee' WHERE id = $1`,
            [ACME_EMP_MEMBERSHIP],
        );
    });
    await app.pg.query("DELETE FROM sessions");
});

async function loginToken(email, password) {
    const r = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email, password },
    });
    assert.equal(r.statusCode, 200, `login ${email}: ${r.statusCode} ${r.body}`);
    return r.json().accessToken;
}

function authedInject(token, opts) {
    return app.inject({
        ...opts,
        headers: {
            ...(opts.headers || {}),
            authorization: `Bearer ${token}`,
        },
    });
}

async function insertCall(orgId, fields) {
    const {
        title,
        direction = "inbound",
        status,
        started_at,
        ended_at = null,
        duration_seconds = null,
        customer_id = null,
        agent_user_id = null,
    } = fields;
    return app.withOrgContext(orgId, async (client) => {
        const r = await client.query(
            `INSERT INTO calls (
                org_id, customer_id, agent_user_id, direction, status,
                started_at, ended_at, duration_seconds, title
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING id`,
            [
                orgId,
                customer_id,
                agent_user_id,
                direction,
                status,
                started_at,
                ended_at,
                duration_seconds,
                title,
            ],
        );
        return r.rows[0].id;
    });
}

function todayUtcStart() {
    const d = new Date();
    return new Date(Date.UTC(
        d.getUTCFullYear(),
        d.getUTCMonth(),
        d.getUTCDate(),
        0, 0, 0, 0,
    ));
}

// ----------------------------------------------------------------- //
// 1. response shape
// ----------------------------------------------------------------- //

test("GET /dashboard/summary returns the documented schema shape", async () => {
    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const r = await authedInject(token, {
        method: "GET",
        url: "/dashboard/summary",
    });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(typeof body.today_calls, "number");
    assert.ok(
        body.response_rate === null ||
            typeof body.response_rate === "number",
    );
    assert.ok(
        body.avg_duration_seconds === null ||
            typeof body.avg_duration_seconds === "number",
    );
    assert.equal(typeof body.active_calls, "number");
    assert.ok(Array.isArray(body.recent_calls));
});

// ----------------------------------------------------------------- //
// 2. Org isolation
// ----------------------------------------------------------------- //

test("Acme and Beta see only their own org's recent calls", async () => {
    const today = todayUtcStart();
    const acmeStart = new Date(today.getTime() + 5 * 60_000);
    const betaStart = new Date(today.getTime() + 6 * 60_000);

    const acmeId = await insertCall(ACME_ID, {
        title: `${SEED_PREFIX}acme-iso`,
        status: "in_progress",
        started_at: acmeStart,
    });
    const betaId = await insertCall(BETA_ID, {
        title: `${SEED_PREFIX}beta-iso`,
        status: "in_progress",
        started_at: betaStart,
    });

    const acmeToken = await loginToken("admin@acme.test", "acme-admin-1234");
    const betaToken = await loginToken("admin@beta.test", "beta-admin-1234");

    const acme = (await authedInject(acmeToken, {
        method: "GET",
        url: "/dashboard/summary",
    })).json();
    const beta = (await authedInject(betaToken, {
        method: "GET",
        url: "/dashboard/summary",
    })).json();

    assert.ok(acme.recent_calls.find((c) => c.id === acmeId));
    assert.equal(
        acme.recent_calls.find((c) => c.id === betaId),
        undefined,
        "Acme should not see the Beta call",
    );

    assert.ok(beta.recent_calls.find((c) => c.id === betaId));
    assert.equal(
        beta.recent_calls.find((c) => c.id === acmeId),
        undefined,
        "Beta should not see the Acme call",
    );
});

// ----------------------------------------------------------------- //
// 3. UTC day boundary
// ----------------------------------------------------------------- //

test("today_calls counts today's row and excludes yesterday's", async () => {
    const today = todayUtcStart();
    const insideToday = new Date(today.getTime() + 10 * 60_000);
    const yesterday  = new Date(today.getTime() - 60 * 60_000); // 1h before midnight UTC

    await insertCall(ACME_ID, {
        title: `${SEED_PREFIX}today`,
        status: "in_progress",
        started_at: insideToday,
    });
    await insertCall(ACME_ID, {
        title: `${SEED_PREFIX}yesterday`,
        status: "ended",
        started_at: yesterday,
        ended_at: new Date(yesterday.getTime() + 60_000),
        duration_seconds: 60,
    });

    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const r = (await authedInject(token, {
        method: "GET",
        url: "/dashboard/summary",
    })).json();

    // We inserted exactly one row whose started_at falls inside today's
    // UTC window. beforeEach wiped everything, so today_calls should be
    // exactly 1.
    assert.equal(r.today_calls, 1);
});

// ----------------------------------------------------------------- //
// 4. response_rate formula
// ----------------------------------------------------------------- //

test("response_rate = ended / (ended + missed); dropped excluded", async () => {
    const today = todayUtcStart();
    const at = (offsetMin) => new Date(today.getTime() + offsetMin * 60_000);

    // 3 ended + 1 missed + 1 dropped = 4 in denominator (ended+missed),
    // numerator = 3 → 0.75. dropped is intentionally excluded.
    await insertCall(ACME_ID, {
        title: `${SEED_PREFIX}rate-ended-1`,
        status: "ended",
        started_at: at(5),
        ended_at: at(6),
        duration_seconds: 60,
    });
    await insertCall(ACME_ID, {
        title: `${SEED_PREFIX}rate-ended-2`,
        status: "ended",
        started_at: at(10),
        ended_at: at(11),
        duration_seconds: 60,
    });
    await insertCall(ACME_ID, {
        title: `${SEED_PREFIX}rate-ended-3`,
        status: "ended",
        started_at: at(15),
        ended_at: at(16),
        duration_seconds: 60,
    });
    await insertCall(ACME_ID, {
        title: `${SEED_PREFIX}rate-missed`,
        status: "missed",
        started_at: at(20),
    });
    await insertCall(ACME_ID, {
        title: `${SEED_PREFIX}rate-dropped`,
        status: "dropped",
        started_at: at(25),
    });

    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const r = (await authedInject(token, {
        method: "GET",
        url: "/dashboard/summary",
    })).json();

    assert.equal(r.today_calls, 5);
    assert.equal(r.response_rate, 0.75);
});

// ----------------------------------------------------------------- //
// 5. avg_duration_seconds is ended-only
// ----------------------------------------------------------------- //

test("avg_duration_seconds averages only ended calls", async () => {
    const today = todayUtcStart();
    const at = (offsetMin) => new Date(today.getTime() + offsetMin * 60_000);

    // ended: 60s + 180s → avg 120s. missed call duration_seconds NULL
    // — must not weight the average. in_progress also excluded.
    await insertCall(ACME_ID, {
        title: `${SEED_PREFIX}avg-ended-1`,
        status: "ended",
        started_at: at(5),
        ended_at: at(6),
        duration_seconds: 60,
    });
    await insertCall(ACME_ID, {
        title: `${SEED_PREFIX}avg-ended-2`,
        status: "ended",
        started_at: at(10),
        ended_at: at(13),
        duration_seconds: 180,
    });
    await insertCall(ACME_ID, {
        title: `${SEED_PREFIX}avg-missed`,
        status: "missed",
        started_at: at(15),
    });
    await insertCall(ACME_ID, {
        title: `${SEED_PREFIX}avg-in-progress`,
        status: "in_progress",
        started_at: at(20),
    });

    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const r = (await authedInject(token, {
        method: "GET",
        url: "/dashboard/summary",
    })).json();

    assert.equal(r.avg_duration_seconds, 120);
});

// ----------------------------------------------------------------- //
// 6. recent_calls capped at 5, ordered started_at DESC
// ----------------------------------------------------------------- //

test("recent_calls returns at most 5 rows ordered by started_at DESC", async () => {
    const today = todayUtcStart();
    const at = (offsetMin) => new Date(today.getTime() + offsetMin * 60_000);

    const inserted = [];
    for (let i = 0; i < 7; i++) {
        const id = await insertCall(ACME_ID, {
            title: `${SEED_PREFIX}recent-${i}`,
            status: "in_progress",
            // earlier rows have smaller offsets so the last one is newest.
            started_at: at(i * 5),
            customer_id: ACME_KIM_ID,
            agent_user_id: ACME_ADMIN_USER_ID,
        });
        inserted.push({ id, offset: i * 5 });
    }

    const token = await loginToken("admin@acme.test", "acme-admin-1234");
    const r = (await authedInject(token, {
        method: "GET",
        url: "/dashboard/summary",
    })).json();

    assert.equal(r.recent_calls.length, 5);

    // DESC by started_at — the 5 newest IDs are the last 5 inserted.
    const expected = inserted.slice(-5).map((c) => c.id).reverse();
    assert.deepEqual(r.recent_calls.map((c) => c.id), expected);

    // joined customer/agent names made it through the LEFT JOIN.
    for (const c of r.recent_calls) {
        assert.equal(c.customer_name, "김민수");
        assert.equal(c.agent_name, "에이스 어드민");
    }
});

// ----------------------------------------------------------------- //
// 7. viewer can read dashboard
// ----------------------------------------------------------------- //

test("viewer can read /dashboard/summary", async () => {
    // demote employee → viewer
    await app.withOrgContext(ACME_ID, async (client) => {
        await client.query(
            `UPDATE memberships SET role = 'viewer' WHERE id = $1`,
            [ACME_EMP_MEMBERSHIP],
        );
    });
    const token = await loginToken("emp@acme.test", "acme-emp-1234");
    const r = await authedInject(token, {
        method: "GET",
        url: "/dashboard/summary",
    });
    assert.equal(r.statusCode, 200);
});

// ----------------------------------------------------------------- //
// 8. missing auth → 401
// ----------------------------------------------------------------- //

test("GET /dashboard/summary without bearer → 401", async () => {
    const r = await app.inject({
        method: "GET",
        url: "/dashboard/summary",
    });
    assert.equal(r.statusCode, 401);
});

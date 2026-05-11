/* /team/members + /memberships/:id + /teams/* — Phase 3 Step 4 §9.
 *
 * Coverage:
 *   - GET /team/members read access (admin / employee / cross-org)
 *   - PATCH /memberships/:id role + status + last-admin protection +
 *     concurrent-demote race + sessions revoke + manager_id cleanup
 *   - requireFreshRole — stale_role + stale_session 401
 *   - /auth/login account_disabled vs invalid_credentials
 *   - Teams CRUD + invalid_manager + delete pre-cleanup + cross-org 404
 *
 * Pre-req: docker compose up + migrate (through 0008) + 02_service_role.sql,
 * server/.env with SERVICE_DATABASE_URL.
 *
 * Run:  cd server && npm test
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import authPlugin from "../src/plugins/auth.js";
import dbPlugin from "../src/plugins/db.js";
import authRoutes from "../src/routes/auth.js";
import meRoutes from "../src/routes/me.js";
import teamRoutes from "../src/routes/team.js";
import { hashPassword } from "../src/services/auth.js";
import { closeServicePool, getServicePool } from "../src/db/servicePool.js";

const ACME_ID = "11111111-1111-1111-1111-111111111111";
const BETA_ID = "22222222-2222-2222-2222-222222222222";
const ACME_ADMIN_USER       = "aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa";
const ACME_EMP_USER         = "aaaaaaaa-0002-0002-0002-aaaaaaaaaaaa";
const ACME_ADMIN_MEMBERSHIP = "cccccccc-0001-0001-0001-cccccccccccc";
const ACME_EMP_MEMBERSHIP   = "cccccccc-0002-0002-0002-cccccccccccc";
const BETA_ADMIN_MEMBERSHIP = "dddddddd-0001-0001-0001-dddddddddddd";
const BETA_EMP_MEMBERSHIP   = "dddddddd-0002-0002-0002-dddddddddddd";
const SEEDED_MEMBERSHIPS = [
    ACME_ADMIN_MEMBERSHIP, ACME_EMP_MEMBERSHIP,
    BETA_ADMIN_MEMBERSHIP, BETA_EMP_MEMBERSHIP,
];

const ACME_ADMIN_PW = "acme-admin-1234";
const ACME_EMP_PW   = "acme-emp-1234";

let app;

before(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    await app.register(dbPlugin);
    await app.register(authRoutes);
    await app.register(meRoutes);
    await app.register(teamRoutes);
});

after(async () => {
    await closeServicePool();
    await app.close();
});

afterEach(async () => {
    // sessions / organizations / users are not RLS-scoped — direct delete OK.
    await app.pg.query("DELETE FROM sessions");
    await app.pg.query(
        `DELETE FROM organizations WHERE name LIKE 'teamtest-org-%'`);
    await app.pg.query(
        `DELETE FROM users WHERE email LIKE 'teamtest-%@example.test'`);

    // Restore seeded memberships + clear any teams test created.
    for (const orgId of [ACME_ID, BETA_ID]) {
        await app.withOrgContext(orgId, async (client) => {
            await client.query(
                `DELETE FROM memberships
                  WHERE id NOT IN ($1, $2, $3, $4)`,
                SEEDED_MEMBERSHIPS,
            );
            await client.query(
                `UPDATE memberships SET role='admin', status='active'
                  WHERE id IN ($1, $2)`,
                [ACME_ADMIN_MEMBERSHIP, BETA_ADMIN_MEMBERSHIP],
            );
            await client.query(
                `UPDATE memberships SET role='employee', status='active'
                  WHERE id IN ($1, $2)`,
                [ACME_EMP_MEMBERSHIP, BETA_EMP_MEMBERSHIP],
            );
            await client.query(`DELETE FROM teams`);
        });
    }
    // users.disabled_at restored (test 4 may set it).
    await app.pg.query(
        `UPDATE users SET disabled_at = NULL WHERE id IN ($1, $2)`,
        [ACME_ADMIN_USER, ACME_EMP_USER],
    );
});

// -------------------------------------------------------------- //
// Helpers
// -------------------------------------------------------------- //

async function login(email, password, orgId) {
    return app.inject({
        method: "POST", url: "/auth/login",
        payload: { email, password, ...(orgId ? { orgId } : {}) },
    });
}

async function acmeAdminToken() {
    const r = await login("admin@acme.test", ACME_ADMIN_PW);
    assert.equal(r.statusCode, 200);
    return r.json().accessToken;
}

async function acmeEmpToken() {
    const r = await login("emp@acme.test", ACME_EMP_PW);
    assert.equal(r.statusCode, 200);
    return r.json().accessToken;
}

async function betaAdminToken() {
    const r = await login("admin@beta.test", "beta-admin-1234");
    assert.equal(r.statusCode, 200);
    return r.json().accessToken;
}

function authed(token) {
    return { authorization: `Bearer ${token}` };
}

/** Create an extra Acme user + active admin membership inline. Returns
 *  the membership id so tests can target it. */
async function addAcmeMember(role = "admin") {
    const ts = Date.now();
    const email = `teamtest-${role}-${ts}-${Math.random().toString(36).slice(2,6)}@example.test`;
    const passwordHash = await hashPassword("teamtest-pw-12345");
    const u = await app.pg.query(
        `INSERT INTO users (email, password_hash, name)
         VALUES ($1, $2, $3) RETURNING id`,
        [email, passwordHash, `teamtest-${role}`],
    );
    const userId = u.rows[0].id;
    let membershipId;
    await app.withOrgContext(ACME_ID, async (client) => {
        const m = await client.query(
            `INSERT INTO memberships (org_id, user_id, role)
             VALUES ($1, $2, $3) RETURNING id`,
            [ACME_ID, userId, role],
        );
        membershipId = m.rows[0].id;
    });
    return { email, userId, membershipId };
}

// -------------------------------------------------------------- //
// GET /team/members
// -------------------------------------------------------------- //

test("GET /team/members: admin sees own org members (2 seeded)", async () => {
    const tok = await acmeAdminToken();
    const r = await app.inject({
        method: "GET", url: "/team/members", headers: authed(tok),
    });
    assert.equal(r.statusCode, 200);
    const ids = r.json().members.map((m) => m.id).sort();
    assert.deepEqual(ids, [ACME_ADMIN_MEMBERSHIP, ACME_EMP_MEMBERSHIP].sort());
});

test("GET /team/members: employee can read (role-agnostic)", async () => {
    const tok = await acmeEmpToken();
    const r = await app.inject({
        method: "GET", url: "/team/members", headers: authed(tok),
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().members.length, 2);
});

test("GET /team/members: cross-org isolation (beta admin doesn't see acme)", async () => {
    const tok = await betaAdminToken();
    const r = await app.inject({
        method: "GET", url: "/team/members", headers: authed(tok),
    });
    assert.equal(r.statusCode, 200);
    const ids = r.json().members.map((m) => m.id).sort();
    assert.deepEqual(ids, [BETA_ADMIN_MEMBERSHIP, BETA_EMP_MEMBERSHIP].sort());
});

// -------------------------------------------------------------- //
// PATCH /memberships/:id — role / status
// -------------------------------------------------------------- //

test("PATCH /memberships/:id: admin demotes employee role → 200", async () => {
    const tok = await acmeAdminToken();
    const r = await app.inject({
        method: "PATCH", url: `/memberships/${ACME_EMP_MEMBERSHIP}`,
        headers: authed(tok), payload: { role: "viewer" },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().membership.role, "viewer");
    assert.equal(r.json().membership.status, "active");
});

test("PATCH /memberships/:id: admin disables employee → sessions revoked + manager_id cleared", async () => {
    // Seed: log emp in so they have an active session.
    const empLogin = await login("emp@acme.test", ACME_EMP_PW);
    assert.equal(empLogin.statusCode, 200);
    const empSid = empLogin.json().membership.id; // not used directly

    // Make emp manager of a brand-new team.
    const adminTok = await acmeAdminToken();
    const teamCreate = await app.inject({
        method: "POST", url: "/teams", headers: authed(adminTok),
        payload: { name: "team-x", managerId: ACME_EMP_USER },
    });
    assert.equal(teamCreate.statusCode, 201);
    const teamId = teamCreate.json().team.id;

    // Disable emp.
    const r = await app.inject({
        method: "PATCH", url: `/memberships/${ACME_EMP_MEMBERSHIP}`,
        headers: authed(adminTok), payload: { status: "disabled" },
    });
    assert.equal(r.statusCode, 200);

    // Sessions for emp in Acme are all revoked with reason='admin_disabled'.
    const sessions = await app.pg.query(
        `SELECT revoked_reason FROM sessions
          WHERE user_id = $1 AND org_id = $2`,
        [ACME_EMP_USER, ACME_ID],
    );
    assert.ok(sessions.rows.length >= 1);
    for (const row of sessions.rows) {
        assert.equal(row.revoked_reason, "admin_disabled");
    }

    // teams.manager_id pointing at emp is now NULL.
    const team = await app.withOrgContext(ACME_ID, (c) =>
        c.query(`SELECT manager_id FROM teams WHERE id = $1`, [teamId]));
    assert.equal(team.rows[0].manager_id, null);
});

test("PATCH /memberships/:id: last active admin self-demote → 409 last_admin_protected", async () => {
    const tok = await acmeAdminToken();
    const r = await app.inject({
        method: "PATCH", url: `/memberships/${ACME_ADMIN_MEMBERSHIP}`,
        headers: authed(tok), payload: { role: "employee" },
    });
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().code, "last_admin_protected");
});

test("PATCH /memberships/:id: second admin exists → self-demote OK", async () => {
    const extra = await addAcmeMember("admin");
    const tok = await acmeAdminToken();
    const r = await app.inject({
        method: "PATCH", url: `/memberships/${ACME_ADMIN_MEMBERSHIP}`,
        headers: authed(tok), payload: { role: "employee" },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().membership.role, "employee");
    // suppress unused-var lint
    void extra;
});

test("PATCH /memberships/:id: last active admin disable → 409 last_admin_protected", async () => {
    const tok = await acmeAdminToken();
    const r = await app.inject({
        method: "PATCH", url: `/memberships/${ACME_ADMIN_MEMBERSHIP}`,
        headers: authed(tok), payload: { status: "disabled" },
    });
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().code, "last_admin_protected");
});

test("PATCH /memberships/:id: concurrent demote of two admins → exactly one succeeds", async () => {
    // Two admins: ACME_ADMIN and `extra`. Concurrent demote of both, both
    // requests authed with ACME_ADMIN's JWT.
    //
    // The DB serializes the two tx via the FOR UPDATE on the active-admin
    // set. Whichever tx commits first wins (200). The losing tx ends up
    // in one of two valid states depending on timing:
    //
    //   (a) Loser entered service AFTER winner committed but BEFORE its
    //       own requireFreshRole ran the role check. Loser sees admin
    //       set = {sole-remaining-admin}, target = that admin, demote
    //       would leave 0 → 409 last_admin_protected.
    //
    //   (b) Loser's requireFreshRole ran AFTER the winner committed and
    //       the winner happened to be the one demoting ACME_ADMIN (the
    //       JWT owner). Loser's DB role is now 'employee' while its JWT
    //       still says 'admin' → 401 stale_role.
    //
    // Both outcomes uphold the security invariant: the system cannot
    // end up with zero active admins via concurrent demotes. We assert
    // the disjunction.
    const extra = await addAcmeMember("admin");
    const tok = await acmeAdminToken();
    const [r1, r2] = await Promise.all([
        app.inject({
            method: "PATCH", url: `/memberships/${ACME_ADMIN_MEMBERSHIP}`,
            headers: authed(tok), payload: { role: "employee" },
        }),
        app.inject({
            method: "PATCH", url: `/memberships/${extra.membershipId}`,
            headers: authed(tok), payload: { role: "employee" },
        }),
    ]);
    const codes = [r1.statusCode, r2.statusCode].sort();
    const okOutcomes = [
        [200, 409], // (a) lock serialization caught the second mutation
        [200, 401], // (b) requireFreshRole caught the second mutation
    ];
    assert.ok(
        okOutcomes.some((expected) => expected[0] === codes[0] && expected[1] === codes[1]),
        `expected one 200 + one 409 or one 200 + one 401, got ${JSON.stringify(codes)}`,
    );
    // And DB invariant: at least one active admin remains.
    const admins = await app.withOrgContext(ACME_ID, (c) =>
        c.query(
            `SELECT count(*)::int AS n FROM memberships
              WHERE role = 'admin' AND status = 'active'`,
        ));
    assert.ok(admins.rows[0].n >= 1, "active admin count must never reach 0");
});

test("PATCH /memberships/:id: requireFreshRole — JWT role 'admin', DB role 'employee' → 401 stale_role", async () => {
    const extra = await addAcmeMember("admin"); // unblock last-admin protection
    const tok = await acmeAdminToken(); // JWT signed with role='admin'

    // Server-side demote the admin's DB row directly.
    await app.withOrgContext(ACME_ID, (c) =>
        c.query(
            `UPDATE memberships SET role='employee', status='active', updated_at=now()
              WHERE id = $1`,
            [ACME_ADMIN_MEMBERSHIP],
        ));

    const r = await app.inject({
        method: "PATCH", url: `/memberships/${extra.membershipId}`,
        headers: authed(tok), payload: { role: "employee" },
    });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().code, "stale_role");
});

test("PATCH /memberships/:id: requireFreshRole — DB row disabled → 401 stale_session", async () => {
    const extra = await addAcmeMember("admin"); // unblock last-admin protection
    const tok = await acmeAdminToken();

    await app.withOrgContext(ACME_ID, (c) =>
        c.query(
            `UPDATE memberships SET status='disabled', updated_at=now()
              WHERE id = $1`,
            [ACME_ADMIN_MEMBERSHIP],
        ));

    const r = await app.inject({
        method: "PATCH", url: `/memberships/${extra.membershipId}`,
        headers: authed(tok), payload: { role: "employee" },
    });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().code, "stale_session");
});

test("PATCH /memberships/:id: employee → 403 (requireRole)", async () => {
    const tok = await acmeEmpToken();
    const r = await app.inject({
        method: "PATCH", url: `/memberships/${ACME_EMP_MEMBERSHIP}`,
        headers: authed(tok), payload: { role: "viewer" },
    });
    assert.equal(r.statusCode, 403);
});

test("PATCH /memberships/:id: cross-org id → 404 not_found (RLS)", async () => {
    const tok = await acmeAdminToken();
    const r = await app.inject({
        method: "PATCH", url: `/memberships/${BETA_EMP_MEMBERSHIP}`,
        headers: authed(tok), payload: { role: "viewer" },
    });
    assert.equal(r.statusCode, 404);
});

test("PATCH /memberships/:id: empty body → 400 invalid_input", async () => {
    const tok = await acmeAdminToken();
    const r = await app.inject({
        method: "PATCH", url: `/memberships/${ACME_EMP_MEMBERSHIP}`,
        headers: authed(tok), payload: {},
    });
    assert.equal(r.statusCode, 400);
});

// -------------------------------------------------------------- //
// login — account_disabled vs invalid_credentials
// -------------------------------------------------------------- //

test("login: disabled membership (only active one) → 401 account_disabled", async () => {
    // ACME_EMP is the seeded employee. Disable his single Acme membership.
    await app.withOrgContext(ACME_ID, (c) =>
        c.query(
            `UPDATE memberships SET status='disabled', updated_at=now()
              WHERE id = $1`,
            [ACME_EMP_MEMBERSHIP],
        ));

    const r = await login("emp@acme.test", ACME_EMP_PW);
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().code, "account_disabled");
});

test("login: wrong password stays 401 invalid_credentials (no enumeration shift)", async () => {
    const r = await login("emp@acme.test", "definitely-wrong-pw");
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().code, "invalid_credentials");
});

test("login: unknown email stays 401 invalid_credentials", async () => {
    const r = await login("nobody@example.test", "any-pw");
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().code, "invalid_credentials");
});

// -------------------------------------------------------------- //
// Teams CRUD
// -------------------------------------------------------------- //

test("POST /teams: admin creates team → 201 + appears in list", async () => {
    const tok = await acmeAdminToken();
    const r = await app.inject({
        method: "POST", url: "/teams", headers: authed(tok),
        payload: { name: "Alpha" },
    });
    assert.equal(r.statusCode, 201);
    assert.equal(r.json().team.name, "Alpha");
    assert.equal(r.json().team.manager_id, null);

    const list = await app.inject({
        method: "GET", url: "/teams", headers: authed(tok),
    });
    assert.equal(list.statusCode, 200);
    assert.ok(list.json().teams.some((t) => t.name === "Alpha"));
});

test("POST /teams: managerId belongs to another org → 400 invalid_manager", async () => {
    const tok = await acmeAdminToken();
    const r = await app.inject({
        method: "POST", url: "/teams", headers: authed(tok),
        payload: { name: "Bravo", managerId: "bbbbbbbb-0001-0001-0001-bbbbbbbbbbbb" },
        // bbbb... is the BETA admin user; not an active member in Acme.
    });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().code, "invalid_manager");
});

test("PATCH /teams/:id: admin updates name → 200", async () => {
    const tok = await acmeAdminToken();
    const create = await app.inject({
        method: "POST", url: "/teams", headers: authed(tok),
        payload: { name: "Charlie" },
    });
    const teamId = create.json().team.id;

    const r = await app.inject({
        method: "PATCH", url: `/teams/${teamId}`, headers: authed(tok),
        payload: { name: "Charlie-Renamed" },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().team.name, "Charlie-Renamed");
});

test("DELETE /teams/:id: pre-clears memberships.team_id then deletes", async () => {
    const tok = await acmeAdminToken();
    // Create team + put emp in it via direct UPDATE (PATCH membership
    // doesn't expose team_id; that's out of Step 4 scope).
    const create = await app.inject({
        method: "POST", url: "/teams", headers: authed(tok),
        payload: { name: "Delta" },
    });
    const teamId = create.json().team.id;
    await app.withOrgContext(ACME_ID, (c) =>
        c.query(
            `UPDATE memberships SET team_id = $1, updated_at = now()
              WHERE id = $2`,
            [teamId, ACME_EMP_MEMBERSHIP],
        ));

    const r = await app.inject({
        method: "DELETE", url: `/teams/${teamId}`, headers: authed(tok),
    });
    assert.equal(r.statusCode, 204);

    // memberships.team_id now NULL (would have failed with NOT NULL
    // violation if composite FK SET NULL fired without pre-cleanup).
    const m = await app.withOrgContext(ACME_ID, (c) =>
        c.query(`SELECT team_id FROM memberships WHERE id = $1`,
                [ACME_EMP_MEMBERSHIP]));
    assert.equal(m.rows[0].team_id, null);

    const dead = await app.withOrgContext(ACME_ID, (c) =>
        c.query(`SELECT 1 FROM teams WHERE id = $1`, [teamId]));
    assert.equal(dead.rows.length, 0);
});

test("POST /teams: employee → 403", async () => {
    const tok = await acmeEmpToken();
    const r = await app.inject({
        method: "POST", url: "/teams", headers: authed(tok),
        payload: { name: "no" },
    });
    assert.equal(r.statusCode, 403);
});

test("DELETE /teams/:id: cross-org id → 404 not_found", async () => {
    const tok = await acmeAdminToken();
    const create = await app.inject({
        method: "POST", url: "/teams", headers: authed(await betaAdminToken()),
        payload: { name: "BetaTeam" },
    });
    const betaTeamId = create.json().team.id;

    const r = await app.inject({
        method: "DELETE", url: `/teams/${betaTeamId}`, headers: authed(tok),
    });
    assert.equal(r.statusCode, 404);
});

test("DELETE /teams/:id: stale_role JWT → 401 stale_role (requireFreshRole)", async () => {
    const tok = await acmeAdminToken();
    const create = await app.inject({
        method: "POST", url: "/teams", headers: authed(tok),
        payload: { name: "Echo" },
    });
    const teamId = create.json().team.id;
    await addAcmeMember("admin"); // unblock last-admin protection
    await app.withOrgContext(ACME_ID, (c) =>
        c.query(
            `UPDATE memberships SET role='employee', status='active', updated_at=now()
              WHERE id = $1`,
            [ACME_ADMIN_MEMBERSHIP],
        ));

    const r = await app.inject({
        method: "DELETE", url: `/teams/${teamId}`, headers: authed(tok),
    });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().code, "stale_role");
});

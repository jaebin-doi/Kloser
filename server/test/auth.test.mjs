/* Auth core tests — Phase 1 Step 3 §1.10.
 *
 * Covers the route + service layer end-to-end via Fastify inject:
 *   - signup
 *   - login (wrong pw / seeded admin / single-membership auto-pick /
 *            multi-membership 400+availableOrgs / explicit orgId)
 *   - /me (no Bearer / valid Bearer / no password_hash leak)
 *   - refresh (single rotation / grace window in-band / out-of-grace
 *              reuse → family revoke / role re-fetch on rotation)
 *   - logout (revokes session + clears cookie / idempotent without
 *             cookie)
 *   - orgContext (prod env rejects X-Org-Id with 400)
 *   - role guard (viewer/employee → 403 on admin-only / admin → 200)
 *   - cookie attrs on Set-Cookie (HttpOnly, SameSite=Lax, Path=/auth)
 *
 * Pre-req: docker compose up + migrate + seed. Tests reuse the seeded
 * orgs (acme=1111…, beta=2222…) and 4 seeded users. afterEach wipes
 * sessions, drops test-created orgs/users, restores any role demotion.
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
import { requireAuth } from "../src/middleware/auth.js";
import { requireRole } from "../src/middleware/role.js";
import { orgContext } from "../src/middleware/orgContext.js";

// Seeded fixtures — see server/seeds/0001_demo.sql.
const ACME_ID = "11111111-1111-1111-1111-111111111111";
const BETA_ID = "22222222-2222-2222-2222-222222222222";
const ACME_ADMIN_USER_ID    = "aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa";
const ACME_ADMIN_MEMBERSHIP = "cccccccc-0001-0001-0001-cccccccccccc";
const ACME_EMP_MEMBERSHIP   = "cccccccc-0002-0002-0002-cccccccccccc";
const BETA_ADMIN_MEMBERSHIP = "dddddddd-0001-0001-0001-dddddddddddd";
const BETA_EMP_MEMBERSHIP   = "dddddddd-0002-0002-0002-dddddddddddd";
const SEEDED_MEMBERSHIPS = [
    ACME_ADMIN_MEMBERSHIP, ACME_EMP_MEMBERSHIP,
    BETA_ADMIN_MEMBERSHIP, BETA_EMP_MEMBERSHIP,
];

let app;

before(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    await app.register(dbPlugin);
    await app.register(authRoutes);
    await app.register(meRoutes);

    // Test-only routes for role guard + orgContext header behavior.
    app.get(
        "/test-admin-only",
        { preHandler: [requireAuth, requireRole("admin")] },
        async () => ({ ok: true }),
    );
    app.get(
        "/test-employee-or-up",
        { preHandler: [requireAuth, requireRole("admin", "manager", "employee")] },
        async () => ({ ok: true }),
    );
    app.get(
        "/test-probe-org",
        { preHandler: orgContext },
        async (request) => ({ orgId: request.orgId }),
    );
});

after(async () => {
    await app.close();
});

afterEach(async () => {
    // sessions / users / organizations have no RLS — direct delete works.
    await app.pg.query("DELETE FROM sessions");
    await app.pg.query("DELETE FROM organizations WHERE name LIKE 'authtest-%'");
    await app.pg.query(
        "DELETE FROM users WHERE email LIKE 'authtest-%@example.test'",
    );

    // memberships has FORCE RLS — delete per-org under SET LOCAL.
    for (const orgId of [ACME_ID, BETA_ID]) {
        await app.withOrgContext(orgId, async (client) => {
            await client.query(
                `DELETE FROM memberships
                  WHERE id NOT IN ($1, $2, $3, $4)`,
                SEEDED_MEMBERSHIPS,
            );
            // Restore seeded roles in case a test demoted one.
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
        });
    }
});

// ---------------------------------------------------------------------- //
// Helpers
// ---------------------------------------------------------------------- //

async function login({ email, password, orgId }) {
    return app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email, password, ...(orgId ? { orgId } : {}) },
    });
}

function decodeJwtPayload(token) {
    const parts = token.split(".");
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

async function expireRevocation(sessionId, secondsAgo) {
    await app.pg.query(
        `UPDATE sessions
            SET revoked_at = now() - ($2::int * interval '1 second')
          WHERE id = $1`,
        [sessionId, secondsAgo],
    );
}

async function addBetaMembershipForAcmeAdmin(role = "employee") {
    await app.withOrgContext(BETA_ID, async (client) => {
        await client.query(
            `INSERT INTO memberships (org_id, user_id, role)
             VALUES ($1, $2, $3)`,
            [BETA_ID, ACME_ADMIN_USER_ID, role],
        );
    });
}

// ---------------------------------------------------------------------- //
// signup
// ---------------------------------------------------------------------- //

test("signup creates org + user + admin membership and returns access token", async () => {
    const email = `authtest-${Date.now()}@example.test`;
    const r = await app.inject({
        method: "POST",
        url: "/auth/signup",
        payload: {
            organizationName: "authtest-signup-org",
            name: "Signup User",
            email,
            password: "test-pw-1234",
        },
    });
    assert.equal(r.statusCode, 201);
    const body = r.json();
    assert.equal(typeof body.accessToken, "string");
    assert.equal(body.user.email, email);
    assert.equal(body.organization.name, "authtest-signup-org");
    assert.equal(body.organization.plan, "starter");
    assert.equal(body.membership.role, "admin");
    assert.ok(!("password_hash" in body.user), "no password_hash leak");

    const cookie = r.cookies.find((c) => c.name === "kloser_refresh");
    assert.ok(cookie, "refresh cookie set");
});

// ---------------------------------------------------------------------- //
// login
// ---------------------------------------------------------------------- //

test("login: wrong password → 401", async () => {
    const r = await login({ email: "admin@acme.test", password: "wrong" });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().code, "invalid_credentials");
});

test("login: seeded Argon2id password accepted, single-membership auto-picks org", async () => {
    const r = await login({
        email: "admin@acme.test",
        password: "acme-admin-1234",
    });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.user.email, "admin@acme.test");
    assert.equal(body.organization.id, ACME_ID);
    assert.equal(body.membership.role, "admin");
    // accessToken payload reflects the picked org.
    const payload = decodeJwtPayload(body.accessToken);
    assert.equal(payload.orgId, ACME_ID);
    assert.equal(payload.role, "admin");
});

test("login: multi-membership user without orgId → 400 with availableOrgs", async () => {
    await addBetaMembershipForAcmeAdmin("employee");

    const r = await login({
        email: "admin@acme.test",
        password: "acme-admin-1234",
    });
    assert.equal(r.statusCode, 400);
    const body = r.json();
    assert.equal(body.code, "org_id_required");
    assert.ok(Array.isArray(body.availableOrgs));
    assert.equal(body.availableOrgs.length, 2);
    const ids = new Set(body.availableOrgs.map((o) => o.id));
    assert.ok(ids.has(ACME_ID));
    assert.ok(ids.has(BETA_ID));
});

test("login: multi-membership user with explicit orgId reaches the chosen org", async () => {
    await addBetaMembershipForAcmeAdmin("employee");

    const r = await login({
        email: "admin@acme.test",
        password: "acme-admin-1234",
        orgId: BETA_ID,
    });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.organization.id, BETA_ID);
    assert.equal(body.membership.role, "employee");
});

// ---------------------------------------------------------------------- //
// /me
// ---------------------------------------------------------------------- //

test("/me: missing Bearer → 401", async () => {
    const r = await app.inject({ method: "GET", url: "/me" });
    assert.equal(r.statusCode, 401);
});

test("/me: with valid Bearer returns scoped user/org/membership and no password_hash", async () => {
    const lr = await login({
        email: "admin@acme.test",
        password: "acme-admin-1234",
    });
    const accessToken = lr.json().accessToken;

    const r = await app.inject({
        method: "GET",
        url: "/me",
        headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.user.email, "admin@acme.test");
    assert.equal(body.user.mfa_enabled_at, null);
    assert.equal(body.organization.id, ACME_ID);
    assert.equal(body.membership.role, "admin");
    assert.ok(!("password_hash" in body.user), "no password_hash leak");
});

// ---------------------------------------------------------------------- //
// refresh
// ---------------------------------------------------------------------- //

test("refresh: single rotation issues new access token, rotates cookie, wires replaced_by_session_id", async () => {
    const lr = await login({
        email: "admin@acme.test",
        password: "acme-admin-1234",
    });
    const cookie = lr.cookies.find((c) => c.name === "kloser_refresh");
    const oldSid = decodeJwtPayload(lr.json().accessToken).sid;

    const r = await app.inject({
        method: "POST",
        url: "/auth/refresh",
        cookies: { kloser_refresh: cookie.value },
    });
    assert.equal(r.statusCode, 200);

    const newAccessToken = r.json().accessToken;
    const newSid = decodeJwtPayload(newAccessToken).sid;
    assert.notEqual(newSid, oldSid);

    const newCookie = r.cookies.find((c) => c.name === "kloser_refresh");
    assert.ok(newCookie, "Set-Cookie present");
    assert.notEqual(newCookie.value, cookie.value);

    // sessions row state: old is revoked + replaced_by linked + reason 'rotated'
    const oldRow = (await app.pg.query(
        "SELECT revoked_at, replaced_by_session_id, revoked_reason FROM sessions WHERE id=$1",
        [oldSid],
    )).rows[0];
    assert.ok(oldRow.revoked_at, "old session revoked_at set");
    assert.equal(oldRow.replaced_by_session_id, newSid);
    assert.equal(oldRow.revoked_reason, "rotated");
});

test("refresh: grace window allows old token reuse — both 200, family intact, last_used_at touched", async () => {
    const lr = await login({
        email: "admin@acme.test",
        password: "acme-admin-1234",
    });
    const oldCookie = lr.cookies.find((c) => c.name === "kloser_refresh");
    const oldSid = decodeJwtPayload(lr.json().accessToken).sid;

    // First refresh: rotates.
    const r1 = await app.inject({
        method: "POST",
        url: "/auth/refresh",
        cookies: { kloser_refresh: oldCookie.value },
    });
    assert.equal(r1.statusCode, 200);

    // Second refresh with the same OLD cookie, immediately (within grace).
    const r2 = await app.inject({
        method: "POST",
        url: "/auth/refresh",
        cookies: { kloser_refresh: oldCookie.value },
    });
    assert.equal(r2.statusCode, 200);
    // Grace path returns access token but does NOT rotate the cookie
    // (the racing first request already shipped the new cookie).
    const r2Cookie = r2.cookies.find((c) => c.name === "kloser_refresh");
    assert.equal(r2Cookie, undefined, "grace path skips Set-Cookie");

    // Family must NOT be fully revoked.
    const family = (await app.pg.query(
        `SELECT id, revoked_at, last_used_at
           FROM sessions
          WHERE token_family_id = (SELECT token_family_id FROM sessions WHERE id=$1)
          ORDER BY created_at`,
        [oldSid],
    )).rows;
    assert.equal(family.length, 2, "rotation produced a 2-row family");
    const revoked = family.filter((row) => row.revoked_at);
    const active = family.filter((row) => !row.revoked_at);
    assert.equal(revoked.length, 1, "only the old session is revoked");
    assert.equal(active.length, 1, "the replacement session is still active");
    assert.ok(active[0].last_used_at, "replacement.last_used_at set by grace path");
});

test("refresh: out-of-grace reuse → 401 + family revoked + cookie cleared", async () => {
    const lr = await login({
        email: "admin@acme.test",
        password: "acme-admin-1234",
    });
    const oldCookie = lr.cookies.find((c) => c.name === "kloser_refresh");
    const oldSid = decodeJwtPayload(lr.json().accessToken).sid;

    // First refresh: rotates normally.
    const r1 = await app.inject({
        method: "POST",
        url: "/auth/refresh",
        cookies: { kloser_refresh: oldCookie.value },
    });
    assert.equal(r1.statusCode, 200);

    // Push old session's revoked_at out of the 30s grace window.
    await expireRevocation(oldSid, 60);

    // Reusing the old cookie now must trip reuse detection.
    const r2 = await app.inject({
        method: "POST",
        url: "/auth/refresh",
        cookies: { kloser_refresh: oldCookie.value },
    });
    assert.equal(r2.statusCode, 401);
    assert.equal(r2.json().code, "invalid_refresh");

    // Cookie was cleared on the response.
    const clearCookie = r2.cookies.find((c) => c.name === "kloser_refresh");
    assert.ok(clearCookie, "clearCookie Set-Cookie present");
    assert.equal(clearCookie.path, "/auth");

    // Whole family revoked, replacement marked reuse_detected.
    const family = (await app.pg.query(
        `SELECT id, revoked_at, revoked_reason
           FROM sessions
          WHERE token_family_id = (SELECT token_family_id FROM sessions WHERE id=$1)`,
        [oldSid],
    )).rows;
    assert.ok(family.every((row) => row.revoked_at), "all family rows revoked");
    const replacement = family.find((row) => row.id !== oldSid);
    assert.equal(replacement.revoked_reason, "reuse_detected");
});

test("refresh: role re-fetched from memberships (admin demoted to viewer reflected in new access token)", async () => {
    const lr = await login({
        email: "admin@acme.test",
        password: "acme-admin-1234",
    });
    const cookie = lr.cookies.find((c) => c.name === "kloser_refresh");
    const beforePayload = decodeJwtPayload(lr.json().accessToken);
    assert.equal(beforePayload.role, "admin");

    // Demote between login and refresh.
    await app.withOrgContext(ACME_ID, async (client) => {
        await client.query(
            "UPDATE memberships SET role='viewer' WHERE id=$1",
            [ACME_ADMIN_MEMBERSHIP],
        );
    });

    const r = await app.inject({
        method: "POST",
        url: "/auth/refresh",
        cookies: { kloser_refresh: cookie.value },
    });
    assert.equal(r.statusCode, 200);
    const afterPayload = decodeJwtPayload(r.json().accessToken);
    assert.equal(afterPayload.role, "viewer", "role is re-read from memberships on refresh");
    assert.equal(afterPayload.orgId, ACME_ID);
    assert.equal(afterPayload.membershipId, beforePayload.membershipId);
});

test("refresh: missing cookie → 401", async () => {
    const r = await app.inject({ method: "POST", url: "/auth/refresh" });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().code, "missing_refresh");
});

// ---------------------------------------------------------------------- //
// logout
// ---------------------------------------------------------------------- //

test("logout: revokes session and clears cookie (Path=/auth)", async () => {
    const lr = await login({
        email: "admin@acme.test",
        password: "acme-admin-1234",
    });
    const cookie = lr.cookies.find((c) => c.name === "kloser_refresh");
    const sid = decodeJwtPayload(lr.json().accessToken).sid;

    const r = await app.inject({
        method: "POST",
        url: "/auth/logout",
        cookies: { kloser_refresh: cookie.value },
    });
    assert.equal(r.statusCode, 204);
    const cleared = r.cookies.find((c) => c.name === "kloser_refresh");
    assert.ok(cleared, "clear-cookie Set-Cookie present");
    assert.equal(cleared.path, "/auth");

    const session = (await app.pg.query(
        "SELECT revoked_at, revoked_reason FROM sessions WHERE id=$1",
        [sid],
    )).rows[0];
    assert.ok(session.revoked_at, "session revoked");
    assert.equal(session.revoked_reason, "logout");
});

test("logout: idempotent without cookie → 204", async () => {
    const r = await app.inject({ method: "POST", url: "/auth/logout" });
    assert.equal(r.statusCode, 204);
});

// ---------------------------------------------------------------------- //
// orgContext: prod env rejects X-Org-Id with 400
// ---------------------------------------------------------------------- //

test("orgContext: NODE_ENV=production rejects X-Org-Id header with 400", async () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
        const r = await app.inject({
            method: "GET",
            url: "/test-probe-org",
            headers: { "x-org-id": ACME_ID },
        });
        assert.equal(r.statusCode, 400);
        assert.match(r.json().error, /X-Org-Id is not accepted in production/);
    } finally {
        process.env.NODE_ENV = original;
    }
});

// ---------------------------------------------------------------------- //
// role guard
// ---------------------------------------------------------------------- //

test("role guard: employee on admin-only route → 403", async () => {
    const lr = await login({
        email: "emp@acme.test",
        password: "acme-emp-1234",
    });
    const accessToken = lr.json().accessToken;

    const r = await app.inject({
        method: "GET",
        url: "/test-admin-only",
        headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(r.statusCode, 403);
});

test("role guard: admin on admin-only route → 200", async () => {
    const lr = await login({
        email: "admin@acme.test",
        password: "acme-admin-1234",
    });
    const accessToken = lr.json().accessToken;

    const r = await app.inject({
        method: "GET",
        url: "/test-admin-only",
        headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(r.statusCode, 200);
});

test("role guard: employee on employee-or-up route → 200", async () => {
    const lr = await login({
        email: "emp@acme.test",
        password: "acme-emp-1234",
    });
    const accessToken = lr.json().accessToken;

    const r = await app.inject({
        method: "GET",
        url: "/test-employee-or-up",
        headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(r.statusCode, 200);
});

// ---------------------------------------------------------------------- //
// cookie attributes
// ---------------------------------------------------------------------- //

test("login Set-Cookie has Path=/auth, HttpOnly, SameSite=Lax", async () => {
    const lr = await login({
        email: "admin@acme.test",
        password: "acme-admin-1234",
    });
    const cookie = lr.cookies.find((c) => c.name === "kloser_refresh");
    assert.equal(cookie.path, "/auth");
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite?.toLowerCase(), "lax");
});

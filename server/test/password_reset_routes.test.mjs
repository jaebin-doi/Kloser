/* /auth/password/forgot + /auth/password/reset — Phase 3 Step 3 §7.
 *
 * Coverage:
 *   - forgot unknown email → 200 + outbox unchanged
 *   - forgot known email   → 200 + outbox row (template=password_reset)
 *   - forgot twice same user → old auth_token invalidated, new one active
 *   - forgot disabled user → 200 + outbox unchanged
 *   - forgot response shape identical regardless of user existence
 *   - reset happy path → password updated + all active sessions revoked
 *   - reset → old refresh cookie → /auth/refresh 401
 *   - reset → new password login 200
 *   - reset old-access-token /me still 200 (JWT TTL trade-off — Step 3 §1-10)
 *   - reset token reuse → 410 generic
 *   - reset expired token → 410 generic
 *   - reset unknown token → 410 generic
 *   - reset short newPassword → 400 schema
 *   - reset missing token → 400 schema
 *
 * Pre-req: docker compose up + migrate (through 0008) + init/02_service_role.sql,
 * server/.env has SERVICE_DATABASE_URL.
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
import { closeServicePool, getServicePool } from "../src/db/servicePool.js";

let app;
let createdEmails = [];

// RLS-scoped reads (auth_tokens / email_outbox / memberships) need BYPASSRLS
// because we don't carry an app.org_id GUC in tests. servicePool is the
// runtime's anonymous-flow pool, reused here for read assertions.
const svc = () => getServicePool();

before(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    await app.register(dbPlugin);
    await app.register(authRoutes);
    await app.register(meRoutes);
});

after(async () => {
    await closeServicePool();
    await app.close();
});

afterEach(async () => {
    // Same teardown pattern as verify_routes: organizations is NOT RLS-
    // scoped, so the app pool can DELETE it. FK cascades take care of
    // memberships / auth_tokens / email_outbox / sessions / invitations.
    if (createdEmails.length === 0) return;
    await app.pg.query(
        `DELETE FROM organizations WHERE name LIKE 'pwresettest-org-%'`,
    );
    await app.pg.query(
        `DELETE FROM users WHERE email LIKE 'pwresettest-%@example.test'`,
    );
    createdEmails = [];
});

// -------------------------------------------------------------- //
// Helpers
// -------------------------------------------------------------- //

function uniqueEmail() {
    const email = `pwresettest-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test`;
    createdEmails.push(email);
    return email;
}

const STRONG_PASSWORD = "pwresettest-password-original-12345";
const NEW_PASSWORD    = "pwresettest-password-changed-67890";

async function signup() {
    const email = uniqueEmail();
    const r = await app.inject({
        method: "POST",
        url: "/auth/signup",
        payload: {
            organizationName: `pwresettest-org-${Date.now()}`,
            name:             "Reset Test",
            email,
            password:         STRONG_PASSWORD,
        },
    });
    assert.equal(r.statusCode, 201, `signup failed: ${r.body}`);
    return { email, body: r.json(), cookies: r.cookies };
}

async function forgot(email) {
    return app.inject({
        method: "POST",
        url:    "/auth/password/forgot",
        payload: { email },
    });
}

async function reset(token, newPassword = NEW_PASSWORD) {
    return app.inject({
        method: "POST",
        url:    "/auth/password/reset",
        payload: { token, newPassword },
    });
}

async function passwordResetTokenForEmail(email) {
    const r = await svc().query(
        `SELECT body_text FROM email_outbox
          WHERE to_email = $1 AND template = 'password_reset'
          ORDER BY created_at DESC LIMIT 1`,
        [email],
    );
    assert.ok(r.rows[0], "no password_reset email in outbox");
    const m = /[?&]token=([^&\s]+)/.exec(r.rows[0].body_text);
    assert.ok(m, "reset URL did not carry ?token=...");
    return decodeURIComponent(m[1]);
}

async function outboxCount(email, template) {
    const r = await svc().query(
        `SELECT count(*)::int AS n FROM email_outbox
          WHERE to_email = $1 AND template = $2`,
        [email, template],
    );
    return r.rows[0].n;
}

// -------------------------------------------------------------- //
// forgot
// -------------------------------------------------------------- //

test("forgot for unknown email → 200 + outbox unchanged", async () => {
    const before = await svc().query(
        `SELECT count(*)::int AS n FROM email_outbox WHERE template='password_reset'`);
    const r = await forgot("pwresettest-noone@example.test");
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { ok: true });
    const after = await svc().query(
        `SELECT count(*)::int AS n FROM email_outbox WHERE template='password_reset'`);
    assert.equal(after.rows[0].n, before.rows[0].n, "outbox should not grow");
});

test("forgot for known email → 200 + 1 password_reset outbox row + active auth_token", async () => {
    const { email, body } = await signup();
    const r = await forgot(email);
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { ok: true });

    assert.equal(await outboxCount(email, "password_reset"), 1);

    const tokens = await svc().query(
        `SELECT consumed_at, invalidated_at, expires_at
           FROM auth_tokens
          WHERE user_id = $1 AND purpose = 'password_reset'`,
        [body.user.id],
    );
    assert.equal(tokens.rows.length, 1);
    assert.equal(tokens.rows[0].consumed_at, null);
    assert.equal(tokens.rows[0].invalidated_at, null);
    // TTL = 1h. Allow generous tolerance.
    const ttlMs = tokens.rows[0].expires_at.getTime() - Date.now();
    assert.ok(ttlMs > 55 * 60 * 1000, `expires_at too early: ${ttlMs}ms`);
    assert.ok(ttlMs < 65 * 60 * 1000, `expires_at too late: ${ttlMs}ms`);
});

test("forgot twice for same user → old token invalidated + new token active", async () => {
    const { email, body } = await signup();
    await forgot(email);
    await forgot(email);

    const tokens = await svc().query(
        `SELECT consumed_at, invalidated_at
           FROM auth_tokens
          WHERE user_id = $1 AND purpose = 'password_reset'
          ORDER BY created_at`,
        [body.user.id],
    );
    assert.equal(tokens.rows.length, 2);
    assert.ok(tokens.rows[0].invalidated_at, "first token should be invalidated");
    assert.equal(tokens.rows[1].invalidated_at, null, "second token stays active");
    assert.equal(await outboxCount(email, "password_reset"), 2);
});

test("forgot for globally disabled user → 200 + outbox unchanged", async () => {
    const { email, body } = await signup();
    await app.pg.query(
        `UPDATE users SET disabled_at = now() WHERE id = $1`, [body.user.id]);

    const r = await forgot(email);
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { ok: true });
    assert.equal(await outboxCount(email, "password_reset"), 0);
});

test("forgot response identical for unknown vs known email (enumeration parity)", async () => {
    const { email } = await signup();
    const known   = await forgot(email);
    const unknown = await forgot("pwresettest-other@example.test");
    assert.equal(known.statusCode, unknown.statusCode);
    assert.equal(known.body, unknown.body);
});

// -------------------------------------------------------------- //
// reset happy path + session revocation
// -------------------------------------------------------------- //

test("reset → 200 + password updated + every active session revoked", async () => {
    const { email, body } = await signup();
    await forgot(email);
    const rawToken = await passwordResetTokenForEmail(email);

    const r = await reset(rawToken);
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { ok: true });

    // sessions table is not RLS-scoped — app pool can read directly.
    const sessions = await app.pg.query(
        `SELECT revoked_at, revoked_reason FROM sessions WHERE user_id = $1`,
        [body.user.id],
    );
    assert.ok(sessions.rows.length >= 1);
    for (const row of sessions.rows) {
        assert.ok(row.revoked_at, "every session should be revoked");
        assert.equal(row.revoked_reason, "password_reset");
    }
});

test("reset → old refresh cookie 401 on /auth/refresh", async () => {
    const { email, cookies } = await signup();
    const refreshCookie = cookies.find((c) => c.name === "kloser_refresh");
    assert.ok(refreshCookie, "signup should set the refresh cookie");

    await forgot(email);
    const rawToken = await passwordResetTokenForEmail(email);
    await reset(rawToken);

    const r = await app.inject({
        method: "POST",
        url:    "/auth/refresh",
        headers: { cookie: `${refreshCookie.name}=${refreshCookie.value}` },
    });
    assert.equal(r.statusCode, 401);
});

test("reset → new password lets user log in (200)", async () => {
    const { email } = await signup();
    await forgot(email);
    const rawToken = await passwordResetTokenForEmail(email);
    await reset(rawToken);

    const oldLogin = await app.inject({
        method: "POST", url: "/auth/login",
        payload: { email, password: STRONG_PASSWORD },
    });
    assert.equal(oldLogin.statusCode, 401, "old password must no longer work");

    const newLogin = await app.inject({
        method: "POST", url: "/auth/login",
        payload: { email, password: NEW_PASSWORD },
    });
    assert.equal(newLogin.statusCode, 200);
});

test("reset trade-off: old access JWT still works on /me until TTL", async () => {
    // Step 3 plan §1-10 / §4: JWTs are stateless; reset cannot force-expire
    // them. Sessions are revoked (above) so refresh fails, but /me — which
    // verifies the access token only — keeps succeeding until ACCESS_TOKEN_TTL
    // elapses. This test pins that documented behavior so a future change
    // (e.g. introducing session-id cross-check in middleware) updates this
    // expectation deliberately.
    const { email, body } = await signup();
    await forgot(email);
    const rawToken = await passwordResetTokenForEmail(email);
    await reset(rawToken);

    const r = await app.inject({
        method: "GET",
        url:    "/me",
        headers: { authorization: `Bearer ${body.accessToken}` },
    });
    assert.equal(r.statusCode, 200,
        "old access JWT must still pass middleware — see Step 3 §1-10 trade-off");
});

// -------------------------------------------------------------- //
// reset token failures — all collapse to generic 410
// -------------------------------------------------------------- //

test("reset same token twice → 410 generic", async () => {
    const { email } = await signup();
    await forgot(email);
    const rawToken = await passwordResetTokenForEmail(email);
    await reset(rawToken);

    const second = await reset(rawToken);
    assert.equal(second.statusCode, 410);
    assert.deepEqual(second.json(), {
        error: "token_invalid_or_expired",
        code:  "token_invalid_or_expired",
    });
});

test("reset expired token → 410 generic", async () => {
    const { email } = await signup();
    await forgot(email);
    const rawToken = await passwordResetTokenForEmail(email);
    await svc().query(
        `UPDATE auth_tokens SET expires_at = now() - interval '1 minute'
          WHERE token_hash = encode(digest($1, 'sha256'), 'hex')`,
        [rawToken],
    ).catch(async () => {
        // digest() needs pgcrypto schema. Fall back to a direct lookup by
        // raw token would require sha256ing client-side. We can locate the
        // row via the most recent password_reset token for the test user.
        await svc().query(
            `UPDATE auth_tokens SET expires_at = now() - interval '1 minute'
              WHERE purpose = 'password_reset'
                AND consumed_at IS NULL AND invalidated_at IS NULL
                AND user_id = (SELECT id FROM users WHERE email = $1)`,
            [email],
        );
    });

    const r = await reset(rawToken);
    assert.equal(r.statusCode, 410);
    assert.equal(r.json().code, "token_invalid_or_expired");
});

test("reset unknown token → 410 generic", async () => {
    const r = await reset("garbage-token-does-not-exist");
    assert.equal(r.statusCode, 410);
    assert.equal(r.json().code, "token_invalid_or_expired");
});

test("reset newPassword shorter than 8 → 400 schema", async () => {
    const r = await app.inject({
        method: "POST", url: "/auth/password/reset",
        payload: { token: "anything-long-enough", newPassword: "short" },
    });
    assert.equal(r.statusCode, 400);
});

test("reset missing token → 400 schema", async () => {
    const r = await app.inject({
        method: "POST", url: "/auth/password/reset",
        payload: { newPassword: NEW_PASSWORD },
    });
    assert.equal(r.statusCode, 400);
});

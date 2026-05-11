/* /auth/verify + /auth/verify/resend + signup email flow — Phase 3 Step 2 §10.
 *
 * Exercises the public surface via Fastify inject:
 *   - /auth/signup writes auth_tokens (purpose='email_verification') +
 *     email_outbox row in the same transaction as the org/user/membership
 *   - /auth/verify (anonymous) consumes the token and sets users.email_verified_at
 *   - /auth/verify re-use returns generic 410 (reason codes collapse)
 *   - /auth/verify/resend invalidates the old token + mints a new one + writes
 *     another outbox row
 *   - /auth/verify/resend on an already-verified user → 409 already_verified
 *   - /auth/login on an unverified user → 200 (verified gate is Step 4/5)
 *   - /me exposes email_verified_at
 *
 * Pre-req: docker compose up + migrate (through 0008) + init/02_service_role.sql.
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

// Reads/deletes against RLS-scoped tables (auth_tokens, email_outbox,
// memberships) need BYPASSRLS — the app pool sees 0 rows without an
// app.org_id GUC. The servicePool's BYPASSRLS role is the natural test fixture
// for cleanup. Same pool the runtime anonymous endpoints use.
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
    // Tear down everything the test wrote without touching seeded data.
    //
    // organizations / users are NOT RLS-scoped, so the app pool can DELETE
    // them directly. FK cascades (org_id ON DELETE CASCADE on memberships,
    // sessions, auth_tokens, email_outbox, invitations) handle every
    // dependent row — cascades run at the system level and bypass RLS.
    //
    // Match by the deterministic prefix that uniqueEmail / signup() apply,
    // so any rows orphaned by an earlier crash still get swept.
    if (createdEmails.length === 0) return;
    await app.pg.query(`DELETE FROM organizations WHERE name LIKE 'verifytest-org-%'`);
    await app.pg.query(`DELETE FROM users WHERE email LIKE 'verifytest-%@example.test'`);
    createdEmails = [];
});

// ------------------------------------------------------------------ //
// helpers
// ------------------------------------------------------------------ //

function uniqueEmail(prefix) {
    const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test`;
    createdEmails.push(email);
    return email;
}

async function signup() {
    const email = uniqueEmail("verifytest");
    const r = await app.inject({
        method: "POST",
        url: "/auth/signup",
        payload: {
            organizationName: `verifytest-org-${Date.now()}`,
            name:             "Verify Test User",
            email,
            password:         "verifytest-password-123",
        },
    });
    assert.equal(r.statusCode, 201, `signup failed: ${r.body}`);
    return { email, body: r.json() };
}

async function rawTokenForEmail(email) {
    // The outbox body_text contains the verify URL with the raw token in
    // ?token=... — extracting from there mirrors how the Phase 3 e2e will
    // pull tokens out of the dev outbox. servicePool (BYPASSRLS) because
    // email_outbox is FORCE RLS and we don't know the org_id yet.
    const r = await svc().query(
        `SELECT body_text FROM email_outbox
          WHERE to_email = $1 AND template = 'email_verification'
          ORDER BY created_at DESC LIMIT 1`,
        [email],
    );
    assert.ok(r.rows[0], "no verification email in outbox");
    const m = /[?&]token=([^&\s]+)/.exec(r.rows[0].body_text);
    assert.ok(m, "verify URL did not contain ?token=...");
    return decodeURIComponent(m[1]);
}

// ------------------------------------------------------------------ //
// signup → outbox + auth_tokens
// ------------------------------------------------------------------ //

test("signup writes auth_tokens + email_outbox in the same transaction", async () => {
    const { email, body } = await signup();

    assert.equal(body.user.email_verified_at, null,
        "signup response should expose email_verified_at as null");

    const tokens = await svc().query(
        `SELECT purpose, expires_at, consumed_at, invalidated_at
           FROM auth_tokens
          WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
        [email],
    );
    assert.equal(tokens.rows.length, 1);
    assert.equal(tokens.rows[0].purpose, "email_verification");
    assert.equal(tokens.rows[0].consumed_at, null);
    assert.equal(tokens.rows[0].invalidated_at, null);
    // TTL = 24h. Allow generous tolerance for clock skew.
    const ttlMs = tokens.rows[0].expires_at.getTime() - Date.now();
    assert.ok(ttlMs > 23 * 60 * 60 * 1000, `expires_at too early: ${ttlMs}ms`);
    assert.ok(ttlMs < 25 * 60 * 60 * 1000, `expires_at too late: ${ttlMs}ms`);

    const outbox = await svc().query(
        `SELECT template, body_text FROM email_outbox WHERE to_email = $1`,
        [email],
    );
    assert.equal(outbox.rows.length, 1);
    assert.equal(outbox.rows[0].template, "email_verification");
    assert.match(outbox.rows[0].body_text, /token=/);
});

// ------------------------------------------------------------------ //
// /auth/verify
// ------------------------------------------------------------------ //

test("/auth/verify consumes token and sets email_verified_at", async () => {
    const { email } = await signup();
    const raw = await rawTokenForEmail(email);

    const r = await app.inject({
        method: "POST",
        url: "/auth/verify",
        payload: { token: raw },
    });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { ok: true });

    const after = await app.pg.query(
        `SELECT email_verified_at FROM users WHERE email = $1`, [email],
    );
    assert.ok(after.rows[0].email_verified_at, "email_verified_at should be set");
});

test("/auth/verify re-use returns generic 410 (reason collapsed)", async () => {
    const { email } = await signup();
    const raw = await rawTokenForEmail(email);

    await app.inject({ method: "POST", url: "/auth/verify", payload: { token: raw } });
    const second = await app.inject({
        method: "POST", url: "/auth/verify", payload: { token: raw },
    });
    assert.equal(second.statusCode, 410);
    assert.deepEqual(second.json(), {
        error: "token_invalid_or_expired",
        code:  "token_invalid_or_expired",
    });
});

test("/auth/verify with unknown token → 410 (404 collapsed)", async () => {
    const r = await app.inject({
        method: "POST", url: "/auth/verify", payload: { token: "garbage-token" },
    });
    assert.equal(r.statusCode, 410);
    assert.equal(r.json().code, "token_invalid_or_expired");
});

test("/auth/verify with expired token → 410", async () => {
    const { email } = await signup();
    const raw = await rawTokenForEmail(email);
    await svc().query(
        `UPDATE auth_tokens SET expires_at = now() - interval '1 minute'
          WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
        [email],
    );
    const r = await app.inject({
        method: "POST", url: "/auth/verify", payload: { token: raw },
    });
    assert.equal(r.statusCode, 410);
});

test("/auth/verify with missing body → 400", async () => {
    const r = await app.inject({
        method: "POST", url: "/auth/verify", payload: {},
    });
    assert.equal(r.statusCode, 400);
});

// ------------------------------------------------------------------ //
// /auth/verify/resend
// ------------------------------------------------------------------ //

test("/auth/verify/resend invalidates old + mints new + outbox grows", async () => {
    const { body } = await signup();
    const accessToken = body.accessToken;

    const r = await app.inject({
        method: "POST",
        url: "/auth/verify/resend",
        headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(r.statusCode, 200);

    const tokens = await svc().query(
        `SELECT consumed_at, invalidated_at
           FROM auth_tokens
          WHERE user_id = $1 AND purpose = 'email_verification'
          ORDER BY created_at`,
        [body.user.id],
    );
    assert.equal(tokens.rows.length, 2);
    assert.ok(tokens.rows[0].invalidated_at, "first token should be invalidated");
    assert.equal(tokens.rows[1].invalidated_at, null);
    assert.equal(tokens.rows[1].consumed_at, null);

    const outboxCount = await svc().query(
        `SELECT count(*)::int AS n FROM email_outbox WHERE to_email = $1
            AND template = 'email_verification'`,
        [body.user.email],
    );
    assert.equal(outboxCount.rows[0].n, 2);
});

test("/auth/verify/resend on already-verified user → 409", async () => {
    const { email, body } = await signup();
    const raw = await rawTokenForEmail(email);
    await app.inject({
        method: "POST", url: "/auth/verify", payload: { token: raw },
    });

    const r = await app.inject({
        method: "POST",
        url: "/auth/verify/resend",
        headers: { authorization: `Bearer ${body.accessToken}` },
    });
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().code, "already_verified");
});

test("/auth/verify/resend without auth → 401", async () => {
    const r = await app.inject({
        method: "POST", url: "/auth/verify/resend",
    });
    assert.equal(r.statusCode, 401);
});

// ------------------------------------------------------------------ //
// Unverified user policy (Step 4/5 gates not yet active)
// ------------------------------------------------------------------ //

test("login on unverified user → 200", async () => {
    const { email } = await signup();
    const r = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email, password: "verifytest-password-123" },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().user.email_verified_at, null);
});

test("/me exposes email_verified_at: null for fresh signup", async () => {
    const { body } = await signup();
    const r = await app.inject({
        method: "GET",
        url: "/me",
        headers: { authorization: `Bearer ${body.accessToken}` },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().user.email_verified_at, null);
});

test("/me exposes email_verified_at after verify", async () => {
    const { email, body } = await signup();
    const raw = await rawTokenForEmail(email);
    await app.inject({
        method: "POST", url: "/auth/verify", payload: { token: raw },
    });
    const r = await app.inject({
        method: "GET",
        url: "/me",
        headers: { authorization: `Bearer ${body.accessToken}` },
    });
    assert.equal(r.statusCode, 200);
    assert.ok(r.json().user.email_verified_at,
        "email_verified_at should be a non-null ISO string");
});

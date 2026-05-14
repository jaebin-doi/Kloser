/* Phase 7 Step 2 — authenticated /auth/mfa/totp/{setup, confirm} + DELETE tests.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_2_PLAN.md §2.7 / §4.4 / §7.
 *
 * Authenticated counterparts of the login-time setup/confirm flow:
 *
 *   POST   /auth/mfa/totp/setup     (body { currentPassword })
 *   POST   /auth/mfa/totp/confirm   (body { code })
 *   DELETE /auth/mfa/totp           (body { currentPassword, code })
 *
 * All three require a valid Bearer access token. /setup + /disable verify
 * current password; /confirm trusts the JWT (the user typed the password
 * into /setup seconds earlier inside the same tab). /confirm stamps the
 * current session as MFA-verified. /disable refuses when the org
 * enforces MFA.
 *
 * Test scenarios:
 *   1. setup with valid password → 200 + otpauthUri/base32 + pending
 *      secret stored, mfa_enabled_at still NULL.
 *   2. setup wrong password → 401 invalid_credentials, no pending secret.
 *   3. setup when already enrolled → 409 mfa_already_enrolled, prior
 *      secret untouched.
 *   4. confirm valid code → 200 + mfa_enabled_at set + current session
 *      stamped with mfa_verified_at + mfa_method='totp'.
 *   5. confirm without prior setup → 409 mfa_setup_not_started.
 *   6. confirm wrong code → 401 mfa_invalid_code, counter=1, no enrol,
 *      session unstamped.
 *   7. 5 wrong confirm codes → 5th is 423 mfa_locked + lock window set.
 *   8. disable valid password + valid code → 204 + MFA cleared
 *      (secret/enabled/counter/lock all wiped).
 *   9. disable wrong password → 401 invalid_credentials, MFA stays enabled.
 *  10. disable wrong code → 401 mfa_invalid_code, counter increments,
 *      MFA stays enabled.
 *  11. disable when org.mfa_required=true → 409 mfa_required_by_org.
 *  12. revoked current session cannot be marked MFA-verified → 401
 *      invalid_session; rollback leaves mfa_enabled_at NULL.
 *  13. error hygiene: no raw secret / ciphertext / key bytes in error body.
 *
 * Fixture strategy:
 *   - Acme employee logs in via /auth/login at the start of each test.
 *   - process.env.MFA_SECRET_ENCRYPTION_KEY is set in `before`, restored
 *     in `after`.
 *   - afterEach scrubs users.mfa_*, organizations.mfa_required, and
 *     sessions for the test user. afterEach runs even when a test fails.
 *
 * Run: cd server && npm test
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import { Buffer } from "node:buffer";
import authPlugin from "../src/plugins/auth.js";
import dbPlugin from "../src/plugins/db.js";
import authRoutes from "../src/routes/auth.js";
import { pool } from "../src/db/pool.js";
import { closeServicePool, getServicePool } from "../src/db/servicePool.js";
import { generateTotp } from "../src/services/totp.js";

const ORG_ACME       = "11111111-1111-1111-1111-111111111111";
const ACME_EMP       = "aaaaaaaa-0002-0002-0002-aaaaaaaaaaaa";
const ACME_EMP_EMAIL = "emp@acme.test";
const ACME_EMP_PW    = "acme-emp-1234";

const svc = () => getServicePool();

const TEST_KEY = Buffer.alloc(32, 7);

let app;
let originalMfaKey;

before(async () => {
    originalMfaKey = process.env.MFA_SECRET_ENCRYPTION_KEY;
    process.env.MFA_SECRET_ENCRYPTION_KEY = TEST_KEY.toString("base64");

    app = Fastify({ logger: false });
    await app.register(authPlugin);
    await app.register(dbPlugin);
    await app.register(authRoutes);
});

after(async () => {
    await pool.query(
        `UPDATE users
            SET mfa_secret_ciphertext = NULL,
                mfa_secret_iv         = NULL,
                mfa_secret_tag        = NULL,
                mfa_secret_key_version = 1,
                mfa_enabled_at        = NULL,
                mfa_failed_attempt_count = 0,
                mfa_locked_until      = NULL
          WHERE id = $1`,
        [ACME_EMP],
    );
    await pool.query(
        `UPDATE organizations SET mfa_required = false WHERE id = $1`,
        [ORG_ACME],
    );
    await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [ACME_EMP]);
    await closeServicePool();
    await app.close();
    if (originalMfaKey === undefined) {
        delete process.env.MFA_SECRET_ENCRYPTION_KEY;
    } else {
        process.env.MFA_SECRET_ENCRYPTION_KEY = originalMfaKey;
    }
});

afterEach(async () => {
    await pool.query(
        `UPDATE users
            SET mfa_secret_ciphertext = NULL,
                mfa_secret_iv         = NULL,
                mfa_secret_tag        = NULL,
                mfa_secret_key_version = 1,
                mfa_enabled_at        = NULL,
                mfa_failed_attempt_count = 0,
                mfa_locked_until      = NULL
          WHERE id = $1`,
        [ACME_EMP],
    );
    await pool.query(
        `UPDATE organizations SET mfa_required = false WHERE id = $1`,
        [ORG_ACME],
    );
    await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [ACME_EMP]);
});

// ---------------------------------------------------------------------- //
// helpers
// ---------------------------------------------------------------------- //

function decodeJwtPayload(jwt) {
    // Split header.payload.sig — middle segment is base64url JSON.
    const seg = jwt.split(".")[1];
    const buf = Buffer.from(seg, "base64");
    return JSON.parse(buf.toString("utf8"));
}

async function loginAcmeEmp() {
    const r = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: ACME_EMP_EMAIL, password: ACME_EMP_PW },
    });
    assert.equal(r.statusCode, 200, `login fixture: expected 200, got ${r.statusCode}: ${r.body}`);
    const { accessToken } = r.json();
    const payload = decodeJwtPayload(accessToken);
    return {
        accessToken,
        sessionId: payload.sid,
    };
}

async function callSetup({ accessToken, currentPassword }) {
    return app.inject({
        method:  "POST",
        url:     "/auth/mfa/totp/setup",
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { currentPassword },
    });
}

async function callConfirm({ accessToken, code }) {
    return app.inject({
        method:  "POST",
        url:     "/auth/mfa/totp/confirm",
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { code },
    });
}

async function callDisable({ accessToken, currentPassword, code }) {
    return app.inject({
        method:  "DELETE",
        url:     "/auth/mfa/totp",
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { currentPassword, code },
    });
}

async function readUserMfaState() {
    const r = await pool.query(
        `SELECT mfa_secret_ciphertext, mfa_secret_iv, mfa_secret_tag,
                mfa_enabled_at, mfa_failed_attempt_count, mfa_locked_until
           FROM users WHERE id = $1`,
        [ACME_EMP],
    );
    return r.rows[0];
}

async function readSessionById(sessionId) {
    const r = await pool.query(
        `SELECT id, user_id, mfa_verified_at, mfa_method, revoked_at
           FROM sessions WHERE id = $1`,
        [sessionId],
    );
    return r.rows[0];
}

async function setOrgMfaRequired(required) {
    await pool.query(
        `UPDATE organizations SET mfa_required = $2 WHERE id = $1`,
        [ORG_ACME, required],
    );
}

function codeForBase32(base32) {
    return generateTotp({ secretBase32: base32 });
}

async function forceEnrolledWithStaticCiphertext() {
    // Plant a secret triple + mfa_enabled_at WITHOUT going through real
    // setup/confirm. Used by "already enrolled" + "disable" scenarios
    // that need the user pre-enrolled.
    await pool.query(
        `UPDATE users
            SET mfa_secret_ciphertext = $2,
                mfa_secret_iv         = $3,
                mfa_secret_tag        = $4,
                mfa_secret_key_version = 1,
                mfa_enabled_at        = now()
          WHERE id = $1`,
        [
            ACME_EMP,
            Buffer.alloc(32, 1).toString("base64"),
            Buffer.alloc(12, 1).toString("base64"),
            Buffer.alloc(16, 1).toString("base64"),
        ],
    );
}

// =============================================================
//                       SETUP
// =============================================================

test("setup with valid password → 200 otpauthUri/base32, pending secret stored, not enabled", async () => {
    const { accessToken } = await loginAcmeEmp();
    const r = await callSetup({ accessToken, currentPassword: ACME_EMP_PW });
    assert.equal(r.statusCode, 200, `expected 200, got ${r.statusCode}: ${r.body}`);
    const body = r.json();
    assert.ok(body.otpauthUri.startsWith("otpauth://totp/Kloser:"),
        "otpauthUri must use the Kloser issuer label");
    assert.ok(/^[A-Z2-7]+=*$/.test(body.secretBase32),
        "secretBase32 must be RFC 4648 base32");

    // No cookie / no access token from /setup — user is already logged in.
    assert.equal(body.accessToken, undefined);
    const cookies = r.headers["set-cookie"];
    if (cookies) {
        const arr = Array.isArray(cookies) ? cookies : [cookies];
        assert.ok(!arr.some((c) => c.includes("kloser_refresh=")),
            "/setup must not set a refresh cookie");
    }

    const state = await readUserMfaState();
    assert.ok(state.mfa_secret_ciphertext, "pending secret must be stored");
    assert.equal(state.mfa_enabled_at, null, "setup must NOT flip mfa_enabled_at");
});

test("setup with wrong password → 401 invalid_credentials, no pending secret", async () => {
    const { accessToken } = await loginAcmeEmp();
    const r = await callSetup({
        accessToken,
        currentPassword: "wrong-password-1234",
    });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().code, "invalid_credentials");

    const state = await readUserMfaState();
    assert.equal(state.mfa_secret_ciphertext, null,
        "wrong password must not store a pending secret");
});

test("setup when already enrolled → 409 mfa_already_enrolled; prior secret untouched", async () => {
    const { accessToken } = await loginAcmeEmp();
    await forceEnrolledWithStaticCiphertext();
    const beforeState = await readUserMfaState();

    const r = await callSetup({ accessToken, currentPassword: ACME_EMP_PW });
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().code, "mfa_already_enrolled");

    const afterState = await readUserMfaState();
    assert.equal(afterState.mfa_secret_ciphertext, beforeState.mfa_secret_ciphertext,
        "prior enrolled secret must NOT be overwritten");
    assert.deepEqual(afterState.mfa_enabled_at, beforeState.mfa_enabled_at);
});

// =============================================================
//                       CONFIRM
// =============================================================

test("confirm valid code → mfa_enabled_at set + current session marked MFA-verified", async () => {
    const { accessToken, sessionId } = await loginAcmeEmp();
    const setup = (await callSetup({ accessToken, currentPassword: ACME_EMP_PW })).json();
    const code = codeForBase32(setup.secretBase32);

    const r = await callConfirm({ accessToken, code });
    assert.equal(r.statusCode, 200, `expected 200, got ${r.statusCode}: ${r.body}`);
    const body = r.json();
    assert.equal(body.ok, true);
    assert.ok(body.mfa_enabled_at, "response must include mfa_enabled_at");

    const userState = await readUserMfaState();
    assert.ok(userState.mfa_enabled_at, "confirm must flip mfa_enabled_at");
    assert.equal(userState.mfa_failed_attempt_count, 0);

    const session = await readSessionById(sessionId);
    assert.ok(session, "current session must still exist");
    assert.equal(session.revoked_at, null);
    assert.ok(session.mfa_verified_at, "current session must be MFA-stamped");
    assert.equal(session.mfa_method, "totp");
});

test("confirm without prior setup → 409 mfa_setup_not_started", async () => {
    const { accessToken } = await loginAcmeEmp();
    const r = await callConfirm({ accessToken, code: "123456" });
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().code, "mfa_setup_not_started");

    const state = await readUserMfaState();
    assert.equal(state.mfa_enabled_at, null);
});

test("confirm wrong code → 401 mfa_invalid_code, counter=1, not enabled, session not stamped", async () => {
    const { accessToken, sessionId } = await loginAcmeEmp();
    await callSetup({ accessToken, currentPassword: ACME_EMP_PW });

    const r = await callConfirm({ accessToken, code: "000000" });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().code, "mfa_invalid_code");

    const userState = await readUserMfaState();
    assert.equal(userState.mfa_enabled_at, null);
    assert.equal(userState.mfa_failed_attempt_count, 1);
    assert.ok(userState.mfa_secret_ciphertext,
        "pending secret must survive a wrong-code attempt");

    const session = await readSessionById(sessionId);
    assert.equal(session.mfa_verified_at, null,
        "wrong code must not stamp the session");
});

test("5 wrong confirm codes → 5th is 423 mfa_locked + lock window set ~10 min out", async () => {
    const { accessToken } = await loginAcmeEmp();
    await callSetup({ accessToken, currentPassword: ACME_EMP_PW });

    for (let i = 1; i <= 4; i++) {
        const r = await callConfirm({ accessToken, code: "000000" });
        assert.equal(r.statusCode, 401, `attempt ${i} expected 401, got ${r.statusCode}`);
        assert.equal(r.json().code, "mfa_invalid_code");
    }
    const before = Date.now();
    const r5 = await callConfirm({ accessToken, code: "000000" });
    assert.equal(r5.statusCode, 423, `5th expected 423, got ${r5.statusCode}: ${r5.body}`);
    assert.equal(r5.json().code, "mfa_locked");

    const state = await readUserMfaState();
    assert.equal(state.mfa_failed_attempt_count, 5);
    assert.ok(state.mfa_locked_until);
    const lockoutMs = state.mfa_locked_until.getTime() - before;
    assert.ok(lockoutMs > 9 * 60 * 1000 + 50_000, `lockout too short: ${lockoutMs}ms`);
    assert.ok(lockoutMs < 10 * 60 * 1000 + 5_000, `lockout too long: ${lockoutMs}ms`);
});

test("revoked current session at confirm → 401 invalid_session; mfa_enabled_at stays NULL", async () => {
    const { accessToken, sessionId } = await loginAcmeEmp();
    const setup = (await callSetup({ accessToken, currentPassword: ACME_EMP_PW })).json();
    const code = codeForBase32(setup.secretBase32);

    // Revoke the current session BEHIND the still-valid access token.
    // The JWT will still verify (no DB lookup) but markMfaVerified's
    // WHERE-clause excludes revoked rows → rowCount=0 → ROLLBACK.
    await pool.query(
        `UPDATE sessions
            SET revoked_at     = now(),
                revoked_reason = 'test_revoke'
          WHERE id = $1`,
        [sessionId],
    );

    const r = await callConfirm({ accessToken, code });
    assert.equal(r.statusCode, 401, `expected 401, got ${r.statusCode}: ${r.body}`);
    assert.equal(r.json().code, "invalid_session");

    // Rolled back: mfa_enabled_at must stay NULL.
    const userState = await readUserMfaState();
    assert.equal(userState.mfa_enabled_at, null,
        "revoked-session confirm must NOT enable MFA");

    // Pending secret survives (separate transaction earlier).
    assert.ok(userState.mfa_secret_ciphertext);
});

// =============================================================
//                       DISABLE
// =============================================================

test("disable with valid password + valid code → 204; MFA fields/counter/lock all cleared", async () => {
    // Build a real enrolled state through the actual setup → confirm so
    // the stored ciphertext is decryptable by the real key.
    const { accessToken } = await loginAcmeEmp();
    const setup = (await callSetup({ accessToken, currentPassword: ACME_EMP_PW })).json();
    const confirm = await callConfirm({
        accessToken,
        code: codeForBase32(setup.secretBase32),
    });
    assert.equal(confirm.statusCode, 200, "setup precondition: confirm must succeed");

    let state = await readUserMfaState();
    assert.ok(state.mfa_enabled_at, "precondition: user must be enrolled");

    // Same base32 secret survives disable because we keep using it
    // here to compute the current valid code.
    const r = await callDisable({
        accessToken,
        currentPassword: ACME_EMP_PW,
        code:            codeForBase32(setup.secretBase32),
    });
    assert.equal(r.statusCode, 204, `expected 204, got ${r.statusCode}: ${r.body}`);

    state = await readUserMfaState();
    assert.equal(state.mfa_enabled_at, null);
    assert.equal(state.mfa_secret_ciphertext, null);
    assert.equal(state.mfa_secret_iv, null);
    assert.equal(state.mfa_secret_tag, null);
    assert.equal(state.mfa_failed_attempt_count, 0);
    assert.equal(state.mfa_locked_until, null);
});

test("disable with wrong password → 401 invalid_credentials; MFA stays enabled", async () => {
    const { accessToken } = await loginAcmeEmp();
    const setup = (await callSetup({ accessToken, currentPassword: ACME_EMP_PW })).json();
    await callConfirm({ accessToken, code: codeForBase32(setup.secretBase32) });

    const r = await callDisable({
        accessToken,
        currentPassword: "wrong-password-9999",
        code:            codeForBase32(setup.secretBase32),
    });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().code, "invalid_credentials");

    const state = await readUserMfaState();
    assert.ok(state.mfa_enabled_at, "MFA must remain enabled");
    assert.ok(state.mfa_secret_ciphertext);
});

test("disable with wrong code → 401 mfa_invalid_code; counter increments; MFA stays enabled", async () => {
    const { accessToken } = await loginAcmeEmp();
    const setup = (await callSetup({ accessToken, currentPassword: ACME_EMP_PW })).json();
    await callConfirm({ accessToken, code: codeForBase32(setup.secretBase32) });

    // confirm-success resets counter to 0 — start from clean.
    const r = await callDisable({
        accessToken,
        currentPassword: ACME_EMP_PW,
        code:            "000000",
    });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().code, "mfa_invalid_code");

    const state = await readUserMfaState();
    assert.equal(state.mfa_failed_attempt_count, 1);
    assert.ok(state.mfa_enabled_at, "wrong code must not disable MFA");
    assert.ok(state.mfa_secret_ciphertext);
});

test("disable blocked when org.mfa_required=true → 409 mfa_required_by_org", async () => {
    const { accessToken } = await loginAcmeEmp();
    const setup = (await callSetup({ accessToken, currentPassword: ACME_EMP_PW })).json();
    await callConfirm({ accessToken, code: codeForBase32(setup.secretBase32) });

    await setOrgMfaRequired(true);

    const r = await callDisable({
        accessToken,
        currentPassword: ACME_EMP_PW,
        code:            codeForBase32(setup.secretBase32),
    });
    assert.equal(r.statusCode, 409, `expected 409, got ${r.statusCode}: ${r.body}`);
    assert.equal(r.json().code, "mfa_required_by_org");

    const state = await readUserMfaState();
    assert.ok(state.mfa_enabled_at, "org-locked disable must not clear MFA");
    // No counter increment on org-policy rejection.
    assert.equal(state.mfa_failed_attempt_count, 0);
});

// =============================================================
//                       ERROR MESSAGE HYGIENE
// =============================================================

// =============================================================
//                       ORG CONTEXT — production X-Org-Id rejection
// =============================================================

test("NODE_ENV=production: setup/confirm/disable reject X-Org-Id header (orgContext defence)", async () => {
    // orgContext reads process.env.NODE_ENV at request time, so flipping
    // mid-suite works without re-registering the app. The header is the
    // bug we want to surface — its mere presence trips the 400 (UUID
    // validity is not even checked in the prod branch).
    //
    // We explicitly restore NODE_ENV in `finally` so a failed assertion
    // never leaves the suite (and other test files in the same run) in
    // production mode. afterEach also runs in this scenario and is
    // unaffected by NODE_ENV.
    const { accessToken } = await loginAcmeEmp();

    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
        // POST /auth/mfa/totp/setup — valid Bearer + presence of header → 400.
        const setup = await app.inject({
            method:  "POST",
            url:     "/auth/mfa/totp/setup",
            headers: {
                authorization: `Bearer ${accessToken}`,
                "x-org-id":    ORG_ACME, // a syntactically valid UUID still rejected
            },
            payload: { currentPassword: ACME_EMP_PW },
        });
        assert.equal(setup.statusCode, 400, `setup expected 400, got ${setup.statusCode}: ${setup.body}`);
        assert.ok(setup.body.includes("X-Org-Id is not accepted in production"),
            `setup error body should mention prod header rejection, got: ${setup.body}`);

        // POST /auth/mfa/totp/confirm — same defence.
        const confirm = await app.inject({
            method:  "POST",
            url:     "/auth/mfa/totp/confirm",
            headers: {
                authorization: `Bearer ${accessToken}`,
                "x-org-id":    ORG_ACME,
            },
            payload: { code: "123456" },
        });
        assert.equal(confirm.statusCode, 400, `confirm expected 400, got ${confirm.statusCode}: ${confirm.body}`);
        assert.ok(confirm.body.includes("X-Org-Id is not accepted in production"));

        // DELETE /auth/mfa/totp — same defence.
        const disable = await app.inject({
            method:  "DELETE",
            url:     "/auth/mfa/totp",
            headers: {
                authorization: `Bearer ${accessToken}`,
                "x-org-id":    ORG_ACME,
            },
            payload: { currentPassword: ACME_EMP_PW, code: "123456" },
        });
        assert.equal(disable.statusCode, 400, `disable expected 400, got ${disable.statusCode}: ${disable.body}`);
        assert.ok(disable.body.includes("X-Org-Id is not accepted in production"));

        // Sanity: without the header the routes proceed normally in prod
        // — setup hits the service which returns 200 here.
        const setupNoHeader = await app.inject({
            method:  "POST",
            url:     "/auth/mfa/totp/setup",
            headers: { authorization: `Bearer ${accessToken}` },
            payload: { currentPassword: ACME_EMP_PW },
        });
        assert.equal(setupNoHeader.statusCode, 200,
            `setup without X-Org-Id should succeed even in prod, got ${setupNoHeader.statusCode}: ${setupNoHeader.body}`);
    } finally {
        // ALWAYS restore — leaving NODE_ENV=production set leaks into
        // every subsequent test file run by the node:test runner in
        // this process.
        if (originalEnv === undefined) {
            delete process.env.NODE_ENV;
        } else {
            process.env.NODE_ENV = originalEnv;
        }
    }
});

test("error responses never echo raw secret / ciphertext / key bytes", async () => {
    const { accessToken } = await loginAcmeEmp();
    const setup = (await callSetup({ accessToken, currentPassword: ACME_EMP_PW })).json();
    const secretB32 = setup.secretBase32;
    const keyB64    = TEST_KEY.toString("base64");

    const dbRow = await pool.query(
        `SELECT mfa_secret_ciphertext FROM users WHERE id = $1`,
        [ACME_EMP],
    );
    const ctSubstring = dbRow.rows[0].mfa_secret_ciphertext;

    const bodies = [];

    // Branch A: confirm wrong code.
    bodies.push((await callConfirm({ accessToken, code: "000000" })).body);

    // Branch B: disable wrong password (still enrolled? not yet — confirm
    // hasn't run. disable will hit mfa_not_enrolled, password fails first
    // anyway). The body must still not echo secrets.
    bodies.push((await callDisable({
        accessToken,
        currentPassword: "wrong-password-9999",
        code:            "000000",
    })).body);

    // Branch C: setup with wrong password.
    bodies.push((await callSetup({
        accessToken,
        currentPassword: "wrong-password-9999",
    })).body);

    for (const body of bodies) {
        assert.ok(typeof body === "string");
        assert.ok(!body.includes(secretB32),
            "error body must not echo the base32 secret");
        assert.ok(!body.includes(ctSubstring),
            "error body must not echo the stored ciphertext");
        assert.ok(!body.includes(keyB64),
            "error body must not echo the MFA encryption key");
    }
});

/* Phase 7 Step 2 — POST /auth/mfa/totp/verify-login route tests.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_2_PLAN.md §4.4 / §7.
 *
 * Covers the second step of MFA login: given a challengeToken returned by
 * /auth/login's 202 response and a valid 6-digit TOTP code, the user
 * should get a normal session (access token + refresh cookie). Failures
 * must not consume the challenge (so a fat-fingered digit doesn't force
 * a fresh password retry), must increment the lockout counter, and must
 * never leak secret material in error messages.
 *
 * Test scenarios:
 *   1. valid challenge + valid code → 200 + access token + refresh cookie.
 *      Session row carries mfa_verified_at + mfa_method='totp'. Challenge
 *      consumed.
 *   2. wrong code → 401 mfa_invalid_code. Challenge NOT consumed. Failed
 *      attempt count = 1.
 *   3. five wrong codes → fifth response is 423 mfa_locked and
 *      mfa_locked_until is set ~10 minutes in the future.
 *   4. locked user attempting verify (even with correct code) → 423.
 *      Challenge stays unconsumed.
 *   5. expired challenge → 401 mfa_invalid_challenge.
 *   6. invalidated challenge → 401 mfa_invalid_challenge.
 *   7. consumed challenge → 401 mfa_invalid_challenge.
 *   8. user without enabled MFA → 409 mfa_not_enrolled (setup-required
 *      flow is the next commit).
 *   9. tampered ciphertext → 500 mfa_secret_corrupt with sanitised
 *      message.
 *  10. wrong encryption key (env mismatch) → 500 mfa_secret_corrupt.
 *  11. error messages must NOT contain the raw challenge token, the
 *      plaintext TOTP secret, ciphertext bytes, or the encryption key.
 *
 * Fixture strategy:
 *   - Suite generates ONE TOTP secret + encrypts it with one MFA test key.
 *   - `process.env.MFA_SECRET_ENCRYPTION_KEY` is set in `before` so the
 *     service-layer call to `loadMfaSecretEncryptionKey()` picks it up.
 *   - Each test that touches Acme employee's MFA state owns the
 *     mutation in try/finally; the afterEach sweep resets everything.
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
import { generateTotp, generateTotpSecret } from "../src/services/totp.js";
import { encryptMfaSecret } from "../src/services/mfaSecretEncryption.js";

const ORG_ACME       = "11111111-1111-1111-1111-111111111111";
const ACME_EMP       = "aaaaaaaa-0002-0002-0002-aaaaaaaaaaaa";
const ACME_EMP_EMAIL = "emp@acme.test";
const ACME_EMP_PW    = "acme-emp-1234";

const svc = () => getServicePool();

// 32-byte test keys for the AES-GCM helper. Two distinct keys cover the
// "wrong key" negative path.
const TEST_KEY   = Buffer.alloc(32, 7);
const WRONG_KEY  = Buffer.alloc(32, 9);

// One TOTP secret used by the whole suite (per-test mutations re-store
// the same ciphertext on Acme employee). Generated once so we can also
// assert that no error message echoes the plaintext bytes.
const SECRET     = generateTotpSecret();          // { raw: Buffer, base32: string }
const CIPHERTEXT = encryptMfaSecret(SECRET.raw, TEST_KEY);

let app;
let originalMfaKey;

before(async () => {
    // Set the env var BEFORE registering routes — the service path
    // re-reads it from process.env on every call, so the fixture only
    // has to be in place during test execution. We restore on after.
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
    await svc().query(
        `UPDATE auth_tokens SET invalidated_at = now()
          WHERE purpose = 'mfa_challenge'
            AND consumed_at IS NULL
            AND invalidated_at IS NULL`,
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
    await svc().query(
        `UPDATE auth_tokens SET invalidated_at = now()
          WHERE purpose = 'mfa_challenge'
            AND consumed_at IS NULL
            AND invalidated_at IS NULL`,
    );
    await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [ACME_EMP]);
});

// ---------------------------------------------------------------------- //
// helpers
// ---------------------------------------------------------------------- //

async function enableUserMfaWith(ciphertext) {
    await pool.query(
        `UPDATE users
            SET mfa_secret_ciphertext = $2,
                mfa_secret_iv         = $3,
                mfa_secret_tag        = $4,
                mfa_secret_key_version = 1,
                mfa_enabled_at        = now(),
                mfa_failed_attempt_count = 0,
                mfa_locked_until      = NULL
          WHERE id = $1`,
        [ACME_EMP, ciphertext.ciphertext, ciphertext.iv, ciphertext.tag],
    );
}

async function startLoginToGetChallenge() {
    const r = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: ACME_EMP_EMAIL, password: ACME_EMP_PW },
    });
    assert.equal(r.statusCode, 202, `setup: /auth/login should yield 202, got ${r.statusCode}: ${r.body}`);
    return r.json().mfa.challengeToken;
}

async function verifyLoginMfa(payload) {
    return app.inject({
        method: "POST",
        url: "/auth/mfa/totp/verify-login",
        payload,
    });
}

async function readUserMfaState() {
    const r = await pool.query(
        `SELECT mfa_failed_attempt_count, mfa_locked_until, mfa_enabled_at
           FROM users WHERE id = $1`,
        [ACME_EMP],
    );
    return r.rows[0];
}

async function readChallenge(rawToken) {
    const crypto = await import("node:crypto");
    const hash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const r = await svc().query(
        `SELECT id, consumed_at, invalidated_at, expires_at
           FROM auth_tokens
          WHERE token_hash = $1 AND purpose = 'mfa_challenge'`,
        [hash],
    );
    return r.rows[0];
}

async function readSessionForUser() {
    // The newest non-revoked session.
    const r = await pool.query(
        `SELECT id, user_id, org_id, mfa_verified_at, mfa_method, revoked_at
           FROM sessions
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT 1`,
        [ACME_EMP],
    );
    return r.rows[0];
}

function currentValidCode() {
    return generateTotp({ secretBase32: SECRET.base32 });
}

// =============================================================
//                       HAPPY PATH
// =============================================================

test("valid challenge + valid TOTP → 200 + access token + cookie + session marked mfa_verified", async () => {
    await enableUserMfaWith(CIPHERTEXT);
    const challengeToken = await startLoginToGetChallenge();
    const code = currentValidCode();

    const r = await verifyLoginMfa({ challengeToken, code });
    assert.equal(r.statusCode, 200, `expected 200, got ${r.statusCode}: ${r.body}`);
    const body = r.json();
    assert.ok(body.accessToken);
    assert.ok(body.user);
    assert.equal(body.user.id, ACME_EMP);
    assert.equal(body.organization.id, ORG_ACME);

    // Refresh cookie planted.
    const setCookie = r.headers["set-cookie"];
    assert.ok(setCookie);
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    assert.ok(cookies.some((c) => c.includes("kloser_refresh=")),
        "200 response must set kloser_refresh cookie");

    // Challenge consumed.
    const challenge = await readChallenge(challengeToken);
    assert.ok(challenge.consumed_at, "challenge must be consumed on success");
    assert.equal(challenge.invalidated_at, null);

    // Session row carries the MFA stamps.
    const session = await readSessionForUser();
    assert.ok(session, "verify-login must create a session");
    assert.equal(session.org_id, ORG_ACME);
    assert.ok(session.mfa_verified_at, "session must record mfa_verified_at");
    assert.equal(session.mfa_method, "totp");
    assert.equal(session.revoked_at, null);

    // Failed-attempt counter reset.
    const userState = await readUserMfaState();
    assert.equal(userState.mfa_failed_attempt_count, 0);
});

// =============================================================
//                       WRONG CODE — counter increments, no consume
// =============================================================

test("wrong code → 401 mfa_invalid_code, challenge unconsumed, counter = 1", async () => {
    await enableUserMfaWith(CIPHERTEXT);
    const challengeToken = await startLoginToGetChallenge();

    const r = await verifyLoginMfa({ challengeToken, code: "000000" });
    assert.equal(r.statusCode, 401, `expected 401, got ${r.statusCode}: ${r.body}`);
    assert.equal(r.json().code, "mfa_invalid_code");

    // No session.
    const session = await readSessionForUser();
    assert.equal(session, undefined, "no session must be created on wrong code");

    // Challenge not consumed.
    const challenge = await readChallenge(challengeToken);
    assert.equal(challenge.consumed_at, null,
        "wrong code must NOT consume the challenge");
    assert.equal(challenge.invalidated_at, null);

    // Counter advanced.
    const userState = await readUserMfaState();
    assert.equal(userState.mfa_failed_attempt_count, 1);
    assert.equal(userState.mfa_locked_until, null);
});

// =============================================================
//                       LOCKOUT — 5th wrong attempt sets lock
// =============================================================

test("5 wrong codes → 5th response is 423 mfa_locked + mfa_locked_until set", async () => {
    await enableUserMfaWith(CIPHERTEXT);
    const challengeToken = await startLoginToGetChallenge();

    // Drive 4 wrong attempts — all should be 401 mfa_invalid_code.
    for (let i = 1; i <= 4; i++) {
        const r = await verifyLoginMfa({ challengeToken, code: "000000" });
        assert.equal(r.statusCode, 401, `attempt ${i} expected 401, got ${r.statusCode}`);
        assert.equal(r.json().code, "mfa_invalid_code");
    }

    // 5th wrong attempt trips the lockout.
    const before = Date.now();
    const r5 = await verifyLoginMfa({ challengeToken, code: "000000" });
    assert.equal(r5.statusCode, 423, `5th attempt expected 423, got ${r5.statusCode}: ${r5.body}`);
    assert.equal(r5.json().code, "mfa_locked");

    const userState = await readUserMfaState();
    assert.equal(userState.mfa_failed_attempt_count, 5);
    assert.ok(userState.mfa_locked_until, "lockout window must be set");
    const lockoutMs = userState.mfa_locked_until.getTime() - before;
    // 10 min ± 5s tolerance.
    assert.ok(lockoutMs > 9 * 60 * 1000 + 50_000, `lockout window too short: ${lockoutMs}ms`);
    assert.ok(lockoutMs < 10 * 60 * 1000 + 5_000, `lockout window too long: ${lockoutMs}ms`);
});

// =============================================================
//                       LOCKED USER — correct code still refused
// =============================================================

test("locked user cannot verify even with the correct code", async () => {
    await enableUserMfaWith(CIPHERTEXT);
    const challengeToken = await startLoginToGetChallenge();

    // Drop the user straight into a lockout window.
    await pool.query(
        `UPDATE users
            SET mfa_failed_attempt_count = 5,
                mfa_locked_until = now() + interval '10 minutes'
          WHERE id = $1`,
        [ACME_EMP],
    );

    const r = await verifyLoginMfa({
        challengeToken,
        code: currentValidCode(),
    });
    assert.equal(r.statusCode, 423);
    assert.equal(r.json().code, "mfa_locked");

    // Challenge stays unconsumed so the user can retry after the lock
    // window expires.
    const challenge = await readChallenge(challengeToken);
    assert.equal(challenge.consumed_at, null);

    // Counter not incremented on the locked branch.
    const userState = await readUserMfaState();
    assert.equal(userState.mfa_failed_attempt_count, 5);
});

// =============================================================
//                       EXPIRED / INVALIDATED / CONSUMED challenge
// =============================================================

test("expired challenge → 401 mfa_invalid_challenge", async () => {
    await enableUserMfaWith(CIPHERTEXT);
    const challengeToken = await startLoginToGetChallenge();

    // Backdate expiry past now.
    await svc().query(
        `UPDATE auth_tokens
            SET expires_at = now() - interval '1 minute'
          WHERE token_hash = (SELECT encode(digest($1, 'sha256'), 'hex'))
            AND purpose = 'mfa_challenge'`,
        [challengeToken],
    );

    const r = await verifyLoginMfa({
        challengeToken,
        code: currentValidCode(),
    });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().code, "mfa_invalid_challenge");

    const session = await readSessionForUser();
    assert.equal(session, undefined);
});

test("invalidated challenge → 401 mfa_invalid_challenge", async () => {
    await enableUserMfaWith(CIPHERTEXT);
    const challengeToken = await startLoginToGetChallenge();

    await svc().query(
        `UPDATE auth_tokens
            SET invalidated_at = now()
          WHERE token_hash = (SELECT encode(digest($1, 'sha256'), 'hex'))
            AND purpose = 'mfa_challenge'`,
        [challengeToken],
    );

    const r = await verifyLoginMfa({
        challengeToken,
        code: currentValidCode(),
    });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().code, "mfa_invalid_challenge");
});

test("already-consumed challenge → 401 mfa_invalid_challenge", async () => {
    await enableUserMfaWith(CIPHERTEXT);
    const challengeToken = await startLoginToGetChallenge();

    // First successful verify consumes the challenge.
    const ok = await verifyLoginMfa({
        challengeToken,
        code: currentValidCode(),
    });
    assert.equal(ok.statusCode, 200);

    // Second verify on the same raw token must fail.
    const r = await verifyLoginMfa({
        challengeToken,
        code: currentValidCode(),
    });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().code, "mfa_invalid_challenge");
});

test("unknown challenge token → 401 mfa_invalid_challenge", async () => {
    // No `enableUserMfaWith` — the unknown-token branch fires before any
    // MFA state lookup.
    const r = await verifyLoginMfa({
        challengeToken: "phase7-step2-bogus-token-deadbeef",
        code: "123456",
    });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().code, "mfa_invalid_challenge");
});

// =============================================================
//                       USER WITHOUT MFA — 409 not_enrolled
// =============================================================

test("challenge user without enabled MFA → 409 mfa_not_enrolled", async () => {
    // DO NOT enable MFA — the user logged in, the server (via direct DB
    // tampering) issued an mfa_challenge anyway. The endpoint must
    // reject without consuming the token so the setup-required flow
    // (next commit) can pick it up.
    //
    // We can't drive /auth/login here because that path won't mint a
    // challenge for an MFA-not-required user. Insert a challenge row
    // directly via the service pool.
    const crypto = await import("node:crypto");
    const rawToken = `phase7step2-not-enrolled-${crypto.randomBytes(8).toString("hex")}`;
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    await svc().query(
        `INSERT INTO auth_tokens (org_id, user_id, purpose, token_hash, expires_at)
         VALUES ($1, $2, 'mfa_challenge', $3, now() + interval '5 minutes')`,
        [ORG_ACME, ACME_EMP, tokenHash],
    );

    const r = await verifyLoginMfa({ challengeToken: rawToken, code: "123456" });
    assert.equal(r.statusCode, 409, `expected 409, got ${r.statusCode}: ${r.body}`);
    assert.equal(r.json().code, "mfa_not_enrolled");

    // Challenge stays unconsumed for the setup flow.
    const challenge = await readChallenge(rawToken);
    assert.equal(challenge.consumed_at, null);
});

// =============================================================
//                       TAMPERED CIPHERTEXT — sanitized 500
// =============================================================

test("tampered ciphertext → 500 mfa_secret_corrupt with sanitized message", async () => {
    // Same ciphertext but tampered tag — AES-GCM auth fails on decrypt.
    const tampered = {
        ciphertext: CIPHERTEXT.ciphertext,
        iv:         CIPHERTEXT.iv,
        tag:        Buffer.alloc(16, 0).toString("base64"),
    };
    await enableUserMfaWith(tampered);
    const challengeToken = await startLoginToGetChallenge();

    const r = await verifyLoginMfa({
        challengeToken,
        code: currentValidCode(),
    });
    assert.equal(r.statusCode, 500, `expected 500, got ${r.statusCode}: ${r.body}`);
    assert.equal(r.json().code, "mfa_secret_corrupt");

    // No session and challenge unconsumed (rollback).
    const session = await readSessionForUser();
    assert.equal(session, undefined);
    const challenge = await readChallenge(challengeToken);
    assert.equal(challenge.consumed_at, null);
});

// =============================================================
//                       WRONG ENV KEY — sanitized 500
// =============================================================

test("wrong MFA_SECRET_ENCRYPTION_KEY env → 500 mfa_secret_corrupt", async () => {
    // Encrypt secret with TEST_KEY (already in env). Then switch the
    // env to WRONG_KEY for this verify call only. The auth tag check
    // fails, the service returns 500 mfa_secret_corrupt — never echoing
    // the wrong key value.
    await enableUserMfaWith(CIPHERTEXT);
    const challengeToken = await startLoginToGetChallenge();

    const originalKey = process.env.MFA_SECRET_ENCRYPTION_KEY;
    process.env.MFA_SECRET_ENCRYPTION_KEY = WRONG_KEY.toString("base64");
    try {
        const r = await verifyLoginMfa({
            challengeToken,
            code: currentValidCode(),
        });
        assert.equal(r.statusCode, 500);
        assert.equal(r.json().code, "mfa_secret_corrupt");
    } finally {
        process.env.MFA_SECRET_ENCRYPTION_KEY = originalKey;
    }
});

// =============================================================
//                       ERROR MESSAGE HYGIENE
// =============================================================

test("error responses never echo raw token / secret / ciphertext / key bytes", async () => {
    // Trigger each error branch we can reach without restarting the
    // server, capture the response body, assert no sensitive substring
    // appears anywhere in it.
    const rawSecretBase64 = SECRET.raw.toString("base64");
    const cipherSubstring = CIPHERTEXT.ciphertext;
    const keyB64          = TEST_KEY.toString("base64");

    const bodies = [];

    // Branch A: unknown challenge.
    bodies.push((await verifyLoginMfa({
        challengeToken: "phase7-step2-hygiene-bogus",
        code: "123456",
    })).body);

    // Branch B: wrong code (real challenge required).
    await enableUserMfaWith(CIPHERTEXT);
    const tok = await startLoginToGetChallenge();
    bodies.push((await verifyLoginMfa({ challengeToken: tok, code: "000000" })).body);

    // Branch C: tampered ciphertext (re-enable with bad tag).
    await enableUserMfaWith({
        ciphertext: CIPHERTEXT.ciphertext,
        iv:         CIPHERTEXT.iv,
        tag:        Buffer.alloc(16, 0).toString("base64"),
    });
    const tok2 = await startLoginToGetChallenge();
    bodies.push((await verifyLoginMfa({
        challengeToken: tok2,
        code: currentValidCode(),
    })).body);

    for (const body of bodies) {
        assert.ok(typeof body === "string");
        assert.ok(!body.includes(tok),
            "error body must not echo a real challenge token");
        assert.ok(!body.includes(rawSecretBase64),
            "error body must not echo raw secret bytes (base64)");
        assert.ok(!body.includes(cipherSubstring),
            "error body must not echo ciphertext bytes");
        assert.ok(!body.includes(keyB64),
            "error body must not echo the MFA encryption key");
    }
});

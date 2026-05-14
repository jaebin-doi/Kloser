/* Phase 7 Step 2 — POST /auth/mfa/totp/setup-challenge + confirm-challenge route tests.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_2_PLAN.md §2.7 / §4.4 / §7.
 *
 * Closes the door /auth/login opens with a 202 `mfa_setup_required`:
 *
 *   /auth/login                  -> 202 + challengeToken
 *   /auth/mfa/totp/setup-challenge   -> 200 + otpauthUri + secretBase32 (no cookie)
 *   /auth/mfa/totp/confirm-challenge -> 200 + access token + refresh cookie
 *
 * Scenarios:
 *   1. happy path: org-required + not-enrolled login → setup returns
 *      otpauthUri/base32 (no cookie); confirm with valid code → 200 +
 *      access token + cookie; user.mfa_enabled_at set; session.mfa_*
 *      stamps present; challenge consumed.
 *   2. setup without org policy (flipped off mid-flow) → 409
 *      mfa_setup_not_required; challenge unconsumed.
 *   3. setup on already-enrolled user → 409 mfa_already_enrolled; pending
 *      secret untouched.
 *   4. setup called twice → second secret replaces first; confirm only
 *      accepts the latest secret's code.
 *   5. confirm without prior setup → 409 mfa_setup_not_started; challenge
 *      unconsumed.
 *   6. confirm with wrong code → 401 mfa_invalid_code; counter=1; no
 *      enrol; no session; challenge unconsumed; pending secret still
 *      pending.
 *   7. confirm with 5 wrong codes → 5th is 423 mfa_locked + mfa_locked_until
 *      set ~10 min out.
 *   8. confirm with expired challenge → 401 mfa_invalid_challenge.
 *   9. confirm with invalidated challenge → 401 mfa_invalid_challenge.
 *  10. confirm twice (success then retry on consumed) → 2nd is
 *      mfa_invalid_challenge.
 *  11. unknown challenge → 401 mfa_invalid_challenge on both endpoints.
 *  12. error hygiene: bodies never echo raw token / secret bytes /
 *      ciphertext / key.
 *
 * Fixture strategy:
 *   - Acme employee + ORG_ACME, with org.mfa_required forced true before
 *     each scenario. afterEach scrubs MFA fields + challenges + sessions.
 *   - process.env.MFA_SECRET_ENCRYPTION_KEY is set in `before` so the
 *     service-layer loadMfaSecretEncryptionKey() picks it up. Restored
 *     in `after`.
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

// 32-byte deterministic test key for the AES-GCM helper.
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
    await pool.query(
        `UPDATE organizations SET mfa_required = false WHERE id = $1`,
        [ORG_ACME],
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

async function setOrgMfaRequired(orgId, required) {
    await pool.query(
        `UPDATE organizations SET mfa_required = $2 WHERE id = $1`,
        [orgId, required],
    );
}

async function forceUserEnrolled(userId) {
    // Drop-in fixture that puts the user into the post-confirm shape
    // (enabled + secret triple set). We don't go through the real
    // setup/confirm flow because the tests that need this scenario
    // are testing what setup-challenge does when the user is already
    // enrolled.
    await pool.query(
        `UPDATE users
            SET mfa_secret_ciphertext = $2,
                mfa_secret_iv         = $3,
                mfa_secret_tag        = $4,
                mfa_secret_key_version = 1,
                mfa_enabled_at        = now()
          WHERE id = $1`,
        [
            userId,
            Buffer.alloc(32, 1).toString("base64"),
            Buffer.alloc(12, 1).toString("base64"),
            Buffer.alloc(16, 1).toString("base64"),
        ],
    );
}

async function startLoginToGetSetupChallenge() {
    const r = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: ACME_EMP_EMAIL, password: ACME_EMP_PW },
    });
    assert.equal(r.statusCode, 202,
        `setup: /auth/login should yield 202 setup-required, got ${r.statusCode}: ${r.body}`);
    assert.equal(r.json().mfa.kind, "mfa_setup_required",
        "login must hand back a setup-required challenge");
    return r.json().mfa.challengeToken;
}

async function setupChallenge(payload) {
    return app.inject({
        method: "POST",
        url: "/auth/mfa/totp/setup-challenge",
        payload,
    });
}

async function confirmChallenge(payload) {
    return app.inject({
        method: "POST",
        url: "/auth/mfa/totp/confirm-challenge",
        payload,
    });
}

async function readUserMfaState() {
    const r = await pool.query(
        `SELECT mfa_secret_ciphertext, mfa_enabled_at,
                mfa_failed_attempt_count, mfa_locked_until
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

async function readNewestSessionForUser() {
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

function codeForBase32(base32) {
    return generateTotp({ secretBase32: base32 });
}

// =============================================================
//                       HAPPY PATH
// =============================================================

test("setup → confirm happy path: 200 + access token + cookie + user enrolled + session mfa-stamped", async () => {
    await setOrgMfaRequired(ORG_ACME, true);

    const challengeToken = await startLoginToGetSetupChallenge();

    // ---- setup-challenge ----
    const setup = await setupChallenge({ challengeToken });
    assert.equal(setup.statusCode, 200, `setup expected 200, got ${setup.statusCode}: ${setup.body}`);
    const setupBody = setup.json();
    assert.ok(typeof setupBody.otpauthUri === "string");
    assert.ok(setupBody.otpauthUri.startsWith("otpauth://totp/Kloser:"),
        "otpauthUri must use the Kloser issuer label");
    assert.ok(typeof setupBody.secretBase32 === "string");
    assert.ok(/^[A-Z2-7]+=*$/.test(setupBody.secretBase32),
        "secretBase32 must be RFC 4648 base32");
    // No access token / no cookie on the setup response — enrollment
    // isn't complete yet.
    assert.equal(setupBody.accessToken, undefined);
    const setupCookies = setup.headers["set-cookie"];
    if (setupCookies) {
        const arr = Array.isArray(setupCookies) ? setupCookies : [setupCookies];
        assert.ok(!arr.some((c) => c.includes("kloser_refresh=")),
            "setup-challenge must not set the refresh cookie");
    }

    // Pending secret stored, mfa_enabled_at still NULL.
    let userState = await readUserMfaState();
    assert.ok(userState.mfa_secret_ciphertext, "pending secret must be stored");
    assert.equal(userState.mfa_enabled_at, null, "must still be pending after setup");

    // Challenge still unconsumed (confirm-challenge will consume it).
    const challengeAfterSetup = await readChallenge(challengeToken);
    assert.equal(challengeAfterSetup.consumed_at, null);
    assert.equal(challengeAfterSetup.invalidated_at, null);

    // ---- confirm-challenge ----
    const code = codeForBase32(setupBody.secretBase32);
    const confirm = await confirmChallenge({ challengeToken, code });
    assert.equal(confirm.statusCode, 200, `confirm expected 200, got ${confirm.statusCode}: ${confirm.body}`);
    const confirmBody = confirm.json();
    assert.ok(confirmBody.accessToken, "200 body must carry an access token");
    assert.equal(confirmBody.user.id, ACME_EMP);
    assert.equal(confirmBody.organization.id, ORG_ACME);

    // Refresh cookie set.
    const cookies = confirm.headers["set-cookie"];
    assert.ok(cookies);
    const arr = Array.isArray(cookies) ? cookies : [cookies];
    assert.ok(arr.some((c) => c.includes("kloser_refresh=")),
        "confirm must set the refresh cookie");

    // User now enrolled.
    userState = await readUserMfaState();
    assert.ok(userState.mfa_enabled_at, "confirm must flip mfa_enabled_at");
    assert.equal(userState.mfa_failed_attempt_count, 0);

    // Session row carries the MFA stamps.
    const session = await readNewestSessionForUser();
    assert.ok(session);
    assert.ok(session.mfa_verified_at, "session must record mfa_verified_at");
    assert.equal(session.mfa_method, "totp");
    assert.equal(session.revoked_at, null);

    // Challenge consumed.
    const challengeAfterConfirm = await readChallenge(challengeToken);
    assert.ok(challengeAfterConfirm.consumed_at, "confirm must consume the challenge");
    assert.equal(challengeAfterConfirm.invalidated_at, null);
});

// =============================================================
//                       ORG NO LONGER REQUIRED (policy flip race)
// =============================================================

test("setup on a challenge whose org flipped mfa_required off → 409 mfa_setup_not_required", async () => {
    await setOrgMfaRequired(ORG_ACME, true);
    const challengeToken = await startLoginToGetSetupChallenge();

    // Admin flips the policy off after the challenge was minted.
    await setOrgMfaRequired(ORG_ACME, false);

    const setup = await setupChallenge({ challengeToken });
    assert.equal(setup.statusCode, 409, `expected 409, got ${setup.statusCode}: ${setup.body}`);
    assert.equal(setup.json().code, "mfa_setup_not_required");

    // No pending secret stored — rollback path.
    const userState = await readUserMfaState();
    assert.equal(userState.mfa_secret_ciphertext, null);

    // Challenge unconsumed.
    const challenge = await readChallenge(challengeToken);
    assert.equal(challenge.consumed_at, null);
    assert.equal(challenge.invalidated_at, null);
});

// =============================================================
//                       ALREADY-ENROLLED USER → 409
// =============================================================

// =============================================================
//                       CONFIRM AFTER ORG POLICY FLIP — blocked
// =============================================================

test("confirm after org flipped mfa_required off → 409 mfa_setup_not_required; no enroll, no session", async () => {
    await setOrgMfaRequired(ORG_ACME, true);
    const challengeToken = await startLoginToGetSetupChallenge();
    const setupBody = (await setupChallenge({ challengeToken })).json();

    // Admin flips the policy off between setup and confirm.
    await setOrgMfaRequired(ORG_ACME, false);

    // The TOTP code itself is valid against the pending secret.
    const validCode = codeForBase32(setupBody.secretBase32);
    const r = await confirmChallenge({ challengeToken, code: validCode });
    assert.equal(r.statusCode, 409, `expected 409, got ${r.statusCode}: ${r.body}`);
    assert.equal(r.json().code, "mfa_setup_not_required");

    // User NOT enrolled (mfa_enabled_at must stay NULL).
    const userState = await readUserMfaState();
    assert.equal(userState.mfa_enabled_at, null,
        "policy-flip confirm must NOT enable MFA");

    // No session issued.
    const session = await readNewestSessionForUser();
    assert.equal(session, undefined, "policy-flip confirm must not create a session");

    // Challenge unconsumed — transaction rolled back.
    const challenge = await readChallenge(challengeToken);
    assert.equal(challenge.consumed_at, null);
    assert.equal(challenge.invalidated_at, null);

    // Pending secret intentionally preserved (see service comment §6).
    assert.ok(userState.mfa_secret_ciphertext,
        "pending secret is preserved across policy-flip rejection");
});

test("setup on an already-enrolled user → 409 mfa_already_enrolled", async () => {
    // Plant a setup-required challenge by enrolling, getting a challenge,
    // then flipping to enrolled. We need the challenge to exist; force-
    // insert via the service pool so the user is already enrolled at
    // setup time.
    await setOrgMfaRequired(ORG_ACME, true);
    const crypto = await import("node:crypto");
    const rawToken = `phase7-setup-already-${crypto.randomBytes(8).toString("hex")}`;
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    await svc().query(
        `INSERT INTO auth_tokens (org_id, user_id, purpose, token_hash, expires_at)
         VALUES ($1, $2, 'mfa_challenge', $3, now() + interval '5 minutes')`,
        [ORG_ACME, ACME_EMP, tokenHash],
    );
    await forceUserEnrolled(ACME_EMP);

    const setup = await setupChallenge({ challengeToken: rawToken });
    assert.equal(setup.statusCode, 409);
    assert.equal(setup.json().code, "mfa_already_enrolled");

    // Challenge unconsumed.
    const challenge = await readChallenge(rawToken);
    assert.equal(challenge.consumed_at, null);
    assert.equal(challenge.invalidated_at, null);
});

// =============================================================
//                       SETUP TWICE — second secret replaces first
// =============================================================

test("setup called twice → second secret replaces first; only latest code confirms", async () => {
    await setOrgMfaRequired(ORG_ACME, true);
    const challengeToken = await startLoginToGetSetupChallenge();

    const first  = (await setupChallenge({ challengeToken })).json();
    const second = (await setupChallenge({ challengeToken })).json();

    // Different secrets each call.
    assert.notEqual(first.secretBase32, second.secretBase32,
        "second setup must regenerate the secret");

    // Old secret's code should NOT confirm.
    const staleCode = codeForBase32(first.secretBase32);
    const staleConfirm = await confirmChallenge({ challengeToken, code: staleCode });
    assert.equal(staleConfirm.statusCode, 401, `stale-secret confirm expected 401, got ${staleConfirm.statusCode}`);
    assert.equal(staleConfirm.json().code, "mfa_invalid_code");

    // Counter advanced by the stale attempt.
    let userState = await readUserMfaState();
    assert.equal(userState.mfa_failed_attempt_count, 1);

    // New secret's code DOES confirm.
    const goodCode = codeForBase32(second.secretBase32);
    const goodConfirm = await confirmChallenge({ challengeToken, code: goodCode });
    assert.equal(goodConfirm.statusCode, 200, `fresh-secret confirm expected 200, got ${goodConfirm.statusCode}: ${goodConfirm.body}`);

    userState = await readUserMfaState();
    assert.ok(userState.mfa_enabled_at);
    assert.equal(userState.mfa_failed_attempt_count, 0,
        "successful confirm must reset the failed counter");
});

// =============================================================
//                       CONFIRM WITHOUT SETUP
// =============================================================

test("confirm without prior setup → 409 mfa_setup_not_started; challenge unconsumed", async () => {
    await setOrgMfaRequired(ORG_ACME, true);
    const challengeToken = await startLoginToGetSetupChallenge();

    // No setup call — pending secret is NULL.
    const r = await confirmChallenge({ challengeToken, code: "123456" });
    assert.equal(r.statusCode, 409, `expected 409, got ${r.statusCode}: ${r.body}`);
    assert.equal(r.json().code, "mfa_setup_not_started");

    const challenge = await readChallenge(challengeToken);
    assert.equal(challenge.consumed_at, null);
});

// =============================================================
//                       WRONG CODE — counter + no consume
// =============================================================

test("confirm with wrong code → 401 mfa_invalid_code; counter=1; no session; no enrol", async () => {
    await setOrgMfaRequired(ORG_ACME, true);
    const challengeToken = await startLoginToGetSetupChallenge();
    await setupChallenge({ challengeToken });

    const r = await confirmChallenge({ challengeToken, code: "000000" });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().code, "mfa_invalid_code");

    const userState = await readUserMfaState();
    assert.equal(userState.mfa_enabled_at, null, "wrong code must not enrol");
    assert.equal(userState.mfa_failed_attempt_count, 1);
    assert.ok(userState.mfa_secret_ciphertext,
        "pending secret must survive a wrong-code attempt");

    const session = await readNewestSessionForUser();
    assert.equal(session, undefined, "no session must be created on wrong code");

    const challenge = await readChallenge(challengeToken);
    assert.equal(challenge.consumed_at, null);
});

// =============================================================
//                       LOCKOUT — 5 wrong codes → mfa_locked
// =============================================================

test("5 wrong confirm codes → 5th is 423 mfa_locked + mfa_locked_until set ~10 min out", async () => {
    await setOrgMfaRequired(ORG_ACME, true);
    const challengeToken = await startLoginToGetSetupChallenge();
    await setupChallenge({ challengeToken });

    for (let i = 1; i <= 4; i++) {
        const r = await confirmChallenge({ challengeToken, code: "000000" });
        assert.equal(r.statusCode, 401, `attempt ${i} expected 401, got ${r.statusCode}: ${r.body}`);
        assert.equal(r.json().code, "mfa_invalid_code");
    }
    const before = Date.now();
    const r5 = await confirmChallenge({ challengeToken, code: "000000" });
    assert.equal(r5.statusCode, 423, `5th attempt expected 423, got ${r5.statusCode}: ${r5.body}`);
    assert.equal(r5.json().code, "mfa_locked");

    const userState = await readUserMfaState();
    assert.equal(userState.mfa_failed_attempt_count, 5);
    assert.ok(userState.mfa_locked_until);
    const lockoutMs = userState.mfa_locked_until.getTime() - before;
    assert.ok(lockoutMs > 9 * 60 * 1000 + 50_000, `lockout window too short: ${lockoutMs}ms`);
    assert.ok(lockoutMs < 10 * 60 * 1000 + 5_000, `lockout window too long: ${lockoutMs}ms`);
});

// =============================================================
//                       EXPIRED / INVALIDATED / CONSUMED / UNKNOWN CHALLENGE
// =============================================================

test("setup + confirm on expired challenge → 401 mfa_invalid_challenge", async () => {
    await setOrgMfaRequired(ORG_ACME, true);
    const challengeToken = await startLoginToGetSetupChallenge();

    // Backdate expiry past now.
    await svc().query(
        `UPDATE auth_tokens
            SET expires_at = now() - interval '1 minute'
          WHERE token_hash = (SELECT encode(digest($1, 'sha256'), 'hex'))
            AND purpose = 'mfa_challenge'`,
        [challengeToken],
    );

    const setup = await setupChallenge({ challengeToken });
    assert.equal(setup.statusCode, 401);
    assert.equal(setup.json().code, "mfa_invalid_challenge");

    const confirm = await confirmChallenge({ challengeToken, code: "123456" });
    assert.equal(confirm.statusCode, 401);
    assert.equal(confirm.json().code, "mfa_invalid_challenge");
});

test("setup + confirm on invalidated challenge → 401 mfa_invalid_challenge", async () => {
    await setOrgMfaRequired(ORG_ACME, true);
    const challengeToken = await startLoginToGetSetupChallenge();

    await svc().query(
        `UPDATE auth_tokens
            SET invalidated_at = now()
          WHERE token_hash = (SELECT encode(digest($1, 'sha256'), 'hex'))
            AND purpose = 'mfa_challenge'`,
        [challengeToken],
    );

    const setup = await setupChallenge({ challengeToken });
    assert.equal(setup.statusCode, 401);
    assert.equal(setup.json().code, "mfa_invalid_challenge");

    const confirm = await confirmChallenge({ challengeToken, code: "123456" });
    assert.equal(confirm.statusCode, 401);
    assert.equal(confirm.json().code, "mfa_invalid_challenge");
});

test("confirm twice on same challenge → second call is mfa_invalid_challenge", async () => {
    await setOrgMfaRequired(ORG_ACME, true);
    const challengeToken = await startLoginToGetSetupChallenge();
    const setup = (await setupChallenge({ challengeToken })).json();

    const ok = await confirmChallenge({
        challengeToken,
        code: codeForBase32(setup.secretBase32),
    });
    assert.equal(ok.statusCode, 200);

    // Second call on a consumed challenge fails — challenge is one-shot.
    const again = await confirmChallenge({
        challengeToken,
        code: codeForBase32(setup.secretBase32),
    });
    assert.equal(again.statusCode, 401);
    assert.equal(again.json().code, "mfa_invalid_challenge");
});

test("unknown challenge token → 401 mfa_invalid_challenge on both endpoints", async () => {
    const setup = await setupChallenge({
        challengeToken: "phase7-setup-bogus-deadbeef",
    });
    assert.equal(setup.statusCode, 401);
    assert.equal(setup.json().code, "mfa_invalid_challenge");

    const confirm = await confirmChallenge({
        challengeToken: "phase7-confirm-bogus-deadbeef",
        code: "123456",
    });
    assert.equal(confirm.statusCode, 401);
    assert.equal(confirm.json().code, "mfa_invalid_challenge");
});

// =============================================================
//                       ERROR MESSAGE HYGIENE
// =============================================================

test("error responses never echo raw challenge / secret / ciphertext / key", async () => {
    await setOrgMfaRequired(ORG_ACME, true);
    const challengeToken = await startLoginToGetSetupChallenge();
    const setup = (await setupChallenge({ challengeToken })).json();
    const secretB32 = setup.secretBase32;
    const keyB64    = TEST_KEY.toString("base64");

    const bodies = [];

    // Branch A: wrong code path.
    bodies.push((await confirmChallenge({
        challengeToken,
        code: "000000",
    })).body);

    // Branch B: unknown challenge on confirm.
    bodies.push((await confirmChallenge({
        challengeToken: "phase7-hygiene-bogus",
        code: "123456",
    })).body);

    // Branch C: unknown challenge on setup.
    bodies.push((await setupChallenge({
        challengeToken: "phase7-hygiene-bogus-setup",
    })).body);

    // Read the stored ciphertext to assert no error body contains the
    // raw bytes (base64) the server is keeping in the row.
    const dbRow = await pool.query(
        `SELECT mfa_secret_ciphertext FROM users WHERE id = $1`,
        [ACME_EMP],
    );
    const ctSubstring = dbRow.rows[0].mfa_secret_ciphertext;

    for (const body of bodies) {
        assert.ok(typeof body === "string");
        assert.ok(!body.includes(challengeToken),
            "error body must not echo the raw challenge token");
        assert.ok(!body.includes(secretB32),
            "error body must not echo the base32 secret");
        assert.ok(!body.includes(ctSubstring),
            "error body must not echo the stored ciphertext");
        assert.ok(!body.includes(keyB64),
            "error body must not echo the MFA encryption key");
    }
});

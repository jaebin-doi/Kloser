/* Phase 7 Step 3 — service-pool (anonymous login-time) MFA audit hook
 * integration tests.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_3_PLAN.md §7.1.
 *
 * Scope (this commit closes):
 *   - mfa.login_verified                  (verifyLoginMfa success)
 *   - mfa.failed_attempt                  (verifyLoginMfa + confirmLogin
 *                                          MfaChallenge wrong code)
 *   - mfa.locked                          (same, ONLY on threshold-trip)
 *   - mfa.setup_started                   (setupLoginMfaChallenge,
 *                                          flow="login_challenge")
 *   - mfa.enabled                         (confirmLoginMfaChallenge
 *                                          success, login-time flow)
 *
 * These all run on the BYPASSRLS servicePool whose role
 * (`kloser_service`) has INSERT-only privilege on `activity_log`
 * (migration `1715000025000_phase7_activity_log_service_insert_grant.sql`).
 * The hook code uses `recordActivityVoid()` instead of `recordActivity()`
 * so the RETURNING clause (which would require SELECT) is dropped.
 *
 * Sensitive-value invariants asserted on every recorded row:
 *   - payload never contains the raw challenge token
 *   - payload never contains the user-typed TOTP code
 *   - payload never contains base32 secret / otpauth URI / ciphertext
 *   - payload never contains a password / refresh token / session token
 *
 * Fixture strategy:
 *   - Per-test wipe of MFA state, sessions, auth_tokens, activity_log
 *     for our seed fixtures in both orgs (mirrors phase7_step3_security_
 *     audit_hooks.test.mjs).
 *   - Production hook payloads don't carry our run id; cleanup sweeps
 *     by actor / target uuid match against the seed fixtures.
 *
 * Run: cd server && npm test
 */
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { Buffer } from "node:buffer";
import { pool } from "../src/db/pool.js";
import { getServicePool } from "../src/db/servicePool.js";
import dbPlugin from "../src/plugins/db.js";
import {
    confirmLoginMfaChallenge,
    login,
    setupLoginMfaChallenge,
    verifyLoginMfa,
} from "../src/services/auth.js";
import { insertActivityVoid } from "../src/repositories/activityLog.js";
import { generateTotpSecret } from "../src/services/totp.js";
import { encryptMfaSecret, loadMfaSecretEncryptionKey } from "../src/services/mfaSecretEncryption.js";

const ORG_ACME = "11111111-1111-1111-1111-111111111111";
const ORG_BETA = "22222222-2222-2222-2222-222222222222";
const ACME_ADMIN = "aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa";
const ACME_EMP   = "aaaaaaaa-0002-0002-0002-aaaaaaaaaaaa";
const BETA_ADMIN = "bbbbbbbb-0001-0001-0001-bbbbbbbbbbbb";

const ACME_ADMIN_EMAIL = "admin@acme.test";
const ACME_ADMIN_PW    = "acme-admin-1234";

let app;

before(async () => {
    app = Fastify({ logger: false });
    await app.register(dbPlugin);
});

after(async () => {
    await wipePerTestState();
    await app.close();
});

async function wipePerTestState() {
    await pool.query(
        `UPDATE users
            SET mfa_secret_ciphertext = NULL,
                mfa_secret_iv         = NULL,
                mfa_secret_tag        = NULL,
                mfa_secret_key_version = 1,
                mfa_enabled_at        = NULL,
                mfa_failed_attempt_count = 0,
                mfa_locked_until      = NULL
          WHERE id IN ($1, $2, $3)`,
        [ACME_ADMIN, ACME_EMP, BETA_ADMIN],
    );
    await pool.query(
        `UPDATE organizations SET mfa_required = false WHERE id IN ($1, $2)`,
        [ORG_ACME, ORG_BETA],
    );
    await pool.query(
        `DELETE FROM sessions WHERE user_id IN ($1, $2, $3)`,
        [ACME_ADMIN, ACME_EMP, BETA_ADMIN],
    );
    await pool.query(
        `DELETE FROM auth_tokens WHERE user_id IN ($1, $2, $3) OR org_id IN ($4, $5)`,
        [ACME_ADMIN, ACME_EMP, BETA_ADMIN, ORG_ACME, ORG_BETA],
    );
    for (const orgId of [ORG_ACME, ORG_BETA]) {
        await app.withOrgContext(orgId, async (client) => {
            await client.query(
                `DELETE FROM activity_log
                  WHERE user_id  = ANY($1::uuid[])
                     OR target_id = ANY($2::uuid[])`,
                [
                    [ACME_ADMIN, ACME_EMP, BETA_ADMIN],
                    [ACME_ADMIN, ACME_EMP, BETA_ADMIN, ORG_ACME, ORG_BETA],
                ],
            );
        });
    }
}

beforeEach(wipePerTestState);
afterEach(wipePerTestState);

// ---------------------------------------------------------------------- //
// helpers
// ---------------------------------------------------------------------- //

/** RFC 6238 TOTP at the current 30s window — used to produce codes
 *  the production verifyTotp will accept for a known plaintext secret. */
function totpAtNow(secretBase32) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = "";
    for (const ch of secretBase32.replace(/=+$/, "")) {
        bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
    }
    const bytes = Buffer.alloc(bits.length >> 3);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
    }
    const counter = Math.floor(Date.now() / 1000 / 30);
    const cb = Buffer.alloc(8);
    cb.writeUInt32BE(0, 0);
    cb.writeUInt32BE(counter, 4);
    const h = crypto.createHmac("sha1", bytes).update(cb).digest();
    const off = h[h.length - 1] & 0xf;
    const bin = ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16)
              | ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff);
    return String(bin % 1000000).padStart(6, "0");
}

/** Plant a known encrypted TOTP secret + mark MFA enabled. Returns the
 *  plaintext base32 secret so the test can produce valid codes. */
async function plantMfaSecret(userId) {
    const secret = generateTotpSecret();
    const key = loadMfaSecretEncryptionKey();
    const wrapped = encryptMfaSecret(secret.raw, key);
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
        [userId, wrapped.ciphertext, wrapped.iv, wrapped.tag],
    );
    return secret.base32;
}

/** Find audit rows in the given org by (action, target_id). */
async function findAuditRows(orgId, action, targetId) {
    let rows;
    await app.withOrgContext(orgId, async (client) => {
        const r = await client.query(
            `SELECT id, org_id, user_id, action, target_type, target_id,
                    payload, created_at
               FROM activity_log
              WHERE action = $1 AND target_id = $2
              ORDER BY created_at DESC, id DESC`,
            [action, targetId],
        );
        rows = r.rows;
    });
    return rows;
}

function assertNoSensitiveValues(rows, sensitiveValues) {
    for (const row of rows) {
        const payloadStr = JSON.stringify(row.payload);
        for (const v of sensitiveValues) {
            if (!v) continue;
            assert.ok(
                !payloadStr.includes(v),
                `audit payload must not echo sensitive value (action=${row.action})`,
            );
        }
    }
}

/** Drive POST /auth/login to get a fresh mfa_challenge raw token for the
 *  target user — used to seed verifyLoginMfa / setup-challenge tests. */
async function loginAndGetChallenge() {
    const result = await login({
        email:    ACME_ADMIN_EMAIL,
        password: ACME_ADMIN_PW,
    });
    return result;
}

// ====================================================================== //
//        repository contract: insertActivityVoid works on kloser_service
// ====================================================================== //

test("insertActivityVoid works with INSERT-only kloser_service role (no SELECT needed)", async () => {
    // Drive through the actual servicePool — the same pool the login-
    // time MFA flows use — so the test exercises the privilege boundary
    // this work just established.
    const sp = getServicePool();
    const client = await sp.connect();
    try {
        await client.query("BEGIN");
        await insertActivityVoid(client, {
            orgId:      ORG_ACME,
            userId:     ACME_ADMIN,
            action:     "auth.login",
            targetType: "user",
            targetId:   ACME_ADMIN,
            payload:    { probe: "void-helper" },
        });
        await client.query("COMMIT");
    } finally {
        client.release();
    }

    // Read back via app pool (which DOES have SELECT) to verify the row
    // actually persisted.
    const rows = await findAuditRows(ORG_ACME, "auth.login", ACME_ADMIN);
    assert.ok(rows.length >= 1, "insertActivityVoid row must be persistent");
    assert.equal(rows[0].payload.probe, "void-helper");
});

// ====================================================================== //
//                         verifyLoginMfa
// ====================================================================== //

test("verifyLoginMfa success creates mfa.login_verified row (target=session, payload={method})", async () => {
    const secretBase32 = await plantMfaSecret(ACME_ADMIN);
    const loginResult = await loginAndGetChallenge();
    assert.equal(loginResult.kind, "mfa_required");

    const code = totpAtNow(secretBase32);
    const auth = await verifyLoginMfa({
        challengeToken: loginResult.challengeToken,
        code,
    });
    assert.ok(auth.session.id, "session must be minted");

    const rows = await findAuditRows(
        ORG_ACME, "mfa.login_verified", auth.session.id,
    );
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.user_id, ACME_ADMIN);
    assert.equal(row.target_type, "session");
    assert.equal(row.target_id, auth.session.id);
    assert.equal(row.payload.method, "totp");
    assertNoSensitiveValues(rows, [
        loginResult.challengeToken,
        secretBase32,
        code,
        ACME_ADMIN_PW,
        auth.refreshToken,
    ]);
});

test("verifyLoginMfa wrong code creates mfa.failed_attempt (flow=login_verify, no sensitive values)", async () => {
    const secretBase32 = await plantMfaSecret(ACME_ADMIN);
    const loginResult = await loginAndGetChallenge();
    assert.equal(loginResult.kind, "mfa_required");

    const wrongCode = "000000";
    await assert.rejects(
        () => verifyLoginMfa({
            challengeToken: loginResult.challengeToken,
            code:           wrongCode,
        }),
        (err) => err && err.code === "mfa_invalid_code",
    );

    const rows = await findAuditRows(ORG_ACME, "mfa.failed_attempt", ACME_ADMIN);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.payload.flow, "login_verify");
    assert.equal(row.payload.failed_attempt_count, 1);
    assertNoSensitiveValues(rows, [
        wrongCode, secretBase32, loginResult.challengeToken, ACME_ADMIN_PW,
    ]);

    // No locked row at count=1.
    const locked = await findAuditRows(ORG_ACME, "mfa.locked", ACME_ADMIN);
    assert.equal(locked.length, 0);
});

test("verifyLoginMfa 5th wrong creates exactly one mfa.locked (no further on retry)", async () => {
    const secretBase32 = await plantMfaSecret(ACME_ADMIN);
    const loginResult = await loginAndGetChallenge();

    // 5 wrong attempts — the same challenge token survives wrong codes
    // (it is NOT consumed on failure per plan §4.4 / §2.3).
    for (let i = 1; i <= 5; i++) {
        await assert.rejects(
            () => verifyLoginMfa({
                challengeToken: loginResult.challengeToken,
                code:           "000000",
            }),
            (err) => err && (err.code === "mfa_invalid_code" || err.code === "mfa_locked"),
            `attempt ${i} must reject`,
        );
    }

    const failed = await findAuditRows(ORG_ACME, "mfa.failed_attempt", ACME_ADMIN);
    assert.equal(failed.length, 5);
    const counts = failed.map((r) => r.payload.failed_attempt_count).sort((a, b) => a - b);
    assert.deepEqual(counts, [1, 2, 3, 4, 5]);
    for (const r of failed) assert.equal(r.payload.flow, "login_verify");

    const locked = await findAuditRows(ORG_ACME, "mfa.locked", ACME_ADMIN);
    assert.equal(locked.length, 1, "mfa.locked must fire exactly once");
    assert.equal(locked[0].payload.flow, "login_verify");
    assert.ok(locked[0].payload.locked_until);

    // 6th attempt while locked → throws 423 mfa_locked at the early
    // "lockout still in effect" gate, NO new failed_attempt + NO new
    // locked row.
    await assert.rejects(
        () => verifyLoginMfa({
            challengeToken: loginResult.challengeToken,
            code:           "000000",
        }),
        (err) => err && err.code === "mfa_locked",
    );
    const failedAfter = await findAuditRows(ORG_ACME, "mfa.failed_attempt", ACME_ADMIN);
    assert.equal(failedAfter.length, 5);
    const lockedAfter = await findAuditRows(ORG_ACME, "mfa.locked", ACME_ADMIN);
    assert.equal(lockedAfter.length, 1);
});

// ====================================================================== //
//                         setupLoginMfaChallenge
// ====================================================================== //

test("setupLoginMfaChallenge creates mfa.setup_started (flow=login_challenge, no secret values)", async () => {
    // Org requires MFA + admin user has NOT enrolled — that's the
    // setup-challenge precondition.
    await pool.query(
        `UPDATE organizations SET mfa_required = true WHERE id = $1`,
        [ORG_ACME],
    );

    const loginResult = await loginAndGetChallenge();
    assert.equal(loginResult.kind, "mfa_setup_required");

    const setup = await setupLoginMfaChallenge({
        challengeToken: loginResult.challengeToken,
    });
    assert.ok(setup.secretBase32);
    assert.ok(setup.otpauthUri);

    const rows = await findAuditRows(ORG_ACME, "mfa.setup_started", ACME_ADMIN);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.user_id, ACME_ADMIN);
    assert.equal(row.target_type, "user");
    assert.equal(row.payload.flow, "login_challenge");
    assert.equal(row.payload.method, "totp");
    assertNoSensitiveValues(rows, [
        setup.secretBase32, setup.otpauthUri,
        loginResult.challengeToken, ACME_ADMIN_PW,
    ]);
});

// ====================================================================== //
//                         confirmLoginMfaChallenge
// ====================================================================== //

test("confirmLoginMfaChallenge success creates mfa.enabled (target=user, payload={method})", async () => {
    await pool.query(
        `UPDATE organizations SET mfa_required = true WHERE id = $1`,
        [ORG_ACME],
    );

    const loginResult = await loginAndGetChallenge();
    const setup = await setupLoginMfaChallenge({
        challengeToken: loginResult.challengeToken,
    });
    const code = totpAtNow(setup.secretBase32);
    const auth = await confirmLoginMfaChallenge({
        challengeToken: loginResult.challengeToken,
        code,
    });
    assert.ok(auth.session.id);

    const rows = await findAuditRows(ORG_ACME, "mfa.enabled", ACME_ADMIN);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.user_id, ACME_ADMIN);
    assert.equal(row.target_type, "user");
    assert.equal(row.target_id, ACME_ADMIN);
    assert.equal(row.payload.method, "totp");
    assertNoSensitiveValues(rows, [
        code, setup.secretBase32, setup.otpauthUri,
        loginResult.challengeToken, ACME_ADMIN_PW, auth.refreshToken,
    ]);
});

test("confirmLoginMfaChallenge wrong code creates mfa.failed_attempt (flow=login_setup_confirm)", async () => {
    await pool.query(
        `UPDATE organizations SET mfa_required = true WHERE id = $1`,
        [ORG_ACME],
    );

    const loginResult = await loginAndGetChallenge();
    await setupLoginMfaChallenge({
        challengeToken: loginResult.challengeToken,
    });

    await assert.rejects(
        () => confirmLoginMfaChallenge({
            challengeToken: loginResult.challengeToken,
            code:           "000000",
        }),
        (err) => err && err.code === "mfa_invalid_code",
    );

    const rows = await findAuditRows(ORG_ACME, "mfa.failed_attempt", ACME_ADMIN);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].payload.flow, "login_setup_confirm");
    assert.equal(rows[0].payload.failed_attempt_count, 1);
    assertNoSensitiveValues(rows, ["000000", loginResult.challengeToken, ACME_ADMIN_PW]);

    const locked = await findAuditRows(ORG_ACME, "mfa.locked", ACME_ADMIN);
    assert.equal(locked.length, 0);
});

test("confirmLoginMfaChallenge 5th wrong creates exactly one mfa.locked", async () => {
    await pool.query(
        `UPDATE organizations SET mfa_required = true WHERE id = $1`,
        [ORG_ACME],
    );

    const loginResult = await loginAndGetChallenge();
    await setupLoginMfaChallenge({
        challengeToken: loginResult.challengeToken,
    });

    for (let i = 1; i <= 5; i++) {
        await assert.rejects(
            () => confirmLoginMfaChallenge({
                challengeToken: loginResult.challengeToken,
                code:           "000000",
            }),
            (err) => err && (err.code === "mfa_invalid_code" || err.code === "mfa_locked"),
            `attempt ${i} must reject`,
        );
    }

    const failed = await findAuditRows(ORG_ACME, "mfa.failed_attempt", ACME_ADMIN);
    assert.equal(failed.length, 5);
    for (const r of failed) assert.equal(r.payload.flow, "login_setup_confirm");

    const locked = await findAuditRows(ORG_ACME, "mfa.locked", ACME_ADMIN);
    assert.equal(locked.length, 1);
    assert.equal(locked[0].payload.flow, "login_setup_confirm");
    assert.ok(locked[0].payload.locked_until);
});

// ====================================================================== //
//                         RLS visibility
// ====================================================================== //

test("service-pool-written audit row is visible to app/admin in the same org", async () => {
    const secretBase32 = await plantMfaSecret(ACME_ADMIN);
    const loginResult = await loginAndGetChallenge();
    const auth = await verifyLoginMfa({
        challengeToken: loginResult.challengeToken,
        code:           totpAtNow(secretBase32),
    });

    // We just read via findAuditRows, which uses withOrgContext on the
    // app pool. Reconfirm the same row id is selectable from the same
    // org context (positive control), and NOT selectable from Beta.
    const acmeRows = await findAuditRows(
        ORG_ACME, "mfa.login_verified", auth.session.id,
    );
    assert.equal(acmeRows.length, 1);
    const rowId = acmeRows[0].id;

    let betaRows;
    await app.withOrgContext(ORG_BETA, async (client) => {
        const r = await client.query(
            `SELECT id FROM activity_log WHERE id = $1`,
            [rowId],
        );
        betaRows = r.rows;
    });
    assert.equal(betaRows.length, 0, "Beta must not see Acme's audit row");
});

// ====================================================================== //
//        Repository-level: audit failure rolls back the same-tx INSERT
// ====================================================================== //

test("insertActivityVoid throw inside servicePool tx rolls back prior service-pool writes", async () => {
    // This is the contract that gives "audit failure aborts the
    // service-pool mutation" its teeth. We can't easily monkey-patch
    // the production hook to force a CHECK violation, so we exercise
    // the equivalent unit-level invariant: insert two rows in one
    // tx, throw a CHECK violation on the second, ROLLBACK on the
    // outer wrapper, then confirm neither row landed.
    const sp = getServicePool();
    const client = await sp.connect();
    let firstError;
    try {
        await client.query("BEGIN");
        await insertActivityVoid(client, {
            orgId:   ORG_ACME,
            userId:  ACME_ADMIN,
            action:  "auth.login",
            payload: { probe: "rollback-survivor" },
        });
        // Force a CHECK failure on the second insert by going around
        // the repository to send an invalid action.
        try {
            await client.query(
                `INSERT INTO activity_log (org_id, action, payload)
                 VALUES ($1, 'this.is.not.a.real.action', '{}'::jsonb)`,
                [ORG_ACME],
            );
        } catch (err) {
            firstError = err;
            await client.query("ROLLBACK");
        }
    } finally {
        client.release();
    }
    assert.ok(firstError, "the bad insert must have thrown");

    // Neither the "rollback-survivor" probe nor any audit row from
    // this tx should remain.
    const rows = await findAuditRows(ORG_ACME, "auth.login", ACME_ADMIN);
    const probe = rows.filter((r) => r.payload.probe === "rollback-survivor");
    assert.equal(probe.length, 0,
        "first audit insert must roll back when a later same-tx write fails");
});

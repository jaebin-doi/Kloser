/* Phase 7 Step 3 — security/MFA/org audit hook integration tests.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_3_PLAN.md §7.1.
 *
 * Scope (this commit's wiring):
 *   - auth.refresh_mfa_required          (refresh() MFA gate)
 *   - mfa.login_challenge_issued          (login(), app pool)
 *   - mfa.setup_started                   (startAuthenticatedTotpSetup)
 *   - mfa.enabled                         (confirmAuthenticatedTotp)
 *   - mfa.disabled                        (disableTotp)
 *   - mfa.failed_attempt                  (confirmAuthenticatedTotp + disableTotp)
 *   - mfa.locked                          (same, ONLY on threshold-trip)
 *   - organization.mfa_required_enabled  / _disabled
 *
 * Intentionally NOT covered here (service-pool flows — defer to next
 * commit per residual risk):
 *   - mfa.login_verified                  (verifyLoginMfa, service pool)
 *   - mfa.setup_started for login         (setupLoginMfaChallenge)
 *   - mfa.enabled for login confirm       (confirmLoginMfaChallenge)
 *   - mfa.failed_attempt / mfa.locked  for the two service-pool flows
 *
 * Sensitive-value invariants asserted on EVERY recorded row:
 *   - payload never contains the raw challenge token string
 *   - payload never contains the user-typed TOTP code
 *   - payload never contains base32 secret / otpauth URI
 *   - payload never contains a refresh / session bearer token
 *
 * Fixture strategy:
 *   - Per-test `TEST_RUN_ID` + `_test_run` payload tag, like the other
 *     Phase 7 Step 3 test files. The after-hook deletes only this
 *     suite's rows.
 *   - Hook payloads are produced by production code (so they don't
 *     carry our tag). We capture them by `(action, target_id)` queries
 *     using freshly-generated uuids for everything that can have one.
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
import dbPlugin from "../src/plugins/db.js";
import authPlugin from "../src/plugins/auth.js";
import authRoutes from "../src/routes/auth.js";
import meRoutes from "../src/routes/me.js";
import organizationSecurityRoutes from "../src/routes/organizationSecurity.js";
import {
    confirmAuthenticatedTotp,
    disableTotp,
    login,
    refresh,
    startAuthenticatedTotpSetup,
} from "../src/services/auth.js";
import { setOrganizationMfaRequired } from "../src/services/organizationSecurity.js";
import { generateTotpSecret } from "../src/services/totp.js";
import { encryptMfaSecret, loadMfaSecretEncryptionKey } from "../src/services/mfaSecretEncryption.js";

const ORG_ACME = "11111111-1111-1111-1111-111111111111";
const ORG_BETA = "22222222-2222-2222-2222-222222222222";
const ACME_ADMIN = "aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa";
const ACME_EMP   = "aaaaaaaa-0002-0002-0002-aaaaaaaaaaaa";
const ACME_ADMIN_MEMBERSHIP = "cccccccc-0001-0001-0001-cccccccccccc";
const ACME_EMP_MEMBERSHIP   = "cccccccc-0002-0002-0002-cccccccccccc";
const BETA_ADMIN = "bbbbbbbb-0001-0001-0001-bbbbbbbbbbbb";

const ACME_ADMIN_EMAIL = "admin@acme.test";
const ACME_ADMIN_PW    = "acme-admin-1234";

// Suite fingerprint — appended to every audit row we want to clean up
// AFTER it lands. Production audit payloads don't carry the tag (the
// hook code doesn't know about us), so we DELETE rows by action + a
// disposable target_id we mint inside each test. The fingerprint is
// here as a last-resort sweep filter against rows we manually scrubbed
// into a tagged shape.
const TEST_RUN_ID = `phase7-step3-hooks-${randomUUID()}`;

// Set of audit row ids to sweep in the after-hook. Tests push freshly-
// inserted ids here so cleanup is exact even when many rows pile up.
const ROWS_TO_DELETE = new Set();

let app;

before(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    await app.register(dbPlugin);
    await app.register(authRoutes);
    await app.register(meRoutes);
    await app.register(organizationSecurityRoutes);
});

after(async () => {
    // Cleanup: drop any audit rows we asked to be cleaned + any rows
    // tagged with our run id (sweep). FORCE RLS — go through org
    // context for both orgs we may have written to.
    for (const orgId of [ORG_ACME, ORG_BETA]) {
        try {
            await app.withOrgContext(orgId, async (client) => {
                if (ROWS_TO_DELETE.size > 0) {
                    await client.query(
                        `DELETE FROM activity_log WHERE id = ANY($1::uuid[])`,
                        [Array.from(ROWS_TO_DELETE)],
                    );
                }
                await client.query(
                    `DELETE FROM activity_log
                       WHERE payload->>'_test_run' = $1`,
                    [TEST_RUN_ID],
                );
            });
        } catch (_) { /* best-effort */ }
    }
    // Restore admin/employee MFA + org flags + memberships.
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
    await app.close();
});

// Per-test isolation. We delete every activity_log row whose
// actor / target id matches one of our test fixtures, in both orgs.
// FORCE RLS means the DELETE has to run under withOrgContext.
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
    // Wipe activity_log rows tied to our test fixtures — production
    // hook code does NOT carry our TEST_RUN_ID tag, so we sweep by
    // any row whose user_id or target_id matches our seed UUIDs.
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

function totpAtNow(secretBase32) {
    // Same RFC-6238 stepping as services/totp.ts at counter=floor(now/30s).
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

/** Plant a real, decryptable TOTP secret on a user via direct DB writes —
 *  bypasses startAuthenticatedTotpSetup so the test can drive confirm/
 *  disable without depending on the setup hook under test. Returns the
 *  base32 secret so the test can produce valid TOTP codes. */
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

/** Run a function under a session created directly via the sessions
 *  table — bypass /auth/login so the test can stamp `mfa_verified_at`
 *  exactly the way it needs. Returns the session id (used as
 *  input.sessionId for confirmAuthenticatedTotp). */
async function plantSession(userId, orgId, membershipId, { mfaVerified = false } = {}) {
    const r = await pool.query(
        `INSERT INTO sessions (
            user_id, org_id, membership_id,
            refresh_token_hash, token_family_id,
            expires_at,
            mfa_verified_at, mfa_method
         ) VALUES (
            $1, $2, $3,
            $4, gen_random_uuid(),
            now() + interval '30 days',
            $5, $6
         )
         RETURNING id`,
        [
            userId, orgId, membershipId,
            crypto.createHash("sha256").update(crypto.randomBytes(32)).digest("hex"),
            mfaVerified ? new Date() : null,
            mfaVerified ? "totp" : null,
        ],
    );
    return r.rows[0].id;
}

/** Issue a real refresh token for the user (plants the session +
 *  returns the raw token string). Used by the refresh() audit test. */
async function plantRefreshSession(userId, orgId, membershipId, { mfaVerified = false } = {}) {
    const raw = crypto.randomBytes(32).toString("hex");
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    const r = await pool.query(
        `INSERT INTO sessions (
            user_id, org_id, membership_id,
            refresh_token_hash, token_family_id,
            expires_at,
            mfa_verified_at, mfa_method
         ) VALUES (
            $1, $2, $3, $4, gen_random_uuid(),
            now() + interval '30 days',
            $5, $6
         )
         RETURNING id`,
        [
            userId, orgId, membershipId, hash,
            mfaVerified ? new Date() : null,
            mfaVerified ? "totp" : null,
        ],
    );
    return { sessionId: r.rows[0].id, refreshToken: raw };
}

/** Look up an auth_tokens row by sha256 hash of the raw token. The
 *  table is FORCE RLS so the SELECT must run under withOrgContext. */
async function findAuthTokenIdByRaw(orgId, rawToken) {
    const hash = crypto.createHash("sha256").update(rawToken).digest("hex");
    let id;
    await app.withOrgContext(orgId, async (client) => {
        const r = await client.query(
            `SELECT id FROM auth_tokens WHERE token_hash = $1`,
            [hash],
        );
        id = r.rows[0]?.id;
    });
    return id;
}

/** Find audit rows in the given org by (action, target_id), newest
 *  first. Adds them to the cleanup set so the after-hook removes them. */
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
    for (const row of rows) ROWS_TO_DELETE.add(row.id);
    return rows;
}

/** Assert that none of the typical sensitive substrings appear in
 *  the JSON-stringified payload of any row. */
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

// ====================================================================== //
//                     auth.refresh_mfa_required
// ====================================================================== //

test("refresh MFA gate blocked → auth.refresh_mfa_required row, no raw token in payload", async () => {
    // Set up: user MFA enabled (so MFA gate trips), refresh session has
    // NOT been MFA-verified. Refresh must throw 401 mfa_required AND
    // leave an audit row.
    await plantMfaSecret(ACME_ADMIN);
    const { sessionId, refreshToken } = await plantRefreshSession(
        ACME_ADMIN, ORG_ACME, ACME_ADMIN_MEMBERSHIP,
        { mfaVerified: false },
    );

    await assert.rejects(
        () => refresh(refreshToken),
        (err) => err && err.statusCode === 401 && err.code === "mfa_required",
    );

    const rows = await findAuditRows(
        ORG_ACME, "auth.refresh_mfa_required", sessionId,
    );
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.org_id, ORG_ACME);
    assert.equal(row.user_id, ACME_ADMIN);
    assert.equal(row.target_type, "session");
    assert.equal(row.target_id, sessionId);
    // payload carries reason only, NEVER the refresh/session token.
    assert.equal(row.payload.reason, "user_mfa_enabled_session_not_verified");
    assertNoSensitiveValues([row], [refreshToken]);
});

// ====================================================================== //
//                     mfa.login_challenge_issued
// ====================================================================== //

test("login MFA challenge issued → mfa.login_challenge_issued row, raw token NOT in payload", async () => {
    // Enable MFA on Acme admin so /login returns an mfa_required challenge.
    await plantMfaSecret(ACME_ADMIN);

    const result = await login({
        email:    ACME_ADMIN_EMAIL,
        password: ACME_ADMIN_PW,
    });
    assert.equal(result.kind, "mfa_required");
    const rawChallenge = result.challengeToken;
    assert.ok(typeof rawChallenge === "string" && rawChallenge.length > 0);

    // The audit row's target_id is auth_tokens.id — look it up by hash
    // under withOrgContext (auth_tokens is FORCE RLS).
    const tokenId = await findAuthTokenIdByRaw(ORG_ACME, rawChallenge);
    assert.ok(tokenId, "challenge token row must exist");

    const rows = await findAuditRows(
        ORG_ACME, "mfa.login_challenge_issued", tokenId,
    );
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.user_id, ACME_ADMIN);
    assert.equal(row.target_type, "auth_token");
    assert.equal(row.target_id, tokenId);
    assert.equal(row.payload.kind, "mfa_required");
    assert.equal(row.payload.method, "totp");
    assert.ok(row.payload.expires_at, "expires_at must be recorded");
    assertNoSensitiveValues([row], [rawChallenge, ACME_ADMIN_PW]);
});

test("login MFA setup-required → mfa.login_challenge_issued kind=mfa_setup_required, method=null", async () => {
    // Org requires MFA, but admin user has NOT enrolled.
    await pool.query(
        `UPDATE organizations SET mfa_required = true WHERE id = $1`,
        [ORG_ACME],
    );

    const result = await login({
        email:    ACME_ADMIN_EMAIL,
        password: ACME_ADMIN_PW,
    });
    assert.equal(result.kind, "mfa_setup_required");
    const rawChallenge = result.challengeToken;

    const tokenId = await findAuthTokenIdByRaw(ORG_ACME, rawChallenge);
    assert.ok(tokenId, "challenge token row must exist");

    const rows = await findAuditRows(
        ORG_ACME, "mfa.login_challenge_issued", tokenId,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].payload.kind, "mfa_setup_required");
    assert.equal(rows[0].payload.method, null);
    assertNoSensitiveValues(rows, [rawChallenge]);
});

// ====================================================================== //
//                     mfa.setup_started (authenticated)
// ====================================================================== //

test("authenticated setup → mfa.setup_started, no secret/base32/otpauthUri in payload", async () => {
    const result = await startAuthenticatedTotpSetup({
        userId:          ACME_ADMIN,
        orgId:           ORG_ACME,
        currentPassword: ACME_ADMIN_PW,
    });
    assert.ok(result.secretBase32);
    assert.ok(result.otpauthUri);

    const rows = await findAuditRows(ORG_ACME, "mfa.setup_started", ACME_ADMIN);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.user_id, ACME_ADMIN);
    assert.equal(row.target_type, "user");
    assert.equal(row.payload.flow, "authenticated");
    assert.equal(row.payload.method, "totp");
    assertNoSensitiveValues(rows, [
        result.secretBase32,
        result.otpauthUri,
        ACME_ADMIN_PW,
    ]);
});

// ====================================================================== //
//                     mfa.enabled (authenticated confirm)
// ====================================================================== //

test("authenticated confirm success → mfa.enabled row", async () => {
    // Plant a pending (not-yet-enabled) secret and a session.
    const secret = generateTotpSecret();
    const key = loadMfaSecretEncryptionKey();
    const wrapped = encryptMfaSecret(secret.raw, key);
    await pool.query(
        `UPDATE users
            SET mfa_secret_ciphertext = $2,
                mfa_secret_iv         = $3,
                mfa_secret_tag        = $4,
                mfa_secret_key_version = 1,
                mfa_enabled_at        = NULL,
                mfa_failed_attempt_count = 0,
                mfa_locked_until      = NULL
          WHERE id = $1`,
        [ACME_ADMIN, wrapped.ciphertext, wrapped.iv, wrapped.tag],
    );
    const sessionId = await plantSession(
        ACME_ADMIN, ORG_ACME, ACME_ADMIN_MEMBERSHIP,
    );

    const code = totpAtNow(secret.base32);
    const r = await confirmAuthenticatedTotp({
        userId:    ACME_ADMIN,
        orgId:     ORG_ACME,
        sessionId,
        code,
    });
    assert.ok(r.mfaEnabledAt instanceof Date);

    const rows = await findAuditRows(ORG_ACME, "mfa.enabled", ACME_ADMIN);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.user_id, ACME_ADMIN);
    assert.equal(row.target_type, "user");
    assert.equal(row.target_id, ACME_ADMIN);
    assert.equal(row.payload.method, "totp");
    assertNoSensitiveValues(rows, [secret.base32, code]);
});

// ====================================================================== //
//                     mfa.failed_attempt + mfa.locked (authenticated)
// ====================================================================== //

test("authenticated confirm wrong code → mfa.failed_attempt with count=1, no code in payload", async () => {
    // Pending secret + session, but submit a code that won't match.
    const secret = generateTotpSecret();
    const key = loadMfaSecretEncryptionKey();
    const wrapped = encryptMfaSecret(secret.raw, key);
    await pool.query(
        `UPDATE users
            SET mfa_secret_ciphertext = $2,
                mfa_secret_iv         = $3,
                mfa_secret_tag        = $4,
                mfa_secret_key_version = 1,
                mfa_enabled_at        = NULL,
                mfa_failed_attempt_count = 0
          WHERE id = $1`,
        [ACME_ADMIN, wrapped.ciphertext, wrapped.iv, wrapped.tag],
    );
    const sessionId = await plantSession(
        ACME_ADMIN, ORG_ACME, ACME_ADMIN_MEMBERSHIP,
    );

    const wrongCode = "000000";  // overwhelmingly unlikely to match TOTP
    await assert.rejects(
        () => confirmAuthenticatedTotp({
            userId: ACME_ADMIN, orgId: ORG_ACME, sessionId, code: wrongCode,
        }),
        (err) => err && err.code === "mfa_invalid_code",
    );

    const rows = await findAuditRows(ORG_ACME, "mfa.failed_attempt", ACME_ADMIN);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.payload.flow, "authenticated_confirm");
    assert.equal(row.payload.failed_attempt_count, 1);
    assertNoSensitiveValues(rows, [wrongCode, secret.base32]);

    // No mfa.locked yet at count=1.
    const lockedRows = await findAuditRows(ORG_ACME, "mfa.locked", ACME_ADMIN);
    assert.equal(lockedRows.length, 0);
});

test("authenticated confirm 5x wrong → mfa.locked exactly once, no further locked rows on retry", async () => {
    const secret = generateTotpSecret();
    const key = loadMfaSecretEncryptionKey();
    const wrapped = encryptMfaSecret(secret.raw, key);
    await pool.query(
        `UPDATE users
            SET mfa_secret_ciphertext = $2,
                mfa_secret_iv         = $3,
                mfa_secret_tag        = $4,
                mfa_secret_key_version = 1,
                mfa_enabled_at        = NULL,
                mfa_failed_attempt_count = 0,
                mfa_locked_until      = NULL
          WHERE id = $1`,
        [ACME_ADMIN, wrapped.ciphertext, wrapped.iv, wrapped.tag],
    );
    const sessionId = await plantSession(
        ACME_ADMIN, ORG_ACME, ACME_ADMIN_MEMBERSHIP,
    );

    // 5 wrong attempts — counter reaches 5 → lock trips on attempt #5.
    for (let i = 1; i <= 5; i++) {
        await assert.rejects(
            () => confirmAuthenticatedTotp({
                userId: ACME_ADMIN, orgId: ORG_ACME, sessionId, code: "000000",
            }),
            (err) => err && (err.code === "mfa_invalid_code" || err.code === "mfa_locked"),
            `attempt ${i} must reject`,
        );
    }

    // failed_attempt: 5 rows total.
    const failed = await findAuditRows(ORG_ACME, "mfa.failed_attempt", ACME_ADMIN);
    assert.equal(failed.length, 5);
    // count values should be monotonically 1..5.
    const counts = failed.map((r) => r.payload.failed_attempt_count).sort((a, b) => a - b);
    assert.deepEqual(counts, [1, 2, 3, 4, 5]);

    // locked: EXACTLY 1 row (only on the trip).
    const locked = await findAuditRows(ORG_ACME, "mfa.locked", ACME_ADMIN);
    assert.equal(locked.length, 1, "mfa.locked must fire exactly once");
    assert.equal(locked[0].payload.flow, "authenticated_confirm");
    assert.ok(locked[0].payload.locked_until, "locked_until ISO must be present");

    // 6th attempt while locked → throws mfa_locked at the early gate, NO
    // new failed_attempt + NO new locked row.
    await assert.rejects(
        () => confirmAuthenticatedTotp({
            userId: ACME_ADMIN, orgId: ORG_ACME, sessionId, code: "000000",
        }),
        (err) => err && err.code === "mfa_locked",
    );
    const failedAfter = await findAuditRows(ORG_ACME, "mfa.failed_attempt", ACME_ADMIN);
    assert.equal(failedAfter.length, 5, "no new failed_attempt while locked");
    const lockedAfter = await findAuditRows(ORG_ACME, "mfa.locked", ACME_ADMIN);
    assert.equal(lockedAfter.length, 1, "no new locked row on retry while locked");
});

// ====================================================================== //
//                     mfa.disabled + disable wrong-code
// ====================================================================== //

test("disable success → mfa.disabled row, no secret in payload", async () => {
    const secretBase32 = await plantMfaSecret(ACME_ADMIN);

    const code = totpAtNow(secretBase32);
    await disableTotp({
        userId:          ACME_ADMIN,
        orgId:           ORG_ACME,
        currentPassword: ACME_ADMIN_PW,
        code,
    });

    const rows = await findAuditRows(ORG_ACME, "mfa.disabled", ACME_ADMIN);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.user_id, ACME_ADMIN);
    assert.equal(row.target_type, "user");
    assert.equal(row.payload.method, "totp");
    assertNoSensitiveValues(rows, [secretBase32, code, ACME_ADMIN_PW]);
});

test("disable wrong code → mfa.failed_attempt with flow='disable', no code in payload", async () => {
    await plantMfaSecret(ACME_ADMIN);

    await assert.rejects(
        () => disableTotp({
            userId:          ACME_ADMIN,
            orgId:           ORG_ACME,
            currentPassword: ACME_ADMIN_PW,
            code:            "000000",
        }),
        (err) => err && err.code === "mfa_invalid_code",
    );

    const rows = await findAuditRows(ORG_ACME, "mfa.failed_attempt", ACME_ADMIN);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].payload.flow, "disable");
    assert.equal(rows[0].payload.failed_attempt_count, 1);
    assertNoSensitiveValues(rows, ["000000", ACME_ADMIN_PW]);
});

// ====================================================================== //
//                     organization.mfa_required_*
// ====================================================================== //

test("org MFA toggle true → organization.mfa_required_enabled row with member count", async () => {
    // Admin must have own MFA enabled to enable org MFA.
    await plantMfaSecret(ACME_ADMIN);

    await app.withOrgContext(ORG_ACME, (client) =>
        setOrganizationMfaRequired(client, {
            orgId:    ORG_ACME,
            userId:   ACME_ADMIN,
            required: true,
        }),
    );

    const rows = await findAuditRows(
        ORG_ACME, "organization.mfa_required_enabled", ORG_ACME,
    );
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.user_id, ACME_ADMIN);
    assert.equal(row.target_type, "organization");
    assert.equal(row.target_id, ORG_ACME);
    assert.equal(typeof row.payload.members_without_mfa_count, "number");
    assert.ok(row.payload.members_without_mfa_count >= 0);
});

test("org MFA toggle false → organization.mfa_required_disabled row", async () => {
    // Start with org MFA on (skip the admin-MFA gate by setting directly).
    await pool.query(
        `UPDATE organizations SET mfa_required = true WHERE id = $1`,
        [ORG_ACME],
    );

    await app.withOrgContext(ORG_ACME, (client) =>
        setOrganizationMfaRequired(client, {
            orgId:    ORG_ACME,
            userId:   ACME_ADMIN,
            required: false,
        }),
    );

    const rows = await findAuditRows(
        ORG_ACME, "organization.mfa_required_disabled", ORG_ACME,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, ACME_ADMIN);
    assert.equal(rows[0].target_type, "organization");
});

// ====================================================================== //
//                     cross-org isolation
// ====================================================================== //

test("audit rows from Acme are invisible to Beta context", async () => {
    // Generate one row in Acme via the disable hook.
    const secretBase32 = await plantMfaSecret(ACME_ADMIN);
    await disableTotp({
        userId:          ACME_ADMIN,
        orgId:           ORG_ACME,
        currentPassword: ACME_ADMIN_PW,
        code:            totpAtNow(secretBase32),
    });

    const acmeRows = await findAuditRows(ORG_ACME, "mfa.disabled", ACME_ADMIN);
    assert.equal(acmeRows.length, 1);
    const acmeRowId = acmeRows[0].id;

    // Query the same row id from Beta context — RLS must hide it.
    let betaRows;
    await app.withOrgContext(ORG_BETA, async (client) => {
        const r = await client.query(
            `SELECT id FROM activity_log WHERE id = $1`,
            [acmeRowId],
        );
        betaRows = r.rows;
    });
    assert.equal(betaRows.length, 0, "Beta must not see Acme's audit row");
});

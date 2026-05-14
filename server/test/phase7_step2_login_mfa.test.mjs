/* Phase 7 Step 2 — POST /auth/login MFA challenge tests.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_2_PLAN.md §2.2 / §2.3 / §7.
 *
 * Covers the new login behavior:
 *   - MFA-not-required: existing 200 + access token + refresh cookie.
 *   - User has MFA enabled (regardless of org setting): 202, kind
 *     'mfa_required', method 'totp', no token / no cookie.
 *   - Org requires MFA + user has no MFA: 202, kind 'mfa_setup_required',
 *     method null, no token / no cookie.
 *   - Wrong password: 401 unchanged, no mfa_challenge row minted.
 *   - Multi-org without orgId: 400 org_id_required, no mfa_challenge mint.
 *   - Repeated login with active mfa_challenge invalidates the prior row
 *     so the partial UNIQUE index `auth_tokens_user_purpose_active_idx`
 *     stays satisfied.
 *   - Cross-org invalidation: a stale `mfa_challenge` minted for org A
 *     does not block a fresh login for org B (service-pool sweep path).
 *
 * Fixture strategy:
 *   - We mutate `users.mfa_*` and `organizations.mfa_required` directly
 *     via the migration pool. Each test owns its mutation in try/finally
 *     so a failure leaves the seeded baseline intact.
 *   - mfa_challenge rows are wiped (invalidated_at = now()) in afterEach
 *     so the partial UNIQUE index never carries leftover state into the
 *     next test.
 *
 * Note: the helper services (TOTP, mfa secret encryption) are NOT
 * exercised here — this commit is the auth.login service + route only.
 * The /auth/mfa/totp/verify-login endpoint is a separate commit.
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

const ORG_ACME    = "11111111-1111-1111-1111-111111111111";
const ORG_BETA    = "22222222-2222-2222-2222-222222222222";
const ACME_EMP    = "aaaaaaaa-0002-0002-0002-aaaaaaaaaaaa";
const ACME_EMP_EMAIL = "emp@acme.test";
const ACME_EMP_PW    = "acme-emp-1234";

const svc = () => getServicePool();

let app;
let multiOrgEmail; // user that lives in both Acme and Beta — built per-suite

before(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    await app.register(dbPlugin);
    await app.register(authRoutes);

    // Spin up a fresh multi-org user. The seeded fixtures bind each user
    // to one org only; the multi-org orgId-required branch needs two
    // active memberships on the same user.
    const argon2 = (await import("argon2")).default;
    const passwordHash = await argon2.hash("multi-org-pass-1234", { type: argon2.argon2id });
    multiOrgEmail = `phase7-multi-${process.pid}-${Date.now()}@example.test`;
    const u = await svc().query(
        `INSERT INTO users (email, password_hash, name, email_verified_at)
         VALUES ($1, $2, 'Phase 7 Multi-Org', now())
         RETURNING id`,
        [multiOrgEmail, passwordHash],
    );
    const userId = u.rows[0].id;
    await svc().query(
        `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'employee')`,
        [ORG_ACME, userId],
    );
    await svc().query(
        `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'employee')`,
        [ORG_BETA, userId],
    );
});

after(async () => {
    // Defensive sweep of every mutation the suite could have made.
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
        `UPDATE organizations SET mfa_required = false WHERE id IN ($1, $2)`,
        [ORG_ACME, ORG_BETA],
    );
    await svc().query(
        `UPDATE auth_tokens
            SET invalidated_at = now()
          WHERE purpose = 'mfa_challenge'
            AND consumed_at IS NULL
            AND invalidated_at IS NULL`,
    );
    // Drop the multi-org test user — memberships cascade.
    await pool.query(`DELETE FROM users WHERE email = $1`, [multiOrgEmail]);
    await closeServicePool();
    await app.close();
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
        `UPDATE organizations SET mfa_required = false WHERE id IN ($1, $2)`,
        [ORG_ACME, ORG_BETA],
    );
    await svc().query(
        `UPDATE auth_tokens
            SET invalidated_at = now()
          WHERE purpose = 'mfa_challenge'
            AND consumed_at IS NULL
            AND invalidated_at IS NULL`,
    );
});

// ---------------------------------------------------------------------- //
// helpers
// ---------------------------------------------------------------------- //

// Force-enable MFA on a user. We don't go through the (not-yet-built)
// /auth/mfa/totp/confirm flow — we just satisfy the DB CHECK constraints
// directly so the login service sees mfa_enabled_at IS NOT NULL.
async function forceUserMfaEnabled(userId) {
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

async function setOrgMfaRequired(orgId, required) {
    await pool.query(
        `UPDATE organizations SET mfa_required = $2 WHERE id = $1`,
        [orgId, required],
    );
}

async function countActiveMfaChallenges(userId) {
    const r = await svc().query(
        `SELECT count(*)::int AS n
           FROM auth_tokens
          WHERE user_id = $1
            AND purpose = 'mfa_challenge'
            AND consumed_at IS NULL
            AND invalidated_at IS NULL`,
        [userId],
    );
    return r.rows[0].n;
}

async function login(payload) {
    return app.inject({ method: "POST", url: "/auth/login", payload });
}

// =============================================================
//                       BASELINE — MFA NOT REQUIRED
// =============================================================

test("MFA not required → 200, access token + refresh cookie unchanged", async () => {
    const r = await login({ email: ACME_EMP_EMAIL, password: ACME_EMP_PW });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.ok(body.accessToken, "200 body must carry an access token");
    assert.ok(body.user);
    assert.ok(body.organization);
    // Refresh cookie present.
    const setCookie = r.headers["set-cookie"];
    assert.ok(setCookie);
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    assert.ok(cookies.some((c) => c.includes("kloser_refresh=")),
        "expected kloser_refresh cookie in 200 response");
    // No challenge minted on the happy path.
    assert.equal(await countActiveMfaChallenges(ACME_EMP), 0);
});

// =============================================================
//                       USER MFA ENABLED → 202 mfa_required
// =============================================================

test("user MFA enabled → 202 mfa_required, no token, no cookie", async () => {
    await forceUserMfaEnabled(ACME_EMP);

    const r = await login({ email: ACME_EMP_EMAIL, password: ACME_EMP_PW });
    assert.equal(r.statusCode, 202, `expected 202, got ${r.statusCode}: ${r.body}`);
    const body = r.json();
    // No access token on the challenge branch.
    assert.equal(body.accessToken, undefined);
    assert.ok(body.mfa, "challenge body must carry mfa block");
    assert.equal(body.mfa.kind, "mfa_required");
    assert.equal(body.mfa.method, "totp");
    assert.ok(typeof body.mfa.challengeToken === "string");
    assert.ok(body.mfa.challengeToken.length > 0);
    assert.ok(body.mfa.expiresAt);

    // No refresh cookie on the challenge branch.
    const setCookie = r.headers["set-cookie"];
    if (setCookie) {
        const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
        assert.ok(!cookies.some((c) => c.includes("kloser_refresh=")),
            "challenge response must not set refresh cookie");
    }

    // Exactly one active mfa_challenge row exists for the user.
    assert.equal(await countActiveMfaChallenges(ACME_EMP), 1);
});

// =============================================================
//                       ORG MFA REQUIRED + USER NO MFA → 202 setup
// =============================================================

test("org mfa_required=true + user not enrolled → 202 mfa_setup_required", async () => {
    await setOrgMfaRequired(ORG_ACME, true);

    const r = await login({ email: ACME_EMP_EMAIL, password: ACME_EMP_PW });
    assert.equal(r.statusCode, 202);
    const body = r.json();
    assert.equal(body.accessToken, undefined);
    assert.ok(body.mfa);
    assert.equal(body.mfa.kind, "mfa_setup_required");
    // method is null on the setup branch — there is no factor yet.
    assert.equal(body.mfa.method, null);
    assert.ok(body.mfa.challengeToken);

    assert.equal(await countActiveMfaChallenges(ACME_EMP), 1);
});

// =============================================================
//                       ORG REQUIRED + USER ENABLED → 202 verify
// =============================================================

test("org mfa_required=true + user enrolled → 202 mfa_required (verify wins)", async () => {
    await setOrgMfaRequired(ORG_ACME, true);
    await forceUserMfaEnabled(ACME_EMP);

    const r = await login({ email: ACME_EMP_EMAIL, password: ACME_EMP_PW });
    assert.equal(r.statusCode, 202);
    const body = r.json();
    // When the user has already enrolled, we always go through verify
    // — never re-enrollment — regardless of the org setting.
    assert.equal(body.mfa.kind, "mfa_required");
    assert.equal(body.mfa.method, "totp");
});

// =============================================================
//                       WRONG PASSWORD — no challenge mint
// =============================================================

test("wrong password → 401 invalid_credentials, no mfa_challenge minted", async () => {
    await forceUserMfaEnabled(ACME_EMP);

    const before = await countActiveMfaChallenges(ACME_EMP);
    const r = await login({ email: ACME_EMP_EMAIL, password: "wrong-password-9999" });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().code, "invalid_credentials");
    const after = await countActiveMfaChallenges(ACME_EMP);
    assert.equal(after, before, "wrong password must not mint a challenge");
});

// =============================================================
//                       MULTI-ORG WITHOUT orgId — no mint
// =============================================================

test("multi-org user without orgId → 400 org_id_required, no mfa_challenge mint", async () => {
    // The multi-org test user does NOT have MFA enabled, but the
    // org_id_required branch fires before MFA evaluation regardless.
    const r = await login({ email: multiOrgEmail, password: "multi-org-pass-1234" });
    assert.equal(r.statusCode, 400, `expected 400, got ${r.statusCode}: ${r.body}`);
    assert.equal(r.json().code, "org_id_required");
    // Confirm no challenge row was minted for the multi-org user.
    const r2 = await svc().query(
        `SELECT count(*)::int AS n
           FROM auth_tokens
          WHERE user_id = (SELECT id FROM users WHERE email = $1)
            AND purpose = 'mfa_challenge'`,
        [multiOrgEmail],
    );
    assert.equal(r2.rows[0].n, 0,
        "org_id_required must short-circuit before challenge mint");
});

// =============================================================
//                       REPEATED LOGIN — prior challenge invalidated
// =============================================================

test("repeated login on MFA-required user invalidates prior active challenge", async () => {
    await forceUserMfaEnabled(ACME_EMP);

    const r1 = await login({ email: ACME_EMP_EMAIL, password: ACME_EMP_PW });
    assert.equal(r1.statusCode, 202);
    const first = r1.json().mfa.challengeToken;

    const r2 = await login({ email: ACME_EMP_EMAIL, password: ACME_EMP_PW });
    assert.equal(r2.statusCode, 202);
    const second = r2.json().mfa.challengeToken;
    assert.notEqual(first, second, "second login must mint a fresh challenge");

    // After the second login: exactly one active mfa_challenge across
    // the user's history. The partial UNIQUE index would have rejected
    // the second mint if the first hadn't been invalidated.
    assert.equal(await countActiveMfaChallenges(ACME_EMP), 1);

    // Verify the specific rows we minted: the first raw token's row is
    // now invalidated (not consumed), the second is still active. We
    // can't rely on "rows.length === 2" because prior test-run history
    // for the same seeded user accumulates as invalidated rows that the
    // afterEach sweep keeps but does not delete.
    const crypto = await import("node:crypto");
    const firstHash  = crypto.createHash("sha256").update(first).digest("hex");
    const secondHash = crypto.createHash("sha256").update(second).digest("hex");

    const r = await svc().query(
        `SELECT token_hash, consumed_at, invalidated_at
           FROM auth_tokens
          WHERE user_id = $1
            AND purpose = 'mfa_challenge'
            AND token_hash IN ($2, $3)`,
        [ACME_EMP, firstHash, secondHash],
    );
    assert.equal(r.rows.length, 2, "exactly the two rows we just minted");
    const firstRow  = r.rows.find((row) => row.token_hash === firstHash);
    const secondRow = r.rows.find((row) => row.token_hash === secondHash);
    assert.ok(firstRow && secondRow);
    assert.ok(firstRow.invalidated_at, "first challenge must be invalidated");
    assert.equal(firstRow.consumed_at, null, "first challenge must not be consumed");
    assert.equal(secondRow.invalidated_at, null, "second challenge must stay active");
    assert.equal(secondRow.consumed_at, null);
});

// =============================================================
//                       CROSS-ORG STALE CHALLENGE — service-pool sweep
// =============================================================

test("cross-org stale challenge does not block fresh login (service-pool sweep)", async () => {
    // Plant a stale mfa_challenge row for the multi-org user in Beta's
    // org via the service pool (BYPASSRLS). We don't go through the
    // login path here — we just need the row to exist with org_id=Beta.
    const u = await svc().query(`SELECT id FROM users WHERE email = $1`, [multiOrgEmail]);
    const multiUserId = u.rows[0].id;
    await svc().query(
        `INSERT INTO auth_tokens (org_id, user_id, purpose, token_hash, expires_at)
         VALUES ($1, $2, 'mfa_challenge', $3, now() + interval '5 minutes')`,
        [ORG_BETA, multiUserId, "phase7-stale-challenge-hash"],
    );

    // Now make Acme require MFA and login with orgId=Acme. Without the
    // cross-org sweep, the partial UNIQUE index (user_id, purpose) would
    // throw 23505 because the Beta row is still active.
    await setOrgMfaRequired(ORG_ACME, true);

    const r = await login({
        email: multiOrgEmail,
        password: "multi-org-pass-1234",
        orgId: ORG_ACME,
    });
    assert.equal(r.statusCode, 202, `expected 202, got ${r.statusCode}: ${r.body}`);
    assert.equal(r.json().mfa.kind, "mfa_setup_required");

    // The Beta row must now be invalidated, and exactly one active row
    // (the Acme one) must remain.
    const rows = await svc().query(
        `SELECT org_id, invalidated_at, consumed_at
           FROM auth_tokens
          WHERE user_id = $1
            AND purpose = 'mfa_challenge'
          ORDER BY created_at`,
        [multiUserId],
    );
    assert.equal(rows.rows.length, 2);
    const stale = rows.rows.find((r) => r.org_id === ORG_BETA);
    assert.ok(stale, "stale Beta row should still exist");
    assert.ok(stale.invalidated_at, "stale Beta row must be invalidated by sweep");
    const fresh = rows.rows.find((r) => r.org_id === ORG_ACME);
    assert.ok(fresh);
    assert.equal(fresh.invalidated_at, null);
    assert.equal(fresh.consumed_at, null);
});

// =============================================================
//                       CHALLENGE TOKEN HASH-ONLY STORAGE
// =============================================================

test("challenge response carries raw token only; DB stores sha256(raw) only", async () => {
    await forceUserMfaEnabled(ACME_EMP);

    const r = await login({ email: ACME_EMP_EMAIL, password: ACME_EMP_PW });
    assert.equal(r.statusCode, 202);
    const rawToken = r.json().mfa.challengeToken;

    // The DB row's token_hash is sha256(rawToken), not the raw bytes.
    const crypto = await import("node:crypto");
    const expectedHash = crypto.createHash("sha256").update(rawToken).digest("hex");

    const row = await svc().query(
        `SELECT token_hash
           FROM auth_tokens
          WHERE user_id = $1
            AND purpose = 'mfa_challenge'
            AND consumed_at IS NULL
            AND invalidated_at IS NULL`,
        [ACME_EMP],
    );
    assert.equal(row.rows.length, 1);
    assert.equal(row.rows[0].token_hash, expectedHash);

    // And the literal raw token must NOT appear in any auth_tokens column.
    const rawSearch = await svc().query(
        `SELECT count(*)::int AS n FROM auth_tokens
          WHERE token_hash = $1`,
        [rawToken],
    );
    assert.equal(rawSearch.rows[0].n, 0,
        "raw token must not appear in token_hash — sha256 only");
});

/* Phase 7 Step 2 — repository + service-token unit tests.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_2_PLAN.md §3.
 *
 * Surface covered:
 *   auth-tokens.ts (mfa_challenge purpose + TTL)
 *     - mintToken with `mfa_challenge` writes a row that lockAndValidate
 *       + markTokenConsumed handle the same way as Phase 3 purposes.
 *     - invalidateActiveTokens scoped to mfa_challenge doesn't touch
 *       other purposes on the same user.
 *     - TTL constant matches plan (5 min).
 *
 *   sessions.ts (Phase 7 Step 2 MFA fields)
 *     - createSession without MFA fields leaves both columns NULL.
 *     - createSession with explicit mfaVerifiedAt + mfaMethod populates
 *       both atomically (DB check constraint enforces the pair).
 *     - markMfaVerified upgrades a NULL-MFA session in place.
 *     - "refresh rotation" pattern: a replacement session carrying the
 *       same token_family_id and inheriting mfaVerifiedAt/mfaMethod
 *       from the leased session keeps the verified fact across the chain.
 *
 *   mfaUsers.ts (Phase 7 Step 2)
 *     - default state on a seeded user (no secret, counters zero).
 *     - storePendingSecret persists the encrypted triple + key_version
 *       and zeros lockout counters; enableMfa stamps `mfa_enabled_at`
 *       only when a secret exists.
 *     - clearMfa nulls every MFA-related field in one UPDATE.
 *     - incrementFailedAttempts returns the new value monotonically;
 *       resetFailedAttempts zeros it.
 *     - DB constraints reject illegal partial states:
 *         all-or-none secret triple
 *         enabled without secret
 *         key_version < 1
 *         failed_attempt_count < 0
 *
 *   organizations.ts (Phase 7 Step 2 mfa_required)
 *     - getCurrentOrg returns mfa_required.
 *     - getCurrentOrgSecurity / setCurrentOrgMfaRequired both pin on
 *       current_app_org_id() — an Acme GUC cannot flip Beta and a
 *       missing GUC returns null / rowCount 0.
 *
 * Cleanup: every test that mutates a seeded row restores the original
 * state in its own try/finally; the after-hook is a defensive sweep.
 *
 * Run: cd server && npm test
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { pool } from "../src/db/pool.js";
import dbPlugin from "../src/plugins/db.js";
import {
    findTokenByRaw,
    invalidateActiveTokens,
    lockAndValidateTokenById,
    markTokenConsumed,
    mintToken,
    TTL_MFA_CHALLENGE_MS,
} from "../src/services/auth-tokens.js";
import {
    createSession,
    findByRefreshTokenHashForUpdate,
    getByIdForUpdate,
    markMfaVerified,
} from "../src/repositories/sessions.js";
import * as mfaUsers from "../src/repositories/mfaUsers.js";
import {
    getCurrentOrg,
    getCurrentOrgSecurity,
    setCurrentOrgMfaRequired,
} from "../src/repositories/organizations.js";

const ORG_ACME = "11111111-1111-1111-1111-111111111111";
const ORG_BETA = "22222222-2222-2222-2222-222222222222";
const ACME_EMP = "aaaaaaaa-0002-0002-0002-aaaaaaaaaaaa";
const ACME_EMP_MEMBERSHIP = "cccccccc-0002-0002-0002-cccccccccccc";

let app;

before(async () => {
    app = Fastify({ logger: false });
    await app.register(dbPlugin);
});

after(async () => {
    // Defensive sweep — undo anything a test forgot to clean up. auth_tokens
    // is FORCE RLS so use the migration pool via the GUC set inside a tx,
    // OR run as the bare pool with the right GUC. Sessions / users /
    // organizations have no RLS so direct UPDATE works.
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
    // app.close() triggers the dbPlugin onClose hook which calls
    // pool.end(). Don't double-end the pool here.
    await app.close();
});

// ---------------------------------------------------------------------- //
// helpers
// ---------------------------------------------------------------------- //

async function withTx(orgId, fn) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        if (orgId) {
            await client.query(
                "SELECT set_config('app.org_id', $1, true)",
                [orgId],
            );
        }
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

async function clearMfaState() {
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
}

async function invalidateAllAcmeEmpTokens() {
    // auth_tokens is FORCE RLS, but the migration role (kloser) owns the
    // table and bypasses RLS through pool.query (the runtime DATABASE_URL
    // uses the app role — see env). Since this is test bookkeeping we
    // run the same way auth_tokens.test.mjs cleans up: bare UPDATE with
    // app role hits zero rows under RLS, so we use the pool which (in
    // dev) is the app role. That means we must set a GUC for the
    // UPDATE to match. Easiest: do it inside withTx(ORG_ACME, ...).
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query(
            "SELECT set_config('app.org_id', $1, true)",
            [ORG_ACME],
        );
        await client.query(
            `UPDATE auth_tokens
                SET invalidated_at = now()
              WHERE user_id = $1
                AND consumed_at IS NULL
                AND invalidated_at IS NULL`,
            [ACME_EMP],
        );
        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

async function deleteSessionsForUser() {
    // sessions has no RLS; safe to delete by user_id from the bare pool.
    // We only run this for the Acme employee fixture so other tests'
    // sessions stay intact.
    await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [ACME_EMP]);
}

function makeSensitive() {
    // The repository does not validate ciphertext shape; the actual AES-
    // 256-GCM helper is a separate file (next commit). For DB-level
    // tests we just need three non-null base64 strings.
    return {
        ciphertext: Buffer.alloc(32, 1).toString("base64"),
        iv: Buffer.alloc(12, 1).toString("base64"),
        tag: Buffer.alloc(16, 1).toString("base64"),
        keyVersion: 1,
    };
}

// ====================================================================== //
//                       AUTH TOKENS — mfa_challenge
// ====================================================================== //

test("TTL_MFA_CHALLENGE_MS equals five minutes", () => {
    assert.equal(TTL_MFA_CHALLENGE_MS, 5 * 60 * 1000);
});

test("mintToken(mfa_challenge) creates a row usable by the split helpers", async () => {
    await invalidateAllAcmeEmpTokens();
    const minted = await withTx(ORG_ACME, (client) =>
        mintToken({
            client,
            orgId: ORG_ACME,
            userId: ACME_EMP,
            purpose: "mfa_challenge",
            ttlMs: TTL_MFA_CHALLENGE_MS,
        }),
    );
    try {
        assert.ok(minted.rawToken);
        assert.ok(minted.tokenId);
        const ttlMs = minted.expiresAt.getTime() - Date.now();
        assert.ok(ttlMs > 4 * 60 * 1000, `expires too early: ${ttlMs}ms`);
        assert.ok(ttlMs <= 5 * 60 * 1000 + 500, `expires too late: ${ttlMs}ms`);

        // auth_tokens is FORCE RLS — every read/UPDATE needs an
        // app.org_id GUC. The service layer uses the BYPASSRLS
        // service pool for anonymous lookups; for repo-level tests
        // we just set the GUC explicitly.
        const lookup = await withTx(ORG_ACME, (client) =>
            findTokenByRaw(client, minted.rawToken, "mfa_challenge"),
        );
        assert.ok(lookup, "findTokenByRaw must return the row");
        assert.equal(lookup.tokenId, minted.tokenId);
        assert.equal(lookup.userId, ACME_EMP);
        assert.equal(lookup.orgId, ORG_ACME);
        assert.equal(lookup.invitationId, null);

        // lock + mark consumed should succeed inside a single transaction
        // (this is exactly the shape the verify-login service will use).
        await withTx(ORG_ACME, async (client) => {
            await lockAndValidateTokenById(client, minted.tokenId, "mfa_challenge");
            await markTokenConsumed(client, minted.tokenId);
        });

        // Second lock + validate must now throw token_already_used.
        await assert.rejects(
            withTx(ORG_ACME, (client) =>
                lockAndValidateTokenById(client, minted.tokenId, "mfa_challenge"),
            ),
            (err) => err?.code === "token_already_used",
        );
    } finally {
        await invalidateAllAcmeEmpTokens();
    }
});

test("invalidateActiveTokens scoped to mfa_challenge ignores other purposes", async () => {
    await invalidateAllAcmeEmpTokens();
    // Mint one mfa_challenge and one email_verification on the same user.
    const challenge = await withTx(ORG_ACME, (client) =>
        mintToken({
            client,
            orgId: ORG_ACME,
            userId: ACME_EMP,
            purpose: "mfa_challenge",
            ttlMs: TTL_MFA_CHALLENGE_MS,
        }),
    );
    const verification = await withTx(ORG_ACME, (client) =>
        mintToken({
            client,
            orgId: ORG_ACME,
            userId: ACME_EMP,
            purpose: "email_verification",
            ttlMs: 60_000,
        }),
    );
    try {
        const touched = await withTx(ORG_ACME, (client) =>
            invalidateActiveTokens({
                client,
                userId: ACME_EMP,
                purpose: "mfa_challenge",
            }),
        );
        assert.equal(touched, 1, "exactly one challenge row should invalidate");

        // The email_verification row must still be usable.
        const lookup = await withTx(ORG_ACME, (client) =>
            findTokenByRaw(client, verification.rawToken, "email_verification"),
        );
        assert.ok(lookup, "email_verification token must survive");

        // The challenge row should now read as invalidated when locked.
        await assert.rejects(
            withTx(ORG_ACME, (client) =>
                lockAndValidateTokenById(client, challenge.tokenId, "mfa_challenge"),
            ),
            (err) => err?.code === "token_invalidated",
        );
    } finally {
        await invalidateAllAcmeEmpTokens();
    }
});

// ====================================================================== //
//                       SESSIONS — MFA fields
// ====================================================================== //

test("createSession without MFA fields leaves both columns NULL", async () => {
    await deleteSessionsForUser();
    try {
        const created = await withTx(null, (client) =>
            createSession(client, {
                userId: ACME_EMP,
                orgId: ORG_ACME,
                membershipId: ACME_EMP_MEMBERSHIP,
                refreshTokenHash: `phase7-step2-noMfa-${randomUUID()}`,
                expiresAt: new Date(Date.now() + 60_000),
            }),
        );
        assert.equal(created.mfa_verified_at, null);
        assert.equal(created.mfa_method, null);

        const reread = await withTx(null, (client) =>
            getByIdForUpdate(client, created.id),
        );
        assert.equal(reread.mfa_verified_at, null);
        assert.equal(reread.mfa_method, null);
    } finally {
        await deleteSessionsForUser();
    }
});

test("createSession with mfaVerifiedAt + mfaMethod populates both atomically", async () => {
    await deleteSessionsForUser();
    try {
        const now = new Date();
        const created = await withTx(null, (client) =>
            createSession(client, {
                userId: ACME_EMP,
                orgId: ORG_ACME,
                membershipId: ACME_EMP_MEMBERSHIP,
                refreshTokenHash: `phase7-step2-mfa-${randomUUID()}`,
                expiresAt: new Date(Date.now() + 60_000),
                mfaVerifiedAt: now,
                mfaMethod: "totp",
            }),
        );
        assert.equal(created.mfa_method, "totp");
        assert.ok(created.mfa_verified_at);
        assert.equal(created.mfa_verified_at.getTime(), now.getTime());
    } finally {
        await deleteSessionsForUser();
    }
});

test("createSession rejects mfa_method without verified_at (DB check constraint)", async () => {
    await deleteSessionsForUser();
    try {
        await assert.rejects(
            withTx(null, async (client) => {
                // Bypass the helper to force the illegal pair: insert
                // mfa_method without mfa_verified_at. The DB
                // sessions_mfa_method_requires_verified_at_check
                // rejects with SQLSTATE 23514.
                await client.query(
                    `INSERT INTO sessions
                        (user_id, org_id, membership_id, refresh_token_hash,
                         expires_at, mfa_method)
                     VALUES ($1, $2, $3, $4, $5, 'totp')`,
                    [
                        ACME_EMP,
                        ORG_ACME,
                        ACME_EMP_MEMBERSHIP,
                        `phase7-step2-bad-${randomUUID()}`,
                        new Date(Date.now() + 60_000),
                    ],
                );
            }),
            (err) => err?.code === "23514",
        );
    } finally {
        await deleteSessionsForUser();
    }
});

test("createSession rejects mfaVerifiedAt without mfaMethod (repo-level pairing)", async () => {
    await deleteSessionsForUser();
    try {
        await assert.rejects(
            withTx(null, (client) =>
                createSession(client, {
                    userId: ACME_EMP,
                    orgId: ORG_ACME,
                    membershipId: ACME_EMP_MEMBERSHIP,
                    refreshTokenHash: `phase7-step2-half-a-${randomUUID()}`,
                    expiresAt: new Date(Date.now() + 60_000),
                    mfaVerifiedAt: new Date(),
                    // mfaMethod intentionally omitted — would otherwise
                    // create a session with a verified timestamp but no
                    // method label, which the DB check does not catch
                    // and the audit trail cannot recover from.
                }),
            ),
            /mfaVerifiedAt and mfaMethod must be set together/,
        );
    } finally {
        await deleteSessionsForUser();
    }
});

test("createSession rejects mfaMethod without mfaVerifiedAt (repo-level pairing)", async () => {
    await deleteSessionsForUser();
    try {
        await assert.rejects(
            withTx(null, (client) =>
                createSession(client, {
                    userId: ACME_EMP,
                    orgId: ORG_ACME,
                    membershipId: ACME_EMP_MEMBERSHIP,
                    refreshTokenHash: `phase7-step2-half-b-${randomUUID()}`,
                    expiresAt: new Date(Date.now() + 60_000),
                    mfaMethod: "totp",
                    // mfaVerifiedAt omitted — DB check would also reject
                    // (23514) but the repo throws first so call sites
                    // can't lean on DB error parsing.
                }),
            ),
            /mfaVerifiedAt and mfaMethod must be set together/,
        );
    } finally {
        await deleteSessionsForUser();
    }
});

test("markMfaVerified upgrades a password-only session in place", async () => {
    await deleteSessionsForUser();
    try {
        const created = await withTx(null, (client) =>
            createSession(client, {
                userId: ACME_EMP,
                orgId: ORG_ACME,
                membershipId: ACME_EMP_MEMBERSHIP,
                refreshTokenHash: `phase7-step2-upgrade-${randomUUID()}`,
                expiresAt: new Date(Date.now() + 60_000),
            }),
        );
        assert.equal(created.mfa_verified_at, null);

        const stamp = new Date();
        const rows = await withTx(null, (client) =>
            markMfaVerified(client, {
                sessionId: created.id,
                method: "totp",
                now: stamp,
            }),
        );
        assert.equal(rows, 1);

        const reread = await withTx(null, (client) =>
            getByIdForUpdate(client, created.id),
        );
        assert.equal(reread.mfa_method, "totp");
        assert.equal(reread.mfa_verified_at.getTime(), stamp.getTime());
    } finally {
        await deleteSessionsForUser();
    }
});

test("markMfaVerified ignores revoked sessions (no audit trail pollution)", async () => {
    await deleteSessionsForUser();
    try {
        const created = await withTx(null, (client) =>
            createSession(client, {
                userId: ACME_EMP,
                orgId: ORG_ACME,
                membershipId: ACME_EMP_MEMBERSHIP,
                refreshTokenHash: `phase7-step2-revoked-${randomUUID()}`,
                expiresAt: new Date(Date.now() + 60_000),
            }),
        );
        // Revoke first, then attempt the upgrade. A stale session id
        // must not gain a fresh mfa_verified_at stamp.
        await pool.query(
            `UPDATE sessions
                SET revoked_at = now(),
                    revoked_reason = 'phase7-step2-test-revoke'
              WHERE id = $1`,
            [created.id],
        );

        const rows = await withTx(null, (client) =>
            markMfaVerified(client, {
                sessionId: created.id,
                method: "totp",
                now: new Date(),
            }),
        );
        assert.equal(rows, 0, "revoked session must not be upgraded");

        const reread = await withTx(null, (client) =>
            getByIdForUpdate(client, created.id),
        );
        assert.equal(reread.mfa_verified_at, null);
        assert.equal(reread.mfa_method, null);
        assert.ok(reread.revoked_at, "revoke must still hold");
    } finally {
        await deleteSessionsForUser();
    }
});

test("refresh rotation pattern: replacement preserves family + MFA fields", async () => {
    await deleteSessionsForUser();
    try {
        // 1) Original MFA-verified session.
        const stamp = new Date();
        const original = await withTx(null, (client) =>
            createSession(client, {
                userId: ACME_EMP,
                orgId: ORG_ACME,
                membershipId: ACME_EMP_MEMBERSHIP,
                refreshTokenHash: `phase7-step2-rot-orig-${randomUUID()}`,
                expiresAt: new Date(Date.now() + 60_000),
                mfaVerifiedAt: stamp,
                mfaMethod: "totp",
            }),
        );

        // 2) Replacement carries the same family id and copies the MFA
        //    fields — the service-layer refresh path will do exactly this.
        const replacement = await withTx(null, (client) =>
            createSession(client, {
                userId: ACME_EMP,
                orgId: ORG_ACME,
                membershipId: ACME_EMP_MEMBERSHIP,
                refreshTokenHash: `phase7-step2-rot-repl-${randomUUID()}`,
                expiresAt: new Date(Date.now() + 60_000),
                tokenFamilyId: original.token_family_id,
                mfaVerifiedAt: original.mfa_verified_at,
                mfaMethod: original.mfa_method,
            }),
        );

        assert.equal(replacement.token_family_id, original.token_family_id);
        assert.equal(replacement.mfa_method, "totp");
        assert.equal(
            replacement.mfa_verified_at.getTime(),
            original.mfa_verified_at.getTime(),
        );

        // Look up via the family or refresh hash — both must surface the
        // new row.
        const found = await withTx(null, (client) =>
            findByRefreshTokenHashForUpdate(client, replacement.refresh_token_hash),
        );
        assert.equal(found.id, replacement.id);
        assert.equal(found.mfa_method, "totp");
    } finally {
        await deleteSessionsForUser();
    }
});

// ====================================================================== //
//                       MFA USERS — repository
// ====================================================================== //

test("getMfaState returns defaults for a seeded user with no MFA configured", async () => {
    await clearMfaState();
    const state = await withTx(null, (client) =>
        mfaUsers.getMfaState(client, ACME_EMP),
    );
    assert.ok(state);
    assert.equal(state.has_secret, false);
    assert.equal(state.mfa_secret_ciphertext, null);
    assert.equal(state.mfa_enabled_at, null);
    assert.equal(state.mfa_failed_attempt_count, 0);
    assert.equal(state.mfa_locked_until, null);
    assert.equal(state.mfa_secret_key_version, 1);
});

test("storePendingSecret persists the encrypted triple without enabling MFA", async () => {
    await clearMfaState();
    try {
        const secret = makeSensitive();
        await withTx(null, (client) =>
            mfaUsers.storePendingSecret(client, ACME_EMP, secret),
        );
        const state = await withTx(null, (client) =>
            mfaUsers.getMfaState(client, ACME_EMP),
        );
        assert.equal(state.has_secret, true);
        assert.equal(state.mfa_secret_ciphertext, secret.ciphertext);
        assert.equal(state.mfa_secret_iv, secret.iv);
        assert.equal(state.mfa_secret_tag, secret.tag);
        assert.equal(state.mfa_secret_key_version, secret.keyVersion);
        assert.equal(state.mfa_enabled_at, null, "pending secret must not enable MFA");
        assert.equal(state.mfa_failed_attempt_count, 0);
    } finally {
        await clearMfaState();
    }
});

test("enableMfa stamps mfa_enabled_at only when a secret exists", async () => {
    await clearMfaState();
    try {
        // Without a secret, enableMfa must touch 0 rows.
        const touchedNoSecret = await withTx(null, (client) =>
            mfaUsers.enableMfa(client, ACME_EMP),
        );
        assert.equal(touchedNoSecret, 0);
        const beforeState = await withTx(null, (client) =>
            mfaUsers.getMfaState(client, ACME_EMP),
        );
        assert.equal(beforeState.mfa_enabled_at, null);

        // With a pending secret, enableMfa moves the row to enabled.
        await withTx(null, (client) =>
            mfaUsers.storePendingSecret(client, ACME_EMP, makeSensitive()),
        );
        const touched = await withTx(null, (client) =>
            mfaUsers.enableMfa(client, ACME_EMP),
        );
        assert.equal(touched, 1);
        const enabledState = await withTx(null, (client) =>
            mfaUsers.getMfaState(client, ACME_EMP),
        );
        assert.ok(enabledState.mfa_enabled_at);
    } finally {
        await clearMfaState();
    }
});

test("clearMfa nulls every MFA-related field atomically", async () => {
    await clearMfaState();
    try {
        await withTx(null, (client) =>
            mfaUsers.storePendingSecret(client, ACME_EMP, makeSensitive()),
        );
        await withTx(null, (client) => mfaUsers.enableMfa(client, ACME_EMP));
        await withTx(null, (client) =>
            mfaUsers.incrementFailedAttempts(client, ACME_EMP),
        );
        await withTx(null, (client) =>
            mfaUsers.setLockedUntil(client, ACME_EMP, new Date(Date.now() + 60_000)),
        );

        await withTx(null, (client) => mfaUsers.clearMfa(client, ACME_EMP));

        const state = await withTx(null, (client) =>
            mfaUsers.getMfaState(client, ACME_EMP),
        );
        assert.equal(state.has_secret, false);
        assert.equal(state.mfa_secret_ciphertext, null);
        assert.equal(state.mfa_secret_iv, null);
        assert.equal(state.mfa_secret_tag, null);
        assert.equal(state.mfa_secret_key_version, 1);
        assert.equal(state.mfa_enabled_at, null);
        assert.equal(state.mfa_failed_attempt_count, 0);
        assert.equal(state.mfa_locked_until, null);
    } finally {
        await clearMfaState();
    }
});

test("incrementFailedAttempts returns the new value monotonically; reset zeros it", async () => {
    await clearMfaState();
    try {
        const first  = await withTx(null, (c) => mfaUsers.incrementFailedAttempts(c, ACME_EMP));
        const second = await withTx(null, (c) => mfaUsers.incrementFailedAttempts(c, ACME_EMP));
        const third  = await withTx(null, (c) => mfaUsers.incrementFailedAttempts(c, ACME_EMP));
        assert.equal(first, 1);
        assert.equal(second, 2);
        assert.equal(third, 3);

        await withTx(null, (c) => mfaUsers.resetFailedAttempts(c, ACME_EMP));
        const after = await withTx(null, (c) => mfaUsers.getMfaState(c, ACME_EMP));
        assert.equal(after.mfa_failed_attempt_count, 0);
    } finally {
        await clearMfaState();
    }
});

test("setLockedUntil sets and clears the lockout window", async () => {
    await clearMfaState();
    try {
        const until = new Date(Date.now() + 10 * 60_000);
        await withTx(null, (c) => mfaUsers.setLockedUntil(c, ACME_EMP, until));
        const locked = await withTx(null, (c) => mfaUsers.getMfaState(c, ACME_EMP));
        assert.ok(locked.mfa_locked_until);
        assert.equal(locked.mfa_locked_until.getTime(), until.getTime());

        await withTx(null, (c) => mfaUsers.setLockedUntil(c, ACME_EMP, null));
        const cleared = await withTx(null, (c) => mfaUsers.getMfaState(c, ACME_EMP));
        assert.equal(cleared.mfa_locked_until, null);
    } finally {
        await clearMfaState();
    }
});

// ---- DB-level constraint coverage ----

test("DB rejects partial secret triple (all-or-none constraint)", async () => {
    await clearMfaState();
    try {
        await assert.rejects(
            pool.query(
                `UPDATE users
                    SET mfa_secret_ciphertext = $2,
                        mfa_secret_iv         = NULL,
                        mfa_secret_tag        = NULL
                  WHERE id = $1`,
                [ACME_EMP, "ct-only"],
            ),
            (err) => err?.code === "23514",
        );
    } finally {
        await clearMfaState();
    }
});

test("DB rejects mfa_enabled_at without a secret", async () => {
    await clearMfaState();
    try {
        await assert.rejects(
            pool.query(
                `UPDATE users SET mfa_enabled_at = now() WHERE id = $1`,
                [ACME_EMP],
            ),
            (err) => err?.code === "23514",
        );
    } finally {
        await clearMfaState();
    }
});

test("DB rejects mfa_secret_key_version < 1", async () => {
    await clearMfaState();
    try {
        await assert.rejects(
            pool.query(
                `UPDATE users SET mfa_secret_key_version = 0 WHERE id = $1`,
                [ACME_EMP],
            ),
            (err) => err?.code === "23514",
        );
    } finally {
        await clearMfaState();
    }
});

test("DB rejects mfa_failed_attempt_count < 0", async () => {
    await clearMfaState();
    try {
        await assert.rejects(
            pool.query(
                `UPDATE users SET mfa_failed_attempt_count = -1 WHERE id = $1`,
                [ACME_EMP],
            ),
            (err) => err?.code === "23514",
        );
    } finally {
        await clearMfaState();
    }
});

// ====================================================================== //
//                       ORGANIZATIONS — mfa_required
// ====================================================================== //

test("getCurrentOrg now surfaces mfa_required (default false)", async () => {
    await app.withOrgContext(ORG_ACME, async (client) => {
        const org = await getCurrentOrg(client);
        assert.ok(org);
        assert.equal(org.id, ORG_ACME);
        assert.equal(org.mfa_required, false);
    });
});

test("setCurrentOrgMfaRequired flips only the current-context org", async () => {
    try {
        // Flip Acme on via the Acme GUC.
        const acmeRows = await app.withOrgContext(ORG_ACME, (client) =>
            setCurrentOrgMfaRequired(client, true),
        );
        assert.equal(acmeRows, 1);

        // Beta must remain false because Acme's GUC cannot match Beta's id.
        const betaSec = await app.withOrgContext(ORG_BETA, (client) =>
            getCurrentOrgSecurity(client),
        );
        assert.ok(betaSec);
        assert.equal(betaSec.id, ORG_BETA);
        assert.equal(betaSec.mfa_required, false);

        // And Acme reads back as required.
        const acmeSec = await app.withOrgContext(ORG_ACME, (client) =>
            getCurrentOrgSecurity(client),
        );
        assert.ok(acmeSec);
        assert.equal(acmeSec.mfa_required, true);
    } finally {
        await pool.query(
            `UPDATE organizations SET mfa_required = false WHERE id IN ($1, $2)`,
            [ORG_ACME, ORG_BETA],
        );
    }
});

test("setCurrentOrgMfaRequired without a GUC touches zero rows", async () => {
    // Bare pool connection with no GUC: current_app_org_id() returns NULL
    // → WHERE id = NULL matches no row, so 0 update.
    const client = await pool.connect();
    try {
        const rows = await setCurrentOrgMfaRequired(client, true);
        assert.equal(rows, 0);
        const sec = await getCurrentOrgSecurity(client);
        assert.equal(sec, null);
    } finally {
        client.release();
    }
});

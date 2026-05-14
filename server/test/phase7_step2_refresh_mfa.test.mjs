/* Phase 7 Step 2 — /auth/refresh MFA gating tests.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_2_PLAN.md §2.5.
 *
 * The gate: when the current user/org requires MFA but the session whose
 * refresh cookie we're rotating has `mfa_verified_at IS NULL`, refresh
 * must NOT issue an access token. The session row + token family stay
 * intact so a later MFA verify-login can restore the user without an
 * admin rebuild. The route's existing 401-clearCookie behaviour drops
 * the cookie from the browser regardless — that's a UX consequence, not
 * a server-side revoke.
 *
 * Scenarios:
 *   1. baseline: MFA-not-required + password-only session → 200 + new cookie.
 *   2. user.mfa_enabled_at set + password-only session → 401 mfa_required.
 *   3. org.mfa_required=true + password-only session → 401 mfa_required.
 *   4. blocked refresh does NOT revoke session/family.
 *   5. MFA-verified session refresh → 200 + replacement preserves
 *      mfa_verified_at, mfa_method, and token_family_id.
 *   6. grace path: rotate once, then reuse old cookie within the grace
 *      window with the chain MFA-verified → 200 + access token, no new
 *      refresh cookie (grace semantics unchanged).
 *   7. stale membership regression: pre-existing 'membership_inactive'
 *      revoke still works exactly as before (no MFA gate interference).
 *
 * The MFA fixtures populate users.mfa_secret_* / mfa_enabled_at /
 * sessions.mfa_verified_at directly via the migration pool — we never
 * drive the full TOTP enroll flow from here. That keeps this test file
 * about refresh policy, not the helper services.
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

const ORG_ACME       = "11111111-1111-1111-1111-111111111111";
const ACME_EMP       = "aaaaaaaa-0002-0002-0002-aaaaaaaaaaaa";
const ACME_EMP_MEMB  = "cccccccc-0002-0002-0002-cccccccccccc";
const ACME_EMP_EMAIL = "emp@acme.test";
const ACME_EMP_PW    = "acme-emp-1234";

const svc = () => getServicePool();

let app;

before(async () => {
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
    await app.withOrgContext(ORG_ACME, async (client) => {
        await client.query(
            `UPDATE memberships SET status = 'active' WHERE id = $1`,
            [ACME_EMP_MEMB],
        );
    });
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
        `UPDATE organizations SET mfa_required = false WHERE id = $1`,
        [ORG_ACME],
    );
    await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [ACME_EMP]);
    await app.withOrgContext(ORG_ACME, async (client) => {
        await client.query(
            `UPDATE memberships SET status = 'active' WHERE id = $1`,
            [ACME_EMP_MEMB],
        );
    });
});

// ---------------------------------------------------------------------- //
// helpers
// ---------------------------------------------------------------------- //

// Drive a real password login to get a valid refresh cookie. Acme
// employee has no MFA configured at this point in the test lifecycle
// (afterEach scrubs every mutation), so this always returns 200.
async function loginAcmeEmp() {
    const r = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: ACME_EMP_EMAIL, password: ACME_EMP_PW },
    });
    assert.equal(r.statusCode, 200, `login fixture should yield 200, got ${r.statusCode}: ${r.body}`);
    const cookie = r.cookies.find((c) => c.name === "kloser_refresh");
    assert.ok(cookie, "login fixture must set kloser_refresh cookie");
    return { cookieValue: cookie.value };
}

async function setUserMfaEnabled(userId) {
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

// The session is found by the hashed refresh cookie. We don't have the
// id directly — look it up from the cookie value the same way the
// service does. sessions has no RLS so a bare pool query is fine.
async function markSessionMfaVerified(cookieValue) {
    const crypto = await import("node:crypto");
    const hash = crypto.createHash("sha256").update(cookieValue).digest("hex");
    const now = new Date();
    const r = await pool.query(
        `UPDATE sessions
            SET mfa_verified_at = $2,
                mfa_method      = 'totp'
          WHERE refresh_token_hash = $1
          RETURNING id, token_family_id`,
        [hash, now],
    );
    assert.equal(r.rowCount, 1, "fixture should locate the session by cookie hash");
    return r.rows[0];
}

async function readSessionByCookie(cookieValue) {
    const crypto = await import("node:crypto");
    const hash = crypto.createHash("sha256").update(cookieValue).digest("hex");
    const r = await pool.query(
        `SELECT id, user_id, org_id, revoked_at, revoked_reason, token_family_id,
                replaced_by_session_id, mfa_verified_at, mfa_method
           FROM sessions
          WHERE refresh_token_hash = $1`,
        [hash],
    );
    return r.rows[0];
}

async function countSessionsInFamily(tokenFamilyId) {
    const r = await pool.query(
        `SELECT count(*)::int AS n FROM sessions WHERE token_family_id = $1`,
        [tokenFamilyId],
    );
    return r.rows[0].n;
}

async function readFamilyRevokedReasons(tokenFamilyId) {
    const r = await pool.query(
        `SELECT id, revoked_at, revoked_reason
           FROM sessions
          WHERE token_family_id = $1
          ORDER BY created_at`,
        [tokenFamilyId],
    );
    return r.rows;
}

async function refresh(cookieValue) {
    return app.inject({
        method: "POST",
        url: "/auth/refresh",
        cookies: { kloser_refresh: cookieValue },
    });
}

// =============================================================
//                       BASELINE — MFA not required
// =============================================================

test("MFA not required + password-only session → refresh 200 (existing behavior)", async () => {
    const { cookieValue } = await loginAcmeEmp();
    const r = await refresh(cookieValue);
    assert.equal(r.statusCode, 200);
    assert.ok(r.json().accessToken);
    const newCookie = r.cookies.find((c) => c.name === "kloser_refresh");
    assert.ok(newCookie, "fresh-rotation must set a new refresh cookie");
    assert.notEqual(newCookie.value, cookieValue);
});

// =============================================================
//                       USER MFA ENABLED — blocks
// =============================================================

test("user MFA enabled + password-only session → refresh 401 mfa_required", async () => {
    const { cookieValue } = await loginAcmeEmp();
    const before = await readSessionByCookie(cookieValue);
    assert.equal(before.mfa_verified_at, null,
        "fixture sanity: login session must start non-MFA");

    await setUserMfaEnabled(ACME_EMP);

    const r = await refresh(cookieValue);
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().code, "mfa_required");
    assert.equal(r.json().accessToken, undefined);
});

test("blocked refresh does NOT revoke the leased session or its family", async () => {
    const { cookieValue } = await loginAcmeEmp();
    const before = await readSessionByCookie(cookieValue);
    await setUserMfaEnabled(ACME_EMP);

    const r = await refresh(cookieValue);
    assert.equal(r.statusCode, 401);

    const after = await readSessionByCookie(cookieValue);
    assert.equal(after.revoked_at, null,
        "blocked refresh must NOT revoke the session row");
    assert.equal(after.revoked_reason, null);
    assert.equal(after.replaced_by_session_id, null);

    // No new session rows were minted in the family — fresh rotation
    // was short-circuited before createSessionWithToken.
    const familyRows = await readFamilyRevokedReasons(before.token_family_id);
    assert.equal(familyRows.length, 1);
    assert.equal(familyRows[0].revoked_at, null,
        "family must remain intact (no reuse-detected revoke)");
});

// =============================================================
//                       ORG MFA REQUIRED — blocks
// =============================================================

test("org mfa_required=true + password-only session → refresh 401 mfa_required", async () => {
    const { cookieValue } = await loginAcmeEmp();
    // The login session was minted BEFORE we flipped the org policy.
    // That's exactly the policy-flip race we want to gate.
    await setOrgMfaRequired(ORG_ACME, true);

    const r = await refresh(cookieValue);
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().code, "mfa_required");
});

// =============================================================
//                       MFA-VERIFIED SESSION — rotates cleanly
// =============================================================

test("MFA-verified session refresh → 200 + replacement preserves family + MFA fields", async () => {
    const { cookieValue } = await loginAcmeEmp();
    const before = await readSessionByCookie(cookieValue);
    // Simulate an existing MFA-verified session (the verify-login route
    // would have stamped these on session creation; here we just stamp
    // them directly so the test focuses on refresh propagation).
    const stamped = await markSessionMfaVerified(cookieValue);
    // Also flip the user / org policy ON — the gate must NOT trip for
    // an MFA-verified session.
    await setUserMfaEnabled(ACME_EMP);
    await setOrgMfaRequired(ORG_ACME, true);

    const r = await refresh(cookieValue);
    assert.equal(r.statusCode, 200, `expected 200, got ${r.statusCode}: ${r.body}`);
    assert.ok(r.json().accessToken);
    const newCookie = r.cookies.find((c) => c.name === "kloser_refresh");
    assert.ok(newCookie);

    // Replacement session inherits family + MFA fields.
    const replacement = await readSessionByCookie(newCookie.value);
    assert.ok(replacement);
    assert.equal(replacement.token_family_id, before.token_family_id,
        "replacement must keep the original token_family_id");
    assert.ok(replacement.mfa_verified_at,
        "replacement must inherit mfa_verified_at from old session");
    assert.equal(replacement.mfa_method, "totp");

    // Old session is revoked with reason 'rotated' + points to the
    // replacement (existing rotation invariants intact).
    const oldAfter = await readSessionByCookie(cookieValue);
    assert.ok(oldAfter.revoked_at);
    assert.equal(oldAfter.revoked_reason, "rotated");
    assert.equal(oldAfter.replaced_by_session_id, replacement.id);

    // Family count = 2 (original + replacement).
    assert.equal(await countSessionsInFamily(before.token_family_id), 2);
});

// =============================================================
//                       GRACE PATH — old cookie within grace window
// =============================================================

test("grace reuse on MFA-verified session → 200 access token, no new cookie", async () => {
    const { cookieValue } = await loginAcmeEmp();
    await markSessionMfaVerified(cookieValue);
    // Optionally flip org policy on — gate should pass via the
    // replacement's MFA fields, not the org check.
    await setOrgMfaRequired(ORG_ACME, true);

    // First refresh rotates (replacement inherits MFA fields).
    const r1 = await refresh(cookieValue);
    assert.equal(r1.statusCode, 200);
    const newCookie = r1.cookies.find((c) => c.name === "kloser_refresh");
    assert.ok(newCookie);

    // Re-use the OLD cookie within the grace window — service returns
    // the replacement's access token but no new refresh cookie (grace
    // semantics from Phase 1 Step 3 / refresh service).
    const r2 = await refresh(cookieValue);
    assert.equal(r2.statusCode, 200);
    assert.ok(r2.json().accessToken);
    const r2Cookie = r2.cookies.find((c) => c.name === "kloser_refresh");
    assert.equal(r2Cookie, undefined,
        "grace path must not rotate the refresh cookie a second time");
});

// =============================================================
//                       STALE MEMBERSHIP — pre-existing behavior intact
// =============================================================

test("stale membership refresh still revokes family (regression on existing behavior)", async () => {
    const { cookieValue } = await loginAcmeEmp();
    const before = await readSessionByCookie(cookieValue);

    // Mark the membership disabled — getSessionMembershipRole should
    // throw, refresh revokes the family, returns 401.
    // memberships has FORCE RLS; bare app-pool UPDATE without a GUC
    // matches 0 rows. kloser_service doesn't have UPDATE on memberships
    // (Phase 3 service grants). withOrgContext sets the app.org_id GUC
    // so the RLS UPDATE policy resolves cleanly.
    await app.withOrgContext(ORG_ACME, async (client) => {
        await client.query(
            `UPDATE memberships SET status = 'disabled' WHERE id = $1`,
            [ACME_EMP_MEMB],
        );
    });

    const r = await refresh(cookieValue);
    assert.equal(r.statusCode, 401);
    // The exact code is 'invalid_session' propagated from the helper —
    // pre-Phase-7 behavior we're preserving.
    assert.ok(r.json().code !== "mfa_required",
        "stale membership must not surface as mfa_required");

    // Family IS revoked — this is the pre-existing behavior the MFA
    // gate must not alter (membership_inactive reason).
    const familyRows = await readFamilyRevokedReasons(before.token_family_id);
    assert.equal(familyRows.length, 1);
    assert.ok(familyRows[0].revoked_at,
        "stale membership must revoke the family (pre-Phase-7)");
    assert.equal(familyRows[0].revoked_reason, "membership_inactive");
});

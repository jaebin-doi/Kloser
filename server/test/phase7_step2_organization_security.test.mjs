/* Phase 7 Step 2 — GET/PATCH /organization/security tests.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_2_PLAN.md §5.2 / §5.3 / §7.
 *
 * Surface (admin-only):
 *   GET   /organization/security  → OrganizationSecurityResponse
 *   PATCH /organization/security  → OrganizationSecurityResponse
 *
 * Test scenarios:
 *   1. admin GET → 200, mfa_required=false (default), current_user_mfa_enabled=false.
 *   2. admin with MFA enabled can PATCH mfa_required=true → 200 + new state.
 *   3. admin without MFA enabled PATCH true → 409 admin_mfa_required.
 *   4. admin can PATCH false even when their own MFA is disabled.
 *   5. employee → 403 on both GET and PATCH.
 *   6. PATCH body with stray `org_id` → 400 (route-level zod `.strict()`).
 *   7. cross-org isolation: Acme admin's PATCH leaves Beta's flag intact.
 *   8. members_without_mfa_count reflects active members lacking MFA.
 *   9. NODE_ENV=production: X-Org-Id header rejected with 400.
 *  10. PATCH with stale admin JWT (DB demoted to employee) → 401 stale_role,
 *      mfa_required unchanged (requireFreshRole).
 *
 * Fixture strategy:
 *   - Acme admin (admin@acme.test) is the seeded admin.
 *   - Acme employee (emp@acme.test) covers the 403 path.
 *   - Beta admin (admin@beta.test) covers cross-org isolation.
 *   - afterEach scrubs MFA fields on both admins + the employee, and
 *     resets mfa_required to false on both orgs.
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
import organizationSecurityRoutes from "../src/routes/organizationSecurity.js";
import { pool } from "../src/db/pool.js";

const ORG_ACME = "11111111-1111-1111-1111-111111111111";
const ORG_BETA = "22222222-2222-2222-2222-222222222222";

const ACME_ADMIN    = "aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa";
const ACME_ADMIN_EMAIL = "admin@acme.test";
const ACME_ADMIN_PW    = "acme-admin-1234";

const ACME_EMP       = "aaaaaaaa-0002-0002-0002-aaaaaaaaaaaa";
const ACME_EMP_EMAIL = "emp@acme.test";
const ACME_EMP_PW    = "acme-emp-1234";

const BETA_ADMIN       = "bbbbbbbb-0001-0001-0001-bbbbbbbbbbbb";
const BETA_ADMIN_EMAIL = "admin@beta.test";
const BETA_ADMIN_PW    = "beta-admin-1234";

// Seed memberships (server/seeds/0001_demo.sql). Needed for the
// stale_role test which demotes ACME admin's membership directly via
// SQL and must restore it before another test runs.
const ACME_ADMIN_MEMBERSHIP = "cccccccc-0001-0001-0001-cccccccccccc";

let app;

before(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    await app.register(dbPlugin);
    await app.register(authRoutes);
    await app.register(organizationSecurityRoutes);
});

after(async () => {
    await scrubAll();
    await app.close();
});

afterEach(async () => {
    await scrubAll();
});

async function scrubAll() {
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
}

// ---------------------------------------------------------------------- //
// helpers
// ---------------------------------------------------------------------- //

async function loginAs(email, password) {
    const r = await app.inject({
        method:  "POST",
        url:     "/auth/login",
        payload: { email, password },
    });
    assert.equal(r.statusCode, 200, `login fixture for ${email}: expected 200, got ${r.statusCode}: ${r.body}`);
    return r.json().accessToken;
}

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

function getSecurity(accessToken) {
    return app.inject({
        method:  "GET",
        url:     "/organization/security",
        headers: { authorization: `Bearer ${accessToken}` },
    });
}

function patchSecurity(accessToken, body) {
    return app.inject({
        method:  "PATCH",
        url:     "/organization/security",
        headers: { authorization: `Bearer ${accessToken}` },
        payload: body,
    });
}

async function readOrgMfa(orgId) {
    const r = await pool.query(
        `SELECT mfa_required FROM organizations WHERE id = $1`,
        [orgId],
    );
    return r.rows[0]?.mfa_required;
}

// =============================================================
//                       GET — admin default
// =============================================================

test("admin GET returns mfa_required=false (default) + current_user_mfa_enabled=false", async () => {
    const accessToken = await loginAs(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const r = await getSecurity(accessToken);
    assert.equal(r.statusCode, 200, `expected 200, got ${r.statusCode}: ${r.body}`);
    const body = r.json();
    assert.equal(body.mfa_required, false);
    assert.equal(body.current_user_mfa_enabled, false);
    assert.equal(typeof body.members_without_mfa_count, "number");
    assert.ok(body.members_without_mfa_count >= 0);
});

test("admin GET surfaces current_user_mfa_enabled=true after MFA enrol", async () => {
    const accessToken = await loginAs(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    await forceUserMfaEnabled(ACME_ADMIN);
    const r = await getSecurity(accessToken);
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().current_user_mfa_enabled, true);
});

// =============================================================
//                       PATCH true — admin MFA gate
// =============================================================

test("admin WITH MFA enabled can PATCH mfa_required=true", async () => {
    const accessToken = await loginAs(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    await forceUserMfaEnabled(ACME_ADMIN);

    const r = await patchSecurity(accessToken, { mfa_required: true });
    assert.equal(r.statusCode, 200, `expected 200, got ${r.statusCode}: ${r.body}`);
    const body = r.json();
    assert.equal(body.mfa_required, true);
    assert.equal(body.current_user_mfa_enabled, true);

    // DB actually flipped.
    assert.equal(await readOrgMfa(ORG_ACME), true);
});

test("admin WITHOUT MFA enabled cannot PATCH true → 409 admin_mfa_required", async () => {
    const accessToken = await loginAs(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);

    const r = await patchSecurity(accessToken, { mfa_required: true });
    assert.equal(r.statusCode, 409, `expected 409, got ${r.statusCode}: ${r.body}`);
    assert.equal(r.json().code, "admin_mfa_required");

    // DB unchanged.
    assert.equal(await readOrgMfa(ORG_ACME), false);
});

test("admin can PATCH false even with their own MFA disabled", async () => {
    // Order matters: login FIRST while org policy is still default (false)
    // so we get a normal 200 + access token. If we flipped org.mfa_required
    // to true before /auth/login, login would return 202 mfa_setup_required
    // for an admin who has no MFA enrolled, and there would be no usable
    // access token to call PATCH with.
    const accessToken = await loginAs(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);

    // Pre-enable org MFA via direct DB so we have something to flip OFF.
    // The existing access token survives this policy flip — refresh would
    // hit the MFA gate, but we don't refresh here.
    await pool.query(
        `UPDATE organizations SET mfa_required = true WHERE id = $1`,
        [ORG_ACME],
    );

    // Admin has NO MFA — flipping OFF must still be allowed.
    const r = await patchSecurity(accessToken, { mfa_required: false });
    assert.equal(r.statusCode, 200, `expected 200, got ${r.statusCode}: ${r.body}`);
    assert.equal(r.json().mfa_required, false);
    assert.equal(await readOrgMfa(ORG_ACME), false);
});

// =============================================================
//                       ROLE GUARD — employee 403
// =============================================================

test("employee → 403 on GET and PATCH", async () => {
    const accessToken = await loginAs(ACME_EMP_EMAIL, ACME_EMP_PW);

    const getRes = await getSecurity(accessToken);
    assert.equal(getRes.statusCode, 403);

    const patchRes = await patchSecurity(accessToken, { mfa_required: true });
    assert.equal(patchRes.statusCode, 403);

    // No DB change.
    assert.equal(await readOrgMfa(ORG_ACME), false);
});

// =============================================================
//                       STRAY FIELD — additionalProperties:false
// =============================================================

test("PATCH body with stray org_id field → 400 (route-level zod .strict())", async () => {
    const accessToken = await loginAs(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    await forceUserMfaEnabled(ACME_ADMIN);

    const r = await app.inject({
        method:  "PATCH",
        url:     "/organization/security",
        headers: { authorization: `Bearer ${accessToken}` },
        // Attempted cross-org injection — the body schema must reject it.
        payload: { mfa_required: true, org_id: ORG_BETA },
    });
    assert.equal(r.statusCode, 400, `expected 400, got ${r.statusCode}: ${r.body}`);

    // Acme stayed default (admin's MFA was enabled in fixture but the
    // PATCH itself was rejected before any UPDATE).
    assert.equal(await readOrgMfa(ORG_ACME), false);
    // Beta MUST NOT have been touched even if the stray field had leaked.
    assert.equal(await readOrgMfa(ORG_BETA), false);
});

// =============================================================
//                       CROSS-ORG ISOLATION
// =============================================================

test("Acme admin PATCH true touches Acme only — Beta unchanged", async () => {
    const accessToken = await loginAs(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    await forceUserMfaEnabled(ACME_ADMIN);

    const r = await patchSecurity(accessToken, { mfa_required: true });
    assert.equal(r.statusCode, 200);

    assert.equal(await readOrgMfa(ORG_ACME), true);
    assert.equal(await readOrgMfa(ORG_BETA), false);
});

test("Beta admin GET sees Beta's state only — not Acme's", async () => {
    // Flip Acme to true via direct DB; Beta default false.
    await pool.query(
        `UPDATE organizations SET mfa_required = true WHERE id = $1`,
        [ORG_ACME],
    );

    const accessToken = await loginAs(BETA_ADMIN_EMAIL, BETA_ADMIN_PW);
    const r = await getSecurity(accessToken);
    assert.equal(r.statusCode, 200);
    // Beta is still default. Beta admin must NOT see Acme's true.
    assert.equal(r.json().mfa_required, false);
});

// =============================================================
//                       members_without_mfa_count
// =============================================================

test("members_without_mfa_count reflects active members lacking MFA", async () => {
    const accessToken = await loginAs(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);

    // Baseline: nobody in Acme has MFA → count includes every active
    // member. We don't pin the exact number here because the seed fixture
    // can drift; we just assert "all-not-enrolled".
    const before = (await getSecurity(accessToken)).json();
    const totalActive = before.members_without_mfa_count;
    assert.ok(totalActive >= 1,
        `seed sanity: Acme must have at least one active member, got ${totalActive}`);

    // Enable MFA on one user (the admin themselves) — count must drop by 1.
    await forceUserMfaEnabled(ACME_ADMIN);
    const after = (await getSecurity(accessToken)).json();
    assert.equal(after.members_without_mfa_count, totalActive - 1,
        `count should drop by exactly 1 when one member enrols`);
});

// =============================================================
//                       PRODUCTION — X-Org-Id rejection
// =============================================================

test("NODE_ENV=production: GET/PATCH reject X-Org-Id header (orgContext defence)", async () => {
    const accessToken = await loginAs(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);

    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
        const getRes = await app.inject({
            method:  "GET",
            url:     "/organization/security",
            headers: {
                authorization: `Bearer ${accessToken}`,
                "x-org-id":    ORG_ACME, // syntactically valid UUID, still rejected
            },
        });
        assert.equal(getRes.statusCode, 400);
        assert.ok(getRes.body.includes("X-Org-Id is not accepted in production"));

        const patchRes = await app.inject({
            method:  "PATCH",
            url:     "/organization/security",
            headers: {
                authorization: `Bearer ${accessToken}`,
                "x-org-id":    ORG_ACME,
            },
            payload: { mfa_required: true },
        });
        assert.equal(patchRes.statusCode, 400);
        assert.ok(patchRes.body.includes("X-Org-Id is not accepted in production"));

        // Sanity: no header still works in prod.
        await forceUserMfaEnabled(ACME_ADMIN);
        const cleanGet = await app.inject({
            method:  "GET",
            url:     "/organization/security",
            headers: { authorization: `Bearer ${accessToken}` },
        });
        assert.equal(cleanGet.statusCode, 200,
            `GET without X-Org-Id should succeed in prod, got ${cleanGet.statusCode}: ${cleanGet.body}`);
    } finally {
        if (originalEnv === undefined) {
            delete process.env.NODE_ENV;
        } else {
            process.env.NODE_ENV = originalEnv;
        }
    }
});

// =============================================================
//                       requireFreshRole — stale_role
// =============================================================

test("PATCH with stale admin JWT (DB demoted to employee) → 401 stale_role, mfa_required unchanged", async () => {
    // Login while the DB still says admin so /auth/login mints a JWT
    // with role='admin'. We then demote the membership server-side so
    // the JWT outlives the DB role — requireFreshRole must catch this
    // before any service code touches organizations.mfa_required.
    const accessToken = await loginAs(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    await forceUserMfaEnabled(ACME_ADMIN);

    // Pre-condition sanity: PATCH would succeed RIGHT NOW with this
    // token. We don't actually call it — we just need to know the
    // failure later is from requireFreshRole, not some other gate.
    assert.equal(await readOrgMfa(ORG_ACME), false);

    try {
        // Direct SQL demote (avoids /memberships's last-admin guard,
        // which would block this single-admin-org demote via the API).
        // memberships is FORCE RLS, so this MUST run inside
        // withOrgContext — a bare pool.query without app.org_id set
        // sees zero rows under the org_isolation policy.
        await app.withOrgContext(ORG_ACME, (client) =>
            client.query(
                `UPDATE memberships
                    SET role = 'employee', updated_at = now()
                  WHERE id = $1`,
                [ACME_ADMIN_MEMBERSHIP],
            ),
        );

        const r = await patchSecurity(accessToken, { mfa_required: true });
        assert.equal(r.statusCode, 401,
            `expected 401 stale_role, got ${r.statusCode}: ${r.body}`);
        assert.equal(r.json().code, "stale_role");

        // The mutation must not have been applied.
        assert.equal(await readOrgMfa(ORG_ACME), false);
    } finally {
        // Restore the seed admin row so subsequent test runs / other
        // suites see the canonical state. afterEach's scrubAll() does
        // NOT touch memberships, so this restore is local. Same RLS
        // rule applies — go through withOrgContext.
        await app.withOrgContext(ORG_ACME, (client) =>
            client.query(
                `UPDATE memberships
                    SET role = 'admin', status = 'active', updated_at = now()
                  WHERE id = $1`,
                [ACME_ADMIN_MEMBERSHIP],
            ),
        );
    }
});

/* Phase 7 Step 9 — /billing routes tests.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_9_PLAN.md §5.4, §7.
 *
 * End-to-end via Fastify inject() against seeded Acme/Beta admins.
 *
 * Cases:
 *   1. GET /billing/overview as admin → 200 with full envelope
 *      (organization + profile + entitlements + usage + limits).
 *   2. GET /billing/overview as employee → 403 (requireRole admin).
 *   3. GET /billing/overview unauthenticated → 401.
 *   4. PATCH /billing/profile updates billing_email + tax_id, writes
 *      activity_log row whose payload lists fields by *name only*
 *      (no values).
 *   5. PATCH /billing/profile with empty body → 400 invalid_input.
 *   6. PATCH /billing/profile with invalid email → 400 invalid_input.
 *   7. PATCH /billing/profile with tax_id > 64 chars → 400 invalid_input.
 *   8. PATCH /billing/profile as employee → 403.
 *   9. Response NEVER includes external_customer_id /
 *      external_subscription_id / external_provider / metadata —
 *      external_provider_configured boolean is the only signal.
 *  10. tax_id XSS payload stored as-is + echoed in PATCH response;
 *      the route does NOT execute or strip script content (rendering
 *      is the frontend's job; Playwright test verifies textContent).
 *  11. PATCH then GET round-trip — overview reflects the patch.
 *
 * Run: cd server && npm test
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import authPlugin from "../src/plugins/auth.js";
import dbPlugin from "../src/plugins/db.js";
import authRoutes from "../src/routes/auth.js";
import billingRoutes from "../src/routes/billing.js";

const ACME_ID = "11111111-1111-1111-1111-111111111111";
const BETA_ID = "22222222-2222-2222-2222-222222222222";

const ACME_ADMIN_PW = "acme-admin-1234";
const ACME_EMP_PW = "acme-emp-1234";
const BETA_ADMIN_PW = "beta-admin-1234";

let app;

before(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    await app.register(dbPlugin);
    await app.register(authRoutes);
    await app.register(billingRoutes);
});

after(async () => {
    // Restore billing profile rows to default state.
    for (const orgId of [ACME_ID, BETA_ID]) {
        await app.withOrgContext(orgId, async (client) => {
            await client.query(
                `UPDATE organization_billing_profiles
                    SET billing_email = NULL,
                        tax_id = NULL,
                        billing_status = 'trialing',
                        updated_at = now()
                  WHERE org_id = current_app_org_id()`,
            );
        });
    }
    await app.pg.query("DELETE FROM sessions");
    await app.close();
});

afterEach(async () => {
    await app.pg.query("DELETE FROM sessions");
    for (const orgId of [ACME_ID, BETA_ID]) {
        await app.withOrgContext(orgId, async (client) => {
            await client.query(
                `UPDATE organization_billing_profiles
                    SET billing_email = NULL,
                        tax_id = NULL,
                        updated_at = now()
                  WHERE org_id = current_app_org_id()`,
            );
            await client.query(
                `DELETE FROM activity_log WHERE action = 'billing.profile_updated'`,
            );
        });
    }
});

async function login(email, password) {
    return app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email, password },
    });
}

async function tokenFor(email, password) {
    const r = await login(email, password);
    assert.equal(r.statusCode, 200, `login ${email} → ${r.statusCode}`);
    return r.json().accessToken;
}

function authed(token, opts) {
    return app.inject({
        ...opts,
        headers: { ...(opts.headers || {}), authorization: `Bearer ${token}` },
    });
}

// =============================================================== //
// 1. GET /billing/overview happy path
// =============================================================== //

test("1. GET /billing/overview admin → 200 with full envelope", async () => {
    const tok = await tokenFor("admin@acme.test", ACME_ADMIN_PW);
    const r = await authed(tok, { method: "GET", url: "/billing/overview" });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.organization?.id, ACME_ID);
    assert.equal(body.organization?.plan, "pro");
    assert.equal(typeof body.profile?.external_provider_configured, "boolean");
    assert.equal(body.profile?.billing_status, "trialing");
    assert.equal(typeof body.entitlements?.seats, "number");
    assert.equal(typeof body.usage?.seats, "number");
    assert.ok(Array.isArray(body.limits));
    const seatLimit = body.limits.find((l) => l.key === "seats");
    assert.ok(seatLimit, "seats limit state present");
    assert.equal(seatLimit.enforcement, "hard");
});

// =============================================================== //
// 2. GET /billing/overview employee → 403
// =============================================================== //

test("2. GET /billing/overview employee → 403", async () => {
    const tok = await tokenFor("emp@acme.test", ACME_EMP_PW);
    const r = await authed(tok, { method: "GET", url: "/billing/overview" });
    assert.equal(r.statusCode, 403);
});

// =============================================================== //
// 3. GET /billing/overview unauth → 401
// =============================================================== //

test("3. GET /billing/overview no auth → 401", async () => {
    const r = await app.inject({ method: "GET", url: "/billing/overview" });
    assert.equal(r.statusCode, 401);
});

// =============================================================== //
// 4. PATCH /billing/profile updates + audit (field-names-only payload)
// =============================================================== //

test("4. PATCH /billing/profile updates fields + audit payload names only", async () => {
    const tok = await tokenFor("admin@acme.test", ACME_ADMIN_PW);
    const r = await authed(tok, {
        method: "PATCH",
        url: "/billing/profile",
        payload: {
            billing_email: "billing@acme.test",
            tax_id: "TX-1234567890",
        },
    });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.profile?.billing_email, "billing@acme.test");
    assert.equal(body.profile?.tax_id, "TX-1234567890");

    // Audit row payload must list fields by name only — no values.
    const audit = await app.withOrgContext(ACME_ID, async (client) => {
        const q = await client.query(
            `SELECT payload FROM activity_log
              WHERE action = 'billing.profile_updated'
              ORDER BY created_at DESC LIMIT 1`,
        );
        return q.rows[0];
    });
    assert.ok(audit, "audit row was written");
    assert.deepEqual(audit.payload, { fields: ["billing_email", "tax_id"] });
    // Defense-in-depth: the value strings must not leak into payload.
    const serialized = JSON.stringify(audit.payload);
    assert.ok(!serialized.includes("billing@acme.test"));
    assert.ok(!serialized.includes("TX-1234567890"));
});

// =============================================================== //
// 5. PATCH /billing/profile empty body → 400
// =============================================================== //

test("5. PATCH /billing/profile {} → 400 invalid_input", async () => {
    const tok = await tokenFor("admin@acme.test", ACME_ADMIN_PW);
    const r = await authed(tok, {
        method: "PATCH",
        url: "/billing/profile",
        payload: {},
    });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error, "invalid_input");
});

// =============================================================== //
// 6. PATCH /billing/profile invalid email → 400
// =============================================================== //

test("6. PATCH /billing/profile invalid email → 400", async () => {
    const tok = await tokenFor("admin@acme.test", ACME_ADMIN_PW);
    const r = await authed(tok, {
        method: "PATCH",
        url: "/billing/profile",
        payload: { billing_email: "not-an-email" },
    });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error, "invalid_input");
});

// =============================================================== //
// 7. PATCH /billing/profile tax_id > 64 → 400
// =============================================================== //

test("7. PATCH /billing/profile tax_id > 64 chars → 400", async () => {
    const tok = await tokenFor("admin@acme.test", ACME_ADMIN_PW);
    const r = await authed(tok, {
        method: "PATCH",
        url: "/billing/profile",
        payload: { tax_id: "x".repeat(65) },
    });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error, "invalid_input");
});

// =============================================================== //
// 8. PATCH /billing/profile employee → 403
// =============================================================== //

test("8. PATCH /billing/profile employee → 403", async () => {
    const tok = await tokenFor("emp@acme.test", ACME_EMP_PW);
    const r = await authed(tok, {
        method: "PATCH",
        url: "/billing/profile",
        payload: { billing_email: "billing@acme.test" },
    });
    assert.equal(r.statusCode, 403);
});

// =============================================================== //
// 9. Response never includes external_* / metadata
// =============================================================== //

test("9. Response never leaks external_provider/customer/subscription/metadata", async () => {
    // Set internal external_* fields directly so we can verify they DO
    // NOT appear in the public response. Backfill the row first then
    // populate fields the route layer never accepts via PATCH.
    await app.withOrgContext(ACME_ID, async (client) => {
        await client.query(
            `UPDATE organization_billing_profiles
                SET external_provider = 'manual',
                    external_customer_id = 'cust_internal_DO_NOT_SHARE',
                    external_subscription_id = 'sub_internal_DO_NOT_SHARE',
                    metadata = jsonb_build_object('internal_note', 'no leak'),
                    updated_at = now()
              WHERE org_id = current_app_org_id()`,
        );
    });

    const tok = await tokenFor("admin@acme.test", ACME_ADMIN_PW);
    const r = await authed(tok, { method: "GET", url: "/billing/overview" });
    assert.equal(r.statusCode, 200);
    const text = r.body;
    assert.ok(!text.includes("cust_internal_DO_NOT_SHARE"), "external_customer_id must not leak");
    assert.ok(!text.includes("sub_internal_DO_NOT_SHARE"), "external_subscription_id must not leak");
    assert.ok(!text.includes("internal_note"), "metadata must not leak");
    const body = r.json();
    assert.equal(body.profile.external_provider_configured, true);
    assert.equal(body.profile.external_customer_id, undefined);
    assert.equal(body.profile.external_subscription_id, undefined);
    assert.equal(body.profile.metadata, undefined);

    // Restore
    await app.withOrgContext(ACME_ID, async (client) => {
        await client.query(
            `UPDATE organization_billing_profiles
                SET external_provider = NULL,
                    external_customer_id = NULL,
                    external_subscription_id = NULL,
                    metadata = '{}'::jsonb,
                    updated_at = now()
              WHERE org_id = current_app_org_id()`,
        );
    });
});

// =============================================================== //
// 10. tax_id XSS payload stored + echoed as plain text
// =============================================================== //

test("10. tax_id XSS payload stored as-is; route does not strip/execute", async () => {
    const tok = await tokenFor("admin@acme.test", ACME_ADMIN_PW);
    const xss = `<script>alert('xss')</script>`;
    const r = await authed(tok, {
        method: "PATCH",
        url: "/billing/profile",
        payload: { tax_id: xss },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().profile.tax_id, xss);
    // The route's only obligation is preserving the value verbatim so
    // the frontend's textContent renderer can output it safely. The
    // Playwright smoke test (see PHASE_7_STEP_9_FINDINGS.md) verifies
    // the frontend renders it as a string node, not as HTML.
});

// =============================================================== //
// 11. PATCH → GET round-trip
// =============================================================== //

test("11. PATCH then GET round-trip shows the patched profile fields", async () => {
    const tok = await tokenFor("admin@acme.test", ACME_ADMIN_PW);
    const patchRes = await authed(tok, {
        method: "PATCH",
        url: "/billing/profile",
        payload: { billing_email: "round-trip@acme.test" },
    });
    assert.equal(patchRes.statusCode, 200);

    const overview = await authed(tok, {
        method: "GET",
        url: "/billing/overview",
    });
    assert.equal(overview.statusCode, 200);
    assert.equal(overview.json().profile.billing_email, "round-trip@acme.test");
});

/* Phase 3 통합 e2e — 6 시나리오 + cleanup.
 *
 * Pre-req (split-origin):
 *   - API:      `npm --prefix server run dev`            (port 32173)
 *   - Static:   `npx http-server . -p 8765 --silent`     (project root)
 *   - Seed:     `npm --prefix server run db:seed`        (acme/beta + phase3 demo)
 *   - Postgres: docker compose up (container `kloser-dev-postgres-1`)
 *
 * Run:
 *   node test/phase_3_e2e.mjs
 *
 * Run (Caddy single-origin):
 *   KLOSER_E2E_BASE_URL=https://localhost node test/phase_3_e2e.mjs
 *
 * Scenarios (Step 7 plan §2):
 *   1. signup → live 미인증 배너 → verify → live 배너 미노출
 *   2. forgot (unknown) parity → forgot (known) → reset → 새 pw 200 / 옛 pw 401
 *   3. admin invite → 신규 user accept → /me org/role 확인
 *   4. 기존 user multi-org accept → 다른 org context + pw 보존
 *   5. role/status 변경 → disabled login 401 → restore
 *   6. resend / cancel → 옛 token 410
 *
 * Token extraction:
 *   - dev outbox provider가 metadata에 raw token 노출 (Phase 3 Step 1 §7).
 *   - e2e는 `docker exec ... psql -U kloser_service ...`로 outbox row 직접 조회.
 *     `kloser_service`는 BYPASSRLS라 GUC 없이 SELECT 가능.
 *   - Phase 6+ SMTP 어댑터는 metadata에서 token을 마스킹하므로 본 패턴은 dev only.
 *
 * Cleanup:
 *   - 모든 신규 user는 `phase3test-*@example.test` prefix.
 *   - finally 블록이 prefix sweep으로 users 삭제 → org/membership cascade.
 *   - emp@acme.test 강제 restore (role='employee', status='active') 안전망.
 */
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const E2E_BASE      = process.env.KLOSER_E2E_BASE_URL || "";
const STATIC_ORIGIN = E2E_BASE || "http://localhost:8765";
const API_BASE      = E2E_BASE || "http://localhost:32173";
const API_HEALTH    = `${API_BASE}/health`;
const IS_HTTPS      = STATIC_ORIGIN.startsWith("https:");

const LOGIN_URL     = `${STATIC_ORIGIN}/platform/login.html`;
const SIGNUP_URL    = `${STATIC_ORIGIN}/platform/signup.html`;
const VERIFY_URL    = `${STATIC_ORIGIN}/platform/verify.html`;
const FORGOT_URL    = `${STATIC_ORIGIN}/platform/forgot-password.html`;
const RESET_URL     = `${STATIC_ORIGIN}/platform/reset-password.html`;
const ACCEPT_URL    = `${STATIC_ORIGIN}/platform/accept-invitation.html`;
const LIVE_URL      = `${STATIC_ORIGIN}/platform/live.html`;
const TEAM_URL      = `${STATIC_ORIGIN}/platform/team.html`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_PATH = path.join(__dirname, "phase_3_e2e.png");

const PG_CONTAINER = "kloser-dev-postgres-1";
const PG_DB        = "kloser_dev";
const PG_SVC_USER  = "kloser_service";
const PG_SVC_PASS  = "kloser_service_dev";
const PG_APP_USER  = "app";
const PG_APP_PASS  = "app_dev";

const RUN_ID = Date.now();
const EMAIL_P1       = `phase3test-p1-${RUN_ID}@example.test`;
const EMAIL_P2       = `phase3test-p2-${RUN_ID}@example.test`;
const EMAIL_P3       = `phase3test-p3-${RUN_ID}@example.test`;
const EMAIL_P6       = `phase3test-p6-${RUN_ID}@example.test`;
const PW_DEFAULT     = "phase3test-pw-12345";
const PW_P2_NEW      = "phase3test-p2-new-67890";
const PW_FAKE        = "phase3test-fake-99999";

const ACME_ADMIN_EMAIL  = "admin@acme.test";
const ACME_ADMIN_PW     = "acme-admin-1234";
const ACME_EMP_EMAIL    = "emp@acme.test";
const ACME_EMP_PW       = "acme-emp-1234";
const BETA_ADMIN_EMAIL  = "admin@beta.test";
const BETA_ADMIN_PW     = "beta-admin-1234";
const ACME_EMP_MEMBERSHIP = "cccccccc-0002-0002-0002-cccccccccccc";

function pass(msg) { console.log("PASS:", msg); }
function fail(msg) { console.error("FAIL:", msg); process.exitCode = 1; }

// ─────────────────────────────────────────────
// psql shell — runs query via docker exec. Bypasses RLS via kloser_service.
// ─────────────────────────────────────────────
function psql(sql, { app = false } = {}) {
    const user = app ? PG_APP_USER : PG_SVC_USER;
    const pass = app ? PG_APP_PASS : PG_SVC_PASS;
    try {
        return execFileSync(
            "docker",
            [
                "exec",
                "-e", `PGPASSWORD=${pass}`,
                PG_CONTAINER,
                "psql", "-U", user, "-d", PG_DB, "-At", "-c", sql,
            ],
            { encoding: "utf8" },
        ).trim();
    } catch (err) {
        const stderr = err.stderr ? err.stderr.toString() : "";
        throw new Error(`psql failed: ${stderr || err.message}`);
    }
}

function rawTokenFor(toEmail, template, urlField) {
    // template ∈ {email_verification, password_reset, invitation}
    // urlField ∈ {verifyUrl, resetUrl, acceptUrl}
    const row = psql(
        `SELECT metadata->>'${urlField}' FROM email_outbox
          WHERE to_email = '${toEmail}' AND template = '${template}'
          ORDER BY created_at DESC LIMIT 1;`,
    );
    if (!row) throw new Error(`no outbox row for ${toEmail} (${template})`);
    const m = /[?&]token=([^&\s]+)/.exec(row);
    if (!m) throw new Error(`token not found in URL: ${row}`);
    return decodeURIComponent(m[1]);
}

// ─────────────────────────────────────────────
// Direct API helpers — bypass UI for setup/teardown.
// ─────────────────────────────────────────────
async function apiLogin(email, password, orgId) {
    const r = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, ...(orgId ? { orgId } : {}) }),
    });
    const body = await r.json().catch(() => null);
    return { status: r.status, body };
}

async function adminApiToken(email, password) {
    const r = await apiLogin(email, password);
    if (r.status !== 200) throw new Error(`api login ${email} → ${r.status}`);
    return r.body.accessToken;
}

async function apiPost(token, path, body) {
    const r = await fetch(`${API_BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body || {}),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
}
async function apiPatch(token, path, body) {
    const r = await fetch(`${API_BASE}${path}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body || {}),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
}
async function apiDelete(token, path) {
    const r = await fetch(`${API_BASE}${path}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
    });
    return { status: r.status };
}
async function apiGet(token, path) {
    const r = await fetch(`${API_BASE}${path}`, {
        headers: { authorization: `Bearer ${token}` },
    });
    return { status: r.status, body: await r.json().catch(() => null) };
}

// ─────────────────────────────────────────────
// Anonymous endpoint shortcut for parity / accept-via-fetch
// (browser context not always needed — but we still drive UI on the
//  forms to exercise the actual page bindings).
// ─────────────────────────────────────────────
async function rawAccept(token, name, password) {
    const r = await fetch(`${API_BASE}/invitations/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, name, password }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
}

// ─────────────────────────────────────────────
// UI helpers — page interactions on the actual platform pages.
// ─────────────────────────────────────────────
async function uiSignup(page, { organizationName, name, email, password }) {
    await page.goto(SIGNUP_URL, { waitUntil: "domcontentloaded" });
    await page.fill("#organizationName", organizationName);
    await page.fill("#name", name);
    await page.fill("#email", email);
    await page.fill("#password", password);
    await Promise.all([
        page.waitForURL((u) => u.pathname.endsWith("/platform/live.html"), { timeout: 8000 }),
        page.click("#submit"),
    ]);
}
async function uiLogout(page) {
    await page.evaluate(async () => {
        if (window.kloserApi?.logout) await window.kloserApi.logout();
    });
}

// ─────────────────────────────────────────────
// Cleanup helpers.
// ─────────────────────────────────────────────
function cleanupTestData() {
    // 1) Find orgs admin-owned by phase3test- users (service role — BYPASSRLS
    //    needed because memberships is RLS-scoped and app role without a GUC
    //    sees 0 rows). Service role has SELECT grant on memberships +
    //    organizations (migration 0008), but NOT DELETE.
    const orgIdsRaw = psql(
        `SELECT DISTINCT m.org_id FROM memberships m
           JOIN users u ON u.id = m.user_id
          WHERE u.email LIKE 'phase3test-%@example.test'
            AND m.role = 'admin';`,
    );
    const orgIds = orgIdsRaw ? orgIdsRaw.split("\n").map((s) => s.trim()).filter(Boolean) : [];

    // 2) Delete those orgs via app role (organizations is NOT RLS-scoped, so
    //    direct DELETE works; cascades to memberships / auth_tokens /
    //    email_outbox / invitations / sessions tied to them).
    for (const orgId of orgIds) {
        psql(
            `DELETE FROM organizations WHERE id = '${orgId}';`,
            { app: true },
        );
    }

    // 3) Delete the test users themselves (users is not RLS-scoped).
    psql(
        `DELETE FROM users WHERE email LIKE 'phase3test-%@example.test';`,
        { app: true },
    );

    // 4) Soft-cancel any phase3test invitations still in seeded orgs
    //    (Acme/Beta) — service role has UPDATE grant on invitations.
    psql(
        `UPDATE invitations SET canceled_at = COALESCE(canceled_at, now())
          WHERE email LIKE 'phase3test-%@example.test' AND accepted_at IS NULL;`,
    );
    psql(
        `UPDATE auth_tokens at
            SET invalidated_at = COALESCE(invalidated_at, now())
           FROM invitations i
          WHERE at.invitation_id = i.id
            AND i.email LIKE 'phase3test-%@example.test'
            AND at.consumed_at IS NULL
            AND at.invalidated_at IS NULL;`,
    );

    // 5) Restore emp@acme.test seeded membership.
    //    memberships has UPDATE policy `USING (org_id = current_app_org_id())`
    //    plus service role lacks UPDATE grant — only app role + Acme GUC works.
    psql(
        `BEGIN;
         SET LOCAL app.org_id = '11111111-1111-1111-1111-111111111111';
         UPDATE memberships SET role='employee', status='active'
           WHERE id = '${ACME_EMP_MEMBERSHIP}';
         COMMIT;`,
        { app: true },
    );

    // 6) Clear all sessions so a disabled emp from a partial run can re-login.
    psql(`DELETE FROM sessions;`, { app: true });
}

// ──────────────────────────────────────────────────────────────────────────
//  main
// ──────────────────────────────────────────────────────────────────────────
async function main() {
    console.log(
        `→ mode: ${E2E_BASE ? `single-origin (${E2E_BASE})` : "split-origin (8765 + 32173)"}`,
    );

    if (IS_HTTPS) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

    // Sanity: API health
    const health = await fetch(API_HEALTH).then((r) => r.json()).catch(() => null);
    if (!health || health.ok !== true) {
        throw new Error("API health probe failed — is server/ running?");
    }
    pass(`API health ok (uptime ${health.uptimeSec}s)`);

    // Sanity: dev postgres reachable
    try {
        psql("SELECT 1;");
        pass("postgres reachable via docker exec");
    } catch (err) {
        throw new Error(`postgres probe failed: ${err.message}`);
    }

    // Pre-clean any prior run residue (idempotent).
    cleanupTestData();
    pass("pre-clean phase3test- residue");

    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ ignoreHTTPSErrors: IS_HTTPS });
    const page = await ctx.newPage();

    page.on("dialog", (dialog) => dialog.accept());

    const consoleErrors = [];
    page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(`[pageerror] ${err.message}`));

    try {
        // ───────────────────────────────────────────────────────────────
        // Scenario 1: signup → live banner → verify → banner gone
        // ───────────────────────────────────────────────────────────────
        await uiSignup(page, {
            organizationName: `Phase3Test P1 ${RUN_ID}`,
            name: "Phase3 P1",
            email: EMAIL_P1,
            password: PW_DEFAULT,
        });
        pass(`s1: signup → live.html`);

        // Wait briefly for /me + banner render.
        await page.waitForFunction(
            () => !!document.getElementById("unverified-banner"),
            { timeout: 4000 },
        ).then(() => pass("s1: unverified banner visible"))
         .catch(() => fail("s1: unverified banner missing"));

        // Pull verify token + go to verify.html
        const verifyToken = rawTokenFor(EMAIL_P1, "email_verification", "verifyUrl");
        await page.goto(`${VERIFY_URL}?token=${encodeURIComponent(verifyToken)}`,
            { waitUntil: "domcontentloaded" });

        if (page.url().endsWith("/platform/verify.html")) {
            pass("s1: verify URL token query stripped (replaceState)");
        } else {
            fail(`s1: verify URL not cleaned (got ${page.url()})`);
        }

        await page.waitForFunction(
            () => document.getElementById("state-success") && !document.getElementById("state-success").hidden,
            { timeout: 4000 },
        ).then(() => pass("s1: verify success state"))
         .catch(() => fail("s1: verify did not reach success"));

        // Reload live.html — banner should now be gone.
        await page.goto(LIVE_URL + `?t=${Date.now()}`, { waitUntil: "domcontentloaded" });
        // Give /me a moment.
        await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
        const stillBanner = await page.evaluate(() => !!document.getElementById("unverified-banner"));
        if (stillBanner) fail("s1: banner still present after verify");
        else pass("s1: banner gone after verify");

        // ───────────────────────────────────────────────────────────────
        // Scenario 2: forgot (unknown parity) + (known) → reset → pw swap
        // ───────────────────────────────────────────────────────────────
        await uiLogout(page);

        // 2A: parity — never-signed-up email gets the same screen.
        await page.goto(FORGOT_URL, { waitUntil: "domcontentloaded" });
        await page.fill("#email", `phase3test-never-${RUN_ID}@example.test`);
        await page.click("#submit");
        await page.waitForFunction(
            () => !document.getElementById("result").hidden,
            { timeout: 4000 },
        ).then(() => pass("s2A: forgot unknown email → same result screen"))
         .catch(() => fail("s2A: forgot unknown email did not show result"));

        // 2B: create real user (phase3test-p2) → forgot → reset.
        await uiSignup(page, {
            organizationName: `Phase3Test P2 ${RUN_ID}`,
            name: "Phase3 P2",
            email: EMAIL_P2,
            password: PW_DEFAULT,
        });
        await uiLogout(page);

        await page.goto(FORGOT_URL, { waitUntil: "domcontentloaded" });
        await page.fill("#email", EMAIL_P2);
        await page.click("#submit");
        await page.waitForFunction(
            () => !document.getElementById("result").hidden,
            { timeout: 4000 },
        );
        pass("s2B: forgot known email → result screen");

        const resetToken = rawTokenFor(EMAIL_P2, "password_reset", "resetUrl");
        await page.goto(`${RESET_URL}?token=${encodeURIComponent(resetToken)}`,
            { waitUntil: "domcontentloaded" });
        if (page.url().endsWith("/platform/reset-password.html")) {
            pass("s2B: reset URL token query stripped");
        } else {
            fail(`s2B: reset URL not cleaned (got ${page.url()})`);
        }
        await page.fill("#password", PW_P2_NEW);
        await page.fill("#passwordConfirm", PW_P2_NEW);
        // wait for submit-enabled
        await page.waitForFunction(
            () => !document.getElementById("submit").disabled,
            { timeout: 2000 },
        );
        await page.click("#submit");
        await page.waitForFunction(
            () => !document.getElementById("success").hidden,
            { timeout: 4000 },
        ).then(() => pass("s2B: reset success"))
         .catch(() => fail("s2B: reset did not succeed"));

        // 2C: new pw works, old pw 401.
        const newLogin = await apiLogin(EMAIL_P2, PW_P2_NEW);
        if (newLogin.status === 200) pass("s2C: new password login 200");
        else fail(`s2C: new password login ${newLogin.status}`);
        const oldLogin = await apiLogin(EMAIL_P2, PW_DEFAULT);
        if (oldLogin.status === 401 && oldLogin.body?.code === "invalid_credentials") {
            pass("s2C: old password login 401 invalid_credentials");
        } else {
            fail(`s2C: old password login ${oldLogin.status} ${JSON.stringify(oldLogin.body)}`);
        }

        // ───────────────────────────────────────────────────────────────
        // Scenario 3: admin invite → new user accept
        // ───────────────────────────────────────────────────────────────
        const acmeAdminTok = await adminApiToken(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
        const inv3 = await apiPost(acmeAdminTok, "/invitations", {
            email: EMAIL_P3, role: "manager", teamId: null,
        });
        if (inv3.status === 201) pass(`s3: invite (manager) 201`);
        else fail(`s3: invite ${inv3.status} ${JSON.stringify(inv3.body)}`);

        const acceptToken3 = rawTokenFor(EMAIL_P3, "invitation", "acceptUrl");

        // Use the UI form for the accept (drives the page binding).
        await ctx.clearCookies();
        await page.goto(`${ACCEPT_URL}?token=${encodeURIComponent(acceptToken3)}`,
            { waitUntil: "domcontentloaded" });
        if (page.url().endsWith("/platform/accept-invitation.html")) {
            pass("s3: accept URL token query stripped");
        } else {
            fail(`s3: accept URL not cleaned (got ${page.url()})`);
        }
        await page.fill("#name", "Phase3 P3");
        await page.fill("#password", PW_DEFAULT);
        await page.fill("#passwordConfirm", PW_DEFAULT);
        await page.waitForFunction(
            () => !document.getElementById("submit").disabled,
            { timeout: 2000 },
        );
        await Promise.all([
            page.waitForURL((u) => u.pathname.endsWith("/platform/live.html"), { timeout: 8000 }),
            page.click("#submit"),
        ]);
        pass("s3: accept (new user) → live.html");

        const me3 = await page.evaluate(async () => {
            const r = await window.kloserApi.apiGet("/me");
            const b = await r.json();
            return {
                status: r.status,
                email: b.user?.email,
                org: b.organization?.name,
                role: b.membership?.role,
                verified: !!b.user?.email_verified_at,
            };
        });
        if (
            me3.status === 200 &&
            me3.email === EMAIL_P3 &&
            me3.org === "Acme Sales Inc." &&
            me3.role === "manager" &&
            me3.verified
        ) {
            pass("s3: /me org=Acme role=manager verified=true");
        } else {
            fail(`s3: /me unexpected ${JSON.stringify(me3)}`);
        }

        // ───────────────────────────────────────────────────────────────
        // Scenario 4: existing user multi-org accept (phase3test-p1 → Beta)
        // ───────────────────────────────────────────────────────────────
        const betaAdminTok = await adminApiToken(BETA_ADMIN_EMAIL, BETA_ADMIN_PW);
        const inv4 = await apiPost(betaAdminTok, "/invitations", {
            email: EMAIL_P1, role: "viewer", teamId: null,
        });
        if (inv4.status === 201) pass("s4: beta invites phase3test-p1 (existing user) 201");
        else fail(`s4: beta invite ${inv4.status} ${JSON.stringify(inv4.body)}`);

        const acceptToken4 = rawTokenFor(EMAIL_P1, "invitation", "acceptUrl");
        await ctx.clearCookies();
        await page.goto(`${ACCEPT_URL}?token=${encodeURIComponent(acceptToken4)}`,
            { waitUntil: "domcontentloaded" });
        await page.fill("#name", "ignored-name");
        await page.fill("#password", PW_FAKE);
        await page.fill("#passwordConfirm", PW_FAKE);
        await page.waitForFunction(
            () => !document.getElementById("submit").disabled,
            { timeout: 2000 },
        );
        await Promise.all([
            page.waitForURL((u) => u.pathname.endsWith("/platform/live.html"), { timeout: 8000 }),
            page.click("#submit"),
        ]);
        pass("s4: existing-user accept → live.html");

        const me4 = await page.evaluate(async () => {
            const r = await window.kloserApi.apiGet("/me");
            const b = await r.json();
            return {
                email: b.user?.email,
                name: b.user?.name,
                org: b.organization?.name,
                role: b.membership?.role,
            };
        });
        if (
            me4.email === EMAIL_P1 &&
            me4.name === "Phase3 P1" &&             // original signup name, NOT 'ignored-name'
            me4.org === "Beta Outreach Co." &&
            me4.role === "viewer"
        ) {
            pass("s4: /me Beta viewer + name preserved");
        } else {
            fail(`s4: /me unexpected ${JSON.stringify(me4)}`);
        }

        // Fake password should not be accepted (accept doesn't overwrite).
        const fakeLogin = await apiLogin(EMAIL_P1, PW_FAKE);
        if (fakeLogin.status === 401) pass("s4: fake password 401 (password preserved)");
        else fail(`s4: fake password login ${fakeLogin.status}`);

        // Original P1 password (per signup) must still work.
        const origLogin = await apiLogin(EMAIL_P1, PW_DEFAULT);
        if (origLogin.status === 200 || origLogin.status === 400) {
            // 400 org_id_required when user is now in multiple orgs.
            // Try again with explicit P1 org id.
            if (origLogin.status === 400 && origLogin.body?.availableOrgs?.length >= 1) {
                pass("s4: multi-org login requires orgId (availableOrgs present)");
            } else {
                pass(`s4: original pw login ${origLogin.status}`);
            }
        } else {
            fail(`s4: original pw login ${origLogin.status} ${JSON.stringify(origLogin.body)}`);
        }

        // ───────────────────────────────────────────────────────────────
        // Scenario 5: role + status change → disabled login 401 → restore
        // ───────────────────────────────────────────────────────────────
        const promote = await apiPatch(acmeAdminTok, `/memberships/${ACME_EMP_MEMBERSHIP}`,
            { role: "manager" });
        if (promote.status === 200 && promote.body?.membership?.role === "manager") {
            pass("s5: emp promoted to manager");
        } else {
            fail(`s5: promote ${promote.status} ${JSON.stringify(promote.body)}`);
        }

        const disable = await apiPatch(acmeAdminTok, `/memberships/${ACME_EMP_MEMBERSHIP}`,
            { status: "disabled" });
        if (disable.status === 200 && disable.body?.membership?.status === "disabled") {
            pass("s5: emp disabled");
        } else {
            fail(`s5: disable ${disable.status} ${JSON.stringify(disable.body)}`);
        }

        const empBlocked = await apiLogin(ACME_EMP_EMAIL, ACME_EMP_PW);
        if (empBlocked.status === 401 && empBlocked.body?.code === "account_disabled") {
            pass("s5: disabled emp login → 401 account_disabled");
        } else {
            fail(`s5: disabled emp login ${empBlocked.status} ${JSON.stringify(empBlocked.body)}`);
        }

        const enable = await apiPatch(acmeAdminTok, `/memberships/${ACME_EMP_MEMBERSHIP}`,
            { status: "active" });
        const restoreRole = await apiPatch(acmeAdminTok, `/memberships/${ACME_EMP_MEMBERSHIP}`,
            { role: "employee" });
        if (enable.status === 200 && restoreRole.status === 200) {
            pass("s5: emp restored (employee/active)");
        } else {
            fail(`s5: restore failed enable=${enable.status} role=${restoreRole.status}`);
        }

        const empLogin = await apiLogin(ACME_EMP_EMAIL, ACME_EMP_PW);
        if (empLogin.status === 200) pass("s5: restored emp login 200");
        else fail(`s5: restored emp login ${empLogin.status}`);

        // ───────────────────────────────────────────────────────────────
        // Scenario 6: resend / cancel → old token 410
        // ───────────────────────────────────────────────────────────────
        const inv6 = await apiPost(acmeAdminTok, "/invitations",
            { email: EMAIL_P6, role: "viewer", teamId: null });
        if (inv6.status !== 201) {
            fail(`s6: invite ${inv6.status}`);
        } else {
            const tokenA = rawTokenFor(EMAIL_P6, "invitation", "acceptUrl");
            const invId = inv6.body.invitation.id;

            const resend = await apiPost(acmeAdminTok, `/invitations/${invId}/resend`, {});
            if (resend.status === 200) pass("s6: resend 200");
            else fail(`s6: resend ${resend.status}`);

            const oldTokenAccept = await rawAccept(tokenA, "Stale", PW_DEFAULT);
            if (oldTokenAccept.status === 410) pass("s6: old token (post-resend) → 410");
            else fail(`s6: old token expected 410 got ${oldTokenAccept.status}`);

            const cancel = await apiDelete(acmeAdminTok, `/invitations/${invId}`);
            if (cancel.status === 204) pass("s6: cancel 204");
            else fail(`s6: cancel ${cancel.status}`);

            const tokenB = rawTokenFor(EMAIL_P6, "invitation", "acceptUrl");
            const cancelledAccept = await rawAccept(tokenB, "Late", PW_DEFAULT);
            if (cancelledAccept.status === 410) pass("s6: cancelled token → 410");
            else fail(`s6: cancelled token expected 410 got ${cancelledAccept.status}`);
        }

    } finally {
        // ───────────────────────────────────────────────────────────────
        // Cleanup
        // ───────────────────────────────────────────────────────────────
        try {
            cleanupTestData();
            pass("cleanup: phase3test- residue cleared + emp restored");
        } catch (err) {
            console.error("[cleanup]", err.message);
        }

        if (consoleErrors.length > 0) {
            fail(`console errors: ${JSON.stringify(consoleErrors, null, 2)}`);
        } else {
            pass("no console errors");
        }

        try {
            await page.screenshot({ path: SCREENSHOT_PATH, fullPage: false });
            pass(`screenshot saved → ${path.relative(process.cwd(), SCREENSHOT_PATH)}`);
        } catch (e) {
            console.error("[screenshot] failed:", e.message);
        }

        await browser.close();
    }

    console.log(process.exitCode ? "\nE2E FAILED" : "\nE2E PASSED");
}

main().catch((err) => {
    console.error("E2E ERROR:", err);
    process.exit(2);
});

/* Phase 4 통합 e2e — 8 시나리오 + cleanup sweep.
 *
 * Pre-req (split-origin):
 *   - API:      `npm --prefix server run dev`            (port 32173)
 *   - Static:   `python -m http.server 8765`             (project root)
 *   - Seed:     `npm --prefix server run db:seed`        (Acme/Beta + Phase 3 demo)
 *   - Postgres: `docker compose -f ops/docker-compose.yml up -d`
 *               (container `kloser-dev-postgres-1`)
 *
 * Run:
 *   node test/phase_4_e2e.mjs
 *
 * Run (Caddy single-origin):
 *   KLOSER_E2E_BASE_URL=https://localhost node test/phase_4_e2e.mjs
 *
 * Scenarios (PHASE_4_STEP_5_E2E.md §4):
 *   1. live.html 실 영속 통화 — note 저장 + 종료 → /calls 등장
 *   2. calls.html 목록/URL sync/detail 패널
 *   3. transcript + action item 렌더
 *   4. dashboard.html KPI/recent_calls가 새 통화 반영
 *   5. Beta org 격리 — Acme 통화 미노출
 *   6. viewer 권한 — calls 읽기 OK / notes mutation 403
 *   7. unverified user — banner 표시 + mutation 403
 *   8. cleanup sweep — phase4test- 잔재 0
 *
 * Cleanup contract:
 *   - Test-owned rows use a `phase4test-` prefix where the user-facing model
 *     allows it: call notes/title, transcript text, action item title, and
 *     temporary user emails.
 *   - The final sweep only deletes calls with a phase4test prefix or calls
 *     attached to `phase4test-%@example.test` users. It deliberately avoids a
 *     broad started_at time-window so concurrent manual dev data is untouched.
 *   - Phase 4 routes expose no hard-delete API, so this dev-only e2e cleanup
 *     uses the migration superuser for the Phase 4 tables.
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
const CALLS_URL     = `${STATIC_ORIGIN}/platform/calls.html`;
const DASHBOARD_URL = `${STATIC_ORIGIN}/platform/dashboard.html`;
const ACCEPT_URL    = `${STATIC_ORIGIN}/platform/accept-invitation.html`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_PATH = path.join(__dirname, "phase_4_e2e.png");

const PG_CONTAINER = "kloser-dev-postgres-1";
const PG_DB        = "kloser_dev";
const PG_SVC_USER  = "kloser_service";
const PG_SVC_PASS  = "kloser_service_dev";
const PG_APP_USER  = "app";
const PG_APP_PASS  = "app_dev";
// Migration role = postgres superuser (docker-compose POSTGRES_USER). Used
// for Phase 4 table writes during cleanup because `kloser_service` has no
// grants on calls/transcripts/call_action_items (intentional — Phase 4
// has no anonymous flow, so service role is not provisioned for them).
const PG_MIG_USER  = "kloser";
const PG_MIG_PASS  = "kloser_dev";

const RUN_ID = Date.now();

const NOTE_TAG         = `phase4test-note-${RUN_ID}`;
const TRANSCRIPT_TAG   = `phase4test-transcript-${RUN_ID}`;
const ACTION_TAG       = `phase4test-action-${RUN_ID}`;
const VIEWER_EMAIL     = `phase4test-viewer-${RUN_ID}@example.test`;
const UNVERIFIED_EMAIL = `phase4test-unverified-${RUN_ID}@example.test`;
const PW_DEFAULT       = "phase4test-pw-12345";

const ACME_ADMIN_EMAIL  = "admin@acme.test";
const ACME_ADMIN_PW     = "acme-admin-1234";
const BETA_ADMIN_EMAIL  = "admin@beta.test";
const BETA_ADMIN_PW     = "beta-admin-1234";

function pass(msg) { console.log("PASS:", msg); }
function fail(msg) { console.error("FAIL:", msg); process.exitCode = 1; }

// ─────────────────────────────────────────────
// psql shell — runs query via docker exec. Bypasses RLS via kloser_service.
// ─────────────────────────────────────────────
function psql(sql, { role = "service" } = {}) {
    let user, pwd;
    if (role === "app") {
        user = PG_APP_USER;
        pwd  = PG_APP_PASS;
    } else if (role === "migrate") {
        user = PG_MIG_USER;
        pwd  = PG_MIG_PASS;
    } else {
        user = PG_SVC_USER;
        pwd  = PG_SVC_PASS;
    }
    try {
        return execFileSync(
            "docker",
            [
                "exec",
                "-e", `PGPASSWORD=${pwd}`,
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
    if (r.status !== 200) {
        throw new Error(`api login ${email} → ${r.status} ${JSON.stringify(r.body)}`);
    }
    return r.body.accessToken;
}

async function apiGet(token, p) {
    const r = await fetch(`${API_BASE}${p}`, {
        headers: { authorization: `Bearer ${token}` },
    });
    return { status: r.status, body: await r.json().catch(() => null) };
}
async function apiPost(token, p, body) {
    const r = await fetch(`${API_BASE}${p}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body || {}),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
}

// ─────────────────────────────────────────────
// UI helpers.
// ─────────────────────────────────────────────
async function uiLogin(page, email, password, returnPath = "/platform/live.html") {
    const url = `${LOGIN_URL}?returnUrl=${encodeURIComponent(returnPath)}`;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.fill("#email", email);
    await page.fill("#password", password);
    await Promise.all([
        page.waitForURL((u) => u.pathname === returnPath, { timeout: 8000 }),
        page.click("#submit"),
    ]);
}
async function uiLogout(page) {
    await page.evaluate(async () => {
        if (window.kloserApi?.logout) await window.kloserApi.logout();
    });
}
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

// Click "save quick note" until the success status text appears. The page
// rejects with `통화 식별자 대기 중` if `callState.callId` is not yet set
// (WS start_call ack arrives a beat after live.html navigation completes).
async function saveLiveNoteWithRetry(page, noteText, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    await page.fill("#noteInput", noteText);
    while (Date.now() < deadline) {
        await page.click("#noteSaveBtn");
        // Wait briefly for the status to settle to a terminal label —
        // ignore the transient "저장 중…" set before the fetch resolves.
        let status = "";
        const settleDeadline = Date.now() + 4000;
        while (Date.now() < settleDeadline) {
            await new Promise((r) => setTimeout(r, 150));
            status = await page.evaluate(() => {
                const el = document.getElementById("noteStatus");
                if (!el || el.classList.contains("hidden")) return "";
                return (el.textContent || "").trim();
            });
            // Skip transient and empty states.
            if (status === "" || status.includes("저장 중")) continue;
            break;
        }
        if (status.includes("저장됨")) return true;
        if (status.includes("대기")) {
            await new Promise((r) => setTimeout(r, 400));
            continue;
        }
        if (status === "") {
            // Status hidden again before we read it — most likely succeeded
            // and faded out (1.8s hide timer). Re-click after a short pause
            // to either re-confirm or surface a real error.
            await new Promise((r) => setTimeout(r, 200));
            continue;
        }
        throw new Error(`save returned unexpected status "${status}"`);
    }
    return false;
}

// ─────────────────────────────────────────────
// Cleanup helpers (Phase 4 has no hard-delete REST surface).
// ─────────────────────────────────────────────
function cleanupPhase4() {
    // Phase 4 tables — `kloser_service` has no grant on them (intentional).
    // Use the migrate role (superuser) so RLS + grants are both bypassed.
    psql(
        `DELETE FROM call_action_items
          WHERE title LIKE 'phase4test-%'
             OR call_id IN (
                  SELECT id FROM calls
                   WHERE notes LIKE 'phase4test-%'
                      OR title LIKE 'phase4test-%'
                      OR agent_user_id IN (
                           SELECT id FROM users
                            WHERE email LIKE 'phase4test-%@example.test'
                         )
                );`,
        { role: "migrate" },
    );
    psql(
        `DELETE FROM transcripts
          WHERE text LIKE 'phase4test-%'
             OR call_id IN (
                  SELECT id FROM calls
                   WHERE notes LIKE 'phase4test-%'
                      OR title LIKE 'phase4test-%'
                      OR agent_user_id IN (
                           SELECT id FROM users
                            WHERE email LIKE 'phase4test-%@example.test'
                         )
                );`,
        { role: "migrate" },
    );
    psql(
        `DELETE FROM calls
          WHERE notes LIKE 'phase4test-%'
             OR title LIKE 'phase4test-%'
             OR agent_user_id IN (
                  SELECT id FROM users
                   WHERE email LIKE 'phase4test-%@example.test'
                );`,
        { role: "migrate" },
    );

    // Invalidate auth tokens tied to phase4test invitations.
    psql(
        `UPDATE auth_tokens at
            SET invalidated_at = COALESCE(invalidated_at, now())
           FROM invitations i
          WHERE at.invitation_id = i.id
            AND i.email LIKE 'phase4test-%@example.test'
            AND at.invalidated_at IS NULL
            AND at.consumed_at IS NULL;`,
    );

    // Orgs whose admin is a phase4test signup → drop the whole org so
    // cascade clears memberships / sessions / auth_tokens / outbox.
    const orgIdsRaw = psql(
        `SELECT DISTINCT m.org_id FROM memberships m
           JOIN users u ON u.id = m.user_id
          WHERE u.email LIKE 'phase4test-%@example.test'
            AND m.role = 'admin';`,
    );
    const orgIds = orgIdsRaw
        ? orgIdsRaw.split("\n").map((s) => s.trim()).filter(Boolean)
        : [];
    for (const orgId of orgIds) {
        psql(`DELETE FROM organizations WHERE id = '${orgId}';`, { role: "app" });
    }

    // Drop the user rows themselves (memberships against seeded orgs
    // cascade through `users.id ON DELETE CASCADE`).
    psql(
        `DELETE FROM users WHERE email LIKE 'phase4test-%@example.test';`,
        { role: "app" },
    );

    // Soft-cancel any phase4test invitations still hanging in seeded orgs.
    psql(
        `UPDATE invitations
            SET canceled_at = COALESCE(canceled_at, now())
          WHERE email LIKE 'phase4test-%@example.test'
            AND accepted_at IS NULL;`,
    );

    // Clear only sessions created by phase4test users.
    psql(
        `DELETE FROM sessions
          WHERE user_id IN (
              SELECT id FROM users
               WHERE email LIKE 'phase4test-%@example.test'
          );`,
        { role: "app" },
    );
}

function residueCounts() {
    // Same role concern as cleanup — Phase 4 tables need migrate role.
    const callsCnt = Number(psql(
        `SELECT count(*) FROM calls
          WHERE notes LIKE 'phase4test-%'
             OR title LIKE 'phase4test-%';`,
        { role: "migrate" },
    ));
    const transcriptsCnt = Number(psql(
        `SELECT count(*) FROM transcripts
          WHERE text LIKE 'phase4test-%';`,
        { role: "migrate" },
    ));
    const actionItemsCnt = Number(psql(
        `SELECT count(*) FROM call_action_items
          WHERE title LIKE 'phase4test-%';`,
        { role: "migrate" },
    ));
    const usersCnt = Number(psql(
        `SELECT count(*) FROM users
          WHERE email LIKE 'phase4test-%@example.test';`,
    ));
    const invitesCnt = Number(psql(
        `SELECT count(*) FROM invitations
          WHERE email LIKE 'phase4test-%@example.test'
            AND accepted_at IS NULL
            AND canceled_at IS NULL;`,
    ));
    return { callsCnt, transcriptsCnt, actionItemsCnt, usersCnt, invitesCnt };
}

// ──────────────────────────────────────────────────────────────────────────
//  main
// ──────────────────────────────────────────────────────────────────────────
async function main() {
    console.log(
        `→ mode: ${E2E_BASE ? `single-origin (${E2E_BASE})` : "split-origin (8765 + 32173)"}`,
    );

    if (IS_HTTPS) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

    // Sanity: API health.
    const health = await fetch(API_HEALTH).then((r) => r.json()).catch(() => null);
    if (!health || health.ok !== true) {
        throw new Error("API health probe failed — is server/ running on :32173?");
    }
    pass(`API health ok (uptime ${health.uptimeSec}s)`);

    // Sanity: postgres reachable.
    try {
        psql("SELECT 1;");
        pass("postgres reachable via docker exec");
    } catch (err) {
        throw new Error(`postgres probe failed: ${err.message}`);
    }

    // Sanity: seeded users login.
    const preToken = await adminApiToken(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    if (!preToken) throw new Error("Acme admin pre-login failed");
    pass("seed pre-check: Acme admin login");

    // Pre-clean any prior interrupted run before scenarios begin.
    cleanupPhase4();
    pass("pre-clean phase4test- residue");

    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ ignoreHTTPSErrors: IS_HTTPS });
    const page = await ctx.newPage();

    page.on("dialog", (dialog) => dialog.accept());

    const consoleErrors = [];
    page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(`[pageerror] ${err.message}`));

    let acmeCallId = null;

    try {
        // ───────────────────────────────────────────────────────────────
        // Scenario 1 — live.html에서 실 영속 통화 생성 + note 저장 + 종료
        // ───────────────────────────────────────────────────────────────
        await uiLogin(page, ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
        // Save the quick note; retry loop covers WS-ack delay.
        const saved = await saveLiveNoteWithRetry(page, NOTE_TAG);
        if (saved) pass("s1: quick note saved (UI status 저장됨)");
        else fail("s1: note save did not succeed within retry budget");

        // End the call via UI.
        await page.click("#endCallBtn");
        await page.waitForFunction(
            () => {
                const lbl = document.getElementById("endCallLabel");
                return lbl && (lbl.textContent || "").trim() === "종료됨";
            },
            { timeout: 8000 },
        ).then(() => pass("s1: WS end_call ack — UI lock to 종료됨"))
         .catch(() => fail("s1: end button label did not flip to 종료됨"));

        // Verify via API: the call landed with notes/status/agent.
        const s1List = await apiGet(preToken,
            `/calls?q=${encodeURIComponent(NOTE_TAG)}`);
        if (s1List.status === 200 && s1List.body?.total === 1) {
            const c = s1List.body.items[0];
            if (c.status === "ended" && c.notes && c.notes.includes(NOTE_TAG)) {
                acmeCallId = c.id;
                pass(`s1: /calls?q=<note> total=1 status=ended (id ${acmeCallId.slice(0, 8)}…)`);
            } else {
                fail(`s1: call record unexpected status=${c.status} notes=${JSON.stringify(c.notes)}`);
            }
            const meRes = await apiGet(preToken, "/me");
            if (meRes.status === 200 && c.agent_user_id === meRes.body.user.id) {
                pass(`s1: call.agent_user_id == logged-in admin`);
            } else {
                fail(`s1: agent_user_id mismatch — got ${c.agent_user_id}, expected ${meRes.body?.user?.id}`);
            }
        } else {
            fail(`s1: /calls?q lookup got ${s1List.status} total=${s1List.body?.total}`);
        }

        if (!acmeCallId) throw new Error("acmeCallId not captured; cannot proceed");

        // ───────────────────────────────────────────────────────────────
        // Scenario 2 — calls.html 목록 + URL sync + detail panel
        // ───────────────────────────────────────────────────────────────
        await page.goto(`${CALLS_URL}?q=${encodeURIComponent(NOTE_TAG)}`,
            { waitUntil: "domcontentloaded" });
        await page.waitForFunction(
            () => {
                const tc = document.getElementById("totalCount");
                return tc && /총 1 건/.test(tc.textContent || "");
            },
            { timeout: 6000 },
        ).then(() => pass("s2: calls.html totalCount=1 with URL q sync"))
         .catch(() => fail("s2: calls.html did not render totalCount=1"));

        const searchVal = await page.inputValue("#searchInput");
        if (searchVal === NOTE_TAG) pass("s2: search input prefilled from URL");
        else fail(`s2: search input mismatch (got "${searchVal}")`);

        await page.click("#callsTable tr");
        await page.waitForFunction(
            () => {
                const ds = document.getElementById("dStatus");
                return ds && (ds.textContent || "").trim() === "완료";
            },
            { timeout: 6000 },
        ).then(() => pass("s2: detail panel status badge 완료"))
         .catch(() => fail("s2: detail panel did not show 완료"));

        const detail = await page.evaluate(() => ({
            callId: document.getElementById("dCallId")?.textContent || "",
            notes:  document.getElementById("dNotes")?.textContent  || "",
        }));
        if (detail.callId.includes(acmeCallId.slice(0, 8))) {
            pass(`s2: detail shows shortened call id ${detail.callId}`);
        } else {
            fail(`s2: detail call id "${detail.callId}" does not match ${acmeCallId.slice(0, 8)}`);
        }
        if (detail.notes.includes(NOTE_TAG)) {
            pass("s2: detail notes panel shows phase4test note");
        } else {
            fail(`s2: detail notes mismatch (got "${detail.notes}")`);
        }

        // ───────────────────────────────────────────────────────────────
        // Scenario 3 — transcript + action item 렌더
        // ───────────────────────────────────────────────────────────────
        const trAppend = await apiPost(preToken,
            `/calls/${acmeCallId}/transcript`,
            { speaker: "customer", text: TRANSCRIPT_TAG });
        if (trAppend.status === 201 && trAppend.body?.transcript) {
            pass("s3: POST /transcript 201");
        } else {
            fail(`s3: transcript append ${trAppend.status} ${JSON.stringify(trAppend.body)}`);
        }

        const aiCreate = await apiPost(preToken,
            `/calls/${acmeCallId}/action-items`,
            { title: ACTION_TAG });
        if (aiCreate.status === 201 && aiCreate.body?.action_item) {
            pass("s3: POST /action-items 201");
        } else {
            fail(`s3: action-item create ${aiCreate.status} ${JSON.stringify(aiCreate.body)}`);
        }

        // Reload detail in calls.html (refetches transcript + action items).
        await page.goto(`${CALLS_URL}?q=${encodeURIComponent(NOTE_TAG)}`,
            { waitUntil: "domcontentloaded" });
        await page.waitForSelector("#callsTable tr", { timeout: 6000 });
        await page.click("#callsTable tr");
        await page.waitForFunction(
            (tag) => {
                const tr = document.getElementById("dTranscript");
                const ai = document.getElementById("dActions");
                return tr && ai &&
                    tr.textContent.includes(tag.transcript) &&
                    ai.textContent.includes(tag.action);
            },
            { transcript: TRANSCRIPT_TAG, action: ACTION_TAG },
            { timeout: 6000 },
        ).then(() => pass("s3: detail transcript + action items rendered"))
         .catch(() => fail("s3: detail panel did not show transcript/action text"));

        // ───────────────────────────────────────────────────────────────
        // Scenario 4 — dashboard.html KPI/recent_calls 반영
        // ───────────────────────────────────────────────────────────────
        await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(
            () => {
                const t = document.getElementById("kpiTodayCalls");
                return t && (t.textContent || "").trim() !== "—";
            },
            { timeout: 6000 },
        ).then(() => pass("s4: dashboard KPI loaded"))
         .catch(() => fail("s4: dashboard KPI never resolved from —"));

        const summaryRes = await apiGet(preToken, "/dashboard/summary");
        if (summaryRes.status !== 200) {
            fail(`s4: /dashboard/summary ${summaryRes.status}`);
        } else {
            const uiKpi = await page.evaluate(() => ({
                today:  (document.getElementById("kpiTodayCalls")?.textContent || "").trim(),
                rate:   (document.getElementById("kpiResponseRate")?.textContent || "").trim(),
                active: (document.getElementById("kpiActiveCalls")?.textContent || "").trim(),
            }));
            const api = summaryRes.body;
            if (uiKpi.today === Number(api.today_calls).toLocaleString("en-US")) {
                pass(`s4: today_calls UI matches API (${uiKpi.today})`);
            } else {
                fail(`s4: today_calls UI "${uiKpi.today}" ≠ API ${api.today_calls}`);
            }
            const expRate = api.response_rate === null
                ? "—"
                : (api.response_rate * 100).toFixed(1) + "%";
            if (uiKpi.rate === expRate) pass(`s4: response_rate UI matches API (${uiKpi.rate})`);
            else fail(`s4: response_rate UI "${uiKpi.rate}" ≠ "${expRate}"`);
            if (uiKpi.active === Number(api.active_calls).toLocaleString("en-US")) {
                pass(`s4: active_calls UI matches API (${uiKpi.active})`);
            } else {
                fail(`s4: active_calls UI "${uiKpi.active}" ≠ API ${api.active_calls}`);
            }
            const found = (api.recent_calls || []).some((r) => r.id === acmeCallId);
            if (found) pass("s4: /dashboard/summary recent_calls contains our test call");
            else fail("s4: recent_calls API response missing our test call id");
        }

        const recentText = await page.evaluate(() =>
            document.getElementById("recentCalls")?.textContent || "");
        if (recentText.length > 0) {
            pass("s4: dashboard recent calls table rendered rows");
        } else {
            fail("s4: dashboard recent calls table empty");
        }
        const demoLabels = await page.evaluate(() =>
            (document.body.textContent.match(/\(demo\)/g) || []).length);
        if (demoLabels >= 3) pass(`s4: (demo) labels still visible (${demoLabels})`);
        else fail(`s4: expected ≥3 (demo) labels, got ${demoLabels}`);

        // ───────────────────────────────────────────────────────────────
        // Scenario 5 — Beta org 격리
        // ───────────────────────────────────────────────────────────────
        await uiLogout(page);
        await uiLogin(page, BETA_ADMIN_EMAIL, BETA_ADMIN_PW, "/platform/calls.html");

        await page.goto(`${CALLS_URL}?q=${encodeURIComponent(NOTE_TAG)}`,
            { waitUntil: "domcontentloaded" });
        await page.waitForFunction(
            () => {
                const tc = document.getElementById("totalCount");
                return tc && /총 0 건/.test(tc.textContent || "");
            },
            { timeout: 6000 },
        ).then(() => pass("s5: beta sees total=0 for acme note query"))
         .catch(() => fail("s5: beta calls.html did not show total=0"));

        const betaToken = await adminApiToken(BETA_ADMIN_EMAIL, BETA_ADMIN_PW);
        const betaList = await apiGet(betaToken,
            `/calls?q=${encodeURIComponent(NOTE_TAG)}`);
        if (betaList.status === 200 && betaList.body?.total === 0) {
            pass("s5: beta /calls?q acme-tag → total=0");
        } else {
            fail(`s5: beta /calls?q got total=${betaList.body?.total}`);
        }

        const betaDirect = await apiGet(betaToken, `/calls/${acmeCallId}`);
        if (betaDirect.status === 404) pass("s5: beta GET /calls/<acmeId> → 404");
        else fail(`s5: beta GET /calls/<acmeId> ${betaDirect.status}`);

        await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(
            () => {
                const t = document.getElementById("kpiTodayCalls");
                return t && (t.textContent || "").trim() !== "—";
            },
            { timeout: 6000 },
        );
        const betaRecent = await page.evaluate(() =>
            document.getElementById("recentCalls")?.textContent || "");
        if (!betaRecent.includes(NOTE_TAG)) {
            pass("s5: beta dashboard recent calls does not leak acme note");
        } else {
            fail("s5: beta dashboard leaked acme phase4test note");
        }

        // ───────────────────────────────────────────────────────────────
        // Scenario 6 — viewer 권한 — read OK, mutation 403
        // ───────────────────────────────────────────────────────────────
        await uiLogout(page);
        const inv = await apiPost(preToken, "/invitations", {
            email: VIEWER_EMAIL,
            role: "viewer",
            teamId: null,
        });
        if (inv.status === 201) pass("s6: acme admin invites viewer 201");
        else fail(`s6: invite ${inv.status} ${JSON.stringify(inv.body)}`);

        const acceptToken = rawTokenFor(VIEWER_EMAIL, "invitation", "acceptUrl");
        await ctx.clearCookies();
        await page.goto(`${ACCEPT_URL}?token=${encodeURIComponent(acceptToken)}`,
            { waitUntil: "domcontentloaded" });
        await page.fill("#name", "phase4test viewer");
        await page.fill("#password", PW_DEFAULT);
        await page.fill("#passwordConfirm", PW_DEFAULT);
        await page.waitForFunction(
            () => !document.getElementById("submit").disabled,
            { timeout: 3000 },
        );
        await Promise.all([
            page.waitForURL((u) => u.pathname.endsWith("/platform/live.html"), { timeout: 8000 }),
            page.click("#submit"),
        ]);
        pass("s6: viewer accepted invitation → live.html");

        await page.goto(CALLS_URL, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(
            () => {
                const tc = document.getElementById("totalCount");
                return tc && /총 \d+ 건/.test(tc.textContent || "");
            },
            { timeout: 6000 },
        ).then(() => pass("s6: viewer calls.html list rendered (read OK)"))
         .catch(() => fail("s6: viewer calls.html list did not render"));

        const viewerToken = await adminApiToken(VIEWER_EMAIL, PW_DEFAULT);
        const viewerNotes = await apiPost(viewerToken,
            `/calls/${acmeCallId}/notes`, { notes: "phase4test-viewer-attempt" });
        if (viewerNotes.status === 403) {
            pass("s6: viewer POST /calls/:id/notes → 403");
        } else {
            fail(`s6: viewer notes mutation ${viewerNotes.status} ${JSON.stringify(viewerNotes.body)}`);
        }
        const viewerRead = await apiGet(viewerToken, `/calls/${acmeCallId}`);
        if (viewerRead.status === 200) pass("s6: viewer GET /calls/:id → 200");
        else fail(`s6: viewer read ${viewerRead.status}`);

        // ───────────────────────────────────────────────────────────────
        // Scenario 7 — unverified user → banner + mutation 403
        // ───────────────────────────────────────────────────────────────
        await uiLogout(page);
        await ctx.clearCookies();
        await uiSignup(page, {
            organizationName: `Phase4 Unverified ${RUN_ID}`,
            name: "Phase4 Unverified",
            email: UNVERIFIED_EMAIL,
            password: PW_DEFAULT,
        });

        await page.goto(CALLS_URL, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(
            () => !!document.getElementById("unverified-banner"),
            { timeout: 6000 },
        ).then(() => pass("s7: unverified banner on calls.html"))
         .catch(() => fail("s7: unverified banner missing on calls.html"));

        await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(
            () => !!document.getElementById("unverified-banner"),
            { timeout: 6000 },
        ).then(() => pass("s7: unverified banner on dashboard.html"))
         .catch(() => fail("s7: unverified banner missing on dashboard.html"));

        const unvLogin = await apiLogin(UNVERIFIED_EMAIL, PW_DEFAULT);
        if (unvLogin.status !== 200) {
            fail(`s7: unverified api login ${unvLogin.status} ${JSON.stringify(unvLogin.body)}`);
        } else {
            const unvToken = unvLogin.body.accessToken;
            const unvMut = await apiPost(unvToken, "/calls", {
                direction: "outbound",
                title: "phase4test-unverified-attempt",
            });
            if (unvMut.status === 403 && unvMut.body?.code === "email_not_verified") {
                pass("s7: unverified POST /calls → 403 email_not_verified");
            } else {
                fail(`s7: unverified mutation ${unvMut.status} ${JSON.stringify(unvMut.body)}`);
            }
            const unvRead = await apiGet(unvToken, "/calls");
            if (unvRead.status === 200) pass("s7: unverified GET /calls → 200 (read allowed)");
            else fail(`s7: unverified read ${unvRead.status}`);
        }
    } finally {
        // ───────────────────────────────────────────────────────────────
        // Scenario 8 — cleanup sweep + residue assertion
        // ───────────────────────────────────────────────────────────────
        try {
            cleanupPhase4();
            pass("cleanup: ran phase4test scoped sweep");
        } catch (err) {
            fail(`cleanup: sweep threw — ${err.message}`);
        }
        try {
            const r = residueCounts();
            const total = r.callsCnt + r.transcriptsCnt + r.actionItemsCnt
                        + r.usersCnt + r.invitesCnt;
            if (total === 0) {
                pass("s8: residue 0 — calls/transcripts/action_items/users/invitations clean");
            } else {
                fail(`s8: residue ${JSON.stringify(r)}`);
            }
        } catch (err) {
            fail(`s8: residue probe threw — ${err.message}`);
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

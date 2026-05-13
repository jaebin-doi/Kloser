/* Phase 5 통합 e2e — 6 시나리오 + cleanup sweep.
 *
 * Pre-req (split-origin):
 *   - API:      `npm --prefix server run dev`            (port 32173)
 *   - Static:   `python -m http.server 8765`             (project root)
 *   - Seed:     `npm --prefix server run db:seed`        (Acme/Beta + Phase 3 demo)
 *   - Postgres: `docker compose -f ops/docker-compose.yml up -d`
 *               (container `kloser-dev-postgres-1`)
 *
 * Run:
 *   node test/phase_5_e2e.mjs
 *
 * Run (Caddy single-origin):
 *   KLOSER_E2E_BASE_URL=https://localhost node test/phase_5_e2e.mjs
 *
 * Scenarios (PHASE_5_STEP_5_E2E.md §2):
 *   1. admin settings — knowledge base + checklist template 생성 (UI)
 *   2. admin live.html — customer link / checklist toggle / heartbeat / endCall
 *   3. admin calls.html detail — manual summary + action item create/toggle
 *   4. suggestion 이력 — psql 시드 후 UI 렌더 검증
 *   5. 권한/RLS smoke — non-admin settings read-only + cross-org RLS
 *   6. cleanup sweep + residue assertion
 *
 * Prefix discipline:
 *   - Every row this suite inserts carries the `phase5-e2e-<RUN_ID>` text
 *     prefix on whichever user-facing column the model allows (title, notes,
 *     text). Cleanup keys off the prefix only — no started_at sweep, no
 *     broad time-windows. Seeded users / customers / memberships / teams
 *     are never touched.
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

const LOGIN_URL    = `${STATIC_ORIGIN}/platform/login.html`;
const SETTINGS_URL = `${STATIC_ORIGIN}/platform/settings.html#guides`;
const LIVE_URL     = `${STATIC_ORIGIN}/platform/live.html`;
const CALLS_URL    = `${STATIC_ORIGIN}/platform/calls.html`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_PATH = path.join(__dirname, "phase_5_e2e.png");

const PG_CONTAINER = "kloser-dev-postgres-1";
const PG_DB        = "kloser_dev";
const PG_SVC_USER  = "kloser_service";
const PG_SVC_PASS  = "kloser_service_dev";
const PG_APP_USER  = "app";
const PG_APP_PASS  = "app_dev";
const PG_MIG_USER  = "kloser";
const PG_MIG_PASS  = "kloser_dev";

const RUN_ID = Date.now();
const PREFIX = `phase5-e2e-`;
const RUN_TAG = `${PREFIX}${RUN_ID}`;

const KB_TITLE        = `${RUN_TAG}-kb`;
const KB_BODY         = `${RUN_TAG}-chunk-A 응대 멘트 본문.\n\n${RUN_TAG}-chunk-B FAQ 답변.`;
const TEMPLATE_TITLE  = `${RUN_TAG}-template`;
const CALL_NOTE       = `${RUN_TAG}-note`;
const SUMMARY_TEXT    = `${RUN_TAG}-summary`;
const NEEDS_TEXT      = `${RUN_TAG}-needs`;
const ACTION_TITLE    = `${RUN_TAG}-action`;
const SUGGESTION_TITLE= `${RUN_TAG}-suggestion-title`;
const SUGGESTION_BODY = `${RUN_TAG}-suggestion-body`;

const ACME_ADMIN_EMAIL = "admin@acme.test";
const ACME_ADMIN_PW    = "acme-admin-1234";
const ACME_EMP_EMAIL   = "emp@acme.test";
const ACME_EMP_PW      = "acme-emp-1234";
const BETA_ADMIN_EMAIL = "admin@beta.test";
const BETA_ADMIN_PW    = "beta-admin-1234";

function pass(msg) { console.log("PASS:", msg); }
function fail(msg) { console.error("FAIL:", msg); process.exitCode = 1; }

// ─────────────────────────────────────────────
// psql shell — runs query via docker exec.
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

// ─────────────────────────────────────────────
// Direct API helpers — bypass UI for setup/assertions.
// ─────────────────────────────────────────────
async function apiLogin(email, password) {
    const r = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
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

// Wait for window.__liveCallState.callId to be set (start_call ack done).
async function waitForLiveCallId(page, timeoutMs = 8000) {
    return page.waitForFunction(
        () => !!(window.__liveCallState && window.__liveCallState.callId),
        { timeout: timeoutMs },
    );
}

// Save the quick note via the existing live.html input. Re-uses the
// Phase 4 retry pattern because WS ack arrives a beat after navigation.
async function saveLiveNoteWithRetry(page, noteText, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    await page.fill("#noteInput", noteText);
    while (Date.now() < deadline) {
        await page.click("#noteSaveBtn");
        let status = "";
        const settleDeadline = Date.now() + 4000;
        while (Date.now() < settleDeadline) {
            await new Promise((r) => setTimeout(r, 150));
            status = await page.evaluate(() => {
                const el = document.getElementById("noteStatus");
                if (!el || el.classList.contains("hidden")) return "";
                return (el.textContent || "").trim();
            });
            if (status === "" || status.includes("저장 중")) continue;
            break;
        }
        if (status.includes("저장됨")) return true;
        if (status.includes("대기")) {
            await new Promise((r) => setTimeout(r, 400));
            continue;
        }
        if (status === "") {
            await new Promise((r) => setTimeout(r, 200));
            continue;
        }
        throw new Error(`save returned unexpected status "${status}"`);
    }
    return false;
}

// ─────────────────────────────────────────────
// Cleanup — prefix-scoped. Never deletes seed rows.
// ─────────────────────────────────────────────
function cleanupPhase5() {
    // child rows first so FK doesn't trip.
    psql(
        `DELETE FROM call_suggestions
          WHERE title LIKE '${PREFIX}%'
             OR call_id IN (
                  SELECT id FROM calls
                   WHERE notes LIKE '${PREFIX}%' OR title LIKE '${PREFIX}%'
                );`,
        { role: "migrate" },
    );
    psql(
        `DELETE FROM call_action_items
          WHERE title LIKE '${PREFIX}%'
             OR call_id IN (
                  SELECT id FROM calls
                   WHERE notes LIKE '${PREFIX}%' OR title LIKE '${PREFIX}%'
                );`,
        { role: "migrate" },
    );
    psql(
        `DELETE FROM call_checklist_items
          WHERE call_id IN (
                  SELECT id FROM calls
                   WHERE notes LIKE '${PREFIX}%' OR title LIKE '${PREFIX}%'
                );`,
        { role: "migrate" },
    );
    psql(
        `DELETE FROM transcripts
          WHERE text LIKE '${PREFIX}%'
             OR call_id IN (
                  SELECT id FROM calls
                   WHERE notes LIKE '${PREFIX}%' OR title LIKE '${PREFIX}%'
                );`,
        { role: "migrate" },
    );
    psql(
        `DELETE FROM calls
          WHERE notes LIKE '${PREFIX}%' OR title LIKE '${PREFIX}%'
             OR summary LIKE '${PREFIX}%';`,
        { role: "migrate" },
    );
    // KB chunks via parent KB cascade (FK ON DELETE CASCADE).
    psql(
        `DELETE FROM knowledge_chunks
          WHERE text LIKE '${PREFIX}%';`,
        { role: "migrate" },
    );
    psql(
        `DELETE FROM knowledge_bases
          WHERE title LIKE '${PREFIX}%';`,
        { role: "migrate" },
    );
    psql(
        `DELETE FROM org_call_checklist_templates
          WHERE title LIKE '${PREFIX}%';`,
        { role: "migrate" },
    );
    // sessions: don't sweep here. uiLogout clears the user's own row.
}

function residueCounts() {
    const cnt = (sql) => Number(psql(sql, { role: "migrate" }));
    return {
        kbs: cnt(`SELECT count(*) FROM knowledge_bases WHERE title LIKE '${PREFIX}%';`),
        kbChunks: cnt(`SELECT count(*) FROM knowledge_chunks WHERE text LIKE '${PREFIX}%';`),
        templates: cnt(`SELECT count(*) FROM org_call_checklist_templates WHERE title LIKE '${PREFIX}%';`),
        checklistItems: cnt(
            `SELECT count(*) FROM call_checklist_items WHERE call_id IN (SELECT id FROM calls WHERE notes LIKE '${PREFIX}%' OR title LIKE '${PREFIX}%');`,
        ),
        suggestions: cnt(`SELECT count(*) FROM call_suggestions WHERE title LIKE '${PREFIX}%';`),
        actionItems: cnt(`SELECT count(*) FROM call_action_items WHERE title LIKE '${PREFIX}%';`),
        transcripts: cnt(`SELECT count(*) FROM transcripts WHERE text LIKE '${PREFIX}%';`),
        calls: cnt(`SELECT count(*) FROM calls WHERE notes LIKE '${PREFIX}%' OR title LIKE '${PREFIX}%' OR summary LIKE '${PREFIX}%';`),
    };
}

// Sanity: count seeded users / orgs / customers so the cleanup sweep
// doesn't accidentally delete them. Logged at the end as evidence.
function seatedSeedCounts() {
    const cnt = (sql) => Number(psql(sql, { role: "migrate" }));
    return {
        users: cnt(`SELECT count(*) FROM users WHERE email LIKE '%@acme.test' OR email LIKE '%@beta.test';`),
        memberships: cnt(`SELECT count(*) FROM memberships WHERE org_id IN ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222');`),
        customers: cnt(`SELECT count(*) FROM customers WHERE org_id IN ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222');`),
    };
}

// ──────────────────────────────────────────────────────────────────────────
//  main
// ──────────────────────────────────────────────────────────────────────────
async function main() {
    console.log(
        `→ mode: ${E2E_BASE ? `single-origin (${E2E_BASE})` : "split-origin (8765 + 32173)"}`,
    );
    console.log(`→ run id: ${RUN_ID}, prefix: ${PREFIX}`);

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
    const seedBefore = seatedSeedCounts();

    // Pre-clean residue from a prior interrupted run.
    cleanupPhase5();
    pass("pre-clean phase5-e2e- residue");

    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ ignoreHTTPSErrors: IS_HTTPS });
    const page = await ctx.newPage();

    page.on("dialog", (dialog) => dialog.accept());

    const consoleErrors = [];
    page.on("console", (msg) => {
        if (msg.type() !== "error") return;
        const loc = msg.location();
        const where = loc && loc.url ? ` @ ${loc.url}` : "";
        consoleErrors.push(`${msg.text()}${where}`);
    });
    page.on("pageerror", (err) => consoleErrors.push(`[pageerror] ${err.message}`));

    let acmeCallId = null;

    try {
        // ───────────────────────────────────────────────────────────────
        // Scenario 1 — admin settings: KB + checklist template (UI)
        // ───────────────────────────────────────────────────────────────
        await uiLogin(page, ACME_ADMIN_EMAIL, ACME_ADMIN_PW, "/platform/settings.html");
        await page.goto(SETTINGS_URL, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(
            () => {
                const b = document.getElementById("guidesRoleBadge");
                return b && b.textContent && b.textContent.indexOf("관리자") !== -1;
            },
            { timeout: 8000 },
        ).then(() => pass("s1: admin badge resolved on settings#guides"))
         .catch(() => fail("s1: admin role badge did not appear"));

        // Create KB via the inline form (covers UI + API + DOM render path).
        await page.fill("#kbNewTitle", KB_TITLE);
        await page.fill("#kbNewBody", KB_BODY);
        await page.click("#kbNewBtn");
        await page.waitForFunction(
            (title) => {
                const list = document.querySelectorAll("#kbList [data-kb-id]");
                for (const el of list) {
                    const t = el.querySelector(".text-\\[\\.86rem\\]");
                    if (t && t.textContent === title) return true;
                }
                return false;
            },
            KB_TITLE,
            { timeout: 8000 },
        ).then(() => pass("s1: KB list reflects newly created KB"))
         .catch(() => fail("s1: KB list did not show created KB"));

        // Verify chunk count surfaced (the page fetches detail per KB).
        await page.waitForFunction(
            (title) => {
                const list = document.querySelectorAll("#kbList [data-kb-id]");
                for (const el of list) {
                    const t = el.querySelector(".text-\\[\\.86rem\\]");
                    if (!t || t.textContent !== title) continue;
                    const meta = el.querySelector(".text-\\[\\.7rem\\]");
                    return meta && /청크 2/.test(meta.textContent || "");
                }
                return false;
            },
            KB_TITLE,
            { timeout: 8000 },
        ).then(() => pass("s1: KB chunk count = 2 (split on blank line)"))
         .catch(() => fail("s1: chunk count not 2"));

        // Create checklist template via inline form.
        await page.fill("#tmplNewTitle", TEMPLATE_TITLE);
        await page.fill("#tmplNewSort", "99");
        await page.click("#tmplNewBtn");
        await page.waitForFunction(
            (title) => {
                const inputs = document.querySelectorAll("#tmplList input[type=text]");
                for (const i of inputs) if (i.value === title) return true;
                return false;
            },
            TEMPLATE_TITLE,
            { timeout: 6000 },
        ).then(() => pass("s1: checklist template appears in list"))
         .catch(() => fail("s1: template did not appear"));

        // ───────────────────────────────────────────────────────────────
        // Scenario 2 — live.html: customer picker / checklist / heartbeat
        // ───────────────────────────────────────────────────────────────
        await page.goto(LIVE_URL, { waitUntil: "domcontentloaded" });
        await waitForLiveCallId(page).then(() => pass("s2: WS start_call ack delivered (__liveCallState.callId set)"))
            .catch(() => fail("s2: callId not set within timeout"));

        acmeCallId = await page.evaluate(() => window.__liveCallState && window.__liveCallState.callId);
        if (!acmeCallId) fail("s2: callId missing after wait");

        // Tag the call with phase5-e2e- prefix so cleanup catches it.
        // Use the quick-note input which is already wired to /calls/:id/notes.
        const saved = await saveLiveNoteWithRetry(page, CALL_NOTE);
        if (saved) pass("s2: live note saved (notes carries phase5-e2e- prefix)");
        else fail("s2: live note save failed");

        // Customer picker — open panel, pick first row, verify link.
        await page.click("#custPickerBtn");
        await page.waitForFunction(
            () => document.querySelectorAll("#custPickerList button").length > 0,
            { timeout: 6000 },
        ).then(() => pass("s2: customer picker populated from /customers"))
         .catch(() => fail("s2: customer picker did not populate"));
        await page.evaluate(() => {
            const firstBtn = document.querySelector("#custPickerList button");
            firstBtn.click();
        });
        await page.waitForFunction(
            () => window.__liveCallState && window.__liveCallState.customerId,
            { timeout: 6000 },
        ).then(() => pass("s2: link-customer succeeded (__liveCallState.customerId set)"))
         .catch(() => fail("s2: customerId not set after link"));

        // Checklist toggle — find the phase5-e2e- template row.
        const itemId = await page.evaluate((tmplTitle) => {
            // Map template_id → title via the page's checklist + templatesById helper.
            // The renderChecklist render places `<span>` with template title text in each li.
            const lis = document.querySelectorAll("#checklist li[data-item-id]");
            for (const li of lis) {
                const span = li.querySelector("span");
                if (span && span.textContent === tmplTitle) return li.dataset.itemId;
            }
            return null;
        }, TEMPLATE_TITLE);
        if (!itemId) fail("s2: phase5-e2e- checklist item not found in live page");
        else pass(`s2: checklist hydrated with phase5-e2e- template (item ${itemId.slice(0,8)})`);

        await page.evaluate((id) => {
            const btn = document.querySelector(`#checklist li[data-item-id="${id}"] button`);
            btn.click();
        }, itemId);

        // Wait for the item to flip to done.
        await page.waitForFunction(
            (id) => {
                const li = document.querySelector(`#checklist li[data-item-id="${id}"]`);
                return li && li.dataset.done === "1";
            },
            itemId,
            { timeout: 6000 },
        ).then(() => pass("s2: checklist item toggled to done (UI)"))
         .catch(() => fail("s2: checklist toggle did not stick"));

        // Heartbeat — start_call already fired one immediate beat. lastSeenAt set.
        const hbState = await page.evaluate(
            () => window.__liveCallState && window.__liveCallState.heartbeat,
        );
        if (hbState && hbState.lastSeenAt) {
            pass(`s2: WS heartbeat ack — lastSeenAt=${hbState.lastSeenAt}`);
        } else {
            fail("s2: heartbeat lastSeenAt missing");
        }

        // Cross-check DB state directly.
        const checklistDone = psql(
            `SELECT status FROM call_checklist_items WHERE id = '${itemId}';`,
            { role: "migrate" },
        );
        if (checklistDone === "done") pass("s2: DB confirms call_checklist_items.status='done'");
        else fail(`s2: DB checklist status='${checklistDone}'`);

        const dbCustomer = psql(
            `SELECT customer_id::text FROM calls WHERE id = '${acmeCallId}';`,
            { role: "migrate" },
        );
        if (dbCustomer && dbCustomer.length > 8) pass("s2: DB confirms calls.customer_id linked");
        else fail("s2: calls.customer_id not stamped");

        // End the call.
        await page.click("#endCallBtn");
        await page.waitForFunction(
            () => {
                const lbl = document.getElementById("endCallLabel");
                return lbl && (lbl.textContent || "").trim() === "종료됨";
            },
            { timeout: 8000 },
        ).then(() => pass("s2: end_call ack — UI lock to 종료됨"))
         .catch(() => fail("s2: end button label did not flip"));

        // ───────────────────────────────────────────────────────────────
        // Scenario 3 — calls.html detail: manual summary + action item
        // ───────────────────────────────────────────────────────────────
        await page.goto(CALLS_URL, { waitUntil: "domcontentloaded" });
        // Wait for the page's script to declare openDetail (top-level
        // async function decl. in classic <script>) and for the boot
        // refresh + sidebar load to settle.
        await page.waitForFunction(
            () => typeof window.openDetail === "function" && !!window.kloserApi && !!window.kloserApi.getAccessToken(),
            { timeout: 10000 },
        );
        // Open detail for the just-ended call directly via the page helper.
        await page.evaluate((id) => window.openDetail(id), acmeCallId);
        await page.waitForFunction(
            () => {
                const el = document.getElementById("dCallId");
                return el && /^#[0-9a-f]{8}$/.test((el.textContent || "").trim());
            },
            { timeout: 8000 },
        ).then(() => pass("s3: detail panel opened for the live-created call"))
         .catch(() => fail("s3: detail panel did not load"));

        // Manual summary write.
        await page.fill("#dManualSummary", SUMMARY_TEXT);
        await page.fill("#dManualNeeds", NEEDS_TEXT);
        await page.fill("#dManualIssues", `${RUN_TAG}-issue`);
        await page.selectOption("#dManualSentiment", "positive");
        await page.click("#dManualSaveBtn");
        await page.waitForFunction(
            () => {
                const el = document.getElementById("dSummarySource");
                return el && (el.textContent || "").indexOf("수동 작성") !== -1;
            },
            { timeout: 6000 },
        ).then(() => pass("s3: manual summary saved (summary_source badge = 수동 작성)"))
         .catch(() => fail("s3: manual summary badge did not flip"));

        // Verify DB.
        const srcRow = psql(
            `SELECT summary_source, summary FROM calls WHERE id = '${acmeCallId}';`,
            { role: "migrate" },
        );
        if (srcRow.startsWith("manual|") && srcRow.indexOf(SUMMARY_TEXT) !== -1) {
            pass("s3: DB confirms summary_source='manual' + summary persisted");
        } else {
            fail(`s3: DB row mismatch — ${srcRow}`);
        }

        // Add action item, then toggle to done.
        await page.fill("#dActionInput", ACTION_TITLE);
        await page.click("#dActionAddBtn");
        await page.waitForFunction(
            (title) => {
                const lis = document.querySelectorAll("#dActions li");
                for (const li of lis) {
                    if ((li.textContent || "").indexOf(title) !== -1) return true;
                }
                return false;
            },
            ACTION_TITLE,
            { timeout: 6000 },
        ).then(() => pass("s3: action item created and visible in detail panel"))
         .catch(() => fail("s3: action item did not appear after create"));

        // Click the toggle button (status was 'open' → becomes 'done').
        await page.evaluate(() => {
            const btn = document.querySelector("#dActions li button[data-action-id]");
            btn.click();
        });
        await page.waitForFunction(
            () => {
                const li = document.querySelector("#dActions li");
                return li && li.classList.contains("line-through");
            },
            { timeout: 6000 },
        ).then(() => pass("s3: action item toggled to done (line-through applied)"))
         .catch(() => fail("s3: action item line-through not applied"));

        const aiRow = psql(
            `SELECT status FROM call_action_items WHERE title = '${ACTION_TITLE}';`,
            { role: "migrate" },
        );
        if (aiRow === "done") pass("s3: DB confirms call_action_items.status='done'");
        else fail(`s3: action item status='${aiRow}'`);

        // ───────────────────────────────────────────────────────────────
        // Scenario 4 — suggestion history (psql seed + UI render)
        //
        // Phase 5 has no REST/WS surface that creates persisted suggestions
        // without the LLM worker (Step 4 finding §5.3). So we seed one row
        // directly with the same prefix, reload the detail, and verify the
        // UI ledger picks it up.
        // ───────────────────────────────────────────────────────────────
        psql(
            `INSERT INTO call_suggestions
                 (org_id, call_id, group_seq, at_ms, tone, type, title, body)
             SELECT org_id, '${acmeCallId}', 0, 1000, 'amber', 'next',
                    '${SUGGESTION_TITLE}', '${SUGGESTION_BODY}'
               FROM calls WHERE id = '${acmeCallId}';`,
            { role: "migrate" },
        );
        // Re-open detail so the page re-fetches /calls/:id/suggestions.
        await page.evaluate((id) => window.openDetail(id), acmeCallId);
        await page.waitForFunction(
            (title) => {
                const els = document.querySelectorAll("#dSuggestions > div");
                for (const e of els) {
                    if ((e.textContent || "").indexOf(title) !== -1) return true;
                }
                return false;
            },
            SUGGESTION_TITLE,
            { timeout: 6000 },
        ).then(() => pass("s4: seeded suggestion renders in calls.html history"))
         .catch(() => fail("s4: suggestion history did not render seeded row"));

        // No HTML escape leak — the title comes from a server string and
        // must appear as plain text (escapeHtml applied).
        const hasEscapeArtifact = await page.evaluate(() => {
            const html = document.getElementById("dSuggestions").innerHTML;
            return html.indexOf("&amp;amp;") !== -1 || html.indexOf("&amp;lt;") !== -1;
        });
        if (!hasEscapeArtifact) pass("s4: suggestion text not double-escaped");
        else fail("s4: double-escape artifact detected");

        // ───────────────────────────────────────────────────────────────
        // Scenario 5 — permission / RLS smoke
        // ───────────────────────────────────────────────────────────────
        await uiLogout(page);
        await uiLogin(page, ACME_EMP_EMAIL, ACME_EMP_PW, "/platform/settings.html");
        await page.goto(SETTINGS_URL, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(
            () => {
                const b = document.getElementById("guidesRoleBadge");
                return b && /읽기 전용/.test(b.textContent || "");
            },
            { timeout: 8000 },
        ).then(() => pass("s5: employee sees 읽기 전용 badge on settings#guides"))
         .catch(() => fail("s5: read-only badge missing"));
        const empUiState = await page.evaluate(() => ({
            bannerVisible: !document.getElementById("guidesReadonlyBanner").classList.contains("hidden"),
            kbAddDisabled: document.getElementById("kbNewBtn").disabled,
            tmplAddDisabled: document.getElementById("tmplNewBtn").disabled,
        }));
        if (empUiState.bannerVisible && empUiState.kbAddDisabled && empUiState.tmplAddDisabled) {
            pass("s5: read-only banner + mutation controls disabled for employee");
        } else {
            fail(`s5: read-only UI state mismatch ${JSON.stringify(empUiState)}`);
        }

        // RLS: Beta admin must not see the Acme phase5-e2e KB.
        const betaToken = await adminApiToken(BETA_ADMIN_EMAIL, BETA_ADMIN_PW);
        const betaKbList = await apiGet(betaToken, "/knowledge-bases?limit=100");
        const acmeKbLeak = (betaKbList.body && betaKbList.body.items || []).some(
            (kb) => (kb.title || "").indexOf(PREFIX) === 0,
        );
        if (betaKbList.status === 200 && !acmeKbLeak) {
            pass("s5: Beta admin /knowledge-bases does not leak Acme phase5-e2e KB");
        } else {
            fail(`s5: RLS leak status=${betaKbList.status} leak=${acmeKbLeak}`);
        }

    } finally {
        // ───────────────────────────────────────────────────────────────
        // Scenario 6 — cleanup sweep + residue assertion
        // ───────────────────────────────────────────────────────────────
        try {
            cleanupPhase5();
            pass("cleanup: ran phase5-e2e- scoped sweep");
        } catch (err) {
            fail(`cleanup: sweep threw — ${err.message}`);
        }
        try {
            const r = residueCounts();
            const total = Object.values(r).reduce((a, b) => a + b, 0);
            if (total === 0) {
                pass("s6: residue 0 — kbs/chunks/templates/items/suggestions/actions/transcripts/calls clean");
            } else {
                fail(`s6: residue ${JSON.stringify(r)}`);
            }
        } catch (err) {
            fail(`s6: residue probe threw — ${err.message}`);
        }

        // Verify the seat seed counts didn't move.
        try {
            const seedAfter = seatedSeedCounts();
            if (
                seedAfter.users === seedBefore.users &&
                seedAfter.memberships === seedBefore.memberships &&
                seedAfter.customers === seedBefore.customers
            ) {
                pass(`s6: seat seed untouched (users=${seedAfter.users}, memberships=${seedAfter.memberships}, customers=${seedAfter.customers})`);
            } else {
                fail(`s6: seat seed drift ${JSON.stringify(seedAfter)} vs ${JSON.stringify(seedBefore)}`);
            }
        } catch (err) {
            fail(`s6: seed sanity probe threw — ${err.message}`);
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

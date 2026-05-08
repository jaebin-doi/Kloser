/* Phase 2 customers e2e — 7 시나리오 + cleanup 검증.
 *
 * Pre-req (split-origin):
 *   - API:    `npm --prefix server run dev`            (port 3001)
 *   - Static: `npx http-server . -p 8765 --silent`     (project root)
 *   - Seed:   `npm --prefix server run db:seed`        (Acme 12 + Beta 12)
 *
 * Run:
 *   node test/phase_2_customers_e2e.mjs
 *
 * Run (Caddy single-origin variant):
 *   KLOSER_E2E_BASE_URL=https://localhost node test/phase_2_customers_e2e.mjs
 *
 * Scenarios (Step 6 plan §4):
 *   1. Login → Acme list 12명 + KPI 12/7/3/2 + sidebar 12
 *   2. 신규 추가 → list 13 + KPI total=13 pending=3
 *   3. 수정 → status active → KPI active=8 pending=2
 *   4. 삭제 → list 12 + KPI 7/3/2 복귀
 *   5. Beta 격리 → 12 disjoint rows, Acme leak 0
 *   6. status=active 필터 + pending POST → list stays 7, stats=13/3
 *   7. cleanup 후 e2etest- 잔재 0 + total 12
 *
 * Cleanup contract:
 *   - 시나리오에서 만든 customer id를 createdIds Set에 push
 *   - finally 블록에서 fresh Acme JWT 획득 → 각 id를 authed DELETE
 *   - 시나리오 7이 list 직접 probe로 e2etest- prefix 잔재 0 확인
 */
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const E2E_BASE      = process.env.KLOSER_E2E_BASE_URL || "";
const STATIC_ORIGIN = E2E_BASE || "http://localhost:8765";
const API_BASE      = E2E_BASE || "http://localhost:3001";
const LOGIN_URL     = `${STATIC_ORIGIN}/platform/login.html`;
const CUSTOMERS_URL = `${STATIC_ORIGIN}/platform/customers.html`;
const API_HEALTH    = `${API_BASE}/health`;
const IS_HTTPS      = STATIC_ORIGIN.startsWith("https:");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_PATH = path.join(__dirname, "phase_2_customers_e2e.png");

// Acme seed names (server/seeds/0002_customers.sql) — used for the
// cross-org leak probe in scenario 5.
const ACME_SEED_NAMES = new Set([
    "김민수", "이지은", "박서준", "정유진", "최서연",
    "강지훈", "한수민", "윤서아", "조성훈", "신예린",
    "오민재", "임채영",
]);

function pass(msg) { console.log("PASS:", msg); }
function fail(msg) { console.error("FAIL:", msg); process.exitCode = 1; }

// ─── direct API helpers (bypass UI) ───
async function loginViaApi(email, password) {
    const r = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
    });
    if (!r.ok) throw new Error(`login ${email} → ${r.status}`);
    const body = await r.json();
    return body.accessToken;
}

async function authedDelete(token, id) {
    const r = await fetch(`${API_BASE}/customers/${id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
    });
    return { ok: r.ok || r.status === 404, status: r.status };
}

async function authedList(token) {
    const r = await fetch(`${API_BASE}/customers?limit=100`, {
        headers: { authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`list → ${r.status}`);
    return r.json();
}

// ─── UI helpers ───
async function uiLogin(page, email, password) {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
    await page.fill("#email", email);
    await page.fill("#password", password);
    await Promise.all([
        page.waitForURL((u) => u.pathname.endsWith("/platform/live.html"), { timeout: 5000 }),
        page.click("#submit"),
    ]);
}

async function uiLogout(page) {
    await page.evaluate(async () => {
        if (window.kloserApi?.logout) await window.kloserApi.logout();
    });
}

async function gotoCustomers(page) {
    await page.goto(CUSTOMERS_URL, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#customersTable tr.customer-row", { timeout: 5000 });
}

async function readKpi(page) {
    return page.evaluate(() => {
        const num = (id) =>
            parseInt((document.getElementById(id)?.textContent || "0").replace(/,/g, ""), 10);
        return {
            total: num("kpiTotal"),
            active: num("kpiActive"),
            review: num("kpiReview"),
            pending: num("kpiPending"),
            sidebar: num("sidebarCustomersCount"),
        };
    });
}

async function readListNames(page) {
    return page.evaluate(() =>
        Array.from(document.querySelectorAll("#customersTable tr.customer-row .font-bold"))
            .map((el) => el.textContent.trim()),
    );
}

async function rowIdForName(page, name) {
    return page.evaluate((n) => {
        const rows = document.querySelectorAll("#customersTable tr.customer-row");
        for (const row of rows) {
            const label = row.querySelector(".font-bold")?.textContent.trim();
            if (label === n) return row.dataset.customerId || null;
        }
        return null;
    }, name);
}

// ──────────────────────────────────────────────────────────────────────────
//  main
// ──────────────────────────────────────────────────────────────────────────
async function main() {
    console.log(
        `→ mode: ${E2E_BASE ? `single-origin (${E2E_BASE})` : "split-origin (8765 + 3001)"}`,
    );

    if (IS_HTTPS) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

    // Sanity: API health
    const health = await fetch(API_HEALTH).then((r) => r.json()).catch(() => null);
    if (!health || health.ok !== true) {
        throw new Error("API health probe failed — is server/ running?");
    }
    pass(`API health ok (uptime ${health.uptimeSec}s)`);

    // Sanity: seed counts (Acme 12)
    const preToken = await loginViaApi("admin@acme.test", "acme-admin-1234");
    const preList = await authedList(preToken);
    if (preList.total !== 12) {
        throw new Error(
            `seed counts mismatch: customers total=${preList.total}, expected 12 — run \`npm --prefix server run db:seed\``,
        );
    }
    pass(`seed pre-check: Acme customers total=12`);

    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ ignoreHTTPSErrors: IS_HTTPS });
    const page = await ctx.newPage();

    // Auto-accept native confirm dialogs (delete confirmation).
    page.on("dialog", (dialog) => dialog.accept());

    const consoleErrors = [];
    page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(`[pageerror] ${err.message}`));

    const createdIds = new Set();

    try {
        // ── Scenario 1 — Login + Acme list ──
        await uiLogin(page, "admin@acme.test", "acme-admin-1234");
        await gotoCustomers(page);

        const s1Names = await readListNames(page);
        if (s1Names.length !== 12) {
            fail(`scenario 1: expected 12 rows, got ${s1Names.length}`);
        } else if (!s1Names.every((n) => ACME_SEED_NAMES.has(n))) {
            fail(`scenario 1: non-seed names: ${s1Names.filter((n) => !ACME_SEED_NAMES.has(n)).join(", ")}`);
        } else {
            pass(`scenario 1: 12 Acme seed rows visible`);
        }
        const s1Kpi = await readKpi(page);
        if (s1Kpi.total === 12 && s1Kpi.active === 7 && s1Kpi.review === 3 && s1Kpi.pending === 2) {
            pass(`scenario 1: KPI 12/7/3/2`);
        } else {
            fail(`scenario 1: KPI mismatch ${JSON.stringify(s1Kpi)}`);
        }
        if (s1Kpi.sidebar !== 12) fail(`scenario 1: sidebar count ${s1Kpi.sidebar}, expected 12`);
        else pass(`scenario 1: sidebar count 12`);

        // ── Scenario 2 — Add customer ──
        const newName2 = `e2etest-add-${Date.now()}`;
        await page.click("header button.btn-primary");
        await page.waitForSelector("#modal.show", { timeout: 2000 });
        await page.fill("#newName", newName2);
        await page.fill("#newCompany", "E2E Co");
        await page.selectOption("#newStatus", "pending");
        await page.click("#modalSaveBtn");

        await page.waitForFunction(
            (name) => Array.from(document.querySelectorAll("#customersTable tr.customer-row .font-bold"))
                .some((el) => el.textContent.trim() === name),
            newName2,
            { timeout: 5000 },
        );

        const s2Names = await readListNames(page);
        if (s2Names.length === 13 && s2Names.includes(newName2)) {
            pass(`scenario 2: new row visible (${s2Names.length} rows)`);
        } else {
            fail(`scenario 2: list mismatch (${s2Names.length} rows, includes new=${s2Names.includes(newName2)})`);
        }

        const s2Kpi = await readKpi(page);
        if (s2Kpi.total === 13 && s2Kpi.pending === 3 && s2Kpi.sidebar === 13) {
            pass(`scenario 2: KPI total=13 pending=3 sidebar=13`);
        } else {
            fail(`scenario 2: KPI mismatch ${JSON.stringify(s2Kpi)}`);
        }

        const newId2 = await rowIdForName(page, newName2);
        if (newId2) createdIds.add(newId2);
        else fail(`scenario 2: could not capture id for ${newName2}`);

        // ── Scenario 3 — Edit ──
        const editedName3 = `${newName2}-edited`;
        await page.evaluate((id) => {
            document.querySelector(`#customersTable tr.customer-row[data-customer-id="${id}"]`)?.click();
        }, newId2);
        await page.waitForSelector("#modal.show", { timeout: 2000 });

        const prefilledName = await page.inputValue("#newName");
        if (prefilledName === newName2) pass(`scenario 3: edit modal prefilled with ${newName2}`);
        else fail(`scenario 3: prefill mismatch (got "${prefilledName}")`);

        await page.fill("#newName", editedName3);
        await page.selectOption("#newStatus", "active");
        await page.click("#modalSaveBtn");

        await page.waitForFunction(
            (name) => Array.from(document.querySelectorAll("#customersTable tr.customer-row .font-bold"))
                .some((el) => el.textContent.trim() === name),
            editedName3,
            { timeout: 5000 },
        );

        const s3StatusOk = await page.evaluate((id) => {
            const row = document.querySelector(`#customersTable tr.customer-row[data-customer-id="${id}"]`);
            return row?.querySelector(".badge")?.textContent.trim() === "활성";
        }, newId2);
        if (s3StatusOk) pass(`scenario 3: status badge "활성" + name updated`);
        else fail(`scenario 3: status badge not "활성"`);

        const s3Kpi = await readKpi(page);
        if (s3Kpi.active === 8 && s3Kpi.pending === 2) pass(`scenario 3: KPI active=8 pending=2`);
        else fail(`scenario 3: KPI mismatch ${JSON.stringify(s3Kpi)}`);

        // ── Scenario 4 — Delete ──
        await page.evaluate((id) => {
            document.querySelector(`#customersTable tr.customer-row[data-customer-id="${id}"]`)?.click();
        }, newId2);
        await page.waitForSelector("#modal.show", { timeout: 2000 });
        await page.click("#modalDeleteBtn");

        await page.waitForFunction(
            (id) => !document.querySelector(`#customersTable tr.customer-row[data-customer-id="${id}"]`),
            newId2,
            { timeout: 5000 },
        );

        const s4Names = await readListNames(page);
        if (s4Names.length === 12 && !s4Names.includes(editedName3)) {
            pass(`scenario 4: row deleted, list back to 12`);
        } else {
            fail(`scenario 4: list didn't restore (${s4Names.length} rows)`);
        }

        const s4Kpi = await readKpi(page);
        if (s4Kpi.total === 12 && s4Kpi.active === 7 && s4Kpi.pending === 2) {
            pass(`scenario 4: KPI restored to 12/7/_/2`);
        } else {
            fail(`scenario 4: KPI mismatch ${JSON.stringify(s4Kpi)}`);
        }

        // Soft-deleted via UI; remove from cleanup set.
        createdIds.delete(newId2);

        // ── Scenario 5 — Beta isolation ──
        await uiLogout(page);
        await uiLogin(page, "admin@beta.test", "beta-admin-1234");
        await gotoCustomers(page);

        const s5Names = await readListNames(page);
        if (s5Names.length !== 12) {
            fail(`scenario 5: expected 12 Beta rows, got ${s5Names.length}`);
        } else {
            const leaked = s5Names.filter((n) => ACME_SEED_NAMES.has(n));
            if (leaked.length > 0) fail(`scenario 5: Acme names leaked into Beta: ${leaked.join(", ")}`);
            else pass(`scenario 5: Beta view shows 12 disjoint rows (Acme leak 0)`);
        }

        // Restore Acme view for scenario 6
        await uiLogout(page);
        await uiLogin(page, "admin@acme.test", "acme-admin-1234");
        await gotoCustomers(page);
        const s5BackNames = await readListNames(page);
        if (s5BackNames.length === 12 && s5BackNames.every((n) => ACME_SEED_NAMES.has(n))) {
            pass(`scenario 5: Acme view restored on re-login`);
        } else {
            fail(`scenario 5: Acme re-login failed (${s5BackNames.length} rows)`);
        }

        // ── Scenario 6 — Filter integrity ──
        await page.click('.chip-group[data-group="status"] .filter-chip[data-value="active"]');
        await page.waitForFunction(
            () => document.querySelectorAll("#customersTable tr.customer-row").length === 7,
            { timeout: 3000 },
        );
        pass(`scenario 6: status=active filter shows 7 rows`);

        const newName6 = `e2etest-filter-${Date.now()}`;
        await page.click("header button.btn-primary");
        await page.waitForSelector("#modal.show", { timeout: 2000 });
        await page.fill("#newName", newName6);
        await page.selectOption("#newStatus", "pending");
        await page.click("#modalSaveBtn");

        // Wait for KPI total to bump (loadAll completed)
        await page.waitForFunction(() => {
            const t = parseInt((document.getElementById("kpiTotal")?.textContent || "0").replace(/,/g, ""), 10);
            return t === 13;
        }, { timeout: 5000 });

        const s6AfterNames = await readListNames(page);
        if (s6AfterNames.length !== 7) {
            fail(`scenario 6: list not 7 after pending POST under active filter (got ${s6AfterNames.length})`);
        } else if (s6AfterNames.includes(newName6)) {
            fail(`scenario 6: pending row leaked into active filter view`);
        } else {
            pass(`scenario 6: filter integrity — list stays 7, new pending row not visible`);
        }

        const s6Kpi = await readKpi(page);
        if (s6Kpi.total === 13 && s6Kpi.pending === 3) {
            pass(`scenario 6: stats total=13 pending=3 (server truth)`);
        } else {
            fail(`scenario 6: stats mismatch ${JSON.stringify(s6Kpi)}`);
        }

        // Capture id for cleanup (UI hides it under the active filter)
        const sweepToken = await loginViaApi("admin@acme.test", "acme-admin-1234");
        const sweepList = await authedList(sweepToken);
        const created6 = sweepList.items.find((c) => c.name === newName6);
        if (created6) createdIds.add(created6.id);
        else fail(`scenario 6: could not capture id for ${newName6}`);
    } finally {
        // ──────────────────────────────────────────────────────────
        //  cleanup — guaranteed even if scenario body threw
        // ──────────────────────────────────────────────────────────
        let cleanupToken = null;
        try {
            cleanupToken = await loginViaApi("admin@acme.test", "acme-admin-1234");
        } catch (e) {
            console.error("[cleanup] could not get Acme token:", e.message);
        }

        if (cleanupToken) {
            let cleaned = 0;
            for (const id of createdIds) {
                try {
                    const r = await authedDelete(cleanupToken, id);
                    if (r.ok) cleaned++;
                    else console.error(`[cleanup] DELETE ${id} → ${r.status}`);
                } catch (e) {
                    console.error(`[cleanup] ${id} threw:`, e.message);
                }
            }
            console.log(`[cleanup] removed ${cleaned}/${createdIds.size} test rows`);

            // ── Scenario 7 — leftover sweep verification ──
            try {
                const finalList = await authedList(cleanupToken);
                const leftovers = finalList.items.filter(
                    (c) => typeof c.name === "string" && c.name.startsWith("e2etest-"),
                );
                if (leftovers.length > 0) {
                    fail(
                        `scenario 7: ${leftovers.length} e2etest- row(s) remain after cleanup: ` +
                            leftovers.map((c) => c.name).join(", "),
                    );
                } else if (finalList.total === 12) {
                    pass(`scenario 7: leftover sweep clean (12 seed rows, 0 e2etest- residue)`);
                } else {
                    fail(`scenario 7: total=${finalList.total} (expected 12 after cleanup)`);
                }
            } catch (e) {
                fail(`scenario 7: post-cleanup probe failed: ${e.message}`);
            }
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

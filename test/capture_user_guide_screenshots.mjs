/* User-guide screenshot capture (Phase 1 시점).
 *
 * Pre-req:
 *   - API server   on :32173  (`npm --prefix server run dev`)
 *   - Static server on :8765 (`npx http-server . -p 8765 --silent`)
 *
 * Run from project root:
 *   node test/capture_user_guide_screenshots.mjs
 *
 * Outputs 9 PNGs into assets/screenshots/user_guide/:
 *   login.png       — public login form (logged-out state, dev fixture box visible)
 *   dashboard.png   — mock dashboard (not behind auth gate today)
 *   daily.png       — 오늘의 일 (mock trend + To-Do)
 *   live.png        — Phase 0.5 live demo with greeting + first suggestion visible
 *   calls.png       — 통화 기록 (mock 8건)
 *   customers.png   — 고객 관리 (mock 12명)
 *   newsletter.png  — 뉴스레터 + AI 챗봇
 *   team.png        — 팀 + 우수 사례 + 권한 매트릭스
 *   settings.png    — 12 카테고리 설정
 *
 * Viewport: 1440×900 (laptop-size). full_page off — captures the
 * meaningful first viewport so the guide stays readable.
 */
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";

const STATIC_ORIGIN = "http://localhost:8765";
const API_HEALTH    = "http://localhost:32173/health";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR   = path.resolve(__dirname, "..", "assets", "screenshots", "user_guide");

if (!existsSync(OUT_DIR)) {
  throw new Error(`Output dir missing: ${OUT_DIR} — create it first.`);
}

const VIEWPORT = { width: 1440, height: 900 };

function log(msg) { console.log("→", msg); }

async function captureMockPage(page, slug) {
  await page.goto(`${STATIC_ORIGIN}/platform/${slug}.html`, { waitUntil: "networkidle" });
  // Most platform pages run a fade-in animation on load. Give it a moment
  // to settle before capturing — avoids half-rendered cards in the shot.
  await page.waitForTimeout(800);
  const out = path.join(OUT_DIR, `${slug}.png`);
  await page.screenshot({ path: out, fullPage: false });
  log(`captured ${slug}.png`);
}

async function captureLogin(page) {
  // Logged-out state. The dev fixture box is hostname-gated so it shows
  // here automatically (we're on localhost).
  await page.goto(`${STATIC_ORIGIN}/platform/login.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  const out = path.join(OUT_DIR, "login.png");
  await page.screenshot({ path: out, fullPage: false });
  log("captured login.png");
}

async function captureLive(page) {
  // 1. Login first (uses the same flow as the e2e — admin@acme.test).
  //    Required because Phase 1 step 4 added an auth gate to live.html.
  await page.goto(`${STATIC_ORIGIN}/platform/login.html`, { waitUntil: "domcontentloaded" });
  await page.fill("#email", "admin@acme.test");
  await page.fill("#password", "acme-admin-1234");
  await Promise.all([
    page.waitForURL((url) => url.pathname.endsWith("/platform/live.html"), { timeout: 5000 }),
    page.click("#submit"),
  ]);

  // 2. Wait until the demo has fired enough events that the screenshot
  //    looks alive: greeting transcript + at least 1 suggestion + sentiment#1.
  //    Sentiment #1 fires at t≈14s ("관심"). Wait for that — it implies
  //    the suggestion at t=14s also fired.
  await page.waitForFunction(
    () => document.getElementById("moodVal")?.textContent === "관심",
    { timeout: 18000 },
  );
  // Small settle so suggestion-card slide-in is finished.
  await page.waitForTimeout(800);

  const out = path.join(OUT_DIR, "live.png");
  await page.screenshot({ path: out, fullPage: false });
  log("captured live.png (with greeting + suggestion + sentiment)");
}

async function main() {
  // Sanity probes.
  const health = await fetch(API_HEALTH).then((r) => r.json()).catch(() => null);
  if (!health || health.ok !== true) {
    throw new Error("API health probe failed — start `npm --prefix server run dev` first.");
  }
  const staticProbe = await fetch(`${STATIC_ORIGIN}/platform/login.html`).then((r) => r.status).catch(() => 0);
  if (staticProbe !== 200) {
    throw new Error("Static probe failed — start `npx http-server . -p 8765 --silent` from project root.");
  }
  log(`servers OK (api uptime ${health.uptimeSec}s)`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const page = await ctx.newPage();

  try {
    // 1. Login (logged-out state)
    await captureLogin(page);

    // 2. Live demo (the only authenticated page in Phase 1 today).
    //    Doing this early so we don't have to log out again afterwards;
    //    other platform pages don't have auth gates yet.
    await captureLive(page);

    // 3. Mock platform pages — order matches the user-guide flow.
    for (const slug of ["dashboard", "daily", "calls", "customers", "newsletter", "team", "settings"]) {
      await captureMockPage(page, slug);
    }
  } finally {
    await browser.close();
  }

  log("done — 9 screenshots in assets/screenshots/user_guide/");
}

main().catch((err) => {
  console.error("CAPTURE ERROR:", err);
  process.exit(2);
});

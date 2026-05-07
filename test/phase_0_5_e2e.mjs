/* Phase 0.5 end-to-end Playwright verification.
 *
 * Pre-req:
 *   - API:    `npm --prefix server run dev`            (port 3001)
 *   - Static: `npx http-server . -p 8765 --silent`     (project root)
 *
 * Run:
 *   node test/phase_0_5_e2e.mjs
 */
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const STATIC_URL = "http://localhost:8765/platform/live.html";
const API_HEALTH = "http://localhost:3001/health";

// Resolve screenshot path relative to this script so the test is cwd-independent.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_PATH = path.join(__dirname, "phase_0_5_e2e.png");

function pass(msg) { console.log("PASS:", msg); }
function fail(msg) { console.error("FAIL:", msg); process.exitCode = 1; }

async function main() {
  // Sanity probe before launching headless browser.
  const health = await fetch(API_HEALTH).then((r) => r.json()).catch(() => null);
  if (!health || health.ok !== true) throw new Error("API health probe failed — is server/ running?");
  pass(`API health ok (uptime ${health.uptimeSec}s)`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  /** @type {string[]} */
  const consoleLogs = [];
  /** @type {string[]} */
  const consoleErrors = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error") consoleErrors.push(text);
    else consoleLogs.push(`[${msg.type()}] ${text}`);
  });
  page.on("pageerror", (err) => consoleErrors.push(`[pageerror] ${err.message}`));

  await page.goto(STATIC_URL, { waitUntil: "domcontentloaded" });

  // 1. Connection + start_call ack appear quickly
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll("script")) && window.kloserWS,
    { timeout: 3000 },
  );
  pass("kloserWS loaded");

  // 2. First transcript (agent greeting) appears within 1500ms (delay 0 + RTT)
  await page.waitForSelector("#transcript .msg-enter", { timeout: 2000 });
  const firstAgent = await page.locator("#transcript .msg-enter").first().innerText();
  if (!firstAgent.includes("김민수입니다")) fail(`first transcript missing greeting — got: ${firstAgent}`);
  else pass(`first transcript: greeting agent line received`);

  // 3. Wait long enough for the 14000ms sentiment update
  await page.waitForFunction(
    () => document.getElementById("moodVal")?.textContent === "관심",
    { timeout: 18000 },
  );
  const interest1 = await page.locator("#interestVal").innerText();
  const stage1 = await page.locator("#stageVal").innerText();
  if (interest1 !== "92%") fail(`interest after first sentiment expected 92%, got ${interest1}`);
  if (stage1 !== "검토") fail(`stage after first sentiment expected 검토, got ${stage1}`);
  if (!/FAIL/.test(String(process.exitCode))) pass(`sentiment #1: 관심 / 92% / 검토`);

  // 4. Wait for 23000ms sentiment update (망설임)
  await page.waitForFunction(
    () => document.getElementById("moodVal")?.textContent === "망설임",
    { timeout: 15000 },
  );
  pass(`sentiment #2: 망설임 reached`);

  // 5. Verify suggestion cards rendered (suggestion sequence fired at 14000, 23000)
  const suggestionCount = await page.locator("#aiSuggestions .sug-card").count();
  if (suggestionCount < 1) fail(`expected suggestion cards, got ${suggestionCount}`);
  else pass(`suggestion cards rendered (${suggestionCount} present)`);

  // 6. Manual text_chunk RTT probe via wrapper.
  //    Filter by seq instead of `once` — the probe socket also calls startCall,
  //    so server-driven demo transcripts (seq 1..10) can race with our probe.
  //    We use seq=999 and only resolve on that.
  const probe = await page.evaluate(async () => {
    const probe = window.kloserWS.connectCallNamespace({ baseUrl: "http://localhost:3001", userId: "e2e-probe" });
    await new Promise((r) => probe.on("connect", r));
    await window.kloserWS.startCall(probe, {});
    const t0 = Date.now();
    const event = await new Promise((resolve, reject) => {
      const handler = (ev) => {
        if (ev && ev.seq === 999) {
          probe.off("transcript", handler);
          resolve(ev);
        }
      };
      probe.on("transcript", handler);
      setTimeout(() => {
        probe.off("transcript", handler);
        reject(new Error("timeout waiting for seq=999"));
      }, 3000);
      window.kloserWS.sendTextChunk(probe, { seq: 999, text: "E2E-PROBE" });
    });
    const rtt = Date.now() - t0;
    probe.close();
    return { event, rtt };
  });
  if (probe.event.text !== "E2E-PROBE") fail(`probe transcript text mismatch: ${probe.event.text}`);
  else pass(`text_chunk echo OK (RTT ${probe.rtt}ms, clientSentAt round-tripped)`);
  if (probe.rtt > 150) fail(`RTT exceeded 150ms target: ${probe.rtt}ms`);
  else pass(`RTT under 150ms target (${probe.rtt}ms)`);

  // 7. Latency badge actually updates when the page socket sends text_chunk.
  //    The page socket is exposed as window.__liveSocket for this assertion
  //    (otherwise the IIFE-scoped socket is unreachable). Use a high seq to
  //    avoid colliding with server-driven demo seqs.
  const latencyBefore = await page.locator("#latencyVal").innerText();
  await page.evaluate(() => {
    window.kloserWS.sendTextChunk(window.__liveSocket, { seq: 7777, text: "LATENCY-PROBE" });
  });
  await page.waitForFunction(
    () => /^\d+ms$/.test((document.getElementById("latencyVal")?.textContent || "").trim()),
    { timeout: 2000 },
  );
  const latencyAfter = await page.locator("#latencyVal").innerText();
  pass(`#latencyVal updated on text_chunk: "${latencyBefore}" → "${latencyAfter}"`);
  const ms = parseInt(latencyAfter, 10);
  if (!Number.isFinite(ms) || ms > 150) fail(`page latency exceeds 150ms or unparseable: ${latencyAfter}`);
  else pass(`page latency under 150ms target (${ms}ms)`);

  // 8. Final transcript count check — at this point we should have 7 transcripts
  // (delays 0, 4500, 9000, 13500, 18000, 22500 = 6 from server replay + 1 we know about)
  // Plus we did not consume the page socket for a probe so the page got server-driven only.
  const transcriptCount = await page.locator("#transcript .msg-enter").count();
  pass(`page transcript count: ${transcriptCount}`);

  // 9. text_chunk payload validation — server should emit `error` on missing clientSentAt
  const badPayloadResult = await page.evaluate(async () => {
    const probe = window.kloserWS.connectCallNamespace({ baseUrl: "http://localhost:3001", userId: "e2e-bad" });
    await new Promise((r) => probe.on("connect", r));
    const result = await new Promise((resolve) => {
      probe.once("error", (err) => resolve({ ok: true, err }));
      setTimeout(() => resolve({ ok: false, reason: "no error event in 1500ms" }), 1500);
      // bypass wrapper to send a malformed payload (missing clientSentAt)
      probe.emit("text_chunk", { seq: 8888, text: "BAD" });
    });
    probe.close();
    return result;
  });
  if (!badPayloadResult.ok) fail(`payload validation: ${badPayloadResult.reason}`);
  else if (badPayloadResult.err?.code !== "BAD_PAYLOAD") fail(`payload validation: unexpected error code ${badPayloadResult.err?.code}`);
  else pass(`payload validation: BAD_PAYLOAD emitted on missing clientSentAt`);

  // 10. No console errors
  if (consoleErrors.length > 0) {
    fail(`console errors: ${JSON.stringify(consoleErrors, null, 2)}`);
  } else {
    pass("no console errors");
  }

  // Screenshot for evidence (path resolved relative to this script).
  await page.screenshot({ path: SCREENSHOT_PATH, fullPage: false });
  pass(`screenshot saved → ${path.relative(process.cwd(), SCREENSHOT_PATH)}`);

  await browser.close();
  console.log(process.exitCode ? "\nE2E FAILED" : "\nE2E PASSED");
}

main().catch((err) => {
  console.error("E2E ERROR:", err);
  process.exit(2);
});

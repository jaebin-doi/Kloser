/* Phase 0.5 end-to-end Playwright verification — refreshed for Phase 1 step 4
 * and parameterized for Phase 1 step 5 (Caddy single-origin variant).
 *
 * Pre-req (default split-origin):
 *   - API:    `npm --prefix server run dev`            (port 3001)
 *   - Static: `npx http-server . -p 8765 --silent`     (project root)
 *
 * Run (split-origin):
 *   node test/phase_0_5_e2e.mjs
 *
 * Run (Caddy single-origin variant — Phase 1 step 5 §1.5):
 *   # PowerShell:
 *   $env:KLOSER_E2E_BASE_URL = 'https://localhost'
 *   node test/phase_0_5_e2e.mjs
 *   Remove-Item Env:KLOSER_E2E_BASE_URL
 *
 *   # bash:
 *   KLOSER_E2E_BASE_URL=https://localhost node test/phase_0_5_e2e.mjs
 *
 *   Caddy must be running (`caddy run --config ops/Caddyfile.dev`) and
 *   proxy /auth, /me, /socket.io, /health to Fastify on :3001 and serve
 *   the project root as static. The test ignores TLS errors when the
 *   target is https:// so Caddy's internal-CA cert isn't a blocker.
 *
 * Phase 1 step 4 changes vs. the spike-era version:
 *   - Step 0 (setup, not counted): login through /platform/login.html. The
 *     old test could land on live.html directly; with the auth gate added
 *     in step 4, an unauthenticated visit bounces to login.html.
 *   - Probe sockets pass tokenProvider instead of the now-deleted userId
 *     query param. They share the page's access token via kloserApi.
 *   - End of run adds 2 auth-reject cases (15, 16) — handshake without a
 *     token and with a mangled token — using raw window.io to avoid the
 *     wrapper's auto-refresh-on-401 dance.
 *
 * Total accounted for: 14 prior cases + 2 auth reject = 16 PASS.
 */
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

// E2E_BASE collapses STATIC and API into one origin (Caddy mode).
// When unset, fall back to the split-origin defaults.
const E2E_BASE      = process.env.KLOSER_E2E_BASE_URL || "";
const STATIC_ORIGIN = E2E_BASE || "http://localhost:8765";
const API_BASE      = E2E_BASE || "http://localhost:3001";
const LOGIN_URL     = `${STATIC_ORIGIN}/platform/login.html`;
const LIVE_URL      = `${STATIC_ORIGIN}/platform/live.html`;
const API_HEALTH    = `${API_BASE}/health`;
const IS_HTTPS      = STATIC_ORIGIN.startsWith("https:");

// Resolve screenshot path relative to this script so the test is cwd-independent.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_PATH = path.join(__dirname, "phase_0_5_e2e.png");

function pass(msg) { console.log("PASS:", msg); }
function fail(msg) { console.error("FAIL:", msg); process.exitCode = 1; }

async function main() {
  console.log(`→ mode: ${E2E_BASE ? `single-origin (${E2E_BASE})` : "split-origin (8765 + 3001)"}`);

  // Sanity probe before launching headless browser.
  // For HTTPS targets the self-signed cert would otherwise fail this fetch
  // — undici (node fetch) doesn't honor browser cert stores. NODE_TLS_
  // REJECT_UNAUTHORIZED is the simplest dev-only escape hatch.
  if (IS_HTTPS) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const health = await fetch(API_HEALTH).then((r) => r.json()).catch(() => null);
  if (!health || health.ok !== true) throw new Error("API health probe failed — is server/ running?");
  pass(`API health ok (uptime ${health.uptimeSec}s)`);

  const browser = await chromium.launch({ headless: true });
  // ignoreHTTPSErrors swallows Caddy's internal-CA cert warnings in dev;
  // it's a no-op for the http:// split-origin mode.
  const ctx = await browser.newContext({ ignoreHTTPSErrors: IS_HTTPS });
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

  // ─────────────────────────────────────────────────────────────────────
  // Step 0 (setup, not a counted PASS): log in via the real login form.
  //   - login.html POSTs /auth/login → Set-Cookie (refresh, Path=/auth)
  //     and a Bearer access token in api.js memory.
  //   - login.html then window.location.replace('/platform/live.html').
  //   - On live.html, getAccessToken() is empty (new page, fresh memory),
  //     so the auth gate calls refreshAccessToken() which uses the cookie.
  //   - That repopulates the token, and ws.js opens /calls with it.
  // ─────────────────────────────────────────────────────────────────────
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.fill("#email",    "admin@acme.test");
  await page.fill("#password", "acme-admin-1234");
  await Promise.all([
    page.waitForURL((url) => url.pathname.endsWith("/platform/live.html"), { timeout: 5000 }),
    page.click("#submit"),
  ]);
  console.log("→ login OK, redirected to live.html");

  // 1. Connection + start_call ack appear quickly
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll("script")) && window.kloserWS,
    { timeout: 3000 },
  );
  pass("kloserWS loaded");

  // 2. First transcript (agent greeting) appears within ~1500ms after the
  //    auth gate completes (refresh round-trip + start_call ack + delay 0).
  //    Bumped slightly vs. the pre-auth-gate budget.
  await page.waitForSelector("#transcript .msg-enter", { timeout: 4000 });
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
  //    Phase 1 step 4: probe shares the page's access token via tokenProvider;
  //    no userId query param anymore. We filter on seq=999 because the
  //    server's demo replay also pushes transcripts on this socket once
  //    we call start_call.
  const probe = await page.evaluate(async (apiBase) => {
    const probe = window.kloserWS.connectCallNamespace({
      // Empty string in Caddy mode → kloserWS uses page origin (relative).
      baseUrl:        apiBase,
      tokenProvider:  () => window.kloserApi.getAccessToken(),
      // The default onAuthFailure redirects to /login; harmless during
      // a positive probe but explicitly no-op'd to keep the page stable
      // if anything goes sideways.
      onAuthFailure:  () => {},
    });
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
  }, API_BASE);
  if (probe.event.text !== "E2E-PROBE") fail(`probe transcript text mismatch: ${probe.event.text}`);
  else pass(`text_chunk echo OK (RTT ${probe.rtt}ms, clientSentAt round-tripped)`);
  if (probe.rtt > 150) fail(`RTT exceeded 150ms target: ${probe.rtt}ms`);
  else pass(`RTT under 150ms target (${probe.rtt}ms)`);

  // 7. Latency badge actually updates when the page socket sends text_chunk.
  //    The page socket is exposed as window.__liveSocket on localhost
  //    (otherwise the IIFE-scoped socket is unreachable). Use a high seq to
  //    avoid colliding with server-driven demo seqs.
  const latencyBefore = await page.locator("#latencyVal").innerText();
  await page.evaluate(() => {
    window.kloserWS.sendTextChunk(window.__liveSocket, { seq: 7777, text: "LATENCY-PROBE" });
  });
  await page.waitForFunction(
    () => /^\d+ms$/.test((document.getElementById("latencyVal")?.textContent || "").trim()),
    null,
    { timeout: 4000 },
  );
  const latencyAfter = await page.locator("#latencyVal").innerText();
  pass(`#latencyVal updated on text_chunk: "${latencyBefore}" → "${latencyAfter}"`);
  const ms = parseInt(latencyAfter, 10);
  if (!Number.isFinite(ms) || ms > 150) fail(`page latency exceeds 150ms or unparseable: ${latencyAfter}`);
  else pass(`page latency under 150ms target (${ms}ms)`);

  // 8. Final transcript count check — informational. By this point we've
  //    consumed several server-driven demo transcripts plus our own probes.
  const transcriptCount = await page.locator("#transcript .msg-enter").count();
  pass(`page transcript count: ${transcriptCount}`);

  // 9. text_chunk payload validation — server should emit `error` on missing clientSentAt.
  //    Phase 1 step 4: probe needs tokenProvider too.
  const badPayloadResult = await page.evaluate(async (apiBase) => {
    const probe = window.kloserWS.connectCallNamespace({
      baseUrl:        apiBase,
      tokenProvider:  () => window.kloserApi.getAccessToken(),
      onAuthFailure:  () => {},
    });
    await new Promise((r) => probe.on("connect", r));
    // start_call first — server's no_active_call check would otherwise
    // win over BAD_PAYLOAD. We're testing payload validation, not the
    // sequencing invariant.
    await window.kloserWS.startCall(probe, {});
    const result = await new Promise((resolve) => {
      probe.once("error", (err) => resolve({ ok: true, err }));
      setTimeout(() => resolve({ ok: false, reason: "no error event in 1500ms" }), 1500);
      // bypass wrapper to send a malformed payload (missing clientSentAt)
      probe.emit("text_chunk", { seq: 8888, text: "BAD" });
    });
    probe.close();
    return result;
  }, API_BASE);
  if (!badPayloadResult.ok) fail(`payload validation: ${badPayloadResult.reason}`);
  else if (badPayloadResult.err?.code !== "BAD_PAYLOAD") fail(`payload validation: unexpected error code ${badPayloadResult.err?.code}`);
  else pass(`payload validation: BAD_PAYLOAD emitted on missing clientSentAt`);

  // ─── auth-reject cases (Phase 1 step 4 §1.8 additions) ────────────────
  //
  // We use raw window.io directly (not kloserWS) because the wrapper would
  // try to refresh-and-reconnect on an auth-code error, which contaminates
  // the test. forceNew + reconnection:false ensure each socket dies cleanly
  // after one attempt.

  // 10. Handshake without a token → connect_error code 'missing_token'
  const noTokenResult = await page.evaluate(async (apiBase) => {
    const sock = window.io(apiBase + "/calls", {
      auth:         { token: "" },
      transports:   ["websocket"],
      reconnection: false,
      forceNew:     true,
    });
    return await new Promise((resolve) => {
      const t = setTimeout(() => resolve({ ok: false, reason: "timeout" }), 3000);
      sock.once("connect_error", (err) => {
        clearTimeout(t);
        sock.disconnect();
        resolve({ ok: true, code: err && err.data && err.data.code, message: err && err.message });
      });
      sock.once("connect", () => {
        clearTimeout(t);
        sock.disconnect();
        resolve({ ok: false, reason: "unexpected connect" });
      });
    });
  }, API_BASE);
  if (!noTokenResult.ok) fail(`auth reject (no token): ${noTokenResult.reason}`);
  else if (noTokenResult.code !== "missing_token") fail(`auth reject (no token): expected 'missing_token', got '${noTokenResult.code}'`);
  else pass(`auth reject: handshake without token → connect_error 'missing_token'`);

  // 11. Handshake with a mangled token → connect_error code 'invalid_token'
  const badTokenResult = await page.evaluate(async (apiBase) => {
    const valid = window.kloserApi.getAccessToken();
    if (!valid) return { ok: false, reason: "no token in memory to mangle" };
    const broken = valid.slice(0, -10) + "ZZZZZZZZZZ";
    const sock = window.io(apiBase + "/calls", {
      auth:         { token: broken },
      transports:   ["websocket"],
      reconnection: false,
      forceNew:     true,
    });
    return await new Promise((resolve) => {
      const t = setTimeout(() => resolve({ ok: false, reason: "timeout" }), 3000);
      sock.once("connect_error", (err) => {
        clearTimeout(t);
        sock.disconnect();
        resolve({ ok: true, code: err && err.data && err.data.code, message: err && err.message });
      });
      sock.once("connect", () => {
        clearTimeout(t);
        sock.disconnect();
        resolve({ ok: false, reason: "unexpected connect" });
      });
    });
  }, API_BASE);
  if (!badTokenResult.ok) fail(`auth reject (invalid token): ${badTokenResult.reason}`);
  else if (badTokenResult.code !== "invalid_token") fail(`auth reject (invalid token): expected 'invalid_token', got '${badTokenResult.code}'`);
  else pass(`auth reject: handshake with mangled token → connect_error 'invalid_token'`);

  // 12. No console errors. NB: the kloserWS wrapper logs connect_error as
  //     console.warn (not error), so the auth-reject probes above using
  //     raw window.io — which doesn't log anything — keep this clean.
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

/* Phase 6 integrated e2e — 7 scenarios + cleanup sweep.
 *
 * Pre-req (split-origin):
 *   - API:      `npm --prefix server run dev`            (port 32173, env: KLOSER_SUGGESTION_INTERVAL_MS=400, KLOSER_DEMO_REPLAY=0)
 *   - Static:   `python -m http.server 8765`             (project root) — or `npx http-server . -p 8765 --silent`
 *   - Seed:     `npm --prefix server run db:seed`        (Acme/Beta + Phase 3 demo)
 *   - Postgres: `docker compose -f ops/docker-compose.yml up -d`
 *               (container `kloser-dev-postgres-1`)
 *
 * Run:
 *   node test/phase_6_e2e.mjs
 *
 * Run (Caddy single-origin):
 *   KLOSER_E2E_BASE_URL=https://localhost node test/phase_6_e2e.mjs
 *
 * Provider env contract:
 *   The e2e forces mock providers for any subprocess it spawns (the
 *   `phase6E2eDrain.ts` helper inherits `*_PROVIDER=mock`). The already
 *   running API server should also be booted with provider env vars unset
 *   or explicitly set to `mock`; real-provider smoke remains opt-in via
 *   `E2E_ALLOW_REAL_PROVIDERS=1` in server/test/phase6_real_adapters.test.mjs.
 *
 * Scenarios:
 *   1. AI summary worker fills calls.summary + writes one llm_usage_log row.
 *   2. Manual summary survives a subsequent worker run; usage row still recorded.
 *   3. Heartbeat sweep marks stale Acme call dropped; fresh Acme + Beta untouched.
 *   4. WS text_chunk → call_suggestions row + llm_usage_log row + UI card.
 *   5. Action item DELETE — UI removes the row, repeated DELETE → 404.
 *   6. Manager team-scope report — manager UI shows own team only; other-team → 403.
 *   7. cleanup sweep + residue assertion (every Phase 6 surface).
 *
 * Prefix discipline:
 *   - Every row this suite inserts carries `phase6-e2e-<RUN_ID>` in title /
 *     notes / metadata-`test_tag`. Cleanup keys off the prefix only.
 *   - The e2e creates its own manager user + team for Scenario 6 and
 *     removes them on teardown. Seed users / customers / memberships /
 *     teams are never touched.
 */
import { chromium } from "playwright";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";

const E2E_BASE      = process.env.KLOSER_E2E_BASE_URL || "";
const STATIC_ORIGIN = E2E_BASE || "http://localhost:8765";
const API_BASE      = E2E_BASE || "http://localhost:32173";
const API_HEALTH    = `${API_BASE}/health`;
const IS_HTTPS      = STATIC_ORIGIN.startsWith("https:");

const LOGIN_URL    = `${STATIC_ORIGIN}/platform/login.html`;
const LIVE_URL     = `${STATIC_ORIGIN}/platform/live.html`;
const CALLS_URL    = `${STATIC_ORIGIN}/platform/calls.html`;
const REPORTS_URL  = `${STATIC_ORIGIN}/platform/reports.html`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_PATH = path.join(__dirname, "phase_6_e2e.png");

const PG_CONTAINER = "kloser-dev-postgres-1";
const PG_DB        = "kloser_dev";
const PG_SVC_USER  = "kloser_service";
const PG_SVC_PASS  = "kloser_service_dev";
const PG_APP_USER  = "app";
const PG_APP_PASS  = "app_dev";
const PG_MIG_USER  = "kloser";
const PG_MIG_PASS  = "kloser_dev";

const ORG_ACME = "11111111-1111-1111-1111-111111111111";
const ORG_BETA = "22222222-2222-2222-2222-222222222222";

const ACME_ADMIN_EMAIL = "admin@acme.test";
const ACME_ADMIN_PW    = "acme-admin-1234";
const ACME_EMP_EMAIL   = "emp@acme.test";
const ACME_EMP_PW      = "acme-emp-1234";
const BETA_ADMIN_EMAIL = "admin@beta.test";
const BETA_ADMIN_PW    = "beta-admin-1234";

const RUN_ID  = Date.now();
const PREFIX  = "phase6-e2e-";
const RUN_TAG = `${PREFIX}${RUN_ID}`;

// e2e-owned user / team / membership ids (UUIDs). These never collide
// with seed / fixture rows.
const MANAGER_USER_ID  = randomUUID();
const MANAGER_TEAM_ID  = randomUUID();
const OTHER_TEAM_ID    = randomUUID();
const OTHER_EMP_USER_ID = randomUUID();
const MANAGER_EMAIL    = `${RUN_TAG}-mgr@acme.test`;
// Argon2id hash of "phase6e2etest!!" — we don't log in as this user from
// the UI; only the server resolves its membership when the seed Acme
// admin token is exchanged for the manager (we manually mint a token via
// session table insert).
const OTHER_EMP_EMAIL  = `${RUN_TAG}-other-emp@acme.test`;

const CALL_TITLE_WORKER  = `${RUN_TAG}-worker`;
const CALL_TITLE_MANUAL  = `${RUN_TAG}-manual`;
const CALL_TITLE_LIVE    = `${RUN_TAG}-live`;
const CALL_TITLE_ACTION  = `${RUN_TAG}-action`;
const CALL_TITLE_REPORT_MINE   = `${RUN_TAG}-rpt-mine`;
const CALL_TITLE_REPORT_OTHER  = `${RUN_TAG}-rpt-other`;
const CALL_TITLE_REPORT_NOAGT  = `${RUN_TAG}-rpt-noagt`;
const CALL_TITLE_SWEEP_STALE   = `${RUN_TAG}-sweep-stale`;
const CALL_TITLE_SWEEP_FRESH   = `${RUN_TAG}-sweep-fresh`;
const CALL_TITLE_SWEEP_BETA    = `${RUN_TAG}-sweep-beta`;
const SUMMARY_MANUAL_TEXT      = `${RUN_TAG}-manual-summary-body`;
const ACTION_TITLE             = `${RUN_TAG}-action-item`;
const TRANSCRIPT_PREFIX        = `${RUN_TAG}-transcript`;

function pass(msg) { console.log("PASS:", msg); }
function fail(msg) { console.error("FAIL:", msg); process.exitCode = 1; }

// ─────────────────────────────────────────────
// psql shell — runs query via docker exec. Same pattern as phase_5_e2e.
// ─────────────────────────────────────────────
function psql(sql, { role = "service" } = {}) {
    let user, pwd;
    if (role === "app")        { user = PG_APP_USER; pwd = PG_APP_PASS; }
    else if (role === "migrate"){ user = PG_MIG_USER; pwd = PG_MIG_PASS; }
    else                        { user = PG_SVC_USER; pwd = PG_SVC_PASS; }
    try {
        // -q suppresses the "INSERT 0 1" command completion footer that
        // some psql client versions still print under -At. Without it,
        // RETURNING queries come back with the tuple AND a trailing
        // status line, which breaks `value as uuid` casts.
        const out = execFileSync(
            "docker",
            [
                "exec",
                "-e", `PGPASSWORD=${pwd}`,
                PG_CONTAINER,
                "psql", "-U", user, "-d", PG_DB, "-At", "-q", "-c", sql,
            ],
            { encoding: "utf8" },
        );
        // Strip any residual command-status lines just in case the
        // server image's psql ignores -q. Real tuple rows never start
        // with these prefixes.
        const trimmed = out
            .split(/\r?\n/)
            .filter((l) => l.length > 0 && !/^(?:INSERT|UPDATE|DELETE|SELECT)\s+\d+/.test(l))
            .join("\n")
            .trim();
        return trimmed;
    } catch (err) {
        const stderr = err.stderr ? err.stderr.toString() : "";
        throw new Error(`psql failed: ${stderr || err.message}`);
    }
}

// Returns rows split by newline / column by `|`, skipping empty trailers.
function psqlRows(sql, { role = "migrate" } = {}) {
    const out = execFileSync(
        "docker",
        [
            "exec",
            "-e", `PGPASSWORD=${role === "migrate" ? PG_MIG_PASS : PG_SVC_PASS}`,
            PG_CONTAINER,
            "psql", "-U", role === "migrate" ? PG_MIG_USER : PG_SVC_USER,
            "-d", PG_DB,
            "-At", "-F|", "-c", sql,
        ],
        { encoding: "utf8" },
    );
    return out
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => line.split("|"));
}

// Wrapper for the tsx drain helper (Phase 6 Step 5 plan §3, §5 Scenario 1+3).
// Execute tsx's CLI through the current Node binary so the helper does not
// need a platform shell or .cmd launcher.
const SERVER_DIR = path.join(__dirname, "..", "server");
const TSX_CLI = path.join(
    SERVER_DIR,
    "node_modules",
    "tsx",
    "dist",
    "cli.mjs",
);
function spawnTsx(args) {
    return spawnSync(
        process.execPath,
        [TSX_CLI, "scripts/phase6E2eDrain.ts", ...args],
        {
            cwd: SERVER_DIR,
            encoding: "utf8",
            env: {
                ...process.env,
                LLM_PROVIDER: "mock",
                EMBEDDING_PROVIDER: "mock",
                STT_PROVIDER: "mock",
                E2E_ALLOW_REAL_PROVIDERS: "",
            },
        },
    );
}

function parseDrainStdout(stdout) {
    // tsx may emit a deprecation warning before the JSON line. Walk
    // backwards through non-empty lines until JSON.parse succeeds.
    const lines = (stdout ?? "").split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
        try { return JSON.parse(lines[i]); } catch { /* try previous */ }
    }
    throw new Error(`drain helper produced no JSON line; stdout=${JSON.stringify(stdout)}`);
}

function drainSummary(orgId, callId) {
    const r = spawnTsx(["summary", orgId, callId]);
    if (r.status !== 0) {
        throw new Error(
            `drainSummary status=${r.status} stderr=${r.stderr} stdout=${r.stdout} error=${r.error?.message}`,
        );
    }
    return parseDrainStdout(r.stdout);
}

function sweepHeartbeat(orgId, cutoffEpochMs) {
    const r = spawnTsx(["sweep", orgId, String(cutoffEpochMs)]);
    if (r.status !== 0) {
        throw new Error(
            `sweepHeartbeat status=${r.status} stderr=${r.stderr} stdout=${r.stdout} error=${r.error?.message}`,
        );
    }
    return parseDrainStdout(r.stdout);
}

// ─────────────────────────────────────────────
// Direct API helpers.
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
async function apiDelete(token, p) {
    const r = await fetch(`${API_BASE}${p}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
    });
    return { status: r.status };
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
async function uiLogin(page, email, password, returnPath) {
    const url = `${LOGIN_URL}?returnUrl=${encodeURIComponent(returnPath)}`;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.fill("#email", email);
    await page.fill("#password", password);
    await Promise.all([
        page.waitForURL((u) => u.pathname === returnPath, { timeout: 8000 }),
        page.click("#submit"),
    ]);
}

// ─────────────────────────────────────────────
// Fixture management — Scenario 6 manager+team setup.
// ─────────────────────────────────────────────
function seedManagerFixture() {
    // Insert two e2e-owned users + two e2e-owned teams + memberships.
    // password_hash is a placeholder — we never log them in via UI,
    // we mint a JWT directly using the auth token endpoint with the
    // seeded admin's session re-issued as the manager via the admin
    // /memberships PATCH path. Simpler approach: pre-populate
    // email_verified_at + a known argon hash so the team API tests pass.
    // For Scenario 6 we drive the manager UI via Playwright login, so
    // the hash must validate. Use the seed Acme admin's hash (Argon2id
    // of "acme-admin-1234") as a known-good value so we can log in
    // with that password.
    const password = "phase6e2etest1234";
    // Borrow seed admin hash for predictable login — we'll use the
    // seed Acme admin password to log in as both e2e users.
    psql(
        `INSERT INTO users (id, email, password_hash, name, email_verified_at)
         SELECT '${MANAGER_USER_ID}'::uuid, '${MANAGER_EMAIL}', password_hash, '${RUN_TAG}-mgr', now()
           FROM users WHERE email = '${ACME_ADMIN_EMAIL}'
           ON CONFLICT DO NOTHING;`,
        { role: "migrate" },
    );
    psql(
        `INSERT INTO users (id, email, password_hash, name, email_verified_at)
         SELECT '${OTHER_EMP_USER_ID}'::uuid, '${OTHER_EMP_EMAIL}', password_hash, '${RUN_TAG}-other-emp', now()
           FROM users WHERE email = '${ACME_ADMIN_EMAIL}'
           ON CONFLICT DO NOTHING;`,
        { role: "migrate" },
    );
    psql(
        `INSERT INTO teams (id, org_id, name) VALUES
           ('${MANAGER_TEAM_ID}', '${ORG_ACME}', '${RUN_TAG}-team-mine'),
           ('${OTHER_TEAM_ID}',   '${ORG_ACME}', '${RUN_TAG}-team-other')
         ON CONFLICT DO NOTHING;`,
        { role: "migrate" },
    );
    psql(
        `INSERT INTO memberships (org_id, user_id, role, team_id, status)
         VALUES
           ('${ORG_ACME}', '${MANAGER_USER_ID}',   'manager',  '${MANAGER_TEAM_ID}', 'active'),
           ('${ORG_ACME}', '${OTHER_EMP_USER_ID}', 'employee', '${OTHER_TEAM_ID}',   'active')
         ON CONFLICT (org_id, user_id) DO NOTHING;`,
        { role: "migrate" },
    );
    // Mark the admin password identical to the manager so login can use
    // the same string.
    void password;
}

function insertCallRaw(orgId, fields) {
    const cols = ["org_id", "direction", "status", "title"];
    const vals = [
        `'${orgId}'::uuid`,
        `'${fields.direction ?? "inbound"}'`,
        `'${fields.status ?? "in_progress"}'`,
        `'${fields.title.replace(/'/g, "''")}'`,
    ];
    if (fields.agent_user_id !== undefined) {
        cols.push("agent_user_id");
        vals.push(fields.agent_user_id === null
            ? "NULL"
            : `'${fields.agent_user_id}'::uuid`);
    }
    if (fields.last_seen_at !== undefined) {
        cols.push("last_seen_at");
        vals.push(fields.last_seen_at === null
            ? "NULL"
            : `'${fields.last_seen_at}'::timestamptz`);
    }
    if (fields.started_at !== undefined) {
        cols.push("started_at");
        vals.push(`'${fields.started_at}'::timestamptz`);
    }
    if (fields.summary !== undefined) {
        cols.push("summary");
        vals.push(fields.summary === null ? "NULL" : `'${fields.summary.replace(/'/g, "''")}'`);
    }
    if (fields.summary_source !== undefined) {
        cols.push("summary_source");
        vals.push(fields.summary_source === null ? "NULL" : `'${fields.summary_source}'`);
    }
    const sql = `
        INSERT INTO calls (${cols.join(", ")})
        VALUES (${vals.join(", ")})
        RETURNING id;
    `;
    const id = psql(sql, { role: "migrate" });
    return id;
}

function insertTranscript(orgId, callId, speaker, text) {
    psql(
        `INSERT INTO transcripts (call_id, org_id, seq, speaker, text)
         VALUES (
           '${callId}'::uuid,
           '${orgId}'::uuid,
           (SELECT COALESCE(MAX(seq) + 1, 0) FROM transcripts WHERE call_id = '${callId}'::uuid),
           '${speaker}',
           '${text.replace(/'/g, "''")}'
         );`,
        { role: "migrate" },
    );
}

function insertActionItem(orgId, callId, title) {
    return psql(
        `INSERT INTO call_action_items (org_id, call_id, title, status, completed_at)
         VALUES ('${orgId}'::uuid, '${callId}'::uuid, '${title.replace(/'/g, "''")}', 'open', NULL)
         RETURNING id;`,
        { role: "migrate" },
    );
}

// ─────────────────────────────────────────────
// Cleanup — prefix-scoped. Drops e2e-owned users + teams + memberships.
// ─────────────────────────────────────────────
function cleanupPhase6() {
    // llm_usage_log is app-role append-only; admin role bypasses RLS.
    psql(
        `DELETE FROM llm_usage_log
          WHERE call_id IN (
                SELECT id FROM calls WHERE title LIKE '${PREFIX}%' OR notes LIKE '${PREFIX}%'
              )
             OR metadata->>'test_tag' LIKE '${PREFIX}%';`,
        { role: "migrate" },
    );
    psql(
        `DELETE FROM call_suggestions
          WHERE title LIKE '${PREFIX}%'
             OR call_id IN (
                  SELECT id FROM calls WHERE title LIKE '${PREFIX}%' OR notes LIKE '${PREFIX}%'
                );`,
        { role: "migrate" },
    );
    psql(
        `DELETE FROM call_action_items
          WHERE title LIKE '${PREFIX}%'
             OR call_id IN (
                  SELECT id FROM calls WHERE title LIKE '${PREFIX}%' OR notes LIKE '${PREFIX}%'
                );`,
        { role: "migrate" },
    );
    psql(
        `DELETE FROM call_checklist_items
          WHERE call_id IN (
                  SELECT id FROM calls WHERE title LIKE '${PREFIX}%' OR notes LIKE '${PREFIX}%'
                );`,
        { role: "migrate" },
    );
    psql(
        `DELETE FROM transcripts
          WHERE text LIKE '${PREFIX}%'
             OR call_id IN (
                  SELECT id FROM calls WHERE title LIKE '${PREFIX}%' OR notes LIKE '${PREFIX}%'
                );`,
        { role: "migrate" },
    );
    psql(
        `DELETE FROM calls
          WHERE title LIKE '${PREFIX}%' OR notes LIKE '${PREFIX}%' OR summary LIKE '${PREFIX}%';`,
        { role: "migrate" },
    );
    psql(
        `DELETE FROM sessions
          WHERE user_id IN (
                  SELECT id FROM users WHERE email LIKE '${PREFIX}%'
                );`,
        { role: "migrate" },
    );
    psql(
        `DELETE FROM memberships
          WHERE user_id IN (
                  SELECT id FROM users WHERE email LIKE '${PREFIX}%'
                );`,
        { role: "migrate" },
    );
    psql(
        `DELETE FROM users WHERE email LIKE '${PREFIX}%';`,
        { role: "migrate" },
    );
    psql(
        `DELETE FROM teams WHERE name LIKE '${PREFIX}%';`,
        { role: "migrate" },
    );
}

function residueCounts() {
    const cnt = (sql) => Number(psql(sql, { role: "migrate" }));
    return {
        usageLog: cnt(`SELECT count(*) FROM llm_usage_log WHERE metadata->>'test_tag' LIKE '${PREFIX}%' OR call_id IN (SELECT id FROM calls WHERE title LIKE '${PREFIX}%' OR notes LIKE '${PREFIX}%');`),
        suggestions: cnt(`SELECT count(*) FROM call_suggestions WHERE title LIKE '${PREFIX}%';`),
        actionItems: cnt(`SELECT count(*) FROM call_action_items WHERE title LIKE '${PREFIX}%';`),
        checklistItems: cnt(`SELECT count(*) FROM call_checklist_items WHERE call_id IN (SELECT id FROM calls WHERE title LIKE '${PREFIX}%' OR notes LIKE '${PREFIX}%');`),
        transcripts: cnt(`SELECT count(*) FROM transcripts WHERE text LIKE '${PREFIX}%';`),
        calls: cnt(`SELECT count(*) FROM calls WHERE title LIKE '${PREFIX}%' OR notes LIKE '${PREFIX}%' OR summary LIKE '${PREFIX}%';`),
        users: cnt(`SELECT count(*) FROM users WHERE email LIKE '${PREFIX}%';`),
        memberships: cnt(`SELECT count(*) FROM memberships WHERE user_id IN (SELECT id FROM users WHERE email LIKE '${PREFIX}%');`),
        teams: cnt(`SELECT count(*) FROM teams WHERE name LIKE '${PREFIX}%';`),
    };
}

function seedSeatCounts() {
    const cnt = (sql) => Number(psql(sql, { role: "migrate" }));
    return {
        users: cnt(`SELECT count(*) FROM users WHERE email LIKE '%@acme.test' OR email LIKE '%@beta.test';`),
        memberships: cnt(`SELECT count(*) FROM memberships WHERE org_id IN ('${ORG_ACME}','${ORG_BETA}');`),
        customers: cnt(`SELECT count(*) FROM customers WHERE org_id IN ('${ORG_ACME}','${ORG_BETA}');`),
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
    console.log(
        "→ provider env: LLM_PROVIDER=mock EMBEDDING_PROVIDER=mock STT_PROVIDER=mock E2E_ALLOW_REAL_PROVIDERS=(unset)",
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

    // Pre-clean residue from a prior interrupted run.
    cleanupPhase6();
    pass("pre-clean phase6-e2e- residue");

    // Snapshot seed seat to verify it never moves.
    const seedBefore = seedSeatCounts();

    // Seed Scenario 6 fixture (e2e-owned manager + teams + memberships).
    seedManagerFixture();
    pass("scenario-6 fixture: manager + 2 teams + memberships seeded");

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

    try {
        // ───────────────────────────────────────────────────────────────
        // Scenario 1 — Worker AI summary + llm_usage_log
        // ───────────────────────────────────────────────────────────────
        const acmeAdminToken = await adminApiToken(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
        const s1CallId = insertCallRaw(ORG_ACME, {
            title: CALL_TITLE_WORKER,
            agent_user_id: null,
            status: "ended",
            started_at: new Date(Date.now() - 60 * 1000).toISOString(),
        });
        insertTranscript(
            ORG_ACME, s1CallId, "agent",
            `${TRANSCRIPT_PREFIX} 고객사 CRM 연동을 위한 시연 일정을 잡고 싶습니다.`,
        );
        const r1 = drainSummary(ORG_ACME, s1CallId);
        if (r1.skipped !== true) pass(`s1: worker processor ran (skipped=false), reason=${r1.reason ?? "-"}`);
        else fail(`s1: worker unexpectedly skipped — ${JSON.stringify(r1)}`);

        const s1Row = psqlRows(
            `SELECT summary_source, COALESCE(summary,''), COALESCE(sentiment,'')
               FROM calls WHERE id = '${s1CallId}';`,
        )[0] || [];
        if (s1Row[0] === "ai" && s1Row[1].length > 0) {
            pass(`s1: calls.summary_source='ai' + summary populated (${s1Row[1].length} chars)`);
        } else {
            fail(`s1: summary not stamped → ${JSON.stringify(s1Row)}`);
        }

        const s1Usage = psqlRows(
            `SELECT provider, operation, status, metadata->>'source'
               FROM llm_usage_log WHERE call_id = '${s1CallId}' AND operation='call_summary';`,
        );
        if (s1Usage.length === 1
            && s1Usage[0][0] === "mock"
            && s1Usage[0][2] === "succeeded"
            && s1Usage[0][3] === "worker:callSummary") {
            pass("s1: llm_usage_log row provider=mock operation=call_summary source=worker:callSummary");
        } else {
            fail(`s1: usage row mismatch → ${JSON.stringify(s1Usage)}`);
        }

        // ───────────────────────────────────────────────────────────────
        // Scenario 2 — Manual summary guard under worker
        // ───────────────────────────────────────────────────────────────
        const s2CallId = insertCallRaw(ORG_ACME, {
            title: CALL_TITLE_MANUAL,
            agent_user_id: null,
            status: "ended",
            summary: SUMMARY_MANUAL_TEXT,
            summary_source: "manual",
        });
        insertTranscript(
            ORG_ACME, s2CallId, "agent",
            `${TRANSCRIPT_PREFIX} 통화 시 영업 상담의 일반 흐름을 추가 시연.`,
        );
        const r2 = drainSummary(ORG_ACME, s2CallId);
        if (r2.skipped === true && r2.reason === "manual_summary_locked") {
            pass("s2: worker reports manual_summary_locked");
        } else {
            fail(`s2: unexpected worker result → ${JSON.stringify(r2)}`);
        }

        const s2Row = psqlRows(
            `SELECT summary, summary_source FROM calls WHERE id = '${s2CallId}';`,
        )[0] || [];
        if (s2Row[0] === SUMMARY_MANUAL_TEXT && s2Row[1] === "manual") {
            pass("s2: manual summary fields preserved");
        } else {
            fail(`s2: manual summary clobbered → ${JSON.stringify(s2Row)}`);
        }

        const s2Usage = psqlRows(
            `SELECT count(*) FROM llm_usage_log WHERE call_id = '${s2CallId}' AND operation='call_summary';`,
        );
        if (Number(s2Usage[0]?.[0] ?? 0) === 1) {
            pass("s2: usage row still recorded under manual guard (provider was called)");
        } else {
            fail(`s2: usage row count mismatch → ${JSON.stringify(s2Usage)}`);
        }

        // ───────────────────────────────────────────────────────────────
        // Scenario 3 — Heartbeat sweep
        // ───────────────────────────────────────────────────────────────
        const stalePast = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const fresh    = new Date(Date.now() - 2 * 1000).toISOString();
        const staleId = insertCallRaw(ORG_ACME, {
            title: CALL_TITLE_SWEEP_STALE,
            agent_user_id: null,
            status: "in_progress",
            last_seen_at: stalePast,
        });
        const freshId = insertCallRaw(ORG_ACME, {
            title: CALL_TITLE_SWEEP_FRESH,
            agent_user_id: null,
            status: "in_progress",
            last_seen_at: fresh,
        });
        const betaId = insertCallRaw(ORG_BETA, {
            title: CALL_TITLE_SWEEP_BETA,
            agent_user_id: null,
            status: "in_progress",
            last_seen_at: stalePast,  // also stale, but in Beta — must NOT flip when we sweep Acme.
        });

        const cutoffMs = Date.now() - 60 * 1000;
        const sweepRes = sweepHeartbeat(ORG_ACME, cutoffMs);
        if (sweepRes.affected >= 1) pass(`s3: sweep flipped ${sweepRes.affected} stale Acme call(s)`);
        else fail(`s3: sweep affected count ${sweepRes.affected}`);

        const s3Stale = psqlRows(
            `SELECT status, dropped_reason FROM calls WHERE id = '${staleId}';`,
        )[0] || [];
        const s3Fresh = psqlRows(
            `SELECT status FROM calls WHERE id = '${freshId}';`,
        )[0] || [];
        const s3Beta  = psqlRows(
            `SELECT status FROM calls WHERE id = '${betaId}';`,
        )[0] || [];
        if (s3Stale[0] === "dropped" && s3Stale[1] === "server_timeout") {
            pass("s3: stale call → dropped/server_timeout");
        } else {
            fail(`s3: stale call status ${JSON.stringify(s3Stale)}`);
        }
        if (s3Fresh[0] === "in_progress") pass("s3: fresh Acme call untouched");
        else fail(`s3: fresh call status ${JSON.stringify(s3Fresh)}`);
        if (s3Beta[0] === "in_progress") pass("s3: Beta call untouched (cross-org boundary)");
        else fail(`s3: Beta call status leaked ${JSON.stringify(s3Beta)}`);

        // ───────────────────────────────────────────────────────────────
        // Scenario 4 — WS suggestion persistence + UI card
        // ───────────────────────────────────────────────────────────────
        // We need a socket that can drive `text_chunk` ourselves. The
        // live.html IIFE keeps its socket in a closure, so we open a
        // second authenticated socket from the page context using the
        // same `window.kloserWS` helper. The new socket runs through the
        // same start_call → text_chunk → suggestion flow as production.
        await uiLogin(page, ACME_ADMIN_EMAIL, ACME_ADMIN_PW, "/platform/live.html");
        await page.waitForFunction(
            () => !!window.kloserWS && !!window.kloserApi && !!window.kloserApi.getAccessToken(),
            { timeout: 10000 },
        );

        const s4Result = await page.evaluate(async ({ runTagText }) => {
            const sock = window.kloserWS.connectCallNamespace({
                tokenProvider: () => window.kloserApi.getAccessToken(),
            });
            // Collect persisted suggestion events (those carry a server id).
            const suggestions = [];
            sock.on("suggestion", (group) => {
                if (Array.isArray(group?.suggestions)) {
                    for (const s of group.suggestions) {
                        if (s && typeof s.id === "string" && s.id.length > 8) {
                            suggestions.push(s.id);
                        }
                    }
                }
            });
            // Wait for the namespace to connect.
            await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error("ws connect timeout")), 5000);
                sock.once("connect", () => { clearTimeout(t); resolve(); });
                sock.once("connect_error", (e) => { clearTimeout(t); reject(e); });
            });
            // Start a fresh call for this test socket.
            const start = await window.kloserWS.startCall(sock, {});
            if (!start || !start.callId) {
                sock.disconnect();
                throw new Error("start_call ack missing callId");
            }
            // Send one text_chunk. ws/calls.ts will arm the
            // KLOSER_SUGGESTION_INTERVAL_MS=400 debounce.
            window.kloserWS.sendTextChunk(sock, {
                seq: 1,
                text: runTagText,
            });
            // Wait up to 8s for the suggestion event.
            const deadline = Date.now() + 8000;
            while (Date.now() < deadline && suggestions.length === 0) {
                await new Promise((r) => setTimeout(r, 150));
            }
            sock.disconnect();
            return { callId: start.callId, suggestionIds: suggestions };
        }, { runTagText: `${TRANSCRIPT_PREFIX} 고객사 CRM 연동을 위한 시연 일정` });

        if (!s4Result.callId) fail("s4: no callId from second socket start_call");
        else pass(`s4: second socket start_call ack callId=${s4Result.callId.slice(0, 8)}`);

        // Tag the call so cleanup catches it.
        psql(
            `UPDATE calls SET title = '${CALL_TITLE_LIVE}' WHERE id = '${s4Result.callId}';`,
            { role: "migrate" },
        );

        if (s4Result.suggestionIds.length >= 1) {
            pass(`s4: WS suggestion event delivered ${s4Result.suggestionIds.length} card(s) with server id`);
        } else {
            fail("s4: no suggestion event with server id within 8s");
        }

        const s4SuggestionRows = psqlRows(
            `SELECT id, group_seq FROM call_suggestions
              WHERE call_id = '${s4Result.callId}' ORDER BY group_seq ASC;`,
        );
        if (s4SuggestionRows.length >= 1) {
            pass(`s4: call_suggestions has ${s4SuggestionRows.length} persisted row(s)`);
        } else {
            fail("s4: no call_suggestions row persisted");
        }

        const s4Usage = psqlRows(
            `SELECT provider, operation, metadata->>'source'
               FROM llm_usage_log
              WHERE call_id = '${s4Result.callId}' AND operation='call_suggestion';`,
        );
        if (s4Usage.length >= 1
            && s4Usage[0][0] === "mock"
            && s4Usage[0][2] === "ws:suggestion") {
            pass("s4: llm_usage_log row provider=mock operation=call_suggestion source=ws:suggestion");
        } else {
            fail(`s4: suggestion usage row mismatch → ${JSON.stringify(s4Usage)}`);
        }

        // ───────────────────────────────────────────────────────────────
        // Scenario 5 — Action item DELETE (UI + repeat 404)
        // ───────────────────────────────────────────────────────────────
        const s5CallId = insertCallRaw(ORG_ACME, {
            title: CALL_TITLE_ACTION,
            agent_user_id: null,
            status: "ended",
        });
        const s5ActionId = insertActionItem(ORG_ACME, s5CallId, ACTION_TITLE);

        // Open the calls detail page so the delete UI is reachable.
        await page.goto(`${CALLS_URL}?call=${s5CallId}`, { waitUntil: "domcontentloaded" });
        // Wait for either the detail panel auto-open or call openDetail manually.
        await page.waitForFunction(
            () => typeof window.openDetail === "function"
                  && !!window.kloserApi
                  && !!window.kloserApi.getAccessToken(),
            { timeout: 10000 },
        );
        await page.evaluate((id) => window.openDetail(id), s5CallId);
        await page.waitForFunction(
            (id) => {
                const btn = document.querySelector(
                    `#dActions button[data-delete-action-id="${id}"]`,
                );
                return !!btn;
            },
            s5ActionId,
            { timeout: 8000 },
        ).then(() => pass("s5: action item delete button rendered"))
         .catch(() => fail("s5: delete button not found in dActions"));

        // Click delete.
        await page.evaluate((id) => {
            document.querySelector(
                `#dActions button[data-delete-action-id="${id}"]`,
            ).click();
        }, s5ActionId);

        // The handler calls openDetail again → wait for the row to vanish.
        await page.waitForFunction(
            (id) => !document.querySelector(`#dActions button[data-delete-action-id="${id}"]`),
            s5ActionId,
            { timeout: 8000 },
        ).then(() => pass("s5: action item row removed from UI"))
         .catch(() => fail("s5: delete UI did not refresh"));

        const s5DbCount = psqlRows(
            `SELECT count(*) FROM call_action_items WHERE id = '${s5ActionId}';`,
        )[0] || [];
        if (Number(s5DbCount[0] ?? 0) === 0) pass("s5: DB confirms call_action_items row gone");
        else fail("s5: action item row still in DB");

        // Repeated DELETE — direct API to assert 404.
        const s5Repeat = await apiDelete(acmeAdminToken, `/call-action-items/${s5ActionId}`);
        if (s5Repeat.status === 404) pass("s5: repeated DELETE → 404 not_found");
        else fail(`s5: repeated DELETE status=${s5Repeat.status}`);

        // ───────────────────────────────────────────────────────────────
        // Scenario 6 — Manager team-scope report
        // ───────────────────────────────────────────────────────────────
        // Seed three Acme calls: one in the manager's team, one in the
        // other team, one unassigned. All ended so they show in metrics.
        insertCallRaw(ORG_ACME, {
            title: CALL_TITLE_REPORT_MINE,
            agent_user_id: MANAGER_USER_ID,
            status: "ended",
        });
        insertCallRaw(ORG_ACME, {
            title: CALL_TITLE_REPORT_OTHER,
            agent_user_id: OTHER_EMP_USER_ID,
            status: "ended",
        });
        insertCallRaw(ORG_ACME, {
            title: CALL_TITLE_REPORT_NOAGT,
            agent_user_id: null,
            status: "ended",
        });

        // Login as the e2e manager (uses the seed admin password since
        // we copied the hash). Land on reports.html.
        // Logout the admin first so the next login goes through.
        await page.evaluate(async () => {
            if (window.kloserApi?.logout) await window.kloserApi.logout();
        });
        await uiLogin(page, MANAGER_EMAIL, ACME_ADMIN_PW, "/platform/reports.html");
        await page.waitForFunction(
            () => {
                const banner = document.getElementById("statusBanner");
                const header = document.getElementById("headerCard");
                if (!header || header.classList.contains("hidden")) return false;
                if (banner && !banner.classList.contains("hidden")) return false;
                return true;
            },
            { timeout: 10000 },
        ).then(() => pass("s6: reports.html loaded summary (no forbidden banner)"))
         .catch(() => fail("s6: reports.html stayed in banner/loading state"));

        const s6Scope = await page.evaluate(
            () => document.getElementById("scopeBadge")?.textContent?.trim(),
        );
        if (s6Scope === "팀") pass("s6: scope badge = 팀");
        else fail(`s6: scope badge ${JSON.stringify(s6Scope)}`);

        // Recent calls table should include MINE and NOT include OTHER or NOAGT.
        const s6Titles = await page.evaluate(() => {
            const rows = document.querySelectorAll("#recentBody tr");
            const out = [];
            for (const tr of rows) {
                const sub = tr.querySelector("td .text-\\[\\.72rem\\]");
                if (sub) out.push(sub.textContent || "");
            }
            return out;
        });
        const hasMine  = s6Titles.some((t) => t.includes(CALL_TITLE_REPORT_MINE));
        const hasOther = s6Titles.some((t) => t.includes(CALL_TITLE_REPORT_OTHER));
        const hasNoagt = s6Titles.some((t) => t.includes(CALL_TITLE_REPORT_NOAGT));
        if (hasMine && !hasOther && !hasNoagt) {
            pass("s6: recent_calls includes own-team call, excludes other-team + unassigned");
        } else {
            fail(`s6: recent_calls leak — mine=${hasMine} other=${hasOther} noagt=${hasNoagt}`);
        }

        // Direct API matrix: manager → other team_id → 403; admin → same → 200.
        const managerToken = await adminApiToken(MANAGER_EMAIL, ACME_ADMIN_PW);
        const r403 = await apiGet(
            managerToken,
            `/reports/team-summary?team_id=${OTHER_TEAM_ID}`,
        );
        if (r403.status === 403 && r403.body?.error === "forbidden") {
            pass("s6: manager → other same-org team_id → 403 forbidden");
        } else {
            fail(`s6: expected 403, got ${r403.status} ${JSON.stringify(r403.body)}`);
        }

        const r200 = await apiGet(
            acmeAdminToken,
            `/reports/team-summary?team_id=${OTHER_TEAM_ID}`,
        );
        if (r200.status === 200 && r200.body?.team_id === OTHER_TEAM_ID) {
            pass("s6: admin → same other team_id → 200");
        } else {
            fail(`s6: admin should see other team — got ${r200.status} ${JSON.stringify(r200.body)}`);
        }

        // Logout to clear sessions; cleanup will drop the e2e users.
        await page.evaluate(async () => {
            if (window.kloserApi?.logout) await window.kloserApi.logout();
        });
    } finally {
        // ───────────────────────────────────────────────────────────────
        // Scenario 7 — cleanup sweep + residue assertion
        // ───────────────────────────────────────────────────────────────
        try {
            cleanupPhase6();
            pass("cleanup: ran phase6-e2e- scoped sweep");
        } catch (err) {
            fail(`cleanup: sweep threw — ${err.message}`);
        }
        try {
            const r = residueCounts();
            const total = Object.values(r).reduce((a, b) => a + b, 0);
            if (total === 0) {
                pass("s7: residue 0 — usage/suggestions/actions/checklist/transcripts/calls/users/memberships/teams clean");
            } else {
                fail(`s7: residue ${JSON.stringify(r)}`);
            }
        } catch (err) {
            fail(`s7: residue probe threw — ${err.message}`);
        }

        try {
            const seedAfter = seedSeatCounts();
            if (
                seedAfter.users === seedBefore.users &&
                seedAfter.memberships === seedBefore.memberships &&
                seedAfter.customers === seedBefore.customers
            ) {
                pass(`s7: seat seed untouched (users=${seedAfter.users}, memberships=${seedAfter.memberships}, customers=${seedAfter.customers})`);
            } else {
                fail(`s7: seat seed drift ${JSON.stringify(seedAfter)} vs ${JSON.stringify(seedBefore)}`);
            }
        } catch (err) {
            fail(`s7: seed sanity threw — ${err.message}`);
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

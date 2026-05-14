# Phase 6 Step 5 Plan - Integrated E2E and Closeout

> Parent plan: `docs/plan/phase-6/PHASE_6_MASTER.md` section 4 Step 5.
> Previous step: Phase 6 Step 4 closeout (`a44391a Add Phase 6 team reports`).
> Scope: Phase 6 integrated e2e, historical e2e regression, final findings, README/status docs, Phase 7 handoff.
> Schema changes: none.

---

## 0. Goal

Close Phase 6 by proving Steps 1-4 work together in the same runtime:

- worker-backed AI summary and usage logging
- heartbeat timeout sweep
- WebSocket suggestion persistence
- action item delete UI/API
- manager team report UI/API
- cleanup with zero Phase 6 residue

This step is also the Phase 6 documentation closeout. After it passes, `PHASE_6_MASTER.md` should show Phase 6 complete and the README status blocks should reflect the new state.

---

## 1. Non-Goals

Do not include these in Step 5:

- database migration
- package dependency changes
- `.env` / `.env.example` changes
- Step 2 cost-accuracy model price map
- SMTP / MFA / audit log / retention / billing / SSO / timezone / i18n
- role-based sidebar hiding for reports
- report date-window filters or agent-level analytics

The Step 2 `cost_usd_micros = NULL` residual remains a documented follow-up unless the user explicitly asks for the separate cost-accuracy commit.

---

## 2. Required Deliverables

Add:

```text
test/phase_6_e2e.mjs
docs/plan/phase-6/PHASE_6_STEP_5_FINDINGS.md
docs/USER_GUIDE_PHASE_6.md
docs/plan/phase-6/PHASE_7_HANDOFF.md
```

Update:

```text
docs/plan/phase-6/PHASE_6_MASTER.md
README.md
server/README.md
```

Do not touch:

```text
server/migrations/**
server/package.json
server/package-lock.json
.env
.env.example
```

---

## 3. E2E Runtime Decision

Use the existing split-origin e2e pattern from `phase_4_e2e.mjs` and `phase_5_e2e.mjs`:

```powershell
docker compose -f ops/docker-compose.yml up -d
npm --prefix server run db:migrate:up
npm --prefix server run db:seed
npm --prefix server run dev
python -m http.server 8765
```

Run:

```powershell
node test/phase_6_e2e.mjs
```

Single-origin Caddy mode should remain supported:

```powershell
KLOSER_E2E_BASE_URL=https://localhost node test/phase_6_e2e.mjs
```

Provider env:

- Force mock providers inside the e2e script or document the required shell env:
  - `LLM_PROVIDER=mock`
  - `EMBEDDING_PROVIDER=mock`
  - `STT_PROVIDER=mock`
  - `E2E_ALLOW_REAL_PROVIDERS` unset
- Reason: Phase 6 e2e must be deterministic and must not spend external API cost.

Worker decision:

- Prefer **inline worker processing** in `phase_6_e2e.mjs`.
- Do not require a separately running `npm --prefix server run dev:worker` process.
- Use direct queue draining or direct invocation of the worker processor where the codebase exposes a stable helper.
- If no stable helper exists, add a small test-only helper in the e2e script that:
  1. creates the call-summary queue/worker dependencies,
  2. drains one queued job,
  3. closes worker/queue connections before exit.

This keeps the e2e repeatable on dev machines while still exercising the same queue payload, DB effects, and provider usage logging path.

---

## 4. `phase_6_e2e.mjs` Structure

Follow the style of `test/phase_5_e2e.mjs`:

- `chromium` from Playwright
- direct API helpers for setup/assertions
- `docker exec psql` helper for admin cleanup and residue assertions
- prefix-scoped rows only
- final cleanup sweep even on failure where practical

Constants:

```js
const PREFIX = "phase6-e2e-";
const RUN_ID = Date.now();
const RUN_TAG = `${PREFIX}${RUN_ID}`;
```

Suggested URLs:

```js
const LIVE_URL = `${STATIC_ORIGIN}/platform/live.html`;
const CALLS_URL = `${STATIC_ORIGIN}/platform/calls.html`;
const REPORTS_URL = `${STATIC_ORIGIN}/platform/reports.html`;
```

Use seeded users:

- `admin@acme.test`
- `emp@acme.test`
- `admin@beta.test`
- Phase 5 fixture manager users may not exist in seeded dev data. If manager/report UI needs a manager, create an e2e-owned manager user + membership + team using prefix-scoped data, then clean it up.

---

## 5. E2E Scenarios

Implement 7 scenarios. Keep each scenario short and assert concrete DB/UI effects.

### Scenario 1 - Worker AI Summary and Usage Log

Goal: prove Step 1 + Step 2 wiring works together.

Flow:

1. Login Acme admin.
2. Create/start a call through API or `live.html`.
3. Insert or send transcript text containing `RUN_TAG`.
4. End the call so the summary job is enqueued.
5. Drain the summary job inline.
6. Assert DB:
   - call has AI summary fields populated
   - `summary_source = 'ai'`
   - exactly one `llm_usage_log` row for the call with `operation = 'call_summary'`
   - usage row has `provider = 'mock'`
   - `cost_usd_micros` may be `NULL`

Do not require real Anthropic/OpenAI/Clova keys.

### Scenario 2 - Manual Summary Guard Under Worker

Goal: preserve Phase 5 manual summary contract while worker code is active.

Flow:

1. Create a call with transcript.
2. Save manual summary from `calls.html` detail or direct API.
3. End call / enqueue / drain worker.
4. Assert DB:
   - manual fields are unchanged
   - `summary_source = 'manual'`
   - usage row still exists because provider cost happened before SQL guard

This proves Step 2 usage ordering and Phase 5 manual guard do not regress.

### Scenario 3 - Heartbeat Sweep

Goal: prove stale in-progress calls are marked dropped.

Flow:

1. Insert two calls:
   - stale in_progress with old `last_seen_at`
   - fresh in_progress with current `last_seen_at`
2. Run heartbeat sweep helper directly.
3. Assert:
   - stale call becomes `dropped`, has `ended_at`, has `duration_seconds`
   - fresh call remains `in_progress`
   - cross-org rows are unaffected

If the production sweep uses a hard 60s cutoff, create DB rows directly with `last_seen_at` far enough in the past. Do not sleep in e2e.

### Scenario 4 - WebSocket Suggestion Persistence

Goal: prove text chunks produce persisted suggestions and UI can see them.

Flow:

1. Login admin to `live.html`.
2. Start a call.
3. Send a `text_chunk` over the page UI/WS path with `RUN_TAG`.
4. Wait for the suggestion debounce/timer.
5. Assert DB:
   - `call_suggestions` has a row for the call
   - `llm_usage_log` has `operation = 'call_suggestion'`
   - metadata includes `source = 'ws:suggestion'`
6. Assert UI:
   - suggestion card appears on live page or calls detail page

If timer latency is high, use the shortest existing test-supported timer hook. Avoid broad sleeps longer than necessary.

### Scenario 5 - Action Item Delete UI/API

Goal: prove Step 3 user-facing delete path.

Flow:

1. Create a call and an action item with title containing `RUN_TAG`.
2. Open `calls.html` detail.
3. Click the action item delete button.
4. Assert:
   - row disappears from UI after reload
   - DB no longer has the action item
5. Negative smoke:
   - employee or manager-other-team delete receives 403 through direct API, or
   - repeated delete returns 404

Do not add a confirm modal in this step.

### Scenario 6 - Manager Team Report UI/API

Goal: prove Step 4 report endpoint and page.

Flow:

1. Create e2e-owned team and manager membership if seeded data does not already include a manager team.
2. Create:
   - one call assigned to the manager's team
   - one call assigned to another same-org team/user
   - one unassigned call
3. Login manager and open `reports.html`.
4. Assert UI:
   - report loads without forbidden banner
   - KPI includes only own-team call(s)
   - other-team/unassigned `RUN_TAG` titles do not appear
5. Direct API assertion:
   - manager `GET /reports/team-summary?team_id=<other same-org team>` returns 403
   - admin can query the same team successfully

### Scenario 7 - Cleanup and Residue Zero

Goal: e2e-owned data leaves no residue.

Cleanup order:

1. `llm_usage_log`
2. `call_suggestions`
3. `call_checklist_items`
4. `call_action_items`
5. `transcripts`
6. `calls`
7. knowledge/checklist rows if created
8. sessions / auth tokens / outbox rows for e2e-created users
9. memberships / users / teams created by this e2e

Residue assertions should check every table touched by Phase 6:

- `calls`
- `transcripts`
- `call_action_items`
- `call_suggestions`
- `call_checklist_items`
- `llm_usage_log`
- e2e-created `users`
- e2e-created `memberships`
- e2e-created `teams`

Use prefix-scoped deletion. Avoid time-window deletion.

---

## 6. Historical Regression Runs

After `phase_6_e2e.mjs` passes, run:

```powershell
node test/phase_0_5_e2e.mjs
node test/phase_2_customers_e2e.mjs
node test/phase_3_e2e.mjs
node test/phase_4_e2e.mjs
node test/phase_5_e2e.mjs
```

Phase 5 special contract:

- Run `phase_5_e2e.mjs` once with workers/providers effectively off.
- If Step 5 implementation starts a worker process for any reason, also run `phase_5_e2e.mjs` while that worker is active.
- If inline worker draining is used, a second "worker ON" run is not meaningful; record that decision in findings.

Regression failures are blockers. Do not mark Phase 6 complete if any historical e2e fails.

---

## 7. Standard Validation

Run:

```powershell
npm --prefix server run typecheck
npm --prefix server test
node test/sync_shared_types.mjs
```

Expected at Step 5 start:

- server tests: 384 total / 381 pass / 3 skipped / 0 fail
- sync shared types: 15 entities

If new Step 5 helper code changes the counts, record the new totals in findings and master.

Also run frontend static syntax checks for touched pages/scripts:

- `platform/reports.html`
- `platform/calls.html`
- `platform/live.html`
- `platform/api.js`
- `platform/_shared.js`

If `phase_6_e2e.mjs` only adds tests/docs and does not touch platform files, the syntax check is still useful as final XSS gate evidence.

---

## 8. XSS Gate Review

Step 5 must re-check the frontend pages touched during Phase 6:

- `platform/calls.html`
  - action item delete button interpolation
  - action item row title/due/status/id interpolation
- `platform/reports.html`
  - recent calls table `innerHTML`
  - all KPI/scope/banner `textContent`
- `platform/_shared.js`
  - reports nav item constant chunk

Findings should include:

- every `innerHTML` / `insertAdjacentHTML` touched by Phase 6
- whether each interpolation is constant, server-returned, or user-typed
- escaping mechanism
- conclusion: violation count

Do not audit all historical demo pages in Step 5 unless they were touched by Phase 6. Note that dashboard/calls/newsletter/daily demo pages remain Phase 7+ UX/security cleanup if applicable.

---

## 9. Documentation Closeout

Create:

```text
docs/plan/phase-6/PHASE_6_STEP_5_FINDINGS.md
docs/USER_GUIDE_PHASE_6.md
docs/plan/phase-6/PHASE_7_HANDOFF.md
```

Update:

```text
docs/plan/phase-6/PHASE_6_MASTER.md
README.md
server/README.md
```

### `PHASE_6_STEP_5_FINDINGS.md`

Include:

- changed files
- e2e scenario results
- historical regression results
- standard validation results
- cleanup residue report
- XSS gate result
- final residual risks
- commit/push status

### `PHASE_6_MASTER.md`

Only after all validation passes:

- mark Step 5 complete
- mark remaining go/no-go e2e checkboxes complete
- update server test totals
- keep the Step 2 cost residual explicit
- make Phase 7+ handoff pointer clear

### README files

Update status blocks only. Avoid large rewrites.

Root README should say Phase 6 core is complete and list the active local commands.

`server/README.md` should reflect:

- worker-backed summaries
- provider adapters
- usage logging
- action item delete
- team reports
- e2e status

### `docs/USER_GUIDE_PHASE_6.md`

Keep it user-facing and short:

- what managers can do in reports
- how action item delete behaves
- what AI summaries/suggestions do
- mock vs real provider env note
- known limitations / Phase 7+ items

### `PHASE_7_HANDOFF.md`

Include prioritized follow-ups:

1. SMTP production email delivery
2. MFA / session hardening
3. audit/activity log
4. retention policies and recording storage
5. billing/subscription caps
6. cost-accuracy model price map for `llm_usage_log`
7. role-based navigation polish
8. report filters and agent drilldown
9. demo-to-real frontend cleanup

---

## 10. Failure Policy

If any Step 5 validation fails:

- do not mark Step 5 complete
- do not update README as "Phase 6 complete"
- write findings with failed command, root cause, and next fix
- keep cleanup residue assertion visible

If e2e infra is unavailable:

- record the missing prerequisite precisely
- leave Step 5 checkbox OFF
- do not substitute unit tests for e2e

If historical e2e exposes pre-existing flake:

- isolate whether Phase 6 caused it
- if unrelated but blocking, document and request direction before closing Phase 6

---

## 11. Completion Checklist

- [ ] `test/phase_6_e2e.mjs` added with 7 scenarios.
- [ ] Phase 6 e2e forces mock providers and avoids real provider cost.
- [ ] AI summary worker path verified.
- [ ] Manual summary guard under worker verified.
- [ ] Heartbeat sweep verified.
- [ ] WS suggestion persistence verified.
- [ ] Action item delete UI/API verified.
- [ ] Manager report UI/API verified.
- [ ] Cleanup residue zero verified.
- [ ] Phase 0.5 e2e regression PASS.
- [ ] Phase 2 customers e2e regression PASS.
- [ ] Phase 3 e2e regression PASS.
- [ ] Phase 4 e2e regression PASS.
- [ ] Phase 5 e2e regression PASS.
- [ ] `npm --prefix server run typecheck` PASS.
- [ ] `npm --prefix server test` PASS.
- [ ] `node test/sync_shared_types.mjs` PASS.
- [ ] Phase 6 XSS gate review documented.
- [ ] `PHASE_6_STEP_5_FINDINGS.md` written.
- [ ] `PHASE_6_MASTER.md` final checkboxes updated.
- [ ] Root `README.md` status block updated.
- [ ] `server/README.md` status block updated.
- [ ] `docs/USER_GUIDE_PHASE_6.md` written.
- [ ] `docs/plan/phase-6/PHASE_7_HANDOFF.md` written.

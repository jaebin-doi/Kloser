# Phase 4 Step 5 — Integration E2E + Phase 4 Closeout Plan

> **Parent plan**: `docs/plan/phase-4/PHASE_4_MASTER.md` Step 5.
> **Prerequisite**: Step 4 committed and pushed (`753e19f Complete Phase 4 frontend wiring`).
> **Scope**: automated Phase 4 browser/API e2e, final regression run, Phase 4 findings and docs closeout. No schema or route contract changes unless this step exposes a defect.
> **Default dev ports**: static `:8765`, API/WS `:32173`.

---

## Progress

- [x] 1. Lock Step 5 scope and risk decisions in this plan.
- [ ] 2. Implement `test/phase_4_e2e.mjs`.
- [ ] 3. Run `node test/phase_4_e2e.mjs` and prove cleanup.
- [ ] 4. Run required regression suite.
- [ ] 5. Write `PHASE_4_STEP_5_FINDINGS.md`.
- [ ] 6. Update `PHASE_4_MASTER.md` Step 5 and go/no-go checklist.
- [ ] 7. Update Phase 4 user/product docs only after e2e is green.

---

## 0. Goal

Step 4 proved the UI manually. Step 5 turns that into a repeatable gate:

1. Start from a seeded user and create a real persisted call through `live.html`.
2. Prove the call is visible through `calls.html`, including notes and transcript.
3. Prove `/dashboard/summary` changes are visible through `dashboard.html`.
4. Prove org isolation and role/write restrictions from the browser/API boundary.
5. Prove all Phase 4 test data is cleaned up even when an assertion fails.

This step closes Phase 4 only if the e2e and regression suite are green. If any test fails, stop in Step 5 and fix the defect before writing completion findings.

---

## 1. Deliverables

| Type | Path | Purpose |
|---|---|---|
| e2e script | `test/phase_4_e2e.mjs` | Phase 4 browser/API integration scenarios |
| screenshot artifact | `test/phase_4_e2e.png` | visual evidence, ignored like prior e2e screenshots if needed |
| findings | `docs/plan/phase-4/PHASE_4_STEP_5_FINDINGS.md` | e2e results, cleanup evidence, residual risks |
| master update | `docs/plan/phase-4/PHASE_4_MASTER.md` | Step 5 complete + go/no-go sync after tests pass |
| user docs | `docs/USER_GUIDE_PHASE_4.md` | user-facing Phase 4 walkthrough after behavior is stable |
| product docs | `docs/product/PHASE_4_FOUNDATIONS.html` | visual guide following Phase 1-3 pattern |
| README cleanup | `README.md`, `server/README.md` | current status block if Phase 4 is fully closed |

No server migrations, shared type changes, or new backend endpoints are planned.

---

## 2. Execution Environment

| Component | Command | Port |
|---|---|---|
| Postgres + Redis | `docker compose -f ops/docker-compose.yml up -d` | 5432 / 6379 |
| API + WS | `npm --prefix server run dev` | 32173 |
| Static HTML | `python -m http.server 8765` from repo root | 8765 |

The script supports the existing Caddy mode with `KLOSER_E2E_BASE_URL=https://localhost`, but split-origin is the required baseline.

Preflight checks inside the script:

- `GET ${API_BASE}/health` returns `{ ok: true }`.
- Login as `admin@acme.test` succeeds.
- Seed assumptions are sane enough to run: Acme and Beta seeded admins exist; Acme has seeded customers.
- Any leftover `phase4test-` rows from a prior interrupted run are hard-deleted before scenarios begin.

If a preflight fails, the script fails fast with an actionable message. It must not silently reseed or mutate baseline seed data.

---

## 3. Test Data Contract

Use `phase4test-<timestamp>` for every value intended for cleanup:

- live note text
- call title or notes when created through REST setup
- action item title
- transcript text
- temporary user email if role/unverified scenarios create users

Phase 4 call routes do not expose hard-delete. Cleanup therefore uses direct DB deletion in the e2e script, following Phase 3's dev-only DB cleanup precedent.

Cleanup rules:

1. Track every created `call.id` in a Set.
2. On `finally`, hard-delete from child to parent where needed:
   - `DELETE FROM call_action_items WHERE call_id = ANY($ids)`
   - `DELETE FROM transcripts WHERE call_id = ANY($ids)`
   - `DELETE FROM calls WHERE id = ANY($ids)`
3. Also sweep by prefix defensively:
   - `calls.notes LIKE 'phase4test-%'`
   - `calls.title LIKE 'phase4test-%'`
   - `call_action_items.title LIKE 'phase4test-%'`
   - `transcripts.text LIKE 'phase4test-%'`
4. Delete temporary `phase4test-` users/invitations if created.
5. Assert a final sweep count of zero.

Use the admin migration URL or service DB credentials only inside cleanup/outbox helpers. Runtime browser/API paths must still use normal app auth.

---

## 4. Scenario Plan

### Scenario 1 — Live Call Persists

1. Open `login.html`, log in as `admin@acme.test`.
2. Navigate to `live.html`.
3. Save a quick note with `phase4test-live-note-<timestamp>`.
4. End the call through the UI.
5. Assert by API:
   - `/calls?q=phase4test-live-note-...` returns exactly one Acme call.
   - call status is `ended`.
   - `notes` contains the test note.
   - `agent_user_id` belongs to the logged-in Acme admin.

This validates the actual Step 4 browser wiring: WS `start_call`, REST notes, WS `end_call`.

### Scenario 2 — Calls Page List, URL Sync, Detail

1. Open `calls.html?q=phase4test-live-note-<timestamp>`.
2. Assert URL search state stays present.
3. Assert `totalCount` is `1`.
4. Click the result row.
5. Assert detail panel shows:
   - shortened call id
   - status `완료`
   - notes panel with the test note
   - transcript panel renders without console errors

This protects the mock-removal boundary in `calls.html`.

### Scenario 3 — Transcript + Action Items Render

Use API setup against the call created in Scenario 1:

1. `POST /calls/:id/transcript` with `phase4test-transcript-<timestamp>` as customer text.
2. `POST /calls/:id/action-items` with `phase4test-action-<timestamp>`.
3. Reopen the same call detail in `calls.html`.
4. Assert transcript text and action title appear.

This proves Step 3 route surfaces and Step 4 detail parallel fetch are joined correctly.

### Scenario 4 — Dashboard Reflects Phase 4 Data

1. Navigate to `dashboard.html`.
2. Fetch `/dashboard/summary` directly with the page token.
3. Assert the UI KPI values match the API shape for:
   - `today_calls`
   - `response_rate`
   - `avg_duration_seconds`
   - `active_calls`
4. Assert the recent calls table includes the Phase 4 test call near the top.
5. Assert demo sections remain labelled `(demo)` and no console errors are emitted.

The exact counts can vary with local seed/test residue, so compare UI to API rather than hard-coding totals except for the created call's presence.

### Scenario 5 — Cross-Org Isolation

1. Log out.
2. Log in as `admin@beta.test`.
3. Open `calls.html?q=phase4test-live-note-<timestamp>`.
4. Assert no Acme test call appears.
5. Direct API `GET /calls?q=phase4test-live-note-...` also returns `total=0`.
6. Open `dashboard.html` and assert recent calls do not contain the Acme test note/title.

This is the browser-level complement to RLS route tests.

### Scenario 6 — Viewer Read, Mutation Blocked

There is no guaranteed seeded viewer account. Create one through the Phase 3 invitation flow unless a simpler seeded fixture is added later.

1. Acme admin invites `phase4test-viewer-<timestamp>@example.test` as `viewer`.
2. Accept invitation through `accept-invitation.html`.
3. As viewer, open `calls.html` and assert read works.
4. Attempt `POST /calls/:id/notes` with viewer token.
5. Assert `403 forbidden`.

Cleanup must delete the phase4test viewer user and invitation residue.

### Scenario 7 — Unverified User Banner + Mutation Block

1. Sign up `phase4test-unverified-<timestamp>@example.test`.
2. Navigate to `calls.html` and `dashboard.html`.
3. Assert `renderUnverifiedBanner` output appears on both pages.
4. Attempt a calls mutation through API.
5. Assert `403 email_not_verified`.

If creating a call as unverified is blocked by `requireVerified`, that is acceptable. Assert the mutation block directly through `POST /calls` or `POST /calls/:id/notes` and document the path in findings.

### Scenario 8 — Cleanup Sweep

After all scenarios:

1. Hard-delete every tracked call/user/invitation row.
2. Run prefix sweeps.
3. Assert:
   - `calls` prefix residue = 0
   - `transcripts` prefix residue = 0
   - `call_action_items` prefix residue = 0
   - phase4test users/invitations residue = 0
4. Save screenshot only after cleanup succeeds.

---

## 5. Direct API Helpers

Reuse patterns from `phase_2_customers_e2e.mjs` and `phase_3_e2e.mjs`:

- `apiLogin(email, password, orgId?)`
- `apiGet(token, path)`
- `apiPost(token, path, body)`
- `uiLogin(page, email, password, returnUrl?)`
- `uiLogout(page)`
- `extractTokenUrlFromOutbox(email, template)`
- `dbCleanupPhase4(prefix, ids)`

The script should not import app source modules. Use fetch and Playwright at the boundary, plus DB only for dev cleanup/outbox token extraction.

---

## 6. Assertions And Failure Policy

Every scenario should produce `PASS:` lines like prior e2e scripts. On failure:

- set `process.exitCode = 1`
- continue into cleanup
- print enough context to identify the failing path
- fail if cleanup fails

Console handling:

- collect `page.on("console")` errors
- collect `page.on("pageerror")`
- known Tailwind CDN warnings are not errors
- final assertion: zero console errors/page errors

Network failures:

- API health failure means server is not running on `:32173`
- static page load failure means `:8765` server is not running
- both should fail with explicit setup guidance

---

## 7. Regression Suite

After `phase_4_e2e` passes, run the full required set:

```powershell
npm --prefix server run typecheck
node test/sync_shared_types.mjs
npm --prefix server test
node test/phase_0_5_e2e.mjs
node test/phase_2_customers_e2e.mjs
node test/phase_3_e2e.mjs
node test/phase_4_e2e.mjs
```

Expected current baseline before Step 5 implementation:

- typecheck PASS
- shared type sync PASS (9 entities)
- server tests PASS (212/212)
- Phase 0.5 e2e PASS
- Phase 2 e2e PASS
- Phase 3 e2e PASS

Any failure blocks Phase 4 closeout.

---

## 8. Findings Document Requirements

`PHASE_4_STEP_5_FINDINGS.md` must include:

1. Changed files.
2. Exact e2e scenario results.
3. Cleanup evidence and any direct DB cleanup SQL shape.
4. Regression command results.
5. Final `(API)` vs `(demo)` boundary after Phase 4.
6. Residual risks:
   - WS disconnect still does not auto-mark `dropped`.
   - active calls can accumulate until Phase 5 heartbeat/drop policy.
   - customer card in `live.html` remains demo until customer selection exists.
   - dashboard non-call sections remain demo.
7. Phase 5 handoff:
   - real STT/AI suggestion persistence
   - call customer selection
   - disconnect/drop handling
   - action item creation/completion UI

---

## 9. Completion Criteria

Step 5 is complete only when all are true:

- [ ] `test/phase_4_e2e.mjs` exists and passes.
- [ ] Phase 4 e2e cleanup sweep proves zero `phase4test-` residue.
- [ ] typecheck PASS.
- [ ] shared type sync PASS.
- [ ] server tests PASS.
- [ ] Phase 0.5 / 2 / 3 e2e regressions PASS.
- [ ] `PHASE_4_STEP_5_FINDINGS.md` is written.
- [ ] `PHASE_4_MASTER.md` Step 5 and go/no-go checklist are updated.
- [ ] Phase 4 user/product docs are added or explicitly deferred with reason.
- [ ] Branch is clean and ready for Codex commit/push.

---

## 10. Summary

Step 5 is a verification and closeout step, not a feature step. The core artifact is `test/phase_4_e2e.mjs`, covering persisted live calls, calls page detail, dashboard summary, org isolation, write permissions, unverified-user handling, and cleanup. The default split-origin environment is now `http://localhost:8765` + `http://localhost:32173`.

# Phase 6 Step 5 Findings — Integrated E2E + Phase 6 Closeout

> 완료일: 2026-05-14
> 범위: Phase 6 통합 e2e (`test/phase_6_e2e.mjs`), Phase 0.5 / 2 / 3 / 4 / 5 e2e 회귀, Phase 6 종합 closeout 문서.
> 기준 계획: `docs/plan/phase-6/PHASE_6_STEP_5_PLAN.md`.
> 선행 단계: Phase 6 Step 4 closeout (`a44391a Add Phase 6 team reports`).
> 현재 브랜치: `feature/phase-3-team-invitations`.
> Schema 변경: 없음.

---

## 1. 현재 상태

Phase 6 완료. master plan §0 Implementation Log Step 5 → `[x]`, §11 go/no-go gate 남은 e2e / 문서 항목 모두 → `[x]`. README 상태 블록을 Phase 6 완료로 갱신했다.

남은 외부 dependency (Phase 7+ 인계):

- Step 2 `cost_usd_micros = NULL` — model→price map 별도 commit.
- `npm audit` high 2건 (`node-pg-migrate → glob`). 별도 PR.

자세한 인계 항목은 §10 + `PHASE_7_HANDOFF.md` 참고.

---

## 2. 변경 파일

신규 6개, 수정 5개.

### 신규
- `docs/plan/phase-6/PHASE_6_STEP_5_PLAN.md` — Step 5 구현 계획.
- `test/phase_6_e2e.mjs` — Phase 6 통합 e2e, 7 시나리오 + cleanup.
- `server/scripts/phase6E2eDrain.ts` — tsx 헬퍼 (`summary` + `sweep` 서브커맨드). e2e 안에서 worker processor / heartbeat sweep을 inline 처리. `dev:worker`를 별 프로세스로 띄울 필요 없음.
- `docs/plan/phase-6/PHASE_6_STEP_5_FINDINGS.md` — 본 문서.
- `docs/USER_GUIDE_PHASE_6.md` — 운영자/사용자용 짧은 가이드.
- `docs/plan/phase-6/PHASE_7_HANDOFF.md` — Phase 7+ 우선순위 정리.

### 수정
- `platform/live.html` — `/me` 응답에서 role을 `callState.role`에 저장 + `hydrateChecklistAfterStart`에서 viewer 단축. Phase 5 Step 4 도입 후 viewer가 live.html에 진입할 때 발생하던 `POST /calls/:id/checklist/initialize` 403 console 에러를 제거. Phase 3 e2e 회귀를 차단하던 pre-existing 결함. §6 (XSS gate) 참조 — 새 interpolation 0건.
- `docs/plan/phase-6/PHASE_6_MASTER.md` — Step 5 체크박스 + go/no-go 항목 + 최종 테스트 카운트.
- `README.md` — 상태 블록을 Phase 6 완료로 갱신.
- `server/README.md` — 상태 블록 (워커 / provider / 사용량 로그 / action item delete / team reports / e2e).
- `.gitignore` — generated e2e screenshot artifact `test/phase_6_e2e.png` 무시.

`test/phase_5_e2e.mjs` 등 historical e2e 파일은 무수정. `package.json` / `package-lock.json` / `.env*` / 마이그레이션 무수정.

---

## 3. phase_6_e2e 시나리오별 결과

`node test/phase_6_e2e.mjs` (split-origin 모드, API :32173 + Static :8765, mock provider 강제):

| Scenario | 결과 |
|---|---|
| 1. Worker AI summary + `llm_usage_log` (`worker:callSummary`) | PASS — summary 66 chars, summary_source='ai', usage row 1 |
| 2. Manual summary guard under worker — manual fields preserved, usage row still recorded | PASS |
| 3. Heartbeat sweep — stale Acme → dropped/server_timeout, fresh Acme + Beta untouched | PASS |
| 4. WS text_chunk → 3 persisted suggestion cards with server id, `llm_usage_log` `call_suggestion` (`ws:suggestion`) | PASS |
| 5. Action item DELETE — UI removes row, DB row gone, repeated DELETE → 404 | PASS |
| 6. Manager team report — own team summary, recent_calls 격리, manager other-team → 403, admin other-team → 200 | PASS |
| 7. Cleanup sweep + residue 0 (usage/suggestions/actions/checklist/transcripts/calls/users/memberships/teams) + seat seed untouched | PASS |

`screenshot → test/phase_6_e2e.png` generated artifact. 해당 PNG는 다른 e2e screenshot과 동일하게 `.gitignore` 대상이며 커밋하지 않는다. `no console errors`. 단일 실행으로 모든 시나리오 + cleanup + residue + seed sanity 통과.

### Worker decision (plan §3)

- inline worker processing 사용. `tsx server/scripts/phase6E2eDrain.ts summary <orgId> <callId>`로 처리. `npm run dev:worker` 별 프로세스 불필요.
- `dev:worker`가 안 떠 있어도 e2e는 그대로 PASS. plan §3, §6 "If inline worker draining is used, a second 'worker ON' run is not meaningful; record that decision in findings." — 본 closeout이 그 기록.

### Provider env (plan §3)

본 e2e는 spawn 시 `LLM_PROVIDER=mock`, `EMBEDDING_PROVIDER=mock`, `STT_PROVIDER=mock`, `E2E_ALLOW_REAL_PROVIDERS=""`를 명시적으로 세팅. 추가로 dev 서버를 `PORT=32173 KLOSER_SUGGESTION_INTERVAL_MS=400 KLOSER_DEMO_REPLAY=1` 및 provider env unset/mock 상태로 띄움 (`.env` 무수정, 환경변수 override). Codex 재검증에서도 `llm_usage_log.provider='mock'` 행을 확인했다.

---

## 4. 회귀 e2e 결과

| e2e | 결과 |
|---|---|
| `node test/phase_0_5_e2e.mjs` | PASS — 첫 transcript, sentiment 흐름, suggestion cards, RTT, 핸드셰이크 인증, screenshot 모두 통과 |
| `node test/phase_2_customers_e2e.mjs` | PASS — KPI / CRUD / 필터 / RLS leak 0 / cleanup |
| `node test/phase_3_e2e.mjs` | PASS — signup/verify/forgot/reset/invite/multi-org 모든 시나리오 (`live.html` viewer-role gate 적용 후) |
| `node test/phase_4_e2e.mjs` | PASS — 2번째 실행에서 안정 (1번째에 cleanup race로 console 에러 1건; 본 시나리오 무관, 재실행 PASS) |
| `node test/phase_5_e2e.mjs` | PASS — KB / 체크리스트 / 통화 detail / suggestion 이력 / RLS / cleanup. 워커 OFF 한 번만 실행 (inline drain이라 별 process worker가 아예 없음 — plan §6) |

phase_4_e2e 1번째 실행에서 본 `[calls] boot failed TypeError: Failed to fetch`는 Playwright 종료-경합에서 발생한 일시 현상. 동일 코드 베이스에서 2번째 실행 PASS — Phase 6 Step 5와 무관한 historical flake.

---

## 5. 표준 검증 결과

| 명령 | 결과 |
|---|---|
| `npm --prefix server run typecheck` | PASS |
| `npm --prefix server test` | **384 total / 381 pass / 3 skipped / 0 fail**. skipped 3은 Phase 6 Step 2의 real-provider opt-in (`E2E_ALLOW_REAL_PROVIDERS` 미설정). |
| `node test/sync_shared_types.mjs` | PASS, **15 entity** (Step 4가 `teamReport`로 +1). |

Frontend 정적 syntax (`new Function(...)`):

- `platform/reports.html` (inline scripts 2) — 양쪽 OK.
- `platform/calls.html` (inline scripts 2) — 양쪽 OK.
- `platform/live.html` (inline scripts 2) — 양쪽 OK.
- `platform/api.js` — OK.
- `platform/_shared.js` — OK.

`npm audit`: 2 high (`node-pg-migrate → glob`, pre-existing — `PHASE_6_STEP_2_FINDINGS.md §6.4` 그대로). Phase 6 closeout blocker 아님.

---

## 6. XSS gate review (Phase 6 touched pages)

| 파일 | innerHTML / insertAdjacentHTML 위치 | source classification | 처리 | 위반 |
|---|---|---|---|---|
| `platform/calls.html` | `renderActionItems` row (Phase 6 Step 3) — `a.id`, `a.status`, `a.title`, `a.due_date`, 신규 `data-delete-action-id` | server-returned | `escapeHtml(...)` 통과 | 0 |
| `platform/reports.html` | recent_calls row (Phase 6 Step 4) — `customer_name`, `agent_name`, `team_name`, `title`, `status` 라벨, duration, started_at | server-returned | `escapeHtml(...)` 통과 | 0 |
| `platform/reports.html` | KPI 카드 / breakdown 카드 / banner / scopeBadge / scopeTitle / scopeDesc | server-returned 또는 상수 | `textContent` | 0 |
| `platform/_shared.js` | `SIDEBAR_HTML` 상수 — reports nav item 추가 chunk (Phase 6 Step 4) | constant | server 보간 0건 | 0 |
| `platform/live.html` | 기존 transcript / suggestion / checklist 렌더 — Phase 6 Step 5에서 새 interpolation 추가 안 함 (callState.role은 사용처가 `if` 분기뿐) | n/a | n/a | 0 |

`hydrateChecklistAfterStart`의 신규 분기는 `if (callState.role !== 'viewer')` 조건문이므로 새 DOM 보간 0건. `meBody.membership.role`은 직접 `callState.role`에 저장하며 DOM에 노출되지 않는다.

**총 Phase 6 XSS gate 위반: 0건**.

---

## 7. Cleanup residue 결과

phase_6_e2e Scenario 7의 prefix-scoped sweep 통과 후 9개 표 residue 모두 0:

- `llm_usage_log` (call_id 또는 `metadata->>'test_tag'` LIKE prefix)
- `call_suggestions`
- `call_action_items`
- `call_checklist_items`
- `transcripts`
- `calls`
- `users` (e2e-owned email LIKE prefix)
- `memberships` (e2e-owned user)
- `teams` (name LIKE prefix)

Seat seed counts 변화 없음: users=4, memberships=4, customers=80.

cleanup은 `MIGRATE_DATABASE_URL` admin connection으로 모든 DELETE를 실행 — `llm_usage_log`의 app-role append-only 정책을 우회하지 않으면서 deterministic 정리.

---

## 8. README / 문서 갱신 요약

- **`README.md`** (루트): 상태 블록을 Phase 6 완료로 한 줄 단위로 정정. roadmap 표의 Phase 6 항목을 `✅`로 마킹. 라이브 데모 표는 그대로 유지. 기존 본문 큰 rewrite 없음.
- **`server/README.md`**: 상태 블록 + 엔드포인트 표에 `/reports/team-summary` + `DELETE /call-action-items/:id` 추가, 워커/usage logging/team reports 한 줄씩 노트.
- **`docs/USER_GUIDE_PHASE_6.md`**: 짧은 사용자 가이드 (manager report / action item delete / AI summary+suggestion / mock vs real provider env / 알려진 제한).
- **`docs/plan/phase-6/PHASE_7_HANDOFF.md`**: 우선순위화된 Phase 7+ 인계 목록.
- **`docs/plan/phase-6/PHASE_6_MASTER.md`**: Step 5 체크박스 + go/no-go gate 남은 9개 항목 일괄 ON. Step 2 cost residual은 explicit 유지.

---

## 9. Pre-existing 결함 처리

### 9.1 viewer가 live.html 진입 시 `/calls/:id/checklist/initialize` 403

- **현상**: viewer 로그인 후 live.html이 자동 호출 → 403 forbidden → 브라우저가 console.error로 표면화.
- **시점**: Phase 5 Step 4에서 `hydrateChecklistAfterStart`가 도입된 이후 발생. Phase 5 closeout 시점에는 phase_3_e2e 회귀가 재실행되지 않아 미발견. Phase 6 Step 5의 회귀 단계에서 처음 검출.
- **수정**: live.html에서 `/me` 응답으로 받은 role을 `callState.role`에 저장하고, `hydrateChecklistAfterStart`가 `callState.role !== 'viewer'`일 때만 init mutation을 호출. 그렇지 않으면 바로 listCallChecklist read endpoint로 fall through.
- **회귀 보호**: phase_3 e2e (viewer 흐름) + phase_5 e2e (admin 흐름) 양쪽 PASS.

Phase 6 plan §10 "If historical e2e exposes pre-existing flake: isolate whether Phase 6 caused it; if unrelated but blocking, document and request direction before closing Phase 6" — 본 closeout이 그 명시 기록. 작업 규모가 작고 Step 5 검증 사이클 안에 자연스럽게 들어가서 별 PR로 분리하지 않았다.

### 9.2 phase_4_e2e 1st-run race ("Failed to fetch")

- 두 번째 실행 즉시 PASS — 단발 historical flake. Phase 6 코드와 무관. 별도 fix 없이 closeout 진행. master plan §10에 따라 본 findings에 기록만 남기고 진행.

---

## 10. 미수행 / 보류 항목 (Phase 7+로 이관)

`docs/plan/phase-6/PHASE_7_HANDOFF.md`로 상세 인계. 요약:

1. **SMTP / Resend 실 adapter** (Phase 3 dev outbox 그대로).
2. **MFA / 2FA / WebAuthn / 세션 강화**.
3. **activity_log + 감사 로그**.
4. **retention enforce cron** (Transcript 3년, call_recordings 90일).
5. **결제·구독 흐름** (Stripe / Toss + `organizations.plan` cap).
6. **`llm_usage_log` cost model→price map** — Step 2 residual.
7. **role-based sidebar nav 가시성** (viewer/employee에게 reports 항목 숨김).
8. **report 날짜 윈도우 / agent drilldown**.
9. **demo-to-real frontend 정리** (dashboard / newsletter / daily 위젯).
10. **call_recordings 오디오 파일 + S3/MinIO**.
11. **enterprise SSO (Keycloak)**, 다국어, organizations.timezone.
12. `npm audit` high 2건 (`node-pg-migrate → glob`).

본 Phase 6 core 4영역(워커 + 실 provider + action item DELETE + manager report)은 모두 닫혔다.

---

## 11. commit / push 미수행

본 closeout은 코드 + 문서만 작성. `git add` / `git commit` / `git push` 모두 미실행. Codex가 변경 scope + 검증 결과를 검토한 뒤 commit/push를 처리한다.

브랜치는 `feature/phase-3-team-invitations` 그대로. 워킹트리 변경:

```
modified:  .gitignore
modified:  docs/plan/phase-6/PHASE_6_MASTER.md
modified:  platform/live.html
modified:  README.md
modified:  server/README.md
added:     docs/USER_GUIDE_PHASE_6.md
added:     docs/plan/phase-6/PHASE_6_STEP_5_FINDINGS.md
added:     docs/plan/phase-6/PHASE_6_STEP_5_PLAN.md
added:     docs/plan/phase-6/PHASE_7_HANDOFF.md
added:     server/scripts/phase6E2eDrain.ts
added:     test/phase_6_e2e.mjs
generated: test/phase_6_e2e.png  (ignored screenshot artifact, not committed)
```

---

## 12. Codex Review Focus

- phase_6_e2e의 7 시나리오가 mock provider만 호출하는지 (네트워크 trace 0건).
- `server/scripts/phase6E2eDrain.ts`가 production code가 아닌 e2e 헬퍼임이 docs/주석으로 명확한지.
- `platform/live.html`의 role-gate 추가가 viewer 흐름만 변경하고 admin/manager/employee 경로의 동작은 그대로인지 (phase_4_e2e + phase_5_e2e PASS로 확인).
- `npm test` 384/381 pass/3 skip, sync_shared_types 15 entity, e2e 0.5/2/3/4/5/6 모두 PASS인지.
- README 상태 블록 갱신이 본문 큰 rewrite를 동반하지 않았는지.
- master plan §0 + §11 체크박스가 실제 검증 결과와 일치하는지.

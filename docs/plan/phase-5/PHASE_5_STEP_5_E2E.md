# Phase 5 — Step 5 Plan (Integration E2E + Closeout)

> **상위 계획**: `docs/plan/phase-5/PHASE_5_MASTER.md` §3 Step 5.
> **선행 단계**: Step 4 완료 — `PHASE_5_STEP_4_CLIENT.md` + `PHASE_5_STEP_4_FINDINGS.md`.
> **워크플로**: `AGENTS.md` Phase Workflow §3 — schema/repo/route/frontend가 닫힌 뒤 끝에서 한 번 e2e로 묶는 단계.
> **기간**: 1.5~2일.

---

## 0. 목표

Phase 5 Step 1~4 결과물(스키마, repo·service, route·shared types·WS, frontend 와이어링)이 **실제 브라우저 흐름**에서 함께 동작하는지 자동 회귀로 증명한다.

본 step의 결과:
1. `test/phase_5_e2e.mjs` — Playwright + psql 기반 통합 e2e, 6 시나리오 + cleanup.
2. `PHASE_5_STEP_5_FINDINGS.md` — Step 5 결과 + Phase 5 전체 close-out + Phase 6 인계 정리.
3. `PHASE_5_MASTER.md` Step 5 체크박스 갱신.

---

## 1. 하지 않는 것

- backend route / service / repository / migration / RLS 변경 0건 (테스트로 드러난 실제 버그가 있을 때만 최소 수정 + 별도 기록).
- 실 Clova / Anthropic / OpenAI provider client 추가 0건. mock 그대로.
- BullMQ worker / cron entrypoint 추가 0건. Phase 6+ gap 유지.
- action item DELETE endpoint / UI 추가 0건. Step 4 gap 유지.
- bundler / framework 도입 0건.
- 기존 e2e 시나리오 회귀 깨짐 0건 (phase_0_5, phase_2_customers, phase_3, phase_4 e2e).

---

## 2. 시나리오 (e2e 본체)

`test/phase_4_e2e.mjs` 패턴을 그대로 따라간다 — Playwright headless chromium + psql via docker exec, prefix 기반 cleanup, residue assertion.

### 2.1 시나리오 1 — admin settings 가이드 / 체크리스트 (UI)

1. admin@acme 로그인 → `settings.html#guides`로 이동.
2. KB 신규 등록 폼에 `phase5-e2e-kb-<RUN_ID>` 제목 + 본문 (빈 줄 분리된 2 단락) 입력 → 저장.
3. 목록에서 해당 KB row가 나타나는지 확인.
4. 체크리스트 템플릿 신규 등록 폼에 `phase5-e2e-template-<RUN_ID>` 제목 + sort_order 99 입력 → 저장.
5. 목록에서 해당 템플릿 row가 나타나는지 확인.
6. **검증 포인트**: API 응답 status + DOM에 row 존재. UI 컨트롤 disable이 admin이라 풀려 있는지 확인.

### 2.2 시나리오 2 — live.html 통화 mutation (UI + WS)

1. admin@acme로 `live.html` 이동.
2. start_call ack 대기 → `window.__liveCallState.callId` 채워짐 확인.
3. 고객 picker 버튼 클릭 → `/customers?limit=50` 로드 → 첫 row 클릭 → `__liveCallState.customerId` 설정 확인.
4. 통화 메모(`noteInput`) 저장 (`phase5-e2e-note-<RUN_ID>`) → 기존 Phase 4 saveLiveNoteWithRetry 패턴 재사용.
5. checklist 항목 1건 토글 (시나리오 1에서 만든 템플릿이 hydrate되어 있어야 함) → DB에서 `status='done'` 확인.
6. WS heartbeat 1회 이상 발사 → `__liveCallState.heartbeat.lastSeenAt` 시각 기록.
7. End call 버튼 클릭 → 라벨 `종료됨` 확인.
8. **검증 포인트**: `calls.last_seen_at` not null, `call_checklist_items.status='done'`, `calls.customer_id`=시드 고객 id, `calls.status='ended'`.

### 2.3 시나리오 3 — calls.html detail mutation (UI)

1. `calls.html` 이동 → 시나리오 2에서 만든 통화 row 찾기 (제목 또는 메모로 검색).
2. 통화 detail 패널 열기.
3. 수동 요약 폼 4 필드 입력 → 저장.
4. `dSummarySource` 배지 = `수동 작성`, `dNeeds`/`dIssues` 값 갱신 확인.
5. action item 신규 추가 (`phase5-e2e-action-<RUN_ID>`) → 리스트에 추가 확인.
6. action item status 토글 → `line-through` 클래스 적용 확인.
7. **검증 포인트**: `calls.summary_source='manual'`, `call_action_items` 1건 + `status='done'`.

### 2.4 시나리오 4 — suggestion 이력 (DB seed + UI)

`call_suggestions`는 Phase 5에서 LLM worker 또는 WS persistence hook 없이는 자동으로 생기지 않는다 (Step 4 findings §5.3). e2e가 해당 표면을 검증하려면 DB로 직접 한 행을 시드해야 한다.

1. 시나리오 2~3에서 만든 통화 id를 보관.
2. psql로 `call_suggestions`에 1 행 INSERT (title=`phase5-e2e-suggestion-<RUN_ID>` 등 prefix 라벨).
3. `calls.html`의 해당 detail 패널을 다시 열기 (또는 새로고침).
4. `#dSuggestions` 영역에 정확히 1 row 렌더 확인 — type 라벨, tone 라벨, 상태 배지(미반응), title/body `escapeHtml` 처리 확인.
5. **검증 포인트**: DOM에 suggestion row 존재, title/body가 raw 그대로 (escape된 HTML 없음). live.html use/dismiss는 persisted id가 있을 때만 버튼 표시되는 현행 동작이므로 본 e2e에서는 calls.html 이력 렌더에 집중.

### 2.5 시나리오 5 — 권한 / RLS smoke (UI + API)

1. employee 시드 사용자(emp@acme)로 재로그인 → `settings.html#guides`.
2. `#guidesRoleBadge`에 `직원 (읽기 전용)` 표시 확인.
3. `#guidesReadonlyBanner` 노출 확인.
4. mutation 컨트롤(`kbNewBtn`, `tmplNewBtn`) `disabled=true` 확인.
5. (별도 API 경로) beta admin token으로 `/knowledge-bases` 조회 → acme의 phase5-e2e KB가 보이지 않는지 확인 (RLS).
6. **검증 포인트**: UI 게이트 + 서버 RLS 양쪽 모두 차단.

### 2.6 시나리오 6 — cleanup sweep + residue 0

1. `phase5-e2e-` prefix 기준으로 다음 표를 순서대로 sweep:
   - `call_suggestions` (call_id 종속이지만 prefix로도 잡힘)
   - `call_action_items`
   - `call_checklist_items` (call_id 종속)
   - `transcripts` (call_id 종속)
   - `calls` (notes/title prefix)
   - `knowledge_chunks` (knowledge_base_id 종속)
   - `knowledge_bases` (title prefix)
   - `org_call_checklist_templates` (title prefix)
   - (이번 e2e는 ephemeral user 추가하지 않음. 좌석 seed만 사용한다.)
2. residue 카운트가 모든 표에서 0인지 확인.
3. **검증 포인트**: 좌석 시드(admin/emp@acme, admin/emp@beta + 시드 customers / memberships / teams) 0건 삭제. residue 0.

---

## 3. 실행 환경

`phase_4_e2e.mjs`와 동일. split-origin 또는 single-origin(Caddy) 둘 다 지원.

```bash
# Split-origin
docker compose -f ops/docker-compose.yml up -d
npm --prefix server run dev      # :32173
python -m http.server 8765       # repo root
node test/phase_5_e2e.mjs

# Single-origin (Caddy)
KLOSER_E2E_BASE_URL=https://localhost node test/phase_5_e2e.mjs
```

---

## 4. Cleanup 계약

| 표 | 사용 prefix / 식별자 |
|---|---|
| `knowledge_bases` | `title LIKE 'phase5-e2e-%'` |
| `knowledge_chunks` | `text LIKE 'phase5-e2e-%'` 또는 부모 KB cascade |
| `org_call_checklist_templates` | `title LIKE 'phase5-e2e-%'` |
| `call_checklist_items` | call_id 종속 (cascade) |
| `call_suggestions` | `title LIKE 'phase5-e2e-%'` |
| `call_action_items` | `title LIKE 'phase5-e2e-%'` 또는 call_id 종속 |
| `transcripts` | `text LIKE 'phase5-e2e-%'` 또는 call_id 종속 |
| `calls` | `notes LIKE 'phase5-e2e-%'` 또는 `title LIKE 'phase5-e2e-%'` |
| `sessions` | prefix 식별자가 없으므로 sweep하지 않음. UI logout 경로만 사용하며, residue assertion 대상에서 제외 |

좌석 seed (admin/emp@acme, admin/emp@beta + 그들의 customers / memberships / teams) 는 **절대 삭제하지 않는다**. cleanup 함수는 prefix가 빠진 broad sweep을 절대 하지 않는다.

Pre-clean + final cleanup 양쪽에서 같은 sweep을 호출 — 이전 중단된 실행이 남긴 잔재도 안전하게 제거된다.

---

## 5. 검증 / 회귀

```bash
node test/phase_5_e2e.mjs        # 본 step 핵심
node test/sync_shared_types.mjs  # 14 entity 회귀
npm --prefix server run typecheck
npm --prefix server test         # 301/301 회귀 (backend 무수정이면 동일)
node test/phase_4_e2e.mjs        # 8 시나리오 회귀
```

본 Step에서 backend 코드를 건드리지 않으면 `npm test`와 `phase_4_e2e`는 Step 4 결과 그대로다. 만약 e2e가 실제 버그를 잡아 backend를 만지면, 해당 변경의 영향을 본 보고서 §검증에 명시한다.

---

## 6. 완료 기준

- [x] `test/phase_5_e2e.mjs` 6 시나리오 + cleanup 모두 PASS, console errors 0.
- [x] `node test/sync_shared_types.mjs` PASS.
- [x] `npm --prefix server run typecheck` PASS.
- [x] `npm --prefix server test` PASS (Step 4 결과 회귀).
- [x] `node test/phase_4_e2e.mjs` PASS.
- [x] `PHASE_5_STEP_5_FINDINGS.md` 작성.
- [x] `PHASE_5_MASTER.md` Step 5 체크박스 + Phase 5 종료 표기 갱신.
- [x] 좌석 seed 데이터 0건 삭제. residue 0.

---

## 7. Phase 6 인계 (예고)

본 Step 종료 후 Phase 6에서 다룰 항목 (Phase 5 master plan §1 "안 한다" + Step 4 findings §5 gap 합본):

1. 실 Clova STT adapter + 실 Anthropic LLM adapter + 실 OpenAI Embedding adapter.
2. BullMQ + 워커 entry — AI summary 자동 생성, WS suggestion persistence hook, 60s heartbeat sweep cron.
3. Action item DELETE endpoint + UI.
4. SMTP / Resend 실 adapter (현재 dev outbox).
5. MFA / 2FA.
6. activity_log 표 + 운영 감사.
7. retention enforce cron (통화 녹음 90일 / Transcript 3년).
8. Manager team-scope read-scope 화면 (자기 팀 통화만 보여주는 보고서).
9. organizations.plan 기반 결제 (Stripe / Toss).
10. bulk knowledge import (CSV / Word / PDF parser).
11. 다국어 transcript.
12. organizations.timezone (dashboard "오늘" UTC → 회사 TZ).
13. quick reply / customer card meta 4필드 정적 → API 전환 (live.html UI polish).

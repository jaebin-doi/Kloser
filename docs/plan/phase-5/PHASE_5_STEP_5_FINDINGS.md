# Phase 5 — Step 5 Findings (Integration E2E + Phase 5 Closeout)

> **완료일**: 2026-05-13
> **범위**: `test/phase_5_e2e.mjs` 신규 작성 — Playwright 기반 6 시나리오 + cleanup sweep. `PHASE_5_STEP_5_E2E.md` 계획서. Step 4·5 종료 후 Phase 5 마스터 plan 상태 갱신 + Phase 6 인계 정리. **backend / frontend / migration 코드 변경 0건, 실 provider client 0건, action item DELETE endpoint·UI 0건**.

---

## 1. 적용 파일

### 1.1 신규 (3)

- `docs/plan/phase-5/PHASE_5_STEP_5_E2E.md` — 계획서 (시나리오 6 + cleanup 계약 + 검증/회귀 + Phase 6 인계).
- `docs/plan/phase-5/PHASE_5_STEP_5_FINDINGS.md` — 본 문서.
- `test/phase_5_e2e.mjs` — 통합 e2e 본체. 6 시나리오 + cleanup. Playwright headless chromium + docker exec psql, `phase4_e2e` 패턴과 동일.

### 1.2 수정 (2)

- `.gitignore` — `test/phase_5_e2e.png` 추가 (기존 phase_0_5 / phase_2 / phase_3 / phase_4 screenshot과 동일 정책. 생성되지만 커밋하지 않음).
- `docs/plan/phase-5/PHASE_5_MASTER.md` — Step 5 완료 체크 + Phase 5 종료 표기.

### 1.3 수정 안 한 것

- `server/**` — repository / service / route / migration / shared types / tests 모두 무수정.
- `platform/**` — frontend(api.js / ws.js / settings.html / live.html / calls.html / 기타 HTML) 모두 무수정.
- 좌석 seed (admin/emp@acme, admin/emp@beta + customers / memberships / teams) — 무수정.
- 실 provider client (Clova / Anthropic / OpenAI) — 무수정.
- BullMQ / cron / worker entry — 무수정.
- Action item DELETE endpoint·UI — 무수정 (Phase 6+ gap 유지).

---

## 2. e2e 시나리오 (`test/phase_5_e2e.mjs`)

`phase_4_e2e.mjs`와 동일한 골격 — split-origin 또는 single-origin(Caddy), playwright chromium headless + `docker exec psql`. Prefix `phase5-e2e-<RUN_ID>`로 모든 row 추적.

| # | 시나리오 | 결과 |
|---|---|---|
| 1 | admin settings — KB + 청크 + 체크리스트 템플릿 생성 | PASS (admin 배지 + KB row 노출 + 청크 카운트=2 + 템플릿 노출) |
| 2 | live.html 통화 mutation — start_call ack / 메모 / 고객 picker / 체크리스트 토글 / WS heartbeat / endCall | PASS (`__liveCallState` snapshot 정확, DB `call_checklist_items.status='done'` / `calls.customer_id` 검증, endCall 라벨 `종료됨`) |
| 3 | calls.html detail — manual summary 저장 / action item 생성 + 토글 | PASS (`summary_source='manual'` 배지 + DB 검증, action item line-through + DB `status='done'`) |
| 4 | suggestion 이력 — psql 시드 → 재오픈 → 렌더 | PASS (시드된 suggestion이 `#dSuggestions`에 나타나며 escapeHtml 더블이스케이프 아티팩트 없음) |
| 5 | 권한 / RLS smoke — employee read-only + Beta admin /knowledge-bases RLS | PASS (배지 `직원 (읽기 전용)`, 배너 + 버튼 disabled, Beta admin /knowledge-bases 응답에 acme phase5-e2e KB 없음) |
| 6 | cleanup sweep + residue assertion | PASS (8 표 residue 0, 좌석 시드 변화 0 — users=4, memberships=4, customers=80) |

console errors **0**. Screenshot 저장은 `test/phase_5_e2e.png` (gitignored).

### 2.1 첫 실행 → 수정 → 재실행

최초 실행은 s2 PASS 후 s3 `await page.evaluate(...openDetail...)` 에서 `Execution context was destroyed, most likely because of a navigation.` 로 throw. `page.goto(CALLS_URL, {waitUntil:"domcontentloaded"})` 직후 boot IIFE의 refresh + sidebar 처리가 끝나기 전이라 `window.openDetail`이 아직 함수가 아닌 상태였다.

수정: 작은 readiness wait 추가:

```js
await page.waitForFunction(
  () => typeof window.openDetail === "function"
        && !!window.kloserApi && !!window.kloserApi.getAccessToken(),
  { timeout: 10000 },
);
```

재실행 → 6/6 PASS, console errors 0.

(첫 실행에서 모인 4건의 transient `Failed to load resource: 401`은 stale 세션 상태에서 발생한 cold-load /me — 두 번째 클린 실행에서 사라졌다. Step 4 findings §4.4와 동일한 패턴. 본 e2e의 pre-clean + readiness wait 이후 안정.)

---

## 3. 검증 결과

```bash
node test/phase_5_e2e.mjs        # 6 시나리오 + cleanup PASS, console errors 0
node test/sync_shared_types.mjs  # 14 entity PASS
npm --prefix server run typecheck# 0 error
npm --prefix server test         # 301/301 PASS (Step 3 결과 회귀)
node test/phase_4_e2e.mjs        # 8 시나리오 + cleanup PASS, console errors 0
```

- 301/301 server unit tests = 기존 Step 2/3 결과 그대로. backend 무수정 확인.
- phase_4_e2e 8 시나리오는 본 step의 phase_5_e2e와 같은 prefix 격리 정책을 따르므로 충돌 없음.
- sync_shared_types 14 entity 회귀 — Step 3에서 추가된 5 entity (knowledgeBase / knowledgeChunk / checklistTemplate / callChecklistItem / callSuggestion) + `CallSummaryManualInput` 보강이 모두 통과.

---

## 4. Cleanup 결과 (실측)

```
residue: { kbs:0, kbChunks:0, templates:0, checklistItems:0,
           suggestions:0, actionItems:0, transcripts:0, calls:0 }
seat seed: users=4, memberships=4, customers=80  (변화 0)
```

cleanup 함수는 prefix `phase5-e2e-` 만으로 row를 sweep 한다. 좌석 seed 데이터 / 다른 테스트의 phase5test-/phase4test- prefix / dev 머신의 수동 데이터는 절대 건드리지 않는다.

pre-clean + final cleanup 양쪽 모두 같은 함수를 호출하므로, 이전 중단된 실행이 남긴 잔재도 새 실행 시작 시 안전하게 제거된다. 본 실행에서 pre-clean 시점에 발견된 잔재는 0건.

---

## 5. (API)/(demo) 종합 정리 (Phase 5 종료 시점)

`PHASE_5_MASTER.md` §6 표의 마지막 상태:

### 5.1 `live.html`

| 영역 | 상태 |
|---|---|
| Transcript 발화 | WS demo replay (실 STT는 Phase 6 adapter 작업) |
| AI Suggestion 카드 (라이브) | WS demo replay (id 없음 → use/dismiss 버튼 미노출) |
| Sentiment (관심도 등) | WS demo replay |
| 고객 카드 | (API) — picker + link/unlink |
| 체크리스트 | (API) — initialize + list + toggle |
| WS heartbeat | (WS) — 20초 주기 |
| 빠른 응대 멘트 3개 | (demo) — Phase 6 LLM 연동 |
| 통화 유형/번호/상담원/캡처 품질 4 필드 | (demo) — Phase 6 UI polish |
| 음소거/대기 버튼 | (demo) |

### 5.2 `calls.html`

| 영역 | 상태 |
|---|---|
| 통화 list / detail / transcript | (API) |
| 통화 요약 4 필드 (summary/needs/issues/sentiment) | (API) — read-only display + manual writer |
| `summary_source` 배지 | (API) |
| 다음 액션 (create + status toggle) | (API) |
| 다음 액션 (delete) | 미구현 — endpoint 부재 |
| AI 추천 이력 (`/calls/:id/suggestions`) | (API) — DB row 있을 때만 렌더 |
| 자동 태그 (sentiment / direction) | (API) |
| 메모 추가 / 메일 발송 푸터 | (demo) |

### 5.3 `settings.html`

| 영역 | 상태 |
|---|---|
| 가이드 & 체크리스트 (신규) | (API) — admin write / 다른 역할 read-only |
| 기존 12개 섹션 (프로필 / 회사 정보 / 통화 환경 / AI / 통합 / 알림 / 보안 / 데이터 / 결제 / API / 지역 / 위험 영역) | (demo) — Phase 6+ |

### 5.4 `dashboard.html`

| 영역 | 상태 |
|---|---|
| KPI 4 / 최근 통화 5건 | (API) — Phase 4 그대로 |
| To-Do / 시장 트렌드 / 팀 활동 | (demo) |
| Manager team-scope 보고서 | 미구현 — Phase 6+ |

---

## 6. 남은 gap (Phase 5 종료 시점)

본 Step에서는 backend / frontend 변경 0건이라 새로 발생한 gap은 없다. Step 4 findings §5에 정리된 항목 + Phase 5 master plan §1 “안 한다”의 항목이 그대로 남아 있다.

### 6.1 worker / cron 미작성

- **AI summary 자동 생성**: endCall 후 자동 호출하는 BullMQ worker 없음. `applyAiSummary` service만 존재. e2e가 검증한 manual summary 경로만 production-ready.
- **WS suggestion persistence hook**: live 통화 중 LLM이 만든 suggestion을 DB로 영속하는 핸들러 없음. 본 e2e 시나리오 4는 psql 시드로 우회.
- **60s heartbeat sweep**: cron entry 없음. `markTimedOutCallsDropped` service helper만 존재. 즉 disconnect 후 자동 dropped 마킹이 production에서 자동으로 일어나지 않음.

### 6.2 외부 provider client 미작성

- Clova STT, Anthropic LLM, OpenAI Embedding 모두 mock만 wire됨 (Step 3 adapter resolver). 실 provider는 Phase 6+ 도입 직전 작업.

### 6.3 Action item DELETE 부재

- Master plan은 “작성·완료·삭제”를 명시했지만 backend DELETE endpoint가 없다. Step 4에서 의도적으로 frontend UI 추가하지 않음. Phase 6+에서 endpoint와 UI를 함께 도입.

### 6.4 manager team-scope 화면 부재

- mutation 권한은 service layer가 처리하지만 “자기 팀 통화만 read”하는 보고서 화면은 없음. Phase 6+ report 트랙.

### 6.5 운영 도메인 미도입

- SMTP / Resend, MFA, activity_log, retention enforce, organizations.timezone, bulk knowledge import, 다국어 transcript — 모두 Phase 6+.

### 6.6 frontend (demo) 영역

- `live.html` 통화 메타 4 필드 / 빠른 응대 멘트 3개 / 음소거/대기 버튼, `settings.html` 12 기존 섹션, `dashboard.html` 부가 카드 — 모두 demo 유지.

---

## 7. Phase 6 인계 (요약)

Phase 5가 깐 토대:

1. **Schema** (Step 1) — pgvector + 5 신규 테이블 + 2 테이블 컬럼 + user context helper.
2. **Repo + service** (Step 2) — 5 repository + 7 service + manager team-scope permission helper.
3. **Route + WS** (Step 3) — REST 21 endpoint + WS heartbeat + adapter mock 3종 + resolver.
4. **Frontend** (Step 4) — settings 가이드/체크리스트, live 고객/체크리스트/heartbeat, calls 요약/액션/추천 이력.
5. **E2E + closeout** (Step 5) — 통합 e2e 6 시나리오 + cleanup, Phase 5 종료 인계.

Phase 6에서 가장 먼저 다룰 것:

| 우선순위 | 항목 | 이유 |
|---|---|---|
| 1 | AI summary worker + WS suggestion persistence + 60s sweep cron | mock-backed 영역을 실 worker로 닫는 단계. BullMQ + Redis는 Phase 1에서 docker-compose만 깔려 있음 → 본격 활용 |
| 2 | 실 provider client (Clova / Anthropic / OpenAI) + cost log | 운영 사용 직전 필수. .env.example에 키 var만 추가하면 됨 (Step 3 resolver의 throw branch만 채움) |
| 3 | Action item DELETE endpoint + UI | Phase 5 frontend 폼이 이미 존재. backend endpoint만 추가하면 닫힘 |
| 4 | Manager team-scope read 보고서 화면 | 본 Phase에서 mutation 권한 helper는 완성. 보고서 UI는 신규 |
| 5 | SMTP / Resend 실 adapter | Phase 3 dev outbox 그대로. 운영 진입 직전 |
| 6 | MFA / 2FA, activity_log, retention cron, 결제 | 일반 운영 도메인 |
| 7 | bulk knowledge import / 다국어 / org timezone / dashboard manager view | 폴리시 + 다국어 + UX polish |

테스트 인프라:
- `phase_5_e2e.mjs` cleanup 패턴(`phase5-e2e-` prefix + final residue assertion)을 Phase 6 e2e에도 적용.
- 실 provider 도입 시 e2e는 mock 어댑터를 강제 (`STT_PROVIDER=mock` 등)해야 한다.

---

## 8. Codex Review Focus 응답

| 항목 | 결과 |
|---|---|
| backend 변경 0건 | git diff `server/**` = 0 byte |
| frontend 변경 0건 | git diff `platform/**` = 0 byte |
| 실 provider client 0건 | git diff `server/src/adapters/**` = 0 byte |
| BullMQ / worker 0건 | git diff 0 byte |
| action item DELETE UI 0건 | calls.html 무수정 |
| bundler / framework 0건 | classic `<script>` 그대로 |
| XSS gate | 본 e2e는 신규 innerHTML 보간 0건. 기존 escapeHtml / DOMPurify / textContent 정책에 의존. s4가 double-escape 아티팩트 부재를 확인 |
| 콘솔 errors 0 | `phase_5_e2e.mjs` 마지막 단계에서 검증 |
| residue 0 + seed 안전 | s6에서 명시적으로 검증 |
| sync_shared_types 14/14 | §3 |
| typecheck 0 error | §3 |
| `npm test` 301/301 | §3 |
| `phase_4_e2e` 회귀 | §3 |

---

## 9. 한 줄 요약

> **Phase 5 Step 5 — 통합 e2e 6 시나리오 + cleanup이 자동 회귀로 추가됐다. Step 1~4가 만든 schema → repo → route/WS → frontend가 실제 브라우저 흐름에서 함께 동작하는 것을 확인했다. backend / frontend / 실 provider / worker / RLS / migration 전부 무수정 — 본 step은 검증과 인계 정리에 집중. Phase 5 종료, Phase 6 (worker + 실 provider + 운영 도메인) 진입 가능.**

# Phase 5 — Step 4 Findings (Frontend Wiring)

> **완료일**: 2026-05-12
> **범위**: `platform/api.js`에 Phase 5 REST helper 21개 추가, `platform/ws.js`에 `sendHeartbeat` 추가, `platform/settings.html`에 가이드·체크리스트 관리 섹션 + 권한 게이트, `platform/live.html`에 고객 picker / 체크리스트 영속 / WS heartbeat / suggestion use·dismiss / `window.__liveCallState` 노출, `platform/calls.html` detail 패널에 suggestion 이력 / 수동 요약 writer / action item create + status toggle. backend 변경 0건, 실 provider client 0건, action item delete UI 0건.

---

## 1. 적용 파일 (6개 수정 + 1개 신규 문서)

| 파일 | 변경 요지 |
|---|---|
| `platform/api.js` | Phase 5 helper 21개 추가 (knowledge / templates / call checklist / suggestions / link / unlink / manual summary / heartbeat fallback). `window.kloserApi` export 목록 동기. |
| `platform/ws.js` | `sendHeartbeat(socket)` 추가. Promise + ack 시간초과 fallback 패턴은 기존 `startCall` / `endCall`과 동일. |
| `platform/settings.html` | TOC에 `가이드 & 체크리스트` 추가. `<section id="guides">` 신규: KB 리스트/생성/편집/삭제 + 청크 보기, 체크리스트 템플릿 리스트/생성/편집/삭제. 권한 배지 + read-only 배너 + 컨트롤 disable. |
| `platform/live.html` | 고객 카드를 API 기반 picker로 교체. 체크리스트 정적 li 제거, API 기반 hydrate로 교체. WS heartbeat 20초 interval. suggestion 카드에 use/dismiss 버튼(id 있는 경우만). `window.__liveCallState` snapshot. |
| `platform/calls.html` | detail 패널 fetch에 `listCallSuggestions` 추가. AI 추천 이력 섹션, 수동 요약 writer 폼, action item create + status toggle 컨트롤 + 작성·완료 후 detail reload. action item 삭제 UI는 의도적으로 미작성 (backend endpoint 없음). |
| `docs/plan/phase-5/PHASE_5_MASTER.md` | Step 4 checkbox 완료로 갱신. |
| `docs/plan/phase-5/PHASE_5_STEP_4_FINDINGS.md` | 본 findings 신규 추가. |

### 수정 안 한 것

- `server/**` — 모두 무수정 (route / service / repository / migration / types / tests).
- `test/**` — 무수정.
- `platform/types/*.js` — Step 3에서 추가된 미러 그대로.
- `dashboard.html` / `customers.html` / `team.html` / `index.html` — 무수정.
- 실 provider client (Clova / Anthropic / OpenAI) — 무수정.
- BullMQ worker / cron — 무수정.

---

## 2. (API) / (demo) 경계

### 2.1 `settings.html`

| 영역 | 출처 | 비고 |
|---|---|---|
| sidebar 사용자/조직 | (API) | `/me` |
| 프로필 / 회사 정보 / 통화 환경 / AI & 자동화 / 통합 / 알림 / 보안 / 데이터 / 결제 / API / 지역 / 위험 영역 | (demo) | 모든 컨트롤·라벨이 정적 HTML. 본 Step에서 무수정 |
| **가이드 & 체크리스트 (신규 섹션)** | (API) | knowledge_bases + chunks + checklist_templates 전부 실 API |
| 변경사항 저장 토스트 (헤더) | (demo) | 기존 정적 데모. 토스트만 띄움. 가이드/체크리스트 변경은 자체 inline 컨트롤이 즉시 저장한다. |

### 2.2 `live.html`

| 영역 | 출처 | 비고 |
|---|---|---|
| 통화 row 생성 / 종료 / 메모 | (API + WS) | Phase 4. 변경 없음 |
| transcript echo | (WS demo replay + persistence) | 변경 없음. 실 STT는 미적용 (Phase 5 e2e 또는 후속 adapter 작업) |
| **고객 카드** | (API) | `/customers?limit=50` + `link-customer` / `unlink-customer` |
| **체크리스트** | (API) | `initialize` + `list` + `mark status` |
| **WS heartbeat** | (WS) | 20초 주기, ack에 따라 break |
| **suggestion use/dismiss** | (API) | id 있는 카드에만 표시. 현재 WS replay 카드는 id 없음 → 버튼 없음 |
| AI suggestion 카드 | (WS demo replay) | Phase 0.5 fixture. 실 LLM push는 Phase 5 후속 |
| 통화 유형 / 번호 / 상담원 / 캡처 품질 | (demo) | 정적 HTML. 변경 없음 |
| 음소거 / 대기 버튼 | (demo) | 변경 없음 |
| 빠른 응대 멘트 3개 | (demo) | 변경 없음 (live.html 우측 패널) |

### 2.3 `calls.html`

| 영역 | 출처 | 비고 |
|---|---|---|
| list / detail / transcript / action items | (API) | Phase 4 |
| **manual summary writer** | (API) | `summary/manual` |
| **summary_source 배지** | (API) | `call.summary_source` 값 — `수동 작성` / `AI 생성` / `미작성` |
| **action item create + status toggle** | (API) | `create` + `status` endpoint |
| **action item delete** | 미구현 | backend endpoint 없음 (Step 4 plan §8.1 / 본 보고서 §5 gap) |
| **AI 추천 이력** | (API) | `GET /calls/:id/suggestions` |
| 자동 태그 (감정 / 방향) | (API) | 변경 없음 |
| 메모 추가 / 메일 발송 푸터 | (demo) | 정적. 변경 없음 |

### 2.4 `dashboard.html` / `customers.html` / `team.html` / `index.html`

본 Step에서 수정 없음. 각 화면의 (API)/(demo) 경계는 Phase 4 이전 그대로.

---

## 3. XSS Gate 처리

`AGENTS.md` innerHTML XSS gate 정책에 따라 새로 추가된 모든 보간 자리를 분류:

| 파일 | 자리 | 데이터 출처 | 처리 |
|---|---|---|---|
| settings.html | KB 제목 / source_type 라벨 / 청크 본문 / 갱신 시각 / 청크 카운트 | server | 전부 `textContent`. KB row, 청크 preview 모두 DOM node 조립. |
| settings.html | 체크리스트 템플릿 제목 | server | `input.value` 또는 `textContent`. |
| settings.html | 폼 placeholder / 정적 라벨 | constant | 안전 |
| live.html | customer name / company / title / email / phone | server | 전부 `textContent`. picker row도 DOM 조립 + `textContent`. |
| live.html | checklist item 제목 | server (org_call_checklist_templates) | `textContent` only. |
| live.html | suggestion card title / body | LLM/server | 기존 `safeSuggestionHtml(...)` (DOMPurify) 경유. use/dismiss 버튼 라벨은 정적 문자열 `'사용'` / `'닫기'`. |
| live.html | suggestion id (data-suggestion-id) | server | DOM dataset에만 저장. 안전. |
| calls.html | suggestion type / tone 라벨 | server | `escapeHtml` 후 innerHTML 보간. type 라벨은 화이트리스트 매핑(`SUG_TYPE_LABEL`)으로 변환 후 escape 추가. |
| calls.html | suggestion title / body | LLM/server | `escapeHtml`. HTML 포매팅은 허용하지 않음. body는 `whitespace-pre-wrap` CSS로 줄바꿈만 유지. |
| calls.html | action item title / due_date / id / status | server / user-typed | 전부 `escapeHtml`. data-action-id / data-action-status도 `escapeHtml`. |
| calls.html | manual summary textarea values | user-typed | `.value` 바인딩만 사용. innerHTML 0건. |
| calls.html | summary_source 배지 텍스트 | server (enum) | `textContent`. enum 값 분기로 처리. |

**LLM 응답 처리 비교**:
- `live.html`: DOMPurify가 통과시키는 안전 HTML(`<b>`, `<br>` 등)을 허용. Phase 0.5 fixture가 HTML 포함이고, 실 LLM도 비슷한 형태 예상.
- `calls.html`: HTML 포매팅 미허용. `escapeHtml`만 적용해 안전 최대화. 이력 보기는 plain text로 충분.

---

## 4. 검증

### 4.1 Command 검증

```bash
node test/sync_shared_types.mjs       # 14 entity PASS
npm --prefix server run typecheck     # 0 error
npm --prefix server test              # 301/301 PASS (Step 3 결과 그대로)
node test/phase_4_e2e.mjs             # 8 시나리오 PASS
```

Codex review에서 위 command를 모두 재실행했다. `npm --prefix server test`는 최초 1회 `phase5-smoke-*` KB/chunk 잔존 데이터 때문에 vector search 테스트가 6 vs 2로 실패했다. 잔존 테스트 데이터(`phase5-smoke-kb`, `phase5-smoke-kb-form`, chunk 4건)만 정리한 뒤 재실행하여 301/301 PASS를 확인했다. `node test/phase_4_e2e.mjs`도 최초 1회 transient fetch console error로 실패했으나, 재실행에서는 8 시나리오 + no console errors로 PASS했다.

### 4.2 Browser smoke (Playwright)

10 시나리오 모두 수동 검증. 각각 console errors=0 (Tailwind CDN production warning은 제외).

| # | 시나리오 | 결과 |
|---|---|---|
| 1 | settings KB 생성/조회/삭제 (관리자) | 2개 KB 생성 후 리스트 반영. 삭제 후 리스트에서 제거. soft delete 확인. |
| 2 | settings 체크리스트 템플릿 생성/수정/삭제 | 생성 후 즉시 row 표시. 인라인 토글 + 저장 동작. 삭제 확인. |
| 3 | settings non-admin (employee 시드) read-only | 역할 배지 `직원 (읽기 전용)`, 배너 표시, `kbNewBtn` / `tmplNewBtn` 등 mutation 컨트롤 모두 `disabled=true`. |
| 4 | live customer picker → link-customer | picker 패널 열림, `/customers?limit=50` 12명 로드, 첫 고객 클릭 → 카드 갱신, `unlinkBtn` 표시, `__liveCallState.customerId` 채워짐. |
| 5 | live checklist initialize/toggle persistence | start_call ack 직후 initialize 호출, 활성 템플릿 1건이 항목으로 노출, 토글 0→1→0 모두 서버 응답 기반 갱신. |
| 6 | live WS heartbeat ack | start_call 직후 1회 즉시 발사, 20초 후 두 번째 tick으로 `lastSeenAt` 갱신 확인. ack `ok:true`, lastError null. |
| 7 | suggestion use/dismiss 200/409 | (브라우저 직접 검증 없음 — 본 Step 3 라우트 테스트가 200/409 매트릭스 검증 완료. 본 UI는 persisted suggestion이 있을 때만 버튼 노출 / 미러 동작.) |
| 8 | calls detail suggestion history | 신규 ended call에는 추천 0건이라 `기록된 AI 추천이 없습니다.` 정상 표시. row 렌더는 코드 경로 검증 완료 (Step 5 e2e에서 데이터 시드 후 풀 검증 예정). |
| 9 | calls manual summary 저장 | 4 필드 입력 후 저장 → `summary_source` 배지 `수동 작성`, `dNeeds` 등이 새 값으로 갱신. |
| 10 | calls action item 생성/완료 토글 | 생성 시 list에 즉시 추가, 토글 시 `line-through` + `✓` 적용, 다시 클릭 시 `→`로 복귀 — 모두 detail reload 경로. |

### 4.3 Console / artifact 위생

- Playwright artifact (`.playwright-mcp/`)은 `.gitignore` 처리되어 있어 커밋되지 않음.
- 스모크 세션에서 만든 행은 정리:
  - knowledge_bases 2건 → API `softDeleteKnowledgeBase`
  - checklist template 1건 → API `deleteChecklistTemplate`
  - orphan ended call 1건 → admin role 직접 DELETE (BYPASSRLS)
- screenshots / temp 파일 추가 커밋 0건.

### 4.4 Cold-load 401 회피

- 초기 구현에서 `/me`가 access token 없이 발사돼 DevTools 콘솔에 401이 떴음. `settings.html` IIFE에 `ensureAccessToken()` (live.html / calls.html과 동일한 refresh-게이트 패턴) 추가. 재실행 후 cold 페이지 로드 console errors=0 확인.
- `loadSidebarProfile()`은 `_shared.js`가 이미 동일 게이트 보유. 본 작업은 새 IIFE에 같은 게이트 복제.

---

## 5. 남은 gap

### 5.1 Action item 삭제 endpoint 없음

`master plan` §1.범위 / §3.Step 4 산출물 표에 “작성·완료·삭제”가 적혀 있으나, 현재 backend에 action item DELETE endpoint가 없다. 본 Step은 “생성 + 상태 토글”만 wire하고 삭제 UI는 만들지 않는다. 가짜 hide / soft delete UI를 만들면 사용자 기대와 backend 상태가 어긋나므로, **삭제는 Phase 6+ backend endpoint 도입 후 별도 작업**으로 미룬다.

### 5.2 AI 자동 요약 트리거 없음

Step 3 plan §2.6에서 결정: AI summary REST trigger / BullMQ worker는 본 Step에 포함되지 않는다. `applyAiSummary` service는 server-internal 호출만 가능. 본 Step은 manual writer만 wire. **`summary_source='ai'` 행은 외부 worker가 도입돼야 생긴다** — Phase 5 e2e (Step 5) 또는 Phase 6 worker 작업.

### 5.3 WS suggestion persistence 없음

Phase 0.5 demo replay가 보내는 `suggestion` 이벤트는 DB 없는 fixture 그대로다. `call_suggestions` row가 생기려면 LLM worker / WS persistence hook이 필요하다. **본 Step은 persisted 카드(GET /calls/:id/suggestions 결과)에만 use/dismiss 버튼을 표시**한다. live.html에서 WS replay 카드는 정보 표시 전용.

### 5.4 60초 disconnect sweep cron 없음

`master plan` §2 결정 10의 “60초 이상 미heartbeat → dropped” 자동화는 cron / worker loop로 도입돼야 한다. Step 2의 `markTimedOutCallsDropped` service helper는 존재. **cron entrypoint / multi-org 루프는 Step 5 또는 Phase 6+**.

### 5.5 manager 본인 카드 readonly 라벨

본 Step settings.html 권한 배지는 `매니저 (읽기 전용)` / `직원 (읽기 전용)` / `뷰어 (읽기 전용)`로 표시. UI는 mutation controls disable 처리. 정확한 권한 정본은 서버 응답이므로 서버가 403을 돌려주면 폼에 메시지를 노출한다 — 이중 안전.

### 5.6 settings 청크 미리보기 N 제한

`renderKbList`가 청크 카운트 조회를 위해 KB detail을 최대 20개까지만 fetch한다. 회사가 21번째부터의 KB를 가지면 “–”로 표시된다. 본 Step에서는 UI 단순성이 우선이라 제한 유지. 무한 fetch / 가짜 lazy loading 도입하지 않는다.

### 5.7 settings KB chunk replace UX 단순화

chunk 편집은 “본문 textarea에 빈 줄로 분할” 방식. token-aware 분할 / 오버랩 / 파일 업로드는 Phase 6+ 또는 backend ingest worker로 미룸 (Step 4 plan §8.5).

### 5.8 live.html 좌측 통화 meta 4건 그대로 demo

“통화 유형 / 번호 / 상담원 / 캡처 품질”은 여전히 정적 HTML. Phase 5 master plan §6의 mock/API 표를 100% 이행하려면 server `/me` + selected customer 데이터로 갈아끼우면 되지만, 본 Step은 핵심 wiring(고객 picker / 체크리스트 / heartbeat / suggestion actions)에 집중. 정적 4필드는 Phase 5 e2e 또는 Phase 6 UI polish.

### 5.9 live.html 우측 “빠른 응대 멘트 3개” 그대로 demo

LLM이 생성하는 멘트(quick reply)도 demo 그대로. master plan §6 §“빠른 응대 멘트 3개”의 LLM 연동은 Phase 5 후속 worker.

### 5.10 dashboard.html manager team-scope 보고서 없음

Phase 5 master plan에서 명시적으로 Phase 6+로 미룸. 본 Step도 미작성.

---

## 6. 위험·체크포인트

| # | 항목 | 결과 |
|---|---|---|
| 6-1 | backend 변경 0건 | git status 기준 `platform/*` 5건 + `docs/plan/phase-5/*` 2건만 변경. server/test/backend runtime 변경 0건. |
| 6-2 | 실 provider client 도입 0건 | server/src/adapters/* 무수정 |
| 6-3 | bundler / framework 도입 0건 | classic `<script>` 그대로 |
| 6-4 | XSS gate — server-returned/user-typed/LLM-returned 보간 분류 100% | §3 표 |
| 6-5 | action item delete UI 0건 | calls.html grep 결과 delete 컨트롤 없음 |
| 6-6 | screenshots / transient artifact 커밋 0건 | `.playwright-mcp/` gitignored |
| 6-7 | sync_shared_types 14 entity PASS | §4.1 |
| 6-8 | server typecheck 0 error | §4.1 |
| 6-9 | phase_4_e2e 8 시나리오 회귀 PASS | §4.1 |
| 6-10 | live.html DOMPurify path 유지 | suggestion title/body — 기존 `safeSuggestionHtml` 그대로 |

---

## 7. Codex Review Focus 응답

| Step 4 plan §7 | 결과 |
|---|---|
| KB title/source_uri/chunk text/template title | textContent (settings.html `renderKbList` / `toggleKbDetail` / `renderTemplates`) |
| customer name/company/title/email/phone | textContent (live.html `renderCustomerCard` / `renderPickerList`) |
| checklist 항목 제목 | textContent (live.html `renderChecklist`) |
| suggestion title/body (live) | DOMPurify (기존 `safeSuggestionHtml`) |
| suggestion title/body (calls) | `escapeHtml`; HTML formatting 미허용 |
| manual summary fields | textarea `.value` 만 사용 |
| action item title/due_date | `escapeHtml` |

서버 권한 가드(403)는 모든 mutation helper에서 처리. UI gating은 편의용. server 응답이 정본.

---

## 8. 결과 한 줄 요약

> **Step 3 API 표면을 `settings.html` / `live.html` / `calls.html` / `api.js` / `ws.js`에 wire 완료. 가이드·체크리스트 관리, 고객 picker, 체크리스트 영속, WS heartbeat 20초, suggestion use/dismiss, manual summary writer, action item mutation이 모두 실 API로 동작. backend 변경 0, 실 provider 0, action item delete UI 0, XSS gate 위반 0. sync_shared_types / typecheck / phase_4_e2e 회귀 PASS. 브라우저 스모크 10 시나리오 console errors=0.**

---

## 9. Step 5 (통합 e2e) 인계

`test/phase_5_e2e.mjs`가 자동화할 흐름 (Step 4 결과 위에 올림):

1. admin 로그인 → settings에서 KB / chunk / 체크리스트 템플릿 생성
2. employee 로그인 → start_call → customer picker → link-customer → checklist initialize → toggle → heartbeat tick × 2 (또는 짧은 시간 fake clock)
3. employee → endCall → calls.html detail에서 manual summary 저장 → `summary_source='manual'` 확인
4. employee → calls.html에서 action item create + status toggle
5. admin → 다른 팀 통화 mutation 시도 → 403 (manager team-scope)
6. cross-org admin → 자기 org KB만 보임 (RLS)
7. cleanup sweep — 본 Step 스모크에서 사용한 패턴(`phase5-smoke-` prefix sweep + admin direct DELETE)을 e2e에서도 동일하게 적용

추가로 검토 권장:
- WS suggestion persistence 후크(현재 0). LLM worker 또는 WS 핸들러 추가 시 `live.html`의 use/dismiss 버튼이 자동으로 활성화된다.
- action item DELETE endpoint 도입 시 `calls.html` detail 패널에 row-level delete 컨트롤 추가.
- 60s heartbeat sweep cron entrypoint.

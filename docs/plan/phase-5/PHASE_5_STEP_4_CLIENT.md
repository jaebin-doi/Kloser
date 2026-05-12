# Phase 5 — Step 4 Client Plan (Frontend Wiring)

> **상위 계획**: `docs/plan/phase-5/PHASE_5_MASTER.md` §3 Step 4.
> **선행 단계**: Step 3 완료 — `PHASE_5_STEP_3_ROUTES.md` + `PHASE_5_STEP_3_FINDINGS.md`.
> **워크플로**: AGENTS.md Phase Workflow의 frontend 단계. backend schema / repository / route contract는 이미 닫혔으므로 본 step은 static HTML + vanilla JS wiring에 한정한다.
> **기간**: 2.5~3일.

---

## 0. 목표

Step 3에서 생긴 Phase 5 API 표면을 기존 정적 화면에 연결한다.

1. `platform/api.js`에 Phase 5 helper를 추가한다.
2. `platform/settings.html`에 회사 가이드와 체크리스트 템플릿 관리 UI를 연결한다.
3. `platform/live.html`에서 고객 선택, 고객 연결, 체크리스트 영속화, WS heartbeat, suggestion use/dismiss를 연결한다.
4. `platform/calls.html` detail 패널에서 suggestion 이력, 수동 요약 작성, action item mutation UI를 연결한다.
5. 신규/수정 `innerHTML` gate를 모두 분류하고 server-returned / LLM-returned 값은 escape 또는 DOMPurify 경유로만 렌더한다.

본 step은 "실 provider 호출"이 아니라 **mock-backed API 표면을 UI에서 실제로 사용하게 만드는 단계**다.

---

## 1. 하지 않는 것

- backend route / service / migration 변경 없음.
- RLS / 권한 정책 변경 없음.
- 실 Clova / Anthropic / OpenAI provider client 추가 없음.
- BullMQ worker / cron scheduler 추가 없음. `dropped` sweep 자동 루프는 Step 5 또는 Phase 6+로 미룬다.
- bundler / framework 도입 없음. 기존 classic HTML + vanilla JS 유지.
- `dashboard.html` 신규 기능 없음. Phase 4 API-backed KPI를 유지하고 manager team read-scope 보고서는 Phase 6+.

계약이 부족해 보이는 경우에도 frontend에서 임시 endpoint를 만들지 않는다. Step 3 API surface를 그대로 사용하고, 부족분은 Step 4 findings에 명시한다.

---

## 2. Current API / Demo Boundary

### 2.1 `platform/api.js`

| 영역 | 현재 | Step 4 |
|---|---|---|
| auth / refresh / logout | API | 유지 |
| calls / transcript / action items / dashboard | API | 유지 + Phase 5 helpers 추가 |
| customers helper | generic `apiGet('/customers')` 사용 필요 | 고객 picker에서 generic 또는 thin helper 추가 |
| knowledge / checklist / suggestions / heartbeat / summary | 없음 | 신규 helper |

### 2.2 `platform/settings.html`

| 영역 | 현재 출처 | Step 4 출처 |
|---|---|---|
| sidebar user/org | API (`_shared.js` `/me`) | API 유지 |
| 프로필 / 알림 / 보안 / 결제 / API 키 / 지역 / 위험영역 | demo/static | demo 유지 |
| 회사 가이드 / FAQ | UI 없음 | API (`/knowledge-bases`, chunks replace) |
| 상담 체크리스트 템플릿 | UI 없음 | API (`/call-checklist-templates`) |

Step 4 status report에서 settings 화면 값은 `(API)` / `(demo)`로 명확히 표기한다.

### 2.3 `platform/live.html`

| 영역 | 현재 출처 | Step 4 출처 |
|---|---|---|
| 통화 row 생성 / 종료 / 메모 | API + WS | API + WS 유지 |
| transcript echo | WS demo replay + user text_chunk persistence | 유지. 실 STT는 아직 아님 |
| suggestion 카드 | WS demo replay | WS demo replay + persisted suggestion actions. 실 LLM push는 아직 아님 |
| 고객 카드 | demo hardcode | API customer picker + `link-customer` |
| 체크리스트 | demo hardcode + client-only toggle | API initialize/list/status |
| heartbeat | 없음 | WS `heartbeat` 20초 주기 |
| `window.__liveCallState` | 없음 | dev/e2e용 read-only snapshot |

실 STT / 실 LLM push는 Step 5 e2e 또는 후속 adapter 작업에서 완성한다. 본 step은 UI와 REST/WS persistence wiring을 닫는다.

### 2.4 `platform/calls.html`

| 영역 | 현재 출처 | Step 4 출처 |
|---|---|---|
| list / detail / transcript | API | 유지 |
| summary / needs / issues / sentiment | API fields read-only | API + manual summary writer |
| action items | API read-only | API create/status/assignee mutation UI |
| suggestion 이력 | 없음 | API (`GET /calls/:id/suggestions`) |
| server fields in `innerHTML` | `escapeHtml` 적용 | 유지 + 신규 보간 전부 escape |

---

## 3. API Helper Plan (`platform/api.js`)

기존 helper와 동일하게 raw `Response`를 반환한다. 호출자는 `res.ok`, `res.status`, `await res.json()`으로 분기한다.

### 3.1 Knowledge

```js
listKnowledgeBases(query)
getKnowledgeBase(id)
createKnowledgeBase(input)
patchKnowledgeBase(id, input)
deleteKnowledgeBase(id)
replaceKnowledgeChunks(id, chunks)
searchKnowledge(query, limit)
```

Endpoint:
- `GET /knowledge-bases`
- `GET /knowledge-bases/:id`
- `POST /knowledge-bases`
- `PATCH /knowledge-bases/:id`
- `DELETE /knowledge-bases/:id`
- `POST /knowledge-bases/:id/chunks/replace`
- `POST /knowledge-bases/search`

### 3.2 Checklist Templates

```js
listChecklistTemplates()
createChecklistTemplate(input)
patchChecklistTemplate(id, input)
deleteChecklistTemplate(id)
```

Endpoint:
- `GET /call-checklist-templates`
- `POST /call-checklist-templates`
- `PATCH /call-checklist-templates/:id`
- `DELETE /call-checklist-templates/:id`

### 3.3 Call Checklist

```js
initializeCallChecklist(callId)
listCallChecklist(callId)
patchCallChecklistItemStatus(id, status)
```

Endpoint:
- `POST /calls/:id/checklist/initialize`
- `GET /calls/:id/checklist`
- `POST /call-checklist-items/:id/status`

### 3.4 Suggestions

```js
listCallSuggestions(callId)
useCallSuggestion(id)
dismissCallSuggestion(id)
```

Endpoint:
- `GET /calls/:id/suggestions`
- `POST /call-suggestions/:id/use`
- `POST /call-suggestions/:id/dismiss`

### 3.5 Call Meta / Summary

```js
linkCallCustomer(callId, customerId)
unlinkCallCustomer(callId)
patchCallManualSummary(callId, input)
```

Endpoint:
- `POST /calls/:id/link-customer`
- `POST /calls/:id/unlink-customer`
- `POST /calls/:id/summary/manual`

WS heartbeat는 `api.js` helper가 아니라 `platform/ws.js` 또는 `live.html` local helper로 둔다. `kloserWS`가 socket concern을 이미 갖고 있으므로 Step 4에서 `sendHeartbeat(socket)` thin wrapper를 추가하는 방향을 우선한다.

---

## 4. File-by-File Plan

### 4.1 `platform/api.js`

작업:
- §3의 helpers 추가.
- `window.kloserApi` export 목록에 helper 추가.
- query serialization은 기존 `listCalls` 패턴 재사용.
- helpers는 JSON parsing을 하지 않고 raw Response 반환.

검증:
- 기존 auth/calls helpers 이름과 충돌 없음.
- `node test/sync_shared_types.mjs`에 영향 없음.

### 4.2 `platform/ws.js`

작업:
- `sendHeartbeat(socket)` 추가.
- Promise ack wrapper는 기존 `startCall` / `endCall` 스타일과 맞춘다.
- ack error는 raw object 반환. `live.html`이 `call_ended`, `no_active_call`, `persistence_failed`를 분기.

비목표:
- suggestion push protocol 변경 없음.
- STT stream protocol 추가 없음.

### 4.3 `platform/settings.html`

UI 배치:
- 기존 좌측 TOC에 `가이드 & 체크리스트` 앵커 추가.
- 본문에는 하나의 full-width section 안에 두 영역을 둔다.
- card 안에 card를 넣지 않는다. `set-card` 섹션 안에서 리스트 row / form block으로 구성한다.

Knowledge Base UX:
- list: title, source_type, chunk count, updated_at.
- create: title + source_type(`manual` 기본) + text area.
- save flow:
  1. `POST /knowledge-bases`
  2. text area를 chunk로 단순 분할해 `POST /knowledge-bases/:id/chunks/replace`
  3. list reload
- edit metadata: title/source_uri patch.
- delete: soft delete 후 list reload.
- detail: selected KB chunks text preview.

Chunking v1:
- client-side simple paragraph chunking.
- 빈 문단 제거, 각 chunk max 약 1800~2400 chars.
- `position`은 0부터 증가.
- `token_count`는 null.
- embedding은 보내지 않음. Step 3 route가 mock embedding을 생성.

Checklist Template UX:
- list: title, active, sort_order.
- create: title + sort_order.
- patch: title / active / sort_order inline controls.
- delete: row action.

권한:
- `/me`로 role 확인.
- admin이 아니면 read-only banner 표시, mutation controls disabled.
- 서버 403도 반드시 처리한다. UI role은 편의용, 권한은 서버가 정본.

XSS:
- KB title/source_uri/chunk text/template title은 server-returned field.
- 리스트는 DOM node + `textContent` 우선.
- 불가피한 `innerHTML`은 `escapeHtml` helper를 추가하고 전부 escape.

### 4.4 `platform/live.html`

Customer picker:
- 기존 customer card hardcode를 API state로 바꾼다.
- page boot 후 `/customers?limit=50` fetch.
- picker modal or inline searchable panel.
- start_call 전 선택된 customerId를 `startCall(socket, { customerId })`에 전달.
- 통화 중 변경 시 `linkCallCustomer(callId, customerId)` 호출.
- unlink control은 선택 해제용으로 제공.

Customer card fields:
- name/company/title/email/phone/status는 API.
- 선택 전 placeholder는 demo/static이 아니라 "고객 미선택" UI.

Checklist:
- `start_call` ack로 `callId`를 받으면:
  1. `initializeCallChecklist(callId)`
  2. `listCallChecklist(callId)` 또는 initialize 응답으로 render
- toggle:
  - optimistic UI는 하지 않는다. POST 성공 후 reload/render.
  - 403/404는 status label로 표시.
- counts는 API item status 기준.

WS heartbeat:
- `callState.status === 'live'`일 때 20초 interval.
- start_call ack 이후 즉시 1회 heartbeat, 이후 interval.
- ack `{ ok: false, error: 'call_ended' }`면 interval clear.
- end_call 성공/실패/페이지 unload 시 interval clear.
- dev/e2e용 `window.__liveCallState`에 `callId`, `status`, `customerId`, `heartbeatLastSeenAt`, checklist counts를 노출.

Suggestions:
- 기존 `renderSuggestions(group)`는 유지하되, suggestion id가 있는 경우 use/dismiss buttons를 렌더.
- Phase 0.5 demo replay에는 id가 없을 수 있으므로 버튼 disabled 또는 숨김.
- persisted suggestions는 `GET /calls/:id/suggestions`로 별도 load해 live side panel 아래 "이력" 또는 calls.html로 넘긴다.
- `use/dismiss` 409 `conflict_state`는 reload 후 "이미 처리됨" 상태로 보여준다.

XSS:
- 기존 DOMPurify path 유지.
- title/body는 LLM/server-returned field라 DOMPurify 필수.
- customer/checklist server fields는 `textContent`로 렌더.

### 4.5 `platform/calls.html`

Detail fetch:
- 기존 병렬 fetch에 `listCallSuggestions(callId)` 추가.
- 기존 `listActionItems`는 유지.

Suggestion history:
- summary section 아래 또는 transcript 전 별도 section.
- fields: type/tone/title/body/used_at/dismissed_at/created_at.
- title/body는 server/LLM-returned field. `escapeHtml` 또는 DOMPurify. `calls.html`은 이미 `escapeHtml`가 있으므로 HTML formatting을 허용하지 않고 escape한다.
- use/dismiss buttons는 unresolved suggestion에만 표시.
- POST 후 detail reload.

Manual summary writer:
- 기존 summary/needs/issues/sentiment read-only 블록 아래 compact edit form.
- "수동 요약 저장" 버튼.
- payload: `{ summary, needs, issues, sentiment }`, empty string은 null.
- 저장 성공 후 call detail reload. `summary_source='manual'` badge 표시.
- 403은 권한 없음 message.

Action item mutation:
- existing read-only list를 row controls로 바꾼다.
- create form: title, due_date optional.
- status toggle: `patchActionItemStatus(id, 'done'|'open')`.
- assignee 변경은 Step 4에서 최소 구현: 본인/미지정만 또는 existing endpoint 그대로 input 제공. 팀 멤버 picker가 필요하면 Step 5로 미룰 수 있다.
- delete endpoint가 없으므로 "삭제" UI는 만들지 않는다. master plan의 "삭제" 표현은 현재 backend contract와 불일치하므로 Step 4 findings에 "delete 미지원"으로 명시한다.

XSS:
- calls.html은 이미 `escapeHtml`가 있으므로 신규 innerHTML도 모두 escape.
- action title/due_date, transcript text, suggestion title/body, summary fields 모두 server-returned field.

---

## 5. Implementation Order

1. `PHASE_5_STEP_4_CLIENT.md` 작성 (본 문서).
2. `platform/api.js` + `platform/ws.js` helpers 추가.
3. `settings.html` 계획된 section skeleton + read/list wiring.
4. `settings.html` mutation controls + admin gating.
5. `live.html` customer picker + link/unlink.
6. `live.html` checklist initialize/list/toggle + heartbeat.
7. `live.html` suggestion use/dismiss 처리.
8. `calls.html` suggestion history.
9. `calls.html` manual summary writer + action item mutation.
10. XSS gate audit.
11. browser/Playwright visual checks + regression commands.
12. `PHASE_5_STEP_4_FINDINGS.md` 작성.
13. `PHASE_5_MASTER.md` Step 4 checkbox는 검증 완료 후에만 갱신.

---

## 6. Validation Plan

### 6.1 Command checks

```powershell
node test/sync_shared_types.mjs
npm --prefix server run typecheck
npm --prefix server test
node test/phase_4_e2e.mjs
```

`npm --prefix server test`는 frontend-only 변경이어도 route contract 회귀를 확인하기 위해 실행한다.

### 6.2 Browser scenarios

1. settings — admin sees knowledge base list, creates manual KB, chunks are persisted, deletes KB.
2. settings — admin creates/patches/deletes checklist template.
3. settings — non-admin sees read-only state and mutation controls disabled; server 403 path handled.
4. live — customer picker lists API customers, selected customerId goes into `start_call` or link endpoint.
5. live — checklist initializes from API and toggle persists after reload/list refresh.
6. live — heartbeat sends every 20s and updates `window.__liveCallState.heartbeatLastSeenAt`.
7. live — suggestion use/dismiss handles 200 and 409 conflict_state.
8. calls — detail shows suggestion history.
9. calls — manual summary save persists and reload shows `summary_source='manual'`.
10. calls — action item create/status toggle persists.

### 6.3 Screenshot / artifact policy

- Do not commit screenshots.
- Temporary Playwright screenshots may be created for inspection and deleted before commit unless user explicitly asks to keep them.

---

## 7. XSS Gate Checklist

Every new or touched `innerHTML` / template literal assigned to DOM must be classified:

| File | Data | Source | Required handling |
|---|---|---|---|
| settings.html | KB title/source_uri/chunk text | Server-returned | `textContent` or `escapeHtml` |
| settings.html | checklist template title | Server-returned | `textContent` or `escapeHtml` |
| live.html | customer name/company/title/email/phone | Server-returned | `textContent` |
| live.html | checklist title | Server-returned | `textContent` |
| live.html | suggestion title/body | LLM/server-returned | DOMPurify via `safeSuggestionHtml` |
| calls.html | suggestion title/body | LLM/server-returned | `escapeHtml`; no HTML formatting |
| calls.html | manual summary fields | Server-returned/user-typed | `textContent` or `escapeHtml` |
| calls.html | action item title/due_date | Server-returned/user-typed | `escapeHtml` |

Constants such as SVG icons, button chrome, static labels are safe. Server-returned and user-typed fields are not safe.

---

## 8. Risks / Open Decisions

### 8.1 Action item delete mismatch

Master plan says "작성/완료/삭제" but current backend has create/status/assignee only. There is no delete endpoint. Step 4 should implement create + complete/open + optional assignee, and record delete as backend gap in findings. Do not invent frontend-only delete.

### 8.2 AI summary auto generation not yet wired

Step 3 intentionally did not expose AI summary trigger or worker. Step 4 can only support manual summary writer and display AI summary fields if present. "통화 후 자동 요약" remains Step 5/worker gap unless a backend worker is added in a later step.

### 8.3 Live suggestion persistence gap

Existing WS suggestion replay emits demo groups without DB ids. `use/dismiss` requires persisted `call_suggestions.id`. Step 4 can:
- render use/dismiss only for persisted suggestions fetched from `GET /calls/:id/suggestions`, and
- keep demo WS cards as display-only.

If product requires live cards to be actionable immediately, backend WS suggestion persistence hook must be added later.

### 8.4 Settings admin gating

Frontend role gating is convenience only. Server 403 remains authoritative. Non-admin UX should be read-only, not hidden entirely, because read endpoints are allowed for same-org users.

### 8.5 Chunking quality

Client-side paragraph chunking is acceptable for manual text in Step 4. Production quality chunking (tokenizer, overlap, file parser, background ingest) belongs in Phase 6+ or a follow-up backend worker.

---

## 9. Completion Criteria

- [ ] `platform/api.js` exposes all Phase 5 REST helpers.
- [ ] `platform/ws.js` exposes heartbeat helper.
- [ ] `settings.html` knowledge base and checklist template UI are API-backed.
- [ ] `live.html` customer picker / link-customer / checklist / heartbeat are API-backed.
- [ ] `calls.html` suggestion history / manual summary / action item mutation are API-backed.
- [ ] Every user-facing value in final report is labeled `(API)` or `(demo)` where relevant.
- [ ] XSS gate audit has 0 unresolved server-returned/user-typed interpolations.
- [ ] `node test/sync_shared_types.mjs` PASS.
- [ ] `npm --prefix server run typecheck` PASS.
- [ ] `npm --prefix server test` PASS.
- [ ] `node test/phase_4_e2e.mjs` PASS.
- [ ] Browser scenarios in §6.2 verified.
- [ ] `PHASE_5_STEP_4_FINDINGS.md` written.
- [ ] `PHASE_5_MASTER.md` Step 4 checkbox updated only after all above are complete.

---

## 10. Step 5 인계 예고

Step 4가 끝나면 Step 5는 `test/phase_5_e2e.mjs`를 작성해 다음을 자동화한다:

- settings에서 KB/chunk/template 생성.
- live에서 customer picker → start_call/link → checklist initialize/toggle → heartbeat.
- mock suggestion/summary path 검증 가능한 만큼 확인.
- calls detail에서 suggestion history/manual summary/action item mutation 확인.
- manager same-team mutation 허용, other-team 403.
- cleanup sweep.


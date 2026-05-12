# Phase 5 — Step 3 Findings (Adapters + REST routes + Shared types + WS heartbeat)

> **완료일**: 2026-05-12
> **범위**: STT / LLM / Embedding adapter 인터페이스 + 3종 mock + resolver, REST 신규 21 endpoint (knowledge / checklist templates / call checklist items / call suggestions / heartbeat / customer link·unlink / manual summary), shared zod/JSDoc 5 신규 entity + `call`에 `CallSummaryManualInput` 추가 (sync registry 9 → 14), WS `heartbeat` 이벤트 + persistence, 신규 단위/라우트/WS 테스트 46건. 프런트엔드 0 byte 변경, 실 provider client 0건 추가.

---

## 1. 적용 파일

### 1.1 신규 (24개)

문서
- `docs/plan/phase-5/PHASE_5_STEP_3_ROUTES.md`
- `docs/plan/phase-5/PHASE_5_STEP_3_FINDINGS.md` (본 문서)

Adapter (7)
- `server/src/adapters/index.ts` — resolver
- `server/src/adapters/stt/index.ts` — `STTAdapter` 인터페이스 + `SttUnsupportedInputError`
- `server/src/adapters/stt/mock.ts` — 5종 한국어 fixture (`greeting` / `intro` / `scale` / `needs` / `closing`)
- `server/src/adapters/llm/index.ts` — `LLMAdapter` 인터페이스
- `server/src/adapters/llm/mock.ts` — sentiment 규칙 기반 mock
- `server/src/adapters/embedding/index.ts` — `EmbeddingAdapter` 인터페이스 + `EmbeddingDimensionError`
- `server/src/adapters/embedding/mock.ts` — 결정적 1536-dim L2-normalised vector

Shared types — server 5 zod (5)
- `server/src/types/knowledgeBase.ts`
- `server/src/types/knowledgeChunk.ts`
- `server/src/types/checklistTemplate.ts`
- `server/src/types/callChecklistItem.ts`
- `server/src/types/callSuggestion.ts`

Shared types — browser JSDoc mirrors (5)
- `platform/types/knowledgeBase.js`
- `platform/types/knowledgeChunk.js`
- `platform/types/checklistTemplate.js`
- `platform/types/callChecklistItem.js`
- `platform/types/callSuggestion.js`

REST 라우트 (3)
- `server/src/routes/knowledgeBases.ts` — 7 endpoint (CRUD + chunks/replace + search)
- `server/src/routes/checklistTemplates.ts` — 4 endpoint (CRUD)
- `server/src/routes/callsPhase5.ts` — 10 endpoint (heartbeat / link / unlink / manual summary / checklist init·get·status / suggestions list·use·dismiss)

테스트 (6)
- `server/test/_phase5Fixture.mjs` — 5 ephemeral phase5test users + 2 teams + mintToken + insertCallRaw helper
- `server/test/phase5_adapters.test.mjs` — 11 case (STT 3 + LLM 3 + embedding 3 + resolver 2)
- `server/test/phase5_routes_knowledge.test.mjs` — 10 case
- `server/test/phase5_routes_checklist.test.mjs` — 7 case
- `server/test/phase5_routes_suggestions.test.mjs` — 6 case
- `server/test/phase5_routes_calls.test.mjs` — 9 case
- `server/test/phase5_ws_heartbeat.test.mjs` — 3 case

### 1.2 수정 (5)

- `server/src/server.ts` — `knowledgeBasesRoutes` / `checklistTemplatesRoutes` / `callsPhase5Routes` 3개 라우트 import + register
- `server/src/types/call.ts` — `CallSummaryManualInput` 추가
- `platform/types/call.js` — `CallSummaryManualInput` JSDoc 미러 추가
- `test/sync_shared_types.mjs` — 5 신규 entity ENTITY_REGISTRY 등록 + `call.types` 배열에 `CallSummaryManualInput` 추가
- `server/src/ws/calls.ts` — `heartbeat` 이벤트 핸들러 추가 (`start_call` / `text_chunk` / `end_call` / `disconnect` 무수정)

### 1.3 수정 안 함

- `server/src/routes/calls.ts` — Phase 4 11 endpoint 그대로
- `server/src/repositories/*` — Step 2에서 작성한 5 신규 + 2 보강 그대로
- `server/src/services/*` — Step 2 7 신규 service 그대로
- `server/migrations/*` — RLS 정책 변경 0건 (team-scope는 service layer 책임)
- `platform/live.html` / `platform/calls.html` / `platform/settings.html` — Step 4 작업
- `server/.env` / `.env` — dev 머신마다 다름. `.env.example`도 본 step에서 손대지 않음 (실 provider 키 미사용)
- 실 provider client (Clova / Anthropic / OpenAI) — interface와 resolver의 throw branch만 추가, 실 모듈 미작성

---

## 2. 핵심 결정 재확인 (Step 3 plan 대비)

| # | 항목 | 구현 결과 |
|---|---|---|
| 3-1 | adapter 디렉터리 | `server/src/adapters/{stt,llm,embedding}/{index,mock}.ts` + `adapters/index.ts` resolver |
| 3-2 | mock 결정성 | 동일 입력 → 동일 출력. embedding은 L2-normalised so cosine 검증 가능 |
| 3-3 | resolver fallback | env 미설정 시 mock. 알 수 없는 provider는 throw — silent fallback 없음 |
| 3-4 | REST endpoint 총수 | 21개 (계획서 §2.3 표와 일치) |
| 3-5 | 권한 chain | read = `requireAuth + orgContext`. writer = `+ requireVerified + requireRole(admin/manager/employee) + requireFreshRole`. admin = `+ requireRole("admin")` |
| 3-6 | team-scope 처리 | service layer `assertCanMutateCall` 그대로 사용. RLS 정책 변경 0 |
| 3-7 | error 매핑 | ZodError 400 / PermissionError 403 / SuggestionStateError 409 / InvalidEmbeddingError 400 / 23503 400 invalid_reference / 23505 409 conflict / 23514 400 / 42501 500 / service null 404 |
| 3-8 | shared types | 14 entity. `call`은 기존 entity에 `CallSummaryManualInput` 추가. 5 신규 entity는 zod + JSDoc + registry |
| 3-9 | WS heartbeat | `heartbeat` 이벤트 1개 추가. disconnect는 그대로 (60s sweep은 service layer 책임, scheduler는 Step 4+) |
| 3-10 | AI summary REST trigger | 본 step에서 미노출. service `applyAiSummary`만 노출 (Step 4 worker가 직접 호출). manual writer endpoint 1개만 추가 |
| 3-11 | suggestion 생성 endpoint | 본 step에서 미노출. WS / LLM worker가 service 직접 호출 — 외부 REST 표면 없음 (계획서 §2.6) |
| 3-12 | chunk embedding REST | 미노출. chunks/replace endpoint가 embedding이 없는 chunk에 대해 adapter로 자동 생성 |

---

## 3. REST 라우트 surface 정본 (21 endpoint)

### 3.1 knowledge_bases (7)

| Method | URL | 역할 | 권한 | 주요 응답 |
|---|---|---|---|---|
| GET | `/knowledge-bases` | list | requireAuth + orgContext | `{ items: KnowledgeBase[] }` |
| POST | `/knowledge-bases` | create | admin chain | 201 `{ knowledge_base }` |
| GET | `/knowledge-bases/:id` | detail | requireAuth + orgContext | `{ knowledge_base, chunks }` |
| PATCH | `/knowledge-bases/:id` | patch | admin chain | `{ knowledge_base }` |
| DELETE | `/knowledge-bases/:id` | soft delete | admin chain | 204 |
| POST | `/knowledge-bases/:id/chunks/replace` | replace chunks (embedding 자동) | admin chain | `{ chunks }` |
| POST | `/knowledge-bases/search` | vector search | requireAuth + orgContext | `{ items: KnowledgeChunkSearchResultItem[] }` |

### 3.2 checklist templates (4)

| Method | URL | 역할 | 권한 |
|---|---|---|---|
| GET | `/call-checklist-templates` | list | requireAuth + orgContext |
| POST | `/call-checklist-templates` | create | admin chain |
| PATCH | `/call-checklist-templates/:id` | patch | admin chain |
| DELETE | `/call-checklist-templates/:id` | delete | admin chain |

### 3.3 calls Phase 5 (10)

| Method | URL | 역할 | 권한 |
|---|---|---|---|
| POST | `/calls/:id/heartbeat` | last_seen_at touch | writer chain |
| POST | `/calls/:id/link-customer` | bind customer | writer chain + assertCanMutateCall |
| POST | `/calls/:id/unlink-customer` | clear customer | writer chain + assertCanMutateCall |
| POST | `/calls/:id/summary/manual` | manual summary writer | writer chain + assertCanMutateCall |
| POST | `/calls/:id/checklist/initialize` | active templates → items snapshot | writer chain + assertCanMutateCall |
| GET  | `/calls/:id/checklist` | items list | requireAuth + orgContext |
| GET  | `/calls/:id/suggestions` | suggestion 이력 | requireAuth + orgContext |
| POST | `/call-checklist-items/:id/status` | mark open/done | writer chain + assertCanMutateCall |
| POST | `/call-suggestions/:id/use` | mark used | writer chain + assertCanMutateCall |
| POST | `/call-suggestions/:id/dismiss` | mark dismissed | writer chain + assertCanMutateCall |

---

## 4. WS heartbeat 이벤트 계약

```ts
socket.emit("heartbeat", {}, ack)
```

ack:

| ack | 의미 | 후속 클라이언트 동작 |
|---|---|---|
| `{ ok: true, lastSeenAt }` | 갱신 성공 | 다음 주기까지 idle |
| `{ ok: false, error: "no_active_call" }` | start_call 전 호출 | heartbeat 송신 중단 |
| `{ ok: false, error: "call_ended" }` | DB call이 in_progress가 아님 | heartbeat 송신 중단 |
| `{ ok: false, error: "persistence_failed" }` | DB 오류 | 다음 주기 재시도 |

기존 `start_call` / `text_chunk` / `end_call` / `disconnect` 핸들러는 변경 없음. master plan §2 결정 11 (20s 주기) 와 §2 결정 10 (60s timeout) 는 Step 4 클라이언트 wiring과 cron sweep loop에서 적용된다.

---

## 5. 검증

### 5.1 typecheck

```bash
npm --prefix server run typecheck
# > tsc --noEmit  (0 error)
```

### 5.2 server unit tests

```bash
npm --prefix server test
# ℹ tests 301
# ℹ pass 301
# ℹ fail 0
# ℹ duration_ms 31799.5553
```

- Step 2까지 255 회귀 0건
- Step 3 신규 46건:
  - `phase5_adapters.test.mjs` 11 (STT 3 + LLM 3 + embedding 3 + resolver 2)
  - `phase5_routes_knowledge.test.mjs` 10
  - `phase5_routes_checklist.test.mjs` 7
  - `phase5_routes_suggestions.test.mjs` 6
  - `phase5_routes_calls.test.mjs` 9
  - `phase5_ws_heartbeat.test.mjs` 3

### 5.3 sync_shared_types

```bash
node test/sync_shared_types.mjs
# customers / signup / password-reset / team / invitation / call /
# transcript / actionItem / dashboard / knowledgeBase / knowledgeChunk /
# checklistTemplate / callChecklistItem / callSuggestion — 14/14 OK
# PASS
```

### 5.4 phase_4_e2e 회귀

```bash
node test/phase_4_e2e.mjs
# E2E PASSED  (8 시나리오 + cleanup)
```

### 5.5 git diff --check

LF↔CRLF 경고만 (Windows 표준). 실제 whitespace 오류 없음.

---

## 6. 발견 / 리스크

### 6.1 chunks/replace의 embedding 자동 생성

`POST /knowledge-bases/:id/chunks/replace` 가 embedding이 없는 chunk를 받으면 adapter resolver의 결과로 `embed()` 호출 후 INSERT. 본 step은 mock이라 동기 작업이지만, 실 provider 도입 시 다음을 주의:

- 200 chunks 전부 동기 embed가 길어질 수 있음. 실 provider 도입 시 BullMQ worker로 분리 검토 (text-only INSERT → 워커가 batch embed → 사후 UPDATE 패턴; Step 1 migration이 이미 NULL embedding을 허용).
- adapter 호출 실패 시 본 step은 raw Error를 surface해 500이 나간다. Step 2 결정 21 (Embedding 실패 → ingest 실패로 chunks INSERT 안 함) 정책과 일치한다.

### 6.2 manual summary가 manager NULL-team의 본인 통화는 허용

`assertCanMutateCall`의 manager 분기는 `call.agent_user_id === actor.id` 단축이 있어, 팀이 없는 manager라도 자기 자신이 agent인 통화는 mutation을 허용한다 (Step 2 §6.4 결정). Step 3 라우트도 같은 분기를 그대로 받는다 — 추가 테스트 케이스 없음 (Step 2 service test에서 이미 검증).

### 6.3 chunks/replace + 자동 embedding이 토큰 사용량을 만들 수 있음

dev mock은 cost 0. 실 provider 전환 시 `chunks/replace`가 token 사용량을 만들기 때문에 master plan §2 결정 19 (org-단위 일일 호출 cap)와 연결해야 한다. 본 step은 cost log조차 없으므로 Phase 5 e2e 전 cost telemetry 추가 필요.

### 6.4 라우트 파일 분할 결정

REST endpoint 21개를 3 라우트 파일에 묶었다.

- `knowledgeBases.ts` — knowledge 도메인 자체 + 외부 adapter(embedding) 주입
- `checklistTemplates.ts` — templates CRUD만 (call 종속 없음)
- `callsPhase5.ts` — call 종속 표면 10개. Phase 4 `calls.ts`는 미수정

Phase 4 `calls.ts`와의 분리 이유: 기존 11 endpoint와 plugin-scoped error handler가 안정되어 있고, Phase 5 표면은 PermissionError·SuggestionStateError 매핑이 추가로 필요. 두 파일에 같은 `setErrorHandler`가 있어도 Fastify는 plugin scope 단위로 격리하므로 충돌 없음 (테스트로 확인).

### 6.5 `phase5routetest-` prefix sweep만으로 cleanup

각 라우트 테스트 파일의 `after()`는 `phase5routetest-` 또는 `phase5wstest-` prefix 기반 sweep만 한다. 좌석 시드 데이터 (admin@acme / emp@acme / admin@beta / emp@beta + customers + memberships) 는 전혀 건드리지 않는다. `_phase5Fixture.mjs` 의 `destroyFixtureUsers()` 가 ephemeral 5 user + 2 team만 정확한 UUID로 삭제 — Phase 4 orphan calls 재발 방지 결정 (memory: report-scope rule) 준수.

### 6.6 `--test-concurrency=1` 의존

`package.json`의 `test` 스크립트가 `--test-concurrency=1` 인 덕분에 각 라우트 테스트 파일이 같은 phase5test 시드 user 풀을 안전하게 공유한다. concurrency 1을 풀면 calls_agent_membership_fk 충돌이 재발한다. 기존 정책 유지가 옳다.

### 6.7 `embedding` 직접 주입 패턴

`knowledgeBasesRoutes(app, { embedding })` 가 옵션으로 EmbeddingAdapter를 받는다. 테스트는 mock을 직접 주입해 deterministic 검증을 보장. 실 server.ts는 `resolveEmbeddingAdapter()` 기본값을 사용 — env 기반 결정. Step 4+ 실 provider 추가 시 `resolveEmbeddingAdapter`만 분기 추가하면 된다.

### 6.8 chunks/replace POST size

`KnowledgeChunkReplaceInput` 에 `z.array(KnowledgeChunkInput).max(2000)` 상한이 있다. Fastify 기본 body 한계 (1 MiB) 안에서 평균 chunk 300 token (영문 1200 byte / 한글 600 byte) 정도까지 안전. 실 운영 ingest는 단일 POST 분할 또는 background ingest worker로 옮길 것 (master plan §2 결정 19 cost cap과 연결).

### 6.9 라우트가 신규 service `persistSuggestionGroup` 노출 안 함

suggestion 생성은 LLM worker / WS 내부 흐름 책임. 외부 REST endpoint 미노출. 본 step의 `phase5_routes_suggestions.test.mjs` 는 `suggestionsRepo.insertGroupForCallInCurrentOrg` 를 직접 호출해 fixture를 깐다 — production endpoint 표면은 그대로 list / use / dismiss 3개만.

---

## 7. Codex Review Focus 응답

| Plan §7 | 결과 |
|---|---|
| 7-1 RLS 정책 변경 없음 | `server/migrations/*` git diff 0 byte |
| 7-2 team-scope는 service layer | 라우트 파일은 `assertCanMutateCall` 호출. RLS 정책 SQL 0 변경 |
| 7-3 `withOrgContext` 사용 | 모든 라우트가 service 또는 `app.withOrgContext` 경유. 직접 `app.pg.query` 0건 |
| 7-4 shared type sync | 14 entity PASS |
| 7-5 adapter 인터페이스 분리 | mock만 구현, 실 provider client 0건 |
| 7-6 innerHTML XSS gate | 라우트는 LLM 응답을 raw로 echo. 프런트가 DOMPurify 책임 (Step 4) |
| 7-7 프런트엔드 미수정 | `platform/live.html` / `calls.html` / `settings.html` git diff 0 byte |
| 7-8 비-목표 준수 | 실 provider client 0, BullMQ worker 0, 새 마이그레이션 0 |
| 7-9 error → HTTP 매핑 | 3 라우트 파일 모두 동일 매핑 적용. 테스트로 ZodError/PermissionError/SuggestionStateError/23503/23505/23514 검증 |
| 7-10 seed cleanup | `phase5routetest-` / `phase5wstest-` prefix. 좌석 사용자/팀/멤버십 미삭제 |

---

## 8. Step 4 (Frontend) 인계

다음 step (Step 4 — Frontend wiring) 가 와이어 할 표면:

### 8.1 settings.html (admin only 화면 추가)

- **회사 가이드 (Knowledge Base)** 패널:
  - `GET /knowledge-bases` / `POST /knowledge-bases` / `PATCH` / `DELETE`
  - `POST /knowledge-bases/:id/chunks/replace` — manual 텍스트 입력을 chunk 단위로 자르고 보낸다. 본 step의 endpoint는 embedding이 비면 자동 생성.
  - 상세 보기는 `GET /knowledge-bases/:id` 가 `{ knowledge_base, chunks }` 를 한번에 반환.
- **상담 체크리스트 템플릿** 패널:
  - `GET /call-checklist-templates` / `POST` / `PATCH` / `DELETE`
  - active / sort_order 토글 UI.

### 8.2 live.html (통화 중 화면)

- **고객 picker 모달**:
  - 시작 시점: `start_call` 시 customerId 전달 (이미 Phase 4에 있음)
  - 통화 중 변경: `POST /calls/:id/link-customer` `{ customer_id }` / `POST /calls/:id/unlink-customer`
- **체크리스트**:
  - 통화 시작 직후 `POST /calls/:id/checklist/initialize` 한번 호출 (idempotent — 재진입해도 안전)
  - 목록 새로고침: `GET /calls/:id/checklist`
  - 토글: `POST /call-checklist-items/:id/status` `{ status: "done" | "open" }`
- **WS heartbeat**:
  - `socket.emit("heartbeat", {}, ack)` 20초 주기. ack가 `call_ended` 면 ping 중단. master plan §2 결정 11.
- **Suggestion 카드**:
  - 라이브 push는 본 step에서 추가하지 않음 (WS suggestion 이벤트는 Phase 0.5 demo replay 그대로). Step 4 가 실 LLM 호출 흐름을 도입할 때 WS 채널이나 SSE로 push.
  - 사용/기각: `POST /call-suggestions/:id/use` / `POST /call-suggestions/:id/dismiss` — 409 conflict_state 처리 필요 (이미 used/dismissed)
  - 이력: `GET /calls/:id/suggestions`

### 8.3 calls.html (통화 detail)

- **수동 요약 작성**: `POST /calls/:id/summary/manual` `{ summary, needs, issues, sentiment }`. summary_source='manual'이 박히면 후속 AI 요약이 덮어쓰지 못함 (검증 케이스 9.8 참조).
- **action item mutation**: Phase 4 endpoint 그대로 사용 (`/calls/:id/action-items` POST + `/call-action-items/:id/status|assignee` POST). Step 4가 detail 패널에 UI만 wire.
- **Suggestion 이력**: `GET /calls/:id/suggestions` — 어떤 추천이 떴고 dismissed_at / used_at 표시.

### 8.4 platform/api.js helpers (제안)

신규 5 helper 패키지:
- `knowledge` — list / get / create / patch / softDelete / replaceChunks / search
- `checklistTemplates` — list / create / patch / delete
- `callChecklist` — initialize / list / markStatus
- `callSuggestions` — list / use / dismiss
- `callSummary` / `callMeta` — manualSummary / linkCustomer / unlinkCustomer / heartbeat-via-WS

### 8.5 innerHTML XSS gate (AGENTS.md)

본 step의 라우트는 LLM-supplied 텍스트 (suggestion title/body, knowledge chunk text) 를 그대로 응답에 echo. Step 4 가 모두 DOMPurify 경유 또는 `textContent` 사용 — `live.html` / `calls.html` / `settings.html` 의 신규 렌더 코드 작성 시 audit 필수.

### 8.6 dev-only 노출 (Phase 5 e2e 대비)

Phase 5 Step 5 (e2e) 가 live.html에서 `window.__liveCallState` 노출을 요구하는 master plan §7 항목 6은 Step 4 작업 영역이다. 본 step에서는 추가 안 함.

### 8.7 실 provider client 도입 시점

본 step 이후, Phase 5 Step 5 (e2e) 직전에:
- `server/src/adapters/stt/clova.ts` + `whisper.ts`
- `server/src/adapters/llm/anthropic.ts` + `openai.ts`
- `server/src/adapters/embedding/openai.ts` + `voyage.ts`
- `server/.env.example` 에 `STT_PROVIDER` / `LLM_PROVIDER` / `EMBEDDING_PROVIDER` / 각 키 var 추가

본 step은 resolver의 throw 분기만 깐 상태. master plan §2 결정 20 (`.env` 미수정) 그대로.

---

## 9. 한 줄 요약

> **Phase 5 외부 어댑터 인터페이스(STT/LLM/Embedding) + mock 구현, REST 신규 21 endpoint, shared types 5 신규 entity(누적 14), WS heartbeat persistence가 추가되어 Step 4 프런트엔드 와이어링이 진입할 표면이 깨끗하게 깔렸다. RLS 정책 변경 0, 프런트엔드 변경 0, 실 provider client 0, server unit tests 301/301 + sync_shared_types 14/14 + phase_4_e2e 8/8 모두 PASS.**

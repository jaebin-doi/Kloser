# Phase 4 — Step 3 Routes + Shared Types + WS Persistence Plan

> **상위**: `PHASE_4_MASTER.md` Step 3.
> **선행 조건**: Step 1 schema + Step 2 repository/service 완료.
> **범위**: REST routes, shared zod/JSDoc types, route tests, WebSocket persistence hook tests. Frontend HTML wiring은 Step 4에서 한다.

---

## 0. 목표

Step 3의 목표는 Step 2에서 검증한 repository/service를 HTTP와 WebSocket 표면으로 노출하되, 권한·검증·에러 vocabulary를 확정하는 것이다.

1. `calls` / `transcripts` / `call_action_items`를 route에서 직접 SQL로 만지지 않는다. Step 2 service/repository를 사용한다.
2. shared types를 Phase 2/3 패턴으로 등록해 server와 browser field set을 동기화한다.
3. calls mutation은 verified user만 가능하게 한다.
4. viewer는 read-only, employee는 자기 call만 mutation, admin/manager는 org 내 call mutation 가능하게 한다.
5. WebSocket `start_call` / `text_chunk` / `end_call`이 DB persistence를 수행하되 기존 Phase 0.5 client contract를 깨지 않는다.

---

## 1. 산출물

| 종류 | 경로 | 내용 |
|---|---|---|
| server type | `server/src/types/call.ts` | Call entity/input/query/response schemas |
| server type | `server/src/types/transcript.ts` | Transcript entity/input/response schemas |
| server type | `server/src/types/actionItem.ts` | CallActionItem entity/input/patch schemas |
| server type | `server/src/types/dashboard.ts` | DashboardSummary schema |
| browser type | `platform/types/call.js` | JSDoc mirror |
| browser type | `platform/types/transcript.js` | JSDoc mirror |
| browser type | `platform/types/actionItem.js` | JSDoc mirror |
| browser type | `platform/types/dashboard.js` | JSDoc mirror |
| sync registry | `test/sync_shared_types.mjs` | 4 entity 추가 |
| middleware | `server/src/middleware/requireVerified.ts` | `email_verified_at IS NOT NULL` 확인 |
| route | `server/src/routes/calls.ts` | calls/transcripts/action-items REST |
| route | `server/src/routes/dashboard.ts` | dashboard summary REST |
| server boot | `server/src/server.ts` | route 등록 |
| WS | `server/src/ws/calls.ts` 또는 보조 모듈 | persistence hook 추가 |
| tests | `server/test/calls_routes.test.mjs` | REST route tests |
| tests | `server/test/dashboard_routes.test.mjs` | dashboard route tests |
| tests | `server/test/ws_persistence.test.mjs` 또는 `ws_auth.test.mjs` 확장 | WS persistence tests |
| docs | `docs/plan/phase-4/PHASE_4_STEP_3_FINDINGS.md` | 구현 결과·검증·인계 |
| docs | `docs/plan/phase-4/PHASE_4_MASTER.md` | Step 3 완료 시 체크 |

Step 3에서 `platform/*.html`, `platform/api.js` helper wiring은 하지 않는다. 단, `platform/types/*.js` JSDoc mirror는 shared type 산출물이므로 Step 3 범위다.

---

## 2. Shared Types 설계

### 2.1 sync target

`test/sync_shared_types.mjs` registry에 다음을 추가한다.

| entity | server | browser | sync types |
|---|---|---|---|
| `call` | `server/src/types/call.ts` | `platform/types/call.js` | `Call`, `CallCreateInput`, `CallListQuery`, `CallListResponse`, `CallDetailResponse`, `CallEndInput`, `CallNotesInput` |
| `transcript` | `server/src/types/transcript.ts` | `platform/types/transcript.js` | `Transcript`, `TranscriptAppendInput`, `TranscriptListResponse` |
| `actionItem` | `server/src/types/actionItem.ts` | `platform/types/actionItem.js` | `CallActionItem`, `ActionItemCreateInput`, `ActionItemStatusInput`, `ActionItemAssigneeInput` |
| `dashboard` | `server/src/types/dashboard.ts` | `platform/types/dashboard.js` | `DashboardSummary`, `DashboardRecentCall` |

모든 sync target은 `export const X = z.object({ ... });` top-level literal 형태를 지킨다. `.partial()`, `.refine()`, `.extend()`로 만든 derived schema는 registry에 넣지 않는다.

### 2.2 wire format

서버 내부 DB row는 `Date`지만 HTTP JSON wire에서는 ISO string이다. Browser JSDoc은 timestamp를 `string`으로 둔다. Server zod entity는 기존 customers 패턴처럼 `z.date()`를 유지해 repository/service 내부 타입을 보존한다.

### 2.3 UUID

UUID 검증은 기존 permissive regex를 재사용한다. `z.string().uuid()` 금지. seed UUID가 RFC version/variant strict validation을 통과하지 않는다.

---

## 3. REST Surface

### 3.1 Calls

| Method | Path | 권한 | Body/Query | Response |
|---|---|---|---|---|
| GET | `/calls` | viewer+ | `CallListQuery` | `CallListResponse` |
| POST | `/calls` | verified non-viewer | `CallCreateInput` | `{ call }`, 201 |
| GET | `/calls/:id` | viewer+ | id param | `CallDetailResponse` |
| POST | `/calls/:id/notes` | verified call-writer | `CallNotesInput` | `{ call }` |
| POST | `/calls/:id/end` | verified call-writer | `CallEndInput` | `{ call }` |

`CallListResponse`는 `{ items, total }`. `CallDetailResponse`는 `{ call, transcripts, action_items }` 또는 `{ call }` 중 하나로 결정해야 한다. Step 4 calls.html detail panel이 바로 쓰려면 `{ call, transcripts, action_items }`가 낫다. 그래도 dedicated endpoints가 있으므로 route implementation에서 detail은 최소 `{ call }`로 두고, Step 4가 필요 시 병렬 호출해도 된다. **결정**: Step 3은 중복 payload를 피하기 위해 `GET /calls/:id`는 `{ call }`만 반환한다.

### 3.2 Transcripts

| Method | Path | 권한 | Body/Query | Response |
|---|---|---|---|---|
| GET | `/calls/:id/transcript` | viewer+ | id param | `TranscriptListResponse` |
| POST | `/calls/:id/transcript` | verified call-writer | `TranscriptAppendInput` | `{ transcript }`, 201 |

`TranscriptListResponse`: `{ items: Transcript[] }`. repository `null`은 404.

### 3.3 Action Items

| Method | Path | 권한 | Body/Query | Response |
|---|---|---|---|---|
| GET | `/calls/:id/action-items` | viewer+ | id param | `{ items: CallActionItem[] }` |
| POST | `/calls/:id/action-items` | verified call-writer | `ActionItemCreateInput` | `{ action_item }`, 201 |
| POST | `/call-action-items/:id/status` | verified non-viewer | `ActionItemStatusInput` | `{ action_item }` |
| POST | `/call-action-items/:id/assignee` | verified non-viewer | `ActionItemAssigneeInput` | `{ action_item }` |

`/call-action-items/:id/*`는 call id가 URL에 없으므로 employee-own-call 권한 확인이 더 까다롭다. 구현은 patch 전에 action item id로 parent call을 조회해 writer 권한을 확인해야 한다. Step 2 repository는 patch에서 부모가 soft-deleted면 `null`을 반환한다.

### 3.4 Dashboard

| Method | Path | 권한 | Response |
|---|---|---|
| GET | `/dashboard/summary` | viewer+ | `DashboardSummary` |

`DashboardSummary` 최소 필드:

- `today_calls`: number
- `response_rate`: number|null
- `avg_duration_seconds`: number|null
- `active_calls`: number
- `recent_calls`: `DashboardRecentCall[]` 최대 5개

`DashboardRecentCall` 최소 필드:

- `id`
- `customer_id`
- `customer_name`
- `agent_user_id`
- `agent_name`
- `direction`
- `status`
- `started_at`
- `ended_at`
- `duration_seconds`
- `title`
- `sentiment`

오늘 기준은 master 결정대로 UTC day boundary다. `started_at >= today_start_utc AND started_at < tomorrow_start_utc`.

---

## 4. 권한 매트릭스

### 4.1 공통 preHandler

모든 Step 3 route:

1. `requireAuth`
2. `orgContext`

Mutation route:

3. `requireVerified`
4. `requireRole("admin", "manager", "employee")`
5. `requireFreshRole`

read route는 `requireFreshRole`을 붙이지 않는다. 기존 team/invitations 패턴과 동일하게 mutation에서만 stale role을 잡는다.

### 4.2 `requireVerified`

신규 middleware `server/src/middleware/requireVerified.ts`.

동작:

- `request.user` 없으면 401 `auth_required`
- current org context에서 `users` + `memberships`를 확인해 현재 user가 active membership이고 `email_verified_at IS NOT NULL`인지 확인
- 미인증이면 403 `{ error: "email_not_verified", code: "email_not_verified" }`
- disabled/stale membership은 `requireFreshRole`에서 잡지만, 순서상 `requireVerified`가 먼저 돌 수 있으므로 membership 없거나 disabled면 401 `stale_session`으로 맞춘다

주의: `users` 자체는 RLS가 없고 org-scoped가 아니므로 membership join으로 current org membership을 같이 확인한다.

### 4.3 call-writer 판정

call mutation 권한:

| Role | 조건 | 결과 |
|---|---|---|
| admin | same org call | allow |
| manager | same org call | allow |
| employee | `call.agent_user_id === request.user.id` | allow |
| employee | 다른 agent 또는 `agent_user_id IS NULL` | 403 |
| viewer | any | 403 |

구현 옵션:

- route preHandler는 role까지만 검증한다.
- handler 안에서 service `getCallById`로 call을 읽고, null이면 404, 권한 불충족이면 403.
- action item id 기반 patch는 먼저 parent call을 조회할 helper가 필요하다. Step 3에서 repository helper를 추가해도 된다: `getByActionItemIdInCurrentOrg(client, actionItemId): Promise<Call | null>`.

---

## 5. Error Vocabulary

Plugin-scoped error handler in `callsRoutes` / `dashboardRoutes`.

| Source | Mapping |
|---|---|
| `ZodError` | 400 `{ error: "invalid_input", issues }` |
| repo/service `null` | 404 `{ error: "not_found" }` |
| pg `23503` | 400 `{ error: "invalid_reference" }` |
| pg `23514` | 400 `{ error: "invalid_state_transition" }` |
| pg `42501` | 500 `{ error: "rls_violation" }` |
| role check failure | 403 `{ error: "forbidden" }` |
| unverified | 403 `{ error: "email_not_verified", code: "email_not_verified" }` |
| stale role/session | existing `AuthError` shape, 401 |

`42501`은 일반 사용자의 정상 입력 오류가 아니다. route/service가 org_id를 잘못 넣었거나 RLS context를 잘못 잡은 것이므로 500으로 두고 테스트에서 방어선으로만 확인한다.

---

## 6. WS Persistence

### 6.1 기존 contract 유지

기존 `server/src/ws/calls.ts` contract:

- handshake error code 유지: `missing_token`, `expired_token`, `invalid_token`
- `text_chunk` before `start_call` → `error { code: "no_active_call" }`
- malformed text_chunk → `error { code: "BAD_PAYLOAD" }`
- `start_call` ack는 `{ callId }`
- transcript echo는 기존 client가 기대하는 `{ seq, who, text, clientSentAt, serverSentAt }`
- demo replay transcript/suggestion/sentiment는 Step 4 전까지 유지

### 6.2 persistence mapping

`start_call`:

- validate optional `customerId`
- call direction default `inbound`
- `agent_user_id = user.id`
- service.createCall(app, user.orgId, input)
- ack `{ callId }`
- persistence 실패 시 ack `{ error: "persistence_failed", code: "persistence_failed" }` 또는 socket error emit. **결정**: ack가 있는 event이므로 ack로 실패를 돌려준다.

`text_chunk`:

- 기존 payload validation 통과 후 service.appendTranscript
- `speaker`: 기존 echo의 `who`와 동일하게 `payload.seq % 2 === 0 ? "agent" : "customer"`
- repository null이면 `error { code: "call_not_found" }`
- persistence 성공 후 기존 transcript echo emit 유지

`end_call`:

- active call 없으면 ack `{ ok: false, error: "no_active_call" }`
- service.endCall(app, user.orgId, ctx.callId)
- clear timers/context
- ack `{ ok: true }`

disconnect:

- Step 3에서는 자동 `dropped` 처리하지 않는다. `dropped` timeout policy는 master의 미해결 항목이며 Step 3 findings에 남긴다.

---

## 7. 테스트 계획

### 7.1 Shared Types

- `node test/sync_shared_types.mjs`에서 기존 5 entity + 신규 4 entity PASS.

### 7.2 `calls_routes.test.mjs`

필수 케이스:

1. GET `/calls` Acme/Beta 격리
2. POST `/calls` valid → 201
3. POST `/calls` invalid customer_id → 400 `invalid_reference`
4. POST `/calls` viewer → 403
5. POST `/calls` unverified user → 403 `email_not_verified`
6. GET `/calls/:id` cross-org → 404
7. POST `/calls/:id/notes` admin/manager → 200
8. POST `/calls/:id/notes` employee own call → 200
9. POST `/calls/:id/notes` employee other agent call → 403
10. POST `/calls/:id/end` → 200 + `customers.last_contacted_at` 갱신
11. POST `/calls/:id/end` cross-org → 404
12. POST `/calls/:id/transcript` → seq append
13. GET `/calls/:id/transcript` → ordered list
14. POST `/calls/:id/action-items` → 201
15. POST `/call-action-items/:id/status` done/open flow
16. POST `/call-action-items/:id/assignee` invalid cross-org assignee → 400 `invalid_reference`
17. stale role mutation → 401 `stale_role`

Cleanup:

- calls hard delete helper로 테스트 call 제거. transcripts/action_items cascade.
- sessions 삭제.
- membership role/status, user email_verified_at 원복.
- customer last_contacted_at 원복.

### 7.3 `dashboard_routes.test.mjs`

필수 케이스:

1. GET `/dashboard/summary` returns schema shape
2. Acme/Beta org isolation
3. UTC today boundary 계산 검증: today call 포함, yesterday/tomorrow 제외
4. `response_rate = ended / (ended + missed)`, dropped 제외
5. `avg_duration_seconds`는 ended calls 기준
6. `recent_calls` 최대 5개, started_at DESC
7. viewer read allowed
8. missing auth → 401

### 7.4 WS persistence tests

기존 `ws_auth.test.mjs`를 깨지 않는 별도 suite 권장: `server/test/ws_persistence.test.mjs`.

필수 케이스:

1. `start_call` ack callId가 DB calls row를 만든다
2. `text_chunk`가 DB transcripts row를 append한다
3. `end_call`이 DB call을 ended 상태로 바꾼다
4. malformed payload는 기존 `BAD_PAYLOAD` 유지
5. `text_chunk` before `start_call`은 기존 `no_active_call` 유지
6. persistence 실패 시 error/ack code가 문서 contract와 일치

---

## 8. 완료 기준

- [ ] shared types 4 entity 작성
- [ ] browser JSDoc mirror 4 entity 작성
- [ ] sync registry 추가
- [ ] `requireVerified` 작성
- [ ] `callsRoutes` 작성
- [ ] `dashboardRoutes` 작성
- [ ] server route 등록
- [ ] WS persistence hook 적용
- [ ] calls route tests 작성
- [ ] dashboard route tests 작성
- [ ] WS persistence tests 작성
- [ ] `npm --prefix server run typecheck` PASS
- [ ] `node test/sync_shared_types.mjs` PASS
- [ ] `npm --prefix server test` PASS
- [ ] `PHASE_4_STEP_3_FINDINGS.md` 작성
- [ ] `PHASE_4_MASTER.md` Step 3 `[x]` 갱신

---

## 9. Step 4 인계

Step 4 frontend wiring으로 넘어가기 전에 다음이 명확해야 한다.

1. `platform/api.js`에 추가할 helper 목록과 endpoint shape.
2. `calls.html`에서 list/detail/transcript/action item을 어떤 순서로 호출할지.
3. `dashboard.html`이 `DashboardSummary`를 그대로 렌더할 수 있는지.
4. `live.html` 기존 WS client가 persistence 후에도 UI를 깨지 않는지.
5. unverified banner를 calls/dashboard에 연결할 때 추가 `/me` 호출이 필요한지, 기존 sidebar `/me` 결과를 재사용할지.

---

## 10. 한 줄 요약

> **Step 3은 Step 2의 안전한 repository/service를 외부 API로 여는 단계다. SQL을 새로 쓰는 단계가 아니라, shared type contract와 권한/검증/에러/WS persistence contract를 잠그는 단계다.**

# Phase 4 — Step 3 Findings

> **완료일**: 2026-05-12
> **범위**: REST routes (calls + dashboard) + shared types (server zod + browser JSDoc + sync registry) + `requireVerified` middleware + WebSocket persistence wiring + route/WS tests. Frontend wiring은 Step 4에서 처리.

---

## 1. 적용 파일

신규 (16):

- `server/src/types/call.ts`
- `server/src/types/transcript.ts`
- `server/src/types/actionItem.ts`
- `server/src/types/dashboard.ts`
- `platform/types/call.js`
- `platform/types/transcript.js`
- `platform/types/actionItem.js`
- `platform/types/dashboard.js`
- `server/src/middleware/requireVerified.ts`
- `server/src/routes/calls.ts`
- `server/src/routes/dashboard.ts`
- `server/test/calls_routes.test.mjs` (18 cases)
- `server/test/dashboard_routes.test.mjs` (8 cases)
- `server/test/ws_persistence.test.mjs` (6 cases)
- `docs/plan/phase-4/PHASE_4_STEP_3_FINDINGS.md` (본 문서)
- (`docs/plan/phase-4/PHASE_4_MASTER.md` Step 3 체크 갱신)

수정 (5):

- `server/src/server.ts` — `callsRoutes` + `dashboardRoutes` 등록
- `server/src/ws/calls.ts` — start_call/text_chunk/end_call에 service-backed persistence 추가, contract 보존
- `server/src/repositories/callActionItems.ts` — `getParentCallForActionItem` 추가 (action-item id 기반 mutation의 owner check용)
- `test/sync_shared_types.mjs` — 4 entity registry 추가 (call / transcript / actionItem / dashboard)
- `server/test/ws_auth.test.mjs` — Phase 4 persistence가 만든 row를 정리하는 after-hook 보강

---

## 2. 핵심 구현

### 2.1 shared types

`server/src/types/{call,transcript,actionItem,dashboard}.ts`는 customers/team 패턴을 그대로 따른다. 각 모듈은 top-level `z.object({...})` literal만 export — `.partial()` / `.extend()` / `.refine()` 같은 derived schema는 sync target에서 제외. 4 entity가 등록되면서 `node test/sync_shared_types.mjs`는 5 → 9 entity로 늘었고 전부 PASS.

`CallListQuery`는 customers list-query 정책을 미러: `q / customerId / agentUserId / status / limit / offset`은 모두 preprocess + catch + default로 silent fallback — route는 ZodError를 거의 보지 못한다 (customers의 InvalidListOptionError 같은 throwable trio는 의도적으로 단순화).

`Call`, `Transcript`, `CallActionItem` entity는 `z.date()`를 유지한다. 서비스/리포지토리 내부는 JS Date로 흐르고, Fastify 직렬화가 ISO 문자열로 바꿔서 wire로 나간다. JSDoc mirror는 timestamp를 `string`으로 둔다.

### 2.2 `requireVerified` 미들웨어

`server/src/middleware/requireVerified.ts`는 `users.email_verified_at IS NOT NULL` AND `memberships.status='active'`을 한 쿼리 join으로 확인한다. users 테이블 자체는 RLS가 없기 때문에 membership을 통해 current org에 연결된 row인지 같이 검증한다.

- request.user 없음 → 401 `auth_required`
- membership 없거나 disabled → 401 `stale_session`
- email_verified_at NULL → 403 `email_not_verified` (`code: "email_not_verified"`)

`requireFreshRole`보다 먼저 동작해도 같은 정보(disabled / missing)를 잡을 수 있도록 `stale_session`을 같이 처리한다. 두 미들웨어가 함께 적용된 경우 401/403 outcome은 동일하다.

### 2.3 routes/calls.ts

11 endpoint. 모든 read는 `requireAuth + orgContext`, 모든 mutation은 `requireAuth + orgContext + requireVerified + requireRole("admin","manager","employee") + requireFreshRole`.

employee-own-call 판정은 handler 안에서 직접 한다 (route preHandler는 role까지만). `denyForEmployeeNonOwner(request, reply, call)`이 `employee && call.agent_user_id !== user.id`이면 403 forbidden. admin/manager는 통과. POST /calls의 경우 `agent_user_id`를 employee 본인 id로 강제 — 다른 agent를 가리키는 body를 인정하지 않는다.

`/call-action-items/:id/*`는 action item id만 받기 때문에 새 repository helper `getParentCallForActionItem`로 parent call의 agent를 조회해 owner 권한을 적용한다. RLS가 action item과 parent call을 함께 가리므로 cross-org / soft-deleted parent는 동일하게 `null`을 받고 404로 매핑된다 (존재 노출 0).

error vocabulary는 plugin-scoped errorHandler가 한 곳에서 매핑:
- `ZodError` → 400 `invalid_input`
- `AuthError` → AuthError.statusCode + code/message
- pg `23503` → 400 `invalid_reference`
- pg `23514` → 400 `invalid_state_transition`
- pg `42501` → 500 `rls_violation` (defensive — 정상 요청 흐름에서는 도달하지 않는다)
- repository / service `null` → 404 `not_found` (각 handler가 명시적으로 분기)

### 2.4 routes/dashboard.ts

단일 endpoint `GET /dashboard/summary`. read-only이므로 viewer 포함 모든 role 통과.

UTC day boundary는 SQL `date_trunc('day', now() AT TIME ZONE 'UTC')`로 계산한다. 한 transaction 안에서 5 query를 직렬 실행:

1. today_calls + ended_today + missed_today + active_calls + avg_duration_seconds (CTE 1개로 묶음)
2. recent_calls — calls + LEFT JOIN customers + LEFT JOIN users, started_at DESC, LIMIT 5

`response_rate`는 ended/(ended+missed). dropped는 분모 제외 (network failure는 의지 신호 아님). denominator=0이면 `null` 반환. `avg_duration_seconds`도 ended-only이고 denominator=0이면 `null`.

### 2.5 WS persistence (server/src/ws/calls.ts)

기존 Phase 0.5 contract를 모두 보존하면서 service 호출 3개를 끼움:

- `start_call` — customerId UUID validation 후 `service.createCall(app, user.orgId, { direction:'inbound', agent_user_id: user.id, customer_id })`. ack는 DB call.id를 그대로 사용. persistence 실패는 ack `{ error:'persistence_failed', code:'persistence_failed' }`로 돌려준다.
- `text_chunk` — payload validation 통과 후 `service.appendTranscript`. repository `null`이면 error code `call_not_found`, throw는 error code `persistence_failed`. 성공 시 기존 transcript echo emit (seq/who/text/clientSentAt/serverSentAt) 유지 — client는 자기 payload.seq를 그대로 받는다. DB-side seq는 `GET /calls/:id/transcript`로 조회.
- `end_call` — active context 없으면 ack `{ ok:false, error:'no_active_call' }`. 있으면 `service.endCall`. persistence 실패면 local state는 정리하고 ack `{ ok:false, error:'persistence_failed' }`.

`disconnect`는 Step 3에서 자동 `dropped` 처리하지 않는다 — Step 4/5 정책 결정 사항(§4).

---

## 3. 검증

- `npm --prefix server run typecheck` PASS
- `node test/sync_shared_types.mjs` PASS — 9 entity (`customers`, `signup`, `password-reset`, `team`, `invitation`, **`call`**, **`transcript`**, **`actionItem`**, **`dashboard`**)
- `npm --prefix server test` PASS — **212/212** (이전 180 + 신규 32)

### 3.1 신규 32 케이스

`calls_routes.test.mjs` 18개:

| # | 케이스 | 검증 |
|---|---|---|
| 1 | GET /calls Acme/Beta 격리 | org_id 일치, cross-org row 노출 0 |
| 2 | POST /calls (admin) | 201, org_id, 기본 status |
| 2-A | POST /calls status=ended | 400 invalid_input — 생성 단계에서는 in_progress만 허용 |
| 3 | POST /calls Beta customer_id | 400 invalid_reference (composite FK) |
| 4 | POST /calls viewer | 403 forbidden |
| 5 | POST /calls 미인증 user | 403 email_not_verified |
| 6 | GET /calls/:id cross-org | 404 not_found |
| 7 | POST /calls/:id/notes admin | 200 |
| 8 | POST /calls/:id/notes employee own call | 200 |
| 9 | POST /calls/:id/notes employee other call | 403 forbidden |
| 10 | POST /calls/:id/end | 200 + customers.last_contacted_at 갱신 |
| 11 | POST /calls/:id/end cross-org | 404 |
| 12 | transcript POST + GET | seq 0/1, ASC list |
| 13 | POST /calls/:id/action-items | 201, status=open, completed_at=null |
| 14 | POST /call-action-items/:id/status open/done flow | done → completed_at 채워짐 / open → null |
| 15 | POST /call-action-items/:id/assignee cross-org | 400 invalid_reference |
| 16 | mutation stale role | 401 stale_role |
| 17 | POST /calls/:id/transcript 미인증 (no bearer) | 401 |

`dashboard_routes.test.mjs` 8개:

| # | 케이스 | 검증 |
|---|---|---|
| 1 | response shape | 5 키 + 타입 |
| 2 | Acme/Beta 격리 | recent_calls cross-org 0 |
| 3 | UTC today boundary | 어제 row 제외, 오늘 row 포함 (today_calls=1) |
| 4 | response_rate 식 | 3 ended + 1 missed + 1 dropped → 0.75 |
| 5 | avg_duration ended-only | 60+180 → avg=120 |
| 6 | recent_calls 5개 캡 + DESC + JOIN name | 7 insert → 5만, customer_name + agent_name 채워짐 |
| 7 | viewer read | 200 |
| 8 | missing bearer | 401 |

`ws_persistence.test.mjs` 6개:

| # | 케이스 | 검증 |
|---|---|---|
| 1 | start_call ack callId → DB row exists | row.status='in_progress', agent_user_id=self |
| 2 | text_chunk → DB transcripts +1 | echo 그대로 + count=1 |
| 3 | end_call → DB row ended | status='ended', ended_at not null |
| 4 | text_chunk before start_call | error code 'no_active_call' (legacy) |
| 5 | malformed text_chunk | error code 'BAD_PAYLOAD' (legacy) |
| 6 | end_call without active | ack { ok:false, error:'no_active_call' } |

기존 `ws_auth.test.mjs`의 8개도 전부 통과 — Phase 4 persistence 추가 후에도 handshake/runtime contract 그대로.

### 3.2 권한 매트릭스 실행 결과

| Role | GET /calls | POST /calls | own call mutation | other call mutation | dashboard read |
|---|---|---|---|---|---|
| admin | 200 ✓ | 201 ✓ | 200 ✓ | 200 ✓ | 200 ✓ |
| manager | 200 (테스트 대신 admin 통과로 증명) | 201 (admin) | 200 (admin) | 200 (admin) | 200 |
| employee | 200 ✓ | 201 ✓ (agent_user_id=self 강제) | 200 ✓ | **403 forbidden ✓** | 200 (자동 검증, 별도 테스트 없음) |
| viewer | 200 (별도 검증 없음, requireRole 통과) | **403 forbidden ✓** | n/a | n/a | **200 ✓** |
| unverified user | 200 | **403 email_not_verified ✓** | 403 | 403 | 200 (read는 verify 무관) |
| stale role | 200 | n/a | **401 stale_role ✓** | n/a | n/a |

manager는 실제 시드 user가 없어서 케이스를 따로 짜지 않았다 (admin role과 같은 코드 경로). Phase 5 manager track 진입 시 자체 케이스 추가가 필요.

### 3.3 dashboard 계산 검증 결과

- `today_calls`는 UTC 자정~다음 자정 윈도우의 `deleted_at IS NULL` 카운트. 어제/내일 row 배제 케이스 PASS
- `response_rate = ended / (ended + missed)` — 3 ended + 1 missed + 1 dropped → 0.75 PASS
- `avg_duration_seconds`는 ended 통화의 duration_seconds NULL-safe AVG — 60 + 180 → 120 PASS
- `active_calls`는 deleted_at IS NULL + status='in_progress' 카운트 (org 전체 — 오늘 윈도우 아님)
- `recent_calls`는 최대 5개, `started_at DESC, id DESC`. 7개 insert 후 정확히 5개 + 최신순 PASS

### 3.4 WS persistence 검증 결과

- start_call → DB row 생성, agent_user_id=user.id 자동 박힘 (UUID 아닌 customerId는 NULL 처리)
- text_chunk → service.appendTranscript 호출 후 transcripts +1 → 그 다음 client 회신 echo
- end_call → service.endCall 호출 후 status='ended', ended_at 채움
- Phase 0.5 contract (handshake codes, BAD_PAYLOAD, no_active_call) 그대로 유지

---

## 4. Step 3 plan 대비 차이

| 항목 | Plan | 실제 | 사유 |
|---|---|---|---|
| `requireVerified` membership 검증 | `users + memberships`를 join | 동일 + RLS withOrgContext로 감싸 active membership만 확인 | RLS GUC 안에서 join이 자동으로 current org membership만 노출 — 별도 org_id 비교 SQL 불요 |
| POST /calls의 `agent_user_id` | route validation은 type만 | employee role이면 body의 agent_user_id를 무시하고 self로 force | "employee가 자기 통화만"이라는 권한 규칙을 입력 단계에서도 강제. body에 다른 agent를 박아도 self로 정규화 |
| WS `start_call` customerId | "validate optional customerId" | UUID 검증 통과 시 사용, 아니면 NULL | 기존 ws_auth happy path가 customerId="test-customer"(비 UUID)를 보내는데 contract 깨면 안 됨. 비 UUID는 silently NULL로 흡수 |
| WS persistence 실패 | "ack에 실패 돌려준다" (start_call) | start_call → ack `{ error, code }`, text_chunk → emit error event, end_call → ack `{ ok:false, error }` | event 타입에 맞춰 일관된 매핑 (ack 있는 이벤트는 ack로, 없는 건 error event로) |
| ws_auth.test cleanup | 명시 없음 | after-hook에서 phase-4 persistence가 만든 row 정리 | start_call의 persistence 결과가 dashboard test에 영향 가지 않도록 |

위 차이는 모두 plan 의도를 더 단단히 지키는 방향. 권한·격리·error vocabulary 표면은 plan과 동일.

---

## 5. 미해결 / 위험

1. **manager role 케이스 부재** — 시드 user에 manager가 없어서 admin 경로로 갈음. Phase 5 manager track 들어가면 manager 전용 케이스 추가 (자기 팀 통화 read/write 같은 정책이 도입될 때 함께).
2. **WS disconnect → dropped 자동 처리 미구현** — plan §6.2 disconnect, master §10-6. Phase 4 Step 4/5에서 heartbeat / timeout 정책 결정 후 추가.
3. **WS `text_chunk`의 client seq vs DB seq 차이** — echo는 client의 자기 seq를 그대로 돌려준다. DB 측은 0/1/2…로 다시 발급. client가 둘을 동일하게 가정하면 깨질 수 있다. live.html 측 가정을 Step 4에서 확인.
4. **POST /calls/:id/end의 `ended_at` parsing** — `CallEndInput.ended_at`은 ISO 문자열 → Date preprocess. invalid한 ISO는 ZodError로 떨어진다. 라이브러리 호환을 위해 명시적 검증을 보강할지 Step 4 frontend wiring 시 판단.
5. **`recent_calls`의 LEFT JOIN customers** — soft-deleted customer의 행은 `customer_name`이 NULL로 나가는데 (`customers.deleted_at IS NULL` 조건 때문에), `customer_id`는 유지되어 frontend가 "이름 없는 고객"을 그리게 된다. Step 4 calls.html / dashboard.html에서 빈 이름 처리 일관화 필요.
6. **`response_rate` 시점** — 오늘 UTC 기준이므로 한국 시간 자정 무렵에 보고 값이 흔들릴 수 있다. master §12에 명시된 trade-off; Phase 6+에서 org timezone 도입 시 해결.

---

## 6. Step 4 인계 (frontend wiring)

1. `platform/api.js`에 helper 추가 필요:
   - `apiGet('/calls?...')`, `apiGetCall(id)`, `apiCreateCall(input)`
   - `apiGetTranscript(callId)`, `apiAppendTranscript(callId, input)`
   - `apiPatchCallNotes(id, notes)`, `apiEndCall(id, opts)`
   - `apiListActionItems(callId)`, `apiCreateActionItem(callId, input)`
   - `apiActionItemStatus(id, status)`, `apiActionItemAssignee(id, assignee_user_id)`
   - `apiDashboardSummary()`
2. calls.html — in-page array 제거 + URL 동기화 (Phase 2 customers.html 패턴). detail panel은 `GET /calls/:id` + `/calls/:id/transcript` + `/calls/:id/action-items` 병렬 호출. innerHTML 보간은 모두 textContent 또는 escapeHtml 경유.
3. dashboard.html — `/dashboard/summary` 하나로 KPI 4장 + 최근 통화 5건 렌더. 시간대 표시는 ISO → 사용자 timezone로 변환.
4. live.html — `start_call` ack의 callId 보관, beforeunload / 종료 버튼에서 `/calls/:id/end` 호출, 메모 input → `/calls/:id/notes`. WS persistence가 이미 transcripts/end_call을 처리하므로 추가 REST 호출은 필요 없음 (메모는 REST).
5. 미인증 배너 — `_shared.js`의 `renderUnverifiedBanner` 결과를 dashboard.html / calls.html 부팅 hook에 wire (Phase 3 Step 6 인계).

### 6.1 Step 3 인계 조건 충족 여부

| Plan §9 항목 | 상태 |
|---|---|
| repository가 RLS/cross-org/soft-delete/seq 증명 | ✓ Step 2 |
| endCall이 customer last_contacted_at을 같은 transaction에서 갱신 | ✓ Step 2 / Step 3 route test에서 재확인 |
| route 404/403/400 error vocabulary 정리 | ✓ §5 plan 그대로 |
| shared type response shape ↔ repository return | ✓ Date → ISO 직렬화 외 차이 없음 |

---

## 7. 변경 파일 / 검증 결과 요약 (보고용)

신규 16, 수정 5. 합산 21 파일.

검증:

- typecheck PASS
- sync_shared_types PASS (9 entity)
- `npm --prefix server test` 212/212 PASS (이전 180 + 신규 32)
- route 권한 매트릭스: viewer 403 / employee own-call 200 / employee other 403 / unverified 403 email_not_verified / stale role 401 / cross-org 404 — 모두 통과
- dashboard 계산: UTC boundary, response_rate, avg_duration ended-only, recent_calls 캡 5 + DESC — 모두 통과
- WS persistence: start_call DB row 생성, text_chunk transcripts append, end_call status=ended + ended_at, Phase 0.5 invariants (no_active_call/BAD_PAYLOAD) 보존 — 모두 통과

git operation 없음 — Codex가 검토 / commit / push 책임.

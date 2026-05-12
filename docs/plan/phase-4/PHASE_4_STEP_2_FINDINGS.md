# Phase 4 — Step 2 Findings

> **완료일**: 2026-05-12
> **범위**: repository + service + unit tests only. Routes / shared types / WS persistence / frontend는 Step 3+에서 처리.

---

## 1. 적용 파일

신규:

- `server/src/repositories/calls.ts`
- `server/src/repositories/transcripts.ts`
- `server/src/repositories/callActionItems.ts`
- `server/src/services/calls.ts`
- `server/test/calls_repo.test.mjs` (18 cases)
- `server/test/calls_service.test.mjs` (7 cases)

문서 수정:

- `docs/plan/phase-4/PHASE_4_MASTER.md` Step 2 체크박스 `[x]` + 결과 요약
- `docs/plan/phase-4/PHASE_4_STEP_2_FINDINGS.md` (본 문서)

---

## 2. 핵심 구현

### 2.1 calls repository

`server/src/repositories/calls.ts`는 customers 패턴을 그대로 따른다. 모든 read/write는 `withOrgContext` 안에서 도는 client만 받고, RLS 정책이 org 격리를 책임진다. 차이점은 calls 고유의 두 가지 surface:

1. `endByIdInCurrentOrg(client, id, endedAt, finalStatus)` — `status`, `ended_at`, `duration_seconds`를 같은 `UPDATE`에서 atomic하게 set. `duration_seconds`는 `GREATEST(0, EXTRACT(EPOCH FROM (ended_at - started_at))::int)` — clock skew나 data fix로 `ended_at < started_at`이 되어도 CHECK constraint (`>= 0`) 위반 없이 0으로 정착한다.
2. `lockByIdInCurrentOrg(client, id)` — `FOR UPDATE` 행 잠금. transcripts append와 action item create / endCall이 같은 call을 동시에 건드릴 때 calls row 잠금이 single serialization point가 된다 (Step 2 plan §2-6 lock order).

soft delete는 customers와 동일하게 `WHERE deleted_at IS NULL` 부분 필터 + 부분 인덱스로 끝난다. read API는 cross-org / soft-deleted / missing을 모두 `null`로 표현해 라우트가 일관된 404를 매핑할 수 있다 (Step 2 plan §2-4).

### 2.2 transcripts repository

`appendForCallInCurrentOrg`은 같은 transaction 안에서:

1. `SELECT id, org_id FROM calls WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`
2. row가 없으면 `null` (cross-org / soft-deleted / missing 모두 같은 출력)
3. `SELECT COALESCE(MAX(seq)+1, 0)::int FROM transcripts WHERE call_id=$1`
4. `INSERT ... RETURNING ...` — `org_id`는 1번에서 읽은 calls.org_id를 그대로 박는다 (drift 차단)

call row를 `FOR UPDATE`로 잠그는 시점이 seq 발급의 race 차단 지점이다. 같은 call에 대한 동시 append는 calls row lock에서 직렬화되고, 다른 call append는 서로 막지 않는다.

`listByCallInCurrentOrg` / `countByCallInCurrentOrg`은 calls.exists 선행 확인 후 transcripts SELECT — call 자체가 없는 경우와 call은 있지만 transcripts가 0건인 경우를 `null` vs `[]`로 구분한다. routes가 404 vs 200을 직접 매핑할 수 있게.

### 2.3 callActionItems repository

CHECK `((status='done' AND completed_at IS NOT NULL) OR (status<>'done' AND completed_at IS NULL))`이 status와 timestamp의 일관성을 DB 레벨에서 강제한다. repository의 `patchStatusInCurrentOrg`는 단일 UPDATE에서 status와 completed_at을 동시에 set:

- `done` → `status='done', completed_at=now()`
- `open` / `dropped` → `status=$1, completed_at=NULL`

CHECK이 transient mismatch (status는 바뀌었는데 completed_at은 아직 안 바뀐 순간)도 거부하기 때문에 두 컬럼은 항상 같은 UPDATE에 묶어야 한다.

cross-org assignee는 `(org_id, assignee_user_id) REFERENCES memberships(org_id, user_id)` composite FK가 23503으로 차단한다 (Step 1 Codex 보강 사항). repository는 사전 검사 없이 raw error를 그대로 올린다.

### 2.4 calls service

`server/src/services/calls.ts`는 transaction boundary 역할만 한다. `app.withOrgContext(actorOrgId, fn)` 한 번에 묶어서 RLS context를 set + DB 작업 + commit / rollback을 한 단위로 만든다.

`endCall`이 가장 큰 단위 합성:

1. `callsRepo.endByIdInCurrentOrg(client, callId, endedAt, finalStatus)` — `null`이면 그대로 return (cross-org / soft-deleted / missing)
2. `customer_id`가 있으면 같은 client로 `UPDATE customers SET last_contacted_at = GREATEST(COALESCE(last_contacted_at, 'epoch'::timestamptz), $1) WHERE id=$2 AND deleted_at IS NULL`
3. `withOrgContext`가 commit. 둘 중 하나가 throw하면 둘 다 rollback.

`GREATEST + COALESCE` 패턴이 monotonic 보장. 더 옛 통화가 늦게 종료 처리돼도 `last_contacted_at`은 뒤로 가지 않는다. `customer_id=NULL` (unknown caller)이면 customers UPDATE는 skip — Step 2 plan §2-11.

---

## 3. 검증

### 3.1 자동 테스트

- `npm --prefix server run typecheck` PASS
- `node test/sync_shared_types.mjs` PASS (5 entity, Phase 4 신규 entity는 아직 sync 대상 아님 — Step 3에서 추가)
- `npm --prefix server test` PASS — **180/180** (이전 155 + Phase 4 Step 2 신규 25)

### 3.2 신규 25 테스트 케이스

`calls_repo.test.mjs` 18개:

| # | 케이스 | 검증 |
|---|---|---|
| 1 | bare pool SELECT | RLS forced — GUC 없는 connection은 0행 |
| 2 | Acme insert + list + get round-trip | 정상 흐름 |
| 3 | Beta가 Acme call을 read / patch / end / softDelete | 모두 `null` / `false` |
| 4 | Acme context + insertInCurrentOrg(client, ORG_BETA, …) | 42501 |
| 5 | Acme call + Beta customer_id | 23503 (composite FK) |
| 6 | Acme call + Beta agent_user_id | 23503 (composite FK) |
| 7 | softDelete hides + idempotent | true → false |
| 8 | 직렬 append → seq 0, 1, list ASC | seq 자동 발급 |
| 9 | 다른 org에서 append | `null` |
| 10 | 직접 INSERT `(beta org_id, acme call_id)` | 23503 (composite FK) |
| 11 | **Promise.all 동시 append × 2 → seqs `[0,1]`** | seq race 차단 (FOR UPDATE) |
| 12 | calls hard delete → transcripts cascade | cascade 동작 |
| 13 | action item create | status=open, completed_at=null |
| 14 | status flow open→done→open→dropped | CHECK 통과, completed_at 일관 |
| 15 | 부모 call soft-delete 후 action item status/assignee patch | `null`, parent soft delete 표면 유지 |
| 16 | raw INSERT done w/o completed_at | 23514 |
| 17 | Acme call + Beta assignee_user_id | 23503 (composite FK) |
| 18 | 다른 org에서 action item create / list | `null` |

`calls_service.test.mjs` 7개:

| # | 케이스 | 검증 |
|---|---|---|
| 1 | endCall 정상 종료 | status=ended, ended_at, duration_seconds (≥55s) |
| 2 | endCall + 고객 last_contacted_at 갱신 | endedAt으로 정확히 이동 |
| 3 | endCall + monotonic | 미래 stamp 시드 → 옛 endedAt → 시드값 유지 |
| 4 | customer_id NULL endCall | 고객 row untouched |
| 5 | cross-org endCall | `null`, 원본 call still in_progress |
| 6 | **withOrgContext rollback** | endByIdInCurrentOrg 호출 후 throw → ROLLBACK → call이 여전히 in_progress |
| 7 | createCall + listCalls + getCallById | round-trip |

case 11 (동시 seq), case 6 (rollback), customer timestamp 3종 (case 2/3/4)이 Step 2 plan §0 다섯 가지 불변식의 핵심 증명이다.

---

## 4. Step 2 plan 대비 차이

| 항목 | Plan | 실제 | 사유 |
|---|---|---|---|
| Entity / input types 위치 | (암묵) Step 3에서 shared types로 | repository 모듈 내부 inline export | Step 2 산출물에 `server/src/types/*`가 명시적으로 빠져 있고, "shared types 만들지 마" 사용자 지시 + AGENTS.md Phase Workflow §3. Step 3에서 zod 원본 + JSDoc 사본 + sync registry로 이동 시 import 경로만 바뀐다 |
| `last_contacted_at` 조건 | `WHERE id = $2` (RLS가 org 강제) | 동일 + `AND deleted_at IS NULL` | soft-deleted 고객은 갱신 대상 아님. RLS는 org 격리만 책임 |
| rollback 테스트 형태 | service.endCall 내부에서 customer update 실패 유도 | service 외부 transaction에서 `endByIdInCurrentOrg` 호출 후 throw 시뮬레이션 | endCall 자체에 test-only throw point를 박지 않기 위해. `withOrgContext`가 commit-or-rollback 단일 단위라는 점은 동일 플러그인 위에서 같은 메커니즘이므로 service.endCall에도 그대로 적용된다 |
| action item parent soft delete | 명시 없음 | status/assignee patch도 부모 call이 `deleted_at IS NULL`일 때만 허용 | calls soft delete가 자식 row를 cascade하지 않으므로, item id만 아는 caller가 soft-deleted call의 후속 액션을 계속 바꾸는 구멍을 Codex review에서 차단 |

차이 4건 모두 endCall의 contract를 약화시키지 않는다. shared types 이동은 Step 3 일정 안에서 무리 없이 처리 가능.

---

## 5. 보안 / 격리 증명 (요약)

Step 1 schema가 RLS + composite FK + CHECK으로 깐 가드 레일을 Step 2 unit test가 명시적으로 두드려서 모두 작동하는지 확인했다:

- **RLS SELECT 격리** — bare pool / cross-org read 모두 0행 (case 1, 3)
- **RLS WITH CHECK** — cross-org INSERT는 42501 (case 4)
- **Composite FK** — cross-org customer / agent / assignee / call_id+org_id 조합은 23503 (case 5, 6, 10, 17)
- **CHECK** — status=done w/o completed_at은 23514 (case 16)
- **Parent soft delete** — soft-deleted call의 action item patch는 `null` (case 15)
- **부모-자식 cascade** — calls hard delete → transcripts cascade (case 12)
- **Soft delete** — list / get / patch / end / softDelete 모두 `WHERE deleted_at IS NULL` 적용 (case 7)
- **seq 동시 발급** — FOR UPDATE row lock으로 직렬화, seq 충돌 0 (case 11)
- **Transaction atomicity** — `withOrgContext` throw 시 ROLLBACK 정상 (case 6 / service test 6)

route 레이어가 라우팅·인증·검증만 더하면 본 가드는 그대로 운영 데이터 흐름의 RLS 표면이 된다.

---

## 6. Step 3 인계

### 6.1 routes에서 결정할 사항

1. **error vocabulary** — repository / service가 `null` / `boolean` / raw error code를 반환한다. routes가 다음을 매핑해야 한다:
   - `null` → 404 `not_found`
   - 42501 → 403 또는 500 (RLS bypass 시도이므로 통상 500 — defense in depth가 발동했다는 신호)
   - 23503 → 400 `invalid_reference` (잘못된 customer_id / agent / assignee)
   - 23514 → 400 `invalid_state_transition` (action item status mismatch)
   - `lockByIdInCurrentOrg` deadlock (40P01) → 409 또는 503 retry
2. **권한 매트릭스** — master §4. employee의 `POST /calls/:id/end`는 `calls.agent_user_id === actorUserId` 검증 후 403. admin/manager는 무관.
3. **transcripts list response shape** — Step 2 repository return은 `Transcript[] | null`. Step 3 zod는 `{ items: Transcript[] }`로 감쌀 가능성 — sync_shared_types와 일관 유지.
4. **`q` 검색 범위** — Step 2는 calls 단독 검색 (`title`, `notes`, `summary`). Step 3에서 customer name/company JOIN 추가 여부 결정.

### 6.2 shared types 등록 (Step 3 Phase Workflow §3)

`server/src/types/`에 4개 zod 모듈 + `platform/types/`에 JSDoc 사본 + `test/sync_shared_types.mjs` registry 4행 추가:

- `call.ts` — Call entity / CallCreateInput / CallListQuery / CallStats (master §3 sync target)
- `transcript.ts` — Transcript / TranscriptAppendInput / TranscriptListResponse
- `actionItem.ts` — CallActionItem / ActionItemCreateInput / ActionItemPatchInput
- `dashboard.ts` — DashboardSummary

repository entity / input type을 그대로 zod schema로 옮기면 무리 없음. preprocess 자리는 customers 패턴 참고.

### 6.3 WS persistence (Step 3)

`server/src/ws/persistence.ts`는 본 service를 그대로 사용해야 한다. WS `start_call` → `service.createCall`, `text_chunk` → `service.appendTranscript`, `end_call` → `service.endCall`. WS handler가 별도 SQL 짜지 않는다 — service가 단일 단위 트랜잭션 책임자.

### 6.4 미해결 / 위험

- **seq lock 충돌 시 503/429 처리**: 현 구현은 PostgreSQL이 row lock을 자동 직렬화한다. lock wait timeout으로 인한 40P01은 발생하지 않을 정도로 짧은 transaction이지만, Step 3 route에서 에러 vocabulary에 추가할지 결정 필요.
- **direction='meeting' 통화의 transcript 의미**: 시드/UI mock은 outbound/inbound 위주. meeting 통화에 transcripts append를 허용할지는 Step 3 route layer에서 정책 결정 (현재 schema는 허용).
- **action item assignee가 비활성 멤버**: composite FK는 membership 행이 살아 있기만 하면 OK. `memberships.status='disabled'` 사용자에게 assignee 박을 수 있다. Step 3에서 service / route 레벨 정책으로 차단할지 결정.
- **`q` substring index**: 현재 `(lower(coalesce(title,'')) LIKE $1 OR ...)`은 leading-`%` 패턴이라 seq scan. 시드 데이터 규모에서는 무해하지만 운영 규모에서는 trigram (`pg_trgm`) 또는 GIN을 고려 (Phase 6+).

---

## 7. 변경 파일 / 검증 결과 요약 (보고용)

신규 (6):

- `server/src/repositories/calls.ts`
- `server/src/repositories/transcripts.ts`
- `server/src/repositories/callActionItems.ts`
- `server/src/services/calls.ts`
- `server/test/calls_repo.test.mjs`
- `server/test/calls_service.test.mjs`

수정 (2):

- `docs/plan/phase-4/PHASE_4_MASTER.md` (Step 2 체크박스)
- `docs/plan/phase-4/PHASE_4_STEP_2_FINDINGS.md` (신규 본 문서로 분류)

검증:

- typecheck PASS
- sync_shared_types PASS (5 entity, Phase 4는 Step 3에서 등록)
- `npm --prefix server test` 180/180 PASS (이전 155 + 신규 25)
- 동시 seq append (Promise.all × 2) → 정확히 [0, 1]
- withOrgContext rollback 시뮬레이션 PASS

git operation 없음 — Codex가 검토 / commit / push.

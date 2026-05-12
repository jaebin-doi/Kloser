# Phase 4 — Step 2 Repository + Unit Tests Plan

> **상위**: `PHASE_4_MASTER.md` Step 2.
> **선행 조건**: Step 1 schema 완료 (`calls` / `transcripts` / `call_action_items` + RLS FORCE + composite FK + app grants).
> **범위**: repository layer + service transaction 초안 + unit tests. Route/shared types/frontend는 Step 3/4에서 처리한다.

---

## 0. 목표

Step 2의 목표는 Phase 4 신규 테이블 3개가 실제 코드에서 안전하게 쓰이는지 증명하는 것이다. 단순 CRUD가 아니라 다음 불변식을 repository/test 레벨에서 고정한다.

1. RLS는 `app.withOrgContext(orgId, fn)` 안에서만 열린다.
2. cross-org ID는 존재를 노출하지 않고 `null` / `false` / 404로 이어질 수 있는 값으로 숨긴다.
3. Step 1 composite FK는 우회하지 않는다. 다른 org customer/user/call 참조는 DB가 막아야 한다.
4. transcript append는 같은 call 안에서 seq 충돌이 없어야 한다.
5. call 종료는 `calls` update와 `customers.last_contacted_at` update가 같은 transaction에서 일어난다.

---

## 1. 산출물

| 종류 | 경로 | 내용 |
|---|---|---|
| repository | `server/src/repositories/calls.ts` | calls list/get/create/notes/end/soft-delete |
| repository | `server/src/repositories/transcripts.ts` | transcript append/list/count |
| repository | `server/src/repositories/callActionItems.ts` | action item create/list/patch status/patch assignee |
| service | `server/src/services/calls.ts` | org context transaction boundary + endCall orchestration |
| test | `server/test/calls_repo.test.mjs` | calls + transcripts + action items repo tests |
| test | `server/test/calls_service.test.mjs` | endCall transaction + customer timestamp tests |
| docs | `docs/plan/phase-4/PHASE_4_STEP_2_FINDINGS.md` | 구현 결과, 검증, 인계 |
| docs | `docs/plan/phase-4/PHASE_4_MASTER.md` | Step 2 완료 시 checkbox 갱신 |

Step 2에서는 `server/src/routes/*`, `server/src/types/*`, `platform/*`를 만들지 않는다. 그 파일들은 Step 3/4 범위다.

---

## 2. 사전 결정

| # | 항목 | 결정 | 근거 |
|---|---|---|---|
| 2-1 | repository 함수 입력 | request body 원형을 받지 않고 typed argument만 받는다 | parsing/validation은 Step 3 shared zod + route layer 책임 |
| 2-2 | org scope 방식 | repository SQL은 `org_id = current_app_org_id()`를 직접 쓰지 않는다. caller가 `withOrgContext`로 GUC를 설정한다 | Phase 2 `customers.ts` 패턴과 일관. RLS 정책이 권위 |
| 2-3 | INSERT org_id | `insertInCurrentOrg(client, orgId, input)`처럼 orgId를 별도 인자로 받는다 | body org_id 주입 차단 + RLS WITH CHECK 재검증 |
| 2-4 | cross-org read/write | `get/update/end/softDelete/listByCall`은 cross-org id에 대해 `null` 또는 `false` | route에서 404로 매핑할 수 있게 존재 노출 차단 |
| 2-5 | transcript seq 발급 | 같은 transaction 안에서 대상 `calls` row를 `FOR UPDATE`로 잠근 뒤 `COALESCE(MAX(seq)+1, 0)` 산출 | 별도 counter table 없이 통화 단위 append를 serialization. 동시 append 테스트로 증명 |
| 2-6 | lock 순서 | transcript append, endCall, action item create가 같은 call을 다룰 때 항상 calls row lock을 먼저 잡는다 | deadlock 가능성 축소 |
| 2-7 | calls soft delete | `calls.deleted_at = now()`만 수행. transcripts/action items는 hard cascade하지 않는다 | Step 1 설계대로 calls만 soft delete. read query에서 calls.deleted_at 필터 |
| 2-8 | endCall status | service `endCall`은 기본적으로 `ended`를 set한다. `missed`/`dropped`는 repository primitive는 허용하되 Step 3 route/WS 정책에서 제한 | disconnect/timeout 정책은 Step 3 WS persistence에서 확정 |
| 2-9 | duration 계산 | `duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM (ended_at - started_at))::int)` | clock skew/data fix 방어. CHECK 위반 방지 |
| 2-10 | last_contacted_at | `GREATEST(COALESCE(last_contacted_at, 'epoch'), ended_at)` | 오래된 call 종료 재처리로 timestamp가 뒤로 가지 않게 함 |
| 2-11 | customer_id NULL | endCall에서 customer_id가 NULL이면 customers update 생략 | unknown caller 케이스 |
| 2-12 | action item 완료 | repository가 `status='done'`이면 `completed_at`도 같은 SQL에서 채운다. open/dropped이면 `completed_at = NULL` | DB CHECK와 service 의미 일치 |

---

## 3. Repository API 초안

### 3.1 `server/src/repositories/calls.ts`

```ts
export interface CallCreateInput {
  customer_id?: string | null;
  agent_user_id?: string | null;
  direction: "inbound" | "outbound" | "meeting";
  status?: "in_progress" | "ended" | "missed" | "dropped";
  title?: string | null;
  notes?: string | null;
}

export interface CallListOptions {
  limit: number;
  offset: number;
  q?: string;
  customerId?: string | null;
  agentUserId?: string | null;
  status?: "in_progress" | "ended" | "missed" | "dropped";
}

export async function listForCurrentOrg(client, opts): Promise<Call[]>;
export async function countForCurrentOrg(client, opts): Promise<number>;
export async function getByIdInCurrentOrg(client, id): Promise<Call | null>;
export async function insertInCurrentOrg(client, orgId, input): Promise<Call>;
export async function patchNotesByIdInCurrentOrg(client, id, notes): Promise<Call | null>;
export async function endByIdInCurrentOrg(client, id, endedAt, finalStatus): Promise<Call | null>;
export async function softDeleteByIdInCurrentOrg(client, id): Promise<boolean>;
export async function lockByIdInCurrentOrg(client, id): Promise<Call | null>;
```

SQL 원칙:
- 모든 read는 `WHERE deleted_at IS NULL`.
- list는 기본 `ORDER BY started_at DESC, id DESC`.
- `q`는 title/summary/notes/customer name/company 정도까지 확장 가능하지만 Step 2에서는 calls table 단독 검색으로 제한해도 된다. customer join 검색은 Step 3 route plan에서 결정 가능.
- `endByIdInCurrentOrg`는 `WHERE id=$1 AND deleted_at IS NULL`로 제한하고 `RETURNING`으로 고객 update에 필요한 `customer_id`, `ended_at`을 돌려준다.

### 3.2 `server/src/repositories/transcripts.ts`

```ts
export interface TranscriptAppendInput {
  speaker: "agent" | "customer" | "system";
  text: string;
  start_ms?: number | null;
  end_ms?: number | null;
  confidence?: number | null;
}

export async function appendForCallInCurrentOrg(client, callId, input): Promise<Transcript | null>;
export async function listByCallInCurrentOrg(client, callId): Promise<Transcript[] | null>;
export async function countByCallInCurrentOrg(client, callId): Promise<number | null>;
```

`appendForCallInCurrentOrg` 절차:

1. `SELECT id, org_id FROM calls WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`
2. row가 없으면 `null`
3. `SELECT COALESCE(MAX(seq)+1, 0)::int FROM transcripts WHERE call_id=$1`
4. `INSERT INTO transcripts (org_id, call_id, seq, speaker, text, start_ms, end_ms, confidence) ... RETURNING ...`

`FOR UPDATE` 대상은 calls row다. 같은 call에 대한 동시 append는 같은 row lock에서 직렬화되고, 다른 call append는 서로 막지 않는다.

### 3.3 `server/src/repositories/callActionItems.ts`

```ts
export interface ActionItemCreateInput {
  title: string;
  due_date?: string | null;
  assignee_user_id?: string | null;
}

export async function createForCallInCurrentOrg(client, callId, input): Promise<CallActionItem | null>;
export async function listByCallInCurrentOrg(client, callId): Promise<CallActionItem[] | null>;
export async function patchStatusInCurrentOrg(client, id, status): Promise<CallActionItem | null>;
export async function patchAssigneeInCurrentOrg(client, id, assigneeUserId): Promise<CallActionItem | null>;
```

`createForCallInCurrentOrg`는 먼저 calls row를 확인한다. 없는 call이면 `null`. 다른 org call은 RLS로 보이지 않으므로 역시 `null`.

`patchStatusInCurrentOrg`:
- `done` → `status='done', completed_at=now()`
- `open` 또는 `dropped` → `status=$1, completed_at=NULL`

---

## 4. Service API 초안

`server/src/services/calls.ts`는 route가 생기기 전에도 unit test 가능한 transaction boundary를 제공한다.

```ts
export async function createCall(app, actorOrgId, input): Promise<Call>;
export async function listCalls(app, actorOrgId, opts): Promise<{ items: Call[]; total: number }>;
export async function getCallById(app, actorOrgId, id): Promise<Call | null>;
export async function appendTranscript(app, actorOrgId, callId, input): Promise<Transcript | null>;
export async function endCall(app, actorOrgId, callId, opts?: { endedAt?: Date; finalStatus?: "ended" | "missed" | "dropped" }): Promise<Call | null>;
```

`endCall` transaction:

1. `app.withOrgContext(actorOrgId, async (client) => { ... })`
2. `calls.endByIdInCurrentOrg(client, callId, endedAt, finalStatus)`
3. call이 없으면 `null`
4. `customer_id`가 있으면 같은 client로 customers update:

```sql
UPDATE customers
   SET last_contacted_at = GREATEST(
         COALESCE(last_contacted_at, 'epoch'::timestamptz),
         $1::timestamptz
       )
 WHERE id = $2
   AND deleted_at IS NULL;
```

RLS가 current org를 강제하므로 `org_id` 조건을 중복으로 쓰지 않아도 된다. 단, 명시성을 위해 `AND org_id = current_app_org_id()`를 추가하는 것은 허용한다.

---

## 5. 테스트 계획

### 5.1 `calls_repo.test.mjs`

RLS / calls:
- bare pool에서 `SELECT count(*) FROM calls` → 0
- Acme context에서 Acme call create/list/get 가능
- Beta context에서 Acme call get/update/delete → `null` / `false`
- Acme context + Beta `orgId`로 insert 시도 → `42501`
- Acme call + Beta customer_id insert → `23503`
- Acme call + Beta agent_user_id insert → `23503`
- soft delete 후 list/get 제외, 두 번째 soft delete는 `false`

transcripts:
- append 1회 → seq 0
- append 2회 → seq 1
- listByCall은 seq ASC
- cross-org call append → `null`
- direct drift insert 또는 repo 우회 SQL로 `(beta org_id, acme call_id)` → `23503`
- 같은 call에 `Promise.all` append 2개 → seq가 정확히 0/1 또는 기존 다음 번호 2개로 유일, unique violation 없음
- calls hard delete 테스트 helper 후 transcripts cascade 확인

action items:
- createForCall → open + completed_at null
- done patch → completed_at not null
- open/dropped patch → completed_at null
- done without completed_at raw SQL → `23514`
- Beta assignee_user_id → `23503`
- cross-org call create/list → `null`

### 5.2 `calls_service.test.mjs`

endCall:
- status가 `ended`, `ended_at`, `duration_seconds`가 채워짐
- customer_id가 있는 call은 `customers.last_contacted_at` 갱신
- `last_contacted_at`이 더 최신이면 뒤로 가지 않음
- customer_id NULL이면 customer update 생략하고 call만 종료
- cross-org call id로 endCall → `null`
- transaction rollback: customer update가 실패하도록 유도했을 때 call update도 rollback되는지 확인

테스트 cleanup:
- 테스트가 만든 calls는 hard delete helper로 정리한다. calls delete가 transcripts/action_items를 cascade하므로 cleanup root는 calls다.
- seeded customers/users/memberships는 원복한다. 사용자 seed를 삭제하지 않는다.

---

## 6. 완료 기준

- [ ] `server/src/repositories/calls.ts` 작성
- [ ] `server/src/repositories/transcripts.ts` 작성
- [ ] `server/src/repositories/callActionItems.ts` 작성
- [ ] `server/src/services/calls.ts` 작성
- [ ] `server/test/calls_repo.test.mjs` 작성
- [ ] `server/test/calls_service.test.mjs` 작성
- [ ] `npm --prefix server run typecheck` PASS
- [ ] `node test/sync_shared_types.mjs` PASS
- [ ] `npm --prefix server test` PASS
- [ ] `PHASE_4_STEP_2_FINDINGS.md` 작성
- [ ] `PHASE_4_MASTER.md` Step 2 `[x]` 갱신

---

## 7. Step 3 인계 조건

Step 3 route/shared types로 넘어가기 전에 다음이 확정돼 있어야 한다.

1. repository가 route 없이도 RLS/cross-org/soft-delete/seq를 증명한다.
2. `endCall` service가 `customers.last_contacted_at`을 같은 transaction에서 갱신한다.
3. route에서 404/403/400으로 매핑할 error vocabulary가 정리돼 있다.
4. shared type에 넣을 response shape 후보가 repository return shape와 충돌하지 않는다.

---

## 8. 한 줄 요약

> **Step 2는 Phase 4 데이터 모델의 "쓰기 안전성"을 증명하는 단계다. UI나 REST 표면을 만들기 전에, RLS + composite FK + transaction + seq 발급 + customer timestamp 갱신이 unit test로 잠겨 있어야 한다.**

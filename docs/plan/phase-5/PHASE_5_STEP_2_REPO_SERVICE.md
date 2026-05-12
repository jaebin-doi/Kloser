# Phase 5 — Step 2 Repository + Service + Unit Tests Plan

> **상위**: `PHASE_5_MASTER.md` Step 2.
> **선행 조건**: Step 1 schema 완료 (`PHASE_5_STEP_1_FINDINGS.md`, commit `44f0002`).
> **범위**: repository layer + service layer + unit tests. Route/shared types/frontend/STT·LLM 외부 adapter wiring은 Step 3/4에서 처리한다.

---

## 0. 목표

Step 2의 목표는 Phase 5 schema가 실제 서버 코드에서 안전하게 쓰이는지 증명하는 것이다. 화면이나 REST API를 만들기 전에, DB 접근 함수와 service 트랜잭션이 다음 불변식을 지키는지 unit test로 고정한다.

1. 신규 5개 테이블은 `app.withOrgContext(...)` 안에서만 접근한다.
2. org 격리는 RLS가 맡고, cross-org ID는 `null` / `false` / 0건으로 숨긴다.
3. pgvector 검색은 `embedding IS NOT NULL`만 대상으로 하며 cosine distance 정렬을 테스트로 증명한다.
4. checklist template과 통화별 checklist 진행 상태는 분리한다.
5. suggestion은 `(call_id, group_seq, type)` 중복을 DB가 막고, dismissed/used 동시 상태를 허용하지 않는다.
6. heartbeat timeout은 `in_progress` 통화만 `dropped`로 바꾸고 이미 ended/missed/dropped된 통화는 건드리지 않는다.
7. customer linkage는 같은 org의 customer/user만 연결 가능하다.
8. manager team-scope은 RLS가 아니라 service helper에서 mutation에만 적용한다.

---

## 1. 산출물

| 종류 | 경로 | 내용 |
|---|---|---|
| plugin | `server/src/plugins/db.ts` | `withOrgContext` backward-compatible overload: `(orgId, fn)` 유지 + `(orgId, userId, fn)` 추가, `app.user_id` GUC 설정 |
| repository | `server/src/repositories/calls.ts` | Phase 5 calls 컬럼 projection 추가 + heartbeat / dropped / customer linkage / AI summary update primitive |
| repository | `server/src/repositories/transcripts.ts` | `stt_provider` / `stt_session_id` projection + append input 확장 |
| repository | `server/src/repositories/knowledgeBases.ts` | knowledge base CRUD primitive, soft delete, same-org creator FK |
| repository | `server/src/repositories/knowledgeChunks.ts` | chunk replace/list/update embedding/vector search |
| repository | `server/src/repositories/callChecklistTemplates.ts` | template list/create/update/active toggle/reorder |
| repository | `server/src/repositories/callChecklistItems.ts` | call 시작 시 template snapshot 생성 + list + mark done/open |
| repository | `server/src/repositories/callSuggestions.ts` | suggestion group insert/list/use/dismiss |
| service | `server/src/services/callPermissions.ts` | manager/employee mutation 권한 helper |
| service | `server/src/services/knowledge.ts` | knowledge ingest transaction helper + vector search wrapper |
| service | `server/src/services/callChecklist.ts` | checklist initialization + mark helper |
| service | `server/src/services/callSuggestions.ts` | suggestion persistence + use/dismiss 권한 검사 |
| service | `server/src/services/callHeartbeat.ts` | heartbeat touch + timeout sweep |
| service | `server/src/services/customerLinkage.ts` | call-customer link helper |
| service | `server/src/services/callSummary.ts` | mockable summarizer 결과를 calls summary 컬럼에 저장 |
| test | `server/test/orgContext.test.mjs` | `app.user_id` overload 회귀 |
| test | `server/test/phase5_repositories.test.mjs` | 신규 repository RLS/FK/CHECK/vector tests |
| test | `server/test/phase5_services.test.mjs` | service transaction + permissions + heartbeat tests |
| docs | `docs/plan/phase-5/PHASE_5_STEP_2_FINDINGS.md` | 구현 결과·검증·Step 3 인계 |
| docs | `docs/plan/phase-5/PHASE_5_MASTER.md` | Step 2 완료 시에만 checkbox 갱신 |

Step 2에서는 다음 파일을 만들거나 수정하지 않는다.

- `server/src/routes/*`
- `server/src/types/*`
- `platform/*`
- `platform/types/*`
- `test/sync_shared_types.mjs`
- real Clova / Claude / OpenAI adapter
- BullMQ / Redis worker entrypoint

단, 기존 `calls.ts` repository/service가 Phase 5 컬럼을 알도록 확장하는 것은 Step 2 범위다.

---

## 2. 사전 결정

| # | 항목 | 결정 | 근거 |
|---|---|---|---|
| 2-1 | `withOrgContext` signature | overload로 확장한다. 기존 `(orgId, fn)` 호출은 그대로 동작하고, 현재 user id가 필요한 service만 `(orgId, userId, fn)` 사용 | Phase 4 route/service 전체 일괄 수정 회피. Step 1 plan의 backward-compatible 결정 유지 |
| 2-2 | `app.user_id` 미설정 의미 | `current_app_user_id()`는 NULL. RLS 정책은 user id를 사용하지 않으므로 read/write는 기존 org RLS 그대로 | manager team-scope은 service helper 책임 |
| 2-3 | manager team-scope 적용 위치 | `services/callPermissions.ts`에서 mutation 직전 검사 | RLS로 same-org read를 좁히지 않기로 한 Step 1 결정 |
| 2-4 | manager read scope | Step 2에서도 org-wide read 유지 | 자기 팀만 보이는 dashboard/report는 Phase 6+ |
| 2-5 | write 권한 기본 규칙 | admin은 org 내 모든 call mutation 가능. manager는 같은 팀 agent의 call mutation만 가능. employee는 자기 call만 가능. viewer는 mutation 불가 | Phase 4 employee-own-call 규칙 확장 |
| 2-6 | unassigned call mutation | admin만 허용. manager/employee는 `agent_user_id IS NULL` call mutation 불가 | 팀 소속 판정 불가능. 운영상 admin이 정리 |
| 2-7 | same-team 판정 | `memberships`에서 actor와 call agent가 같은 org, active, 같은 `team_id`이고 `team_id IS NOT NULL`이어야 manager 허용 | NULL team은 "같은 팀"으로 보지 않음 |
| 2-8 | knowledge mutation 권한 | Step 2 service는 role을 강제하지 않는다. route admin-only는 Step 3에서 적용 | Step 2는 API surface 없음. repository/service invariant만 고정 |
| 2-9 | vector parameter format | `pg`에는 vector type encoder가 없으므로 `"[0.1,0.2,...]"::vector` 문자열을 parameter로 넘기고 SQL에서 cast | 간단하고 테스트 가능 |
| 2-10 | vector search filter | 항상 `embedding IS NOT NULL` | Step 1에서 embedding nullable + 전체 ivfflat index 선택 |
| 2-11 | knowledge ingest | Step 2는 embedding provider를 호출하지 않는다. chunk text + optional embedding 배열을 받아 저장한다 | real embedding adapter는 Step 3 |
| 2-12 | checklist call snapshot | 통화 시작 또는 최초 조회 시 active templates를 `call_checklist_items`로 복제한다. 중복은 `(call_id, template_id)` UNIQUE로 흡수 | 과거 통화 진행 상태 보존 |
| 2-13 | suggestion insert | group 단위 bulk insert. duplicate unique violation은 service에서 idempotent success로 처리하지 않는다. 테스트에서 23505 확인 | 중복 LLM push는 버그로 드러나야 함 |
| 2-14 | suggestion use/dismiss | use 후 dismiss, dismiss 후 use 모두 DB CHECK 또는 service guard로 거부 | 사용자 행동 이력은 단일 최종 행동 |
| 2-15 | AI summary overwrite | AI summary는 `summary_source IS NULL OR summary_source='ai'`일 때만 덮어쓴다. `manual`은 보존 | 사용자 수동 입력 보호 |
| 2-16 | heartbeat touch | `status='in_progress' AND deleted_at IS NULL` 통화만 `last_seen_at` 갱신 | ended 통화를 heartbeat로 되살리지 않음 |
| 2-17 | dropped sweep | cutoff보다 오래된 `in_progress` + `last_seen_at` non-null 통화만 `dropped/server_timeout` | 시작 직후 heartbeat 전 통화는 Step 3 정책에서 별도 결정 |
| 2-18 | customer linkage | same-org customer만 허용. `customer_linked_by_user_id`는 same-org membership FK가 검증 | cross-org leak은 composite FK로 차단 |
| 2-19 | route error vocabulary | Step 2는 error class만 준비 가능. HTTP 403/404/400 매핑은 Step 3 route 책임 | 계층 분리 |
| 2-20 | test cleanup | 테스트가 만든 call/knowledge row만 prefix로 정리. seed user/customer/membership 삭제 금지 | Phase 4 orphan calls 잔재 재발 방지 |

---

## 3. `withOrgContext` 확장

### 3.1 목표

현재 plugin:

```ts
app.withOrgContext(orgId, async (client) => { ... })
```

Step 2에서 추가:

```ts
app.withOrgContext(orgId, userId, async (client) => { ... })
```

기존 호출자는 수정하지 않아도 된다. 새 signature를 쓰는 service만 `app.user_id` GUC가 설정된다.

### 3.2 타입 초안

```ts
export interface WithOrgContext {
  <T>(orgId: string, fn: (client: PoolClient) => Promise<T>): Promise<T>;
  <T>(
    orgId: string,
    userId: string | null,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T>;
}
```

구현은 rest argument로 분기한다.

```ts
const withOrgContext: WithOrgContext = async (orgId, userIdOrFn, maybeFn) => {
  const userId = typeof userIdOrFn === "function" ? undefined : userIdOrFn;
  const fn = typeof userIdOrFn === "function" ? userIdOrFn : maybeFn!;

  await client.query("BEGIN");
  await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
  if (userId !== undefined && userId !== null) {
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
  }
  ...
};
```

### 3.3 테스트

`server/test/orgContext.test.mjs`에 추가:

- 기존 `(orgId, fn)` 호출이 계속 동작
- `(orgId, userId, fn)` 호출 안에서 `current_app_user_id()`가 userId 반환
- 트랜잭션 종료 후 bare pool에서 `current_app_user_id()`가 NULL 또는 미설정 상태
- rollback path에서도 client release 정상

---

## 4. Repository API 초안

### 4.1 `server/src/repositories/calls.ts` 보강

기존 `Call` projection에 Step 5 컬럼을 추가한다.

```ts
summary_generated_at: Date | null;
summary_source: "ai" | "manual" | null;
last_seen_at: Date | null;
dropped_reason: "browser_disconnect" | "server_timeout" | "manual" | null;
customer_linked_at: Date | null;
customer_linked_by_user_id: string | null;
```

추가 함수:

```ts
export async function touchHeartbeatInCurrentOrg(
  client: PoolClient,
  callId: string,
  seenAt: Date,
): Promise<Call | null>;

export async function markDroppedTimedOutInCurrentOrg(
  client: PoolClient,
  cutoff: Date,
  droppedAt: Date,
): Promise<number>;

export async function linkCustomerInCurrentOrg(
  client: PoolClient,
  callId: string,
  customerId: string | null,
  linkedByUserId: string,
  linkedAt: Date,
): Promise<Call | null>;

export interface CallSummaryPatch {
  summary: string | null;
  needs: string | null;
  issues: string | null;
  sentiment: "positive" | "neutral" | "cautious" | "negative" | null;
}

export async function updateAiSummaryInCurrentOrg(
  client: PoolClient,
  callId: string,
  patch: CallSummaryPatch,
  generatedAt: Date,
): Promise<Call | null>;

export async function updateManualSummaryInCurrentOrg(
  client: PoolClient,
  callId: string,
  patch: CallSummaryPatch,
): Promise<Call | null>;
```

SQL contracts:

- `touchHeartbeatInCurrentOrg`: `WHERE id=$1 AND status='in_progress' AND deleted_at IS NULL`
- `markDroppedTimedOutInCurrentOrg`: `WHERE status='in_progress' AND deleted_at IS NULL AND last_seen_at IS NOT NULL AND last_seen_at < $cutoff`
- `linkCustomerInCurrentOrg`: customer_id nullable. Non-null wrong-org customer는 composite FK가 23503으로 막음
- `updateAiSummaryInCurrentOrg`: `AND (summary_source IS NULL OR summary_source='ai')`
- `updateManualSummaryInCurrentOrg`: `summary_source='manual'`, `summary_generated_at`은 변경하지 않음

### 4.2 `server/src/repositories/transcripts.ts` 보강

`Transcript` projection:

```ts
stt_provider: "clova" | "whisper" | "manual" | "fixture" | null;
stt_session_id: string | null;
```

`TranscriptAppendInput` 추가:

```ts
stt_provider?: "clova" | "whisper" | "manual" | "fixture" | null;
stt_session_id?: string | null;
```

기존 append seq lock 정책은 유지한다.

### 4.3 `server/src/repositories/knowledgeBases.ts`

```ts
export type KnowledgeBaseSourceType = "manual" | "file" | "url";

export interface KnowledgeBase {
  id: string;
  org_id: string;
  title: string;
  source_type: KnowledgeBaseSourceType;
  source_uri: string | null;
  created_by_user_id: string | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface KnowledgeBaseCreateInput {
  title: string;
  source_type: KnowledgeBaseSourceType;
  source_uri?: string | null;
  created_by_user_id?: string | null;
}

export async function listForCurrentOrg(client, opts): Promise<KnowledgeBase[]>;
export async function getByIdInCurrentOrg(client, id): Promise<KnowledgeBase | null>;
export async function insertInCurrentOrg(client, orgId, input): Promise<KnowledgeBase>;
export async function patchInCurrentOrg(client, id, input): Promise<KnowledgeBase | null>;
export async function softDeleteByIdInCurrentOrg(client, id): Promise<boolean>;
```

Rules:

- list/get는 `deleted_at IS NULL`
- `created_by_user_id` wrong-org는 composite FK 23503
- soft delete는 parent `knowledge_bases.deleted_at = now()`. chunks는 hard-delete하지 않는다

### 4.4 `server/src/repositories/knowledgeChunks.ts`

```ts
export interface KnowledgeChunk {
  id: string;
  knowledge_base_id: string;
  org_id: string;
  position: number;
  text: string;
  embedding: string | null;
  token_count: number | null;
  created_at: Date;
}

export interface KnowledgeChunkInput {
  position: number;
  text: string;
  embedding?: number[] | null;
  token_count?: number | null;
}

export async function replaceForKnowledgeBaseInCurrentOrg(
  client,
  orgId,
  knowledgeBaseId,
  chunks,
): Promise<KnowledgeChunk[] | null>;

export async function listByKnowledgeBaseInCurrentOrg(client, knowledgeBaseId): Promise<KnowledgeChunk[] | null>;

export async function updateEmbeddingInCurrentOrg(
  client,
  chunkId,
  embedding,
  tokenCount,
): Promise<KnowledgeChunk | null>;

export async function searchSimilarInCurrentOrg(
  client,
  queryEmbedding,
  opts,
): Promise<Array<KnowledgeChunk & { distance: number }>>;
```

Vector helper:

```ts
function toVectorLiteral(values: number[]): string {
  if (values.length !== 1536) throw new Error("invalid_embedding_dimension");
  return "[" + values.join(",") + "]";
}
```

Search SQL:

```sql
SELECT ..., (embedding <=> $1::vector)::float8 AS distance
  FROM knowledge_chunks
 WHERE embedding IS NOT NULL
 ORDER BY embedding <=> $1::vector
 LIMIT $2
```

`replaceForKnowledgeBaseInCurrentOrg`는 transaction 안에서:

1. parent knowledge base 존재 확인
2. 기존 chunks 삭제
3. 새 chunks insert

### 4.5 `server/src/repositories/callChecklistTemplates.ts`

```ts
export interface CallChecklistTemplate {
  id: string;
  org_id: string;
  title: string;
  sort_order: number;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

export async function listForCurrentOrg(client, opts): Promise<CallChecklistTemplate[]>;
export async function listActiveForCurrentOrg(client): Promise<CallChecklistTemplate[]>;
export async function insertInCurrentOrg(client, orgId, input): Promise<CallChecklistTemplate>;
export async function patchInCurrentOrg(client, id, input): Promise<CallChecklistTemplate | null>;
export async function setActiveInCurrentOrg(client, id, active): Promise<CallChecklistTemplate | null>;
export async function deleteByIdInCurrentOrg(client, id): Promise<boolean>;
```

Delete는 운영 UI에서는 가급적 쓰지 않고 `active=false`를 기본으로 한다. 그래도 schema에 DELETE policy가 있으므로 repository primitive는 제공 가능하다.

### 4.6 `server/src/repositories/callChecklistItems.ts`

```ts
export type CallChecklistStatus = "open" | "done";

export interface CallChecklistItem {
  id: string;
  call_id: string;
  template_id: string;
  org_id: string;
  status: CallChecklistStatus;
  checked_at: Date | null;
  checked_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function initializeForCallInCurrentOrg(
  client,
  callId,
): Promise<CallChecklistItem[] | null>;

export async function listByCallInCurrentOrg(client, callId): Promise<CallChecklistItem[] | null>;

export async function markStatusInCurrentOrg(
  client,
  itemId,
  status,
  checkedByUserId,
): Promise<CallChecklistItem | null>;

export async function getParentCallForChecklistItem(client, itemId): Promise<{ call_id: string; agent_user_id: string | null } | null>;
```

`initializeForCallInCurrentOrg`:

- call row `FOR UPDATE`
- active templates 조회
- `INSERT ... ON CONFLICT (call_id, template_id) DO NOTHING`
- 최종 list 반환

`markStatusInCurrentOrg`:

- `done` → `checked_at=now(), checked_by_user_id=$userId`
- `open` → `checked_at=NULL, checked_by_user_id=NULL`

### 4.7 `server/src/repositories/callSuggestions.ts`

```ts
export type CallSuggestionTone = "blue" | "cyan" | "amber" | "rose" | "emerald" | "slate";
export type CallSuggestionType = "direction" | "script" | "alert" | "risk" | "next" | "kb";

export interface CallSuggestion {
  id: string;
  call_id: string;
  org_id: string;
  group_seq: number;
  at_ms: number;
  tone: CallSuggestionTone;
  type: CallSuggestionType;
  title: string;
  body: string | null;
  dismissed_at: Date | null;
  used_at: Date | null;
  created_at: Date;
}

export interface CallSuggestionInput {
  group_seq: number;
  at_ms: number;
  tone: CallSuggestionTone;
  type: CallSuggestionType;
  title: string;
  body?: string | null;
}

export async function insertGroupForCallInCurrentOrg(client, callId, items): Promise<CallSuggestion[] | null>;
export async function listByCallInCurrentOrg(client, callId): Promise<CallSuggestion[] | null>;
export async function markUsedInCurrentOrg(client, id, usedAt): Promise<CallSuggestion | null>;
export async function markDismissedInCurrentOrg(client, id, dismissedAt): Promise<CallSuggestion | null>;
export async function getParentCallForSuggestion(client, id): Promise<{ call_id: string; agent_user_id: string | null } | null>;
```

`markUsedInCurrentOrg` / `markDismissedInCurrentOrg`는 already-opposite 상태일 때 `null` 또는 domain error 중 하나를 선택한다. 권장: service에서 `conflict_state` domain error로 바꿔 Step 3 route가 409로 매핑.

---

## 5. Service API 초안

### 5.1 `server/src/services/callPermissions.ts`

```ts
export type ActorRole = "admin" | "manager" | "employee" | "viewer";

export interface Actor {
  id: string;
  orgId: string;
  role: ActorRole;
}

export class PermissionError extends Error {
  code = "forbidden" as const;
}

export async function assertCanMutateCall(
  client: PoolClient,
  actor: Actor,
  call: { agent_user_id: string | null },
): Promise<void>;
```

Rules:

- admin: allow
- viewer: deny
- employee: allow only `call.agent_user_id === actor.id`
- manager:
  - deny if `call.agent_user_id IS NULL`
  - actor membership and agent membership must be same org, active, non-null same team
  - otherwise deny

This helper is used by call notes/end/customer-linkage/summary/checklist/suggestion/action-item mutation services in Step 2/3. Step 3 route can keep `requireRole("admin","manager","employee")`, but ownership/team denial should move out of route-local helpers and into this service.

### 5.2 `server/src/services/knowledge.ts`

```ts
export async function createKnowledgeBase(app, actor, input): Promise<KnowledgeBase>;
export async function replaceKnowledgeChunks(app, actor, knowledgeBaseId, chunks): Promise<KnowledgeChunk[] | null>;
export async function searchKnowledge(app, actorOrgId, queryEmbedding, opts): Promise<SearchResult[]>;
```

Step 2는 role enforcement를 하지 않아도 된다. Step 3 route에서 admin-only를 적용한다. 단 org context와 transaction boundary는 service가 소유한다.

### 5.3 `server/src/services/callChecklist.ts`

```ts
export async function initializeChecklistForCall(app, actorOrgId, callId): Promise<CallChecklistItem[] | null>;

export async function markChecklistItem(
  app,
  actor,
  itemId,
  status,
): Promise<CallChecklistItem | null>;
```

`markChecklistItem` flow:

1. `withOrgContext(actor.orgId, actor.id, tx)`
2. parent call lookup by item id
3. parent 없으면 `null`
4. `assertCanMutateCall`
5. repository mark status

### 5.4 `server/src/services/callSuggestions.ts`

```ts
export async function persistSuggestionGroup(app, actorOrgId, callId, items): Promise<CallSuggestion[] | null>;

export async function useSuggestion(app, actor, suggestionId): Promise<CallSuggestion | null>;

export async function dismissSuggestion(app, actor, suggestionId): Promise<CallSuggestion | null>;
```

`persistSuggestionGroup`는 WS/LLM 내부 흐름에서 사용될 예정이라 actor 권한 검사를 받지 않는다. 대신 org context + parent call 존재만 확인한다. 사용자 행동인 `useSuggestion` / `dismissSuggestion`은 `assertCanMutateCall`을 적용한다.

### 5.5 `server/src/services/callHeartbeat.ts`

```ts
export async function touchCallHeartbeat(app, actorOrgId, callId, seenAt = new Date()): Promise<Call | null>;

export async function markTimedOutCallsDropped(app, actorOrgId, cutoff: Date, droppedAt = new Date()): Promise<number>;
```

Step 2는 org 단위 함수만 만든다. 전체 org sweep scheduler는 Step 3+에서 결정한다. 테스트는 한 org 안에서 cutoff 전/후 row count만 검증한다.

### 5.6 `server/src/services/customerLinkage.ts`

```ts
export async function linkCustomerToCall(
  app,
  actor,
  callId,
  customerId,
): Promise<Call | null>;

export async function unlinkCustomerFromCall(app, actor, callId): Promise<Call | null>;
```

Flow:

1. parent call lookup
2. `assertCanMutateCall`
3. repo link/unlink
4. wrong-org customer/user FK는 23503으로 올라오게 둔다

### 5.7 `server/src/services/callSummary.ts`

```ts
export interface GeneratedCallSummary {
  summary: string | null;
  needs: string | null;
  issues: string | null;
  sentiment: "positive" | "neutral" | "cautious" | "negative" | null;
}

export async function applyAiSummary(
  app,
  actorOrgId,
  callId,
  generated,
  generatedAt = new Date(),
): Promise<Call | null>;

export async function applyManualSummary(
  app,
  actor,
  callId,
  patch,
): Promise<Call | null>;
```

Step 2 does not call Claude/OpenAI. It only proves overwrite rules:

- AI can fill empty summary
- AI can replace previous AI summary
- AI cannot overwrite `summary_source='manual'`
- manual summary sets `summary_source='manual'`

---

## 6. Test Plan

### 6.1 `orgContext.test.mjs`

Add 4 cases:

1. old signature `(orgId, fn)` still returns scoped rows
2. new signature `(orgId, userId, fn)` returns `current_app_user_id() = userId`
3. old signature returns `current_app_user_id() IS NULL`
4. thrown callback rolls back and releases client

### 6.2 `phase5_repositories.test.mjs`

Knowledge:

- bare pool select 신규 table count → 0
- Acme insert/list/get knowledge base
- Beta cannot see Acme knowledge base
- Acme context + Beta org insert → 42501
- wrong-org `created_by_user_id` → 23503
- soft delete hides from list/get
- replace chunks creates positions 0..N
- replace chunks on cross-org KB → null
- embedding dimension != 1536 helper rejects before SQL
- vector search ignores NULL embeddings
- vector search returns nearest result first

Checklist:

- create/list active templates sorted by `sort_order`
- inactive template excluded from active list
- initializeForCall creates one item per active template
- initialize twice does not duplicate
- cross-org call initialize → null
- mark done sets `checked_at` + `checked_by_user_id`
- mark open clears both
- raw invalid `status='done' AND checked_at IS NULL` → 23514

Suggestions:

- insert group for call returns rows sorted by group/at/type
- duplicate `(call_id, group_seq, type)` → 23505
- dismissed + used simultaneous raw insert/update → 23514
- list by cross-org call → null
- mark used sets `used_at`
- mark dismissed sets `dismissed_at`

Calls/transcripts Phase 5 columns:

- heartbeat updates `last_seen_at` only for in_progress
- ended call heartbeat returns null
- dropped sweep marks only stale in_progress
- customer linkage set/unset works for same org
- wrong-org customer linkage → 23503
- transcript append stores `stt_provider` / `stt_session_id`

### 6.3 `phase5_services.test.mjs`

Permissions:

- admin can mutate any same-org call
- employee can mutate own call
- employee cannot mutate another agent call
- manager same team can mutate
- manager different team cannot mutate
- manager with null team cannot mutate
- manager cannot mutate unassigned call
- viewer cannot mutate

Service transactions:

- checklist mark uses permission helper
- suggestion use/dismiss uses permission helper
- customer link uses permission helper
- manual summary uses permission helper
- AI summary does not overwrite manual summary
- heartbeat timeout does not touch ended/missed/dropped
- rollback: if second statement fails, earlier update rolls back

Expected test count: 35~45 new tests. Existing 212 tests must keep passing.

### 6.4 Cleanup Contract

Each new test must create rows with a `phase5test-` prefix where a text field exists. Cleanup should remove in child-to-parent order:

1. `call_suggestions`
2. `call_checklist_items`
3. `call_action_items` if created
4. `transcripts`
5. `calls`
6. `knowledge_chunks`
7. `knowledge_bases`
8. `org_call_checklist_templates`

Do not delete seeded users/customers/memberships. The Phase 4 orphan `calls` finding was caused by deleting test users while calls still referenced them. Step 2 tests should not delete users at all.

---

## 7. Non-Goals

Step 2 must not implement:

- `/knowledge-bases` routes
- `/checklist-templates` routes
- new `/calls/:id/*` REST endpoints
- shared zod/JSDoc types
- `platform/api.js`
- `platform/live.html`
- `platform/calls.html`
- `platform/settings.html`
- real Clova STT
- real Claude/OpenAI calls
- BullMQ worker process
- phase_5_e2e

If implementation pressure suggests touching one of these, stop and split the work into Step 3/4 instead.

---

## 8. Error Mapping Contract For Step 3

Step 2 service should expose domain errors that Step 3 routes can map cleanly.

| Domain condition | Suggested service error | Step 3 HTTP mapping |
|---|---|---|
| actor lacks mutation right | `PermissionError("forbidden")` | 403 |
| target row missing/cross-org | `null` | 404 |
| duplicate suggestion group/type | raw pg `23505` | 409 or 400, route decision |
| invalid FK, wrong-org referenced row | raw pg `23503` | 400 `invalid_reference` |
| invalid state CHECK | raw pg `23514` | 400 `invalid_state_transition` |
| vector dimension wrong before SQL | `InvalidEmbeddingError` | 400 `invalid_embedding` |
| suggestion already dismissed/used | `SuggestionStateError` | 409 `conflict_state` |

Do not leak cross-org existence through 403. Cross-org rows should look missing unless the row is same-org but unauthorized by role/team.

---

## 9. Completion Checklist

- [ ] `server/src/plugins/db.ts` overload implemented without breaking existing callers
- [ ] `server/src/repositories/calls.ts` projection includes Phase 5 columns
- [ ] `server/src/repositories/transcripts.ts` projection includes STT metadata
- [ ] knowledge repositories implemented
- [ ] checklist repositories implemented
- [ ] suggestion repository implemented
- [ ] heartbeat/customer-linkage/summary service helpers implemented
- [ ] manager/employee permission helper implemented and unit tested
- [ ] pgvector search unit test proves ordering and NULL filter
- [ ] duplicate/check constraint tests cover DB invariants
- [ ] `npm --prefix server run typecheck` PASS
- [ ] `npm --prefix server test` PASS, existing 212 + new tests
- [ ] `node test/sync_shared_types.mjs` PASS, still 9 entity because Step 2 adds no shared types
- [ ] `node test/phase_4_e2e.mjs` PASS or explicitly deferred with reason if server routes untouched and runtime not available
- [ ] `git diff --check` PASS
- [ ] `PHASE_5_STEP_2_FINDINGS.md` written with changed files, tests, risks, Step 3 handoff
- [ ] `PHASE_5_MASTER.md` Step 2 checkbox updated only after all above are green

---

## 10. Codex Review Focus

1. **`withOrgContext` overload safety** — old callers must be untouched. `app.user_id` must be transaction-local and not leak through pooled clients.
2. **team-scope semantics** — manager same-team mutation allowed, cross-team denied, read still org-wide. This distinction must stay explicit.
3. **pgvector parameterization** — no string-built SQL with embedding values. Pass vector literal as a parameter and cast `$1::vector`.
4. **AI summary overwrite guard** — `summary_source='manual'` must not be overwritten by delayed AI summary.
5. **heartbeat cutoff** — do not mark fresh `in_progress` calls dropped before first heartbeat unless Step 3 consciously changes that policy.
6. **test cleanup** — no user deletion, no broad started_at sweeps, no manual dev data deletion.
7. **Step boundary** — no routes/frontend/shared types/real external APIs in Step 2.

---

## 11. One-Line Handoff

> **Step 2는 Phase 5 신규 schema를 코드에서 안전하게 쓰기 위한 repository/service layer다. `withOrgContext`에 user context를 backward-compatible하게 추가하고, knowledge/checklist/suggestion/heartbeat/customer-linkage/summary primitives와 manager team-scope permission helper를 단위 테스트로 고정한다. 외부 STT/LLM adapter, REST route, shared types, UI는 Step 3/4로 미룬다.**

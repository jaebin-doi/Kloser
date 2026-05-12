# Phase 5 — Step 3 Plan (Adapters + REST routes + Shared types + WS heartbeat)

> **상위 계획**: `docs/plan/phase-5/PHASE_5_MASTER.md` §3 Step 3, §4 권한 매트릭스.
> **선행 단계**: Step 2 완료 — `PHASE_5_STEP_2_FINDINGS.md` §8 Step 3 인계 7항목.
> **워크플로**: `AGENTS.md` Phase Workflow §3 — routes / shared types / WS persistence는 같은 step에서 같이 닫는다. 프런트엔드는 손대지 않는다.
> **기간**: 2.5~3일.

---

## 0. 이번 Step의 범위 (Step 2와의 경계)

Step 2가 깐 것: `withOrgContext` 3-arg overload, Phase 5 5개 repository, 7개 service (`callPermissions` / `knowledge` / `callChecklist` / `callSuggestions` / `callHeartbeat` / `customerLinkage` / `callSummary`), domain error 클래스 (`PermissionError`, `SuggestionStateError`, `InvalidEmbeddingError`).

본 step이 하는 것: 그 위에 **외부 adapter 인터페이스 + mock 구현**, **REST 라우트 7군**, **shared zod/JSDoc 5 entity**, **WS heartbeat persistence**, **route/WS 테스트**.

본 step이 **하지 않는** 것:
- 프런트엔드 (`platform/live.html`, `calls.html`, `settings.html`) — Step 4
- 실제 외부 provider 호출 (Clova / Anthropic / OpenAI) — adapter interface와 mock만. 실 provider client는 Phase 5 e2e 이후 별도 작업
- BullMQ worker / cron sweep loop — service helper는 Step 2에 있고, multi-org loop scheduling은 Step 4 또는 Phase 6+
- phase_5_e2e — Step 5
- RLS 정책 추가/변경 — team-scope는 service layer가 책임 (Step 2 결정)

---

## 1. Adapter 인터페이스 + Mock

### 1.1 디렉터리

```
server/src/adapters/
  stt/
    index.ts        — 인터페이스 export, default export 결정 helper
    mock.ts         — 결정적 fixture
  llm/
    index.ts
    mock.ts
  embedding/
    index.ts
    mock.ts
```

각 `index.ts`는 interface와 type alias만 export. `mock.ts`는 dev/test에서 쓰는 결정적 구현. 실 provider 모듈은 본 step에서 추가하지 않는다 (`anthropic.ts` / `clova.ts` / `openai.ts` 파일은 Phase 5 e2e 이후 또는 Phase 6+).

### 1.2 STTAdapter

```ts
export interface SttUtterance {
  speaker: "agent" | "customer" | "system";
  text: string;
  startMs: number | null;
  endMs: number | null;
  confidence: number | null;
}

export interface SttTranscribeOptions {
  language: "ko-KR" | "en-US";
  sessionId: string;
}

export interface STTAdapter {
  provider: "clova" | "whisper" | "mock";
  transcribeChunk(
    audio: Buffer | string, // dev mock은 string fixture
    options: SttTranscribeOptions,
  ): Promise<SttUtterance | null>;
}
```

mock 구현: `transcribeChunk(fixtureKey, opts)` — `fixtureKey`가 "greeting"이면 `{speaker:'agent', text:'안녕하세요', confidence:0.95}` 같은 결정적 반환. text 길이/언어/세션 id를 echo해 라우트 테스트가 검증 가능하게.

### 1.3 LLMAdapter

```ts
export interface LlmGeneratedSummary {
  summary: string | null;
  needs: string | null;
  issues: string | null;
  sentiment: "positive" | "neutral" | "cautious" | "negative" | null;
}

export interface LlmGeneratedSuggestion {
  group_seq: number;
  at_ms: number;
  tone: "blue" | "cyan" | "amber" | "rose" | "emerald" | "slate";
  type: "direction" | "script" | "alert" | "risk" | "next" | "kb";
  title: string;
  body: string | null;
}

export interface LLMAdapter {
  provider: "anthropic" | "openai" | "mock";
  summarizeCall(input: {
    transcript: string;
    knowledgeContext?: string[];
  }): Promise<LlmGeneratedSummary>;
  suggestForUtterance(input: {
    transcript: string;
    knowledgeContext?: string[];
    groupSeq: number;
    atMs: number;
  }): Promise<LlmGeneratedSuggestion[]>;
}
```

mock은 transcript 길이를 보고 sentiment를 결정하는 식의 단순 규칙. summarizeCall은 transcript의 첫 200자를 summary로 echo, suggest는 group_seq를 그대로 반영한 1~2 카드 반환.

### 1.4 EmbeddingAdapter

```ts
export interface EmbeddingAdapter {
  provider: "openai" | "voyage" | "mock";
  dimensions: 1536;
  embed(text: string): Promise<number[]>;     // length === 1536
  embedBatch(texts: string[]): Promise<number[][]>;
}
```

mock은 텍스트의 char code sum + 위치 기반의 결정적 1536-dim 벡터. 동일 입력은 동일 출력. cosine distance가 서로 다른 텍스트에 대해 0 < d < 2 범위로 분포하도록 조정.

### 1.5 Resolver

```ts
// server/src/adapters/index.ts
export function resolveSttAdapter(): STTAdapter { ... }
export function resolveLlmAdapter(): LLMAdapter { ... }
export function resolveEmbeddingAdapter(): EmbeddingAdapter { ... }
```

resolver는 `process.env.STT_PROVIDER` / `LLM_PROVIDER` / `EMBEDDING_PROVIDER` 값을 보고 분기. 미설정 시 mock 반환. 본 step에서 실 provider 분기 branch는 아직 throw — Phase 5 e2e 직전에 실 구현 추가.

`.env.example`에 `STT_PROVIDER=mock` / `LLM_PROVIDER=mock` / `EMBEDDING_PROVIDER=mock` 추가. `.env`는 손대지 않는다.

---

## 2. REST 라우트 surface

### 2.1 신설 파일

- `server/src/routes/knowledgeBases.ts` — knowledge_bases CRUD + chunk replace/list/search
- `server/src/routes/checklistTemplates.ts` — 회사 체크리스트 마스터 CRUD
- `server/src/routes/checklistItems.ts` — 통화별 진행 상태 mutation

### 2.2 기존 라우트 보강

- `server/src/routes/calls.ts` —
  - `POST /calls/:id/checklist/initialize`
  - `POST /calls/:id/heartbeat`
  - `POST /calls/:id/link-customer`
  - `POST /calls/:id/unlink-customer`
  - `POST /calls/:id/summary/manual`
  - `POST /calls/:id/summary/ai` (server-internal — admin only — Step 4+ worker 직전)
  - `GET  /calls/:id/suggestions`
  - `POST /call-suggestions/:id/use`
  - `POST /call-suggestions/:id/dismiss`

### 2.3 Surface 총정리 (12 신규 endpoint)

| # | Method | URL | Body 핵심 | 역할 | preHandler |
|---|---|---|---|---|---|
| 1 | GET    | `/knowledge-bases` | query: limit, offset | knowledge list | requireAuth + orgContext |
| 2 | POST   | `/knowledge-bases` | KnowledgeBaseCreateInput | KB create (admin) | + requireVerified + requireRole("admin") + requireFreshRole |
| 3 | GET    | `/knowledge-bases/:id` | — | KB detail + chunks | requireAuth + orgContext |
| 4 | PATCH  | `/knowledge-bases/:id` | KnowledgeBasePatchInput | KB patch (admin) | admin chain |
| 5 | DELETE | `/knowledge-bases/:id` | — | KB soft delete (admin) | admin chain |
| 6 | POST   | `/knowledge-bases/:id/chunks/replace` | { chunks: KnowledgeChunkInput[] } | chunk replace (admin) | admin chain |
| 7 | POST   | `/knowledge-bases/search` | { query: string, limit?: number } | vector search (any signed-in user) | requireAuth + orgContext |
| 8 | GET    | `/call-checklist-templates` | — | template list | requireAuth + orgContext |
| 9 | POST   | `/call-checklist-templates` | TemplateCreateInput | create (admin) | admin chain |
| 10 | PATCH | `/call-checklist-templates/:id` | TemplatePatchInput | patch (admin) | admin chain |
| 11 | DELETE | `/call-checklist-templates/:id` | — | delete (admin) | admin chain |
| 12 | POST   | `/calls/:id/checklist/initialize` | — | call items 초기 snapshot | writer chain |
| 13 | GET    | `/calls/:id/checklist` | — | items list | requireAuth + orgContext |
| 14 | POST   | `/call-checklist-items/:id/status` | { status } | mark open/done | writer chain + team-scope helper |
| 15 | GET    | `/calls/:id/suggestions` | — | suggestion 이력 | requireAuth + orgContext |
| 16 | POST   | `/call-suggestions/:id/use` | — | mark used | writer chain + team-scope helper |
| 17 | POST   | `/call-suggestions/:id/dismiss` | — | mark dismissed | writer chain + team-scope helper |
| 18 | POST   | `/calls/:id/heartbeat` | — | last_seen_at 갱신 | writer chain |
| 19 | POST   | `/calls/:id/link-customer` | { customer_id } | bind customer | writer chain + team-scope helper |
| 20 | POST   | `/calls/:id/unlink-customer` | — | clear customer | writer chain + team-scope helper |
| 21 | POST   | `/calls/:id/summary/manual` | CallSummaryPatch | manual writer | writer chain + team-scope helper |

> 21개로 정정 — 사용자 지시의 7군이 endpoint 수로는 21개로 펼쳐진다 (검색 endpoint #7 포함). 본 표가 정본.

### 2.4 preHandler chains

기존 `calls.ts`와 동일 패턴.

- **read chain**: `requireAuth, orgContext`
- **writer chain**: `requireAuth, orgContext, requireVerified, requireRole("admin", "manager", "employee"), requireFreshRole`
- **admin chain**: `requireAuth, orgContext, requireVerified, requireRole("admin"), requireFreshRole`

writer chain 안에서 본 call mutation 권한은 `assertCanMutateCall` (Step 2) 가 처리. employee-own / manager-team / admin-all / viewer-deny가 한 곳에 모인다.

### 2.5 Error → HTTP 매핑

`calls.ts` 패턴 그대로. 각 라우트 파일이 `app.setErrorHandler`를 자체 등록 (plugin-scoped). 매핑:

| 발생 | HTTP | body.error |
|---|---|---|
| ZodError | 400 | invalid_input + issues |
| AuthError | err.statusCode | err.message + code |
| `PermissionError` (callPermissions) | 403 | forbidden |
| `SuggestionStateError` | 409 | conflict_state |
| `InvalidEmbeddingError` | 400 | invalid_embedding |
| pg 23503 | 400 | invalid_reference |
| pg 23514 | 400 | invalid_state_transition |
| pg 23505 | 409 | conflict |
| pg 42501 | 500 | rls_violation |
| service null (missing / cross-org) | 404 | not_found |
| 그 외 | 500 | (default Fastify) |

knowledge endpoint들의 23505는 (title) UNIQUE가 없으므로 거의 발생하지 않지만, suggestion route에서 같은 group_seq×type 재push 시 23505가 적절히 409로 떨어져야 한다 (Step 4 worker 재시도 대비).

### 2.6 본 step에서 추가하지 않는 route

- `POST /calls/:id/suggestions` — server-internal 생성 (LLM worker가 직접 호출) 또는 WS 핸들러 내부에서만 사용. 외부에 노출하지 않음.
- `POST /knowledge-chunks/:id/embedding` — embedding fill 워커가 직접 service 호출. REST 미노출.
- `POST /calls/:id/summary/ai` — 본 step에서는 미노출. AI summary는 server-internal trigger만 (Step 4의 worker 또는 본 step의 mock unit test에서 service.applyAiSummary 직접 호출). master plan §3 Step 3 산출물 표의 `/calls/:id/summarize`는 본 step에서 manual writer 1개로 좁힌다.

> 사용자 지시의 "manual/AI summary trigger" 중 AI trigger는 endCall 직후 자동 enqueue로 처리하는 것이 master plan의 결정 (사전결정 8). 명시적 REST trigger는 dev 도구 성격이므로 본 step은 manual writer만 추가하고, AI trigger는 Step 4+ BullMQ worker 도입 시 함께 검토한다.

---

## 3. Shared types (zod + JSDoc + registry)

### 3.1 신규 entity 5개

| Entity 파일 | Server 경로 | Browser 경로 | 등록 type 이름 |
|---|---|---|---|
| `knowledgeBase` | `server/src/types/knowledgeBase.ts` | `platform/types/knowledgeBase.js` | `KnowledgeBase`, `KnowledgeBaseCreateInput`, `KnowledgeBasePatchInput`, `KnowledgeBaseListResponse` |
| `knowledgeChunk` | `server/src/types/knowledgeChunk.ts` | `platform/types/knowledgeChunk.js` | `KnowledgeChunk`, `KnowledgeChunkInput`, `KnowledgeChunkReplaceInput`, `KnowledgeChunkSearchQuery`, `KnowledgeChunkSearchResultItem`, `KnowledgeChunkSearchResponse` |
| `checklistTemplate` | `server/src/types/checklistTemplate.ts` | `platform/types/checklistTemplate.js` | `CallChecklistTemplate`, `CallChecklistTemplateCreateInput`, `CallChecklistTemplatePatchInput`, `CallChecklistTemplateListResponse` |
| `callChecklistItem` | `server/src/types/callChecklistItem.ts` | `platform/types/callChecklistItem.js` | `CallChecklistItem`, `CallChecklistItemStatusInput`, `CallChecklistItemListResponse` |
| `callSuggestion` | `server/src/types/callSuggestion.ts` | `platform/types/callSuggestion.js` | `CallSuggestion`, `CallSuggestionInput`, `CallSuggestionGroupInput`, `CallSuggestionListResponse` |

### 3.2 sync_shared_types 등록

`test/sync_shared_types.mjs`의 `ENTITY_REGISTRY`에 5 entity 추가 → 9 → 14 entity. 각 entity의 `types` 배열은 위 표와 일치.

### 3.3 zod 규약

- 모든 entity는 top-level `export const X = z.object({ ... })` 리터럴. `.extend / .merge / .partial / .refine`은 sync 대상이 아닌 derived 스키마에서만 사용.
- preprocess는 허용 (Step 2의 `Call` 정책과 동일).
- timestamp는 server 측 `z.date()`, browser 측 `string`. wire 직렬화는 ISO string.

### 3.4 추가 보강 — `call.ts`에 manual summary input 추가

```ts
export const CallSummaryManualInput = z.object({
  summary: z.string().max(4000).nullable(),
  needs: z.string().max(4000).nullable(),
  issues: z.string().max(4000).nullable(),
  sentiment: CallSentiment.nullable(),
});
```

`call` entity registry의 `types` 배열에 `CallSummaryManualInput` 추가. `platform/types/call.js`도 동기. `call`은 기존 entity이므로 entity 수 증가 없음.

---

## 4. WS heartbeat persistence

### 4.1 변경 범위

`server/src/ws/calls.ts`만. 신규 이벤트 1개 추가:

```ts
socket.on("heartbeat", async (_payload, ack?: (resp: unknown) => void) => {
  const ctx = calls.get(socket);
  if (!ctx) {
    if (typeof ack === "function") ack({ ok: false, error: "no_active_call" });
    return;
  }
  try {
    const updated = await callHeartbeatService.touchCallHeartbeat(
      app, user.orgId, ctx.callId,
    );
    if (!updated) {
      // 상대가 ended/missed/dropped로 이미 마감 → 클라이언트가 ping 멈추도록 신호
      if (typeof ack === "function") ack({ ok: false, error: "call_ended" });
      return;
    }
    if (typeof ack === "function") ack({ ok: true, lastSeenAt: updated.last_seen_at });
  } catch (err) {
    socket.data.log("heartbeat persistence_failed", { err: (err as Error)?.message });
    if (typeof ack === "function") ack({ ok: false, error: "persistence_failed" });
  }
});
```

기존 `start_call` / `text_chunk` / `end_call` / `disconnect` 핸들러는 손대지 않는다.

### 4.2 disconnect 추가 처리는 본 step에서 도입하지 않음

`master plan` §2 결정 10에 따르면 disconnect 시 즉시 dropped 마킹이 아니라 60s sweep으로 처리. sweep은 service layer에 있고, cron loop은 Step 4+ 또는 별도 worker entry. 본 step의 `disconnect` 핸들러는 그대로.

### 4.3 클라이언트 ack 계약

| ack | 의미 |
|---|---|
| `{ ok: true, lastSeenAt }` | heartbeat 반영 완료 |
| `{ ok: false, error: "no_active_call" }` | start_call 전 |
| `{ ok: false, error: "call_ended" }` | 통화가 이미 마감 — 클라이언트는 ping 중단 |
| `{ ok: false, error: "persistence_failed" }` | DB 오류. 클라이언트는 다음 주기에 재시도 |

---

## 5. 테스트

### 5.1 신규 테스트 파일

| 파일 | 내용 |
|---|---|
| `server/test/phase5_routes_knowledge.test.mjs` | knowledge bases CRUD + chunk replace + search × admin/manager/employee/viewer × cross-org |
| `server/test/phase5_routes_checklist.test.mjs` | templates CRUD (admin) + initialize + items list + mark status × team-scope |
| `server/test/phase5_routes_suggestions.test.mjs` | listing + use/dismiss + 409 conflict_state + team-scope |
| `server/test/phase5_routes_calls.test.mjs` | heartbeat / link-customer / unlink-customer / manual summary × team-scope × cross-org |
| `server/test/phase5_ws_heartbeat.test.mjs` | WS heartbeat ack + last_seen_at DB 반영 + ended call → call_ended ack |
| `server/test/phase5_adapters.test.mjs` | mock STT/LLM/Embedding 결정성 + dimension 검증 |

(파일 분리 이유: 단일 거대 파일은 `calls_routes.test.mjs`의 패턴과 어긋나고, knowledge 시드/cleanup이 길어 다른 리소스와 섞이면 가독성 저하.)

### 5.2 시드/cleanup 정책

- 모든 신규 row는 `phase5routetest-` 또는 `phase5wstest-` prefix 라벨 (`title` / `KB.title` / `template.title` / `suggestion.title`)을 단다.
- `afterEach` 또는 `after`에서 prefix 기반 sweep. 좌석 데이터 (users / memberships / teams)는 건드리지 않는다.
- manager team-scope 테스트가 필요한 경우 `phase5_services.test.mjs`와 동일한 5 ephemeral user + 2 team 시드를 재사용 (utility 함수로 옮길지 여부는 구현 시점 판단; 일단 helper 모듈 `server/test/_phase5Fixture.mjs` 검토).

### 5.3 권한 매트릭스 (각 route별 최소 검증 표)

| Endpoint | admin | manager (same team) | manager (other team) | employee (own) | employee (other) | viewer | cross-org |
|---|---|---|---|---|---|---|---|
| KB list / search / detail | 200 | 200 | 200 | 200 | 200 | 200 | 404 |
| KB create/patch/delete/replace | 200/201 | 403 | 403 | 403 | 403 | 403 | 404 |
| Templates list | 200 | 200 | 200 | 200 | 200 | 200 | RLS scope |
| Templates create/patch/delete | 201/200 | 403 | 403 | 403 | 403 | 403 | 404 |
| Checklist initialize / mark | 200 | 200 | 403 | 200 (own call) | 403 | 403 | 404 |
| Suggestion list | 200 | 200 | 200 | 200 | 200 | 200 | 404 |
| Suggestion use/dismiss | 200 | 200 | 403 | 200 (own) | 403 | 403 | 404 |
| Heartbeat | 200 | 200 | 403 | 200 (own) | 403 | 403 | 404 |
| Link / unlink customer | 200 | 200 | 403 | 200 (own) | 403 | 403 | 404 |
| Manual summary | 200 | 200 | 403 | 200 (own) | 403 | 403 | 404 |

각 endpoint에 대해 행 7개 풀 매트릭스를 다 돌리지는 않는다. 라우트 묶음당 admin / manager-same / manager-other / employee-own / employee-other / viewer / cross-org에서 representative 케이스 6~8건 정도.

### 5.4 회귀

- 기존 server unit tests 255건 PASS 유지
- `node test/sync_shared_types.mjs` → 14 entity PASS
- `node test/phase_4_e2e.mjs` 8 시나리오 회귀 PASS (Phase 5 변경이 Phase 4 surface를 깨지 않음 검증)

---

## 6. 작업 순서 (1일 단위 분해)

### Day 1 — adapters + shared types

1. `server/src/adapters/{stt,llm,embedding}/{index,mock}.ts` 6 파일 작성 + `server/src/adapters/index.ts` resolver
2. `server/src/types/{knowledgeBase,knowledgeChunk,checklistTemplate,callChecklistItem,callSuggestion}.ts` 5 zod 파일
3. `platform/types/{...}.js` 5 JSDoc 미러
4. `test/sync_shared_types.mjs` ENTITY_REGISTRY 보강 (5 추가 + `call` types에 `CallSummaryManualInput` 추가)
5. `server/test/phase5_adapters.test.mjs` 작성
6. `node test/sync_shared_types.mjs` PASS, `npm --prefix server test` 회귀 OK 확인

### Day 2 — REST routes

7. `server/src/routes/knowledgeBases.ts` 신규 (7 endpoint) + `server.ts` 등록
8. `server/src/routes/checklistTemplates.ts` 신규 (4 endpoint) + 등록
9. `server/src/routes/checklistItems.ts` 신규 (3 endpoint: `POST /calls/:id/checklist/initialize`, `GET /calls/:id/checklist`, `POST /call-checklist-items/:id/status`) + 등록
10. `server/src/routes/calls.ts` 보강 — heartbeat / link-customer / unlink-customer / manual summary / suggestion list / suggestion use / suggestion dismiss

### Day 3 — WS + tests

11. `server/src/ws/calls.ts` heartbeat 이벤트 핸들러 추가
12. `phase5_routes_*` 4 파일 + `phase5_ws_heartbeat.test.mjs` 작성
13. Validation suite 4건 PASS 확인
14. `PHASE_5_STEP_3_FINDINGS.md` 작성

---

## 7. Codex Review Focus

| # | 항목 | 어떻게 확인 |
|---|---|---|
| 7-1 | RLS 정책 변경 없음 | `git diff` migrations 폴더에 변경 없음 (Step 1 8 마이그레이션 그대로) |
| 7-2 | team-scope는 service layer | route 파일에서 `assertCanMutateCall` 호출 위치 확인. RLS 정책 SQL은 추가/변경 0 |
| 7-3 | `withOrgContext` 사용 | 모든 route handler가 `app.withOrgContext` 또는 service 함수 경유. 직접 `app.pg.query` 없음 |
| 7-4 | shared type sync | `node test/sync_shared_types.mjs`가 14 entity PASS |
| 7-5 | adapter 인터페이스 분리 | `server/src/adapters/*/index.ts`에 실 provider 코드 없음 (mock만) |
| 7-6 | innerHTML XSS gate | 라우트 응답이 server-supplied LLM 응답을 raw로 echo. 프런트 와이어링 (Step 4)이 DOMPurify 책임 — 본 step은 frontend 미수정 |
| 7-7 | 프런트엔드 미수정 | `platform/live.html` / `calls.html` / `settings.html` `git diff` 0 byte |
| 7-8 | 본 step 비-목표 준수 | 실 provider client (anthropic.ts / clova.ts / openai.ts) 추가 없음, BullMQ worker entry 없음 |
| 7-9 | error → HTTP 매핑 정합 | 각 라우트 파일이 `setErrorHandler`로 PermissionError → 403, SuggestionStateError → 409, 23505 → 409, 23503 → 400 invalid_reference |
| 7-10 | seed cleanup | `phase5routetest-` / `phase5wstest-` prefix 기반. 좌석 user/membership/team 미삭제 |

---

## 8. 완료 기준 (Step 3 go gate)

- [ ] `npm --prefix server run typecheck` PASS (0 error)
- [ ] `npm --prefix server test` PASS — 기존 255 + 신규 ~50건
- [ ] `node test/sync_shared_types.mjs` PASS (14 entity)
- [ ] `node test/phase_4_e2e.mjs` 8 시나리오 회귀 PASS
- [ ] adapter 인터페이스 3종 + mock 3종 + resolver 노출
- [ ] REST endpoint 21개 (7군 + KB search + manual summary) 모두 200/4xx 정확
- [ ] WS heartbeat 이벤트가 calls.last_seen_at을 갱신
- [ ] manager team-scope 위반 mutation 403 회귀 (4종 mutation × non-team manager)
- [ ] knowledge / checklist template CRUD viewer/employee/manager 403 회귀 (admin only)
- [ ] `docs/plan/phase-5/PHASE_5_STEP_3_FINDINGS.md` 작성

하나라도 실패하면 본 step에 머문다.

---

## 9. Step 4 인계 (예고)

본 step이 끝나면 Step 4는 다음을 wire:

1. `platform/settings.html` — knowledge bases CRUD UI (admin), checklist templates CRUD UI (admin)
2. `platform/live.html` — customer picker 모달, 체크리스트가 `/calls/:id/checklist` fetch + 토글이 `/call-checklist-items/:id/status` 호출, suggestion 카드가 WS push + `/call-suggestions/:id/use|dismiss` 호출, WS heartbeat 20s 주기 발신
3. `platform/calls.html` — detail 패널 suggestion 이력 + manual summary 작성 UI + action item mutation
4. `platform/api.js` — helpers 5종 (knowledge / templates / checklist / suggestion / heartbeat-via-WS)
5. innerHTML XSS gate — LLM 응답 모두 DOMPurify 경유

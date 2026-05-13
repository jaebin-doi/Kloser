# Phase 6 Step 2 Plan (Real Providers + Usage Logging)

> **상위 계획**: `docs/plan/phase-6/PHASE_6_MASTER.md` §4 Step 2.
> **선행 단계**: Phase 6 Step 1 완료 및 커밋 `9799f4b` (`PHASE_6_STEP_1_FINDINGS.md`).
> **워크플로**: schema 변경이 있으므로 AGENTS.md Phase Workflow를 적용한다. 순서: schema migration → repo + tests → adapter/service tests → worker/WS integration tests → findings. 프론트엔드 변경은 없다.
> **기간**: 3~4일.

---

## 0. 목표

Phase 5/6 Step 1에서 mock으로 고정되어 있던 provider 자리에 실 client를 넣되, 기본 개발/테스트 경로는 계속 mock-only로 유지한다.

1. `llm_usage_log` 테이블을 추가해 provider 호출 단위 사용량, 지연시간, 실패 상태를 기록한다.
2. Anthropic Messages API 기반 LLM adapter를 추가한다.
3. OpenAI Embeddings API 기반 embedding adapter를 추가한다.
4. Naver Cloud CLOVA Speech Recognition REST adapter를 추가한다.
5. Step 1 worker/WS 경로가 real provider 사용 시 usage row를 남기도록 연결한다.

외부 API 호출은 명시 env opt-in 없이는 테스트에서 실행하지 않는다. `STT_PROVIDER`, `LLM_PROVIDER`, `EMBEDDING_PROVIDER`가 없거나 `mock`이면 기존 동작을 그대로 유지한다.

---

## 1. 하지 않는 것

- frontend 변경 없음.
- `platform/types/**` shared type 추가 없음. 이 step은 user-facing REST response를 추가하지 않는다.
- provider key를 `.env`에 쓰지 않는다. `.env.example`만 확장한다.
- daily cap, billing enforcement, org plan limit은 Phase 7+로 보류한다.
- Clova realtime gRPC streaming은 보류한다. 현재 서버 WS는 audio chunk를 받지 않고 `text_chunk`만 처리하므로 Step 2에서는 기존 `STTAdapter.transcribeChunk(Buffer|string)`에 맞는 REST short-recognition client만 추가한다.
- OpenAI를 LLM fallback으로 추가하지 않는다. 이번 step의 LLM real provider는 Anthropic만이다.
- 실 provider e2e는 기본 CI/dev gate에 넣지 않는다. 키가 있는 로컬에서 `E2E_ALLOW_REAL_PROVIDERS=1`일 때만 opt-in smoke를 허용한다.

---

## 2. 공식 문서 확인 기준

구현 직전 다시 확인해야 하는 provider 문서:

| Provider | 확인 항목 | 기준 문서 |
|---|---|---|
| Anthropic | Messages API request/response, `usage.input_tokens`, `usage.output_tokens`, `x-api-key`, `anthropic-version` | https://docs.anthropic.com/en/api/messages-examples |
| OpenAI | `openai.embeddings.create`, `text-embedding-3-small`, `usage.prompt_tokens`, 기본 1536 dimension | https://platform.openai.com/docs/guides/embeddings |
| Naver Cloud | CLOVA Speech Recognition REST URL, `x-ncp-apigw-api-key-id`, `x-ncp-apigw-api-key`, 60s/3MB short audio limit | https://api.ncloud-docs.com/docs/en/ai-naver-clovaspeechrecognition |

주의: pricing은 자주 바뀐다. `cost_usd_micros` 계산에 쓰는 모델별 단가는 구현 당일 공식 pricing을 다시 확인한 뒤 코드 주석에 확인일을 남긴다. 확인 불가 모델은 tokens/latency만 기록하고 cost는 `NULL`로 둔다.

---

## 3. Schema Plan

### 3.1 마이그레이션

신규 파일:

- `server/migrations/1715000021000_phase6_llm_usage_log.sql`

`PHASE_6_MASTER.md`의 최소 스키마는 성공 호출만 분석할 수 있어 운영 로그로 부족하다. Step 2에서는 호출 위치와 실패 원인을 식별할 수 있도록 다음 필드를 추가한다.

```sql
CREATE TABLE llm_usage_log (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    call_id             uuid,
    provider            text NOT NULL CHECK (provider IN ('anthropic','openai','clova','mock')),
    operation           text NOT NULL CHECK (
      operation IN ('call_summary','call_suggestion','knowledge_embedding','stt_transcribe')
    ),
    model               text NOT NULL,
    status              text NOT NULL CHECK (status IN ('succeeded','failed','skipped')),
    tokens_in           int CHECK (tokens_in IS NULL OR tokens_in >= 0),
    tokens_out          int CHECK (tokens_out IS NULL OR tokens_out >= 0),
    latency_ms          int CHECK (latency_ms IS NULL OR latency_ms >= 0),
    cost_usd_micros     bigint CHECK (cost_usd_micros IS NULL OR cost_usd_micros >= 0),
    provider_request_id text,
    error_code          text,
    metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT llm_usage_log_call_same_org_fk
      FOREIGN KEY (org_id, call_id)
      REFERENCES calls(org_id, id)
      ON DELETE SET NULL
);
```

Indexes:

- `(org_id, created_at DESC)`
- `(org_id, provider, created_at DESC)`
- `(org_id, operation, created_at DESC)`
- `(call_id, created_at DESC) WHERE call_id IS NOT NULL`

RLS:

```sql
ALTER TABLE llm_usage_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_usage_log FORCE ROW LEVEL SECURITY;

CREATE POLICY llm_usage_log_select ON llm_usage_log FOR SELECT
  USING (org_id = current_app_org_id());

CREATE POLICY llm_usage_log_insert ON llm_usage_log FOR INSERT
  WITH CHECK (org_id = current_app_org_id());
```

No update/delete policy in Step 2. Usage rows are append-only.

Grants:

```sql
GRANT SELECT, INSERT ON llm_usage_log TO app;
```

### 3.2 RLS Tests

Add tests proving:

- bare pool with no GUC sees 0 rows.
- Acme context inserts and reads Acme usage rows.
- Beta context cannot read Acme usage rows.
- Acme context cannot insert a row with `org_id = Beta`.
- Acme context cannot attach usage to a Beta call id.

---

## 4. Adapter Contract Change

Current adapter methods return only domain output, so usage logging has nowhere reliable to get token/request metadata. Step 2 changes adapter return values to a measured result shape.

New file:

- `server/src/adapters/usage.ts`

```ts
export interface ProviderUsage {
  provider: 'anthropic' | 'openai' | 'clova' | 'mock';
  operation: 'call_summary' | 'call_suggestion' | 'knowledge_embedding' | 'stt_transcribe';
  model: string;
  status: 'succeeded' | 'failed' | 'skipped';
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number | null;
  costUsdMicros: number | null;
  providerRequestId?: string | null;
  errorCode?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ProviderResult<T> {
  value: T;
  usage?: ProviderUsage;
}
```

Interface changes:

- `LLMAdapter.summarizeCall(...) -> Promise<ProviderResult<LlmGeneratedSummary>>`
- `LLMAdapter.suggestForUtterance(...) -> Promise<ProviderResult<LlmGeneratedSuggestion[]>>`
- `EmbeddingAdapter.embed(...) -> Promise<ProviderResult<number[]>>`
- `EmbeddingAdapter.embedBatch(...) -> Promise<ProviderResult<number[][]>>`
- `STTAdapter.transcribeChunk(...) -> Promise<ProviderResult<SttUtterance | null>>`

All existing mock adapters return deterministic `value` plus `usage` with provider `mock`, zero/null cost, and small synthetic token counts where useful. Existing services unwrap `.value`.

Reason: storing usage in adapter instance state is unsafe under concurrent requests. Returning usage with the result keeps metadata tied to the exact provider call.

---

## 5. Provider Clients

### 5.1 Anthropic LLM

New file:

- `server/src/adapters/llm/anthropic.ts`

Dependency:

- `@anthropic-ai/sdk`

Env:

- `LLM_PROVIDER=anthropic`
- `ANTHROPIC_API_KEY`
- `ANTHROPIC_MODEL=claude-sonnet-4-20250514` (override allowed)
- `ANTHROPIC_MAX_TOKENS=1024`
- `ANTHROPIC_TIMEOUT_MS=30000`

Behavior:

- `summarizeCall` sends transcript and optional knowledge context to Messages API.
- It requests strict JSON output with keys `summary`, `needs`, `issues`, `sentiment`.
- Invalid JSON or invalid enum is a provider error and does not mutate call summary.
- `suggestForUtterance` requests a JSON array matching `LlmGeneratedSuggestion[]`.
- Returned items are validated with zod/local predicates before DB insert.
- `usage.input_tokens` and `usage.output_tokens` are mapped to `tokens_in` / `tokens_out`.
- Provider response id is stored as `provider_request_id` when available.

Failure behavior:

- 401/403 config/auth errors throw fail-fast.
- 429 and 5xx throw retryable errors; BullMQ retry policy handles call summary jobs.
- WS suggestion failures are logged and do not kill the socket.

### 5.2 OpenAI Embedding

New file:

- `server/src/adapters/embedding/openai.ts`

Dependency:

- `openai`

Env:

- `EMBEDDING_PROVIDER=openai`
- `OPENAI_API_KEY`
- `OPENAI_EMBEDDING_MODEL=text-embedding-3-small`
- `OPENAI_EMBEDDING_DIMENSIONS=1536`
- `OPENAI_TIMEOUT_MS=10000`

Behavior:

- Uses `openai.embeddings.create`.
- Sends `encoding_format: 'float'`.
- Explicitly requests `dimensions: 1536` when supported by the model.
- Verifies every returned vector length is 1536 before returning.
- Maps OpenAI usage `prompt_tokens` to `tokens_in`; `tokens_out = 0`.

### 5.3 Naver Cloud CLOVA STT

New file:

- `server/src/adapters/stt/clova.ts`

Dependency:

- none required; use Node 22 global `fetch` and `AbortController`.

Env:

- `STT_PROVIDER=clova`
- `CLOVA_STT_URL=https://naveropenapi.apigw.ntruss.com/recog/v1/stt`
- `CLOVA_CLIENT_ID`
- `CLOVA_CLIENT_SECRET`
- `CLOVA_STT_LANGUAGE=Kor`
- `CLOVA_TIMEOUT_MS=10000`

Behavior:

- Accepts `Buffer` only for real provider. String fixture keys throw `SttUnsupportedInputError`.
- Sends `Content-Type: application/octet-stream`.
- Sends Naver Cloud headers `x-ncp-apigw-api-key-id` and `x-ncp-apigw-api-key`.
- Maps `SttTranscribeOptions.language` to Clova language query value.
- Returns `null` for empty/unrecognized result, matching current adapter contract.
- `tokens_in` / `tokens_out` remain null; latency and status are still logged.

Scope correction: this is not realtime gRPC. The current product has no browser audio upload path in Phase 6 Step 2, so adding gRPC would create unused infrastructure. Realtime speech streaming belongs in a later desktop/browser-audio phase.

---

## 6. Usage Logging

New files:

- `server/src/repositories/llmUsage.ts`
- `server/src/services/llmUsage.ts`

Repository:

- `insertInCurrentOrg(client, input)` returns inserted row.
- `listForCallInCurrentOrg(client, callId)` only for tests/internal diagnostics.

Service:

- `recordProviderUsage(app, orgId, callId, usage)` wraps `withOrgContext`.
- Logging failure must not fail the original user operation. It logs a warning and returns `null`.
- `status='failed'` rows are recorded only when the adapter can build a structured usage/error object. Transport errors before provider response may not have token/cost data.

Call sites:

- `workers/callSummary.worker.ts`: after `summarizeCall`, record `operation='call_summary'`, then apply summary.
- `ws/calls.ts`: after `suggestForUtterance`, record `operation='call_suggestion'`, then persist suggestions.
- `services/knowledge.ts`: after OpenAI embedding calls, record `operation='knowledge_embedding'` with `call_id = NULL`.
- STT route/service currently does not ingest real audio in normal UI. Add adapter tests and leave production call-site integration to the first backend path that accepts audio buffers.

Important ordering:

- For summary: usage logging should happen even if `applyAiSummary` no-ops because manual summary is locked. Provider cost was already incurred.
- For suggestions: usage logging should happen even if generated suggestions validate to an empty list or DB insert returns no rows.

---

## 7. Resolver Behavior

Modify `server/src/adapters/index.ts`:

- env missing or blank -> `mock`.
- `STT_PROVIDER=clova` -> require Clova env and return real adapter.
- `LLM_PROVIDER=anthropic` -> require Anthropic env and return real adapter.
- `EMBEDDING_PROVIDER=openai` -> require OpenAI env and return real adapter.
- unsupported provider -> throw with explicit provider name.

Do not silently fall back to mock when a real provider is explicitly selected but misconfigured. That would hide production config errors.

---

## 8. Test Plan

### 8.1 Schema / RLS

New test file or extension:

- `server/test/phase6_usage_log.test.mjs`

Cases:

1. bare pool sees 0 rows.
2. same-org insert/read succeeds.
3. cross-org read returns 0.
4. wrong `org_id` insert fails with RLS.
5. wrong-org `call_id` insert fails with FK/RLS.
6. append-only: update/delete not allowed for app role.

### 8.2 Adapter Contract

Modify existing Phase 5 adapter tests:

- mock STT/LLM/Embedding now return `{ value, usage }`.
- resolver defaults to mock.
- explicit unknown provider still throws.
- explicit real provider with missing key throws fail-fast.

New tests:

- Anthropic adapter is skipped unless `E2E_ALLOW_REAL_PROVIDERS=1` and `ANTHROPIC_API_KEY` are set.
- OpenAI adapter is skipped unless `E2E_ALLOW_REAL_PROVIDERS=1` and `OPENAI_API_KEY` are set.
- Clova adapter is skipped unless `E2E_ALLOW_REAL_PROVIDERS=1` and Clova credentials are set.

Default test suite must not make network calls.

### 8.3 Integration

Cases:

1. call summary processor records one usage row in mock mode.
2. manual-summary locked call still records usage if provider was called.
3. WS `text_chunk` suggestion records one usage row in mock mode.
4. knowledge chunk replace records one embedding usage row in mock mode.
5. logging failure does not fail summary/suggestion/embedding operation.

### 8.4 Regression Gates

Run:

```powershell
npm --prefix server run typecheck
npm --prefix server test
node test/sync_shared_types.mjs
node test/phase_4_e2e.mjs
node test/phase_5_e2e.mjs
```

Optional local real-provider smoke:

```powershell
$env:E2E_ALLOW_REAL_PROVIDERS='1'
$env:LLM_PROVIDER='anthropic'
$env:EMBEDDING_PROVIDER='openai'
$env:STT_PROVIDER='clova'
npm --prefix server test -- --test-name-pattern provider
```

Do not include real-provider smoke in the required gate unless credentials and cost policy are explicitly approved.

---

## 9. Implementation Order

### Commit 1: Schema

1. Add `1715000021000_phase6_llm_usage_log.sql`.
2. Run migrate up locally.
3. Add RLS/repository tests for the raw table.
4. Validate:
   - `npm --prefix server test -- --test-name-pattern usage`

### Commit 2: Repository + Service

1. Add `repositories/llmUsage.ts`.
2. Add `services/llmUsage.ts`.
3. Add focused tests for insert, cross-org, append-only, logging failure isolation.

### Commit 3: Adapter Contract + Mock Update

1. Add `adapters/usage.ts`.
2. Update STT/LLM/Embedding interfaces.
3. Update mock adapters and all call sites to unwrap `.value`.
4. Update Phase 5 adapter/service tests.
5. Confirm all existing mock-only behavior remains identical.

### Commit 4: Real Providers

1. Add Anthropic, OpenAI, Clova concrete adapters.
2. Add dependencies to `server/package.json`.
3. Extend `.env.example`.
4. Update resolver branches.
5. Add skipped-by-default contract tests.

### Commit 5: Usage Wiring + Findings

1. Wire usage logging into call summary worker.
2. Wire usage logging into WS suggestion generation.
3. Wire usage logging into knowledge embedding service.
4. Add integration tests.
5. Write `PHASE_6_STEP_2_FINDINGS.md`.
6. Update `PHASE_6_MASTER.md` Step 2 checkbox only after validation passes.

If the team wants fewer commits, Commit 2~5 can be squashed, but schema should stay standalone per AGENTS.md.

---

## 10. Env Additions

Update `server/.env.example` only:

```dotenv
# Phase 6 Step 2 providers. Defaults stay mock unless explicitly set.
STT_PROVIDER=mock
LLM_PROVIDER=mock
EMBEDDING_PROVIDER=mock

# Anthropic LLM
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-4-20250514
ANTHROPIC_MAX_TOKENS=1024
ANTHROPIC_TIMEOUT_MS=30000

# OpenAI embeddings
OPENAI_API_KEY=
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_EMBEDDING_DIMENSIONS=1536
OPENAI_TIMEOUT_MS=10000

# Naver Cloud CLOVA Speech Recognition
CLOVA_STT_URL=https://naveropenapi.apigw.ntruss.com/recog/v1/stt
CLOVA_CLIENT_ID=
CLOVA_CLIENT_SECRET=
CLOVA_STT_LANGUAGE=Kor
CLOVA_TIMEOUT_MS=10000
```

---

## 11. Risks

1. **Adapter contract churn**: changing return types touches several services. Mitigation: do this in its own commit with full mock-only tests before adding real clients.
2. **Cost calculation staleness**: pricing changes. Mitigation: unknown models record `cost_usd_micros=NULL`; pricing constants require source/date comments.
3. **Real provider retries can cost money**: Step 1 BullMQ caps retries at 3. Step 2 must keep that cap and avoid adding unbounded retries inside adapters.
4. **Provider response parsing**: LLM JSON may be malformed. Mitigation: zod/local validation and fail closed; no partial DB writes.
5. **STT scope mismatch**: current frontend does not send audio. Mitigation: adapter-only implementation now, audio ingestion later.
6. **RLS leakage**: usage rows must always go through `withOrgContext`; repository tests cover bare/cross-org access.

---

## 12. Completion Criteria

- [ ] `llm_usage_log` migration applies and has FORCE RLS.
- [ ] app role can only SELECT/INSERT same-org usage rows.
- [ ] usage rows are append-only in Step 2.
- [ ] mock adapters return measured results and all existing tests still pass.
- [ ] Anthropic/OpenAI/Clova resolvers fail fast when explicitly selected but missing required env.
- [ ] real provider tests are skipped by default and opt-in only.
- [ ] call summary worker records usage rows.
- [ ] WS suggestion generation records usage rows.
- [ ] knowledge embedding records usage rows.
- [ ] no frontend files changed.
- [ ] no `.env` changes.
- [ ] `npm --prefix server run typecheck` PASS.
- [ ] `npm --prefix server test` PASS.
- [ ] `node test/sync_shared_types.mjs` PASS.
- [ ] `node test/phase_4_e2e.mjs` PASS.
- [ ] `node test/phase_5_e2e.mjs` PASS.
- [ ] `PHASE_6_STEP_2_FINDINGS.md` written.

---

## 13. Codex Review Focus

| # | Check | Why |
|---|---|---|
| 13-1 | schema commit is standalone | AGENTS.md phase workflow |
| 13-2 | `llm_usage_log` has FORCE RLS | org usage/cost data is tenant-scoped |
| 13-3 | no real provider call in default tests | avoids accidental spend and flaky CI |
| 13-4 | explicit real provider misconfig throws | avoids silent mock in production |
| 13-5 | usage logging failure is non-blocking | provider result should still reach user flow |
| 13-6 | summary manual guard still works | Step 1/Phase 5 safety invariant |
| 13-7 | provider JSON is validated before DB write | LLM output is untrusted |
| 13-8 | no frontend XSS surface added | Step 2 should not touch UI |
| 13-9 | pricing constants have source/date or cost null | prevents stale cost claims |
| 13-10 | `.env` untouched | user-owned secrets |

---

## 14. Next Step After This Plan

User review 후 Step 2 schema commit부터 시작한다:

1. `llm_usage_log` migration 작성.
2. migrate up.
3. RLS/repository tests 추가.
4. schema commit.


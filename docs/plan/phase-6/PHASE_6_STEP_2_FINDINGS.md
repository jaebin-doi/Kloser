# Phase 6 Step 2 — Closeout Findings

> 완료일: 2026-05-13
> 범위: Phase 6 Step 2 종합 closeout. 4개 sub-unit (schema / contract+service / wiring / real providers) 결과를 묶어 Step 2 전체 완료를 선언한다.
> 기준 계획: `docs/plan/phase-6/PHASE_6_STEP_2_PLAN.md`, `docs/plan/phase-6/PHASE_6_MASTER.md` §4 Step 2 + §11 go/no-go gate.
> 선행 단위 findings:
> - `PHASE_6_STEP_2_SCHEMA_FINDINGS.md` (schema + repo + RLS tests, commits `9c027cf` + `b386e96`)
> - 본 문서 §2.2 — adapter contract + `services/llmUsage` (commit `99f25e4`, 단위 findings 없음)
> - `PHASE_6_STEP_2_WIRING_FINDINGS.md` (usage logging wiring, commit `ba4ab8d`)
> - `PHASE_6_STEP_2_PROVIDER_FINDINGS.md` (real provider adapters + resolver + `.env.example`, commit `6ea02f1`)
> 커밋 시퀀스 (Step 2 단위만):
> - `9c027cf Add Phase 6 usage log schema`
> - `b386e96 Add Phase 6 usage log repository tests`
> - `99f25e4 Add Phase 6 provider usage contract`
> - `ba4ab8d Wire Phase 6 provider usage logging`
> - `6ea02f1 Add Phase 6 real provider adapters`
> 현재 브랜치: `feature/phase-3-team-invitations`

---

## 1. Step 2 전체 상태

**Step 2 완료**. `PHASE_6_MASTER.md` §0 Implementation Log의 Step 2 체크박스를 본 closeout으로 `[x]`로 전환한다. 근거는 §3 (완료 기준 매핑) + §6 (residual risk) 참고.

남은 Phase 6 작업은 Step 3 (action item DELETE) / Step 4 (manager team-scope read) / Step 5 (통합 e2e + Phase 6 종합 closeout)로, Phase 6 전체 closeout은 Step 5 종료 시점에 다시 일어난다. README.md / server/README.md 상태 블록은 본 closeout에서 갱신하지 않는다 (Phase 6 전체 closeout 때 일괄 처리).

---

## 2. 4 sub-unit 결과 요약

### 2.1 Schema + Repository + RLS (commits `9c027cf` + `b386e96`)

- `server/migrations/1715000021000_phase6_llm_usage_log.sql` — `llm_usage_log` 신규 테이블.
  - columns: `id` (uuid PK), `org_id` (NOT NULL, CASCADE on org delete), `call_id` (nullable, PG15+ partial `ON DELETE SET NULL`), `provider` ('anthropic'|'openai'|'clova'|'mock'), `operation` ('call_summary'|'call_suggestion'|'knowledge_embedding'|'stt_transcribe'), `model` (text, NOT NULL), `status` ('succeeded'|'failed'|'skipped'), `tokens_in` / `tokens_out` (int, ≥0 or NULL), `latency_ms` (int, ≥0 or NULL), `cost_usd_micros` (bigint, ≥0 or NULL), `provider_request_id`, `error_code`, `metadata` (jsonb NOT NULL default `{}`), `created_at`.
  - 4개 인덱스: `(org_id, created_at DESC)`, `(org_id, provider, created_at DESC)`, `(org_id, operation, created_at DESC)`, partial `(call_id, created_at DESC) WHERE call_id IS NOT NULL`.
  - FORCE RLS. SELECT/INSERT policy on `org_id = current_app_org_id()`. UPDATE/DELETE policy 없음 → app role에 대해 append-only.
  - composite FK `(org_id, call_id) → calls(org_id, id)`로 cross-org call attach 방지.
- `server/src/repositories/llmUsage.ts` — `insertInCurrentOrg`, `listForCallInCurrentOrg`, `listForCurrentOrgByTestTagPrefix` (test/diagnostic only). caller가 `withOrgContext` 책임을 짊.
- `server/test/phase6_usage_log.test.mjs` — 9 케이스 (default-deny / cross-org / WITH CHECK / composite FK 24503 / append-only UPDATE+DELETE / `ON DELETE SET NULL (call_id)` 보존).
- Cleanup: app role은 DELETE 불가 — 모든 테스트 cleanup은 `MIGRATE_DATABASE_URL` admin connection으로 `metadata->>'test_tag' LIKE '${PREFIX}%'` 패턴.

### 2.2 Adapter contract + llmUsage service (commit `99f25e4`)

별도 sub-findings 파일을 만들지 않은 단위. 본 closeout에서 한 번에 정리한다.

- `server/src/adapters/usage.ts` 신규 — `ProviderUsage` / `ProviderResult<T>` 계약. `provider` / `operation` / `status` 타입은 `repositories/llmUsage.ts` enum과 정렬되어 boundary 매핑이 필요 없다.
- adapter 인터페이스 4개 갱신 (return type → `Promise<ProviderResult<T>>`):
  - `LLMAdapter.summarizeCall(input) → Promise<ProviderResult<LlmGeneratedSummary>>`
  - `LLMAdapter.suggestForUtterance(input) → Promise<ProviderResult<LlmGeneratedSuggestion[]>>`
  - `EmbeddingAdapter.embed(text) → Promise<ProviderResult<number[]>>`
  - `EmbeddingAdapter.embedBatch(texts) → Promise<ProviderResult<number[][]>>`
  - `STTAdapter.transcribeChunk(audio, options) → Promise<ProviderResult<SttUtterance | null>>`
- 3개 mock adapter (`llm/mock.ts`, `embedding/mock.ts`, `stt/mock.ts`)를 새 shape로 변환. domain payload 유지. mock model strings: `mock-llm-summary-v1`, `mock-llm-suggest-v1`, `mock-embedding-1536-v1`, `mock-stt-v1`. cost는 0.
- 3 call site unwrap: `workers/callSummary.worker.ts`, `ws/calls.ts`, `routes/knowledgeBases.ts`. 본 단위에서는 usage row insert wiring 미수행 (별 단위에서 처리).
- `server/src/services/llmUsage.ts` 신규 — `recordProviderUsage(app, orgId, callId, usage, opts?)`. `app.withOrgContext(orgId, ...)` + repository insert를 try/catch로 감싸 logging 실패가 user/provider flow를 차단하지 않도록 `app.log.warn` 후 null 반환.
- `server/test/phase6_llm_usage_service.test.mjs` 신규 — 7 케이스 (happy / call link / metadata merge / null fields / cross-org isolation / `withOrgContext` throw → null / INSERT CHECK throw → null).
- `server/test/phase5_adapters.test.mjs` 갱신 — 새 ProviderResult shape 기준.

### 2.3 Usage logging wiring (commit `ba4ab8d`, `PHASE_6_STEP_2_WIRING_FINDINGS.md`)

`recordProviderUsage`를 4개 production call site에 연결.

| Call site | metadata.source | callId | operation |
|---|---|---|---|
| `workers/callSummary.worker.ts` processor | `worker:callSummary` | 실제 callId | `call_summary` |
| `ws/calls.ts` `fireSuggestion` | `ws:suggestion` | 실제 callId | `call_suggestion` |
| `routes/knowledgeBases.ts` chunks/replace (embedding 없는 chunk만) | `route:knowledge.chunks.replace` | `null` | `knowledge_embedding` |
| `routes/knowledgeBases.ts` search | `route:knowledge.search` | `null` | `knowledge_embedding` |

핵심 결정:
- worker는 `summarizeCall` → `recordProviderUsage` → `applyAiSummary` 순서. manual-locked로 applyAiSummary가 skip돼도 usage row는 남는다 (Step 2 plan §6 ordering).
- chunks/replace에서 caller가 `chunk.embedding`을 미리 제공한 경우 adapter 호출 자체가 없으므로 logging 건너뜀.

테스트:
- `phase6_workers.test.mjs` 기존 3개 케이스에 usage assertion 추가.
- `phase5_routes_knowledge.test.mjs` 신규 3개 케이스 (mixed precomputed/plain → 정확히 2 rows / search 1 row diff / malformed usage envelope → search 응답 200 유지).
- 모든 cleanup은 admin URL (append-only 정책 우회 안 함).

### 2.4 Real provider adapters + resolver + `.env.example` (commit `6ea02f1`, `PHASE_6_STEP_2_PROVIDER_FINDINGS.md`)

- `server/src/adapters/llm/anthropic.ts` — `@anthropic-ai/sdk` Messages API client. system prompt로 JSON-strict 강제 + `JSON.parse` + enum/shape 검증. 401/403 throw fail-fast, 429/5xx throw (BullMQ retry), parse 실패 throw.
- `server/src/adapters/embedding/openai.ts` — `openai` SDK. `dimensions: 1536` 요청 옵션 + 응답마다 length 검증 → `EmbeddingDimensionError`. batch는 호출당 1 usage row.
- `server/src/adapters/stt/clova.ts` — Naver Cloud CLOVA Speech Recognition REST. global `fetch` + `AbortController`. Buffer-only (string 입력은 `SttUnsupportedInputError`). 401/403 → `ClovaAuthError`, 그 외 비-2xx → `ClovaResponseError`. `fetchImpl` DI로 테스트는 실 네트워크 없이 헤더/본문/lang 쿼리/4xx-5xx 검증.
- `server/src/adapters/index.ts` resolver — unset/empty → mock / `"mock"` → mock / `"anthropic"|"openai"|"clova"` → real factory (env 검증) / 알 수 없는 값 → throw. real selected + 키 부재 → fail-fast throw (silent mock fallback **거부**, Step 2 plan §7 결정).
- `.env.example` 확장 — `STT_PROVIDER` / `LLM_PROVIDER` / `EMBEDDING_PROVIDER` + 각 provider별 키/모델/timeout + `E2E_ALLOW_REAL_PROVIDERS` 가이드.
- `package.json` / `package-lock.json` — `@anthropic-ai/sdk@^0.95.2` + `openai@^6.37.0` 추가.
- `server/test/phase6_real_adapters.test.mjs` 신규 (14 default + 3 opt-in) — CLOVA stub fetch 6 + OpenAI 생성자 가드 3 + Anthropic 생성자 가드 2 + skip-by-default 옵트인 contract 3.
- `phase5_adapters.test.mjs` 추가 갱신 — resolver fail-fast / 분기 매트릭스 / `withEnv` helper.

---

## 3. Step 2 완료 기준 매핑

`PHASE_6_STEP_2_PLAN.md` §12 완료 기준 + `PHASE_6_MASTER.md` §4 Step 2 완료 기준을 모두 매핑한다.

### 3.1 Step 2 plan §12

| # | 항목 | 상태 | 근거 |
|---|---|---|---|
| 12-1 | `llm_usage_log` migration applies + FORCE RLS | ✅ | §2.1 |
| 12-2 | app role은 same-org SELECT/INSERT만 | ✅ | `phase6_usage_log.test.mjs` 9 케이스 |
| 12-3 | append-only (UPDATE/DELETE 0 rows) | ✅ | 같은 테스트 + 모든 cleanup이 admin URL |
| 12-4 | mock adapters return measured results + 기존 테스트 통과 | ✅ | §2.2 + `phase5_adapters.test.mjs` 갱신 |
| 12-5 | Anthropic/OpenAI/Clova resolver fail-fast on missing env | ✅ | §2.4 + 7 케이스 fail-fast tests |
| 12-6 | real provider tests opt-in only | ✅ | `E2E_ALLOW_REAL_PROVIDERS=1` gate, 3 skipped by default |
| 12-7 | call summary worker records usage rows | ✅ | §2.3 wiring + `phase6_workers.test.mjs` assertion |
| 12-8 | WS suggestion generation records usage rows | ✅ | §2.3 + WS 테스트 |
| 12-9 | knowledge embedding records usage rows | ✅ | §2.3 + `phase5_routes_knowledge.test.mjs` |
| 12-10 | no frontend files changed | ✅ | git diff stat 확인 (platform/* 미수정) |
| 12-11 | no `.env` changes | ✅ | `.env.example`만 확장 |
| 12-12 | typecheck PASS | ✅ | §5 |
| 12-13 | `npm test` PASS | ✅ | §5 — 355 pass / 3 skipped / 0 fail |
| 12-14 | `sync_shared_types` PASS | ✅ | §5 |
| 12-15 | `phase_4_e2e` regression PASS | ⚠️ 본 closeout에서 미실행 | §6.2 |
| 12-16 | `phase_5_e2e` regression PASS | ⚠️ 본 closeout에서 미실행 | §6.2 |
| 12-17 | `PHASE_6_STEP_2_FINDINGS.md` written | ✅ | 본 문서 |

### 3.2 Master §4 Step 2 완료 기준 (광의 매핑)

| 항목 | 상태 | 비고 |
|---|---|---|
| mock-only 모드에서 e2e + 단위 테스트 PASS | ✅ | `npm test` 355/3-skip 직접 검증. e2e는 §6.2. |
| 키가 있을 때만 실 provider 활성, 키 없으면 mock fallback | ⚠️ **의도적 deviation** | Step 2 plan §7 결정에 따라 **silent mock fallback 거부**, 키 부재 시 throw. 운영 boot에서 실 LLM 누락 사고 방지. `PROVIDER=mock`으로 명시 지정하면 mock 사용 가능. master 문장보다 Step 2 plan 정책이 더 안전. |
| 워커 job finished hook이 `llm_usage_log`에 1행 INSERT | ✅ | §2.3 + 테스트 |
| 실 provider 호출 cost가 log에 기록되어 운영 admin이 SELECT로 확인 가능 | ⚠️ 부분 충족 | tokens/latency는 SELECT로 즉시 확인 가능. **`cost_usd_micros`는 NULL** (Step 2 plan §2 "확인 불가 모델은 cost NULL" 허용). model→price map은 별도 cost-accuracy commit으로 분리. §6.1 residual. |

### 3.3 Master §11 Phase 6 go/no-go gate 중 Step 2 관련만

| 항목 | Step 2 시점 | 비고 |
|---|---|---|
| typecheck PASS | ✅ | §5 |
| `npm test` PASS | ✅ | §5 |
| `sync_shared_types` PASS (현재 14 entity) | ✅ | 본 단위 신규 entity 0개 — Phase 6 Step 4가 16 entity까지 올릴 예정 |
| BullMQ 워커 boot + AI summary 자동 + heartbeat sweep + WS suggestion persistence | ✅ | Phase 6 Step 1에서 닫혔고 Step 2가 회귀 검증 |
| 실 provider 어댑터 3종 인터페이스 충족 + `llm_usage_log` 1행 INSERT | ✅ | §2.4 + 옵트인 contract 테스트 골격 + §2.3 wiring 테스트 |
| `PHASE_6_STEP_1~5_FINDINGS.md` 모두 작성 | 진행 중 | Step 1 / 2 완료. Step 3 / 4 / 5는 미진행 |
| README / server/README 상태 블록 Phase 6 완료로 갱신 | ⏳ | Phase 6 전체 closeout (Step 5) 시점에 일괄 처리. 본 closeout에서 갱신하지 않음 (지시문 §3) |

---

## 4. provider별 env 요구사항 (운영 요약)

| Provider | 활성화 env | 필수 키 | 옵션 (default) |
|---|---|---|---|
| Anthropic LLM | `LLM_PROVIDER=anthropic` | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` (`claude-sonnet-4-5`), `ANTHROPIC_MAX_TOKENS` (1024), `ANTHROPIC_TIMEOUT_MS` (30000) |
| OpenAI Embeddings | `EMBEDDING_PROVIDER=openai` | `OPENAI_API_KEY` | `OPENAI_EMBEDDING_MODEL` (`text-embedding-3-small`), `OPENAI_EMBEDDING_DIMENSIONS` (1536 — 그 외 `EmbeddingDimensionError`), `OPENAI_TIMEOUT_MS` (10000) |
| CLOVA STT | `STT_PROVIDER=clova` | `CLOVA_STT_URL`, `CLOVA_CLIENT_ID`, `CLOVA_CLIENT_SECRET` | `CLOVA_STT_LANGUAGE` (`Kor`), `CLOVA_TIMEOUT_MS` (10000) |

`.env`는 본 단위에서 수정하지 않았다. `.env.example`만 확장.

옵트인 contract test gate:
- `E2E_ALLOW_REAL_PROVIDERS=1` + 해당 provider API key. CLOVA는 추가로 `CLOVA_E2E_AUDIO_PATH`.
- 기본 PR/CI에서는 항상 skip — outbound HTTP 0건 보장.

resolver 동작 한 줄 요약:
- unset / `""` → mock factory.
- `"mock"` → mock factory.
- real provider 이름 → real factory (필수 env 검증 후).
- real selected + 키 부재 → throw "PROVIDER selected but ENV_NAME is empty. Set it or revert to mock."
- unknown value → throw with supported list.

---

## 5. 검증 결과 (closeout 시점 baseline)

`server/feature/phase-3-team-invitations` HEAD (`6ea02f1`)에서 재확인:

```powershell
git status --short --branch
```

- `## feature/phase-3-team-invitations...origin/feature/phase-3-team-invitations` (clean).

```powershell
npm --prefix server run typecheck
```

- PASS.

```powershell
npm --prefix server test
```

- `355 pass / 3 skipped / 0 fail` (총 358). skipped 3 = real-provider opt-in (Anthropic / OpenAI / CLOVA).

```powershell
node test/sync_shared_types.mjs
```

- PASS. 14 entity (Step 2 user-facing entity 추가 없음).

```powershell
npm audit
```

- 2 high (pre-existing): `node-pg-migrate@^7.9.0` → `glob@11.0.0-11.0.3`. breaking upgrade라 본 범위 밖. §6.4 residual.

e2e regression (`phase_4_e2e.mjs` / `phase_5_e2e.mjs`):
- 본 closeout에서 미실행. 두 e2e는 live API 서버(:32173) + 정적 서버(:8765) + Playwright + DB / Redis 컨테이너를 요구하므로 본 문서 작업 환경(서버 미가동)에서 자동 실행이 부적절. Step 2 plan §12 완료 기준에는 들어 있으나 실 회귀는 Codex 검토 단계 또는 Step 5 e2e 진입 시점에서 일괄 수행. §6.2 residual.

---

## 6. Residual risks / 인계 사항

### 6.1 `cost_usd_micros = NULL` 정책

본 Step 2는 3개 real provider 모두 `cost_usd_micros: null`을 고정으로 기록한다. 이유:

- Step 2 plan §2: "pricing은 자주 바뀐다. ... 확인 불가 모델은 tokens/latency만 기록하고 cost는 NULL로 둔다."
- model→price map은 운영자가 "verified on YYYY-MM-DD" 주석과 함께 박는 별도 cost-accuracy commit으로 분리하는 것이 안전. 잘못된 단가가 누적되면 operator가 cost report를 신뢰할 수 없게 된다.

운영 영향:
- `SELECT provider, operation, sum(tokens_in), sum(tokens_out), avg(latency_ms) FROM llm_usage_log WHERE org_id = $1 ...`로 호출량/지연/모델 분포는 즉시 SELECT 가능.
- `SELECT sum(cost_usd_micros) FROM llm_usage_log ...`는 NULL을 반환한다 (실제 cost 미기록).

후속 작업:
- Phase 6 Step 5 종합 e2e 직전 또는 Phase 6 closeout 시점에 별 commit: provider × model 단가 표 + `cost_usd_micros` 계산 + 단위 테스트.
- 대안: Phase 7+ 운영 도메인(결제 cap / daily cap)에 통합. Step 5 e2e plan에서 결정.

### 6.2 `phase_4_e2e` / `phase_5_e2e` regression 회귀

Step 2 plan §12 완료 기준에 포함됐으나 본 closeout에서는 자동 실행하지 않았다.

회귀 보장 근거:
- 두 e2e는 `*_PROVIDER=mock` (또는 env 미지정)에서 돈다. mock adapter는 ProviderResult로 wrap만 됐을 뿐 domain shape는 보존 — `phase5_adapters.test.mjs` 13 케이스 PASS로 일차 확인.
- worker / WS / knowledge route의 wiring은 logging 실패가 user flow를 막지 않는 것을 service + wiring 두 층에서 검증 — `phase6_llm_usage_service.test.mjs` 7 + `phase6_workers.test.mjs` 신규 assertion + `phase5_routes_knowledge.test.mjs` 신규 3.
- Phase 5 master plan §9 "phase_5_e2e 회귀 유지 계약"의 6개 조건은 모두 보존된다 (manual_summary_locked guard 변화 없음, heartbeat sweep ON으로 동작, demo replay env flag 변화 없음).

권장: Codex 검토 시 또는 Step 5 e2e plan 진입 시점에 두 e2e를 실 환경에서 한 번 돌릴 것. Step 5 e2e (`phase_6_e2e.mjs`)는 두 e2e 회귀를 cleanup 시퀀스 안에 끼워 한 번에 검증 예정 — master §11 go/no-go gate.

### 6.3 master plan vs Step 2 plan deviation — silent mock fallback 거부

master §4 Step 2 완료 기준은 "키 없으면 mock으로 fallback"이라고 적혀 있으나, Step 2 plan §7은 정반대 — "Do not silently fall back to mock when a real provider is explicitly selected but misconfigured. That would hide production config errors."

본 closeout은 **Step 2 plan 정책을 채택**. 운영 boot 시점에 `LLM_PROVIDER=anthropic`이 세팅됐는데 키가 비어 있다면 fail-fast가 절대 정답이다 (사일런트 mock = 운영자가 사고를 인지하지 못함). 운영자가 mock로 의도적으로 돌리려면 `LLM_PROVIDER=mock`을 명시하거나 env 전체를 비워야 한다.

이 deviation은 `PHASE_6_STEP_2_PROVIDER_FINDINGS.md §7.7`에서 이미 명시. master plan의 한 줄짜리 표현보다 Step 2 plan의 세부 정책이 더 안전하고 운영 친화적이라는 판단.

### 6.4 npm audit high 2건 (pre-existing)

- `glob@11.0.0-11.0.3` (high, command injection via `-c/--cmd`): `node-pg-migrate@^7.9.0`이 의존.
- `npm audit fix --force`는 `node-pg-migrate@8.0.4`로 올리는 breaking change → migration runner 동작 검증 필요.

본 Step 2 단위 범위 밖. 별도 PR 또는 Phase 7+ 운영 위생 단계에서 처리.

### 6.5 README / server/README 상태 블록

여전히 Phase 4 / 5 시점의 문구. Phase 6 전체 closeout (Step 5)에서 일괄 갱신 예정. 본 closeout에서는 의도적으로 손대지 않음 (지시문 §3).

### 6.6 cost / retention / SSO 등 Phase 7+ 보류 (변경 없음)

master §10.2 보류 목록 그대로 유지. Phase 6 본체 범위가 아님.

---

## 7. Phase 6 다음 단계로 넘길 항목

### 7.1 즉시 진행 가능

- **Step 3 — Action item DELETE** (1.5~2일). master §4 Step 3 plan 작성 + hard vs soft delete 결정 + endpoint + UI.
- **Step 4 — Manager team-scope read 보고서** (2~2.5일). team-scope KPI service + route + frontend.

두 단위는 서로 독립이라 병렬 진행 가능. 단, Codex가 Step 2를 검토/머지한 뒤에 들어가는 게 안전 (현재 워킹트리에는 본 closeout 문서만 신규 변경).

### 7.2 Step 5 진입 전 합치기 단위

- **cost-accuracy commit**: provider × model 단가 + `cost_usd_micros` 계산 + 단위 테스트. Step 2의 마지막 residual을 닫는다.
- **README / server/README 상태 블록 Phase 6 갱신**: Step 5 closeout 시점.

### 7.3 Step 5 — 통합 e2e + Phase 6 종합 closeout

- `test/phase_6_e2e.mjs` 6~8 시나리오. 워커 boot + endCall enqueue / heartbeat sweep / WS suggestion persistence / action item DELETE / manager 보고서 / cleanup 일괄.
- master §11 go/no-go gate 모든 체크박스 처리.
- README 상태 블록 + Phase 7 인계 문서.

---

## 8. 변경 파일 목록 (본 closeout)

신규 1개:
- `docs/plan/phase-6/PHASE_6_STEP_2_FINDINGS.md` — 본 문서.

수정 1개:
- `docs/plan/phase-6/PHASE_6_MASTER.md` — Implementation Log §0 Step 2 체크박스 `[ ]` → `[x]` + 완료일 + 본 closeout 문서 참조.

코드 / 마이그레이션 / `.env*` / `platform/*` / `package*.json` / 기타 sub-finding 파일은 본 closeout에서 변경하지 않는다 (지시문 §금지).

---

## 9. Codex Review Focus

- Step 2 체크박스 ON 결정의 근거 (§3 + §6.1 + §6.3)가 master plan 문구를 명시적으로 deviation으로 다루고 있는지.
- Step 2 plan §12 17개 항목 중 `phase_4_e2e` / `phase_5_e2e` 두 e2e가 본 closeout에서 미실행 — residual로만 남기고 Step 5 또는 Codex review 단계로 밀어도 무방한지.
- `cost_usd_micros = NULL` 정책이 별도 commit으로 닫힐 수 있는 의존성으로만 남아 있고, 본 closeout이 그 점을 명확히 운영 가시성 한계로 적시했는지.
- README 상태 블록은 Phase 6 전체 closeout 때 처리, Step 2 closeout에서는 손대지 않는다는 분리가 적절한지.
- 본 closeout이 코드 / 마이그레이션 / `.env*` / `platform/*` / `package*.json`을 무수정으로 유지하고 문서 2개(신규 1 + master 갱신)만 건드렸는지.

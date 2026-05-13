# Phase 6 Step 2 Real Provider Adapter Findings

> 완료일: 2026-05-13
> 범위: Step 2의 "real provider adapter" 단위 — Anthropic Messages / OpenAI Embeddings / Naver Cloud CLOVA Speech REST 어댑터 + resolver wiring + `.env.example`. usage logging wiring은 본 단위 *이전* commit(`ba4ab8d Wire Phase 6 provider usage logging`)에서 닫혔다.
> 기준 계획: `docs/plan/phase-6/PHASE_6_STEP_2_PLAN.md` §5·§7.
> 선행 단위:
> - `9c027cf Add Phase 6 usage log schema`
> - `b386e96 Add Phase 6 usage log repository tests`
> - `99f25e4 Add Phase 6 provider usage contract`
> - `ba4ab8d Wire Phase 6 provider usage logging`
> 현재 브랜치: `feature/phase-3-team-invitations`

---

## 1. 현재 상태

Phase 6 Step 2 종합 완료가 *아니다*. 본 단위는 real provider 어댑터 3종 + resolver + `.env.example` + dependency 추가만 닫는다. 남은 작업은 §6 참고. `PHASE_6_MASTER.md` Step 2 체크박스는 종합 findings 시점까지 OFF 유지.

기본 테스트(`npm --prefix server test`)는 실 네트워크 호출을 0건 만든다. 실 provider contract 테스트는 `E2E_ALLOW_REAL_PROVIDERS=1` + 해당 API key 환경변수가 모두 있을 때만 실행된다.

---

## 2. 변경 파일

신규 5개, 수정 5개.

### 신규
- `server/src/adapters/llm/anthropic.ts` — `@anthropic-ai/sdk` 기반 Messages API client. 4-field summary + suggestion array JSON-strict parsing. 401/403 fail-fast, 429/5xx throw (BullMQ retry). cost=null.
- `server/src/adapters/embedding/openai.ts` — `openai` SDK 기반 Embeddings client. `dimensions: 1536` 강제 (요청 + 응답 검증). batch는 단일 usage row.
- `server/src/adapters/stt/clova.ts` — Naver Cloud CLOVA Speech Recognition REST client. global fetch + AbortController + DI 가능한 `fetchImpl`. Buffer-only; string 입력은 `SttUnsupportedInputError`. 401/403 → `ClovaAuthError`, 그 외 비-2xx → `ClovaResponseError`.
- `server/test/phase6_real_adapters.test.mjs` — real adapter 단위 + 옵트인 contract test (skipped by default).
- `docs/plan/phase-6/PHASE_6_STEP_2_PROVIDER_FINDINGS.md` — 본 findings.

### 수정
- `server/src/adapters/index.ts` — resolver가 `mock|anthropic` / `mock|openai` / `mock|clova` 분기를 갖도록 확장. unset/empty → mock. real selected + key 없음 → throw. 알 수 없는 값 → throw.
- `server/.env.example` — provider env section (`STT_PROVIDER` / `LLM_PROVIDER` / `EMBEDDING_PROVIDER` + 각 provider별 키/모델/timeout).
- `server/package.json` — `@anthropic-ai/sdk@^0.95.2`, `openai@^6.37.0` dependency 추가.
- `server/package-lock.json` — npm install 결과 lockfile 재생성 (8 packages added).
- `server/test/phase5_adapters.test.mjs` — resolver test를 새 분기 매트릭스로 갱신 + scoped env helper(`withEnv`) 추가.

---

## 3. 검증 결과

```powershell
npm --prefix server run typecheck
```

- PASS.

```powershell
npm --prefix server test
```

- PASS. `355 pass / 3 skipped / 0 fail` (skipped 3개 = `E2E_ALLOW_REAL_PROVIDERS` opt-in 테스트). 이전 baseline 333 + 신규 25 = 358 total.

```powershell
node test/sync_shared_types.mjs
```

- PASS. 14 entity 그대로 (본 단위는 user-facing entity 추가 없음).

```powershell
npm audit
```

- 2 high (pre-existing): `node-pg-migrate` → `glob`. 본 단위와 무관, 별도 PR.

---

## 4. provider별 env 요구사항

| Provider | 활성화 env | 필수 키 | 옵션 |
|---|---|---|---|
| Anthropic LLM | `LLM_PROVIDER=anthropic` | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` (default `claude-sonnet-4-5`), `ANTHROPIC_MAX_TOKENS` (1024), `ANTHROPIC_TIMEOUT_MS` (30000) |
| OpenAI Embeddings | `EMBEDDING_PROVIDER=openai` | `OPENAI_API_KEY` | `OPENAI_EMBEDDING_MODEL` (default `text-embedding-3-small`), `OPENAI_EMBEDDING_DIMENSIONS` (1536 — 다른 값은 EmbeddingDimensionError로 거부), `OPENAI_TIMEOUT_MS` (10000) |
| Naver Cloud CLOVA STT | `STT_PROVIDER=clova` | `CLOVA_STT_URL`, `CLOVA_CLIENT_ID`, `CLOVA_CLIENT_SECRET` | `CLOVA_STT_LANGUAGE` (default `Kor`), `CLOVA_TIMEOUT_MS` (10000) |

`.env`은 본 작업에서 수정하지 않았다. `.env.example`만 확장.

옵트인 contract test gate:
- `E2E_ALLOW_REAL_PROVIDERS=1` + 해당 API key가 있을 때만 실행.
- CLOVA의 경우 `CLOVA_E2E_AUDIO_PATH` (실 오디오 파일 절대 경로)도 필요 — 미설정 시 test skip.

---

## 5. resolver 동작 요약

```
env 값        → 동작
─────────────────────────────────────────────────
unset / "" → mock (안전 기본값)
"mock" → mock factory
"anthropic" / "openai" / "clova" → real factory (env 검증 후)
↓
real selected + 필수 키 부재 → throw "<PROVIDER> selected but ENV_NAME is empty. Set it or revert to mock."
↓
unknown value → throw "PROVIDER='<value>' is not implemented in this build; supported values: mock, <real>."
```

- `STT_PROVIDER` / `LLM_PROVIDER` / `EMBEDDING_PROVIDER`는 서로 독립. 한 쪽만 real로 띄울 수 있다.
- 알 수 없는 값에는 supported 목록을 에러 메시지에 노출 (운영자가 typo 즉시 인지).
- whitespace-only key는 empty 취급 (`(env ?? "").trim()` 패턴).

---

## 6. 추가/수정한 테스트 목록

`server/test/phase5_adapters.test.mjs` (수정):
- `withEnv({...}, fn)` helper 추가 (env 변경을 test scope로 한정).
- 기존 resolver default test 갱신 — 새 분기 매트릭스.
- 기존 "unknown provider → throw" 케이스를 3개로 확장 (`STT_PROVIDER=whisper-cloud`, `LLM_PROVIDER=gemini`, `EMBEDDING_PROVIDER=voyage`).
- 빈 문자열 = unset 동작 검증.
- real provider selected + 키 부재 fail-fast: ANTHROPIC / OPENAI / CLOVA 각각.
- CLOVA 다중 누락 키 메시지 검증 (URL/ID/SECRET 모두 부재 → 메시지에 셋 다 노출).
- 실 네트워크 호출 없이 어댑터 instance 생성 검증 (3 provider × 1 케이스).

`server/test/phase6_real_adapters.test.mjs` (신규, 14 케이스):
- **CLOVA (stubbed fetch)** — 6 케이스
  - string fixture key → SttUnsupportedInputError.
  - Buffer audio + 헤더(`X-NCP-APIGW-API-KEY-ID/KEY`) + lang=Kor 쿼리 파라미터 검증.
  - `language: 'en-US'` → `lang=Eng` 매핑.
  - whitespace-only text 응답 → `value: null` + usage 기록.
  - 401 응답 → `ClovaAuthError`.
  - 500 응답 → `ClovaResponseError` with `status / body`.
- **OpenAI 생성자 가드** — 3 케이스
  - 빈 apiKey → throw.
  - 1536 외 dimensions → `EmbeddingDimensionError`.
  - 성공 생성 → `provider='openai'`, `dimensions=1536`.
- **Anthropic 생성자 가드** — 2 케이스
  - 빈 apiKey → throw.
  - 성공 생성 → `provider='anthropic'`.
- **Opt-in real-network smoke** — 3 케이스 (skip by default)
  - Anthropic end-to-end summarizeCall.
  - OpenAI end-to-end embed.
  - CLOVA end-to-end transcribeChunk (오디오 파일 path 필요).

기본 PR 테스트에서 22 pass + 3 skipped 추가 — 총 358 (이전 333).

---

## 7. 중요한 구현 결정

### 7.1 cost = NULL (Step 2 종합까지 유지)

PHASE_6_STEP_2_PLAN.md §2 "pricing은 자주 바뀐다. 확인 불가 모델은 tokens/latency만 기록하고 cost는 NULL로 둔다." 본 단위는 세 provider 모두 `cost_usd_micros: null`로 고정. `tokensIn` / `tokensOut` / `latencyMs`은 SDK / response에서 가능한 범위로 채움. 정확한 model→price map은 별도 commit으로 분리하여 verify-date 주석을 함께 박는 것이 목표 (Step 5 종합 또는 그 직전).

### 7.2 LLM JSON 강제

Anthropic Messages는 system prompt로 "JSON 객체만 출력 / 마크다운 금지"를 강제. 파싱은 `JSON.parse` + 명시적 enum/shape 검증 (sentiment / tone / type / title length). 검증 실패 시 `AnthropicResponseError` throw — `applyAiSummary`나 `persistSuggestionGroup`가 절대 corrupt row를 받지 않는다.

### 7.3 OpenAI 1536-dim 강제

`dimensions: 1536`을 요청 옵션으로 명시 + 응답 벡터마다 length 검증. pgvector 컬럼이 1536 고정이므로 잘못된 width는 boundary에서 즉시 `EmbeddingDimensionError`. 기존 route 에러 핸들러가 이 클래스를 400 invalid_embedding으로 매핑.

### 7.4 CLOVA REST 한정

PHASE_6_STEP_2_PLAN.md §5.3에 명시된 대로 realtime gRPC streaming은 미도입. 현재 product에 audio buffer 송신 경로가 없으므로 short-recognition REST만 구현. 첫 audio ingest 경로(Phase 7+ desktop app)가 들어오면 본 어댑터가 즉시 plug in 가능.

### 7.5 Clova `fetchImpl` DI

CLOVA 어댑터는 `globalThis.fetch`를 기본으로 사용하되, 옵션 `fetchImpl`로 stub fetch를 받을 수 있다. 테스트가 실 네트워크 없이 헤더 / 본문 / lang 쿼리 / 4xx-5xx 분기를 모두 검증.

### 7.6 fail-fast vs ProviderResult `failed`

real provider 모두 4xx/5xx는 throw로 일관 처리. ProviderResult `status='failed'`는 사용 안 함 (cost 0 그대로). 이유:
- 401/403은 misconfig — 즉시 발견되어야 함.
- 429/5xx는 transient — BullMQ retry가 받아야 함.
- 4xx parse error는 corrupt response — DB write를 절대 진행하면 안 됨.

`failed` status는 향후 retention 정책 / 운영 대시보드에서 의미가 생길 때 추가 도입 (Phase 7+).

### 7.7 fail-fast on misconfig vs silent mock fallback

resolver는 `LLM_PROVIDER=anthropic`인데 키가 비어있으면 **throw**. 사일런트 mock fallback은 의도적으로 거부 — 운영 boot가 실 LLM 없이 시작되는 사고를 막는다. 대신 운영자가 mock로 의도적으로 돌리려면 명시적으로 `LLM_PROVIDER=mock`을 세팅하거나 env를 비워야 한다.

---

## 8. 아직 남은 Step 2 항목

본 단위로 Step 2의 *기능* 범위는 거의 닫혔다. 남은 것은 cost 정확도와 종합 처리:

- **Model→price map + cost 계산** — `cost_usd_micros` 채우기. 모델별 단가 + 검증일 주석. 세 provider 각각.
- **PHASE_6_STEP_2_FINDINGS.md (Step 2 종합)** — schema / contract / wiring / real-provider 네 단위를 묶은 최종 findings. Step 2 closeout 후에 `PHASE_6_MASTER.md` 체크박스를 ON.
- **Step 2 회귀 e2e (옵션)** — Step 5 종합 e2e에 합칠 수도 있고 별 e2e로 둘 수도 있음. master plan §4 Step 5 결정.

여전히 Step 3 (action item DELETE) / Step 4 (manager team-scope) / Step 5 (Phase 6 종합 e2e)는 별도 단위.

---

## 9. Codex Review Focus

- 기본 테스트(`npm test`)에서 outbound HTTP 0건이 보장되는지 (CLOVA는 stub fetch, Anthropic/OpenAI는 construction only).
- resolver fail-fast가 misconfig를 즉시 잡는지 (anthropic/openai/clova 각각).
- `cost_usd_micros: null` 결정이 코드 + findings 양쪽에 명시되어 있는지.
- pgvector dimension 강제가 boundary 양쪽(요청 + 응답)에 모두 박혀 있는지.
- `.env`은 무수정인지, `.env.example`만 확장됐는지.
- `PHASE_6_MASTER.md` Step 2 체크박스가 여전히 OFF인지.

# Phase 7 Step 5 Plan — llm usage cost map

작성일: 2026-05-18

상위 문서: `PHASE_7_MASTER.md`

선행 완료:

- Step 1 — Resend email delivery + transactional `email_outbox`
- Step 2 — TOTP MFA / session hardening
- Step 3 — `activity_log` audit trail + admin query surface
- Step 4 — retention enforce cron

이번 step의 목적은 Phase 6에서 의도적으로 `NULL`로 남긴 `llm_usage_log.cost_usd_micros`를, 지원 provider/model에 한해 앞으로 발생하는 usage row부터 채우는 것이다. 이 step은 운영 비용 추정의 최소 단위이며, role-based menu / report drilldown / billing cap은 Step 6+로 분리한다.

---

## 1. Current State

### 1.1 이미 있는 것

- `llm_usage_log`
  - `cost_usd_micros bigint CHECK (cost_usd_micros IS NULL OR cost_usd_micros >= 0)`
  - FORCE RLS, app role append-only.
  - repository/service insert path는 이미 `cost_usd_micros` 값을 그대로 저장한다.
- Adapter usage envelope
  - `ProviderUsage.costUsdMicros: number | null`
  - mock adapters는 `0`.
  - real adapters는 현재 모두 `null`.
- Usage call sites
  - call summary worker.
  - live WS suggestion generation.
  - knowledge embedding route.
  - STT adapter contract는 있으나 현재 product route/audio ingest surface는 없다.
- Default real models
  - Anthropic LLM: `claude-sonnet-4-5`
  - OpenAI embedding: `text-embedding-3-small`
  - Clova STT: `clova-speech-recog-rest`

### 1.2 아직 없는 것

- provider/model별 price map source-of-truth.
- 가격 검증일과 source URL이 남는 코드 주석.
- unknown model / unknown billing unit에 대한 명시적 `NULL` 정책 테스트.
- 과거 `cost_usd_micros IS NULL` row backfill.

---

## 2. Scope

### 한다

1. **Static price map helper**
   - 신규 파일 후보: `server/src/adapters/pricing.ts`.
   - provider + operation + model + token usage를 받아 `costUsdMicros`를 계산한다.
   - 정수 micro-dollar 계산만 사용한다. floating-point dollar 계산은 금지.
   - 각 가격 상수에는 구현 당일 확인한 공식 pricing URL과 `verified on YYYY-MM-DD` 주석을 붙인다.

2. **Adapter wiring**
   - `server/src/adapters/llm/anthropic.ts`
     - input/output token 가격을 분리 계산.
     - `call_summary`, `call_suggestion` 둘 다 같은 helper 사용.
   - `server/src/adapters/embedding/openai.ts`
     - `tokensIn` 기준 embedding 비용 계산.
     - `tokensOut`은 계속 `0`.
   - `server/src/adapters/stt/clova.ts`
     - 현재는 audio duration이 usage envelope에 없으므로 cost는 `NULL` 유지.
     - 이유와 후속 조건을 주석/테스트로 고정한다.
   - mock adapters는 계속 `0`.

3. **Unknown/unsupported policy**
   - price map에 없는 real model은 request를 실패시키지 않는다.
   - usage row는 tokens/latency/model을 기록하고 `cost_usd_micros=NULL`로 둔다.
   - 운영자가 알 수 있도록 metadata에 `cost_status: "unknown_model"` 또는 동등한 작은 marker를 남긴다.

4. **Tests**
   - helper 단위 테스트: known model 계산, rounding, unknown model, missing tokens, mock zero.
   - adapter boundary 테스트: fake Anthropic/OpenAI responses가 non-null cost를 반환하는지 검증.
   - Clova는 cost null 유지 이유를 테스트로 고정.
   - 기존 usage logging tests 중 `cost_usd_micros` 기대값이 Step 2 정책에 묶여 있으면 갱신한다.

5. **Docs**
   - `PHASE_7_MASTER.md` Step 5 진행 상태 갱신.
   - Step 5 findings 신규 작성.
   - README 현재 단계/로드맵 한 줄 갱신.

### 안 한다

- 과거 `llm_usage_log.cost_usd_micros IS NULL` row backfill.
- billing/subscription cap enforcement.
- admin cost dashboard 또는 reports UI.
- org별 custom pricing.
- provider invoice reconciliation.
- STT audio duration mapper.
- pricing을 DB table로 관리하는 admin UI.

---

## 3. Decisions

### 3.1 계산 위치

결정: adapter boundary에서 `ProviderUsage.costUsdMicros`를 채운다.

이유:

- 실제 provider가 반환한 model명과 usage token count는 adapter가 가장 정확히 안다.
- `services/llmUsage.ts`는 append-only insert wrapper로 유지한다. 이 서비스에 provider별 가격 지식을 넣으면 transport boundary와 persistence boundary가 섞인다.
- logging 실패는 기존처럼 user/provider flow를 막지 않아야 한다.

### 3.2 Price map 형태

가격 상수는 provider별 record로 둔다.

```ts
interface TokenPrice {
  inputUsdMicrosPerMillionTokens: bigint;
  outputUsdMicrosPerMillionTokens?: bigint;
  verifiedOn: "YYYY-MM-DD";
  source: "official-provider-pricing-url";
}
```

계산은 integer ceil로 한다.

```text
inputCostMicros  = ceil(tokensIn  * inputUsdMicrosPerMillionTokens  / 1_000_000)
outputCostMicros = ceil(tokensOut * outputUsdMicrosPerMillionTokens / 1_000_000)
total            = inputCostMicros + outputCostMicros
```

주의:

- 구현일에 공식 pricing page를 다시 확인한다. 가격은 자주 바뀌므로 지금 계획서에는 단가 숫자를 박지 않는다.
- 코드에는 확인일과 URL을 남긴다.
- `number`로 반환하기 전 `Number.isSafeInteger` 범위를 확인한다. 내부 계산은 `bigint`를 우선한다.

### 3.3 모델 매칭

결정: price map은 normalized exact match를 사용한다.

- `model.trim().toLowerCase()`를 key로 사용한다.
- 원본 `usage.model` 문자열은 그대로 보존한다.
- alias/prefix guessing은 하지 않는다. 예: `claude-sonnet-*` wildcard 매칭 금지.
- unknown model은 cost `NULL`이다. 잘못된 guess로 비용을 과대/과소 기록하는 것보다 낫다.

### 3.4 NULL vs 0

정책:

| 상황 | cost |
|---|---|
| mock provider | `0` |
| real provider, 실제 provider call이 skip됨, token 0 | `0` |
| real provider, known model, 필요한 token count 있음 | calculated |
| real provider, known model, token count 누락 | `NULL` |
| real provider, unknown model | `NULL` |
| Clova STT, audio duration 없음 | `NULL` |

`NULL`은 "비용 없음"이 아니라 "현재 코드가 신뢰 가능한 비용을 계산하지 못함"이라는 뜻이다. 이 의미를 findings에 다시 적는다.

### 3.5 Backfill

결정: Step 5에서는 backfill하지 않는다.

이유:

- 과거 row의 정확한 provider pricing effective date를 보장할 수 없다.
- `llm_usage_log`는 app role append-only이고, backfill은 admin/migration 권한 작업이 된다.
- 운영 비용 추정은 Step 5 이후 row부터 가능하게 하는 것이 이번 범위의 목표다.

나중에 backfill이 필요하면 별도 admin script로 만든다. 그 script는 date range, provider/model, verified price version을 명시적으로 받아야 한다.

---

## 4. Implementation Plan

### 4.1 Pricing helper

신규 파일: `server/src/adapters/pricing.ts`

예상 export:

```ts
export type CostStatus =
  | "calculated"
  | "zero"
  | "unknown_model"
  | "missing_usage"
  | "unsupported_unit";

export interface UsageCostInput {
  provider: ProviderName;
  operation: ProviderOperation;
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
}

export interface UsageCostResult {
  costUsdMicros: number | null;
  status: CostStatus;
  pricingVerifiedOn?: string;
}

export function calculateUsageCostUsdMicros(input: UsageCostInput): UsageCostResult;
```

Helper rules:

- `provider="mock"`는 항상 `{ costUsdMicros: 0, status: "zero" }`.
- Anthropic LLM operation은 input/output token 모두 사용.
- OpenAI embedding operation은 input token만 사용.
- Clova STT는 `unsupported_unit`로 `NULL`.
- 음수 token, non-integer token은 `missing_usage` 또는 throw 중 하나를 선택한다. 권장: adapter boundary 내부 invariant 위반이므로 throw하고 테스트로 고정한다.
- unknown provider/operation 조합은 compile-time union으로 막되, runtime defensive branch는 `NULL`을 반환한다.

### 4.2 Anthropic adapter wiring

파일: `server/src/adapters/llm/anthropic.ts`

변경:

- `makeUsage(...)`에서 현재 `costUsdMicros: null` 고정을 제거.
- `calculateUsageCostUsdMicros` 호출.
- 계산 결과가 `unknown_model`이면 `usage.metadata.cost_status`에 marker를 넣는다.
- response model이 있으면 지금처럼 `message.model ?? configuredModel` 사용한다. price map도 그 최종 model 문자열 기준이다.

테스트 포인트:

- fake Messages API가 `usage.input_tokens=1000`, `usage.output_tokens=200`을 반환할 때 cost가 non-null.
- configured default model과 response model이 다르면 response model 기준으로 계산.
- unknown model이면 tokens는 보존되고 cost는 `NULL`.

### 4.3 OpenAI embedding adapter wiring

파일: `server/src/adapters/embedding/openai.ts`

변경:

- `makeUsage(...)`에서 cost 계산.
- `response.model ?? model` 기준으로 price map lookup.
- empty input skip은 token 0 / cost 0.

테스트 포인트:

- fake embedding response의 `usage.prompt_tokens` 기준으로 cost가 non-null.
- unsupported model이면 cost `NULL`.
- `usage.prompt_tokens`가 누락되면 cost `NULL`, route 자체는 기존처럼 성공.

### 4.4 Clova STT policy lock

파일: `server/src/adapters/stt/clova.ts`

변경:

- 비용 계산 helper를 호출하지 않거나, helper가 `unsupported_unit`을 반환하도록 명시한다.
- 주석에 "현재 usage envelope에 audio duration이 없어 per-duration billing 계산 불가"를 남긴다.

후속 조건:

- 실제 audio ingest route가 생기고 byte/audio duration을 reliable하게 계산할 수 있을 때 `ProviderUsage.metadata.audio_duration_ms` 또는 전용 field를 추가한다.
- 그때 Clova price map을 per-second/per-15-second unit으로 확장한다.

### 4.5 Tests

신규 후보:

- `server/test/phase7_step5_llm_pricing.test.mjs`

테스트 케이스:

1. mock provider returns zero cost.
2. Anthropic known model calculates input + output cost with integer ceil.
3. OpenAI embedding known model calculates input-only cost.
4. unknown real model returns `NULL` with `unknown_model`.
5. missing tokens returns `NULL` with `missing_usage`.
6. skipped zero-token call returns `0`.
7. negative / fractional token count is rejected or classified consistently.

기존 테스트 갱신 후보:

- `server/test/phase6_real_adapters.test.mjs`
  - fake Anthropic/OpenAI usage response에서 `costUsdMicros !== null` assertion 추가.
  - Clova는 `costUsdMicros === null` 유지 assertion.
- `server/test/phase6_llm_usage_service.test.mjs`
  - service는 pass-through임을 유지. calculator 테스트와 중복하지 않는다.
- `server/test/phase5_adapters.test.mjs`
  - mock cost `0` 기대는 유지.

---

## 5. Validation

필수:

```powershell
npm --prefix server run typecheck
node test/sync_shared_types.mjs
npx tsx --test --test-concurrency=1 test/phase7_step5_llm_pricing.test.mjs
npx tsx --test --test-concurrency=1 test/phase6_real_adapters.test.mjs
npm --prefix server test
```

조건부:

- shared type 변경이 없으므로 `sync_shared_types`는 regression check 용도다.
- migration이 없으면 `db:migrate:up`은 필수는 아니지만, closeout에서 "No migrations to run" 확인은 허용한다.

---

## 6. Acceptance Criteria

- [ ] 지원 real provider/model의 usage row가 `cost_usd_micros`를 non-null로 기록한다.
- [ ] unknown model은 provider flow를 실패시키지 않고 `cost_usd_micros=NULL`을 기록한다.
- [ ] mock provider는 계속 `0`을 기록한다.
- [ ] Clova STT는 duration 없음으로 `NULL`을 유지하고 그 이유가 테스트/문서에 남는다.
- [ ] 가격 계산은 integer micro-dollar로 수행되고 rounding policy가 테스트된다.
- [ ] 각 price constant에는 공식 source URL + verified date 주석이 있다.
- [ ] 기존 usage logging failure-is-non-blocking 계약은 유지된다.
- [ ] full server test가 통과한다.

---

## 7. Risks

### 7.1 Pricing staleness

가격은 자주 바뀐다. 구현자는 코딩 당일 공식 pricing page를 다시 확인해야 한다. 확인하지 못한 모델은 `NULL`로 두는 것이 맞다.

### 7.2 Model rename / provider alias

provider가 response model명을 바꾸면 exact match가 실패해 cost가 `NULL`이 된다. 이 동작은 의도적이다. wildcard로 추정 계산하지 않는다.

### 7.3 Historical cost gap

Step 5 이전 row는 계속 `NULL`일 수 있다. README/findings에서 "Step 5 이후 발생분부터 비용 추정 가능"이라고 표현한다.

### 7.4 Billing cap과 혼동

이번 step은 observability/cost estimation이다. billing cap enforcement가 아니다. cap은 Step 9 또는 별도 billing step에서 사용량 집계와 plan limit 정책을 함께 설계한다.

---

## 8. Handoff To Implementation Agent

구현 순서:

1. 공식 pricing page 확인 후 `server/src/adapters/pricing.ts` 작성.
2. `phase7_step5_llm_pricing.test.mjs`로 calculator부터 고정.
3. Anthropic/OpenAI adapter에 helper 연결.
4. Clova null 정책 주석/테스트 고정.
5. 기존 adapter tests의 cost expectation 갱신.
6. typecheck + targeted tests + full server test.
7. `PHASE_7_STEP_5_FINDINGS.md`, `PHASE_7_MASTER.md`, `README.md` 갱신.

커밋 단위 추천:

1. pricing helper + calculator tests.
2. adapter wiring + adapter tests.
3. docs closeout.


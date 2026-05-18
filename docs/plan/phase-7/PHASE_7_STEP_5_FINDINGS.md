# Phase 7 Step 5 Findings — llm usage cost map

작성일: 2026-05-18

상위 문서: `PHASE_7_MASTER.md` · 상세 계획: `PHASE_7_STEP_5_PLAN.md`.

---

## 1. 산출물

| 영역 | 위치 |
|---|---|
| Pricing helper | `server/src/adapters/pricing.ts` — `calculateUsageCostUsdMicros(input)`, `applyUsageCost(usage, result)`, `UsageCostInputError`. bigint micro-USD 내부 계산 + integer ceil. |
| Helper 테스트 | `server/test/phase7_step5_llm_pricing.test.mjs` — 26 시나리오 (mock zero / Anthropic input+output / OpenAI input-only / skipped 0-token / unknown model / missing usage / Clova unsupported_unit / 음수·소수 throw / rounding / 모델명 정규화 / applyUsageCost metadata fold). |
| Anthropic adapter | `server/src/adapters/llm/anthropic.ts` — `makeUsage` 안에서 helper 호출, status='failed' 제외하고 모든 경로가 cost 계산. |
| OpenAI embedding adapter | `server/src/adapters/embedding/openai.ts` — 동일 패턴. embedding이라 `tokensOut=0` 고정. |
| Clova STT adapter | `server/src/adapters/stt/clova.ts` — helper 호출 결과가 `unsupported_unit`이라 cost는 null, metadata.cost_status에 marker. 정책 lock 주석 헤더 + 본문에 명시. |
| 기존 테스트 갱신 | `server/test/phase6_real_adapters.test.mjs` — Clova 빈 결과 테스트에 cost null + `unsupported_unit` assertion 추가. Anthropic·OpenAI에 skip-path Step 5 wiring 테스트 4개 추가 (no-network) + opt-in e2e 테스트 2개에 known/unknown model 분기 cost assertion 추가. |
| Docs | 이 파일 + `PHASE_7_MASTER.md` Step 5 상태 갱신 + README 현재 단계 한 줄 갱신. |

---

## 2. 검증된 공식 가격 (2026-05-18 기준)

### 2.1 Anthropic LLM

Source: `https://platform.claude.com/docs/en/about-claude/pricing`

| Model | Input ($/MTok) | Output ($/MTok) | Stored as (micro-USD per million) |
|---|---:|---:|---|
| `claude-sonnet-4-5` (default) | $3 | $15 | input=`3_000_000n`, output=`15_000_000n` |
| `claude-sonnet-4-6` | $3 | $15 | same |
| `claude-opus-4-7` | $5 | $25 | input=`5_000_000n`, output=`25_000_000n` |
| `claude-opus-4-6` | $5 | $25 | same |
| `claude-opus-4-5` | $5 | $25 | same |
| `claude-haiku-4-5` | $1 | $5 | input=`1_000_000n`, output=`5_000_000n` |

`claude-opus-4-1` ($15/$75)과 deprecated 모델, batch/cache 변형 가격은 의도적으로 map에 넣지 않았다. 이 product가 호출하는 default model에 한정.

### 2.2 OpenAI Embedding

Source: `https://developers.openai.com/api/docs/models/text-embedding-3-small` (also `https://platform.openai.com/docs/pricing`).

| Model | Input ($/MTok) | Stored as |
|---|---:|---|
| `text-embedding-3-small` (default) | $0.02 | input=`20_000n` |
| `text-embedding-3-large` | $0.13 | input=`130_000n` |

Embedding은 output token 없음 — `tokensOut`은 어댑터에서 0으로 고정, 가격 helper도 input-only 계산.

### 2.3 Clova STT

가격 페이지 확인하지 **않았다**. 의도적이다. 현재 `ProviderUsage` envelope에 audio duration 필드가 없어서 per-15-second billing을 계산할 수 없다. helper가 `unsupported_unit`을 반환하고 cost는 null로 유지. 오디오 ingest surface가 Phase 8/P2에 들어올 때 동시에 가격 entry 추가.

---

## 3. 계산 모델

### 3.1 단위

내부 계산은 **bigint micro-USD per million tokens**.

```ts
// 1 USD = 1_000_000 micro-USD
// $3 per 1M tokens → 3_000_000 micro-USD per 1M tokens
inputUsdMicrosPerMillionTokens: 3_000_000n
```

한 호출의 cost:

```
cost_micros = ceil(tokens * pricePerMillion / 1_000_000)
```

bigint ceiling division으로 구현(`bigintCeilDiv(a, b) = (a + b - 1) / b`). float dollar 계산은 어디에도 없다.

### 3.2 Number 변환

최종 return은 `number`. `Number.isSafeInteger` 범위(2^53 - 1) 초과 시 throw — 정상 사용량에선 절대 도달하지 않지만 미래 가격표 확장에 대한 tripwire.

### 3.3 모델명 매칭

`model.trim().toLowerCase()` 단순 정규화 후 exact match. wildcard / prefix / alias resolution **없음**.

- 어댑터가 `claude-sonnet-4-5` 또는 `Claude-Sonnet-4-5 `를 보내면 match.
- 어댑터가 dated snapshot id (`claude-sonnet-4-5-20250929` 등)를 보내면 miss → `unknown_model` 반환.

후자 케이스에 대한 정책은 plan §3.3 + §7.2와 일치 — 추측 계산은 하지 않는다. 운영 중 SDK가 dated snapshot을 일관되게 반환하면, 그 키를 별도 PR로 map에 추가한다.

---

## 4. CostStatus 분류

| 상황 | cost | status | metadata.pricing_verified_on | metadata.cost_status |
|---|:---:|:---|:---:|:---|
| mock provider | `0` | `zero` | — | — |
| real, known model, succeeded with tokens | calculated | `calculated` | set | — |
| real, known model, skipped (0/0 tokens) | `0` | `zero` | set | — |
| real, known model, succeeded but tokens missing | `null` | `missing_usage` | — | `missing_usage` |
| real, unknown model | `null` | `unknown_model` | — | `unknown_model` |
| Clova STT (모든 경우) | `null` | `unsupported_unit` | — | `unsupported_unit` |
| status='failed' | `null` | (helper 호출 안 함) | — | — |

`status='failed'` 경로는 adapter `makeUsage`에서 helper 호출을 건너뛴다. 실패는 비용 추정 대상이 아니다.

운영자가 `llm_usage_log.metadata`를 조회하면 cost가 null인 이유가 한눈에 보인다:

- `cost_status='unknown_model'` → 가격표 갱신 필요
- `cost_status='missing_usage'` → adapter parsing 버그 또는 provider 응답 변경
- `cost_status='unsupported_unit'` → Clova STT (정상)
- 표시 없음 + cost null → adapter가 helper를 호출하지 않은 경로 (status='failed' 등)

---

## 5. Backfill 정책

Plan §3.5 결정대로 **과거 row에 대한 backfill은 하지 않는다**.

이유:

- 과거 row의 정확한 provider pricing effective date를 보장할 수 없다.
- `llm_usage_log`는 app role append-only, backfill은 admin/migration 권한 작업.
- 운영 비용 추정은 Step 5 deployment 이후 발생분부터 가능하게 하는 것이 이번 step의 목표.

향후 backfill이 필요하면 별도 admin script로 만들 것. 그 script는 date range + provider/model + verified price version을 명시적으로 받아야 한다.

---

## 6. 검증 결과

```powershell
npm --prefix server run typecheck                                              # PASS
node test/sync_shared_types.mjs                                                # PASS (변경 없음)
npx tsx --test --test-concurrency=1 test/phase7_step5_llm_pricing.test.mjs    # 26/26 PASS
npx tsx --test --test-concurrency=1 test/phase6_real_adapters.test.mjs        # 15/15 PASS + 3 skipped (opt-in real network)
npm --prefix server test                                                       # PASS (727 total / 724 pass / 3 skipped / 0 fail)
```

### 알려진 flaky

Step 3/4 findings에 적어둔 `phase7_email_outbox_repo.test.mjs` due-lease flaky 2개는 Step 5와 직접 연결 없음. Step 5는 adapter boundary와 새 헬퍼만 건드린다. 풀 테스트 재현 시 별도 관찰.

---

## 7. 안 한 것

Plan §2 "안 한다" 그대로:

- 과거 `llm_usage_log.cost_usd_micros IS NULL` row backfill.
- billing/subscription cap enforcement.
- admin cost dashboard / reports UI.
- org별 custom pricing.
- provider invoice reconciliation.
- STT audio duration mapper (Clova price entry 자체 보류).
- pricing을 DB table로 관리하는 admin UI.

---

## 8. Phase 7 Master 상태 갱신

`PHASE_7_MASTER.md §0`에서 Step 5는 "P1 bundle 1번 — llm_usage_log cost map"이 닫힌 상태로 기록. Step 5+ bundle의 나머지 4개(role-based menu / report drilldown / demo-to-real cleanup / billing)는 그대로 P1 follow-up으로 남아 있다.

---

## 9. 다음 작업 인계

Plan `PHASE_7_MASTER.md §3 Step 5+ bundle` 잔여 P1 항목:

1. role-based sidebar nav visibility (employee/viewer에게 admin 전용 메뉴 숨김).
2. reports date window + agent drilldown.
3. demo-to-real frontend cleanup (dashboard / daily / newsletter 위젯).
4. billing / subscription caps.

billing이 들어올 때 Step 5 cost 데이터가 plan limit 정책과 결합된다 — 현재는 observability 한 단계만 닫혀 있다.

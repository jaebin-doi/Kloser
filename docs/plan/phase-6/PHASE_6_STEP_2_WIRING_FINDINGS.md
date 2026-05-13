# Phase 6 Step 2 Wiring Findings (Usage Logging Wiring)

> 완료일: 2026-05-13
> 범위: Step 2의 "usage logging wiring" 단위 — adapter `ProviderResult.usage`를 기존 call site (call summary worker / WS suggestion / knowledge route)에서 `services/llmUsage.recordProviderUsage`로 흘려보냄. real provider 어댑터는 본 단위에 없음.
> 기준 계획: `docs/plan/phase-6/PHASE_6_STEP_2_PLAN.md` §6.
> 선행 단위:
> - `9c027cf Add Phase 6 usage log schema`
> - `b386e96 Add Phase 6 usage log repository tests`
> - `99f25e4 Add Phase 6 provider usage contract` (ProviderResult + services/llmUsage + mock adapter envelope)
> 현재 브랜치: `feature/phase-3-team-invitations`

---

## 1. 현재 상태

Phase 6 Step 2는 아직 전체 완료가 아니다. 본 섹션은 usage logging wiring 단위만 닫는다. 실 provider 어댑터 / `.env.example` / `PHASE_6_MASTER` 체크박스는 다음 단위로 미룬다.

작업트리 상태: 본 작업에서 변경. 커밋/푸시는 Codex 책임.

---

## 2. 변경 파일

수정 5개, 신규 1개.

- `server/src/workers/callSummary.worker.ts`
  - `llm.summarizeCall(...)` 결과를 `result`로 받아 `result.value`는 기존처럼 `applyAiSummary`로, `result.usage`는 `recordProviderUsage(app, orgId, callId, usage, { metadata: { source: "worker:callSummary" } })`로 흘림.
  - usage 기록은 `applyAiSummary` 호출 *전*에 일어남 — provider cost는 이미 발생했으므로 manual-locked 경로에서도 row가 남아야 한다 (Step 2 plan §6).

- `server/src/ws/calls.ts`
  - `fireSuggestion()` 내부에서 `llm.suggestForUtterance(...)` 결과를 `result`로 받아 usage를 먼저 기록한 뒤 `result.value`로 suggestion persistence + WS emit.
  - metadata에 `source: "ws:suggestion"`, `group_seq`, `at_ms` 포함 — 운영자가 cost row와 live UI 시간축을 매칭할 수 있도록.
  - `llmUsageService` import 추가.

- `server/src/routes/knowledgeBases.ts`
  - chunks/replace: precomputed embedding(`c.embedding` 보유)인 chunk는 provider 호출 없음 → usage 기록 *건너뜀*. 새로 embed가 일어난 chunk만 `recordProviderUsage`. metadata는 `{ source, knowledge_base_id, chunk_index }`.
  - search: 모든 호출이 query embedding을 만들므로 항상 1행 기록. metadata는 `{ source, query_length }`.
  - 두 경로 모두 `callId = null` (knowledge는 통화에 묶이지 않음).

- `server/test/phase6_workers.test.mjs`
  - `pg` import 추가 + admin URL 기반 `llm_usage_log` cleanup hook (app role은 DELETE 불가).
  - `readUsageRowsForCall(orgId, callId)` helper 추가.
  - 3개 기존 테스트에 usage row assertion 추가:
    1. `callSummary worker fills summary fields from mock LLM transcript` — `call_summary` row 1행 + provider/status/source 검증.
    2. `callSummary worker is a no-op when summary_source='manual'` — applyAiSummary가 skip되어도 usage row는 여전히 1행 (Step 2 plan §6 ordering 요구사항).
    3. `text_chunk timer fires → call_suggestions row persisted + WS event has id` — `call_suggestion` row 1행 + metadata.source/group_seq 검증.

- `server/test/phase5_routes_knowledge.test.mjs`
  - `pg` import + `SUITE_START_ISO` 캡처 + admin URL cleanup hook (source = `route:knowledge.*` AND `created_at >= SUITE_START_ISO`).
  - `readKnowledgeUsageRows(filter)` helper 추가.
  - 3개 신규 테스트:
    1. `chunks/replace records one usage row only for chunks without a precomputed embedding` — mixed precomputed + plain chunks → 정확히 2 rows, `chunk_index`가 non-precomputed 위치를 가리킴.
    2. `search records one usage row for the query embedding` — search 1회 = 1 row. before/after diff로 isolation 검증.
    3. `search still succeeds when usage logging fails (malformed usage envelope)` — embedding 어댑터의 `usage.status`를 일시 swap해 CHECK 위반을 강제. service가 swallow하여 route는 200을 그대로 반환 (wiring-level failure isolation).

- `docs/plan/phase-6/PHASE_6_STEP_2_WIRING_FINDINGS.md`
  - 본 usage wiring 단위의 결과와 남은 Step 2 범위를 기록.

수정 파일 없음 외의 신규 파일 없음.

---

## 3. 검증 결과

```powershell
npm --prefix server run typecheck
```

- PASS.

```powershell
npm --prefix server test
```

- PASS. `333/333`. 기존 baseline 330 + 신규 3.

```powershell
node test/sync_shared_types.mjs
```

- PASS. 14 entity 그대로 (본 단위는 user-facing entity 추가 없음).

Residue:

- `llm_usage_log` 테스트 후 남는 row 없음. admin URL cleanup이 `metadata->>'source' IN (...)` + 시간/KB 스코프로 정리.

---

## 4. usage logging이 붙은 call site 목록

| Call site | metadata.source | callId | operation |
|---|---|---|---|
| `server/src/workers/callSummary.worker.ts` `processor` | `worker:callSummary` | 실제 callId | `call_summary` |
| `server/src/ws/calls.ts` `fireSuggestion` | `ws:suggestion` | 실제 callId | `call_suggestion` |
| `server/src/routes/knowledgeBases.ts` chunks/replace (embedding이 없는 chunk만) | `route:knowledge.chunks.replace` | `null` | `knowledge_embedding` |
| `server/src/routes/knowledgeBases.ts` search | `route:knowledge.search` | `null` | `knowledge_embedding` |

`operation`은 `repositories/llmUsage.ts`의 enum과 정렬 — adapter mock이 이미 정확한 `operation` 값을 envelope에 넣고 있어 wiring 코드는 별도 매핑 없이 `recordProviderUsage`로 흘림.

---

## 5. 중요한 구현 결정

### 5.1 manual-locked 경로에서도 usage 기록

Step 2 plan §6 "Important ordering":

> For summary: usage logging should happen even if `applyAiSummary` no-ops because manual summary is locked. Provider cost was already incurred.

worker는 `summarizeCall` → `recordProviderUsage` → `applyAiSummary` 순서로 호출. manual_summary_locked 케이스에서도 usage row가 남는지 테스트로 검증.

### 5.2 precomputed chunk는 logging skip

chunks/replace에서 caller가 `chunk.embedding`을 직접 넘긴 경우 adapter를 호출하지 않음. provider call이 실제 발생하지 않았으므로 `recordProviderUsage`도 건너뜀. 테스트로 검증 (precomputed 1개 + plain 2개 → 정확히 2 usage rows).

### 5.3 wiring-level failure isolation

`services/llmUsage.recordProviderUsage`가 모든 throw를 catch하여 null을 반환하므로 wiring 코드는 그 결과를 무시하면 자동으로 안전하다. service-level 단위 테스트(`phase6_llm_usage_service.test.mjs`)가 두 케이스를 이미 증명:

- `withOrgContext` 자체가 throw → null 반환
- INSERT가 CHECK 위반으로 throw → null 반환

추가로 wiring-level에서 1 케이스 검증 (knowledge route, search 경로): embedding 어댑터가 일부러 잘못된 `usage.status`를 반환하도록 swap하면 INSERT가 CHECK에 막혀 실패하지만 search 응답은 그대로 200으로 떨어진다.

### 5.4 cleanup 정책

`llm_usage_log`는 app role에 UPDATE/DELETE 정책이 없는 append-only 표. 테스트 teardown이 app role로 DELETE 하면 0 rows이 영향을 받으므로 실제로는 정리되지 않는다. 본 단위의 모든 cleanup은 `MIGRATE_DATABASE_URL` admin connection으로 우회한다.

스코핑은 두 갈래:

- worker/WS path: `metadata->>'source' IN ('worker:callSummary','ws:suggestion')` + `call_id IN (SELECT id FROM calls WHERE title LIKE 'phase6test-%')`.
- knowledge route: `metadata->>'source' IN ('route:knowledge.chunks.replace','route:knowledge.search')` + `created_at >= SUITE_START_ISO` (모듈 로드 시점에 캡처).

knowledge route는 metadata에 test prefix를 직접 박을 수 없어 시간 윈도우로 좁힘. 동일 DB에 동시 실행은 가정하지 않음 (CI/dev 모두 직렬 실행).

### 5.5 cost_usd_micros bigint 처리

`cost_usd_micros`는 PG `bigint`이므로 `pg` 드라이버가 string으로 반환. mock cost는 항상 0이라 테스트 검증은 `assert.equal(String(row.cost_usd_micros), "0")` 패턴 — 이미 service test에서 처리.

---

## 6. 아직 하지 않은 것 (Step 2 전체 기준 남은 작업)

- `server/src/adapters/llm/anthropic.ts` (실 Anthropic Messages API client)
- `server/src/adapters/embedding/openai.ts` (실 OpenAI Embeddings client)
- `server/src/adapters/stt/clova.ts` (실 Naver Cloud CLOVA REST client)
- `server/src/adapters/index.ts` resolver의 throw branch 채우기 (env 기반 실 provider 분기 + 미설정 시 fail-fast)
- `server/.env.example` provider env 확장
- `server/package.json` `@anthropic-ai/sdk` + `openai` dependency 추가
- 실 provider contract 테스트 (env opt-in, `E2E_ALLOW_REAL_PROVIDERS=1` gate)
- `PHASE_6_STEP_2_FINDINGS.md` (Step 2 종합)
- `PHASE_6_MASTER.md` Step 2 checkbox

Step 2 checkbox는 아직 켜지 않는다.

---

## 7. 다음 작업 지시문 (Claude)

다음 wiring 다음 단위 = real provider 어댑터 (Anthropic / OpenAI / Clova). 다른 단위로 가기 전 본 wiring 단위가 Codex review로 들어가는 게 우선.

```text
Phase 6 Step 2의 다음 단위로 real provider 어댑터 3종을 추가해 주세요.

기준 문서:
- docs/plan/phase-6/PHASE_6_STEP_2_PLAN.md §5
- docs/plan/phase-6/PHASE_6_STEP_2_WIRING_FINDINGS.md
- AGENTS.md

작업 범위:
- server/src/adapters/llm/anthropic.ts
- server/src/adapters/embedding/openai.ts
- server/src/adapters/stt/clova.ts
- server/src/adapters/index.ts resolver 분기 (env가 지정됐는데 키가 비면 fail-fast)
- server/.env.example provider env 확장 (.env 무수정)
- server/package.json: @anthropic-ai/sdk + openai 의존성 추가
- 단위 테스트: 실 호출은 E2E_ALLOW_REAL_PROVIDERS=1 일 때만, 기본 PR에서 skip.

금지:
- 실 provider 호출이 기본 테스트 경로에서 발생하지 않도록 할 것 (env gate).
- platform/frontend 변경 금지.
- PHASE_6_MASTER Step 2 checkbox는 real provider까지 끝나고도 Step 2 종합 findings 전까지 켜지 말 것.

검증:
- npm --prefix server run typecheck
- npm --prefix server test (real provider env 없이 PASS)
- node test/sync_shared_types.mjs
```

---

## 8. Codex Review Focus For This Section

- worker / ws / knowledge route 세 군데에서 `recordProviderUsage`가 정확히 1회씩 호출되는지 (precomputed chunk는 건너뜀).
- usage row가 `applyAiSummary` no-op 경로에서도 남는지.
- knowledge route는 `call_id = null`로 들어가는지.
- service-level + wiring-level failure isolation 두 갈래로 logging 실패가 user flow를 깨지 않는지.
- `llm_usage_log` 테스트 cleanup이 app role을 우회하지 않는 production path를 끌어들이지 않았는지 (admin URL은 test only).
- Step 2 checkbox가 아직 켜지지 않았는지.

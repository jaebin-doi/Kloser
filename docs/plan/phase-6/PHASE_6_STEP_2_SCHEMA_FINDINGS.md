# Phase 6 Step 2 Schema + Repository Findings

> 완료일: 2026-05-13
> 범위: Step 2의 첫 단위, `llm_usage_log` schema + repository + RLS tests.
> 기준 계획: `docs/plan/phase-6/PHASE_6_STEP_2_PLAN.md`
> 현재 브랜치: `feature/phase-3-team-invitations`

---

## 1. 현재 상태

Phase 6 Step 2는 아직 전체 완료가 아니다. 이번 섹션에서는 Step 2 plan의 schema/repository 첫 단위만 완료했다.

완료된 커밋:

- `9c027cf Add Phase 6 usage log schema`
- `b386e96 Add Phase 6 usage log repository tests`

원격 반영:

- `origin/feature/phase-3-team-invitations`에 push 완료.
- 작업트리 clean 확인.

---

## 2. 변경 파일

신규 파일 3개:

- `server/migrations/1715000021000_phase6_llm_usage_log.sql`
  - `llm_usage_log` 테이블 추가.
  - 4개 인덱스 추가.
  - FORCE RLS.
  - same-org SELECT/INSERT policy.
  - `GRANT SELECT, INSERT ON llm_usage_log TO app`.
  - UPDATE/DELETE policy 없음. Step 2 contract는 append-only.

- `server/src/repositories/llmUsage.ts`
  - `insertInCurrentOrg`.
  - `listForCallInCurrentOrg`.
  - `listForCurrentOrgByTestTagPrefix` 테스트/진단 helper.
  - 모든 helper는 caller가 넘긴 `PoolClient`를 사용한다. `withOrgContext`는 caller 책임.

- `server/test/phase6_usage_log.test.mjs`
  - schema/RLS/repository 9 케이스.
  - append-only 테이블 cleanup은 app role이 아니라 `MIGRATE_DATABASE_URL` admin connection으로 prefix 범위만 정리한다.

수정 파일 없음.

---

## 3. 검증 결과

Codex 재검증 완료:

```powershell
npm --prefix server run db:migrate:up
```

- PASS. `No migrations to run!`, migration 적용 상태 확인.

```powershell
npm --prefix server run typecheck
```

- PASS.

```powershell
npm --prefix server test
```

- PASS. `321/321`.

```powershell
node test/sync_shared_types.mjs
```

- PASS.

```powershell
cd server
npx tsx --test --test-concurrency=1 test/phase6_usage_log.test.mjs
```

- PASS. `9/9`.

Residue:

- `llm_usage_log.metadata->>'test_tag' LIKE 'phase6test-%'` residue `0`.
- 이전 cleanup 설계 문제로 남았던 `21`건은 admin prefix cleanup으로 정리 완료.

---

## 4. 테스트 커버리지

`server/test/phase6_usage_log.test.mjs` 신규 9 케이스:

1. bare pool with no GUC sees 0 `llm_usage_log` rows.
2. Acme insert + read round-trip via repository.
3. Beta cannot read Acme `llm_usage_log` rows.
4. Acme context cannot INSERT a row with `org_id = Beta` (`42501`).
5. composite FK rejects cross-org `call_id` under correct `org_id` (`23503`).
6. same-org `call_id` INSERT links usage to a call.
7. app role cannot UPDATE `llm_usage_log` rows.
8. app role cannot DELETE `llm_usage_log` rows.
9. `ON DELETE SET NULL (call_id)` preserves usage row when call is hard-deleted.

---

## 5. 중요한 구현 결정

### 5.1 Composite FK partial SET NULL

Plan에는 composite FK `ON DELETE SET NULL` 의도만 있었다. 실제 migration은:

```sql
FOREIGN KEY (org_id, call_id)
REFERENCES calls(org_id, id)
ON DELETE SET NULL (call_id)
```

`org_id`는 NOT NULL이고 usage row는 provider cost/audit record라 보존되어야 한다. 따라서 parent call hard-delete 시 `call_id`만 NULL 처리하고 `org_id`는 유지한다. PG15+ partial set-null syntax를 사용한다.

### 5.2 Append-only cleanup

`llm_usage_log`는 app role에 DELETE policy가 없다. 테스트 cleanup을 app role로 하면 실제로 row가 삭제되지 않는다. Codex 검토 중 이 문제를 발견했고, 테스트 teardown을 `MIGRATE_DATABASE_URL` admin connection 기반 prefix cleanup으로 수정했다.

이 cleanup은 테스트 전용이고 다음 조건으로만 삭제한다:

```sql
metadata->>'test_tag' LIKE 'phase6test-%'
```

### 5.3 Repository helper 추가

`listForCurrentOrgByTestTagPrefix`는 production service path가 아니라 테스트/진단 helper다. cleanup 검증과 same-org RLS 확인을 위해 추가했다.

---

## 6. 아직 하지 않은 것

Step 2 전체 기준으로 남은 작업:

- `server/src/services/llmUsage.ts`
- adapter result contract 추가 (`ProviderResult<T>`, `ProviderUsage`)
- mock adapter return type 변경
- 기존 call sites unwrap 변경
- Anthropic/OpenAI/Clova real provider adapters
- `.env.example` provider env 확장
- usage logging wiring
  - call summary worker
  - WS suggestion generation
  - knowledge embedding service
- `PHASE_6_STEP_2_FINDINGS.md`
- `PHASE_6_MASTER.md` Step 2 checkbox 갱신

Step 2 checkbox는 아직 켜면 안 된다.

---

## 7. 다음 작업 지시문 (Claude)

다음 섹션에서 Claude에게 아래 그대로 전달한다.

```text
Phase 6 Step 2를 이어서 진행해 주세요.

기준 문서:
- docs/plan/phase-6/PHASE_6_STEP_2_PLAN.md
- docs/plan/phase-6/PHASE_6_STEP_2_SCHEMA_FINDINGS.md
- AGENTS.md

현재 완료 상태:
- schema commit 완료: 9c027cf Add Phase 6 usage log schema
- repository/tests commit 완료: b386e96 Add Phase 6 usage log repository tests
- llm_usage_log migration/RLS/repository/tests는 원격에 push 완료
- typecheck / npm test 321/321 / sync_shared_types PASS

이번 작업 범위:
Step 2의 다음 단위만 구현하세요. real provider adapter까지 가지 말고, usage service + adapter result contract 준비까지만 진행하세요.

구체 작업:
1. server/src/adapters/usage.ts 추가
   - ProviderUsage
   - ProviderResult<T>
   - provider/operation/status 타입은 llmUsage repository enum과 일치시킬 것

2. adapter interfaces 변경
   - LLMAdapter.summarizeCall -> Promise<ProviderResult<LlmGeneratedSummary>>
   - LLMAdapter.suggestForUtterance -> Promise<ProviderResult<LlmGeneratedSuggestion[]>>
   - EmbeddingAdapter.embed -> Promise<ProviderResult<number[]>>
   - EmbeddingAdapter.embedBatch -> Promise<ProviderResult<number[][]>>
   - STTAdapter.transcribeChunk -> Promise<ProviderResult<SttUtterance | null>>

3. mock adapters 변경
   - 기존 domain value는 value에 넣기
   - usage는 provider='mock', model은 명확한 mock model string 사용
   - cost_usd_micros는 0 또는 null
   - latency/tokens는 deterministic하게 넣거나 null

4. 기존 call sites unwrap 수정
   - services/knowledge.ts
   - services/callSummary.ts 또는 worker 경로
   - ws/calls.ts
   - tests에서 mock adapter 직접 호출하는 부분
   - 이 작업에서는 아직 usage row insert wiring은 하지 않아도 됨. 단, value unwrap 후 기존 동작이 깨지면 안 됨.

5. server/src/services/llmUsage.ts 추가
   - recordProviderUsage(app, orgId, callId, usage)
   - app.withOrgContext(orgId, ...)
   - repositories/llmUsage.insertInCurrentOrg 사용
   - logging 실패는 원래 user/provider flow를 막지 않도록 catch + app.log.warn 후 null 반환
   - 이 service는 wiring commit에서 호출될 예정이므로 지금은 단위 테스트 중심

6. tests 추가/수정
   - mock adapter tests를 ProviderResult shape 기준으로 갱신
   - service llmUsage tests 추가
   - logging failure가 throw를 밖으로 전파하지 않는지 검증
   - default test에서 real network call 0건

금지:
- real Anthropic/OpenAI/Clova adapter 구현하지 말 것
- package.json dependency 추가하지 말 것
- .env / .env.example 수정하지 말 것
- platform/frontend 변경하지 말 것
- PHASE_6_MASTER Step 2 checkbox 켜지 말 것
- commit/push 하지 말 것. Codex가 검토 후 커밋/푸시함.

검증:
- npm --prefix server run typecheck
- npm --prefix server test
- node test/sync_shared_types.mjs

보고:
- 변경 파일 목록
- 검증 결과
- adapter contract 변경으로 수정한 call site 목록
- 미수행/보류 항목
```

---

## 8. Codex Review Focus For Next Section

- Adapter return type 변경이 모든 call site에 반영됐는지.
- mock-only behavior가 기능적으로 동일한지.
- `llmUsage` service가 logging failure를 user flow로 전파하지 않는지.
- real provider 관련 dependency/env/network call이 들어오지 않았는지.
- `llm_usage_log` cleanup이 append-only 정책을 우회하지 않는 production path로 들어오지 않았는지.
- Step 2 checkbox가 아직 켜지지 않았는지.


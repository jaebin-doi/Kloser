# Phase 6 — Step 1 Implementation Plan (Codex)

> **작성일**: 2026-05-13
> **기준 문서**: `PHASE_6_MASTER.md`, `PHASE_6_STEP_1_PLAN.md`, Phase 5 closeout.
> **목적**: Claude 구현 전에 Codex가 확정한 파일별 구현 순서와 검증 계약. 이 문서는 구현 지시의 기준이다.

---

## 0. 결론

Step 1은 **schema 변경 없이** Phase 5의 helper들을 실제 runtime loop에 연결한다.

1. BullMQ + Redis 큐를 추가한다.
2. endCall 성공 후 `{ orgId, callId }` AI summary job을 best-effort enqueue한다.
3. worker가 org context 안에서 transcript를 읽고 mock LLM summary를 적용한다.
4. BullMQ repeatable job으로 heartbeat timeout sweep을 실행한다.
5. WS `text_chunk` 흐름에서 30초 timer 기반 mock LLM suggestion을 DB에 저장하고 id 포함 이벤트를 발사한다.
6. demo replay는 `KLOSER_DEMO_REPLAY` gate 뒤로 숨긴다.

**금지**: migration, RLS policy, platform frontend, real provider client, `llm_usage_log`, action item delete, manager report.

---

## 1. 확정 결정

| 항목 | 결정 |
|---|---|
| Queue | BullMQ + ioredis |
| Queue payload | `CallSummaryJob = { orgId: string, callId: string }` |
| Enqueue 위치 | `services/calls.endCall()` transaction 성공 이후. Redis 실패는 catch 후 로그만 남김 |
| Worker DB context | `app.withOrgContext(orgId, ...)` |
| Org 목록 조회 | worker 내부 전용 `repositories/orgs.listAllOrgIds(client)`; `organizations`는 RLS 비적용이므로 `app` role SELECT 사용 |
| Heartbeat sweep | BullMQ repeatable job, singleton jobId, cutoff 60s, interval 30s |
| Suggestion hook | `ws/calls.ts`에서 text_chunk 이후 30초 timer. queue로 분리하지 않음 |
| Demo replay | 명시 env 우선. 미설정 시 production=off, dev/test=on |
| Real provider | Step 2에서만. Step 1은 existing mock adapter만 호출 |

---

## 2. 파일별 작업 순서

### 2.1 Dependency / scripts

수정:
- `server/package.json`
- `server/package-lock.json`
- `server/.env.example`

작업:
- `bullmq`, `ioredis` 추가.
- scripts 추가:
  - `dev:worker`: `tsx watch src/workers/index.ts`
  - `start:worker`: `tsx src/workers/index.ts`
- `.env.example`에 추가:
  - `REDIS_URL=redis://localhost:6379`
  - `KLOSER_DEMO_REPLAY=1`
  - `KLOSER_HEARTBEAT_CUTOFF_SEC=60`
  - `KLOSER_HEARTBEAT_SWEEP_INTERVAL_SEC=30`
  - `KLOSER_SUGGESTION_INTERVAL_MS=30000`

검토 포인트:
- `.env`는 수정하지 않는다.
- lockfile 변경은 dependency 추가에 따른 정상 변경이다.

### 2.2 Queue modules

신규:
- `server/src/queue/redis.ts`
- `server/src/queue/queues.ts`
- `server/src/queue/index.ts`

계약:
- Redis URL default는 `redis://localhost:6379`.
- connection 생성은 worker/test shutdown에서 닫을 수 있게 export한다.
- `enqueueCallSummary({ orgId, callId })`는 BullMQ job을 추가한다.
- job options:
  - `attempts: 3`
  - `backoff: { type: "exponential", delay: 5000 }`
  - deterministic `jobId`는 같은 call 중복 요약을 막는 방향 권장: `call-summary:${orgId}:${callId}`
- heartbeat repeatable scheduling은 singleton jobId를 사용한다.

주의:
- queue helper를 Fastify route나 browser-facing API로 노출하지 않는다.

### 2.3 Worker internals

신규:
- `server/src/workers/callSummary.worker.ts`
- `server/src/workers/heartbeatSweep.worker.ts`
- `server/src/workers/index.ts`
- `server/src/repositories/orgs.ts`

`callSummary.worker.ts`:
- job data validation: `{ orgId, callId }`가 string인지 확인.
- org context 안에서 call과 transcript를 읽는다.
- transcript text를 deterministic하게 합쳐 `resolveLlmAdapter().summarizeCall({ transcript })` 호출.
- 결과를 `applyAiSummary(app, orgId, callId, generated)`에 전달.
- transcript가 비어 있으면 mock LLM 결과가 null fields일 수 있다. 이 경우도 성공 job으로 처리한다.
- call이 없거나 manual summary 보호로 update가 null이면 no-op success.

`heartbeatSweep.worker.ts`:
- `listAllOrgIds(app.pg)`로 org 목록 조회.
- 각 org에 대해 `markTimedOutCallsDropped` 계열 service 호출.
- cutoff seconds env를 읽고 기본 60초.
- 결과는 로그에 org별 count를 남긴다.

`workers/index.ts`:
- Fastify 인스턴스 + db plugin 등록.
- call summary worker와 heartbeat sweep worker boot.
- repeatable heartbeat sweep schedule 등록.
- SIGINT/SIGTERM에서 worker, queue, Redis, app을 순서대로 close.

`repositories/orgs.ts`:
- `listAllOrgIds(client)`만 제공.
- 주석에 "worker internal only, not route/service public API"를 명시.

### 2.4 endCall enqueue hook

수정:
- `server/src/services/calls.ts`

작업:
- 기존 `endCall()`의 DB transaction 결과를 `updated`로 받은 뒤, transaction 밖에서 enqueue한다.
- 구조는 다음 형태여야 한다:

```ts
const updated = await app.withOrgContext(...);
if (updated) {
  await enqueueCallSummary({ orgId: actorOrgId, callId: updated.id }).catch((err) => {
    app.log.warn({ err, callId: updated.id }, "call summary enqueue failed");
  });
}
return updated;
```

주의:
- enqueue 실패가 endCall 결과를 바꾸면 안 된다.
- transaction 안에서 Redis 호출하지 않는다.
- manual summary 보호는 기존 repository SQL에 맡긴다.

### 2.5 Heartbeat service

수정:
- `server/src/services/callHeartbeat.ts`

작업:
- 단일 org helper는 유지한다.
- multi-org helper는 worker에서 org 목록을 받은 뒤 org별로 기존 helper를 호출하는 얇은 layer로 둔다.
- 실제 row update는 반드시 `withOrgContext(orgId, ...)` 안에서 실행한다.
- race는 `WHERE status='in_progress'` 조건으로 정리한다.

### 2.6 WS suggestion persistence

수정:
- `server/src/ws/calls.ts`

작업:
- socket state에 다음을 추가:
  - recent transcript text window
  - suggestion group sequence
  - suggestion timer id
- `text_chunk` 수신 시 transcript append 이후 window 갱신.
- timer가 없으면 `KLOSER_SUGGESTION_INTERVAL_MS` 후 1회 timer 등록.
- timer fire:
  - active call이 없거나 call ended면 no-op
  - mock LLM `suggestForUtterance({ transcript, groupSeq, atMs })`
  - 결과 0건이면 no-op
  - `persistSuggestionGroup(app, orgId, callId, items)` 호출
  - 반환 row를 기존 suggestion event shape에 맞춰 emit. 반드시 `id` 포함.
- disconnect/end_call 시 timer cleanup.

Demo replay:
- `shouldDemoReplay()` helper 추가.
- env 명시값:
  - `"1"`, `"true"` => on
  - `"0"`, `"false"` => off
- env 미설정:
  - `NODE_ENV === "production"` => off
  - 그 외 => on
- 기존 Phase 0.5/4/5 e2e가 fixture replay에 암묵적으로 기대는 경우를 깨지 않도록 dev/test 기본 on.

---

## 3. 테스트 계획

신규:
- `server/test/phase6_workers.test.mjs`

필수 케이스:
1. `endCall` 성공 후 call summary queue job이 `{ orgId, callId }`로 생성된다.
2. enqueue 실패를 강제로 만들었을 때도 `endCall`은 성공 결과를 반환한다.
3. call summary worker processor가 transcript를 모아 mock summary를 적용하고 `summary_source='ai'`가 된다.
4. manual summary가 있는 call에 worker가 실행되어도 `summary_source='manual'`과 fields가 유지된다.
5. heartbeat sweep cutoff 이전 call은 유지, cutoff 이후 call은 `dropped/server_timeout`.
6. heartbeat sweep cross-org 격리: Acme sweep이 Beta call을 건드리지 않는다.
7. heartbeat sweep idempotency: 같은 sweep 반복 호출 시 추가 변경 0.
8. WS `text_chunk` 후 짧은 test interval에서 suggestion row가 생성되고 WS event에 `id`가 포함된다.
9. `KLOSER_DEMO_REPLAY=0`에서 fixture suggestion event가 발사되지 않는다.
10. worker boot smoke: worker modules가 close 가능한 리소스를 정리한다.

테스트 env:
- `KLOSER_HEARTBEAT_CUTOFF_SEC`와 `KLOSER_SUGGESTION_INTERVAL_MS`는 테스트에서 짧게 override.
- Redis가 필요한 테스트는 기존 docker Redis 사용. 불가능하면 해당 케이스를 명확히 fail시키고 findings에 환경 전제 기록.

Cleanup:
- prefix `phase6test-`.
- calls, transcripts, call_suggestions, action_items, checklist_items 등 부모 call 기반으로 정리.
- seat seed는 건드리지 않는다.

---

## 4. 검증 명령

필수:

```powershell
npm --prefix server run typecheck
npm --prefix server test
node test/sync_shared_types.mjs
node test/phase_4_e2e.mjs
node test/phase_5_e2e.mjs
```

Worker boot:

```powershell
npm --prefix server run start:worker
```

짧게 boot 로그를 확인하고 정상 종료한다. 장기 실행 프로세스를 남기지 않는다.

추가 확인:

```powershell
git diff -- server/migrations
git diff -- platform
```

둘 다 0 byte여야 한다.

---

## 5. 완료 산출물

신규 예상:
- `server/src/queue/redis.ts`
- `server/src/queue/queues.ts`
- `server/src/queue/index.ts`
- `server/src/workers/callSummary.worker.ts`
- `server/src/workers/heartbeatSweep.worker.ts`
- `server/src/workers/index.ts`
- `server/src/repositories/orgs.ts`
- `server/test/phase6_workers.test.mjs`
- `docs/plan/phase-6/PHASE_6_STEP_1_FINDINGS.md`

수정 예상:
- `server/src/services/calls.ts`
- `server/src/services/callHeartbeat.ts`
- `server/src/ws/calls.ts`
- `server/package.json`
- `server/package-lock.json`
- `server/.env.example`
- `docs/plan/phase-6/PHASE_6_MASTER.md`

수정 금지:
- `server/migrations/**`
- `platform/**`
- `.env`
- real provider adapter files unless only import path cleanup이 필요한 경우. 실 client 구현 금지.

---

## 6. Codex Review Checklist

Codex는 구현 보고 후 다음을 우선 검토한다.

- `endCall` transaction 밖 enqueue인지.
- queue payload에 `orgId`가 있는지.
- Redis 실패가 API/WS endCall을 깨지 않는지.
- `organizations` 전체 list helper가 worker internal-only인지.
- worker가 `withOrgContext` 밖에서 org-scoped write를 하지 않는지.
- demo replay default가 dev/test 호환성을 지키는지.
- WS suggestion event에 persisted `id`가 포함되는지.
- manual summary guard를 우회하지 않는지.
- migrations/platform diff가 0인지.
- Phase 4/5 e2e console errors가 0인지.

---

## 7. Claude 작업 지시 기준

Claude는 이 구현계획서를 먼저 읽고, 여기서 벗어나는 결정을 발견하면 구현 전에 보고해야 한다. 구현 중 새 schema가 필요해 보이면 중단하고 Codex/user 확인을 받는다.

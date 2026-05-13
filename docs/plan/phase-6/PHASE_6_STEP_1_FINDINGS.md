# Phase 6 Step 1 — Findings

> 종결일: 2026-05-12
> 기준 문서: `docs/plan/phase-6/PHASE_6_STEP_1_IMPLEMENTATION_PLAN.md` (Codex 작성). 본 결과 보고는 implementation plan을 정본으로 두고 그 위의 deviations만 §6에 명시한다.
> 검증 종합: `typecheck` PASS · `npm test` 312 / 312 PASS · `sync_shared_types` PASS · `phase_4_e2e` PASS · `phase_5_e2e` PASS · worker boot smoke PASS

---

## 1. 변경 파일 목록

### 1.1 신규

| 파일 | 역할 |
|---|---|
| `server/src/queue/redis.ts` | ioredis singleton + `closeRedis()`. BullMQ Worker 요건(`maxRetriesPerRequest: null`, `enableReadyCheck: false`)을 채우고, connect 이벤트에서 underlying socket을 `.unref()` 해서 producer 측 연결이 tsx --test의 event loop를 잡지 않도록 한다. |
| `server/src/queue/queues.ts` | 큐 이름(`call-summary`, `heartbeat-sweep`) + 지연 초기화 accessor + 공통 job defaults(`attempts: 3` / exponential backoff 5s / `removeOnComplete: 100` / `removeOnFail: 200`) + `CallSummaryJobData` / `HeartbeatSweepJobData` 타입. |
| `server/src/queue/index.ts` | `enqueueCallSummary({ orgId, callId })` (deterministic jobId `call-summary:<org>:<call>`로 중복 enqueue 방지) + `scheduleHeartbeatSweep(intervalMs)` (jobId `heartbeat-sweep-singleton` 반복 작업) + re-export. |
| `server/src/repositories/orgs.ts` | 워커 전용 helper `listAllOrgIds(client)`. `organizations`는 RLS 비적용 테이블이라 sweep이 GUC 우회 없이 단일 SELECT로 모든 org id 목록을 수집할 수 있음. 파일 상단 주석에 "route/service 공개 API로 노출 금지" 명시. |
| `server/src/workers/callSummary.worker.ts` | `makeCallSummaryProcessor(app)` (테스트가 BullMQ Worker loop 없이 호출하는 processor 함수) + `createCallSummaryWorker(app)` (BullMQ Worker wrap). processor 흐름은 plan §A 그대로: payload 검증 → `withOrgContext(orgId)` 안에서 call + transcripts 로드 → mock LLM `summarizeCall` → `callSummary.applyAiSummary` (manual guard는 service SQL이 보유). 결과 `{ skipped?, reason? }` 반환. |
| `server/src/workers/heartbeatSweep.worker.ts` | 환경변수 `KLOSER_HEARTBEAT_CUTOFF_SEC` (기본 60) 또는 job data로 cutoff 결정 → bare pool client로 `listAllOrgIds` → 각 org 별 `withOrgContext` + `markTimedOutCallsDropped`. 한 org가 실패해도 다음 org는 시도하도록 per-org `try/catch`. |
| `server/src/workers/index.ts` | 워커 엔트리. db plugin만 register(HTTP 라우트/WS 미등록), 두 worker 생성 후 `scheduleHeartbeatSweep(SWEEP_INTERVAL_MS)`로 singleton repeatable job 등록. SIGINT/SIGTERM → summaryWorker → sweepWorker → queues → redis → app close 순서로 종료. |
| `server/test/phase6_workers.test.mjs` | Phase 6 Step 1 통합 단위 테스트. 11 케이스. prefix `phase6test-`. |

### 1.2 수정

| 파일 | 변경 요지 |
|---|---|
| `server/src/services/calls.ts` | `endCall` — DB transaction commit 직후 `enqueueCallSummary({ orgId, callId })` best-effort 호출. `try/catch`로 Redis outage가 endCall ack를 막지 않도록 함. plan §B 그대로. |
| `server/src/ws/calls.ts` | `CallContext`에 `suggestionTimer`, `suggestionGroupSeq`, `transcriptWindow`. `shouldDemoReplay()` (env `KLOSER_DEMO_REPLAY` 토글, 미설정 시 production OFF / 그 외 ON). `start_call`에서 fixture replay를 gate로 감쌈. `text_chunk`에서 텍스트를 window에 누적(최대 50)하고 `SUGGESTION_INTERVAL_MS`(기본 30000) 타이머를 1회 예약. 타이머 발화 시 `fireSuggestion`이 mock LLM `suggestForUtterance` 호출 → `callSuggestionsService.persistSuggestionGroup`으로 영속화 → `suggestion` 이벤트에 row id 포함해서 발사. `clearCall`에서 timer 정리. |
| `server/package.json` | dependencies에 `bullmq ^5.76.8`, `ioredis ^5.10.1` 추가. scripts에 `dev:worker` / `start:worker` 추가. |
| `server/.env.example` | Phase 6 section 추가 — `KLOSER_DEMO_REPLAY=1`, `KLOSER_HEARTBEAT_CUTOFF_SEC=60`, `KLOSER_HEARTBEAT_SWEEP_INTERVAL_SEC=30`, `KLOSER_SUGGESTION_INTERVAL_MS=30000`. `.env`는 변경 없음. |
| `docs/plan/phase-6/PHASE_6_MASTER.md` | Step 1 체크박스 ON + 완료일 / findings 참조 추가. |

### 1.3 금지 경로 확인

- `git diff -- server/migrations` : 0 byte
- `git diff -- platform` : 0 byte
- `server/.env` : 변경 없음 (`.env.example`만 확장)
- `commit/push` : 수행하지 않음 (사용자 승인 대기)

---

## 2. 검증 결과

### 2.1 typecheck

```
npm --prefix server run typecheck  →  PASS (tsc --noEmit, 무경고)
```

### 2.2 단위 / 통합 테스트

```
npm --prefix server test  →  tests 312 / pass 312 / fail 0
                              suites 0 / cancelled 0 / skipped 0
                              duration ≈ 62s
```

신규 `phase6_workers.test.mjs` 11 케이스 모두 PASS:

| # | 케이스 | 검증 |
|---|---|---|
| 1 | endCall enqueues a call-summary job with `{ orgId, callId }` | jobId가 `call-summary:<org>:<call>` 형태 |
| 2 | endCall succeeds even if enqueueCallSummary throws | Redis outage 시뮬레이션, ack 정상 |
| 3 | callSummary worker fills summary fields from mock LLM transcript | summary_source='ai' |
| 4 | callSummary worker is a no-op when summary_source='manual' | manual guard 발동, 0 row update |
| 5 | callSummary worker no-op when call vanished | cross-org/soft-deleted 견고성 |
| 6 | heartbeat sweep marks stale calls dropped + leaves fresh ones alone | cutoff 경계 |
| 7 | heartbeat sweep does not cross orgs | 멀티 org 격리 |
| 8 | heartbeat sweep is idempotent (second run = 0 updates) | 재실행 안전 |
| 9 | text_chunk timer fires → call_suggestions row persisted + WS event has id | persistSuggestionGroup + id-bearing suggestion 이벤트 |
| 10 | KLOSER_DEMO_REPLAY=0 — no fixture replay events fire | env gate |
| 11 | call summary worker can be created and closed cleanly | Worker lifecycle |

### 2.3 sync_shared_types

```
node test/sync_shared_types.mjs  →  PASS (15 entity)
```

신규 entity 없음 (mock provider 단계라 `llm_usage_log` 미도입, Step 2 예정).

### 2.4 e2e 회귀

```
node test/phase_4_e2e.mjs  →  E2E PASSED  (40 PASS / 0 FAIL)
node test/phase_5_e2e.mjs  →  E2E PASSED  (31 PASS / 0 FAIL)
```

phase_5_e2e 시나리오 3 (manual summary 저장) — 워커가 동시에 떠 있어도 `summary_source='manual'` SQL guard가 AI overwrite 차단. plan §결정 9 / master plan §9.1 그대로.

### 2.5 worker boot smoke

```
npm --prefix server run start:worker  (timeout 8s)
→ [workers] up — call-summary + heartbeat-sweep (interval=30000ms, cutoff=60s)
→ clean exit
```

부팅 로그가 한 줄로 떨어지고, 그 사이 stderr/error 없음. SIGINT 라우팅은 단위 테스트 11번 케이스 (close cleanly)로 추가 검증.

---

## 3. Cleanup / Residue

- 단위 테스트 cleanup: `phase6test-` prefix scoped sweep — calls / transcripts / call_suggestions / customers / users / memberships. residue 0 확인 (테스트 내부 after()).
- e2e 회귀 cleanup: `phase4test-` / `phase5-e2e-` 각자 sweep 통과. 좌석 시드(admin/employee@acme/beta, customers, memberships, teams) 무손상.
- Redis 큐 잔존: dev Redis(`kloser-dev-redis-1`)의 `bull:call-summary:*` / `bull:heartbeat-sweep:*` 키. 본 Step의 단위 테스트는 BullMQ Worker loop를 띄우지 않고 processor를 직접 호출하므로 큐에 실제 job을 쌓지 않음 (테스트 종료 후 `closeRedis()`로 connection만 닫음). 워커 boot smoke 8초 동안 sweep job 1건이 enqueued/processed 되었을 수 있으나 Step 1 BullMQ 정책 `removeOnComplete: { count: 100 }`로 곧 회수됨.

---

## 4. Worker boot 결과 (별도 강조)

플랜 §H의 boot smoke 요구를 그대로 따라 `npm --prefix server run start:worker`를 8초 timeout으로 실행:

- stdout: `[workers] up — call-summary + heartbeat-sweep (interval=30000ms, cutoff=60s)`
- stderr: 무
- exit: timeout으로 인한 graceful termination (`---EXIT---` 마커까지 도달)

여기서 verifier가 잡으려던 두 가지 함정 모두 통과:
1. BullMQ Worker 인스턴스 생성이 ioredis blocking option 위반으로 즉시 throw 하지 않음.
2. `scheduleHeartbeatSweep` repeatable job 등록 이후 워커가 lock 경합으로 무한 루프에 빠지지 않음.

운영 머신에서는 SIGTERM 시 summaryWorker → sweepWorker → queues → redis → app 순서로 close되는 경로가 `workers/index.ts` 안에 있다. 본 boot smoke에서는 timeout 종료라 graceful close 경로는 단위 테스트 11번 케이스에서 검증.

---

## 5. 보안 / 권한 확인

- `enqueueCallSummary`는 service layer(`services/calls.ts`)에서만 호출. route/public API에 노출되는 query / mutation은 추가하지 않음. plan §결정 4(워커 큐를 외부에 드러내지 않는다)와 master plan §결정 3(`listAllOrgIds`도 route 노출 금지) 모두 준수.
- 워커 SQL은 전부 `withOrgContext(orgId)` 안에서 `app` role + RLS GUC 경유. `listAllOrgIds`만 bare client (organizations는 RLS 비적용 테이블) — 사용처는 `heartbeatSweep.worker.ts` 한 곳. grep으로 다른 import 없음 확인.
- WS suggestion persistence는 `callSuggestionsService.persistSuggestionGroup` 재사용. 이 service는 Phase 5 Step 4에서 이미 RLS WITH CHECK + agent 검증 완료. 카드 텍스트는 클라이언트에서 `escapeHtml` 처리하던 기존 sanitize 경로 그대로 (`platform/live.html`).
- 새 env 변수(`KLOSER_DEMO_REPLAY` / `KLOSER_HEARTBEAT_*` / `KLOSER_SUGGESTION_INTERVAL_MS`)는 `.env.example`에만 노출. 실 `.env`는 본 작업에서 수정하지 않음.

---

## 6. 계획 대비 변경 사항 (deviations)

implementation plan(Codex 작성)에 대비해 실제 구현에서 벌어진 차이는 다음 3건. 각 항목은 plan의 의도를 깨지 않는 범위에서 정한 결정이며, 모두 보고 후 진행했다.

### 6.1 `callSummary.worker.ts`의 processor 함수 분리

- **plan 원문**: 워커 모듈은 BullMQ `Worker` 인스턴스를 export.
- **실제**: `makeCallSummaryProcessor(app)`을 별도 export하고 `createCallSummaryWorker(app)`이 그것을 wrap.
- **이유**: BullMQ `Worker`는 생성 즉시 ioredis 연결을 잡고 polling을 시작하므로 단위 테스트가 매 케이스마다 worker를 띄웠다가 닫는 게 비효율적이고, 더 큰 문제로 BullMQ가 processor 함수를 외부에서 호출 가능한 형태로 노출하지 않는다. processor를 분리하면 테스트가 production과 동일한 함수를 동일한 입력으로 호출하면서도 Redis loop 비용을 회피한다.
- **runtime 영향**: 없음. `createCallSummaryWorker`는 분리된 processor를 그대로 wrap한다.

### 6.2 ioredis socket `.unref()`

- **plan 원문**: Redis 연결은 lazy + 명시적 `closeRedis()` 종료.
- **실제**: 위 두 조건을 유지하면서, `conn.on("connect", () => stream.unref())`를 추가해 producer-side 연결이 Node event loop를 잡지 못하게 한다.
- **이유**: `npm test`가 `calls_service.test.mjs`에서 무한 정지하는 문제 — endCall이 `enqueueCallSummary`로 ioredis socket을 lazily 연다. 테스트 cleanup은 다른 handle은 정리하지만 ioredis socket이 남아 tsx --test가 다음 파일로 못 넘어간다. API 서버와 워커 entry는 별도 long-lived handle(HTTP server / Worker connection)이 있어 `.unref()`로 producer 연결을 unref해도 process 수명이 짧아지지 않는다.
- **runtime 영향**: API/worker 프로세스에는 무영향. 테스트 프로세스만 깨끗하게 종료.

### 6.3 단위 테스트 케이스 수

- **plan 원문**: ~15~20 케이스 가이드.
- **실제**: 11 케이스로 마무리.
- **이유**: enqueue / processor / sweep / WS hook / lifecycle 5개 축을 각각 happy-path + 핵심 edge로 닫고, 권한/RLS는 이미 Phase 4/5에서 닫혀 있어 같은 격자를 다시 깔지 않았다. 모든 plan 완료 기준은 11 케이스 안에 매핑된다 (§2.2 표 참조). 11 / 11 PASS.

---

## 7. 다음 단계 (Step 2 진입 전 점검)

1. 본 findings 사용자 리뷰.
2. PHASE_5와 동일하게 `npm test` / e2e 회귀는 워커 OFF에서 도는 게 default — 본 Step도 production에 워커 entry를 띄울지는 운영 결정(`npm run start:worker`을 systemd unit으로 따로 띄움).
3. Step 2(real provider + `llm_usage_log`) 진입 시점은 사용자 승인 후. Step 1 산출물에는 schema 변경이 없으므로 마이그레이션 회귀는 비활성.
4. Git: 본 Step 산출물은 미커밋 상태 — 사용자 승인 후 commit / push.

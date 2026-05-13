# Phase 6 — Step 1 Plan (Worker + Cron + WS Suggestion Persistence)

> **상위 계획**: `docs/plan/phase-6/PHASE_6_MASTER.md` §4 Step 1.
> **선행 단계**: Phase 5 종료 — `docs/plan/phase-5/PHASE_5_STEP_5_FINDINGS.md`.
> **워크플로**: `AGENTS.md` Phase Workflow. 본 step은 **schema 변경 없음** — service / route / WS / worker 단계만 거친다.
> **기간**: 3~4일.

---

## 0. 목표

Phase 5에서 `service helper`만 깔린 다음 운영 루프를 실제로 돌아가게 만든다 — **mock provider 그대로**, 실 client는 Step 2에서 도입.

1. BullMQ + Redis 기반 **워커 인프라**를 부팅한다.
2. **endCall 후 AI summary 자동 생성** — `applyAiSummary` 를 큐 + 워커로 비동기 호출.
3. **60s heartbeat sweep** — disconnect 또는 비정상 종료 통화를 자동 `dropped` 마킹.
4. **WS suggestion persistence hook** — `text_chunk` 흐름 중 mock LLM이 suggestion을 생성 → `call_suggestions`에 영속 → 클라이언트에 id 포함 카드 재발사.

본 step의 모든 외부 의존성은 **mock**이다. 실 Clova / Anthropic / OpenAI는 Step 2.

---

## 1. 하지 않는 것

- 실 Clova / Anthropic / OpenAI provider client 추가 0건. mock 어댑터(Phase 5 Step 3 결과) 그대로.
- 새 schema / 마이그레이션 0건. Phase 5에서 마련한 컬럼/테이블만 사용.
- `llm_usage_log` 도입 0건 (Step 2).
- Action item DELETE 0건 (Step 3).
- Manager team-scope 보고서 0건 (Step 4).
- frontend 변경은 최소화 — WS suggestion id가 새로 채워지면서 자동으로 use/dismiss 버튼이 활성화되는 정도. 의도된 UI 변경 외 코드 수정 0건.
- RLS 정책 변경 0건. 워커도 `app` role + `withOrgContext` 동일 패턴.

---

## 2. Schema 검토

### 2.1 변경 필요?

**없음**. Phase 5 Step 1이 깐 다음이 본 step의 모든 SQL writes를 흡수한다:

| 표 | 사용 컬럼 | 출처 |
|---|---|---|
| `calls.last_seen_at` | heartbeat sweep cutoff | Phase 5 마이그레이션 1715000017000 |
| `calls.dropped_reason` | sweep 시 `'server_timeout'` 마킹 | 같음 |
| `calls.summary` / `needs` / `issues` / `sentiment` | AI summary 워커가 채움 | Phase 4 + Phase 5 |
| `calls.summary_source` / `summary_generated_at` | 워커가 `'ai'` 마킹 + 시각 기록 | Phase 5 |
| `call_suggestions` | WS 핸들러가 INSERT | Phase 5 마이그레이션 1715000016000 |
| `transcripts.stt_provider` / `stt_session_id` | (옵션) 실 STT 도입 시 채움 — 본 step에서는 mock 그대로 'fixture' | Phase 5 마이그레이션 1715000018000 |

### 2.2 RLS 영향

**없음**. 워커가 org-scoped writes를 할 때는 `app.withOrgContext(orgId, ...)`를 그대로 호출하므로 기존 RLS 정책이 그대로 적용된다. multi-org sweep cron은 먼저 내부 worker repository에서 `SELECT id FROM organizations`로 org id 목록을 조회한 뒤, 각 org별로 `withOrgContext`를 반복 호출한다.

주의: `organizations`는 현재 RLS 비적용 테이블이고 `app` role은 dev init grant로 SELECT 권한을 가진다. 따라서 전체 org id 조회 자체는 가능하지만, 이 helper는 worker 내부 전용으로만 둔다. route/service 공개 API로 노출하지 않는다.

### 2.3 마이그레이션 0건 확인

본 step 종료 시점에 `server/migrations/` 디렉터리 git diff = 0 byte 확인.

---

## 3. 사전 결정 (Step 1 시작 전 확정)

| # | 항목 | 결정 후보 | 추천 |
|---|---|---|---|
| S1-1 | 큐 라이브러리 | BullMQ vs bullmq-legacy(bull) | **BullMQ**. Phase 5 master plan §2 결정 18에서 확정. node-pg-migrate / typescript 호환 검증 완료된 stack. |
| S1-2 | Redis 클라이언트 | ioredis vs node-redis | **ioredis**. BullMQ 권장. |
| S1-3 | Heartbeat sweep 주체 | (a) BullMQ repeatable job, (b) setInterval inside worker, (c) node-cron | **(a) BullMQ repeatable job** — retry / dead-letter / observability를 큐 인프라가 무료로 제공. |
| S1-4 | Heartbeat sweep cutoff | 60초 (master plan §2 결정 10 그대로) | 60s |
| S1-5 | Heartbeat sweep 주기 | 30초 또는 60초 | **30초**. cutoff 60초 대비 절반 — 1회 누락도 안전 마진. |
| S1-6 | Multi-org sweep 구현 | (a) admin role + SQL 한방 (RLS 우회), (b) `app` role + org 루프 (`organizations` 목록 조회 후 `withOrgContext` 반복) | **(b) app role + org 루프**. org id 목록 조회만 RLS 비적용 `organizations`에서 내부 worker helper로 수행하고, 실제 dropped update는 기존 RLS 안에서 수행한다. 본격 multi-tenant 운영에서 병목이면 Phase 7+에서 admin role + 직접 SQL로 교체. |
| S1-7 | AI summary 워커 trigger | (a) endCall service 안에서 enqueue, (b) WS handler / route handler 각각 enqueue | **(a) service 안에서 enqueue**. WS + REST 두 경로가 같은 service 거치므로 한 곳에 후크하면 충분. 큐 payload는 반드시 `{ orgId, callId }` — `callId`만으로는 워커가 RLS context를 잡을 수 없다. enqueue는 endCall DB transaction이 성공한 뒤 best-effort로 수행한다. |
| S1-8 | AI summary retry 정책 | BullMQ exponential backoff 3회 + dead-letter | 3회. Phase 5 결정 21 graceful degrade. |
| S1-9 | WS suggestion 생성 trigger | (a) 매 text_chunk마다, (b) N개 text_chunk마다 batch, (c) 30초 timer | **(c) 30초 timer**. 매 chunk마다 LLM 호출은 cost 폭주. demo replay 패턴(시점별 group)을 30초 주기로 흉내. Phase 7에서 실 LLM streaming으로 교체. |
| S1-10 | WS suggestion persistence 위치 | (a) `ws/calls.ts` 안에서 직접 service 호출, (b) 별 internal worker queue | **(a) ws/calls.ts 안에서 직접**. 통화별 socket context를 가진 핸들러 안에서 처리. queue로 분리하면 socket 종료 후 결과 발사 경로가 복잡. |
| S1-11 | Demo WS replay 정책 | (a) 제거, (b) env flag `KLOSER_DEMO_REPLAY` 토글, (c) 그대로 두고 LLM 카드와 공존 | **(b) env flag**. `KLOSER_DEMO_REPLAY`가 명시되면 그 값을 따르고, 미설정 시 `NODE_ENV === 'production'` 에서만 0, dev/test에서는 1을 기본값으로 둔다. 기존 Phase 0.5/4/5 e2e 호환성을 유지하면서 운영에서는 fixture를 끈다. |
| S1-12 | 워커 entrypoint | `server/src/workers/index.ts`가 모든 워커를 한 process에서 spawn. prod에서는 별 process(`npm run start:worker`), dev에서는 별 터미널(`npm run dev:worker`) | 단일 entry. systemd unit 1개로 끝남. |
| S1-13 | 워커 health check | HTTP `/health/worker` 또는 process exit code | **process exit code** + console log. dev 단계는 HTTP probe 미도입. Phase 7 ops에서 도입. |
| S1-14 | endCall idempotency | endCall 가 중복 enqueue 가능 (e2e는 신경 안 씀). 워커가 `summary_source='manual'` 그대로면 no-op (Phase 5 SQL guard) | OK. retry 안전. |
| S1-15 | dev에서 Redis 사용 | `ops/docker-compose.yml` 의 Redis 그대로 사용. `REDIS_URL=redis://localhost:6379` | Phase 1 docker-compose 재사용. |
| S1-16 | Phase 5 e2e 워커 ON 회귀 | `phase_5_e2e.mjs` 가 워커 ON 환경에서도 PASS — manual summary 보호 SQL이 race를 막음 | master plan §9 그대로. |

---

## 4. 산출물

### 4.1 신규 (8)

- `server/src/queue/redis.ts` — ioredis 연결 (REDIS_URL 환경변수).
- `server/src/queue/queues.ts` — BullMQ 큐 정의 (`callSummary`, `heartbeatSweep` 2종).
- `server/src/queue/index.ts` — `enqueueCallSummary({ orgId, callId })` + `scheduleHeartbeatSweep()` export.
- `server/src/workers/callSummary.worker.ts` — consumer: pulls `{ orgId, callId }`, loads transcripts inside org context, calls mock LLM `summarizeCall`, then passes generated fields to `services/callSummary.applyAiSummary`.
- `server/src/workers/heartbeatSweep.worker.ts` — repeatable job consumer: enumerates orgs and runs `markTimedOutCallsDropped` per org.
- `server/src/workers/index.ts` — runner entrypoint. spawns both workers + schedules sweep repeat.
- `server/src/repositories/orgs.ts` — internal-only `listAllOrgIds(client)` helper for multi-org sweep. `organizations` has no RLS; keep this helper out of route/service public surfaces.
- `server/test/phase6_workers.test.mjs` — 단위/통합 (~15~20 케이스).

### 4.2 수정 (5)

- `server/src/services/calls.ts` — `endCall` DB transaction 성공 이후 `await enqueueCallSummary({ orgId: actorOrgId, callId }).catch(...)` (best-effort, 실패해도 ack 영향 없음).
- `server/src/services/callHeartbeat.ts` — multi-org sweep helper (`markAllOrgsDroppedTimedOut(client, cutoff)`) 추가. 단일 org 그대로 유지.
- `server/src/ws/calls.ts` — `text_chunk` 핸들러에 30초 timer 추가. timer fire 시 mock LLM `suggestForUtterance` 호출 → `persistSuggestionGroup` → 클라이언트에 `suggestion` 이벤트 (id 포함) 재발사. demo replay는 `shouldDemoReplay()` helper가 true일 때만 활성.
- `server/package.json` — `"dev:worker": "tsx watch src/workers/index.ts"`, `"start:worker": "tsx src/workers/index.ts"` 스크립트 추가.
- `server/package-lock.json` — BullMQ / ioredis dependency lock 갱신.
- `server/.env.example` — `REDIS_URL=redis://localhost:6379` 추가 (이미 있다면 생략), `KLOSER_DEMO_REPLAY=1` 명시 (dev 기본값).

### 4.3 수정 안 함

- `platform/**` — frontend 무수정. WS suggestion 이벤트에 id가 새로 포함되면서 자동으로 live.html의 use/dismiss 버튼이 활성됨. 별 코드 변경 없음 (Phase 5 Step 4 frontend가 이미 `if (s.id) { ... }` 분기를 갖고 있음).
- `server/src/adapters/**` — mock 그대로. 실 client는 Step 2.
- `server/migrations/**` — 변경 0건.
- `server/src/repositories/calls.ts` / `callSuggestions.ts` — 변경 0건. Phase 5 SQL이 그대로 흡수.
- `test/phase_*_e2e.mjs` — 변경 0건.

---

## 5. 실행 순서 (사일 단위)

### Day 1 — 큐 인프라 + AI summary 워커 mock 자동 채움

1. `server/src/queue/{redis,queues,index}.ts` 작성. BullMQ + ioredis 연결.
2. `server/src/workers/callSummary.worker.ts` 작성. `processor`가 `applyAiSummary`를 호출 (`resolveLlmAdapter()`로 mock 가져옴).
3. `server/src/workers/index.ts`에서 worker boot.
4. `server/src/services/calls.ts`의 `endCall`에 transaction 성공 이후 `await enqueueCallSummary({ orgId: actorOrgId, callId }).catch(...)` 추가.
5. 단위 테스트: endCall → `{ orgId, callId }` 큐 1 job 추가, 워커가 transcript를 모아 mock LLM 요약 처리 → `summary_source='ai'` + 4 필드 채워짐.
6. manual summary가 먼저 들어있던 row에 AI 워커가 작동해도 row 변경 0건 검증 (Phase 5 SQL guard 재확인).

### Day 2 — Heartbeat sweep cron

7. `server/src/repositories/orgs.ts`에 내부 전용 `listAllOrgIds(client)` 추가 — `organizations`는 RLS 비적용이므로 `app` role SELECT 1회로 목록을 얻되, route/service 공개 API로 노출하지 않는다.
8. `server/src/services/callHeartbeat.ts`에 multi-org sweep helper 추가. 각 org에 대해 `withOrgContext(orgId, (c) => markDroppedTimedOutInCurrentOrg(c, cutoff))` 반복.
9. `server/src/workers/heartbeatSweep.worker.ts` 작성. BullMQ repeatable job. 30s마다 cutoff = now() - 60s.
10. 단위 테스트: 60초 cutoff 전후로 통화 status 변화 확인. 두 org 동시 sweep 시 cross-org 영향 없음.

### Day 3 — WS suggestion persistence hook

11. `server/src/ws/calls.ts` `text_chunk` 핸들러에 30초 timer 등록. timer fire 시:
    a. 통화의 최근 transcript 일부를 transcript 윈도우로 모음
    b. `resolveLlmAdapter().suggestForUtterance({transcript, groupSeq, atMs})` 호출
    c. 결과를 `persistSuggestionGroup(app, orgId, callId, items)` 로 INSERT
    d. INSERT 결과 (id 포함) 를 클라이언트에 `suggestion` 이벤트로 발사 (Phase 0.5 demo 포맷 호환)
12. demo replay 환경변수 게이트: `shouldDemoReplay()` helper가 true일 때만 `scheduleDemoReplay()` 호출. helper는 명시 env 값을 우선하고, 미설정 시 production=0 / dev·test=1을 반환.
13. 단위 테스트: text_chunk 1회 → 30초 후 (fake clock or short cutoff env) → suggestion INSERT 1 group + WS 발사 1회. demo flag OFF 시 demo replay 발사 0회.

### Day 4 — 마무리 + 회귀

14. `server/test/phase6_workers.test.mjs` — 통합 테스트 정리.
15. `npm test` 회귀 — 새 ~15~20 + 기존 301 = 320 안팎.
16. `phase_5_e2e.mjs` 회귀 — 워커 OFF (default, e2e가 워커 process를 띄우지 않음) + 워커 ON (수동 검증) 둘 다 PASS.
17. `phase_4_e2e.mjs` 회귀 — 영향 없음 (워커 OFF 환경).
18. `PHASE_6_STEP_1_FINDINGS.md` 작성.

---

## 6. mock vs real provider 경계

| 표면 | 본 step | Step 2 |
|---|---|---|
| LLM 어댑터 호출 위치 | `resolveLlmAdapter()` (mock 강제) | resolver branches 채움 |
| LLM 어댑터 호출 빈도 | 워커 1회 / 통화 + WS 30초 timer | 동일 |
| 결과 영속 | `applyAiSummary` / `persistSuggestionGroup` | 동일 |
| 비용 추적 | 없음 | `llm_usage_log` INSERT |
| failure 시 동작 | summary NULL 유지 / suggestion 0 row | 동일 |

본 step은 mock만 wire하므로 실 cost 발생 0. 운영 진입은 Step 2 + 실 키 주입 후.

---

## 7. 테스트 전략

### 7.1 단위 / 통합

`server/test/phase6_workers.test.mjs`에 다음을 포함:

| 케이스 | 검증 포인트 |
|---|---|
| endCall → 큐 1 job + 워커 처리 → summary 채움 | `summary_source='ai'`, 4 필드 채움 |
| manual summary 후 endCall → 워커가 manual을 덮지 못함 | `summary_source='manual'` 그대로 |
| heartbeat sweep cutoff 전후 | in_progress 통화가 dropped로 마킹 |
| heartbeat sweep cross-org | beta 통화는 acme sweep 영향 없음 |
| heartbeat sweep idempotency | 동일 cutoff 반복 호출 시 변화 0 |
| text_chunk 30초 timer fire → suggestion 영속 | `call_suggestions` 1 group + WS 이벤트 id 포함 |
| KLOSER_DEMO_REPLAY=0 시 demo replay 발사 0회 | Phase 0.5 fixture 비활성 |
| 워커 retry 3회 + dead-letter | BullMQ retry policy 동작 |
| pre-emptive endCall → enqueue 실패해도 ack 정상 | Redis 단절 환경 graceful degrade |
| `applyAiSummary` 가 LLM throw 시 워커 retry | retry exhausted 후 dead-letter, summary NULL 유지 |

### 7.2 Phase 5 e2e 회귀

`phase_5_e2e.mjs`가 워커 process를 자동으로 띄우지 않는다. 따라서:

- 시나리오 3 (manual summary 저장) — 워커 OFF 환경에서는 AI summary가 채워지지 않으므로 manual 저장 후 `summary_source='manual'` 그대로 → PASS.
- 워커 ON 환경에서 e2e를 돌리는 수동 검증은 Step 5에서 자동화. 본 step에서는 회귀 통과만 확인.

### 7.3 환경변수

| 변수 | 기본값 | 용도 |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | BullMQ 연결 |
| `KLOSER_DEMO_REPLAY` | 명시값 우선. 미설정 시 production=0, dev/test=1 | Phase 0.5 fixture 발사 |
| `KLOSER_HEARTBEAT_CUTOFF_SEC` | `60` | dev에서 짧게 줘서 sweep 테스트 가속 |
| `KLOSER_HEARTBEAT_SWEEP_INTERVAL_SEC` | `30` | sweep job 주기 |
| `KLOSER_SUGGESTION_INTERVAL_MS` | `30000` | WS suggestion timer |

---

## 8. Cleanup 전략

본 step은 새 schema 0건이라 cleanup 표면도 Phase 5 그대로.

신규로 prefix scope를 추가하는 자리:

- `phase6test-` — `phase6_workers.test.mjs`의 in-process call/suggestion 라벨.

`phase5-e2e-` / `phase5test-` / `phase4test-` 와 충돌 없음. 단위 테스트는 자체 prefix 기반 sweep으로 자기 row만 정리.

워커가 만든 row(AI summary, suggestion)는:
- `summary` / `needs` / `issues` 텍스트는 mock LLM이 echo한 transcript의 일부 → 본 테스트가 transcript에 prefix를 넣으면 cleanup이 잡음.
- `call_suggestions.title`은 mock LLM의 결정적 한국어 문자열 → 본 테스트에서 prefix를 강제하지 못함. 따라서 cleanup은 부모 call_id 기반 cascade를 사용.

---

## 9. Phase 5 e2e 회귀 유지 계약 (재확인)

`phase_5_e2e.mjs`는 본 step의 변경이 적용된 상태에서도 PASS 해야 한다:

1. **endCall 후크 추가** — `phase_5_e2e.mjs` 시나리오 2의 endCall은 워커 OFF 환경이므로 enqueue가 시도되지만, BullMQ가 Redis 연결 실패 시 graceful degrade(아래 §10 위험 5)로 ack를 막지 않음. 또한 본 step의 endCall 변경은 `await enqueueCallSummary({ orgId: actorOrgId, callId }).catch(...)` 로 wrap해 실패 무시.
2. **heartbeat sweep cron** — `phase_5_e2e.mjs`는 통화를 short-lived(수 초)로 만들고 즉시 endCall로 종료. 60초 cutoff 도달 전이라 sweep 대상 아님.
3. **WS suggestion hook** — `phase_5_e2e.mjs` 시나리오 2의 live 통화는 text_chunk를 보내지 않음. 30초 timer fire 전에 endCall로 종료되므로 suggestion 영속 path가 발사되지 않음.
4. **demo replay** — `KLOSER_DEMO_REPLAY=1` (dev 기본값)이면 Phase 0.5 fixture가 그대로 발사. `phase_5_e2e.mjs`는 fixture에 의존하지 않으므로 무관.

종합: phase_5_e2e는 본 step 종료 후에도 console errors 0, residue 0 그대로.

---

## 10. 위험 요소 + 보류

### 10.1 위험

1. **Redis 연결 실패 시 endCall 영향** — endCall이 `await enqueueCallSummary`를 동기 await하면 Redis 단절 시 endCall이 throw. 워크어라운드: `.catch(err => log)` 로 wrap. 운영에서 Redis 단절은 ops 문제로 별 대응.
2. **워커 retry 폭주** — LLM mock은 throw 안 함. 실 provider 도입 후(Step 2)에 retry 폭주 위험. 본 step에서는 적음.
3. **heartbeat sweep race vs endCall** — 사용자가 endCall 누르는 순간 워커가 같은 row를 dropped로 마킹 시도. SQL CHECK 위반? `markDroppedTimedOutInCurrentOrg` SQL은 WHERE `status='in_progress'` 이고 endCall도 마찬가지로 in_progress만 받음. 둘 중 하나가 먼저 UPDATE하면 다른 쪽 WHERE 0 rows. CHECK 위반 0건. 검증 필요.
4. **demo replay와 LLM hook 충돌** — `KLOSER_DEMO_REPLAY=1` 이면 fixture와 LLM 결과가 같은 timeline에 카드를 발사. UI는 그냥 둘 다 표시. 운영에서는 demo flag 0 → fixture 없음.
5. **e2e 부팅 시 워커가 없음** — 본 step 종료 시점에 `phase_5_e2e.mjs`가 워커를 자동으로 띄우지 않으면 enqueue가 Redis로 가지만 처리되지 않아 Redis 큐에 backlog 누적. dev에서는 무해, prod에서는 ops 문제. 본 step에서는 endCall enqueue를 graceful degrade (실패 무시).
6. **워커 이중 boot** — 동일 worker process가 두 번 실행되면 sweep job이 중복 실행. BullMQ repeatable job은 jobId 고정으로 dedupe 처리 가능. plan에서 `jobId: 'heartbeat-sweep-singleton'` 으로 고정.
7. **`KLOSER_SUGGESTION_INTERVAL_MS` race** — 통화가 30초 미만이면 timer fire 0회. suggestion DB에 row 0. UI에 영향 없음 (Phase 5 frontend가 id-없는 카드도 처리).

### 10.2 보류 / Step 2+로 미룸

- 실 provider client → Step 2.
- `llm_usage_log` cost tracking → Step 2.
- 워커 HTTP health probe → Phase 7 ops.
- 워커 dead-letter alert → Phase 7 ops.
- Multi-org sweep 성능 최적화 (수백 org 이상) → Phase 7 scale.

---

## 11. 완료 기준 (Step 1 go gate)

- [ ] `npm --prefix server run typecheck` PASS (0 error).
- [ ] `npm --prefix server test` PASS — 기존 301 + 신규 15~20.
- [ ] `node test/sync_shared_types.mjs` PASS (entity 수 변화 없음 — 본 step은 새 shared type 없음).
- [ ] `node test/phase_4_e2e.mjs` 회귀 PASS.
- [ ] `node test/phase_5_e2e.mjs` 회귀 PASS (워커 OFF 환경).
- [ ] BullMQ 워커 process boot OK (`npm --prefix server run dev:worker` → 로그 출력 + 큐 listen).
- [ ] endCall → 큐 1 job → 워커가 mock LLM 호출 → `summary_source='ai'` row 검증.
- [ ] manual summary 후 AI 워커 호출 → row 변경 0건 검증.
- [ ] heartbeat sweep cutoff 통화가 `dropped/server_timeout`로 마킹 검증.
- [ ] cross-org sweep 격리 검증.
- [ ] text_chunk 30초 timer → `call_suggestions` 1 group + WS id 포함 카드 발사 검증.
- [ ] `KLOSER_DEMO_REPLAY=0` 시 fixture 발사 0회 검증.
- [ ] `docs/plan/phase-6/PHASE_6_STEP_1_FINDINGS.md` 작성.

---

## 12. Codex Review Focus

| # | 항목 | 어떻게 확인 |
|---|---|---|
| 12-1 | schema / 마이그레이션 0건 | `git diff server/migrations` = 0 byte |
| 12-2 | 실 provider client 0건 | `git diff server/src/adapters` = 0 byte |
| 12-3 | RLS 정책 변경 0건 | `git diff` SQL 0 byte |
| 12-4 | endCall enqueue graceful degrade | endCall의 catch 분기 + Phase 5 e2e 회귀 |
| 12-5 | manual summary 보호 | repository SQL의 `summary_source='manual'` WHERE가 그대로 유지 |
| 12-6 | heartbeat sweep race | endCall vs sweep SQL 양쪽 모두 WHERE `status='in_progress'`로 dedupe |
| 12-7 | Demo replay env flag | `KLOSER_DEMO_REPLAY` 분기 + Phase 5 e2e 호환성 |
| 12-8 | 워커 retry 캡 | BullMQ `attempts: 3` + `backoff: { type: 'exponential', delay: 5000 }` 설정 |
| 12-9 | cleanup contract | `phase6test-` prefix만 sweep. 좌석 시드 / 다른 prefix 0건 변경 |
| 12-10 | XSS gate | 본 step은 LLM 응답을 WS로 보내고 클라이언트는 기존 DOMPurify 통과. 새 innerHTML 추가 0건 |

---

## 13. 다음 작업 (Step 1 종료 후)

1. Step 2 plan 작성 — 실 provider client + `llm_usage_log` schema 도입.
2. Step 2 plan 사용자 리뷰 통과 → Step 2 구현 진입.
3. Step 2가 끝나야 Step 3 (action item DELETE) / Step 4 (manager 보고서)로 넘어간다.

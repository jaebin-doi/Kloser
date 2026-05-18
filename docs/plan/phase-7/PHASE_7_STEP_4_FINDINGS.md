# Phase 7 Step 4 Findings — retention enforce cron

작성일: 2026-05-18

상위 문서: `PHASE_7_MASTER.md` · 상세 계획: `PHASE_7_STEP_4_PLAN.md`.

---

## 1. 산출물

| 영역 | 위치 |
|---|---|
| Schema migration | `server/migrations/1715000026000_phase7_retention_audit_actions.sql` — `activity_log_action_check`를 Step 3 set + 2개 신규 action(`retention.transcripts_deleted`, `email_outbox.sending_recovered`)으로 재생성. `email_outbox_sending_locked_idx` partial index 추가. |
| Repository — transcripts | `server/src/repositories/transcriptRetention.ts` — `deleteExpiredTranscriptsInCurrentOrg(client, { cutoff, limit })`. CTE + `FOR UPDATE SKIP LOCKED`, transcript text 미반환. |
| Repository — email outbox | `server/src/repositories/emailOutboxRecovery.ts` — `recoverStuckSendingInCurrentOrg(client, { cutoff, now, limit })`. status `sending → failed`, lock metadata clear, `attempt_count` 불변, sensitive payload 보존. |
| Service | `server/src/services/retention.ts` — `loadRetentionConfigFromEnv` (env validation + `RetentionConfigError` fail-fast), `runRetentionForOrg` (배치 루프 + aggregate audit), `runRetentionTick` (per-org failure isolation). |
| Queue | `server/src/queue/queues.ts` + `index.ts` — `RETENTION_SWEEP_QUEUE`, `RetentionSweepJobData`, `getRetentionSweepQueue`, `scheduleRetentionSweep`, `QUEUE_NAMES.retentionSweep`. |
| Worker | `server/src/workers/retentionSweep.worker.ts` — `makeRetentionSweepProcessor(app, { config, now })`, `createRetentionSweepWorker(app, config)`. disabled config 시 `{ skipped: true, reason: 'disabled' }`. |
| Worker entrypoint | `server/src/workers/index.ts` — retention worker 항상 생성, `KLOSER_RETENTION_ENABLED=true`일 때만 schedule. shutdown 순서에 retention worker 포함. |
| Shared types | (없음 — Step 4는 frontend 없음, route 없음, browser mirror 없음. `test/sync_shared_types.mjs` registry 변경 없음.) |
| ActivityAction union 동기화 | `server/src/repositories/activityLog.ts` union + `server/src/routes/activityLog.ts` ACTIVITY_ACTIONS allow-list에 신규 2 action 추가. DB CHECK와 lockstep 유지. |
| Tests | `server/test/phase7_step4_retention_service.test.mjs` (11 시나리오), `server/test/phase7_step4_retention_worker.test.mjs` (3 시나리오). |
| Env | `server/.env.example`에 retention/email-stuck 관련 7개 env block 추가. |
| Docs | 이 파일 + `PHASE_7_MASTER.md` Step 4 [x] + Go/No-Go 갱신 + 다음 작업 안내. README/server README는 작은 footprint 변경. |

---

## 2. Audit action allow-list 동기화

3-way lockstep:

1. **DB CHECK** — `server/migrations/1715000026000_phase7_retention_audit_actions.sql`가 `activity_log_action_check`를 DROP + ADD하면서 Step 3 set + 2개 신규를 모두 포함.
2. **Repository union** — `server/src/repositories/activityLog.ts`의 `ActivityAction` 타입에 `retention.transcripts_deleted` / `email_outbox.sending_recovered` 추가.
3. **Route allow-list** — `server/src/routes/activityLog.ts`의 `ACTIVITY_ACTIONS` 배열에 같은 두 값 추가 (zod enum 입력에 들어가 400 invalid_input으로 거절되지 않게).

세 곳 중 하나라도 빠뜨리면 fail-fast:

- DB 누락 → `recordActivity` 호출 시 CHECK 위반으로 500.
- Union 누락 → TypeScript build 단계에서 `as const satisfies readonly ActivityAction[]` assertion으로 컴파일 실패.
- Route allow-list 누락 → 새 action으로 audit log을 admin이 필터 조회할 때 400 invalid_input.

---

## 3. 보존 정책 enforce

### 3.1 Transcripts

- 기본 cutoff: `now() - 1095일` (3년).
- Org별 `withOrgContext` 안에서 batch 단위(기본 500) hard delete.
- 한 tick에서 org당 최대 `batchSize * maxBatchesPerOrg = 10,000` rows. 백로그는 다음 tick으로 이월.
- 삭제 결과 count > 0일 때만 한 줄 audit row.
- `calls` 본행, `summary`, `needs`, `issues`, `sentiment`, action items, dashboard KPI는 모두 보존. 정책 대상은 "원문 대화 text"만.

### 3.2 Email outbox stuck recovery

- 기본 cutoff: `now() - 900s` (15분).
- `status='sending' AND locked_at IS NOT NULL AND locked_at < cutoff` 행을 `status='failed'`로 되돌리고 `locked_at` / `lock_token` 클리어, `next_attempt_at = now()`.
- `attempt_count`는 증가시키지 않음 — 실제 send 시도가 아니라 lease crash recovery이기 때문.
- `sensitive_payload_*` 4컬럼 보존 — 다음 delivery tick이 decrypt해서 보내야 함.
- `error_message`는 상수 `worker_recovered_stuck_sending` — provider error body나 raw token이 누출되지 않음.

### 3.3 Audit payload hygiene

두 audit action 모두 aggregate-only. 허용 키 집합 (`services/activityLog.ts`의 sanitizer를 통과하는 키만):

```json
// retention.transcripts_deleted
{
  "actor_type": "system",
  "cutoff": "<iso>",
  "deleted_count": <n>,
  "batch_size": 500,
  "batches": <n>,
  "retention_days": 1095
}

// email_outbox.sending_recovered
{
  "actor_type": "system",
  "cutoff": "<iso>",
  "recovered_count": <n>,
  "stuck_after_seconds": 900
}
```

각 row의 audit payload에는 transcript text / call_id / speaker / email body / raw token / ciphertext / lock_token이 들어가지 않는다. 테스트가 직접 `JSON.stringify(payload)`에 sensitive marker가 없음을 확인한다.

---

## 4. Worker 구조

- `loadRetentionConfigFromEnv(env)` — invalid env (out-of-range, non-integer, …) 시 `RetentionConfigError` throw. Worker boot가 silently 보존을 끄지 않도록 fail-fast.
- Codex review에서 env 파싱을 한 번 더 조였다. `3600abc` 같은 partial numeric string과 `KLOSER_RETENTION_ENABLED=definitely` 같은 알 수 없는 boolean string도 fail-fast 대상이다.
- Worker는 enabled/disabled와 무관하게 항상 생성 — shutdown에서 `await retentionWorker.close()`로 깨끗이 종료할 자리.
- `scheduleRetentionSweep(intervalMs)`는 `KLOSER_RETENTION_ENABLED=true`일 때만 호출. dev/CI는 기본 disabled.
- Processor는 `now` injection을 받아 deterministic 테스트 가능. job payload `nowIso`는 manual override (dev에서 수동 트리거할 때).
- Per-org 실패는 `runRetentionTick`이 catch해서 `failedOrgs: [{ orgId, errorName }]`로 모음. errorName만 — error message body는 logs에 흘리지 않음.

---

## 5. 검증 결과

```powershell
npm --prefix server run typecheck                              # PASS
node test/sync_shared_types.mjs                                # PASS (변경 없음 — Step 4는 shared type 없음)
npx tsx --test --test-concurrency=1 test/phase7_step4_retention_service.test.mjs   # 11/11 PASS
npx tsx --test --test-concurrency=1 test/phase7_step4_retention_worker.test.mjs    # 3/3 PASS
npm --prefix server run db:migrate:up                          # PASS (No migrations to run)
npm --prefix server test                                       # PASS (697 total / 694 pass / 3 skipped / 0 fail)
```

### 알려진 flaky

Step 3 findings에 적어둔 `phase7_email_outbox_repo.test.mjs` due-lease flaky 2개 건에 대해, Step 4는 `email_outbox` 컬럼 추가 없이 `status='sending'` 행만 별도로 다루므로 기존 due-lease 동작과 충돌하지 않는다. 새 index(`email_outbox_sending_locked_idx`)도 partial이라 기존 `email_outbox_due_idx`(`status IN ('pending','failed')`)와 겹치지 않는다. 풀 테스트에서 동일 flaky가 재현되면 Step 4 commit의 회귀가 아님을 확인할 것.

---

## 6. call_recordings 정책

Plan §3.5 결정에 따라 **이번 step에서는 call_recordings 테이블을 만들지 않는다**.

- 현재 product schema에 recording table이 없다.
- audio object storage(S3/MinIO)도 없다.
- 빈 테이블을 retention만 위해 신설하면 dead schema가 된다.

Phase 8/P2에서 recording metadata + storage가 들어올 때 이 worker에 `recordings` module을 추가한다. 새 audit action(`recording.deleted` 또는 동등)이 필요하면 Step 4와 동일한 3-way lockstep (DB CHECK + repository union + route allow-list) 마이그레이션으로 추가한다.

---

## 7. Phase 7 Go / No-Go 갱신

`PHASE_7_MASTER.md §6` 기준 다음 항목이 `[x]`로 갱신됐다:

- retention worker가 deterministic test cutoff로 검증됨 — `phase7_step4_retention_worker.test.mjs` boundary 테스트가 `now`를 +2일 이동시켜 cutoff 통과/미통과 양쪽을 직접 검증한다.

남은 게이트: Phase 7 closeout e2e, Step 2 closeout findings 작성, P1 follow-up bundle(cost map / role-based menu / report drilldown / demo cleanup / billing).

---

## 8. 다음 작업 인계

Plan `PHASE_7_MASTER.md §3` Step 5+ bundle:

1. `llm_usage_log.cost_usd_micros` price map.
2. role-based sidebar nav visibility (employee/viewer에게 보고서/감사 메뉴 숨김).
3. reports date window + agent drilldown.
4. demo-to-real frontend cleanup (dashboard / daily / newsletter 위젯).
5. billing / subscription caps.

운영 출시 게이트 측면에서는 P0 4개(Step 1~4)가 모두 닫혔으므로 Step 5+는 P1 우선순위로 분리해서 진행 가능.

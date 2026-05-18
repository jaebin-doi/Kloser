# Phase 7 Step 4 Plan — retention enforce cron

작성일: 2026-05-18

상위 문서: `PHASE_7_MASTER.md`

선행 완료:

- Step 1 — Resend email delivery + transactional `email_outbox`
- Step 2 — TOTP MFA / session hardening
- Step 3 — `activity_log` audit trail + admin query surface

이번 step의 목적은 문서상 보존 정책을 실제 worker cron으로 강제하는 것이다. Phase 7 Step 3에서 audit row 기록과 관리자 조회가 닫혔으므로, retention worker는 삭제/복구 결과를 `activity_log`에 aggregate event로 남긴다.

---

## 1. Current State

### 1.1 이미 있는 것

- `transcripts` table
  - `created_at timestamptz NOT NULL DEFAULT now()`
  - `org_id` denormalized + FORCE RLS
  - `transcripts_org_created_idx ON transcripts(org_id, created_at DESC)`
  - `DELETE` RLS policy exists.
- worker entrypoint
  - `server/src/workers/index.ts`
  - 현재 `callSummary`, `heartbeatSweep`, `emailDelivery` worker/scheduler를 부팅한다.
- queue infra
  - `server/src/queue/queues.ts`
  - `server/src/queue/index.ts`
  - singleton repeatable job 패턴이 이미 `heartbeat-sweep`, `email-delivery`에 있다.
- `activity_log`
  - `recordActivity`, `tryRecordActivity`
  - admin query surface `GET /activity-log`
  - action CHECK allow-list는 migration으로 확장해야 한다.
- `email_outbox`
  - Step 1에서 `status='sending'` stuck row recovery를 Step 4로 미뤘다.

### 1.2 없는 것

- `call_recordings` table은 현재 migration/runtime에 없다.
- audio object storage(S3/MinIO)도 없다.
- organization-level retention override column도 없다.

따라서 이번 step은 실제 존재하는 데이터 표면만 enforce한다. `call_recordings` 90일 보존 정책은 "recording metadata/storage 도입 시 같은 worker에 붙인다"는 hook/설계만 남기고, 빈 테이블을 새로 만들지 않는다.

---

## 2. Scope

### 한다

1. **Transcript retention**
   - 기본 보존 기간: 3년.
   - `transcripts.created_at < cutoff`인 row를 org별 RLS context에서 batch delete.
   - 삭제는 deterministic cutoff를 받을 수 있어야 테스트가 wall clock sleep 없이 가능하다.
   - 삭제 결과는 org별 aggregate audit row로 남긴다.

2. **Email outbox stuck sending recovery**
   - `email_outbox.status='sending'`이고 `locked_at < cutoff`인 row를 `failed`로 되돌린다.
   - `locked_at`, `lock_token`을 비우고 `next_attempt_at=now()`로 재시도 가능하게 만든다.
   - `attempt_count`는 증가시키지 않는다. 실제 전송 시도 결과가 아니고 lease crash recovery이기 때문이다.
   - 복구 결과는 org별 aggregate audit row로 남긴다.

3. **Worker cron**
   - 새 singleton repeatable queue를 추가한다.
   - worker process가 부팅될 때 schedule한다.
   - dev/test에서는 기본 disabled 또는 명시 env로만 enable한다.
   - tests는 processor를 직접 호출해 deterministic 검증한다.

4. **Audit**
   - Step 3 `activity_log` action allow-list를 migration으로 확장.
   - retention worker 결과를 `activity_log`에 남긴다.

### 안 한다

- `call_recordings` table/object storage 구현.
- S3/MinIO object delete.
- per-org retention override.
- legal hold.
- user-facing retention settings UI.
- transcript archival/export.
- email outbox delivered/dead-letter archive purge.

---

## 3. Decisions

### 3.1 Transcript deletion model

결정: `transcripts` row 자체를 hard delete한다.

이유:

- `transcripts`는 append-only child table이고 soft delete column이 없다.
- 부모 `calls`는 남겨야 한다. call row에는 KPI/summary/action item/report가 남아야 하므로 call 자체 삭제는 하지 않는다.
- `calls.summary`, `needs`, `issues`, `sentiment`는 삭제하지 않는다. transcript 원문 보존 정책과 call-level business record는 별개다.

### 3.2 Batch model

결정: org별로 작은 batch를 반복 삭제한다.

기본값:

```text
KLOSER_RETENTION_TRANSCRIPT_DAYS=1095
KLOSER_RETENTION_TRANSCRIPT_BATCH_SIZE=500
KLOSER_RETENTION_MAX_BATCHES_PER_ORG=20
```

한 tick에서 org 하나가 최대 `500 * 20 = 10,000` rows를 삭제한다. 대량 backlog가 있으면 다음 tick/day에 이어 처리한다. 이 방식은 긴 transaction과 lock 폭주를 피한다.

### 3.3 Cron enablement

결정: local/dev/test에서는 자동 스케줄을 기본으로 켜지 않는다.

Env:

```text
KLOSER_RETENTION_ENABLED=false
KLOSER_RETENTION_INTERVAL_SEC=86400
KLOSER_RETENTION_TRANSCRIPT_DAYS=1095
KLOSER_RETENTION_TRANSCRIPT_BATCH_SIZE=500
KLOSER_RETENTION_MAX_BATCHES_PER_ORG=20
KLOSER_EMAIL_STUCK_SENDING_AFTER_SEC=900
```

Production/staging에서 `KLOSER_RETENTION_ENABLED=true`를 명시해야 scheduler가 등록된다. Worker class/processor는 항상 import 가능해야 하고, tests는 env와 무관하게 직접 호출한다.

### 3.4 Audit event granularity

결정: 삭제 row마다 audit row를 남기지 않고 org별 aggregate row 하나를 남긴다.

이유:

- transcript row 개별 audit은 너무 고용량이다.
- retention은 정책 집행 이벤트이지 사용자 mutation이 아니다.
- admin이 필요한 것은 "언제, 어떤 cutoff로, 몇 건을 삭제했나"다.

초기 audit actions:

```text
retention.transcripts_deleted
email_outbox.sending_recovered
```

Target:

- `target_type = 'organization'`
- `target_id = org_id`
- `user_id = null`
- payload 예:

```json
{
  "actor_type": "system",
  "cutoff": "2023-05-18T00:00:00.000Z",
  "deleted_count": 128,
  "batch_size": 500,
  "batches": 1,
  "retention_days": 1095
}
```

Email stuck recovery payload:

```json
{
  "actor_type": "system",
  "cutoff": "2026-05-18T00:45:00.000Z",
  "recovered_count": 3,
  "stuck_after_seconds": 900
}
```

Payload must not include email body, raw token, ciphertext, transcript text, provider error body, or lock token.

### 3.5 call_recordings policy

결정: 이번 step에서 `call_recordings` table을 만들지 않는다.

Plan language:

- 현재 product에는 recording upload/playback/storage가 없다.
- 없는 table을 retention만 위해 추가하면 dead schema가 된다.
- Phase 8/P2 recording storage 작업이 `call_recordings` metadata table을 만들 때, 이 Step 4 worker에 `recordings` module을 추가한다.
- Step 4 findings에는 "call_recordings 90일 enforce는 storage surface 부재로 not applicable"이라고 명시한다.

---

## 4. Schema Plan

Forward migration:

```text
server/migrations/1715000026000_phase7_retention_audit_actions.sql
```

작업:

1. `activity_log_action_check` 확장.
   - PostgreSQL은 CHECK constraint를 직접 edit하지 못하므로 drop + re-add.
   - 기존 allow-list 전체 + 신규 2개 action.

```text
retention.transcripts_deleted
email_outbox.sending_recovered
```

2. 필요 인덱스 확인.
   - `transcripts_org_created_idx`가 이미 있으므로 추가 transcript index는 만들지 않는다.
   - `email_outbox` stuck recovery는 `status='sending' AND locked_at < cutoff` scan이 필요하다. 새 partial index 추가:

```sql
CREATE INDEX email_outbox_sending_locked_idx
  ON email_outbox(org_id, locked_at)
  WHERE status = 'sending' AND locked_at IS NOT NULL;
```

3. Grants.
   - app role은 이미 `transcripts` delete, `email_outbox` update, `activity_log` insert 권한이 있다.
   - migration에서 권한을 다시 확인하고, 필요한 경우 idempotent GRANT만 추가한다.

Down migration:

- 새 partial index drop.
- action CHECK를 이전 Step 3 allow-list로 되돌린다.

---

## 5. Repository Plan

### 5.1 `server/src/repositories/transcriptRetention.ts`

Helpers:

```ts
deleteExpiredTranscriptsInCurrentOrg(client, {
  cutoff: Date,
  limit: number,
}): Promise<{ deletedCount: number; oldestDeletedAt: Date | null; newestDeletedAt: Date | null }>
```

SQL shape:

```sql
WITH doomed AS (
  SELECT id, created_at
    FROM transcripts
   WHERE created_at < $1
   ORDER BY created_at
   LIMIT $2
   FOR UPDATE SKIP LOCKED
),
deleted AS (
  DELETE FROM transcripts t
   USING doomed d
   WHERE t.id = d.id
   RETURNING d.created_at
)
SELECT count(*)::int, min(created_at), max(created_at) FROM deleted;
```

Rules:

- No `org_id = $x` predicate. RLS current org context scopes it.
- No transcript text returned.
- Limit is clamped in service layer before calling repository.

Tests:

- deletes only rows older than cutoff.
- same-org only under RLS.
- no GUC deletes 0 or is rejected safely.
- batch limit respected.
- newer rows remain.

### 5.2 `server/src/repositories/emailOutboxRecovery.ts`

Helpers:

```ts
recoverStuckSendingInCurrentOrg(client, {
  cutoff: Date,
  now: Date,
  limit: number,
}): Promise<{ recoveredCount: number }>
```

SQL shape:

```sql
WITH stuck AS (
  SELECT id
    FROM email_outbox
   WHERE status = 'sending'
     AND locked_at IS NOT NULL
     AND locked_at < $1
   ORDER BY locked_at
   LIMIT $2
   FOR UPDATE SKIP LOCKED
)
UPDATE email_outbox e
   SET status = 'failed',
       failed_at = $3,
       error_message = 'worker_recovered_stuck_sending',
       next_attempt_at = $3,
       locked_at = NULL,
       lock_token = NULL
  FROM stuck
 WHERE e.id = stuck.id
 RETURNING e.id;
```

Rules:

- Do not increment `attempt_count`.
- Do not touch sensitive payload columns.
- Do not recover delivered/dead_lettered/failed/pending rows.
- RLS via current org only.

Tests:

- old sending rows recover.
- fresh sending rows remain.
- non-sending rows remain.
- cross-org isolation.
- lock token is cleared but never audited.

---

## 6. Service Plan

Add `server/src/services/retention.ts`.

Core types:

```ts
interface RetentionConfig {
  transcriptRetentionDays: number;
  transcriptBatchSize: number;
  maxBatchesPerOrg: number;
  emailStuckSendingAfterSec: number;
  emailRecoveryBatchSize: number;
}

interface RetentionOrgResult {
  orgId: string;
  transcriptsDeleted: number;
  transcriptBatches: number;
  emailOutboxRecovered: number;
}
```

Functions:

```ts
loadRetentionConfigFromEnv(env?: NodeJS.ProcessEnv): RetentionConfig
runRetentionForOrg(app, orgId, config, now = new Date()): Promise<RetentionOrgResult>
runRetentionTick(app, config, now = new Date()): Promise<RetentionTickResult>
```

Behavior:

1. Compute transcript cutoff:

```ts
new Date(now.getTime() - transcriptRetentionDays * 24 * 60 * 60 * 1000)
```

2. For each org:
   - delete transcript batches until count is 0 or maxBatches reached.
   - recover email stuck sending rows once per tick.
   - insert audit rows only when count > 0.

3. Audit:
   - use `recordActivity` inside same org context after the mutation batch transaction.
   - For transcript deletes, either:
     - delete all batches in one transaction then record one audit row in the same transaction, or
     - per batch transaction + per org aggregate audit after.  
   Decision: use one org transaction containing all batches + audit row. Max batch caps bound the transaction.

4. Failure:
   - one org failure does not stop other orgs.
   - tick result records failed org ids and sanitized error names.

Config validation:

- days must be positive integer.
- batch size 1..5000.
- max batches 1..100.
- stuck seconds 60..86400.
- interval seconds 60..86400.
- invalid env is fail-fast at worker boot.

---

## 7. Worker / Queue Plan

### 7.1 Queue additions

Update `server/src/queue/queues.ts`:

```ts
export const RETENTION_SWEEP_QUEUE = "retention-sweep";

export interface RetentionSweepJobData {
  nowIso?: string; // test/manual only
}
```

Add lazy queue handle `getRetentionSweepQueue()` with:

- attempts: 1
- removeOnComplete: { count: 100 }
- removeOnFail: { count: 200 }

Update `server/src/queue/index.ts`:

```ts
scheduleRetentionSweep(intervalMs)
QUEUE_NAMES.retentionSweep
```

Singleton repeat key:

```text
retention-sweep-singleton
```

### 7.2 Worker

Add `server/src/workers/retentionSweep.worker.ts`.

Exports:

```ts
makeRetentionSweepProcessor(app, config, opts?)
createRetentionSweepWorker(app, config)
```

Processor:

- if config disabled: no-op result `{ skipped: true, reason: 'disabled' }`.
- list org ids through `listAllOrgIds`.
- call `runRetentionForOrg` per org.
- log aggregate counts:
  - orgsScanned
  - transcriptsDeleted
  - emailOutboxRecovered
  - failedOrgs

### 7.3 Worker entrypoint

Update `server/src/workers/index.ts`:

- load retention config.
- create retention worker always, with disabled config allowed.
- schedule only when `KLOSER_RETENTION_ENABLED=true`.
- shutdown closes retention worker before queues/redis/app.

Boot log should include:

```text
retention-sweep disabled
```

or

```text
retention-sweep enabled (interval=86400s, transcriptDays=1095)
```

---

## 8. Test Plan

### 8.1 Repository/service tests

Add `server/test/phase7_step4_retention_service.test.mjs`.

Cases:

1. transcript older than cutoff is deleted.
2. transcript newer than cutoff remains.
3. batch limit respected.
4. multiple batches stop at maxBatches.
5. Acme sweep does not delete Beta transcript.
6. no transcript text appears in audit payload.
7. audit row `retention.transcripts_deleted` is written only when delete count > 0.
8. email_outbox old `sending` row recovers to `failed`.
9. fresh `sending` row remains.
10. non-sending rows remain.
11. email recovery clears lock metadata and sets `next_attempt_at`.
12. email recovery audit row omits lock_token, body, raw token, ciphertext.
13. invalid env config throws sanitized config error.

### 8.2 Worker tests

Add to existing `server/test/phase6_workers.test.mjs` or a new `server/test/phase7_step4_retention_worker.test.mjs`.

Cases:

1. processor disabled → skipped result, no mutation.
2. processor scans both orgs and isolates failures.
3. deterministic `now` drives cutoff without sleeping.
4. worker result counts match DB state.

### 8.3 Migration checks

Route/repo tests already prove `activity_log_action_check` rejects unknown actions. Step 4 tests should prove new actions are accepted by inserting via `recordActivity`.

### 8.4 Required baseline

```powershell
npm --prefix server run typecheck
npm --prefix server test
node test/sync_shared_types.mjs
```

No shared browser type is expected unless a public API is added. Step 4 has no frontend.

Optional e2e:

- Not required for Step 4 because no user-facing UI changes.
- If added, use direct DB fixture + worker processor invocation, not wall clock sleeps.

---

## 9. Implementation Order

1. **Schema migration**
   - `1715000026000_phase7_retention_audit_actions.sql`
   - action CHECK add:
     - `retention.transcripts_deleted`
     - `email_outbox.sending_recovered`
   - `email_outbox_sending_locked_idx`
   - migration smoke.

2. **Repository tests + repositories**
   - `transcriptRetention.ts`
   - `emailOutboxRecovery.ts`
   - RLS/batch/cutoff tests.

3. **Service + audit tests**
   - `services/retention.ts`
   - config loader
   - org runner
   - aggregate audit rows.

4. **Queue + worker**
   - queue definitions
   - `retentionSweep.worker.ts`
   - worker entrypoint registration and schedule gate.

5. **Worker tests**
   - disabled/enabled processor
   - deterministic now/cutoff
   - per-org failure isolation.

6. **Docs closeout**
   - `PHASE_7_STEP_4_FINDINGS.md`
   - update `PHASE_7_MASTER.md`
   - update README/server README env notes if config names are added.

---

## 10. Completion Criteria

Step 4 is complete when:

- [ ] forward migration expands `activity_log_action_check` for retention/recovery actions.
- [ ] `email_outbox_sending_locked_idx` exists.
- [ ] transcript retention repository deletes only expired same-org rows and respects batch limit.
- [ ] email outbox recovery repository only recovers stuck `sending` rows.
- [ ] retention service writes aggregate audit rows with sanitized payload.
- [ ] retention processor can run with deterministic `now`.
- [ ] retention worker is registered in `server/src/workers/index.ts`.
- [ ] cron scheduling is disabled by default outside explicit env enablement.
- [ ] `call_recordings` absence is documented as not applicable until recording storage exists.
- [ ] `npm --prefix server run typecheck` PASS.
- [ ] `npm --prefix server test` PASS.
- [ ] `node test/sync_shared_types.mjs` PASS.
- [ ] Step 4 findings written and reviewed.

---

## 11. Next Task For Implementer

Start with the schema migration only:

1. Add `1715000026000_phase7_retention_audit_actions.sql`.
2. Recreate `activity_log_action_check` with the Step 3 action set plus:
   - `retention.transcripts_deleted`
   - `email_outbox.sending_recovered`
3. Add `email_outbox_sending_locked_idx`.
4. Do not add worker code in the schema commit.
5. Run migration + targeted activity_log CHECK tests before moving to repository work.

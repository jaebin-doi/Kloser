# Phase 8 Step 5 Plan - Retention Worker Integration

작성일: 2026-05-19

상위 문서:

- `docs/plan/phase-8/PHASE_8_MASTER.md`
- `docs/plan/phase-8/PHASE_8_STEP_4_FINDINGS.md`
- `docs/plan/phase-7/PHASE_7_STEP_4_FINDINGS.md`

선행 조건:

- Step 1 `call_recordings` metadata schema 완료.
- Step 2 repository + recording storage adapter boundary 완료.
- Step 3 backend upload/finalize/list/playback/delete routes 완료.
- Step 4 frontend playback UI 완료.
- Phase 7 Step 4 retention worker가 이미 transcript retention + stuck email recovery를 수행한다.

주의:

- Step 5는 worker/service/repository/audit 작업이다.
- Frontend와 backend route 계약은 수정하지 않는다.
- Browser playback UI, upload UI, waveform, transcoding은 Step 5 범위가 아니다.
- Object key, bucket, signed URL, raw audio bytes, per-recording id list는 audit payload나 logs에 넣지 않는다.

---

## 0. 목표

Step 5의 목표는 Phase 7 retention worker에 call recording object lifecycle을 연결하는 것이다.

완료 후 retention worker는 다음을 수행해야 한다.

1. 각 org context에서 보존 기간이 지난 `call_recordings` row를 batch로 찾는다.
2. 각 recording의 object storage object를 삭제한다.
3. 삭제 성공 또는 object-not-found를 idempotent success로 보고 metadata를 tombstone 또는 hard delete한다.
4. user-facing route delete 실패로 `delete_pending`에 남은 row도 재시도한다.
5. aggregate audit row만 남긴다.
6. 한 org/provider/recording의 실패가 전체 tick을 막지 않는다.

---

## 1. Critical Correction

기존 Step 2 helper:

```ts
listRetentionCandidatesInCurrentOrg(client, cutoff, limit)
```

이 단일 cutoff는 Step 5 정책을 정확히 표현하기에 부족하다.

정책상 두 기준이 다르다.

- 명시적 cutoff: `retention_delete_after <= now`
- 기본 90일 cutoff: `retention_delete_after IS NULL AND uploaded_at <= now - recordingRetentionDays`

단일 `cutoff`에 `now - 90d`를 넣으면 명시 `retention_delete_after`도 90일 늦게 삭제된다. 반대로 `now`를 넣으면 기본 정책이 업로드 직후 삭제될 수 있다.

따라서 Step 5 구현은 repository helper를 다음 중 하나로 수정해야 한다.

Preferred:

```ts
listRetentionCandidatesInCurrentOrg(client, {
  explicitCutoff: now,
  uploadedBefore: new Date(now - recordingRetentionDays),
  limit,
})
```

Acceptable:

```ts
listRetentionCandidatesInCurrentOrg(client, now, recordingRetentionDays, limit)
```

Preferred가 더 명확하다. 쿼리 조건은 다음이 되어야 한다.

```sql
WHERE deleted_at IS NULL
  AND status IN ('uploaded', 'available', 'failed')
  AND (
    (retention_delete_after IS NOT NULL AND retention_delete_after <= $1)
    OR
    (retention_delete_after IS NULL AND uploaded_at IS NOT NULL AND uploaded_at <= $2)
  )
ORDER BY COALESCE(retention_delete_after, uploaded_at) ASC, id ASC
LIMIT $3
```

`delete_pending` 재시도 대상은 별도 helper가 더 안전하다. `delete_pending`은 이미 user/admin delete가 시작된 row라서 "90일 정책 대상"과 의미가 다르다.

---

## 2. Scope

### 한다

1. `activity_log.action` allow-list에 recording retention aggregate action 추가.
2. `ActivityAction` union lockstep 갱신.
3. retention config에 recording 관련 env 추가.
4. `callRecordings` repository retention helper 보정.
5. `delete_pending` retry helper 추가.
6. retention service에 recording sweep 추가.
7. storage adapter를 worker에서 사용하도록 app decorator/plugin 경계 확인.
8. service/unit tests와 worker tests 추가.
9. findings 작성 및 master 갱신은 구현/검증 후 수행.

### 하지 않는다

- `platform/*` 수정.
- recording routes 수정.
- shared browser/server REST type 수정.
- playback UI 수정.
- upload/finalize flow 수정.
- waveform/transcoding/audio alignment.
- real MinIO/S3 integration smoke를 기본 CI에 넣기.

---

## 3. Audit Action

### 3.1 New Action

Add:

```text
retention.recordings_deleted
```

Reason:

- Reusing `retention.transcripts_deleted` would make audit semantics ambiguous.
- `activity_log.action` is CHECK-bound, so this requires a forward migration.

Target:

```ts
target_type = "organization"
target_id = orgId
actorUserId = null
payload.actor_type = "system"
```

### 3.2 Migration

New migration:

```text
server/migrations/1715000030000_phase8_recording_retention_audit_action.sql
```

Change:

- Drop/recreate `activity_log_action_check` with `retention.recordings_deleted`.
- Do not change target type CHECK.
- Avoid header phrases that match node-pg-migrate's SQL splitter accidentally. Step 3 found that comments containing a literal down-section marker can mis-split SQL migrations.

### 3.3 Type Union

Update:

```text
server/src/repositories/activityLog.ts
```

Add `retention.recordings_deleted` to `ActivityAction`.

### 3.4 Payload

Allowed payload keys:

- `actor_type`
- `cutoff`
- `uploaded_before`
- `retention_days`
- `deleted_count`
- `object_not_found_count`
- `failed_count`
- `batch_size`
- `batches`
- `storage_provider_counts`
- `delete_pending_retried_count`

Forbidden payload:

- `recording_id`
- `recording_ids`
- `call_id`
- `call_ids`
- `object_key`
- `storage_bucket`
- `storage_provider` as per-row value
- signed URL
- checksum
- object version
- provider endpoint
- access key / secret
- raw error message
- raw audio bytes

`storage_provider_counts` is acceptable only as aggregate counts, e.g.:

```json
{ "local": 10, "s3": 4, "minio": 0 }
```

No object locator values.

---

## 4. Config

Extend `RetentionConfig` in:

```text
server/src/services/retention.ts
```

Add:

```ts
recordingRetentionDays: number;       // default 90
recordingBatchSize: number;           // default 100
recordingDeletePendingRetryAfterSec: number; // default 900
```

Optional but useful:

```ts
recordingMaxDeleteFailuresPerOrg: number; // default maybe batch size
```

Recommendation:

- Reuse `maxBatchesPerOrg` for both transcript and recording batch loops to keep tick runtime bounded.
- Keep recording batch size separate from transcript batch size because recording deletes call object storage and are slower.

Env names:

```text
KLOSER_RETENTION_RECORDING_DAYS
KLOSER_RETENTION_RECORDING_BATCH_SIZE
KLOSER_RETENTION_RECORDING_DELETE_PENDING_RETRY_AFTER_SEC
```

Validation ranges:

| Field | Default | Min | Max |
|---|---:|---:|---:|
| recording days | 90 | 1 | 36500 |
| recording batch size | 100 | 1 | 1000 |
| delete_pending retry sec | 900 | 60 | 86400 |

Keep existing `KLOSER_RETENTION_ENABLED` gate. It should continue to control the whole retention tick scheduler/processor.

---

## 5. Repository Work

File:

```text
server/src/repositories/callRecordings.ts
```

### 5.1 Fix Candidate Helper

Replace or overload current helper with a two-cutoff input.

Preferred input:

```ts
export interface CallRecordingRetentionCandidateInput {
  explicitCutoff: Date;
  uploadedBefore: Date;
  limit: number;
}
```

Function:

```ts
listRetentionCandidatesInCurrentOrg(
  client,
  input: CallRecordingRetentionCandidateInput,
): Promise<CallRecording[]>
```

Validation:

- `explicitCutoff` valid Date.
- `uploadedBefore` valid Date.
- `limit` positive integer.

States included:

- `uploaded`
- `available`
- `failed`

States excluded:

- `upload_pending`
- `processing`
- `delete_pending`
- `deleted`
- tombstoned rows with `deleted_at IS NOT NULL`

Why exclude `processing`:

- A future transcoder could still be writing a derived object. Retention should not race active processing.

### 5.2 Add Delete-Pending Retry Helper

Add a separate helper:

```ts
listDeletePendingRetryCandidatesInCurrentOrg(client, input): Promise<CallRecording[]>
```

Input:

```ts
{
  olderThan: Date;
  limit: number;
}
```

Query:

```sql
WHERE deleted_at IS NULL
  AND status = 'delete_pending'
  AND updated_at <= $1
ORDER BY updated_at ASC, id ASC
LIMIT $2
```

Reason:

- User route delete can leave `delete_pending` after object storage failure.
- Retry should not wait for 90-day retention.
- `olderThan` avoids racing an in-flight user delete request that has just marked the row pending.

### 5.3 Add Locking / State Guard

The current list helpers do not use `FOR UPDATE SKIP LOCKED`. For a worker with external object storage calls, avoid holding a DB transaction while deleting objects. Preferred service pattern:

1. In org context, list candidate rows without locking.
2. For each row:
   - attempt object delete outside DB transaction.
   - after success, open short org transaction and call `markDeletedInCurrentOrg` or `hardDeleteByIdInCurrentOrg`.

This means a concurrent worker could pick the same row. Object delete must be idempotent:

- success → OK
- storage_object_not_found → OK
- second metadata update returns null/false → OK

If stronger de-duplication is desired, Step 5 can add a repo helper to atomically mark candidates `delete_pending` first:

```ts
claimRetentionCandidatesInCurrentOrg(...)
```

But that mutates state before external object deletion. It also makes worker failures leave more `delete_pending` rows. For Step 5, keep the simpler idempotent per-row flow unless tests reveal unacceptable duplicate work.

---

## 6. Metadata Final State

Decision: **markDeleted, not hardDelete, for Step 5 v1.**

Reason:

- User-facing delete route already tombstones rows.
- Audit/debugging benefits from keeping metadata that an object was deleted.
- `listByCallInCurrentOrg` hides tombstoned rows, so UI impact is none.
- Hard delete can be a future compaction step after an additional retention period.

Worker should:

```ts
await adapter.deleteObject(...)
await markDeletedInCurrentOrg(client, recording.id, now)
```

Object-not-found:

- Treat as success.
- Increment `object_not_found_count`.
- Still markDeleted.

Already tombstoned:

- `markDeletedInCurrentOrg` returns null.
- Treat as success/no-op.

Hard delete remains available for tests and future compaction, but Step 5 should not use it in the production worker path.

---

## 7. Service Design

File:

```text
server/src/services/retention.ts
```

### 7.1 Result Shapes

Extend:

```ts
export interface RetentionOrgResult {
  orgId: string;
  transcriptsDeleted: number;
  transcriptBatches: number;
  emailOutboxRecovered: number;
  recordingsDeleted: number;
  recordingBatches: number;
  recordingObjectNotFound: number;
  recordingDeleteFailures: number;
  recordingDeletePendingRetried: number;
}
```

Extend tick:

```ts
export interface RetentionTickResult {
  ...
  recordingsDeleted: number;
  recordingObjectNotFound: number;
  recordingDeleteFailures: number;
}
```

Worker log line should add aggregate counts only:

```text
recordingsDeleted=N recordingDeleteFailures=N
```

No object key or recording ids.

### 7.2 Per-Org Flow

Current `runRetentionForOrg` wraps transcripts + email recovery + audit in one DB transaction via `app.withOrgContext`.

Recording object deletion is different because it calls external storage. Do **not** perform object storage HTTP calls inside a long DB transaction.

Recommended Step 5 structure:

```ts
export async function runRetentionForOrg(app, orgId, config, now) {
  const transcript/email result = await app.withOrgContext(...existing tx...);
  const recording result = await runRecordingRetentionForOrg(app, orgId, config, now);
  return merged result;
}
```

`runRecordingRetentionForOrg`:

1. Compute:
   - `explicitCutoff = now`
   - `uploadedBefore = now - recordingRetentionDays`
   - `deletePendingOlderThan = now - recordingDeletePendingRetryAfterSec`
2. For `batch < maxBatchesPerOrg`:
   - list retention candidates with limit `recordingBatchSize`.
   - list delete_pending retry candidates with remaining batch capacity.
   - if both empty, break.
   - for each row:
     - call `app.recordingStorage.deleteObject({ bucket: row.storage_bucket, objectKey: row.object_key, objectVersion: row.object_version })`
     - if success or `storage_object_not_found`, tombstone metadata in short `withOrgContext` transaction.
     - if storage failure, leave row unchanged for normal candidates, leave `delete_pending` unchanged for retry candidates.
   - update aggregate counters.
3. After all batches, if any count changed, record one aggregate audit row in org context.

Important:

- `storage_bucket` is currently null in v1. Pass it through anyway because the adapter interface accepts bucket and future storage policy may use it.
- `object_key` is required for deletion but must not be logged/audited.
- `object_version` can be passed for versioned stores, but not audited.

### 7.3 Audit Placement

For transcript/email, audit is in the same DB transaction as mutation. For recordings, object deletion occurs outside transaction.

Recommended:

- Tombstone metadata per row in short transactions after object delete success.
- After loop, write one aggregate audit row in a final short org transaction if `recordingsDeleted > 0 || objectNotFound > 0`.

This is not strictly atomic across all rows, but it avoids holding DB locks while doing network IO. The aggregate audit describes completed metadata transitions in that tick.

If audit insert fails:

- Do not roll back already-deleted objects.
- Let `runRetentionForOrg` throw for that org after the final audit failure? This would cause `failedOrgs` even though object deletion completed.

Recommendation:

- Treat audit insert failure as org failure because audit is compliance-critical.
- Document that object deletion may have succeeded even if audit failed, and the next tick will not re-audit already tombstoned rows. This is an existing tradeoff introduced by external storage. To reduce this risk, keep audit payload simple and sanitizer-safe.

### 7.4 Failure Isolation

Per recording deletion failure should not fail the org by default.

Reason:

- A single S3 permission/object error should not block other expired recordings.
- The result includes `recordingDeleteFailures`.
- Rows remain eligible for next tick.

Org-level failure should still occur for:

- DB query failure.
- config/programming error.
- final aggregate audit insert failure.
- storage adapter not configured at worker boot.

---

## 8. Storage Adapter in Worker

Step 3 added `recordingStoragePlugin` and `app.recordingStorage`.

Worker path must ensure the plugin is available in the Fastify app used by workers.

Inspect:

- `server/src/server.ts`
- `server/src/workers/index.ts`
- app/bootstrap file used for workers

If worker app uses the same server instance, no extra work.

If workers build a separate Fastify app, register `recordingStoragePlugin` there before creating the retention worker.

Test injection:

- Unit tests should decorate `app.recordingStorage` with a fake/local adapter before invoking `runRetentionForOrg`.
- Avoid S3 network in default tests.

---

## 9. Tests

### 9.1 Repository Tests

File:

```text
server/test/phase8_step5_call_recordings_retention_repo.test.mjs
```

Cases:

1. explicit `retention_delete_after <= now` is included even when uploaded_at is recent.
2. explicit `retention_delete_after > now` is excluded even when uploaded_at is old.
3. no explicit retention: `uploaded_at <= now - days` included.
4. no explicit retention: uploaded_at inside window excluded.
5. `upload_pending`, `processing`, `delete_pending`, `deleted`, tombstoned excluded from normal candidates.
6. `delete_pending` older than retry cutoff included in retry helper.
7. recent `delete_pending` excluded from retry helper.
8. bare pool sees zero rows or helper inside no GUC returns zero/throws safely according to existing RLS pattern.
9. cross-org candidate rows invisible under other org context.

### 9.2 Service Tests

File:

```text
server/test/phase8_step5_recording_retention_service.test.mjs
```

Use local/fake recording storage adapter.

Cases:

1. expired available recording: adapter.deleteObject called, row becomes `deleted`, list hides it.
2. expired failed recording: object delete called, row becomes `deleted`.
3. non-expired recording remains untouched.
4. explicit `retention_delete_after` triggers deletion independently of uploaded_at.
5. `storage_object_not_found` counts as success and tombstones row.
6. storage failure leaves row eligible and increments failure count.
7. `delete_pending` older than retry cutoff is retried and tombstoned on success.
8. recent `delete_pending` is not retried.
9. audit row `retention.recordings_deleted` is created only when count > 0.
10. audit payload omits object key, bucket, recording ids, call ids, checksums, signed URLs, raw errors.
11. per-recording storage failure does not prevent other recordings in same org from being deleted.
12. cross-org isolation: Acme sweep does not delete Beta recordings.
13. disabled config returns skipped/no-op through `runRetentionTick`.
14. result aggregates flow through `runRetentionTick`.

### 9.3 Worker Tests

Update:

```text
server/test/phase7_step4_retention_worker.test.mjs
```

or add:

```text
server/test/phase8_step5_retention_worker.test.mjs
```

Cases:

1. processor disabled result includes recording fields as zero.
2. enabled processor logs aggregate recording counts and returns them.
3. deterministic now boundary: recording inside window survives first tick, expires after now moves beyond cutoff.

### 9.4 Existing Tests To Update

Current Phase 7 retention tests expect result object shape. Update assertions to include new zero fields where needed.

Run:

```powershell
npx tsx --test --test-concurrency=1 server/test/phase7_step4_retention_service.test.mjs
npx tsx --test --test-concurrency=1 server/test/phase7_step4_retention_worker.test.mjs
npx tsx --test --test-concurrency=1 server/test/phase8_step5_recording_retention_service.test.mjs
```

---

## 10. Implementation Order

### Commit 1 - Audit Action Migration

Files:

- `server/migrations/1715000030000_phase8_recording_retention_audit_action.sql`
- `server/src/repositories/activityLog.ts`

Validation:

```powershell
npm --prefix server run db:migrate:up
npm --prefix server run typecheck
```

### Commit 2 - Repository Helpers

Files:

- `server/src/repositories/callRecordings.ts`
- repository tests

Validation:

```powershell
npx tsx --test --test-concurrency=1 server/test/phase8_step5_call_recordings_retention_repo.test.mjs
```

### Commit 3 - Retention Service Integration

Files:

- `server/src/services/retention.ts`
- `server/src/workers/retentionSweep.worker.ts` if result/log changes require it
- service tests

Validation:

```powershell
npm --prefix server run typecheck
npx tsx --test --test-concurrency=1 server/test/phase7_step4_retention_service.test.mjs
npx tsx --test --test-concurrency=1 server/test/phase8_step5_recording_retention_service.test.mjs
```

### Commit 4 - Worker / Bootstrap

Files:

- worker app bootstrap if `recordingStoragePlugin` is not registered there
- worker tests

Validation:

```powershell
npx tsx --test --test-concurrency=1 server/test/phase7_step4_retention_worker.test.mjs
npx tsx --test --test-concurrency=1 server/test/phase8_step5_retention_worker.test.mjs
```

### Commit 5 - Findings / Master

Files:

- `docs/plan/phase-8/PHASE_8_STEP_5_FINDINGS.md`
- `docs/plan/phase-8/PHASE_8_MASTER.md`

Validation:

```powershell
npm --prefix server run typecheck
npm --prefix server test
node test/sync_shared_types.mjs
git diff --check
```

---

## 11. Validation Gates

Required before Step 5 closeout:

```powershell
npm --prefix server run db:migrate:up
npm --prefix server run typecheck
npx tsx --test --test-concurrency=1 server/test/phase8_step5_call_recordings_retention_repo.test.mjs
npx tsx --test --test-concurrency=1 server/test/phase8_step5_recording_retention_service.test.mjs
npx tsx --test --test-concurrency=1 server/test/phase7_step4_retention_service.test.mjs
npx tsx --test --test-concurrency=1 server/test/phase7_step4_retention_worker.test.mjs
npm --prefix server test
node test/sync_shared_types.mjs
git diff --check
```

Optional integration:

- MinIO smoke with explicit opt-in env only. Do not make it part of default test suite.

---

## 12. Security Checklist

- [ ] recording retention action has dedicated migration and TS union lockstep.
- [ ] worker uses `app.withOrgContext` for every org-scoped DB operation.
- [ ] object storage delete does not run inside long DB transaction.
- [ ] object key is passed to adapter only, not logged/audited.
- [ ] bucket/provider/endpoint/credentials are not logged/audited.
- [ ] signed URLs are never generated by retention worker.
- [ ] raw storage SDK errors are mapped/sanitized before logs/results.
- [ ] audit payload is aggregate-only.
- [ ] audit payload contains no recording id list or call id list.
- [ ] object-not-found is idempotent success.
- [ ] storage failures leave rows retryable.
- [ ] cross-org rows are not visible/deleted in another org context.
- [ ] `KLOSER_RETENTION_ENABLED=false` still no-ops.

---

## 13. Completion Checklist

- [ ] `retention.recordings_deleted` migration added and applied.
- [ ] `ActivityAction` union updated.
- [ ] retention config has recording days/batch/retry settings.
- [ ] candidate helper uses separate explicit and uploaded cutoffs.
- [ ] delete_pending retry helper exists.
- [ ] retention service deletes expired recording objects.
- [ ] retention service tombstones metadata with `markDeletedInCurrentOrg`.
- [ ] object-not-found is counted and tombstoned.
- [ ] storage failure leaves row retryable and does not block other rows.
- [ ] aggregate audit row exists and is sanitized.
- [ ] worker/tick result includes recording counters.
- [ ] disabled processor returns recording counters as zero.
- [ ] default tests make no network calls.
- [ ] targeted Step 5 tests pass.
- [ ] full server test passes.
- [ ] `PHASE_8_STEP_5_FINDINGS.md` written.
- [ ] `PHASE_8_MASTER.md` Step 5 checked only after verification.

---

## 14. Codex Review Focus

1. The single-cutoff retention helper must not survive unchanged if Step 5 claims explicit retention correctness.
2. No object storage call should be made inside the existing long per-org transcript/email transaction.
3. `delete_pending` retry must be separate from normal 90-day expiry.
4. The worker must not log object keys or provider secrets on storage errors.
5. Audit must be aggregate-only and sanitizer-safe.
6. Object-not-found must be idempotent success.
7. Storage failure must not tombstone metadata.
8. Cross-org isolation must be proven with tests.
9. Existing transcript/email retention behavior must not regress.
10. The recording storage plugin/decorator must exist in the worker runtime path.

---

## 15. One-Line Handoff

Implement Step 5 by extending the Phase 7 retention worker with recording-specific config, corrected candidate selection, object delete + metadata tombstone, delete_pending retry, aggregate `retention.recordings_deleted` audit, and network-free service/worker tests, without changing frontend or route contracts.

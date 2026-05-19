# Phase 8 Step 5 Findings - Retention Worker Integration

작성일: 2026-05-19

상위 문서: `PHASE_8_MASTER.md`
계획 문서: `PHASE_8_STEP_5_PLAN.md`
선행 결과: `PHASE_8_STEP_4_FINDINGS.md`, `docs/plan/phase-7/PHASE_7_STEP_4_FINDINGS.md`

---

## 1. 결과 요약

Phase 8 Step 5는 retention worker에 call recording sweep을 연결했다. backend route/schema/storage 계약과 frontend는 모두 미변경.

신규:

- `server/migrations/1715000030000_phase8_recording_retention_audit_action.sql`
- `server/test/phase8_step5_call_recordings_retention_repo.test.mjs` — 9 case
- `server/test/phase8_step5_recording_retention_service.test.mjs` — 12 case

수정:

- `server/src/repositories/activityLog.ts` — `ActivityAction` union에 `retention.recordings_deleted` lockstep
- `server/src/repositories/callRecordings.ts` — `listRetentionCandidatesInCurrentOrg` 단일 cutoff → two-cutoff input; `listDeletePendingRetryCandidatesInCurrentOrg` 신규
- `server/src/services/retention.ts` — `RetentionConfig`에 recording 필드 3종, `RetentionOrgResult`/`RetentionTickResult`에 recording counter 5종/3종, `runRecordingRetentionForOrg` 신규, `runRetentionForOrg` 흐름 분리
- `server/src/workers/index.ts` — worker bootstrap에 `recordingStoragePlugin` 등록
- `server/src/workers/retentionSweep.worker.ts` — disabled processor result + log line에 recording aggregate 추가
- `server/test/phase8_step2_call_recordings_repo.test.mjs` — 기존 Step 2 case가 새 signature를 쓰도록 갱신
- `server/test/phase7_step4_retention_service.test.mjs` — config에 recording 필드, local recording storage adapter 주입, cleanup
- `server/test/phase7_step4_retention_worker.test.mjs` — 동일 갱신

문서:

- `docs/plan/phase-8/PHASE_8_STEP_5_FINDINGS.md` (이 문서)
- `docs/plan/phase-8/PHASE_8_MASTER.md` (Step 5 체크 + Next-up Closeout)

---

## 2. Audit Action

migration `1715000030000_phase8_recording_retention_audit_action.sql`:

- `activity_log_action_check`를 DROP + recreate해서 `retention.recordings_deleted` 1종 추가. 기존 51개 action + 신규 = 52개.
- target_type CHECK는 미변경. recording retention 이벤트는 `target_type='organization'`, `target_id=orgId` (transcript retention과 동일 패턴).
- DOWN은 이전 51개 allow-list로 복원. 새 action으로 작성된 row가 있으면 revert 시 ADD CONSTRAINT가 실패하므로 운영자가 정리.
- 헤더 코멘트에서 `down migration` 문구 회피 (`node-pg-migrate` splitter 함정, Step 3 findings §11.7).

`ActivityAction` union에 lockstep으로 `retention.recordings_deleted` 추가.

---

## 3. Repository

### 3.1 `listRetentionCandidatesInCurrentOrg` two-cutoff input

```ts
export interface CallRecordingRetentionCandidateInput {
  explicitCutoff: Date;
  uploadedBefore: Date;
  limit: number;
}
```

쿼리:

```sql
WHERE deleted_at IS NULL
  AND status IN ('uploaded','available','failed')
  AND (
    (retention_delete_after IS NOT NULL AND retention_delete_after <= explicitCutoff)
    OR
    (retention_delete_after IS NULL AND uploaded_at IS NOT NULL AND uploaded_at <= uploadedBefore)
  )
ORDER BY COALESCE(retention_delete_after, uploaded_at) ASC, id ASC
LIMIT $3
```

- `explicitCutoff` (보통 `now`)는 명시적 per-row override를 가진 row에만 적용.
- `uploadedBefore` (보통 `now - recordingRetentionDays`)는 override 없는 row에만 적용.
- 단일 cutoff를 쓰면 explicit override가 90일 지연되거나 freshly-uploaded row가 즉시 만료되는 문제가 있었다 (Plan §1).
- 입력 유효성 검사: 둘 다 `Date`이고 not NaN, `limit` 양의 정수.

### 3.2 `listDeletePendingRetryCandidatesInCurrentOrg` 신규

```sql
WHERE deleted_at IS NULL
  AND status = 'delete_pending'
  AND updated_at <= olderThan
ORDER BY updated_at ASC, id ASC
LIMIT $2
```

- user route DELETE가 `markDeletePending` 후 `adapter.deleteObject` 호출에서 실패하면 row가 `delete_pending`에 머문다. 다음 retention tick이 이 helper로 후보를 잡아 재시도.
- `olderThan` (보통 `now - recordingDeletePendingRetryAfterSec`) — in-flight user delete를 한 tick 안에 race하지 않도록 floor.

### 3.3 Step 2 회귀 케이스

기존 Step 2 repo 테스트의 단일-cutoff signature 호출을 `{ explicitCutoff, uploadedBefore, limit }`로 갱신. 15/15 PASS 유지.

---

## 4. Retention Config

`RetentionConfig`에 3 필드 추가:

| Field | Env | Default | Range |
|---|---|---:|---|
| `recordingRetentionDays` | `KLOSER_RETENTION_RECORDING_DAYS` | 90 | 1..36500 |
| `recordingBatchSize` | `KLOSER_RETENTION_RECORDING_BATCH_SIZE` | 100 | 1..1000 |
| `recordingDeletePendingRetryAfterSec` | `KLOSER_RETENTION_RECORDING_DELETE_PENDING_RETRY_AFTER_SEC` | 900 | 60..86400 |

- `KLOSER_RETENTION_ENABLED` 마스터 게이트는 그대로. recording sweep도 disabled이면 no-op.
- `maxBatchesPerOrg`는 transcript / recording 공용. recording 배치는 별도 batch size로 더 작게 잡아 object storage HTTP latency를 흡수.

---

## 5. Service Flow

### 5.1 `runRetentionForOrg` 분리

이전: transcript + email recovery + audit를 모두 하나의 긴 `app.withOrgContext` transaction에서 실행.

변경: 같은 long transaction을 transcript + email에 유지하되, recording sweep은 **외부**에서 `runRecordingRetentionForOrg`로 실행. 이유:

- recording delete는 row마다 외부 object storage HTTP call이 발생.
- DB transaction을 잡은 채 외부 IO를 하면 connection occupancy + lock duration 둘 다 악화.
- transcript/email 결과는 commit된 뒤에 recording sweep이 돌고, 각 recording delete 후 짧은 per-row tx에서 `markDeletedInCurrentOrg`로 tombstone.

`RetentionOrgResult`는 두 결과를 합쳐 반환.

### 5.2 `runRecordingRetentionForOrg`

알고리즘:

1. `explicitCutoff = now`, `uploadedBefore = now - recordingRetentionDays * day`, `deletePendingOlderThan = now - recordingDeletePendingRetryAfterSec * sec` 계산.
2. `for batch < maxBatchesPerOrg`:
   - 단일 짧은 org tx에서 normal candidates + delete_pending retry candidates를 동시 조회 (총 `recordingBatchSize` capacity).
   - 둘 다 비면 break.
   - 각 row에 대해:
     - `failedThisTick` Set에 있으면 skip (같은 tick 안에서 같은 row를 재시도해 counter inflation 막음).
     - `adapter.deleteObject({ bucket, objectKey, objectVersion })`.
     - `storage_object_not_found` → idempotent success.
     - 그 외 RecordingStorageOperationError → `recordingDeleteFailures++`, `failedThisTick.add(id)`, continue.
     - 성공 → 짧은 org tx에서 `markDeletedInCurrentOrg(id, now)`. row가 이미 tombstoned이거나 markDeleted가 null이어도 storage outcome으로 count.
   - batch에서 successful tombstone이 0이면 outer loop break (모든 row가 실패 중인 상태로 무한 시도 방지).
3. `recordingsDeleted > 0 || recordingDeleteFailures > 0`이면 마지막에 한 번 org tx에서 aggregate audit row 작성.

### 5.3 Aggregate Audit Payload

```json
{
  "actor_type": "system",
  "cutoff": "2026-05-19T...",
  "uploaded_before": "2026-02-18T...",
  "retention_days": 90,
  "deleted_count": 3,
  "object_not_found_count": 1,
  "failed_count": 0,
  "delete_pending_retried_count": 0,
  "batch_size": 100,
  "batches": 1,
  "storage_provider_counts": { "local": 3, "s3": 0, "minio": 0 }
}
```

**미포함 (강제)**:

- `recording_id` / `recording_ids` / `call_id` / `call_ids`
- `object_key` / `storage_bucket` / per-row `storage_provider`
- signed URL / checksum / object_version / provider endpoint
- access key / secret / raw SDK error message
- raw audio bytes

테스트가 row id, object_key 같은 식별 가능한 값들을 JSON 본문 substring으로 검사해 강제.

### 5.4 Failure Isolation

- 단일 recording delete 실패는 org의 다른 recording 처리를 막지 않는다. 같은 row는 다음 tick에서 재시도.
- transcript/email tx가 commit된 후 recording sweep이 throw하면 org-level failure로 surface 가능. 현재 구현은 storage_object_not_found가 아닌 RecordingStorageOperationError를 catch해서 counter만 증가시킨다. 그 외 throw (예: `runRecordingRetentionForOrg` 내부 DB 실패 등)는 `runRetentionForOrg`에서 throw로 전파되어 `runRetentionTick`이 `failedOrgs`로 잡는다.
- `app.recordingStorage`가 없으면 `runRecordingRetentionForOrg`가 throw — boot 시점에 plugin이 등록돼야 한다는 invariant.

---

## 6. Worker Integration

### 6.1 Bootstrap

`server/src/workers/index.ts`:

```ts
import recordingStoragePlugin from "../plugins/recordingStorage.js";
...
await app.register(dbPlugin);
await app.register(recordingStoragePlugin); // Phase 8 Step 5
```

- worker가 시작할 때 `RECORDING_STORAGE_PROVIDER` env에 따라 adapter 결정.
- production에서 provider 미설정 또는 s3/minio env 누락 시 boot fail-fast (Step 3에서 이미 정의된 정책).

### 6.2 Result Shapes

```ts
export interface RetentionOrgResult {
  ...
  recordingsDeleted: number;
  recordingBatches: number;
  recordingObjectNotFound: number;
  recordingDeleteFailures: number;
  recordingDeletePendingRetried: number;
}

export interface RetentionTickResult {
  ...
  recordingsDeleted: number;
  recordingObjectNotFound: number;
  recordingDeleteFailures: number;
  ...
}
```

disabled processor는 모든 recording counter를 0으로 반환.

### 6.3 Worker Log

```
[retention-sweep] orgs=N transcriptsDeleted=N emailRecovered=N recordingsDeleted=N recordingObjectNotFound=N recordingDeleteFailures=N failedOrgs=N
```

aggregate-only. object key / recording id / signed URL / raw storage error body 없음.

---

## 7. Tests

### 7.1 `phase8_step5_call_recordings_retention_repo.test.mjs` — 9 cases

| # | Case |
|---|---|
| 1 | explicit retention_delete_after <= explicitCutoff은 uploaded_at이 recent여도 included |
| 2 | explicit retention_delete_after > explicitCutoff은 uploaded_at이 ancient여도 excluded |
| 3 | no explicit retention: uploaded_at <= uploadedBefore included |
| 4 | no explicit retention: uploaded_at within window excluded |
| 5 | upload_pending / processing / delete_pending / deleted / tombstoned excluded |
| 6 | delete_pending older than olderThan included by retry helper |
| 7 | recent delete_pending excluded |
| 8 | cross-org isolation (Beta context cannot see Acme candidates) |
| 9 | input validation (invalid Date / non-positive limit) |

`touch_updated_at` 트리거가 매 UPDATE마다 updated_at을 now()로 덮어쓰는 제약을 회피하기 위해 retry 테스트는 두 row를 시간차로 생성한 뒤 중간 cutoff로 분리.

### 7.2 `phase8_step5_recording_retention_service.test.mjs` — 12 cases

`FakeRecordingStorage` (in-memory; deleted 배열만 기록; behavior callback으로 not_found / 임의 에러 주입) 으로 network 없음.

| # | Case |
|---|---|
| 1 | expired available recording → object delete + row tombstoned |
| 2 | non-expired recording untouched |
| 3 | explicit retention_delete_after triggers deletion independently |
| 4 | storage_object_not_found counts as success and tombstones |
| 5 | storage failure leaves the failing row, does not block siblings, counter=1 not N |
| 6 | storage provider mismatch is reported as aggregate failure without adapter delete or tombstone |
| 7 | delete_pending older than retry cutoff is retried and tombstoned |
| 8 | aggregate audit row written, payload omits recording id / object key / bucket / signed URL / checksum / raw error |
| 9 | cross-org isolation (Acme sweep does NOT touch Beta rows) |
| 10 | disabled config: runRetentionTick no-op with recording counters all 0 |
| 11 | runRetentionForOrg returns merged transcript+recording counters |
| 12 | audit NOT written when nothing happened (count=0 short-circuit) |

### 7.3 Phase 7 retention 회귀

`phase7_step4_retention_service.test.mjs` + `phase7_step4_retention_worker.test.mjs` 모두 갱신:

- 테스트 app에 `createLocalRecordingStorageAdapter` (temp dir)로 `app.recordingStorage` decorate.
- `enabledConfig` factory에 recording 3 필드 추가 (`recordingRetentionDays: 90`, `recordingBatchSize: 100`, `recordingDeletePendingRetryAfterSec: 900`).
- after-hook에 temp dir cleanup 추가.
- 14/14 PASS 유지.

---

## 8. Verification 결과

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

결과:

- db:migrate:up: PASS (1715000030000 적용, CHECK constraint에 `retention.recordings_deleted` 확인됨)
- typecheck: PASS
- Step 5 repo tests: 9/9 PASS
- Step 5 service tests: 12/12 PASS
- Phase 7 retention service tests: 11/11 PASS (recording 필드 추가 후)
- Phase 7 retention worker tests: 3/3 PASS
- full server test: **852 total / 849 PASS / 3 skipped / 0 fail** (Step 4 closeout 831 → 21 case 추가)
- sync_shared_types: PASS, registry 변경 없음
- git diff --check: PASS (LF/CRLF 사전 경고 5건만, Windows 환경 정상)

---

## 9. Not Implemented (계획대로)

- frontend (`platform/*`) 수정
- recording REST route / shared type 변경
- waveform / transcoding / transcript-audio alignment
- MinIO 실제 통합 smoke (opt-in only)
- atomic claim helper (`claimRetentionCandidatesInCurrentOrg`) — Step 5 plan §5.3에 명시한 대로 단순 idempotent 흐름 유지

---

## 10. Decisions

### 10.1 markDeleted, not hardDelete

Plan §6 권장대로 tombstone 유지. 이유: audit 가시성, future compaction 단계로 분리, listByCall은 이미 tombstone을 숨김.

### 10.2 Two cutoffs not one

Plan §1의 "Critical Correction" 정확히 반영. 단일 cutoff는 explicit override를 90일 지연 또는 갓 업로드된 row를 즉시 만료시키는 부정합.

### 10.3 Recording sweep outside the long transaction

object storage HTTP call을 DB transaction 안에서 하면 connection lock duration이 외부 latency만큼 늘어남. transcript/email tx가 commit된 뒤 recording sweep을 돌리고, per-row 짧은 tx에서 tombstone.

### 10.4 `failedThisTick` Set + batch-success break

같은 tick 안에서 영구적으로 실패하는 row를 재시도하면 `recordingDeleteFailures`가 부풀고 adapter call이 낭비된다. Set으로 추적해 한 tick에 한 row 한 번만 시도. + 모든 batch가 0 successful이면 outer loop break.

### 10.5 No claim helper (de-duplication)

Plan §5.3가 acceptable로 명시한 단순 idempotent 흐름 유지. 두 worker가 같은 row를 동시에 잡아도 `markDeletedInCurrentOrg`가 idempotent이고, `storage_object_not_found`도 idempotent success로 처리되므로 안전.

### 10.6 Aggregate audit only when count > 0

Plan §3 권장 그대로. `deleted_count > 0 || failed_count > 0`일 때만 audit row 1개. 0/0이면 noise 방지.

### 10.7 Storage provider counts as aggregate map

`storage_provider_counts: { local, s3, minio }` 형태로 mix-provider org에서 정책 변경 영향 가시화. 개별 row의 provider는 노출하지 않음.

---

## 11. Risks / Follow-ups

- **MinIO/S3 real smoke 미실행**: opt-in 통합 테스트 (`KLOSER_RECORDING_S3_INTEGRATION`) 시나리오 부재. production deploy 전에 한 번은 실제 provider로 검증 권장.
- **delete_pending 누적 가능성**: storage 영구 실패 시 (예: bucket 권한 영구 박탈) row가 영원히 `delete_pending`에 남는다. 운영 정책상 일정 횟수 이상 retry 실패한 row를 dead-letter 상태로 옮기는 mechanism은 별도 step에서 검토.
- **audit 실패 시 metadata는 이미 deleted**: per-row tombstone과 aggregate audit가 완전히 atomic하지 않다. 매우 드물지만 audit insert가 실패해도 object/row deletion은 commit된 채 남는다. Plan §7.3 trade-off 인지 + 다음 tick은 이미 tombstoned된 row를 재처리하지 않으므로 단순 반복 안전.
- **transcript/email tx commit 후 recording throw**: org-level failure로 surface된다. `failedOrgs`에 잡힌다. transcript/email 일은 이미 commit. 의도된 부분 진행 (정책 결정).
- **Phase 7 retention service에서 transcript 멤버 transcriptBatches가 빠짐**: 기존 Step 4 API 변경 회피 — `RetentionOrgResult.transcriptBatches`는 유지되는 필드. 단 새로운 recordingBatches와 의미가 비슷. 통합 가능성은 product 결정.

---

## 12. Phase 8 closeout 준비

Step 1~5 모두 완료. closeout 시점에 필요한 항목:

- Phase 8 closeout findings (전체 step 요약 + Go/No-Go 게이트)
- README 갱신 (Phase 8 완료 표기 + Step 5 노트 추가)
- USER_GUIDE_PHASE_8 (recording surface + retention 정책)
- full validation 재실행 (typecheck + sync types + full test + git diff)
- pending product/legal decisions: legal consent workflow, multi-recording UX, retention dead-letter 정책

Phase 8 v1 backend가 닫혔으므로 closeout 단계는 documentation-heavy. retention worker가 실제로 production에서 1 tick을 돌고 audit row가 남는 것까지 보면 v1 sanity check 완료.

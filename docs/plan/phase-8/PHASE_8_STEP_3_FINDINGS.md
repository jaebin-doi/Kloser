# Phase 8 Step 3 Findings - Upload / Finalize / Playback Routes

작성일: 2026-05-19

상위 문서: `PHASE_8_MASTER.md`
계획 문서: `PHASE_8_STEP_3_PLAN.md`
선행 결과: `PHASE_8_STEP_2_FINDINGS.md`

---

## 1. 결과 요약

Phase 8 Step 3은 다음을 닫았다.

1. `activity_log.action` allow-list에 recording.* 5종 추가 + `ActivityAction` TS union lockstep + service helper 5종.
2. `CallRecording` REST 표면 shared types(server zod + browser JSDoc) + `sync_shared_types` registry.
3. `S3CompatibleSentinelAdapter`를 `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` 기반 실제 adapter로 교체. sentinel은 opt-in factory로만 유지.
4. `server/src/plugins/recordingStorage.ts` Fastify decorator (test injection 지원).
5. `server/src/services/callRecordings.ts` service glue — repository + adapter + permission + audit + sanitized response 매핑.
6. `server/src/routes/callRecordings.ts` 5개 endpoint + route-scoped error handler.
7. route tests 21건 + audit hooks tests 5건. local storage adapter는 temp dir 사용, network call 0.

신규 코드:

- `server/migrations/1715000029000_phase8_recording_activity_actions.sql`
- `server/src/types/callRecording.ts`
- `platform/types/callRecording.js`
- `server/src/plugins/recordingStorage.ts`
- `server/src/services/callRecordings.ts`
- `server/src/routes/callRecordings.ts`
- `server/test/phase8_step3_recording_routes.test.mjs`
- `server/test/phase8_step3_recording_audit_hooks.test.mjs`

수정:

- `server/src/repositories/activityLog.ts` — ActivityAction union 확장
- `server/src/services/activityLog.ts` — 5종 recording helper 추가
- `server/src/adapters/recordingStorage.ts` — S3 실 SDK adapter + mapS3Error scrub
- `server/src/server.ts` — recordingStoragePlugin + callRecordingsRoutes 등록
- `test/sync_shared_types.mjs` — `callRecording` entity registry
- `server/test/phase8_step2_recording_storage.test.mjs` — sentinel assertion → 실 SDK presigner 검증
- `server/package.json` / `server/package-lock.json` — `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` 의존성 추가

문서:

- `docs/plan/phase-8/PHASE_8_STEP_3_FINDINGS.md` (이 문서)
- `docs/plan/phase-8/PHASE_8_MASTER.md` (Step 3 체크박스 + Next-up)

---

## 2. Audit Action Allow-List

migration `1715000029000_phase8_recording_activity_actions.sql`:

- 기존 `activity_log_action_check` DROP 후 5종 추가하여 재생성.
- target_type은 확장하지 않음. recording.* 이벤트는 `target_type='call'` + `target_id=call.id`, recording id는 payload.recording_id로 전달.
- DOWN 마이그레이션은 이전 allow-list로 복원. recording.* 행이 이미 존재하면 DOWN의 ADD CONSTRAINT가 실패하므로 운영자가 행 제거 또는 보존 여부 결정.

migration splitter 함정 1건 발견 후 회피:

- `node-pg-migrate`의 SQL splitter regex `^\s*--[\s-]*${direction}\s+migration` (i, m 플래그)는 헤더 코멘트의 `-- DOWN migration restores ...`도 매치한다.
- 결과적으로 `downMigrationStart`가 헤더 위치를 가리키게 되어, UP 섹션이 UP+DOWN 전체로 묶이고 DOWN의 ADD CONSTRAINT가 마지막에 적용되면서 새 actions가 사라졌다.
- 해결: 헤더에서 `down migration` 문구를 회피하고, 그 함정을 명시적으로 주석에 적었다.

`ActivityAction` union (`server/src/repositories/activityLog.ts`)에 다음 5종 추가:

- `recording.upload_initiated`
- `recording.finalized`
- `recording.playback_url_issued`
- `recording.delete_requested`
- `recording.deleted`

`services/activityLog.ts`에 동일 이름의 helper 5종. 모든 helper는 `recordActivity`(app pool)을 사용. `tryRecordActivity`는 사용하지 않음 — recording 이벤트는 mutation 흐름에 직접 묶이므로 audit 실패 시 mutation 자체를 롤백한다.

payload allow-list (`recording_id`, `content_type`, `size_bytes`, `duration_seconds`, `ttl_seconds`, `previous_status`)는 sanitizer의 FORBIDDEN_KEY_TOKENS 집합과 충돌하지 않는다. object_key / storage_bucket / signed URL / checksum_sha256 / raw audio는 service에서도 helper에 전달하지 않는다.

---

## 3. Shared Types

`server/src/types/callRecording.ts`:

- `CallRecordingStatus`, `RecordingContentType` z.enum
- `CallRecording` (응답 entity — internal storage 필드 미노출)
- `CallRecordingUploadInput`, `CallRecordingFinalizeInput` (요청 body)
- `SignedRecordingUrl` (PUT / GET 공용)
- `CallRecordingUploadResponse`, `CallRecordingFinalizeResponse`, `CallRecordingListResponse`, `CallRecordingPlaybackUrlResponse`

응답에서 의도적으로 노출하지 않는 필드:

- `org_id`, `storage_provider`, `storage_bucket`, `object_key`, `object_version`, `checksum_sha256`, `metadata`

이유: object storage locator/config는 내부 정보이며, frontend가 알 필요 없다. checksum과 metadata는 운영용. org_id는 redundant (auth가 이미 강제).

`platform/types/callRecording.js` JSDoc mirror + `test/sync_shared_types.mjs` registry entry 추가. SignedRecordingUrl은 nested object이지만 top-level z.object로 선언해야 sync 파서가 field 집합을 비교할 수 있어 ActivityLogCursor 패턴 그대로 따랐다.

---

## 4. S3-Compatible Real Adapter

`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` 의존성을 서버에만 추가 (48 패키지). 기본 테스트는 여전히 network call 없음:

- `createUploadUrl` / `createReadUrl` — 순수 HMAC-SHA256 서명. SDK는 network에 접속하지 않고 URL을 생성한다.
- `putObject` / `deleteObject` — 실제 S3에 HTTP 요청. Step 3 route 테스트는 local adapter만 사용하므로 호출되지 않는다.

신규 클래스: `S3CompatibleRecordingStorageAdapter` — `PutObjectCommand` / `GetObjectCommand` / `DeleteObjectCommand` + `getSignedUrl`.

error scrub: `mapS3Error(err, operation)` SDK error.name → 안정적 code 매핑.

- `NoSuchKey` / `NotFound` → `storage_object_not_found`
- `AccessDenied` / `Forbidden` → `storage_forbidden`
- `NoSuchBucket` → `storage_bucket_missing`
- 그 외 → `storage_upstream`

SDK message는 caller에 노출하지 않는다 (bucket/key를 포함할 수 있음).

기존 sentinel (`S3CompatibleSentinelAdapter`)는 `createS3CompatibleSentinelAdapter` factory로 보존. 빌드 파이프라인 등 network 권한이 없는 환경에서 명시적으로 사용 가능.

`forcePathStyle` 기본값은 minio=true, s3=false. env override 가능. `RECORDING_STORAGE_SESSION_TOKEN`이 있으면 임시 자격 증명 path도 동작.

---

## 5. Fastify Plugin (`recordingStoragePlugin`)

`server/src/plugins/recordingStorage.ts`:

- Server boot 시 `resolveRecordingStorageAdapter()`로 한 번만 instantiation → `app.recordingStorage` decorator.
- 이미 decorator가 존재하면 skip — tests에서 `app.decorate("recordingStorage", localAdapter)`로 inject 후 plugin 등록 안 하면 그대로 local adapter 사용.
- Boot fail-fast 정책 유지 (production에서 provider 미설정 또는 s3/minio env 누락 시 throw, server 시작 실패).

`server/src/server.ts`에 `dbPlugin` 다음에 등록, route 등록 전에 위치.

---

## 6. Service (`services/callRecordings.ts`)

5개의 export:

| Function | Behavior |
|---|---|
| `initiateRecordingUpload(app, actor, callId, input)` | size cap 검증 → withOrgContext → call lock → assertCanMutateCall → repo insert(upload_pending) → audit → adapter.createUploadUrl → 응답 |
| `finalizeRecordingUpload(app, actor, callId, recordingId, input)` | size cap → withOrgContext → call lock + perm → recording lock → call_id 일치 + state 검증 → repo markUploaded → markAvailable (v1) → audit |
| `listCallRecordings(app, actorOrgId, callId)` | withOrgContext → listByCallInCurrentOrg. null → 404, 빈 배열은 OK |
| `createRecordingPlaybackUrl(app, actorOrgId, actorUserId, callId, recordingId)` | call read → getActive recording → status='available' 검증 → audit → adapter.createReadUrl |
| `deleteRecording(app, actor, callId, recordingId)` | 2-phase: tx1(markDeletePending + audit) → adapter.deleteObject (ENOENT는 idempotent 성공) → tx2(markDeleted + audit) |

서비스 errors:

- `RecordingNotFoundError` → 404 not_found
- `RecordingInvalidStateError(currentStatus)` → 409 invalid_recording_state (current_status echo)
- `RecordingTooLargeError(attempted, limit)` → 413 recording_too_large

`PermissionError` (callPermissions.ts) → 403 forbidden.
`RecordingStorageOperationError(code='storage_object_not_found')` → 404. 그 외 → 502 recording_storage_failed.
`RecordingStorageConfigError` → 503 recording_storage_unavailable (방어용 — plugin이 boot에서 fail-fast함).
`RecordingStorageInputError` → 400 invalid_recording_input.
pg 23503/23505/23514/42501 매핑.

size cap default 250 MB, `RECORDING_UPLOAD_MAX_BYTES` env로 override 가능.

object key 생성은 server-known uuid만 사용 (`buildRecordingObjectKey`); request body가 key를 주입할 수 없다. Codex validation에서 이 계약을 더 조였다. 서비스가 만든 `recordingId`를 `call_recordings.id`로도 insert하고, route test는 signed upload URL 경로가 응답의 recording id와 같은 id를 쓰는지 검증한다. 따라서 DB row, audit payload, object key가 같은 recording id로 정렬된다.

`storage_bucket`은 service가 항상 `null`로 insert. S3 adapter 자체가 bucket을 client config에 보관하므로, DB의 `storage_bucket` 컬럼은 v1에서 빈 채로 둔다 (스키마는 이미 nullable). 미래에 multi-bucket per-tenant가 필요해지면 같은 컬럼을 채우면 된다.

---

## 7. Routes (`routes/callRecordings.ts`)

5 endpoints (모두 `/calls/:id` 하위에서 register):

| Method | Path | Pre-handler |
|---|---|---|
| POST | `/calls/:id/recordings/upload` | `requireAuth` + `orgContext` + `requireVerified` + `requireRole(admin/manager/employee)` + `requireFreshRole` |
| POST | `/calls/:id/recordings/:recordingId/finalize` | (writer mutation matrix) |
| GET | `/calls/:id/recordings` | `requireAuth` + `orgContext` (read) |
| GET | `/calls/:id/recordings/:recordingId/playback-url` | (read) |
| DELETE | `/calls/:id/recordings/:recordingId` | (writer mutation matrix) |

plugin-scoped `app.setErrorHandler` 1개로 zod/PermissionError/Recording*Error/RecordingStorage*Error/pg code 통일된 vocabulary로 변환.

`server/src/server.ts`에 `await app.register(callRecordingsRoutes);` 등록 (callsRoutes / callsPhase5Routes 뒤).

---

## 8. Tests

### 8.1 `server/test/phase8_step3_recording_routes.test.mjs` — 21 cases

| # | Case |
|---|---|
| 1 | POST upload without auth → 401 |
| 2 | admin upload → 201 + sanitized response (no object_key/bucket/provider) |
| 3 | viewer upload → 403 (employee membership 일시 demote) |
| 4 | employee upload on non-own call → 403 |
| 5 | employee upload on own call → 201 |
| 6 | admin upload against cross-org call id → 404 |
| 7 | invalid content_type → 400 invalid_input |
| 8 | invalid checksum_sha256 → 400 invalid_input |
| 9 | size_bytes over 250MB cap → 413 recording_too_large |
| 10 | finalize → 200 available, sanitized recording |
| 11 | finalize cross-org recording id → 404 |
| 12 | finalize recording whose call id path does not match → 404 |
| 13 | finalize already-available row → 409 invalid_recording_state |
| 14 | list same-org → 200, sanitized items |
| 15 | list cross-org → 404 |
| 16 | playback-url on upload_pending → 409 invalid_recording_state |
| 17 | playback-url on available → 200 signed GET URL, expires_at within TTL |
| 18 | playback-url cross-org → 404 |
| 19 | DELETE → 204, list hides tombstoned row |
| 20 | DELETE cross-org → 404 |
| 21 | DELETE already-deleted → 404 (consistent with call-action-items DELETE pattern) |

### 8.2 `server/test/phase8_step3_recording_audit_hooks.test.mjs` — 5 cases

| # | Case |
|---|---|
| 1 | recording.upload_initiated audit row carries recording_id/content_type/size_bytes/duration_seconds/ttl_seconds + no forbidden tokens |
| 2 | recording.finalized records same fields + omits checksum |
| 3 | recording.playback_url_issued carries ttl_seconds only, no URL |
| 4 | DELETE produces recording.delete_requested(previous_status) + recording.deleted, both sanitized |
| 5 | Acme audit rows invisible to Beta context (cross-org RLS) |

forbidden payload token list (JSON.stringify substring check): `object_key`, `storage_bucket`, `bucket`, `signed_url`, `playback_url`, `upload_url`, `checksum`, `object_version`, `provider_secret`, `access_key`, `secret_access_key`, 그리고 `http://localhost.invalid/recordings/` (URL이 직접 들어갔는지 sentinel).

테스트는 모두 local recording storage adapter (`mkdtemp` 임시 디렉터리)를 `app.decorate` 로 inject. network call 0.

---

## 9. Verification 결과

```powershell
npm --prefix server run db:migrate:up
npm --prefix server run typecheck
npx tsx --test --test-concurrency=1 server/test/phase8_step3_recording_routes.test.mjs
npx tsx --test --test-concurrency=1 server/test/phase8_step3_recording_audit_hooks.test.mjs
npm --prefix server test
node test/sync_shared_types.mjs
git diff --check
```

결과:

- db:migrate:up: PASS (1715000029000 적용 완료, CHECK constraint에 recording.* 5종 확인됨)
- typecheck: PASS
- route targeted tests: 21 / 21 PASS
- audit hooks targeted tests: 5 / 5 PASS
- full server test: **831 total / 828 PASS / 3 skipped / 0 fail** (Step 2 closeout 804 → 27 case 추가)
- sync_shared_types: PASS, `callRecording` registry entry OK
- git diff --check: PASS (LF/CRLF 경고 4건만, Windows 환경 정상)

---

## 10. Not Implemented (계획대로 미구현)

- `platform/calls.html` recording playback UI
- `platform/live.html` recording capture UI
- desktop/browser audio capture pipeline
- waveform rendering
- audio transcoding queue
- transcript/audio timestamp alignment
- retention worker recording 모듈 (Phase 8 Step 5)
- legal consent workflow
- public bucket / public object URL
- MinIO 통합 smoke (opt-in only, network 필요)

---

## 11. Decisions

### 11.1 S3 real adapter NOW (sentinel deferred 안 함)

plan §4.4 권장 path를 택함. 이유:
- route 표면이 signed URL의 첫 실 caller. sentinel 유지하면 production `RECORDING_STORAGE_PROVIDER=s3` 환경에서 그냥 깨진다.
- presigner는 network 없이 서명을 만든다 → 기본 테스트가 여전히 offline.
- 의존성 증가 ~48 패키지 vs. 실제 production unblock 가치 = 후자 우세.

### 11.2 target_type='call' (recording 새 type 안 만듦)

audit DB CHECK target_type 추가 부담을 피하고, 기존 `activity_log_org_target_created_idx` index가 그대로 사용된다. 사용자 가시 "녹취 X를 누가 손댔는가" 드릴다운은 (call_id, recording_id) 페어로도 충분히 가능.

### 11.3 finalize는 `uploaded` → `available` 자동 전환

v1에는 transcoding pipeline이 없다. 사용자 경험상 finalize 직후 playback이 가능해야 한다. 미래에 server-side 검증 / transcoding이 추가되면 `processing` step을 끼울 수 있다 (state guard가 `uploaded` → `processing` → `available` 모두 허용).

### 11.4 DELETE idempotency = 404 (not 204)

이미 tombstoned된 recording의 재DELETE는 404로 처리. 이유:
- `call_action_items` DELETE와 동일 contract.
- tombstone 이후에는 user-facing 표면에서 "사라진" 상태여야 하므로 두 번째 DELETE도 자연스럽게 "이미 없다"는 응답이 맞다.
- DB row 자체는 audit 보존을 위해 남아 있고, retention worker (Step 5)가 처리.

### 11.5 storage_bucket DB 컬럼은 v1에서 항상 NULL

S3Client가 bucket을 자체적으로 보관 (env 기반). DB에서 컬럼은 future-proof로만 두고 비워둔다. minio 다중 bucket per-tenant 또는 legal-hold 분리 bucket 정책이 들어올 때 이 컬럼이 채워질 것.

### 11.6 size cap default 250MB

env `RECORDING_UPLOAD_MAX_BYTES`로 override 가능. 4시간 mono opus ≈ 28MB이므로 9배 마진. runaway upload는 명확히 413으로 차단.

### 11.7 `node-pg-migrate` SQL splitter 함정

`-- DOWN migration restores...` 같이 헤더 코멘트에서 `down migration` 문구를 사용하면 migrate가 그 위치를 down section start로 인식해 UP/DOWN을 잘못 자른다. 같은 migration 파일에서 다시 안 들어가도록 회피 + 명시적 주석 추가.

---

## 12. Risks / Follow-ups

- **MinIO real integration smoke 부재**: opt-in 통합 테스트 (KLOSER_RECORDING_S3_INTEGRATION 같은 gate)가 없다. Step 5 retention 작업 또는 별도 ops 단계에서 한 번 돌려보는 게 안전.
- **storage delete 실패 시 recovery**: 현재 service는 storage_object_not_found는 idempotent로, 그 외는 502 throw. row는 `delete_pending` 상태로 남는다. Step 5 retention worker가 이 상태를 처리해야 한다 (object delete 재시도 + 최종 markDeleted).
- **manager same-team 테스트 부재**: seed에 manager 역할이 없어 manager same-team / other-team 케이스를 라우트 테스트에서 다루지 못함. seed에 manager 역할이 추가되거나 별도 fixture가 마련되면 retrofit 필요. assertCanMutateCall 단위 테스트 (Phase 5)는 이미 manager 분기를 검증.
- **playback URL audit**: 모든 GET playback-url 호출이 audit row를 만든다. 잦은 재생 시 noise가 될 수 있음. 첫 모니터링 후 sampling 정책을 도입할지 결정.

---

## 13. Next Step

Phase 8 Step 4 — frontend playback UI.

- `platform/calls.html` 또는 call detail panel에 recording status, player, download link, error state를 API-backed로 표시
- viewer/employee 권한은 backend 결과 기준 (sidebar-only hiding은 보안 경계가 아님)
- 모든 server-returned recording 필드는 `textContent` / escape 경로만 사용
- player는 signed URL을 매번 새로 받아 사용 (TTL 만료 시 자동 갱신)
- loading / no recording / processing / available / failed / deleted state 구분

retention worker (Phase 8 Step 5)는 Step 4 이후 또는 병렬로 진행 가능 — frontend와 무관.

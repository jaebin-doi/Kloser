# Phase 8 Step 2 Findings - Repository + Recording Storage Adapter Boundary

작성일: 2026-05-19

상위 문서: `PHASE_8_MASTER.md`
계획 문서: `PHASE_8_STEP_2_PLAN.md`
선행 결과: `PHASE_8_STEP_1_FINDINGS.md`

---

## 1. 결과 요약

Phase 8 Step 2는 repository + storage adapter boundary만 닫았다. route, shared type, frontend, retention worker connection은 손대지 않았다.

신규 코드:

- `server/src/repositories/callRecordings.ts`
- `server/src/adapters/recordingStorage.ts`
- `server/test/phase8_step2_call_recordings_repo.test.mjs`
- `server/test/phase8_step2_recording_storage.test.mjs`

문서:

- `docs/plan/phase-8/PHASE_8_STEP_2_FINDINGS.md` (이 문서)
- `docs/plan/phase-8/PHASE_8_MASTER.md` (Step 2 체크박스 + Next-up)

`server/package.json` / `package-lock.json`은 건드리지 않았다. 실제 S3-compatible SDK 의존성은 Step 3에서 라우트와 함께 들어가는 것이 자연스럽다 (이번 단계의 boundary는 SDK 없이도 닫을 수 있다는 사실 자체가 결정사항).

---

## 2. Repository (`server/src/repositories/callRecordings.ts`)

### 2.1 Types

- `CallRecording` row
- `CallRecordingStatus` (7개 lifecycle 값)
- `RecordingStorageProvider` (`local` / `s3` / `minio`)
- `RecordingContentType` (5개 audio MIME)
- `CallRecordingCreateInput` / `CallRecordingFinalizeInput` / `CallRecordingFailureInput`

`size_bytes`는 `bigint` 컬럼이지만 hydrate 단계에서 number로 parse. 모든 실 녹취 파일은 `Number.MAX_SAFE_INTEGER`(2^53) 안. Step 3 route는 필요시 string으로 다시 노출할 수 있다.

`metadata`는 항상 `Record<string, unknown>`. DB의 jsonb null은 hydrate에서 `{}`로 정규화.

### 2.2 Helpers (전부 `InCurrentOrg` suffix)

| Helper | 동작 |
|---|---|
| `insertUploadPendingInCurrentOrg(client, orgId, input)` | status=`upload_pending`. orgId는 RLS `WITH CHECK`가 다시 검증. body가 org_id 주입 불가 |
| `markUploadedInCurrentOrg(client, id, input)` | `upload_pending`/`failed` 만 → `uploaded`. finalize metadata는 `COALESCE` 패치, `uploaded_at`은 default now() |
| `markProcessingInCurrentOrg(client, id)` | `uploaded`/`processing` → `processing` (idempotent) |
| `markAvailableInCurrentOrg(client, id)` | `uploaded`/`processing`/`available` → `available` (idempotent) |
| `markFailedInCurrentOrg(client, id, input)` | `deleted` 제외 → `failed`. `error_message`는 raw 저장(호출자가 사전 scrub 책임) |
| `markDeletePendingInCurrentOrg(client, id)` | `deleted` 제외 → `delete_pending` (object 삭제 직전 표시) |
| `markDeletedInCurrentOrg(client, id, deletedAt)` | 아직 안 지워진 row → `deleted` + `deleted_at` 동시 (CHECK 충족) |
| `hardDeleteByIdInCurrentOrg(client, id)` | 메타데이터 row 자체 제거. retention worker 전용 |
| `getByIdInCurrentOrg(client, id)` | soft-deleted 포함 (audit) |
| `getActiveByIdInCurrentOrg(client, id)` | `deleted_at IS NULL` |
| `lockByIdInCurrentOrg(client, id)` | `FOR UPDATE` |
| `listByCallInCurrentOrg(client, callId)` | call이 same-org에 없으면 null, 있으면 active recordings 배열 (transcripts 패턴 동일) |
| `listAvailableByCallInCurrentOrg(client, callId)` | 동일 + `status='available'` 필터 |
| `listRetentionCandidatesInCurrentOrg(client, cutoff, limit)` | uploaded/available/failed AND `retention_delete_after<=cutoff` OR (`retention_delete_after IS NULL` AND `uploaded_at<=cutoff`). pending/deleted는 제외 |

### 2.3 정책

- 모든 helper는 caller가 `app.withOrgContext(orgId, fn)` 안에서 호출한다는 전제. SQL에 `org_id = ...` 중복 필터 안 함. RLS가 authority.
- read는 RLS, mutator는 not-found 시 `null` 반환. raw 22023/23514/23505/23503은 caller(service)가 4xx 매핑.
- `markUploaded`, `markProcessing`, `markAvailable`은 명시적 state guard (`WHERE status IN (...)`). 잘못된 상태에서 호출하면 row 미반환 → null.
- `error_message` 저장 시점에 sanitize 안 함. plan 문서에 `bucket / object key / signed URL / provider secret을 호출자가 사전 정리`해야 함을 모듈 헤더 주석으로 명시.

---

## 3. Storage Adapter (`server/src/adapters/recordingStorage.ts`)

### 3.1 Public surface

```ts
export interface RecordingStorageAdapter {
  provider: RecordingStorageProvider;
  createUploadUrl(input): Promise<SignedStorageUrl>;
  createReadUrl(input): Promise<SignedStorageUrl>;
  putObject(input): Promise<PutRecordingObjectResult>;
  deleteObject(input): Promise<void>;
}
```

- `RecordingStorageConfigError` — 구성/env 오류 (boot fatal)
- `RecordingStorageInputError` — 호출자 입력 오류 (4xx-class)
- `RecordingStorageOperationError` — 백엔드 동작 실패 (라우트가 status에 매핑)
- TTL 상수: upload 600s / read 300s / max 900s (helper `assertTtl`로 강제)
- `buildRecordingObjectKey({orgId, callId, recordingId, contentType, now})` — pure helper, server-known id만 사용, content-type → 확장자 매핑은 5개 audio MIME 허용리스트

### 3.2 Local provider

- `LocalRecordingStorageAdapter` — filesystem-backed, 네트워크 없음
- 모든 메소드 시작에서 `assertSafeObjectKey` + `resolveAbsolutePath` 두 단계 검증
  - 거부: empty, `..` segment, leading `/` 또는 `C:\\`, backslash, 인코딩된 `%2e%2e`, `\u0000-\u001f\u007f` control chars, double slash, > 1024자
  - `path.relative(rootDir, absolute)`가 `..`로 시작하거나 절대경로면 추가 거부
- `putObject` — `mkdir -p` 후 `writeFile`, sha256 계산. `checksumSha256` 인자 주면 mismatch 시 throw (`code='checksum_mismatch'`)
- `deleteObject` — `rm`, ENOENT는 `storage_object_not_found` operation error로 변환
- Signed URL은 `http://localhost.invalid/recordings/<encoded-key>?expires=<unix>` 형태. Step 2에는 이 URL을 서빙하는 route가 없다. 계약 테스트 전용
- 테스트 보조 helper `_readForTest` / `_existsForTest` (production 코드는 signed URL 경로로만 read)

### 3.3 S3 / MinIO

- `readS3CompatibleConfigFromEnv(provider, env)` — env가 누락된 키 이름을 모두 모아 단일 throw. 메시지에 값은 절대 포함하지 않음. minio는 `RECORDING_STORAGE_ENDPOINT` 추가 필수
- `forcePathStyle` 기본값: minio=true, s3=false. `RECORDING_STORAGE_FORCE_PATH_STYLE` 명시 시 그 값
- `S3CompatibleSentinelAdapter` — 4개 메소드 모두 `RecordingStorageOperationError('not_implemented_step_2', ...)` 던짐. Step 3에서 실 SDK로 교체
- 의도: Step 2는 env 검증/boundary/fail-fast만 닫고, 실 presigner / `PutObject` / `DeleteObject` SDK call은 Step 3 라우트가 첫 caller가 될 때 함께 들어간다. 이렇게 하면 unused dependency가 생기지 않는다

### 3.4 Resolver

```ts
resolveRecordingStorageAdapter({ env }?) → RecordingStorageAdapter
```

| `RECORDING_STORAGE_PROVIDER` | `NODE_ENV` | 결과 |
|---|---|---|
| unset / 빈 문자열 | `production` | throw `missing_env` |
| unset / 빈 문자열 | 그 외 | LocalRecordingStorageAdapter (rootDir 기본 `.data/recordings`) |
| `local` | any | LocalRecordingStorageAdapter |
| `s3` | any | env 검증 후 S3CompatibleSentinelAdapter |
| `minio` | any | env 검증 (+ endpoint) 후 S3CompatibleSentinelAdapter |
| 그 외 값 | any | throw `provider_unknown` — raw 값은 echo 안 함 (값이 secret일 가능성) |

### 3.5 Sensitive value scrub 검증

- 어떤 error path에서도 다음 값이 노출되지 않음을 테스트로 강제: provider access key, secret key, endpoint, bucket name. 테스트가 fixed sample 값들("AKIAFAKEACCESSKEY", "fake-secret-access-key-shhh", "endpoint.invalid", "very-secret-bucket")을 사용해 모든 throw 메시지를 lowercase substring 검사
- path-traversal error 메시지에도 offending key가 echo되지 않음

---

## 4. Tests

### 4.1 `server/test/phase8_step2_call_recordings_repo.test.mjs` — 15 cases

| # | Case |
|---|---|
| 1 | bare pool → 0 rows |
| 2 | Acme insertUploadPending + getById + listByCall 라운드트립 |
| 3 | Beta cannot see/patch/delete Acme recording (null / null / null / false) |
| 4 | Acme context + `insertUploadPending(client, ORG_BETA, ...)` → 42501 (RLS WITH CHECK) |
| 5 | Acme context inserting against Beta call_id → 23503 (composite FK; Beta call is RLS-hidden in Acme tx) |
| 6 | Beta context, raw INSERT (org_id=BETA, call_id=Acme call) → 23503 (composite FK) |
| 7 | lifecycle markUploaded → markAvailable transitions + state guard refuses already-available re-finalize |
| 8 | markFailed stores error_message + metadata + 'failed' status |
| 9 | markDeleted tombstones; listByCall hides; getById still surfaces (audit) |
| 10 | raw UPDATE status='deleted' with deleted_at=NULL → 23514 |
| 11 | UNIQUE (org_id, object_key) 23505; same key in another org OK |
| 12 | invalid content_type → 23514 |
| 13 | invalid checksum_sha256 hex → 23514 |
| 14 | listRetentionCandidates filter (uploaded/available/failed past cutoff in; pending/deleted/future out) |
| 15 | cascade — parent call hard delete removes recordings |

### 4.2 `server/test/phase8_step2_recording_storage.test.mjs` — 17 cases

| # | Case |
|---|---|
| 1 | `buildRecordingObjectKey` deterministic structure |
| 2 | `buildRecordingObjectKey` rejects non-uuid input |
| 3 | local putObject + deleteObject round-trip (size/checksum reported) |
| 4 | local putObject checksum mismatch (no body echo) |
| 5 | local 0-byte object |
| 6 | path-traversal keys all rejected before any FS write, error messages do not echo offending key |
| 7 | local createUploadUrl / createReadUrl method+headers+expires |
| 8 | TTL out-of-range rejected (`<=0` and `>900`) |
| 9 | resolver default = local in non-production |
| 10 | resolver returns local when `RECORDING_STORAGE_PROVIDER=local` |
| 11 | resolver unknown provider throws WITHOUT echoing raw value |
| 12 | resolver in production with unset provider fail-fast |
| 13 | s3 with full env → sentinel; 4개 메소드 모두 `not_implemented_step_2` throw, secret echo 없음 |
| 14 | s3 missing required env enumerates all missing keys by NAME only |
| 15 | minio requires `RECORDING_STORAGE_ENDPOINT` |
| 16 | `forcePathStyle` 기본값: minio=true, s3=false, env override 동작 |
| 17 | TTL 상수 default < max 일관성 |

테스트는 network call 0. process.env는 stub object로 주입 (resolver에 옵션으로 전달). 임시 디렉터리는 `os.tmpdir()` 아래 `kloser-recording-test-*`로 생성하고 try/finally 정리.

---

## 5. Verification 결과

```powershell
npm --prefix server run typecheck
npx tsx --test --test-concurrency=1 server/test/phase8_step2_recording_storage.test.mjs
npx tsx --test --test-concurrency=1 server/test/phase8_step2_call_recordings_repo.test.mjs
npm --prefix server test
node test/sync_shared_types.mjs
git diff --check
```

결과:

- typecheck: PASS
- adapter targeted tests: 17 / 17 PASS
- repo targeted tests: 15 / 15 PASS
- full server test: 804 total / 801 PASS / 3 skipped / 0 fail (이전 Step 1 closeout 시 772 → 32 case 증가)
- sync_shared_types: PASS, registry 변경 없음
- git diff --check: PASS (문서 파일 LF/CRLF 경고만 출력, whitespace error 없음)

---

## 6. Not Implemented

계획 §2 "안 한다" 그대로 미구현.

- 라우트 (`POST /calls/:id/recordings/*`, `GET .../playback-url`, `DELETE ...`)
- shared browser types
- 프론트엔드 (`platform/calls.html`, `platform/live.html`, `platform/api.js`, `platform/ws.js` 등)
- upload / finalize / playback REST 흐름
- retention worker `call_recordings` 모듈 (Phase 8 Step 5)
- activity_log recording action
- 실 AWS SDK 의존성 / 실 presigner / 실 PutObject SDK 호출 → Step 3
- 데스크톱 audio capture pipeline
- waveform, transcoding, transcript/audio alignment
- legal consent UX

---

## 7. Decisions

### 7.1 sentinel adapter for s3/minio

실 SDK 의존성을 Step 3로 미루고 boot fail-fast만 Step 2에서 닫는다.

장점:

- `package.json`을 건드리지 않아 `npm install` 회귀 위험 없음.
- 환경 검증 / boundary / 에러 메시지 정책을 라우트와 분리해 검증 가능.
- Step 3가 들어올 때 sentinel을 SDK 어댑터로 교체하면 됨 (인터페이스 동일).

단점:

- 실 S3 provider를 명시한 dev 환경에서 부팅은 성공하지만 method 호출에서 throw. 이는 의도된 동작이며 plan 문서에 명시.

### 7.2 size_bytes를 number로 노출

`bigint` 컬럼이지만 hydrate에서 `Number.parseInt`. 5GB 통화도 5e9 < 2^53. Step 3 route response shape에서 number 또는 string 중 선택 가능.

### 7.3 path-traversal 2단계 방어

`assertSafeObjectKey`로 입력 차원에서 거부 (..segments, encoded traversal, absolute path, backslash, control chars, double slash, > 1024 chars). 그 다음 `resolveAbsolutePath`가 `path.resolve` 결과를 `path.relative`로 한 번 더 검사. 어느 하나가 실패해도 filesystem write/delete 직전에 throw.

### 7.4 control character regex

`/[\u0000-\u001f\u007f]/` escape 표기로 제어문자를 검사한다. 소스 파일에 literal NUL/control byte를 넣지 않는다.

### 7.5 dynamic import 대신 정적 import

Windows 환경에서 `await import(absolutePath)`는 `ERR_UNSUPPORTED_ESM_URL_SCHEME`. tsx가 알아서 처리하는 정적 import (`import { ... } from "../src/adapters/recordingStorage.ts"`)로 통일.

---

## 8. Risks / Follow-ups for Step 3+

- Step 3에서 sentinel adapter를 실제 `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` 기반 구현으로 교체하면서 같은 인터페이스 / 같은 에러 정책을 유지해야 함. test fixture 패턴 (env stub + no network)을 그대로 재사용 가능.
- Step 3 라우트가 `markUploadedInCurrentOrg` 호출 전후로 `lockByIdInCurrentOrg`를 사용해 finalize 경합을 직렬화하는 것이 권장 (transcripts.appendForCall 패턴 동일).
- Step 5 retention worker는 `listRetentionCandidatesInCurrentOrg(cutoff, batchLimit)` → adapter.`deleteObject` → `markDeletedInCurrentOrg`/`hardDeleteByIdInCurrentOrg` 순서. aggregate audit 외 raw object key를 audit payload에 절대 넣지 않을 것 (plan §1.6).
- Step 3 route가 `error_message`에 무엇을 저장하는지 review 필요. service 단계에서 bucket/key/URL sanitize 한 번 더.

---

## 9. Next Step

Phase 8 Step 3 — upload / finalize / playback routes.

- `POST /calls/:id/recordings/upload` — 메타 row 생성 (upload_pending) + signed PUT URL 반환
- `POST /calls/:id/recordings/:recordingId/finalize` — `lockByIdInCurrentOrg` → checksum/size 검증 → `markUploadedInCurrentOrg` → 필요시 `markAvailableInCurrentOrg`
- `GET /calls/:id/recordings` — `listByCallInCurrentOrg`. response에서 `object_key` / `storage_bucket` 노출 금지
- `GET /calls/:id/recordings/:recordingId/playback-url` — `getActiveByIdInCurrentOrg` 권한 확인 후 `createReadUrl` (TTL ≤ 900s)
- `DELETE /calls/:id/recordings/:recordingId` — `markDeletePendingInCurrentOrg` → adapter.`deleteObject` → `markDeletedInCurrentOrg`

shared type 추가 (`server/src/types/callRecording.ts` + `platform/types/callRecording.js` + `test/sync_shared_types.mjs` registry entry)와 frontend playback UI는 Step 3가 닫는 범위. activity_log action도 Step 3에 추가.

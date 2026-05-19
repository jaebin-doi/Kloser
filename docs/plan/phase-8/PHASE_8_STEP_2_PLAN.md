# Phase 8 Step 2 Plan - Repository + Recording Storage Adapter Boundary

작성일: 2026-05-19

상위 문서:

- `docs/plan/phase-8/PHASE_8_MASTER.md`
- `docs/plan/phase-8/PHASE_8_STEP_1_PLAN.md`
- `docs/plan/phase-8/PHASE_8_STEP_1_FINDINGS.md`

선행 조건:

- Step 1 schema migration 완료.
- `call_recordings` table, FORCE RLS, composite FK `(org_id, call_id) -> calls(org_id, id)`, app grants, retention indexes가 존재한다.

이번 step의 목적은 **DB metadata access layer와 object storage provider boundary를 고정**하는 것이다. Upload/finalize/playback HTTP route, shared browser types, frontend playback UI, retention worker wiring은 이번 step에서 구현하지 않는다.

---

## 0. 목표

Step 2는 다음 불확실성을 route/UI 이전에 닫는다.

1. `call_recordings` metadata를 기존 repository 패턴에 맞춰 typed helper로 다룬다.
2. repository helper는 모두 `InCurrentOrg` suffix를 사용하고, caller가 `app.withOrgContext(orgId, fn)` 안에서 호출한다는 전제를 명확히 한다.
3. RLS와 composite FK가 실제 app role 테스트에서 cross-org recording 접근을 숨기거나 차단하는지 증명한다.
4. object storage는 좁은 adapter interface로 격리한다.
5. dev/test는 네트워크 없이 local/mock adapter로 동작한다.
6. real `s3` / `minio` provider를 명시했는데 필수 env가 빠지면 silent fallback 없이 fail-fast한다.
7. adapter error message와 test logs에 provider secret, signed URL, object body가 노출되지 않도록 한다.

---

## 1. 산출물

예상 추가 파일:

| 종류 | 경로 | 내용 |
|---|---|---|
| repository | `server/src/repositories/callRecordings.ts` | `call_recordings` typed metadata helper |
| adapter | `server/src/adapters/recordingStorage.ts` | storage interface, local provider, S3-compatible provider factory, env resolver |
| test | `server/test/phase8_step2_call_recordings_repo.test.mjs` | repository + RLS + FK isolation tests |
| test | `server/test/phase8_step2_recording_storage.test.mjs` | local adapter + env fail-fast + no-secret error tests |
| docs | `docs/plan/phase-8/PHASE_8_STEP_2_FINDINGS.md` | implementation 결과 handoff. Step 2 완료 후 작성 |

예상 수정 파일:

| 종류 | 경로 | 내용 |
|---|---|---|
| package | `server/package.json`, `server/package-lock.json` | S3-compatible provider를 구현할 경우 AWS SDK dependency 추가 |
| docs | `docs/plan/phase-8/PHASE_8_MASTER.md` | Step 2 완료 후 checkbox와 handoff 갱신 |

이번 계획서 작성 시점에는 위 구현 파일들을 만들지 않는다.

---

## 2. 명시적 Non-Goals

Step 2에서 하지 않는다.

- `server/src/routes/*` recording route 추가
- `server/src/types/*` / `platform/types/*` shared type 추가
- `test/sync_shared_types.mjs` registry 변경
- `platform/calls.html`, `platform/live.html`, `platform/api.js` 변경
- upload/finalize/playback/download REST API 구현
- signed URL을 사용자에게 반환하는 route 구현
- audio body를 DB에 저장
- public bucket 또는 public object URL 사용
- activity log action 추가
- retention worker에서 recording 삭제/tombstone 처리
- desktop/browser audio capture pipeline 구현
- waveform, transcoding, transcript/audio alignment 구현

Step 2 구현 중 위 파일이나 기능이 필요해 보이면 작업을 멈추고 Step 3+ 범위로 분리한다.

---

## 3. Repository Design

파일:

```text
server/src/repositories/callRecordings.ts
```

### 3.1 기본 규칙

- 모든 helper는 `PoolClient`를 받고, `app.withOrgContext(orgId, fn)` 안에서만 호출한다.
- read/update/delete SQL은 `org_id = ...`를 중복 필터링하지 않는다. RLS가 authority다.
- insert는 RLS `WITH CHECK` 때문에 `orgId`를 별도 인자로 받아 `org_id` column에 넣는다.
- request body가 `org_id`를 주입할 수 없도록 create/finalize input type에는 `org_id`가 없다.
- soft-deleted/tombstoned rows 처리 방식은 helper별로 명시한다.
- cross-org row는 `null`, `false`, empty list, 또는 DB FK/RLS error로만 보인다. "exists elsewhere" 식의 신호를 만들지 않는다.

### 3.2 Types

초안:

```ts
export type CallRecordingStatus =
  | "upload_pending"
  | "uploaded"
  | "processing"
  | "available"
  | "delete_pending"
  | "deleted"
  | "failed";

export type RecordingStorageProvider = "local" | "s3" | "minio";

export type RecordingContentType =
  | "audio/webm"
  | "audio/ogg"
  | "audio/mpeg"
  | "audio/mp4"
  | "audio/wav";

export interface CallRecording {
  id: string;
  org_id: string;
  call_id: string;
  status: CallRecordingStatus;
  storage_provider: RecordingStorageProvider;
  storage_bucket: string | null;
  object_key: string;
  object_version: string | null;
  content_type: RecordingContentType;
  codec: string | null;
  duration_seconds: number | null;
  size_bytes: string | number | null;
  checksum_sha256: string | null;
  recorded_at: Date | null;
  uploaded_at: Date | null;
  retention_delete_after: Date | null;
  deleted_at: Date | null;
  error_message: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}
```

주의: `pg`는 `bigint`를 string으로 반환할 수 있다. 기존 repo 관례에 맞춰 `size_bytes`를 string으로 그대로 둘지 number로 parse할지 구현 시 결정하되, route response type은 Step 3에서 별도로 정한다.

### 3.3 Repository API

초안:

```ts
export interface CallRecordingCreateInput {
  call_id: string;
  storage_provider: RecordingStorageProvider;
  storage_bucket?: string | null;
  object_key: string;
  content_type: RecordingContentType;
  codec?: string | null;
  recorded_at?: Date | null;
  retention_delete_after?: Date | null;
  metadata?: Record<string, unknown>;
}

export interface CallRecordingFinalizeInput {
  object_version?: string | null;
  duration_seconds?: number | null;
  size_bytes?: number | null;
  checksum_sha256?: string | null;
  uploaded_at?: Date;
  metadata?: Record<string, unknown>;
}

export interface CallRecordingFailureInput {
  error_message: string;
  metadata?: Record<string, unknown>;
}

export async function insertUploadPendingInCurrentOrg(
  client: PoolClient,
  orgId: string,
  input: CallRecordingCreateInput,
): Promise<CallRecording>;

export async function listByCallInCurrentOrg(
  client: PoolClient,
  callId: string,
): Promise<CallRecording[]>;

export async function listAvailableByCallInCurrentOrg(
  client: PoolClient,
  callId: string,
): Promise<CallRecording[]>;

export async function getByIdInCurrentOrg(
  client: PoolClient,
  id: string,
): Promise<CallRecording | null>;

export async function getByCallAndIdInCurrentOrg(
  client: PoolClient,
  callId: string,
  id: string,
): Promise<CallRecording | null>;

export async function lockByIdInCurrentOrg(
  client: PoolClient,
  id: string,
): Promise<CallRecording | null>;

export async function markUploadedInCurrentOrg(
  client: PoolClient,
  id: string,
  input: CallRecordingFinalizeInput,
): Promise<CallRecording | null>;

export async function markAvailableInCurrentOrg(
  client: PoolClient,
  id: string,
): Promise<CallRecording | null>;

export async function markFailedInCurrentOrg(
  client: PoolClient,
  id: string,
  input: CallRecordingFailureInput,
): Promise<CallRecording | null>;

export async function markDeletePendingInCurrentOrg(
  client: PoolClient,
  id: string,
): Promise<CallRecording | null>;

export async function markDeletedInCurrentOrg(
  client: PoolClient,
  id: string,
  deletedAt: Date,
): Promise<CallRecording | null>;

export async function deleteByIdInCurrentOrg(
  client: PoolClient,
  id: string,
): Promise<boolean>;

export async function listRetentionCandidatesInCurrentOrg(
  client: PoolClient,
  cutoff: Date,
  limit: number,
): Promise<CallRecording[]>;
```

### 3.4 State Transition Rules

Repository should stay thin but still avoid obviously invalid state changes.

| Helper | Allowed current state | New state | Notes |
|---|---|---|---|
| `insertUploadPendingInCurrentOrg` | n/a | `upload_pending` | object key generated by service/route later, not by DB |
| `markUploadedInCurrentOrg` | `upload_pending`, `failed` | `uploaded` | upload retry may move `failed` back to `uploaded` only if same row is reused. Step 3 may choose new row instead |
| `markAvailableInCurrentOrg` | `uploaded`, `processing` | `available` | future transcoding can pass through `processing` |
| `markFailedInCurrentOrg` | not `deleted` | `failed` | `error_message` must be bounded by route/service later |
| `markDeletePendingInCurrentOrg` | not `deleted` | `delete_pending` | used before object deletion |
| `markDeletedInCurrentOrg` | any not `deleted` | `deleted` | must set `deleted_at` |
| `deleteByIdInCurrentOrg` | any visible row | hard delete | primarily retention cleanup path; user-facing delete route can soft/tombstone first |

If implementation chooses to keep repository completely state-agnostic, service tests in Step 3 must cover these transitions. The preferred Step 2 approach is to encode simple `WHERE status IN (...)` guards in update helpers and return `null` when the current state is incompatible.

### 3.5 Retention Candidate Semantics

`listRetentionCandidatesInCurrentOrg(client, cutoff, limit)` should return rows where:

- `deleted_at IS NULL`
- `status IN ('uploaded', 'available', 'failed')`
- effective cutoff is:
  - `retention_delete_after <= cutoff`, or
  - `retention_delete_after IS NULL AND uploaded_at <= cutoff`

Step 5 will decide whether the cutoff passed into this helper is "now" against `retention_delete_after`, or "now - 90 days" against `uploaded_at`. The helper should be clear enough that Step 5 cannot accidentally sweep `upload_pending` rows.

---

## 4. Storage Adapter Design

파일:

```text
server/src/adapters/recordingStorage.ts
```

### 4.1 Interface

초안:

```ts
export interface RecordingStorageAdapter {
  provider: RecordingStorageProvider;

  createUploadUrl(input: CreateRecordingUploadUrlInput): Promise<SignedStorageUrl>;
  createReadUrl(input: CreateRecordingReadUrlInput): Promise<SignedStorageUrl>;
  putObject(input: PutRecordingObjectInput): Promise<PutRecordingObjectResult>;
  deleteObject(input: DeleteRecordingObjectInput): Promise<void>;
}

export interface CreateRecordingUploadUrlInput {
  bucket: string | null;
  objectKey: string;
  contentType: RecordingContentType;
  expiresInSeconds: number;
  checksumSha256?: string | null;
  sizeBytes?: number | null;
}

export interface CreateRecordingReadUrlInput {
  bucket: string | null;
  objectKey: string;
  expiresInSeconds: number;
  responseContentType?: RecordingContentType | null;
}

export interface SignedStorageUrl {
  url: string;
  expiresAt: Date;
  method: "GET" | "PUT";
  headers: Record<string, string>;
}

export interface PutRecordingObjectInput {
  bucket: string | null;
  objectKey: string;
  contentType: RecordingContentType;
  body: Buffer | Uint8Array;
  checksumSha256?: string | null;
}

export interface PutRecordingObjectResult {
  objectVersion: string | null;
  sizeBytes: number;
  checksumSha256: string | null;
}

export interface DeleteRecordingObjectInput {
  bucket: string | null;
  objectKey: string;
  objectVersion?: string | null;
}
```

Design notes:

- Adapter accepts `objectKey`, not `recordingId`. DB repository owns metadata; adapter owns object operations.
- Adapter never sees `orgId` unless object key generation later chooses to include it. Authorization is route/service responsibility.
- Adapter returns signed URL only to the route/service. It must not log the URL.
- `headers` is explicit because some providers require content-type or checksum headers for signed PUT.
- `putObject` exists for tests, future server-side upload, and retention verification. Browser direct upload will normally use `createUploadUrl`.

### 4.2 Provider Resolver

Env names:

```dotenv
RECORDING_STORAGE_PROVIDER=local

# local provider
RECORDING_STORAGE_LOCAL_ROOT=.data/recordings
RECORDING_STORAGE_PUBLIC_BASE_URL=http://localhost:32173/dev-recordings

# s3/minio provider
RECORDING_STORAGE_BUCKET=
RECORDING_STORAGE_REGION=us-east-1
RECORDING_STORAGE_ENDPOINT=
RECORDING_STORAGE_ACCESS_KEY_ID=
RECORDING_STORAGE_SECRET_ACCESS_KEY=
RECORDING_STORAGE_FORCE_PATH_STYLE=true
```

Resolver behavior:

| Env value | Behavior |
|---|---|
| unset / empty | `local` in development/test |
| `local` | local filesystem adapter. No network |
| `s3` | S3-compatible adapter. Requires bucket, region, access key, secret key. Endpoint optional for AWS S3 |
| `minio` | S3-compatible adapter. Requires bucket, endpoint, access key, secret key. `forcePathStyle=true` default |
| unknown | throw, naming only the env key and supported values |

Production caveat:

- If `NODE_ENV=production` and provider is unset/empty, implementation should fail fast instead of silently using local. This mirrors the repo's existing real-provider policy.
- Error messages must not echo secret values, raw endpoint credentials, object keys, or signed URLs.

### 4.3 Dependency Decision

Preferred implementation for real S3-compatible storage:

- `@aws-sdk/client-s3`
- `@aws-sdk/s3-request-presigner`

Reason:

- AWS SDK v3 supports AWS S3 and MinIO-compatible endpoints.
- Presigned PUT/GET can be generated without exposing credentials to the browser.
- Tests can validate command construction and env fail-fast without making network calls.

Step 2 implementation should avoid real network tests by default. Any MinIO integration smoke should be opt-in and not part of the required gate.

### 4.4 Local Provider

Local provider behavior:

- `putObject` writes below `RECORDING_STORAGE_LOCAL_ROOT`.
- `deleteObject` removes only the resolved file under that root.
- path traversal must be rejected. `objectKey` such as `../x`, absolute paths, or Windows drive paths must fail.
- `createReadUrl` / `createUploadUrl` may return deterministic dev URLs only if a local dev route exists later. Since Step 2 has no route, the local adapter may return a `file://`-free placeholder URL or use an internal `local://` URL in tests.

Recommended plan:

- In Step 2, local adapter's signed URL methods return `http://localhost.invalid/recordings/<encoded-key>?expires=...` only for contract testing.
- Step 3 replaces route-visible URL generation with backend playback/upload routes or a dev-only static handler if explicitly needed.
- Do not return `file://` paths to clients.

---

## 5. Object Key Contract

Step 2 should define a helper but route/service will decide when to call it.

Recommended object key shape:

```text
orgs/<orgId>/calls/<callId>/recordings/<recordingId>/<timestamp>-original.<ext>
```

Rules:

- object key is internal metadata and must not be exposed in API responses or audit payloads.
- key generation must use server-known `orgId`, `callId`, `recordingId`; never trust body-supplied org.
- extension comes from the allow-listed content type.
- object key uniqueness is enforced by `UNIQUE (org_id, object_key)`.

Potential helper in `recordingStorage.ts` or a future service:

```ts
export function buildRecordingObjectKey(input: {
  orgId: string;
  callId: string;
  recordingId: string;
  contentType: RecordingContentType;
  now: Date;
}): string;
```

If Step 2 implements this helper, it must be pure and unit-tested. It must not create DB rows or storage objects.

---

## 6. Repository Test Plan

파일:

```text
server/test/phase8_step2_call_recordings_repo.test.mjs
```

Use existing pattern:

- Fastify app + `dbPlugin`
- seeded Acme/Beta orgs
- `app.withOrgContext(orgId, async client => ...)`
- test rows tracked by ids and removed in `afterEach`
- never delete seeded users/customers/orgs

Suggested constants:

```js
const ORG_ACME = "11111111-1111-1111-1111-111111111111";
const ORG_BETA = "22222222-2222-2222-2222-222222222222";
const ACME_ADMIN_USER = "aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa";
const BETA_ADMIN_USER = "bbbbbbbb-0001-0001-0001-bbbbbbbbbbbb";
```

Cases:

1. app role without `app.org_id` sees zero `call_recordings` rows.
2. `insertUploadPendingInCurrentOrg` creates a row for an Acme call.
3. Acme can list/get its own recording by call.
4. Beta cannot list/get Acme recording.
5. Acme context + Beta call id insert fails through composite FK or RLS.
6. insert with `orgId=Beta` inside Acme context fails RLS `WITH CHECK`.
7. duplicate `(org_id, object_key)` fails with `23505`.
8. same object key in another org is allowed only if that org has its own call and context.
9. invalid content type is rejected by DB check.
10. invalid checksum is rejected by DB check.
11. `markUploadedInCurrentOrg` sets uploaded metadata, size, checksum, uploaded_at.
12. `markAvailableInCurrentOrg` moves uploaded/processing row to available.
13. `markFailedInCurrentOrg` stores bounded error metadata and status failed.
14. `markDeletedInCurrentOrg` sets status deleted and `deleted_at`.
15. raw update to `status='deleted'` with `deleted_at=NULL` fails DB check.
16. `listRetentionCandidatesInCurrentOrg` includes eligible uploaded/available/failed rows.
17. retention candidate list excludes `upload_pending`, `delete_pending`, `deleted`, and already tombstoned rows.
18. hard delete removes same-org row and returns false for missing/cross-org row.
19. `updated_at` advances after update trigger.
20. `lockByIdInCurrentOrg` returns row under same org and null under cross org.

Cleanup order:

1. `call_recordings`
2. `calls` inserted only by this test

Do not clean by broad date windows. Track inserted ids.

---

## 7. Storage Adapter Test Plan

파일:

```text
server/test/phase8_step2_recording_storage.test.mjs
```

Cases:

1. resolver defaults to local in non-production when provider env is unset.
2. resolver accepts `RECORDING_STORAGE_PROVIDER=local`.
3. resolver rejects unknown provider without echoing the unknown value if it might contain a secret-like string.
4. production with provider unset fails fast.
5. `s3` with missing bucket/access/secret fails fast.
6. `minio` with missing endpoint fails fast.
7. fail-fast messages name missing env keys but do not echo values.
8. local `putObject` writes below a temp root and reports size/checksum.
9. local `deleteObject` removes the object.
10. local adapter rejects path traversal object keys.
11. local signed URL methods return bounded `expiresAt` and correct method.
12. signed URL TTL clamps or rejects values outside the configured range.
13. S3-compatible adapter factory can be constructed with complete fake env without making a network call.
14. S3-compatible signed URL creation can be unit-tested with fake credentials and does not require network.

TTL policy:

- default playback TTL: 5 minutes.
- default upload TTL: 10 minutes.
- max TTL: 15 minutes unless Step 3 route plan changes it.
- adapter should reject `expiresInSeconds <= 0`.
- adapter or service should cap overly large TTLs. Preferred: resolver exposes config and service passes valid TTL; adapter still validates defensively.

---

## 8. Error and Secret Policy

Repository:

- Raw DB errors are allowed to bubble to service/route tests in Step 2.
- Step 3 route mapping will translate DB errors to HTTP vocabulary.
- Cross-org existence must not become `403 exists_elsewhere`.

Storage:

- Do not log signed URLs.
- Do not log `RECORDING_STORAGE_SECRET_ACCESS_KEY`.
- Do not include request body bytes in thrown errors.
- Do not include full object key in audit payloads later. Step 2 tests can assert adapter errors avoid object key where practical.
- Unknown provider errors should say supported values but should avoid echoing the raw provided value if it could contain a secret-like string.

Suggested error classes:

```ts
export class RecordingStorageConfigError extends Error {}
export class RecordingStorageInputError extends Error {}
export class RecordingStorageOperationError extends Error {}
```

---

## 9. Step 3 Handoff Contract

Step 2 should leave Step 3 with enough primitives to implement:

- `POST /calls/:id/recordings/upload`
  - create metadata row in `upload_pending`
  - generate object key
  - call `createUploadUrl`
- `POST /calls/:id/recordings/:recordingId/finalize`
  - lock recording row
  - validate call/recording same current org through repository
  - mark uploaded/available
- `GET /calls/:id/recordings`
  - list by call
  - hide object key and bucket from response
- `GET /calls/:id/recordings/:recordingId/playback-url`
  - authorize backend access first
  - call `createReadUrl`
- `DELETE /calls/:id/recordings/:recordingId`
  - mark delete pending/deleted and coordinate object deletion

Step 2 must not implement these routes.

---

## 10. Implementation Order For Step 2

Recommended sequence for the implementer:

1. Add `PHASE_8_STEP_2_PLAN.md` review-approved baseline.
2. Implement `callRecordings` repository types and read helpers.
3. Add repository tests for bare pool, same-org read, cross-org empty behavior.
4. Add insert/update/delete helpers.
5. Add repository tests for FK/RLS/CHECK/unique/state transition behavior.
6. Implement storage adapter interface and local provider.
7. Add local provider tests and path traversal tests.
8. Add S3-compatible provider factory/env resolver and fail-fast tests.
9. Add package dependencies only if real S3-compatible signing is actually implemented.
10. Run validation.
11. Write `PHASE_8_STEP_2_FINDINGS.md`.
12. Update `PHASE_8_MASTER.md` Step 2 checkbox only after tests pass.

---

## 11. Validation Gates

Required:

```powershell
npm --prefix server run typecheck
npm --prefix server test
node test/sync_shared_types.mjs
git diff --check
```

Targeted during implementation:

```powershell
npx tsx --test --test-concurrency=1 `
  server/test/phase8_step2_call_recordings_repo.test.mjs `
  server/test/phase8_step2_recording_storage.test.mjs
```

Optional:

```powershell
npm --prefix server run db:migrate:up
```

No frontend or Playwright smoke is required for Step 2 because no UI or route should change.

---

## 12. Completion Checklist

- [ ] `callRecordings` repository exists and uses existing RLS/current-org pattern.
- [ ] All repository helpers that touch org-scoped rows are named `*InCurrentOrg`.
- [ ] bare app role sees zero recording rows without org context.
- [ ] same-org insert/list/get/update/delete paths pass.
- [ ] cross-org list/get returns empty/null.
- [ ] cross-org raw insert is blocked by composite FK or RLS.
- [ ] invalid checksum/content type/status constraints are covered.
- [ ] retention candidate helper excludes unsafe states.
- [ ] storage adapter interface exists and has local provider.
- [ ] real `s3` / `minio` provider config is fail-fast when explicitly selected.
- [ ] no default test makes a network call.
- [ ] no storage error echoes secrets, signed URLs, or object body.
- [ ] no route/shared type/frontend files changed.
- [ ] `npm --prefix server run typecheck` PASS.
- [ ] targeted Step 2 tests PASS.
- [ ] full `npm --prefix server test` PASS.
- [ ] `node test/sync_shared_types.mjs` PASS.
- [ ] `git diff --check` PASS.
- [ ] `PHASE_8_STEP_2_FINDINGS.md` written.
- [ ] `PHASE_8_MASTER.md` updated after verification only.

---

## 13. Codex Review Focus

1. **Step boundary**: no routes, shared types, frontend, retention worker, or upload UI.
2. **RLS proof**: tests must use app role path through `dbPlugin`, not migration/admin role only.
3. **Composite FK proof**: wrong-org `(org_id, call_id)` insert must fail at DB level.
4. **Repository naming**: org-scoped helpers should use `InCurrentOrg` suffix consistently.
5. **No object key leaks**: API is not built yet, but adapter/log/error surfaces must not normalize leaking object locators.
6. **Provider fail-fast**: explicit real provider cannot silently fall back to local/mock.
7. **No network in default tests**: S3/MinIO tests must be constructor/presign/unit tests only unless explicitly gated.
8. **Local path safety**: object key traversal must be rejected before filesystem writes/deletes.
9. **State transitions**: deleted rows need `deleted_at`; retention candidates cannot include pending upload rows.
10. **Dirty scope**: implementation commit should include only Step 2 files and planned docs.

---

## 14. One-Line Handoff

Step 2 should produce a tested `call_recordings` metadata repository plus a narrow recording storage adapter boundary, proving RLS/cross-org isolation and provider fail-fast behavior before any upload/playback route or frontend surface is added.

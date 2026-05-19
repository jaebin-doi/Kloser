# Phase 8 Step 3 Plan - Upload / Finalize / Playback Routes

작성일: 2026-05-19

상위 문서:

- `docs/plan/phase-8/PHASE_8_MASTER.md`
- `docs/plan/phase-8/PHASE_8_STEP_1_FINDINGS.md`
- `docs/plan/phase-8/PHASE_8_STEP_2_FINDINGS.md`

선행 조건:

- Step 1 `call_recordings` metadata schema 완료.
- Step 2 repository + recording storage adapter boundary 완료.
- `server/src/repositories/callRecordings.ts`는 org-scoped `InCurrentOrg` helper와 lifecycle guard를 제공한다.
- `server/src/adapters/recordingStorage.ts`는 local provider, S3/MinIO env validation, sentinel adapter, object key helper, TTL guard를 제공한다.

주의:

- Step 3은 route/shared-type 단계이지만, `activity_log`에 recording action을 추가하려면 DB CHECK allow-list도 확장해야 한다. 따라서 Step 3 구현은 **3.0 audit action forward migration**을 먼저 닫고, 그 다음 route/types를 진행한다. 이는 AGENTS.md의 schema-first 원칙에 맞춘 예외가 아니라 필수 선행 작업이다.

---

## 0. 목표

Step 3의 목표는 frontend 없이도 backend가 recording upload/finalize/playback 권한 경계를 완성하는 것이다.

완료 후 서버는 다음을 제공해야 한다.

1. authenticated same-org caller만 recording metadata를 만들고 조회할 수 있다.
2. upload URL과 playback URL은 항상 backend authorization을 통과한 뒤 발급된다.
3. response에는 `object_key`, `storage_bucket`, provider credential, raw signed URL config가 노출되지 않는다.
4. finalize는 call/recording same-org 관계와 lifecycle state를 검증한다.
5. delete는 route level에서 soft/tombstone 흐름을 제공하되, object deletion 실패 정책을 명확히 한다.
6. shared zod/JSDoc type과 route response shape가 `sync_shared_types`에 등록된다.
7. activity_log row에는 object key, signed URL, bucket, raw audio body가 절대 들어가지 않는다.

---

## 1. 범위

### 한다

1. Audit action CHECK forward migration:
   - `server/migrations/1715000029000_phase8_recording_activity_actions.sql`
   - activity action allow-list에 recording actions 추가
   - TS union `ActivityAction`도 같은 commit 또는 바로 다음 commit에서 lockstep 갱신

2. Shared types:
   - `server/src/types/callRecording.ts`
   - `platform/types/callRecording.js`
   - `test/sync_shared_types.mjs` registry entry

3. Service glue:
   - `server/src/services/callRecordings.ts`
   - repository + storage adapter + call permission helper를 묶는 application service

4. Routes:
   - `server/src/routes/callRecordings.ts`
   - `server/src/server.ts` registration

5. Tests:
   - route tests for auth/org/RLS/permission/lifecycle/error mapping
   - shared type sync
   - audit action tests
   - S3/MinIO sentinel or real SDK behavior tests, depending on adapter choice below

6. S3-compatible adapter decision:
   - preferred: Step 3에서 `S3CompatibleSentinelAdapter`를 실제 AWS SDK v3 presigner adapter로 교체
   - acceptable fallback: Step 3 route tests use local provider only, and S3 SDK landing is explicitly deferred in findings. If deferred, production `s3|minio` route calls still fail with `not_implemented_step_2`, so this must be called out as a release blocker.

### 하지 않는다

- `platform/calls.html` playback UI
- `platform/live.html` recording capture UI
- browser/desktop audio capture pipeline
- waveform rendering
- audio transcoding
- transcript/audio timestamp alignment
- retention worker object deletion
- legal consent workflow
- public bucket or public object URL

---

## 2. Routes

Route file:

```text
server/src/routes/callRecordings.ts
```

Register in `server/src/server.ts` after `callsRoutes` / `callsPhase5Routes` is fine. The route paths extend `/calls/:id`.

### 2.1 `POST /calls/:id/recordings/upload`

Purpose:

- Create a `call_recordings` row in `upload_pending`.
- Generate internal object key.
- Return a bounded signed PUT URL.

Pre-handlers:

```ts
requireAuth
orgContext
requireVerified
requireRole("admin", "manager", "employee")
requireFreshRole
```

Permission:

- Use `assertCanMutateCall`.
- Admin can upload to any same-org call.
- Manager can upload for same-team calls only.
- Employee can upload only own calls.
- Viewer cannot upload.
- Cross-org/missing call returns `404 not_found`, not `403`.

Body schema:

```ts
CallRecordingUploadInput = {
  content_type: "audio/webm" | "audio/ogg" | "audio/mpeg" | "audio/mp4" | "audio/wav";
  codec?: string | null;                 // max 80
  recorded_at?: string | null;           // ISO, optional
  duration_seconds?: number | null;      // int >= 0
  size_bytes?: number | null;            // int >= 0, route-level max
  checksum_sha256?: string | null;       // lowercase 64 hex
}
```

Size policy:

- Introduce `RECORDING_UPLOAD_MAX_BYTES`, default e.g. `250_000_000` (250 MB).
- If `size_bytes` exceeds max, return `413 recording_too_large`.
- This is route/service policy, not DB policy.

Response:

```ts
CallRecordingUploadResponse = {
  recording: CallRecording;
  upload: {
    method: "PUT";
    url: string;
    headers: Record<string, string>;
    expires_at: string;
  };
}
```

Response must not include:

- `object_key`
- `storage_bucket`
- `storage_provider` unless product explicitly needs it. Preferred: hide provider.
- provider config

Audit:

- `recording.upload_initiated`
- target_type: `call`
- target_id: call id
- payload: `{ recording_id, content_type, size_bytes, ttl_seconds }`
- no object key, bucket, URL, checksum, body

### 2.2 `POST /calls/:id/recordings/:recordingId/finalize`

Purpose:

- Confirm upload metadata after object upload.
- Move `upload_pending` or `failed` row to `uploaded`, then usually `available` for v1.

Pre-handlers:

Same as upload.

Permission:

- Same `assertCanMutateCall` policy as upload.
- `callId` path and `recordingId` path must match one visible row. Mismatch returns `404 not_found`.

Body schema:

```ts
CallRecordingFinalizeInput = {
  object_version?: string | null;         // max 256
  duration_seconds?: number | null;       // int >= 0
  size_bytes?: number | null;             // int >= 0, max policy
  checksum_sha256?: string | null;        // lowercase 64 hex
}
```

Service behavior:

1. `withOrgContext(actor.orgId, actor.id, tx)`
2. lock call row or get call row
3. assert mutation permission
4. lock recording row
5. verify `recording.call_id === callId`
6. if status is `deleted` or `delete_pending`, return 409 `invalid_recording_state`
7. call `markUploadedInCurrentOrg`
8. call `markAvailableInCurrentOrg` for v1, because no transcoding pipeline exists yet
9. write audit row in same transaction

Response:

```ts
CallRecordingFinalizeResponse = {
  recording: CallRecording;
}
```

Audit:

- `recording.finalized`
- payload: `{ recording_id, content_type, size_bytes, duration_seconds }`
- no object key, bucket, URL, checksum

### 2.3 `GET /calls/:id/recordings`

Purpose:

- List recording metadata for call detail UI.

Pre-handlers:

```ts
requireAuth
orgContext
```

Read permission:

- Same pattern as call detail today: any same-org authenticated role can read unless existing call read policy changes.
- Cross-org/missing call returns `404 not_found`.

Response:

```ts
CallRecordingListResponse = {
  items: CallRecording[];
}
```

Ordering:

- repository currently orders `created_at DESC, id DESC`.

Tombstones:

- use `listByCallInCurrentOrg`, so rows with `deleted_at IS NOT NULL` are hidden.
- A deleted row can still be queried internally for audit, but not through this user-facing list.

No audit row:

- Listing recordings is a low-risk read, and recording list is part of ordinary call detail. Do not add noisy read audit in Step 3.

### 2.4 `GET /calls/:id/recordings/:recordingId/playback-url`

Purpose:

- Return a short-lived signed GET URL for one available recording.

Pre-handlers:

```ts
requireAuth
orgContext
```

Read permission:

- same-org authenticated role can request playback URL.
- If product later wants viewer restrictions, that belongs in Step 4/UX policy or a dedicated security step. Step 3 should keep backend policy explicit.

State policy:

- only `status='available'` and `deleted_at IS NULL` can receive playback URL.
- `upload_pending`, `uploaded`, `processing` return `409 recording_not_available`.
- `failed`, `delete_pending`, `deleted` return `409 recording_not_available` or `404` for deleted/tombstoned depending on service choice. Preferred: active lookup hides deleted as `404`.

Response:

```ts
CallRecordingPlaybackUrlResponse = {
  playback: {
    method: "GET";
    url: string;
    headers: Record<string, string>;
    expires_at: string;
  };
}
```

TTL:

- default: `RECORDING_READ_TTL_DEFAULT_SECONDS` (300s)
- max: `RECORDING_URL_TTL_MAX_SECONDS` (900s)
- no client-controlled TTL in Step 3.

Audit:

- `recording.playback_url_issued`
- payload: `{ recording_id, ttl_seconds }`
- no URL, object key, bucket, provider config

### 2.5 `DELETE /calls/:id/recordings/:recordingId`

Purpose:

- User/admin initiated delete/tombstone flow.

Pre-handlers:

```ts
requireAuth
orgContext
requireVerified
requireRole("admin", "manager", "employee")
requireFreshRole
```

Permission:

- same as upload/finalize: `assertCanMutateCall`.

Delete policy:

Preferred Step 3 policy:

1. transaction: mark row `delete_pending`, audit `recording.delete_requested`
2. outside transaction: attempt `adapter.deleteObject`
3. transaction: mark row `deleted`
4. response `204`

If object deletion fails:

- return `502 recording_delete_failed` for storage operation failure.
- leave row as `delete_pending` so Step 5 retention/reconciliation can retry.
- do not hard-delete metadata.

If object not found:

- treat as success and mark deleted. Object absence is idempotent from user perspective.

Audit:

- `recording.delete_requested` in transaction before object deletion
- optionally `recording.deleted` after successful deletion
- payload: `{ recording_id }` and maybe `{ previous_status }`
- no object key, bucket, URL

Potential issue:

- The existing local adapter throws `storage_object_not_found`. Service should map that to idempotent success for DELETE only.

---

## 3. Shared Types

Server:

```text
server/src/types/callRecording.ts
```

Browser mirror:

```text
platform/types/callRecording.js
```

Registry:

```text
test/sync_shared_types.mjs
```

### 3.1 Type Set

Register these top-level z.object literals:

- `CallRecording`
- `CallRecordingUploadInput`
- `CallRecordingUploadResponse`
- `CallRecordingFinalizeInput`
- `CallRecordingFinalizeResponse`
- `CallRecordingListResponse`
- `CallRecordingPlaybackUrlResponse`

Enums can be z.enum exports but do not need registry entries because `sync_shared_types` compares object field names.

### 3.2 `CallRecording` Response Shape

Suggested wire shape:

```ts
export const CallRecording = z.object({
  id: UuidString,
  call_id: UuidString,
  status: CallRecordingStatus,
  content_type: RecordingContentType,
  codec: z.string().nullable(),
  duration_seconds: z.number().int().nonnegative().nullable(),
  size_bytes: z.number().int().nonnegative().nullable(),
  recorded_at: z.string().nullable(),
  uploaded_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
  error_message: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
```

Do not expose:

- `org_id`
- `storage_provider`
- `storage_bucket`
- `object_key`
- `object_version`
- `checksum_sha256`
- `metadata`

Rationale:

- `call_id` is useful to client state.
- `org_id` is redundant and should not be trusted client-side.
- storage fields are internal locators/config.
- checksum and metadata are operational internals for now.

### 3.3 Date Conversion

Repository rows use `Date`. Route response types should use ISO strings. Add a mapper:

```ts
toCallRecordingResponse(row: RepoCallRecording): CallRecording
```

Keep this mapper in service or route module. Do not rely on accidental JSON serialization if zod response schemas expect strings.

---

## 4. Service Design

File:

```text
server/src/services/callRecordings.ts
```

### 4.1 Responsibilities

The service owns application-level coordination:

- call lookup + mutation permission
- recording row creation/finalization/deletion
- object key generation
- adapter signed URL calls
- audit hook calls
- sanitized error mapping

The repository stays mechanical. The route stays schema/error vocabulary.

### 4.2 Service API Draft

```ts
export async function initiateRecordingUpload(
  app: FastifyInstance,
  actor: Actor,
  callId: string,
  input: CallRecordingUploadInput,
): Promise<CallRecordingUploadResponse>;

export async function finalizeRecordingUpload(
  app: FastifyInstance,
  actor: Actor,
  callId: string,
  recordingId: string,
  input: CallRecordingFinalizeInput,
): Promise<CallRecordingFinalizeResponse | null>;

export async function listCallRecordings(
  app: FastifyInstance,
  actorOrgId: string,
  callId: string,
): Promise<CallRecordingListResponse | null>;

export async function createRecordingPlaybackUrl(
  app: FastifyInstance,
  actorOrgId: string,
  callId: string,
  recordingId: string,
): Promise<CallRecordingPlaybackUrlResponse | null>;

export async function deleteRecording(
  app: FastifyInstance,
  actor: Actor,
  callId: string,
  recordingId: string,
): Promise<boolean>;
```

### 4.3 Storage Adapter Resolution

Avoid resolving provider from env on every request if it will instantiate clients. Options:

1. Register a Fastify decorator `app.recordingStorage` in a small plugin.
2. Resolve lazily in service with module-level singleton.

Preferred for Step 3:

- add `server/src/plugins/recordingStorage.ts`
- register in `server/src/server.ts` after `dbPlugin`
- tests can inject env or decorate with local adapter.

If using a plugin:

```ts
declare module "fastify" {
  interface FastifyInstance {
    recordingStorage: RecordingStorageAdapter;
  }
}
```

### 4.4 S3-Compatible Adapter

Step 2 left S3/MinIO as sentinel. Step 3 should decide one of two paths.

Preferred path:

- add dependencies:
  - `@aws-sdk/client-s3`
  - `@aws-sdk/s3-request-presigner`
- replace sentinel methods with real:
  - `createUploadUrl` -> `PutObjectCommand` + `getSignedUrl`
  - `createReadUrl` -> `GetObjectCommand` + `getSignedUrl`
  - `putObject` -> `PutObjectCommand`
  - `deleteObject` -> `DeleteObjectCommand`
- keep the same env validation and error classes.
- tests use stubbed clients or constructor-only tests; no network by default.

Fallback path:

- keep sentinel and document production route limitation.
- route tests must use local provider only.
- findings must mark S3/MinIO SDK as Step 3 incomplete and block Step 3 checkbox unless the product accepts local-only backend.

Recommendation:

- Implement real SDK in Step 3. The route surface is the first real caller of signed URL methods, so leaving sentinel in place undermines the Step 3 goal.

---

## 5. Activity Log Changes

Because action is DB CHECK-bound, add a small forward migration before route hooks.

### 5.1 Migration

File:

```text
server/migrations/1715000029000_phase8_recording_activity_actions.sql
```

Actions to add:

- `recording.upload_initiated`
- `recording.finalized`
- `recording.playback_url_issued`
- `recording.delete_requested`
- `recording.deleted`

Target type:

- Prefer existing `target_type='call'`, target_id = call id.
- Do not add `target_type='recording'` unless there is a real drilldown route keyed by recording id.

Reason:

- Existing target type CHECK does not include `recording`.
- Call is the user-facing parent and stable route context.
- `recording_id` can be payload metadata without becoming the audit target.

Migration approach:

- Drop and recreate `activity_log_action_check` with the expanded allow-list.
- Do not touch grants, RLS, indexes, payload check, or target type check.
- Down migration should restore the previous allow-list only if no new rows exist, or simply drop/recreate old constraint. Since down migration can fail if rows contain new actions, document that expected behavior.

### 5.2 Type Union

Update:

```text
server/src/repositories/activityLog.ts
```

`ActivityAction` union must match migration exactly.

### 5.3 Service Helpers

Add to:

```text
server/src/services/activityLog.ts
```

Helpers:

```ts
recordRecordingUploadInitiated(...)
recordRecordingFinalized(...)
recordRecordingPlaybackUrlIssued(...)
recordRecordingDeleteRequested(...)
recordRecordingDeleted(...)
```

Payload rules:

- allowed: `recording_id`, `content_type`, `size_bytes`, `duration_seconds`, `ttl_seconds`, `previous_status`
- forbidden: object key, bucket, signed URL, provider credentials, checksum, raw metadata, raw error body

### 5.4 Tests

Add audit tests in the route test file or separate:

```text
server/test/phase8_step3_recording_audit_hooks.test.mjs
```

Cases:

- upload creates `recording.upload_initiated`
- finalize creates `recording.finalized`
- playback URL creates `recording.playback_url_issued`
- delete creates `recording.delete_requested` and `recording.deleted` on success
- payload never contains `object_key`, `storage_bucket`, `url`, `bucket`, `secret`, `checksum`
- audit rows are invisible cross-org

---

## 6. Error Vocabulary

Route-scoped error handler should map:

| Condition | HTTP | Body |
|---|---:|---|
| zod validation | 400 | `{ error: "invalid_input", issues }` |
| missing/cross-org call or recording | 404 | `{ error: "not_found" }` |
| permission denied same-org | 403 | `{ error: "forbidden" }` |
| upload too large | 413 | `{ error: "recording_too_large" }` |
| invalid lifecycle state | 409 | `{ error: "invalid_recording_state" }` |
| playback before available | 409 | `{ error: "recording_not_available" }` |
| storage provider not implemented | 501 or 503 | `{ error: "recording_storage_unavailable" }` |
| storage operation failed | 502 | `{ error: "recording_storage_failed" }` |
| pg 23503 | 400 | `{ error: "invalid_reference" }` |
| pg 23505 | 409 | `{ error: "recording_conflict" }` |
| pg 23514 | 400 | `{ error: "invalid_state_transition" }` |
| pg 42501 | 500 | `{ error: "rls_violation" }` |

Do not echo adapter messages directly to clients. Adapter messages are sanitized, but route responses should stay stable and terse.

---

## 7. Route Test Plan

Primary file:

```text
server/test/phase8_step3_recording_routes.test.mjs
```

Setup pattern:

- Fastify app with auth/db/plugin/routes
- local recording storage adapter with temp root
- seeded Acme/Beta users
- login helpers from existing route tests
- create calls through service/repo or existing `/calls` route
- clean inserted calls, recordings, temp files, activity rows

Cases:

### Upload

1. missing auth -> 401
2. viewer upload -> 403
3. employee uploads own call -> 201
4. employee uploads another user's call -> 403
5. manager same-team upload -> 201
6. manager other-team upload -> 403
7. cross-org call id -> 404
8. invalid content type -> 400
9. invalid checksum -> 400
10. size over `RECORDING_UPLOAD_MAX_BYTES` -> 413
11. response has `recording` + `upload`, no object key/bucket/provider config
12. upload row is `upload_pending`
13. upload audit row exists and omits sensitive fields

### Finalize

14. finalize pending row -> 200 with status `available`
15. finalize cross-org recording id -> 404
16. finalize recording whose call id path does not match -> 404
17. finalize already available row -> 409 or 404 depending service policy; preferred 409 invalid state
18. finalize deleted row -> 404 or 409; preferred 404 if active lookup hides deleted
19. invalid size/checksum -> 400
20. finalize audit row exists and omits object key/checksum

### List

21. same-org GET list -> 200 items
22. cross-org call -> 404
23. deleted/tombstoned rows are hidden
24. list response never includes internal storage fields

### Playback URL

25. available row -> 200 signed GET URL, expires_at within 300s default
26. upload_pending row -> 409 recording_not_available
27. cross-org row -> 404
28. response has no object key/bucket/provider config
29. audit row exists and payload has TTL only

### Delete

30. employee own call can delete -> 204
31. employee other call -> 403
32. cross-org recording -> 404
33. missing object in local storage is treated idempotently if policy chooses so
34. delete marks DB row `deleted`, list hides it
35. storage delete failure leaves `delete_pending` and returns storage error
36. delete audit rows omit sensitive fields

### Provider

37. `RECORDING_STORAGE_PROVIDER=s3` with missing env fails route app boot/plugin registration
38. S3/MinIO real adapter tests do not make network calls by default

---

## 8. Shared Type Sync Tests

Update `test/sync_shared_types.mjs` registry:

```js
{
  name: "callRecording",
  server: "server/src/types/callRecording.ts",
  browser: "platform/types/callRecording.js",
  types: [
    "CallRecording",
    "CallRecordingUploadInput",
    "CallRecordingUploadResponse",
    "CallRecordingFinalizeInput",
    "CallRecordingFinalizeResponse",
    "CallRecordingListResponse",
    "CallRecordingPlaybackUrlResponse",
  ],
}
```

Run:

```powershell
node test/sync_shared_types.mjs
```

The server schemas must be top-level `export const X = z.object({ ... });` literals. Derived schemas can exist but should not be registered.

---

## 9. Implementation Order

### Commit 1 - Audit Action Schema

Files:

- `server/migrations/1715000029000_phase8_recording_activity_actions.sql`
- `server/src/repositories/activityLog.ts`
- focused schema/audit allow-list test if useful

Validation:

```powershell
npm --prefix server run db:migrate:up
npm --prefix server run typecheck
npx tsx --test --test-concurrency=1 server/test/phase7_step3_activity_log_repo.test.mjs
```

### Commit 2 - Shared Types

Files:

- `server/src/types/callRecording.ts`
- `platform/types/callRecording.js`
- `test/sync_shared_types.mjs`

Validation:

```powershell
npm --prefix server run typecheck
node test/sync_shared_types.mjs
```

### Commit 3 - Storage SDK / Plugin

Files:

- `server/src/adapters/recordingStorage.ts`
- `server/src/plugins/recordingStorage.ts`
- `server/package.json`
- `server/package-lock.json`

Validation:

```powershell
npm --prefix server run typecheck
npx tsx --test --test-concurrency=1 server/test/phase8_step2_recording_storage.test.mjs
```

If S3 SDK is deferred, this commit should only add the plugin/local injection path and must document that production S3 playback remains unavailable.

### Commit 4 - Service + Routes

Files:

- `server/src/services/callRecordings.ts`
- `server/src/routes/callRecordings.ts`
- `server/src/server.ts`
- route tests

Validation:

```powershell
npm --prefix server run typecheck
npx tsx --test --test-concurrency=1 server/test/phase8_step3_recording_routes.test.mjs
```

### Commit 5 - Findings / Master

Files:

- `docs/plan/phase-8/PHASE_8_STEP_3_FINDINGS.md`
- `docs/plan/phase-8/PHASE_8_MASTER.md`

Validation:

```powershell
npm --prefix server test
node test/sync_shared_types.mjs
git diff --check
```

---

## 10. Validation Gates

Required before Step 3 closeout:

```powershell
npm --prefix server run db:migrate:up
npm --prefix server run typecheck
npx tsx --test --test-concurrency=1 server/test/phase8_step3_recording_routes.test.mjs
npx tsx --test --test-concurrency=1 server/test/phase8_step3_recording_audit_hooks.test.mjs
npm --prefix server test
node test/sync_shared_types.mjs
git diff --check
```

If S3 real adapter is implemented:

- add unit tests that construct/presign without network
- optional MinIO integration smoke must be opt-in only

No frontend smoke is required for Step 3. Frontend playback UI is Step 4.

---

## 11. Security Checklist

- [ ] all routes use `requireAuth` and `orgContext`
- [ ] mutations use `requireVerified`, writer role, and `requireFreshRole`
- [ ] mutation routes call `assertCanMutateCall`
- [ ] cross-org call/recording is `404`, not `403`
- [ ] same-org role denial is `403`
- [ ] playback URL requires backend auth before signed URL creation
- [ ] signed URL TTL <= 900 seconds
- [ ] no object key in response
- [ ] no bucket in response
- [ ] no provider credentials/config in response
- [ ] no signed URL in activity_log payload
- [ ] no object key/bucket/checksum/raw audio in activity_log payload
- [ ] adapter errors are mapped to stable route errors without echoing internals
- [ ] default tests make no network calls

---

## 12. Completion Checklist

- [ ] recording audit action migration exists and applies
- [ ] `ActivityAction` union matches migration allow-list
- [ ] activity service has recording-specific helpers
- [ ] shared server/browser types added and registered
- [ ] `sync_shared_types` passes
- [ ] recording storage plugin or equivalent injection path exists
- [ ] S3/MinIO sentinel is replaced with real SDK adapter, or documented as deferred release blocker
- [ ] upload route creates metadata + signed PUT URL
- [ ] finalize route moves row to `available`
- [ ] list route hides internal storage metadata
- [ ] playback route returns bounded signed GET URL
- [ ] delete route tombstones metadata and coordinates object delete
- [ ] route tests cover auth/org/permission/lifecycle/errors
- [ ] audit tests prove sensitive payload exclusion
- [ ] no frontend files changed
- [ ] `npm --prefix server run typecheck` PASS
- [ ] targeted Step 3 tests PASS
- [ ] full `npm --prefix server test` PASS
- [ ] `node test/sync_shared_types.mjs` PASS
- [ ] `git diff --check` PASS
- [ ] `PHASE_8_STEP_3_FINDINGS.md` written
- [ ] `PHASE_8_MASTER.md` Step 3 checked only after verification

---

## 13. Codex Review Focus

1. Step 3 must not touch frontend playback UI.
2. Activity action migration must be standalone and lockstep with TS union.
3. No API response should expose object storage internals.
4. Playback URL route must not skip backend authorization.
5. Delete must not hard-delete metadata before object deletion outcome is known.
6. S3/MinIO provider must not silently fall back to local in production.
7. Route tests must distinguish cross-org `404` from same-org permission `403`.
8. Audit payloads must contain identifiers/counts/status only, never storage locators or signed URLs.
9. Shared type registry must include only top-level z.object schemas.
10. If AWS SDK is added, package-lock churn must be limited to that dependency tree.

---

## 14. One-Line Handoff

Step 3 should add the recording audit action migration, shared call recording types, backend service glue, authenticated upload/finalize/list/playback/delete routes, and route/audit tests, while still leaving all frontend playback UI and retention worker behavior to Steps 4 and 5.

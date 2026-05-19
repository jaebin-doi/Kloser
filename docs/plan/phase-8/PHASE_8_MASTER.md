# Phase 8 Master Plan - Call Recording

작성일: 2026-05-18

상위 인계:

- `docs/plan/phase-7/PHASE_7_CLOSEOUT_FINDINGS.md`
- `docs/plan/phase-7/PHASE_7_MASTER.md`
- `docs/plan/roadmap/BACKEND_PLAN.md`

워크플로: `AGENTS.md` Phase Workflow를 따른다. Schema 변경이 있는 기능은 schema migration -> repository + unit tests -> route/types + route tests -> frontend -> e2e 순서로 닫는다.

---

## 0. 진행 상태

> **Phase 8 Step 4 완료.** Step 1~3에 이어 Step 4 frontend playback UI까지 닫혔다. `platform/calls.html` detail panel에 6-state recording surface가 붙었고, signed URL은 DOM property로만 audio element에 결합돼 page-authored innerHTML template / visible text / console에 노출되지 않는다. 다음은 retention worker integration(Step 5).

- [x] **Step 1 - `call_recordings` metadata schema**: `call_recordings` table, org-scoped RLS, object metadata columns, retention cutoff metadata, app grants. 상세 계획은 `PHASE_8_STEP_1_PLAN.md`, 결과는 `PHASE_8_STEP_1_FINDINGS.md`.
- [x] **Step 2 - repository + storage adapter boundary**: typed repository (`server/src/repositories/callRecordings.ts`), recording storage adapter (`server/src/adapters/recordingStorage.ts`) — local filesystem provider (with two-stage path-traversal protection) + s3/minio env validator + sentinel adapter. RLS/cross-org/FK/CHECK/UNIQUE/lifecycle/retention 회귀 32 case. 계획 `PHASE_8_STEP_2_PLAN.md`, 결과 `PHASE_8_STEP_2_FINDINGS.md`.
- [x] **Step 3 - upload/finalize/playback routes**: audit action migration (`1715000029000_phase8_recording_activity_actions.sql`) + `ActivityAction` lockstep + 5 service helper. shared types (`server/src/types/callRecording.ts` + browser mirror + sync registry). `recordingStoragePlugin` Fastify decorator. `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` 실 SDK adapter (sentinel은 opt-in factory로 보존). `services/callRecordings.ts` (initiate/finalize/list/playbackUrl/delete) + `routes/callRecordings.ts` 5 endpoint + plugin-scoped error handler. route tests 21 + audit hooks tests 5. 계획 `PHASE_8_STEP_3_PLAN.md`, 결과 `PHASE_8_STEP_3_FINDINGS.md`.
- [x] **Step 4 - frontend playback UI**: `platform/api.js`에 list/playback-url/delete 3 helper. `platform/calls.html` detail panel에 recording surface 추가 — 6-state renderer(loading / none / processing / available / failed / deleted), `<audio controls preload="none">`에 signed URL을 DOM property로만 결합, 만료 30초 전 epoch-guarded auto refresh, detail close / 다른 call open 시 audio src + timer cleanup, viewer hide via `/me` role 캐시(backend는 여전히 authority). browser smoke: 데스크탑 1440×900 + 모바일 390×844 PASS, console errors 0건, object_key / bucket / signature는 visible text나 page-authored innerHTML template에 노출되지 않음. 계획 `PHASE_8_STEP_4_PLAN.md`, 결과 `PHASE_8_STEP_4_FINDINGS.md`.
- [ ] **Step 5 - retention worker integration**: Phase 7 Step 4 retention worker에 `call_recordings` 90일 metadata + object delete module 추가, aggregate audit 기록.
- [ ] **Closeout**: findings, user guide, README, full validation.

---

## 1. Phase 8 목표

Phase 8의 목표는 통화 원문 오디오를 Kloser의 existing call lifecycle에 붙이는 것이다. Phase 5~7에서 transcript, summary, reports, retention, billing caps는 닫혔지만 실제 녹취 파일 표면은 없었다.

완료 후 운영자는 다음을 할 수 있어야 한다.

- 통화 row와 연결된 녹취 metadata를 org scope 안에서 저장한다.
- private object storage에 저장된 오디오를 짧은 TTL의 signed URL로만 재생한다.
- employee/manager/admin 권한 경계가 기존 calls 정책과 일치한다.
- 삭제/보존 정책이 transcript retention과 별도로 90일 기준으로 동작한다.
- audit row에는 object key, URL, raw audio body 같은 민감 값이 들어가지 않는다.

---

## 2. 우선순위

| Priority | Work | Why |
|---|---|---|
| P0 | `call_recordings` metadata schema | RLS, FK, retention, storage key contract를 먼저 고정해야 adapter/route가 흔들리지 않는다. |
| P0 | repository + RLS tests | audio metadata는 개인정보에 가깝다. cross-org isolation을 schema 직후 증명해야 한다. |
| P0 | upload/finalize/playback API | object storage는 직접 공개하지 않고 backend authorization을 거친 signed URL로만 노출해야 한다. |
| P1 | storage adapter | dev/local 또는 MinIO, production S3-compatible path를 env로 분기하되 real provider missing config는 fail-fast. |
| P1 | playback frontend | 녹취가 제품 가치로 드러나는 표면. route가 닫힌 뒤에만 붙인다. |
| P1 | retention integration | call recording 90일 정책은 Phase 7에서 hook만 남겨둔 상태. metadata + object storage가 생긴 뒤 붙인다. |
| P2 | waveform, chunked streaming, background transcoding | 제품 품질 개선. v1 recording surface 뒤로 미룬다. |
| P2 | transcript/audio alignment | transcript timestamps와 audio seek sync. core recording보다 뒤다. |

---

## 3. Step Breakdown

### Step 1 - `call_recordings` metadata schema

**목표**: object storage에 저장될 오디오 파일을 DB에서 org-scoped로 추적할 metadata table을 만든다.

**범위**:

- `server/migrations/1715000028000_phase8_call_recordings.sql`
- `call_recordings` table
- `(org_id, call_id)` composite FK -> `calls(org_id, id)`
- RLS + FORCE RLS
- `app` role grants
- indexes for call lookup, retention sweep, object key uniqueness

**완료 기준**:

- migration up/down 적용 가능.
- bare pool에서 `SELECT count(*) FROM call_recordings`는 0.
- wrong org context에서 select/update/delete가 불가능.
- cross-org `(org_id, call_id)` raw insert는 FK로 차단.
- no route/frontend/storage SDK changes in this step.

### Step 2 - repository + storage adapter boundary

**목표**: DB access layer와 storage provider abstraction을 분리한다. Repository는 DB metadata만 책임지고, adapter는 object store operation contract만 책임진다.

**예상 파일**:

- `server/src/repositories/callRecordings.ts`
- `server/src/adapters/recordingStorage.ts`
- `server/test/phase8_step2_call_recordings_repo.test.mjs`
- `server/test/phase8_step2_recording_storage.test.mjs`

**정책**:

- repository helpers는 모두 `InCurrentOrg` suffix를 유지한다.
- adapter는 `putObject`, `deleteObject`, `createReadUrl`, `createUploadUrl` 같은 narrow method만 노출한다.
- production provider를 명시했는데 bucket/endpoint/credentials가 없으면 boot fail-fast.
- dev default는 real network 없이 테스트 가능한 provider여야 한다.

### Step 3 - upload/finalize/playback routes

**목표**: 클라이언트가 직접 object storage credential을 갖지 않도록 backend가 authorization을 담당한다.

**예상 route**:

- `POST /calls/:id/recordings/upload` - upload session 또는 signed PUT URL 발급.
- `POST /calls/:id/recordings/:recordingId/finalize` - size/content type/checksum/duration metadata 확정.
- `GET /calls/:id/recordings` - call별 recording list/status.
- `GET /calls/:id/recordings/:recordingId/playback-url` - 짧은 TTL의 signed GET URL 발급.
- `DELETE /calls/:id/recordings/:recordingId` - soft delete + object delete scheduling 또는 immediate delete.

**보안 기준**:

- `requireAuth` -> `orgContext` -> role/ownership check.
- cross-org는 404/empty로 불투명 처리.
- signed URL TTL은 짧게, 기본 5~15분.
- response에는 raw bucket credential, provider secret, full internal config를 노출하지 않는다.

### Step 4 - frontend playback UI

**목표**: `calls.html` 또는 call detail panel에서 API-backed recording surface를 제공한다.

**UX 기준**:

- loading / no recording / processing / available / failed / deleted state 구분.
- player는 signed URL을 매번 새로 받아 사용한다.
- server-returned title/status/error는 `textContent` 또는 escaping 경로만 사용한다.
- viewer/employee 권한은 backend 결과를 기준으로 표시한다. sidebar-only hiding은 보안 경계가 아니다.

### Step 5 - retention worker integration

**목표**: Phase 7 Step 4 retention worker에 recording 90일 정책을 추가한다.

**정책**:

- cutoff: `uploaded_at < now() - 90 days` 또는 explicit `retention_delete_after < now()`.
- object delete가 성공한 뒤 metadata를 deleted state로 전환하거나 hard delete한다. 최종 방식은 Step 5 plan에서 확정한다.
- aggregate-only audit: count, cutoff, provider, batch_size, batches 정도만 허용. object key/call id/raw URL은 audit payload에 넣지 않는다.

---

## 4. Cross-Cutting Rules

- **Schema-first**: upload route나 UI를 먼저 만들지 않는다.
- **RLS**: `call_recordings`는 org-scoped table이며 FORCE RLS를 켠다.
- **Composite FK**: child row drift를 막기 위해 `(org_id, call_id)` -> `calls(org_id, id)`를 사용한다.
- **No public object URLs**: object key는 내부 metadata다. 사용자-facing playback은 signed URL route를 거친다.
- **No raw audio in DB**: DB에는 metadata만 저장한다. audio body는 object storage만 담당한다.
- **No object key in audit payload**: audit row에는 민감한 storage locator를 남기지 않는다.
- **Provider fail-fast**: real S3/MinIO provider를 명시했는데 필수 env가 없으면 boot 실패.
- **Frontend XSS gate**: server-returned recording fields는 `textContent` 또는 escape 경로만 사용한다.
- **Retention-aware from day one**: schema에는 retention sweep이 효율적으로 조회할 수 있는 index와 cutoff metadata를 둔다.

---

## 5. Not In Phase 8 Unless Reprioritized

- Stripe/Toss real billing provider.
- enterprise SSO.
- multilingual transcript.
- newsletter/daily real backend.
- waveform rendering library.
- audio transcoding queue.
- live audio chunk ingestion from desktop app. Step 3 may support upload/finalize, but full desktop recorder pipeline is separate.
- legal consent workflow. 필요한 경우 별도 policy/design step으로 분리한다.

---

## 6. Phase 8 Go / No-Go

Phase 8 closeout 최소 기준:

- [ ] `call_recordings` table has FORCE RLS and composite FK isolation.
- [ ] repository tests prove bare-pool invisibility and cross-org isolation.
- [ ] upload/finalize/playback routes require authenticated org context and hide cross-org rows.
- [ ] signed playback URL never exposes provider credentials and has bounded TTL.
- [ ] frontend playback UI labels API-backed data correctly and has no unsafe server-value `innerHTML`.
- [ ] retention worker deletes or tombstones expired recordings and does not leak object keys in audit payload.
- [ ] `npm --prefix server run typecheck` PASS.
- [ ] `node test/sync_shared_types.mjs` PASS if shared types are added.
- [ ] targeted Phase 8 tests PASS.
- [ ] full `npm --prefix server test` PASS before closeout.

---

## 7. 바로 다음 작업

Step 4 frontend playback UI는 닫혔다. 다음 작업은 Step 5 retention worker integration이다.

다음 구현 단위:

1. `PHASE_8_STEP_5_PLAN.md`
2. Phase 7 Step 4 retention worker (`server/src/workers/retention*` + service)에 `call_recordings` 모듈 추가
3. `listRetentionCandidatesInCurrentOrg(cutoff, limit)`로 후보 batch select → adapter `deleteObject` → `markDeleted` 또는 `hardDelete` (Step 5 plan에서 확정)
4. `delete_pending` 상태로 막힌 row를 같은 worker에서 재시도 (Step 4 frontend의 502 fallback)
5. aggregate-only audit (`retention.recordings_deleted` 같은 신규 action — DB CHECK 추가 + `ActivityAction` lockstep 또는 기존 `retention.transcripts_deleted` 재사용 결정). object key / recording id list는 payload에 절대 포함 안 함
6. `KLOSER_RETENTION_ENABLED` gate 재사용
7. worker 단위 + 통합 테스트, network-free fixture

Step 5는 frontend와 backend route 모두 미수정. 작업 후 Phase 8 closeout (findings + USER_GUIDE + README + full validation).

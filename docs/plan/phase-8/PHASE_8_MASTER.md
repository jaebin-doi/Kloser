# Phase 8 Master Plan - Call Recording

작성일: 2026-05-18

상위 인계:

- `docs/plan/phase-7/PHASE_7_CLOSEOUT_FINDINGS.md`
- `docs/plan/phase-7/PHASE_7_MASTER.md`
- `docs/plan/roadmap/BACKEND_PLAN.md`

워크플로: `AGENTS.md` Phase Workflow를 따른다. Schema 변경이 있는 기능은 schema migration -> repository + unit tests -> route/types + route tests -> frontend -> e2e 순서로 닫는다.

---

## 0. 진행 상태

> **Phase 8 시작.** Phase 7 closeout에서 `call_recordings` audio storage + playback이 다음 제품 확장 후보로 인계됐다. Phase 7 closeout 문서의 "schema + S3/MinIO adapter + upload URL signing" 묶음은 너무 넓으므로, 본 phase에서는 repo workflow에 맞춰 첫 step을 schema migration으로만 자른다.

- [x] **Step 1 - `call_recordings` metadata schema**: `call_recordings` table, org-scoped RLS, object metadata columns, retention cutoff metadata, app grants. 상세 계획은 `PHASE_8_STEP_1_PLAN.md`, 결과는 `PHASE_8_STEP_1_FINDINGS.md`.
- [ ] **Step 2 - repository + storage adapter boundary**: typed repository, RLS/cross-org tests, storage adapter interface. 실제 S3/MinIO SDK wiring은 env fail-fast와 mock/local adapter test를 포함한다.
- [ ] **Step 3 - upload/finalize/playback routes**: authenticated upload initiation/finalize, signed playback URL, shared types, route tests. Direct URL access is not a substitute for backend authorization.
- [ ] **Step 4 - frontend playback UI**: `calls.html`/call detail surface에서 recording status, player, download link, error state를 API-backed로 표시.
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

Step 1 schema migration은 닫혔다. 다음 작업은 Step 2 repository + storage adapter boundary다.

다음 구현 단위:

1. `server/src/repositories/callRecordings.ts`
2. `server/test/phase8_step2_call_recordings_repo.test.mjs`
3. `server/src/adapters/recordingStorage.ts`
4. storage adapter env validation tests
5. `PHASE_8_STEP_2_PLAN.md`

Step 2에서도 route/frontend는 만들지 않는다. API surface는 Step 3에서 shared types와 함께 닫는다.

# Phase 8 Closeout Findings — Call Recording v1

작성일: 2026-05-19

상위 문서: `PHASE_8_MASTER.md`
단계별 결과: `PHASE_8_STEP_1_FINDINGS.md` · `PHASE_8_STEP_2_FINDINGS.md` · `PHASE_8_STEP_3_FINDINGS.md` · `PHASE_8_STEP_4_FINDINGS.md` · `PHASE_8_STEP_5_FINDINGS.md`
직전 Phase 인계: `docs/plan/phase-7/PHASE_7_CLOSEOUT_FINDINGS.md`

> Phase 8의 5개 step이 모두 닫혔다. 통화 녹취 metadata schema부터 storage adapter, REST 표면, frontend playback, retention worker integration까지 한 묶음으로 봉합한 상태다. 본 문서는 closeout 시점의 정본 결과, Go/No-Go 게이트 결과, 의도된 한계, 운영 검증 잔존 항목, 다음 단계 인계를 한 곳에 모아 둔다.

---

## 1. Phase 8 결과 요약

| Step | 주제 | 정본 문서 | 핵심 산출 |
|---|---|---|---|
| Step 1 | `call_recordings` metadata schema | `PHASE_8_STEP_1_FINDINGS.md` | `call_recordings` 신규 table + `(org_id, call_id)` composite FK → `calls(org_id, id)` + FORCE RLS + app grants + object metadata/status/content-type/checksum/retention indexes. DB에는 audio bytes / signed URL / provider credential을 저장하지 않음 |
| Step 2 | repository + storage adapter boundary | `PHASE_8_STEP_2_FINDINGS.md` | typed repository (`server/src/repositories/callRecordings.ts`, helper 전부 `InCurrentOrg` suffix), recording storage adapter (`server/src/adapters/recordingStorage.ts`) — local filesystem provider (two-stage path-traversal 차단) + s3/minio env validator + sentinel adapter. RLS / cross-org / FK / CHECK / UNIQUE / lifecycle / retention 회귀 32 case |
| Step 3 | upload / finalize / playback routes | `PHASE_8_STEP_3_FINDINGS.md` | audit action migration (`1715000029000_phase8_recording_activity_actions.sql`) + `ActivityAction` lockstep + 5 service helper. shared types (`server/src/types/callRecording.ts` + browser mirror + sync registry). `recordingStoragePlugin` Fastify decorator. `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` 실 SDK adapter (sentinel은 opt-in factory). `services/callRecordings.ts` (initiate/finalize/list/playbackUrl/delete) + `routes/callRecordings.ts` 5 endpoint + plugin-scoped error handler. route tests 21 + audit hooks tests 5 |
| Step 4 | frontend playback UI | `PHASE_8_STEP_4_FINDINGS.md` | `platform/api.js`에 list / playback-url / delete 3 helper. `platform/calls.html` detail panel에 recording surface — 6-state renderer(loading / none / processing / available / failed / deleted), `<audio controls preload="none">`에 signed URL을 DOM property로만 결합, 만료 30초 전 epoch-guarded auto refresh, detail close / 다른 call open 시 audio src + timer cleanup, viewer hide via `/me` role 캐시(backend는 여전히 authority). browser smoke: 데스크탑 1440×900 + 모바일 390×844 PASS, console errors 0건 |
| Step 5 | retention worker integration | `PHASE_8_STEP_5_FINDINGS.md` | audit action migration (`1715000030000_phase8_recording_retention_audit_action.sql`) + `ActivityAction` lockstep. repository: `listRetentionCandidatesInCurrentOrg` 단일 cutoff → two-cutoff (`explicitCutoff` + `uploadedBefore`); `listDeletePendingRetryCandidatesInCurrentOrg` 신규. config: `recordingRetentionDays`(90) / `recordingBatchSize`(100) / `recordingDeletePendingRetryAfterSec`(900). service: `runRecordingRetentionForOrg` — object storage delete를 long DB tx 밖에서 실행, `storage_object_not_found`는 idempotent success, 실패 row는 다음 tick으로 이월, aggregate audit `retention.recordings_deleted`. worker bootstrap에 `recordingStoragePlugin` 추가. result/log에 recording aggregate counter 추가. tests: repo 9 + service 12 + Phase 7 retention 회귀 갱신 14 |

---

## 2. Cross-cutting 정책 (Phase 8 동안 새로 굳어진 것)

Phase 7에서 자리잡은 lockstep / sanitizer / fail-fast 정책을 그대로 따르면서, recording 영역 고유 정책을 새로 추가했다.

- **Metadata only DB.** `call_recordings`는 audio bytes / signed URL / provider credential을 저장하지 않는다. `object_key`는 내부 locator이며 API response, audit row, frontend payload에 그대로 노출하지 않는다.
- **Composite FK.** child row drift를 막기 위해 `(org_id, call_id)` → `calls(org_id, id)`. 다른 org의 call_id를 raw insert해도 FK가 거부한다.
- **No public object URLs.** 사용자-facing playback은 backend가 발급하는 짧은 TTL signed URL을 거친다. 발급 TTL은 read 300s, upload 600s, 최대 900s.
- **Storage adapter boundary는 좁다.** adapter는 `putObject` / `deleteObject` / `createReadUrl` / `createUploadUrl` 4개 메소드만 노출한다. provider config error / input error / operation error 3-tier로 분리해 라우트가 4xx/5xx에 매핑한다.
- **Path-traversal 2-stage 방어.** local filesystem provider는 input regex 차단(`..` / encoded traversal / absolute path / backslash / control chars / double slash / >1024 chars) + `path.relative` 결과 재검증으로 filesystem write 직전에 한 번 더 막는다.
- **Provider env fail-fast.** `RECORDING_STORAGE_PROVIDER=s3` 또는 `minio`를 명시했는데 필수 env가 없으면 boot 시 throw. error 메시지에 값은 echo하지 않고 key 이름만 enumerate.
- **Aggregate-only audit.** retention sweep과 recording event audit 모두 `recording_id` / `recording_ids` / `call_id` / `call_ids` / `object_key` / `storage_bucket` / signed URL / checksum / object_version / provider endpoint / raw SDK error를 payload에 넣지 않는다. test가 substring sentinel로 강제한다.
- **3-way lockstep.** 새 audit action을 추가할 때 DB CHECK + `ActivityAction` TS union + 라우트 `ACTIVITY_ACTIONS` allow-list가 같이 움직인다. Step 3 (`recording.*` 5종)과 Step 5 (`retention.recordings_deleted` 1종)에서 같은 패턴 사용.
- **3-way shared types sync.** `server/src/types/callRecording.ts` (zod) ↔ `platform/types/callRecording.js` (JSDoc) ↔ `test/sync_shared_types.mjs` registry.
- **Frontend signed URL은 DOM property로만.** `audio.src`는 DOM property 할당 (`audioEl.src = playback.url`). page-authored innerHTML template, visible text, console 어디에도 URL이 들어가지 않는다. 단, native media element는 src를 attribute로 reflect하므로 DOM inspector에서는 보일 수 있다 (브라우저 native 동작, 보안 경계는 사용자-visible text/console/page-authored template).
- **Two-cutoff retention.** explicit `retention_delete_after`는 `explicitCutoff(=now)`로, 미설정 row는 `uploadedBefore(=now - 90d)`로 별도 필터. 단일 cutoff는 explicit override를 90일 지연 또는 갓 업로드 row를 즉시 만료시키는 부정합 발생.
- **Object delete는 long tx 밖에서.** retention worker는 transcript/email 정리를 single long tx로 commit한 뒤, recording sweep을 외부에서 row 단위로 처리하고 짧은 per-row tx로 tombstone. DB connection이 외부 HTTP latency만큼 잠기지 않는다.
- **`failedThisTick` + batch-success break.** 같은 tick 안에서 영구 실패하는 row가 counter를 부풀리지 않도록 Set으로 추적. 모든 batch가 0 successful이면 outer loop break.
- **idempotent storage_object_not_found.** retention sweep과 user DELETE 모두 `storage_object_not_found`를 success로 처리하고 tombstone을 commit. 외부 storage가 먼저 삭제된 상태에서도 자연스럽게 정합.

---

## 3. 검증 명령 (Phase 8 closeout 시점)

다음 명령이 모두 2026-05-19에 PASS인 상태로 closeout을 확인했다.

```bash
# 빌드 / 타입 / 스키마
npm --prefix server run typecheck            # PASS
npm --prefix server run db:migrate:up        # PASS (Phase 8 migrations 3종 적용 완료)
node test/sync_shared_types.mjs              # PASS (callRecording registry entry 포함)

# 백엔드 단위 / 통합 / 라우트 전수
npm --prefix server test                      # 852 total / 849 PASS / 3 skipped / 0 fail
# Phase 7 closeout 시점 769/772 → Phase 8 5 step 누적 +80 case

# Phase 8 step 단위 회귀
npx tsx --test --test-concurrency=1 \
    server/test/phase8_step2_call_recordings_repo.test.mjs \
    server/test/phase8_step2_recording_storage.test.mjs \
    server/test/phase8_step3_recording_routes.test.mjs \
    server/test/phase8_step3_recording_audit_hooks.test.mjs \
    server/test/phase8_step5_call_recordings_retention_repo.test.mjs \
    server/test/phase8_step5_recording_retention_service.test.mjs

# 위생 게이트
git diff --check                              # clean (LF/CRLF 사전 경고만, 변경 의도 외)
```

**Playwright manual smoke (Step 4 마지막 회):**

- admin desktop (1440×900): 3개 fixture(`phase8-step4-smoke/{none,processing,available}`) 검증. `available` row에서 audio element, "URL 새로고침" / "삭제" 버튼, "12초 · 4 KB" 메타 정상 렌더.
- admin mobile (390×844): single column fallback, audio native 컨트롤이 viewport / panel / surface 안에 들어가고 가로 스크롤 없음.
- XSS / locator 노출 점검: `htmlContainsObjectKey=false`, `htmlContainsBucket=false`, `visibleTextContainsSignature=false`, console error 0건.
- delete flow: 204 → render `deleted` → `loadRecordingsForCurrentCall` reconcile → "녹음 없음"으로 reconcile.

**의도적으로 미실행한 검증:**

- **MinIO / S3 실 provider integration smoke.** opt-in 통합 gate (`KLOSER_RECORDING_S3_INTEGRATION` 등) 부재. 기본 테스트는 network call 0이 정책. production deploy 또는 staging 배포 직전에 한 번 실제 provider로 putObject / deleteObject / createUploadUrl / createReadUrl 4종 검증 필요.
- **운영 retention 1 tick 검증.** `KLOSER_RETENTION_ENABLED=true` 운영 부팅 + 90일 cutoff에 도달한 row 1건 이상이 실제 tick에서 처리되는지 staging에서 확인.

---

## 4. Phase 8 Go / No-Go 최종 상태

`PHASE_8_MASTER.md §6` closeout 체크리스트 — 본 closeout 시점에 모든 항목 [x] (10/10).

- [x] `call_recordings` table has FORCE RLS and composite FK isolation (Step 1).
- [x] repository tests prove bare-pool invisibility and cross-org isolation (Step 2 — 15 case).
- [x] upload / finalize / playback routes require authenticated org context and hide cross-org rows (Step 3 — 21 case).
- [x] signed playback URL never exposes provider credentials and has bounded TTL (read 300s / max 900s, Step 3 + Step 4).
- [x] frontend playback UI labels API-backed data correctly and has no unsafe server-value `innerHTML` (Step 4 browser smoke, 6-state renderer, audio.src DOM property).
- [x] retention worker deletes or tombstones expired recordings and does not leak object keys in audit payload (Step 5 service 12 case + audit substring sentinel).
- [x] `npm --prefix server run typecheck` PASS.
- [x] `node test/sync_shared_types.mjs` PASS (callRecording entity 포함).
- [x] targeted Phase 8 tests PASS (Step 2 / 3 / 5 단위 모두 그대로 통과).
- [x] full `npm --prefix server test` PASS (852 total / 849 PASS / 3 skipped / 0 fail).

---

## 5. 남은 리스크 / 한계 (정직성)

운영 환경에 출시 가능한 v1 recording surface는 닫혔다. 다만 다음 항목은 **의도적으로 Phase 8 범위 밖에 둔** 약속이거나 product / 운영 결정이 필요한 항목이다.

### 5.1 의도된 한계 (계획대로 미수행)

- **데스크탑 / 브라우저 audio capture pipeline.** Step 3 backend의 upload / finalize 경로는 닫혔지만, 현재 사용자가 직접 새 녹취를 만들 frontend는 없다. desktop recorder 또는 browser capture UI는 별도 트랙으로 분리 (`docs/plan/roadmap/DESKTOP_APP_PLAN.md`).
- **legal consent UX.** 통화 녹음에는 사전 동의 / 안내 / 거부 옵션이 필요할 수 있다. 본 Phase는 기술 기반만 닫고 product / legal 트랙에서 별도 결정.
- **multi-recording picker.** 한 call이 여러 recording을 가질 수 있지만 (failed retry, replacement upload), UI는 primary 한 개만 표시한다 (`status='available'` 우선, 없으면 첫 row). 실 사용에서 다중 recording 사례가 잦아지면 picker 추가.
- **waveform / chunked streaming / transcoding.** 제품 품질 개선 항목. v1 recording surface 뒤로 미룬다.
- **transcript / audio timestamp alignment.** transcript timestamps와 audio seek sync. core recording이 운영 데이터로 쌓인 뒤 결정.
- **retention dead-letter mechanism.** storage 영구 실패 row가 `delete_pending`에 무한 누적되지 않도록 일정 retry 후 dead-letter 상태로 옮기는 정책. 별도 ops step에서 다룬다.

### 5.2 운영 검증 잔존

- **MinIO / S3 실 provider smoke.** Step 3 SDK adapter (presigner + PutObject/DeleteObject)는 단위 테스트에서 fixed env stub로만 검증됐다. staging에서 한 번 실제 bucket / 자격 증명으로 4종 메소드 모두 검증 권장. 정책에 따라 opt-in 통합 테스트 (`KLOSER_RECORDING_S3_INTEGRATION=true` 같은 gate)로 추가 가능.
- **`KLOSER_RETENTION_ENABLED=true` + recording 동시 가동.** Phase 7 transcript / email recovery sweep과 함께 recording sweep이 staging에서 1 tick 이상 실행되어, aggregate audit row (`retention.recordings_deleted`)와 worker 로그가 동기화되는지 확인.
- **Resend domain 검증.** Phase 7 closeout 잔존 항목 그대로 (recording과 무관, 누적 잔존만 적어 둠).

### 5.3 알려진 작은 한계

- **playback URL audit noise.** `GET /calls/:id/recordings/:rid/playback-url` 호출마다 `recording.playback_url_issued` audit row가 남는다. 자주 새로고침되는 운영 환경에서는 audit row가 많아질 수 있음. Step 3 §12에 sampling 정책 후보로 기록.
- **`storage_bucket` 컬럼은 v1에서 NULL.** S3Client가 bucket을 client config에 보관하므로 DB row는 비워 둔다. future multi-bucket per-tenant 또는 legal-hold 정책이 들어오면 이 컬럼이 채워질 자리.
- **manager same-team / other-team 라우트 회귀 부재.** seed에 manager 역할이 없어 route test에서 manager 분기 검증 불가. `assertCanMutateCall` 단위 테스트(Phase 5)는 이미 manager를 다룸. seed 확장 시 retrofit.
- **`recordingBatches` vs `transcriptBatches` 이름 통일성.** `RetentionOrgResult`에 두 종류의 batches counter가 공존. 의미는 비슷하지만 별도로 노출. 통합 여부는 worker observability dashboard 도입 시 결정.
- **viewer fixture 부재로 viewer hide 동작 browser-level 회귀 없음.** Step 4 `/me` 캐시 기반 hide는 admin / employee 시드로만 검증.

---

## 6. 변경 영향 / Backward incompat 정리

운영 데이터에 영향을 주는 변경:

- **Step 1 schema**: `call_recordings` 신규 table + 인덱스 + 트리거. 기존 테이블 미수정. 운영 데이터 영향 없음.
- **Step 3 dependency**: `server/package.json`에 `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` 추가 (~48 패키지). 서버 boot에는 항상 require되지만 network call은 provider=s3/minio에서 method 호출 시점에만 발생.
- **Step 3 server boot**: `RECORDING_STORAGE_PROVIDER`가 unset이고 `NODE_ENV=production`이면 boot fail-fast. dev / test에서는 자동으로 local provider로 fallback (default rootDir `.data/recordings`).
- **Step 5 worker boot**: worker process도 `recordingStoragePlugin`을 등록하므로 production env에서는 web과 동일한 fail-fast 정책. 기존 worker 운영 변수에 `KLOSER_RETENTION_RECORDING_*` 3종이 추가 (default 값 fallback).
- **Step 5 retention behavior**: `KLOSER_RETENTION_ENABLED=true` 환경에서 recording 90일 cutoff가 자동 적용된다. 의도된 변경. dev / test 기본 OFF는 그대로.

운영 데이터에 영향 없는 변경:

- Step 3 `activity_log_action_check` 확장 — `recording.*` 5종 ADD only.
- Step 5 `activity_log_action_check` 확장 — `retention.recordings_deleted` 1종 ADD only.
- Step 2 / 5 repository signature 변경은 service / worker 호출자만 영향. 외부 API surface 무변경.
- Step 4 frontend 변경은 server 무영향. 기존 calls.html selector 자동화가 detail panel 본문을 읽고 있다면 새 recording section은 selector 외 영역.

API 단의 backward incompat 없음:

- `GET /calls/:id` 같은 기존 endpoint shape 무변경.
- 새 5종 endpoint (`/calls/:id/recordings/*`)는 신규 surface.

---

## 7. 운영자 환경 변수 (Phase 8 신규)

`server/.env` (프로덕션 / 운영 단계):

| Key | 필수 여부 | Default / 동작 |
|---|---|---|
| `RECORDING_STORAGE_PROVIDER` | production 필수 | `local` / `s3` / `minio` 중 하나. 미설정 시 production boot fail-fast, dev/test는 자동 `local` |
| `RECORDING_STORAGE_LOCAL_ROOT` | local 모드 선택 | 기본 `.data/recordings`. `RECORDING_STORAGE_PROVIDER=local`에서 사용 |
| `RECORDING_STORAGE_BUCKET` | s3 / minio 필수 | bucket name. 누락 시 boot fail-fast |
| `RECORDING_STORAGE_REGION` | s3 / minio 필수 | AWS region 또는 minio region 문자열 |
| `RECORDING_STORAGE_ENDPOINT` | minio 필수 | endpoint URL. s3에서는 optional (AWS endpoint) |
| `RECORDING_STORAGE_ACCESS_KEY_ID` | s3 / minio 필수 | access key. 메시지에 값 echo 안 함 |
| `RECORDING_STORAGE_SECRET_ACCESS_KEY` | s3 / minio 필수 | secret. 메시지에 값 echo 안 함 |
| `RECORDING_STORAGE_SESSION_TOKEN` | s3 / minio 선택 | 임시 자격 증명 경로 |
| `RECORDING_STORAGE_FORCE_PATH_STYLE` | s3 / minio 선택 | minio 기본 `true`, s3 기본 `false`. 명시 시 그 값 |
| `RECORDING_UPLOAD_MAX_BYTES` | 선택 | 단일 upload size cap. 기본 250 MB |
| `KLOSER_RETENTION_RECORDING_DAYS` | 선택 | 기본 90, 범위 1..36500 |
| `KLOSER_RETENTION_RECORDING_BATCH_SIZE` | 선택 | 기본 100, 범위 1..1000 |
| `KLOSER_RETENTION_RECORDING_DELETE_PENDING_RETRY_AFTER_SEC` | 선택 | 기본 900, 범위 60..86400 |

기존 마스터 게이트 `KLOSER_RETENTION_ENABLED`는 Phase 7 그대로 유지. recording sweep도 같은 게이트로 활성화된다.

---

## 8. Phase 8 이후 인계

### 8.1 다음 트랙 후보

- **결제 provider 연동 Phase.** Phase 7 closeout에서 이월된 항목 (`docs/plan/phase-7/PHASE_7_CLOSEOUT_FINDINGS.md §7.1`). Stripe Checkout 또는 Toss 결제. `organization_billing_profiles.external_*` 컬럼이 이 연동의 hook이다.
- **데스크탑 / 브라우저 audio capture pipeline.** Phase 8 v1은 backend / API / playback / retention까지 닫았다. 사용자가 직접 새 녹취를 생성할 capture UI가 다음 product 단계의 핵심.
- **retention dead-letter mechanism.** `delete_pending` 무한 누적 방어. recording sweep tick에서 일정 retry 이상 실패한 row를 별도 상태로 옮기고 운영 알림에 노출.
- **MinIO / S3 통합 smoke + opt-in gate.** `KLOSER_RECORDING_S3_INTEGRATION=true` 같은 명시적 env로 실 provider 4종 메소드 호출 검증 자동화.
- **multi-recording picker UX.** 한 call의 recording 다중 row 사용 사례가 운영 데이터로 보이기 시작하면 detail panel에 picker 추가.
- **legal consent UX.** 통화 녹음 사전 동의 / 안내 / 거부 옵션. 별도 policy + design step.

### 8.2 P2 / P3 항목 (현재 우선순위 낮음)

- waveform 렌더링.
- audio transcoding queue.
- transcript / audio timestamp alignment.
- playback URL audit sampling.
- live audio chunk ingestion from desktop app.

---

## 9. 다음 세션 entry point

다음 세션은 위 §8.1 후보 중 하나를 선택해 plan 수립부터 시작한다. 운영 입장에서는 **결제 provider Phase**가 매출 성립의 마지막 게이트로 우선순위가 높다. 제품 입장에서는 **desktop recorder pipeline**이 녹취 가치를 사용자가 직접 만들어 낼 수 있게 하므로 마케팅 견인 효과가 크다. 선택은 운영팀 / product 합의 후 결정.

문서 진입점:

- Phase 8 master: `docs/plan/phase-8/PHASE_8_MASTER.md`
- 본 closeout: `docs/plan/phase-8/PHASE_8_CLOSEOUT_FINDINGS.md`
- 사용자 가이드: `docs/USER_GUIDE_PHASE_8.md` + `docs/USER_GUIDE_PHASE_8.html`
- 다음 트랙 후보: `docs/plan/roadmap/BACKEND_PLAN.md`, `docs/plan/roadmap/DESKTOP_APP_PLAN.md`, `docs/plan/phase-7/PHASE_7_CLOSEOUT_FINDINGS.md §7.1`

---

## 10. 참조

- 상위 master: `PHASE_8_MASTER.md`
- 단계별 plan: `PHASE_8_STEP_1_PLAN.md` ~ `PHASE_8_STEP_5_PLAN.md`
- 단계별 결과: `PHASE_8_STEP_1_FINDINGS.md` ~ `PHASE_8_STEP_5_FINDINGS.md`
- 사용자 가이드: `docs/USER_GUIDE_PHASE_8.md` · `docs/USER_GUIDE_PHASE_8.html`
- 직전 Phase 인계: `docs/plan/phase-7/PHASE_7_CLOSEOUT_FINDINGS.md`
- Phase 7 retention 기반: `docs/plan/phase-7/PHASE_7_STEP_4_FINDINGS.md`
- 데스크탑 트랙: `docs/plan/roadmap/DESKTOP_APP_PLAN.md`

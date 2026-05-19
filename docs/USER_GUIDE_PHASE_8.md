# Kloser Phase 8 사용자 가이드 — 통화 녹취 (Call Recording v1)

> Phase 8은 Phase 1~7이 닫아 둔 통화 라이프사이클 위에 **통화 녹취 표면**을 새로 추가한 단계입니다. 통화 페이지에서 녹취 metadata를 확인하고, 짧은 TTL의 안전한 링크로 audio를 재생하고, 권한에 따라 삭제하고, 90일이 지난 녹취가 자동으로 정리되는 흐름까지 한 묶음으로 닫았습니다.

작성일: 2026-05-19 · 상위 문서: `docs/plan/phase-8/PHASE_8_MASTER.md` · 정본 결과: `docs/plan/phase-8/PHASE_8_CLOSEOUT_FINDINGS.md`.

---

## 1. Phase 8의 목적

Phase 1~7까지의 시스템은 통화 메타데이터 / transcript / 액션 / 보고서 / 운영 게이트가 모두 닫혔지만, **실 통화 audio 자체를 다루는 표면이 없었습니다**.

Phase 8이 채운 5가지 빈자리:

1. **녹취 metadata를 org 안에서 안전하게 저장한다.** `call_recordings` 테이블은 FORCE RLS + composite FK로 다른 회사의 녹취 row를 절대 볼 수 없습니다. DB에는 audio bytes / signed URL / provider credential을 저장하지 않고 metadata만 둡니다.
2. **object storage를 직접 노출하지 않는다.** 사용자는 backend가 발급하는 짧은 TTL signed URL로만 audio에 접근합니다. bucket name / object key / provider 자격 증명은 frontend / audit / API response 어디에도 노출되지 않습니다.
3. **REST 표면으로 upload / finalize / list / playback / delete를 닫는다.** 5종 endpoint가 권한 / org context / state guard를 거치고, 모든 mutation이 audit row를 남깁니다.
4. **calls 페이지에서 녹취를 직접 본다.** 통화 상세 패널에 6-state recording surface (loading / 없음 / 처리 중 / 재생 가능 / 실패 / 삭제됨)가 붙어 audio 컨트롤이 정상 동작합니다.
5. **90일 retention 정책을 자동으로 강제한다.** Phase 7 retention worker에 통합되어, 90일이 지난 녹취는 object storage에서 삭제되고 metadata가 tombstone 처리됩니다.

Phase 8이 끝나면 운영자 / 평가자는 **REST 또는 데스크탑 / 브라우저 capture 도구로 audio 업로드 → finalize → 통화 페이지에서 재생 → 권한별 삭제 → 90일 자동 정리** 흐름을 실제 운영처럼 진행할 수 있습니다 (capture UI는 별도 트랙, §10 참고).

---

## 2. Phase 8에서 가능해진 것

운영 환경 시점 기준 (`RECORDING_STORAGE_PROVIDER=s3` 또는 `minio`, `KLOSER_RETENTION_ENABLED=true`):

- 통화별로 녹취 metadata가 org 안에 저장되고, 다른 회사 사용자는 read / write / delete 어떤 방법으로도 접근할 수 없습니다.
- 클라이언트가 object storage 자격 증명을 직접 갖지 않습니다. backend가 발급하는 5~15분 TTL signed URL로만 upload / playback이 가능합니다.
- 통화 상세 패널에서 녹취 상태가 처리 단계별로 표시되고, "재생 가능" 상태에서는 audio 컨트롤로 즉시 재생할 수 있습니다.
- 만료 직전(30초 전) signed URL이 자동으로 갱신되어 재생이 끊기지 않습니다. detail을 닫거나 다른 통화로 전환하면 audio src / refresh timer가 즉시 정리됩니다.
- viewer 역할은 삭제 버튼을 보지 않습니다. employee / manager / admin은 backend 권한 매트릭스에 따라 본인 / 팀 / 조직 범위 안의 녹취만 삭제할 수 있습니다.
- 90일이 지난 녹취는 retention worker가 자동으로 object storage에서 삭제하고 metadata를 tombstone 처리합니다. 운영자 추적용 aggregate audit row 1건만 남고 object key / recording id는 audit에 들어가지 않습니다.

---

## 3. 데이터 모델 — `call_recordings`

녹취 metadata는 `call_recordings` 테이블에 저장됩니다.

핵심 컬럼 (사용자가 알 필요가 있는 부분만):

- `id` — recording 식별자 (UUID, 같은 org 안에서 unique)
- `call_id` — 연결된 통화 (composite FK `(org_id, call_id) → calls(org_id, id)` ON DELETE CASCADE)
- `status` — 7-state lifecycle (§4 참고)
- `content_type` — `audio/webm` / `audio/ogg` / `audio/mpeg` / `audio/mp4` / `audio/wav` 5종 허용
- `duration_seconds`, `size_bytes`, `codec` — playback / 메타 표시용
- `recorded_at`, `uploaded_at` — 시점 정보
- `retention_delete_after` — per-row 명시 cutoff (NULL이면 `uploaded_at + 90일` 정책 적용)
- `deleted_at`, `error_message` — 삭제 / 실패 표시
- `metadata` — JSON object (운영용)

API 응답 / frontend / audit에는 다음 필드가 **노출되지 않습니다**:

- `org_id` (auth가 이미 강제)
- `storage_provider` / `storage_bucket` / `object_key` / `object_version` — 내부 storage locator
- `checksum_sha256` — 운영용 무결성 marker
- `metadata` — 운영용

RLS:

- 모든 org가 본인 row만 SELECT / INSERT / UPDATE / DELETE 가능 (`org_id = current_app_org_id()` + FORCE RLS).
- bare pool (org context 없음) → 0 rows.
- 다른 org의 `call_id`를 raw insert해도 composite FK가 거부 (`23503`).

---

## 4. Recording Lifecycle (7-state)

```
upload_pending  →  uploaded  →  processing  →  available
                                     ↓
                                  failed
       ↓
   delete_pending  →  deleted
```

| status | 의미 |
|---|---|
| `upload_pending` | metadata row 생성됨. signed upload URL 발급됨. 아직 object storage에 byte 없음 |
| `uploaded` | finalize 호출됨. size / checksum 검증 완료 |
| `processing` | (v1 사용 안 함) future transcoding 단계 자리 |
| `available` | 재생 가능 |
| `failed` | upload 또는 finalize 실패. `error_message`에 사유 (bucket / key 미포함) |
| `delete_pending` | 사용자 또는 retention sweep이 삭제 시작. object 삭제 대기 |
| `deleted` | object 삭제 완료. metadata는 audit 보존을 위해 row는 남음 (tombstone) |

v1에서는 finalize가 성공하면 자동으로 `uploaded → available` 전환됩니다. transcoding pipeline이 추가되면 `processing` state가 끼게 됩니다.

---

## 5. REST 표면 (Step 3)

모든 endpoint는 `requireAuth` + `orgContext` + (mutation의 경우 `requireVerified` + role 매트릭스 + `requireFreshRole`) 게이트를 거칩니다. cross-org는 404 / empty로 불투명 처리합니다.

### 5.1 `POST /calls/:id/recordings/upload`

- 동작: metadata row 생성 (`upload_pending`) + signed PUT URL 발급.
- request body: `content_type`, `size_bytes`, optional `duration_seconds` / `codec` / `recorded_at`.
- response: `recording`(sanitized) + `signed_url`(method / url / headers / expires_at).
- 권한: admin / manager / employee. viewer 차단.
- 에러:
  - 400 `invalid_input` — content_type / checksum / size 형식 오류
  - 403 `forbidden` — role / ownership 거부
  - 404 `not_found` — call이 다른 org이거나 없음
  - 413 `recording_too_large` — size_bytes > 250MB (env `RECORDING_UPLOAD_MAX_BYTES`로 조정)

### 5.2 `POST /calls/:id/recordings/:recordingId/finalize`

- 동작: object를 storage에 올린 뒤 backend에 finalize 요청. size / checksum / metadata 확정.
- request body: `size_bytes`, optional `checksum_sha256`, `duration_seconds`, `codec`.
- response: 200 + sanitized recording (status=`available`).
- 에러:
  - 404 — recording이 cross-org이거나 path call_id와 일치하지 않음
  - 409 `invalid_recording_state` — 이미 `available` 등 잘못된 state에서 호출 (`current_status` echo)

### 5.3 `GET /calls/:id/recordings`

- 동작: 해당 call의 active recording 배열. tombstoned row는 제외.
- response: `items: CallRecording[]` (sanitized).
- cross-org call → 404.

### 5.4 `GET /calls/:id/recordings/:recordingId/playback-url`

- 동작: 짧은 TTL의 signed GET URL 발급.
- 권한: 통화 read 권한이 있는 모든 멤버 (admin / manager / employee / viewer).
- response: `url`, `method='GET'`, `headers`, `expires_at`. TTL 기본 300초, 최대 900초.
- 에러:
  - 404 — recording이 cross-org / 없음
  - 409 `invalid_recording_state` — `available`이 아닌 상태

### 5.5 `DELETE /calls/:id/recordings/:recordingId`

- 동작: 2-phase delete.
  1. `markDeletePending` (짧은 tx) + audit `recording.delete_requested`
  2. adapter.`deleteObject` (DB tx 밖)
  3. `markDeleted` (짧은 tx) + audit `recording.deleted`
- response: 204.
- 에러:
  - 403 — viewer 또는 cross-team employee
  - 404 — recording이 cross-org / 이미 tombstone됨 (`call_action_items` DELETE와 동일 contract)
  - 502 `recording_storage_failed` — storage 응답 실패. row는 `delete_pending`에 남고 retention sweep이 재시도

### 5.6 Audit 이벤트 (5종)

모든 mutation은 audit row를 남깁니다. payload는 **이름 / 수치 / state code만** 포함하고 raw URL / object key / checksum 같은 민감 값은 포함하지 않습니다.

| Action | Payload (허용 키 예시) |
|---|---|
| `recording.upload_initiated` | recording_id, content_type, size_bytes, duration_seconds, ttl_seconds |
| `recording.finalized` | recording_id, content_type, size_bytes, duration_seconds |
| `recording.playback_url_issued` | recording_id, ttl_seconds |
| `recording.delete_requested` | recording_id, previous_status |
| `recording.deleted` | recording_id |

> Audit에는 절대 들어가지 않는 값: `object_key`, `storage_bucket`, `bucket`, `signed_url`, `playback_url`, `upload_url`, `checksum`, `object_version`, `provider_secret`, `access_key`, `secret_access_key`, raw audio.

---

## 6. 프론트엔드 — 통화 페이지 (`platform/calls.html`)

### 6.1 위치

통화 페이지 우측 상세 패널 안, 메모 작성 영역 바로 위에 "녹음" 라벨이 붙은 카드가 추가됐습니다. 카드 하나가 6-state renderer로 동작합니다.

### 6.2 6 상태 화면

| state | 표시 |
|---|---|
| 로딩 | "녹음 정보를 불러오는 중…" + 로딩 배지 |
| 녹음 없음 | "이 통화에는 녹음 파일이 없습니다." |
| 처리 중 | "업로드 대기 / 처리 대기 / 처리 중" 중 하나 + 새로고침 버튼 |
| 재생 가능 | "재생 가능" 배지 + `<audio controls preload="none">` + URL 새로고침 / 삭제 버튼 + 길이 · 용량 · 코덱 메타 |
| 실패 | "실패" 배지 + 사유 (escape됨, bucket / key 미포함) |
| 삭제됨 | "삭제됨" 배지 |

길이 / 용량 / 코덱은 모두 helper로 포맷팅한 뒤 escape됩니다. server-supplied 값은 어디에도 raw로 들어가지 않습니다.

### 6.3 Audio 재생 흐름

- audio element 생성 시점에는 `src`가 비어 있습니다.
- 재생 가능 상태에서 backend가 발급한 signed URL을 `audio.src = playback.url` 형태로 DOM property로만 결합합니다. page-authored innerHTML 템플릿 / visible text / console 어디에도 URL이 들어가지 않습니다 (브라우저 native 동작상 DOM inspector / outerHTML에서는 media `src` attribute가 보일 수 있습니다 — 이는 native audio playback의 브라우저 반영입니다).
- `preload="none"` 정책으로 사용자가 재생 버튼을 누른 시점에만 byte fetch가 발생합니다.

### 6.4 자동 URL 새로고침

- 만료 30초 전 자동 갱신 (너무 가까우면 15초 floor).
- 새로고침은 monotonic epoch + 현재 통화 / 녹취 id가 모두 일치할 때만 동작 — detail 전환 race condition으로 잘못된 통화의 URL이 적용되지 않습니다.
- audio 재생 중 에러가 나면 1회 자동 재시도 후 멈춥니다. 무한 재시도 루프 없음.

### 6.5 Detail close / 통화 전환

- 다른 통화 detail로 전환하거나 detail을 닫으면 즉시:
  - audio.src 해제
  - refresh timer 취소
  - epoch +1로 in-flight 요청 무효화
  - surface DOM clear

### 6.6 삭제 버튼

- viewer 역할에게는 표시되지 않습니다 (`/me.membership.role` 캐시 기반 hide).
- 표시되더라도 backend가 권한 authority — viewer가 직접 호출하면 403.
- 클릭 시 204면 즉시 "삭제됨"으로 표시 → server truth로 reconcile.
- 502 (storage 실패) → "저장소 삭제 실패. 잠시 후 다시 시도해주세요." (retention sweep이 백그라운드에서 재시도).

---

## 7. 보존 정책 (Step 5)

### 7.1 정책 한 줄

```
업로드 후 90일 또는 explicit retention_delete_after 시각 도달 → object storage 삭제 + metadata tombstone
```

### 7.2 활성화

운영 환경에서 `KLOSER_RETENTION_ENABLED=true`를 설정합니다. dev / test 기본 OFF. Phase 7 transcript / email recovery sweep과 같은 마스터 게이트를 공유합니다.

### 7.3 두 cutoff

retention worker는 row마다 두 가지 cutoff를 동시에 검사합니다.

- **`explicitCutoff`** (보통 `now`) — `retention_delete_after`가 명시된 row에만 적용. per-row override.
- **`uploadedBefore`** (보통 `now - 90일`) — `retention_delete_after`가 없는 row의 default 정책.

단일 cutoff를 쓰면 explicit override가 90일 지연되거나 갓 업로드된 row가 즉시 만료되는 부정합이 있어, 의도적으로 분리했습니다.

### 7.4 처리 흐름

1. 후보 row 조회 (`uploaded` / `available` / `failed` 중에서, 두 cutoff 조건 OR).
2. 각 row에 대해 `adapter.deleteObject(bucket, object_key, object_version)`.
   - `storage_object_not_found` → idempotent success.
   - 그 외 실패 → 카운터 증가, 다음 tick으로 이월.
3. 성공한 row만 짧은 tx로 `markDeleted` (status=`deleted`, `deleted_at=now`).
4. 사용자 DELETE가 storage 실패로 `delete_pending`에 남은 row도 같은 sweep에서 retry. retry는 `updated_at`이 `now - 15분`보다 오래된 row만 (운영자가 만들고 있는 in-flight delete를 race하지 않도록 floor).

### 7.5 Aggregate audit

한 tick에 1건 이상 처리되면 org당 1개 audit row가 작성됩니다.

```json
{
  "actor_type": "system",
  "cutoff": "...",
  "uploaded_before": "...",
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

> 강제로 **들어가지 않는** 값: recording_id, recording_ids, call_id, call_ids, object_key, storage_bucket, signed URL, checksum, object_version, provider endpoint, access key, secret, raw audio.

### 7.6 Worker 로그

```
[retention-sweep] orgs=N transcriptsDeleted=N emailRecovered=N recordingsDeleted=N recordingObjectNotFound=N recordingDeleteFailures=N failedOrgs=N
```

aggregate counter만 남고 row 단위 정보는 노출되지 않습니다.

---

## 8. 권한 매트릭스 (요약)

| Endpoint | admin | manager | employee | viewer |
|---|---|---|---|---|
| POST upload | ✅ | ✅ (본인 팀) | ✅ (본인 통화) | ❌ 403 |
| POST finalize | ✅ | ✅ (본인 팀) | ✅ (본인 통화) | ❌ 403 |
| GET list | ✅ | ✅ | ✅ | ✅ (read-only) |
| GET playback-url | ✅ | ✅ | ✅ | ✅ |
| DELETE | ✅ | ✅ (본인 팀) | ✅ (본인 통화) | ❌ 403 |

manager / employee 분기는 `assertCanMutateCall` 매트릭스 (Phase 5)에 따릅니다. cross-org 또는 권한 거부는 404 / 403으로 불투명 처리됩니다.

---

## 9. 보안 정책 요약

| 항목 | 보장 방법 |
|---|---|
| object_key / bucket | 응답 / audit / frontend / 로그 어디에도 노출되지 않음. shared type에서 schema 레벨로 제외 |
| signed URL | 짧은 TTL (read 300s, upload 600s, 최대 900s), 만료 30초 전 자동 갱신, visible text / page-authored innerHTML / console 노출 없음 |
| audio bytes | DB에 저장하지 않음. object storage에만 저장 |
| provider credential | env에서만 읽음. error 메시지에 값 echo 없음, key 이름만 enumerate |
| frontend XSS | `error_message` 같은 server-supplied 값은 escapeHtml 또는 textContent. raw `innerHTML` 미사용 |
| RLS | FORCE RLS + `(org_id, call_id)` composite FK. bare pool / cross-org 모두 0 rows / 23503 |
| audit | row 단위 식별자 / locator 미포함. aggregate counter만 |
| path traversal (local provider) | 2-stage 차단 — input regex (`..` / encoded / absolute / backslash / control char / >1024 chars) + `path.relative` 재검증 |
| upload size | 단일 upload 250 MB cap. 초과 시 413 |
| provider env 누락 | production boot fail-fast. 메시지에 값 echo 없음 |

---

## 10. 의도된 한계 (Phase 8 v1 미포함)

- **데스크탑 / 브라우저 audio capture pipeline.** Phase 8 v1은 backend / API / playback / retention까지만 닫았습니다. 사용자가 직접 새 녹취를 만들 capture UI는 별도 트랙(`docs/plan/roadmap/DESKTOP_APP_PLAN.md`)에서 진행됩니다.
- **legal consent UX.** 통화 녹음 사전 동의 / 안내 / 거부 옵션은 product + legal 트랙에서 별도 결정합니다.
- **multi-recording picker.** 한 통화의 녹취 row가 여러 개일 때 (failed retry, replacement upload), UI는 primary 한 개만 표시합니다. 사용 사례가 잦아지면 picker 추가.
- **waveform / transcoding / transcript-audio alignment.** 제품 품질 개선 항목. v1 뒤로 미룹니다.
- **MinIO / S3 실 provider integration smoke 자동화.** opt-in 통합 gate 부재. staging 배포 직전에 1회 수동 검증 권장.
- **retention dead-letter mechanism.** storage 영구 실패 row가 `delete_pending`에 무한 누적되지 않도록 일정 retry 후 dead-letter로 옮기는 정책. 운영 데이터가 쌓인 뒤 별도 step에서 다룹니다.

---

## 11. 운영자 환경 변수 (Phase 8 신규)

| Key | 필수 여부 | Default / 동작 |
|---|---|---|
| `RECORDING_STORAGE_PROVIDER` | production 필수 | `local` / `s3` / `minio` 중 하나. 미설정 시 production boot fail-fast, dev/test는 `local` |
| `RECORDING_STORAGE_LOCAL_ROOT` | local 선택 | 기본 `.data/recordings` |
| `RECORDING_STORAGE_BUCKET` | s3 / minio 필수 | bucket name |
| `RECORDING_STORAGE_REGION` | s3 / minio 필수 | region 문자열 |
| `RECORDING_STORAGE_ENDPOINT` | minio 필수 / s3 선택 | endpoint URL |
| `RECORDING_STORAGE_ACCESS_KEY_ID` | s3 / minio 필수 | access key |
| `RECORDING_STORAGE_SECRET_ACCESS_KEY` | s3 / minio 필수 | secret access key |
| `RECORDING_STORAGE_SESSION_TOKEN` | s3 / minio 선택 | 임시 자격 증명 |
| `RECORDING_STORAGE_FORCE_PATH_STYLE` | s3 / minio 선택 | minio 기본 true / s3 기본 false |
| `RECORDING_UPLOAD_MAX_BYTES` | 선택 | 단일 upload size cap (기본 250 MB) |
| `KLOSER_RETENTION_ENABLED` | 운영 ON | retention sweep 마스터 게이트 (Phase 7과 공유) |
| `KLOSER_RETENTION_RECORDING_DAYS` | 선택 | 기본 90 (범위 1..36500) |
| `KLOSER_RETENTION_RECORDING_BATCH_SIZE` | 선택 | 기본 100 (범위 1..1000) |
| `KLOSER_RETENTION_RECORDING_DELETE_PENDING_RETRY_AFTER_SEC` | 선택 | 기본 900 (범위 60..86400) |

---

## 12. 에러 응답 한눈에

| 상황 | status | code |
|---|---|---|
| 인증 토큰 없음 / 만료 | 401 | unauthorized |
| 권한 부족 (viewer 또는 cross-team employee) | 403 | forbidden |
| 다른 org 통화 / 녹취 | 404 | not_found |
| 통화에 녹취가 없음 / 이미 tombstone됨 | 404 | not_found |
| content_type / checksum / size 형식 오류 | 400 | invalid_input |
| state 조건 위반 (이미 available, 이미 deleted 등) | 409 | invalid_recording_state |
| size_bytes > 250 MB | 413 | recording_too_large |
| object storage 일시 실패 | 502 | recording_storage_failed |
| boot 시 provider 미설정 / env 누락 | (boot fail-fast) | — |

`409 invalid_recording_state` 응답은 `current_status` 필드도 함께 echo합니다 (예: `{ "error": "invalid_recording_state", "current_status": "uploaded" }`).

---

## 13. Phase 8 검증 명령

closeout 시점(2026-05-19)에 다음이 모두 PASS인 상태를 확인했습니다.

```bash
npm --prefix server run typecheck            # PASS
npm --prefix server run db:migrate:up        # PASS (Phase 8 migrations 적용)
node test/sync_shared_types.mjs              # PASS (callRecording entity 포함)

npm --prefix server test                      # 852 total / 849 PASS / 3 skipped / 0 fail
```

Browser smoke (Playwright, Step 4 마지막 회):

- 데스크탑 1440×900 + 모바일 390×844 모두 6-state renderer 정상.
- audio 재생 / URL 새로고침 / 삭제 reconcile 흐름 정상.
- console errors 0건. signed URL이 page-authored DOM / visible text에 노출되지 않음.

---

## 14. 다음 Phase 인계

운영 출시 직전 게이트(Phase 7) + v1 녹취 표면(Phase 8)이 모두 닫혔습니다. 다음 작업 후보:

- **결제 provider 연동** (별도 Phase) — Phase 7 closeout에서 이월된 항목. Stripe Checkout 또는 Toss 결제 위젯. 외부 돈 이동 / 회계 계약 / webhook / invoice가 동반되어 본 repo의 Phase와 분리.
- **데스크탑 / 브라우저 capture pipeline** — Phase 8 v1 backend가 닫혔으므로 frontend capture UI만 추가하면 사용자가 직접 녹취를 만들 수 있습니다. `docs/plan/roadmap/DESKTOP_APP_PLAN.md`.
- **legal consent UX** — 별도 product + legal 트랙.
- **MinIO / S3 통합 smoke + opt-in gate** — `KLOSER_RECORDING_S3_INTEGRATION=true` 같은 명시적 env로 실 provider 4종 메소드 호출 검증 자동화.
- **retention dead-letter mechanism** — `delete_pending` 무한 누적 방어.
- **multi-recording picker / waveform / transcoding / transcript-audio alignment** — 제품 품질 트랙.

자세한 인계 노트는 `docs/plan/phase-8/PHASE_8_CLOSEOUT_FINDINGS.md §5`와 `§8`을 참고하세요.

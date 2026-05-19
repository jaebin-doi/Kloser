# Phase 9 Master Plan - Browser Audio Capture Pipeline

작성일: 2026-05-19

상위 문서: `docs/plan/phase-8/PHASE_8_CLOSEOUT_FINDINGS.md`, `docs/USER_GUIDE_PHASE_8.md`
관련 보류 트랙: `docs/plan/roadmap/DESKTOP_APP_PLAN.md`

> Phase 9는 Phase 8에서 닫은 call recording backend/upload/playback/retention 표면 위에 **사용자가 직접 녹취를 생성하는 browser-first capture UI**를 붙이는 단계다. PC 네이티브 앱(WASAPI loopback, 소프트폰 감지, 자동 업데이트)은 여전히 별도 보류 트랙으로 두고, 이번 Phase는 브라우저 `MediaRecorder` 기반 수동 녹음 → Phase 8 upload/finalize API → 기존 calls detail playback surface로 이어지는 최소 운영 가능 흐름을 닫는다.

---

## 0. 진행 상태

> **계획 수립 단계.** 구현은 아직 시작하지 않는다. Phase 8은 closeout 완료 상태이고, Phase 9는 browser capture를 첫 product-value layer로 선택한다.

- [ ] **Step 1 - capture UX + browser capability plan**: 권한별 UI, legal notice placeholder, MediaRecorder capability matrix, failure/error vocabulary 확정.
- [ ] **Step 2 - frontend recorder implementation**: `platform/calls.html` detail panel에 start/pause/resume/stop/discard/upload recorder controls 추가. Phase 8 upload/finalize API 재사용.
- [ ] **Step 3 - upload robustness + client-side validation**: max size/duration guard, MIME negotiation, retry/discard/reconcile, offline/network failure handling.
- [ ] **Step 4 - browser smoke + security audit**: desktop/mobile browser smoke, permission denied/no device cases, object locator/signed URL non-exposure, innerHTML gate review.
- [ ] **Step 5 - user guide + closeout**: Phase 9 findings, `docs/USER_GUIDE_PHASE_9.md`, README/docs index 갱신, final validation.

---

## 1. 목표

Phase 8은 "녹취 파일을 안전하게 저장하고 재생하는 표면"을 닫았지만, 사용자가 녹취를 직접 만드는 UI는 범위 밖이었다. Phase 9의 목표는 다음 흐름을 실제 사용자 조작으로 닫는 것이다.

1. 사용자가 통화 상세 패널에서 녹음 시작을 누른다.
2. 브라우저가 microphone 권한을 요청하고 `MediaRecorder`로 audio blob을 만든다.
3. 사용자가 중지 후 미리듣기 / 폐기 / 업로드를 선택한다.
4. frontend가 Phase 8 `POST /calls/:id/recordings/upload`로 metadata row + signed upload URL을 받고, object storage로 blob을 업로드한다.
5. frontend가 `POST /calls/:id/recordings/:recordingId/finalize`를 호출한다.
6. 기존 Phase 8 recording surface가 list를 reload하고 `available` playback 상태를 보여준다.

핵심은 backend API shape를 새로 만들지 않고 Phase 8 contract를 그대로 사용하는 것이다. 필요한 변경은 주로 `platform/calls.html`과 `platform/api.js` helper 보강에 제한한다.

---

## 2. 범위

### In Scope

- Browser `MediaRecorder` 기반 수동 녹음.
- `platform/calls.html` detail panel 안의 recording capture controls.
- Browser capability detection:
  - `navigator.mediaDevices.getUserMedia`
  - `window.MediaRecorder`
  - supported MIME type selection.
- Microphone-only v1.
- Recording duration / size client-side guard.
- Stop 후 local preview (`URL.createObjectURL`)와 explicit discard.
- Phase 8 upload/finalize/list/playback/delete helpers 재사용.
- Upload progress 표시.
- Permission denied / no microphone / unsupported browser / upload failed / finalize failed UI.
- Signed URL, object key, bucket, checksum, provider metadata를 UI/console/audit에 노출하지 않는 frontend audit.
- Browser smoke:
  - mock `MediaRecorder` path
  - permission denied path
  - upload/finalize success path
  - upload/finalize failure reconcile path
  - mobile layout no overflow.

### Out of Scope

- Windows 네이티브 desktop app.
- WASAPI loopback / system audio capture.
- 소프트폰 자동 통화 감지.
- 실시간 STT streaming (`audio_chunk` WebSocket).
- waveform / transcript-audio alignment.
- transcoding queue.
- multi-recording picker.
- legal consent의 최종 법무 문구 확정.
- S3/MinIO real-provider integration smoke. 이는 운영 hardening 트랙으로 분리한다.

---

## 3. Product / UX Contract

### 3.1 사용자 위치

첫 화면은 `platform/calls.html`의 call detail panel이다. Phase 8 playback surface와 같은 "녹취" section 안에서 capture controls를 보여준다.

권장 배치:

- recording 없음: "녹음 시작" primary action.
- recording 처리 중 / 재생 가능: 기본은 playback surface 유지. v1은 새 녹음을 덮어쓰기하지 않는다.
- failed row만 있는 경우: "다시 녹음" action 허용 가능.
- recording available이 이미 있으면 "새 녹음"은 v1에서 숨긴다. multi-recording picker가 없기 때문이다.

### 3.2 상태 모델

Frontend-local capture state는 Phase 8 DB lifecycle과 분리한다.

| Local State | 의미 |
|---|---|
| `idle` | 녹음 UI 대기 |
| `requesting_permission` | browser microphone 권한 요청 중 |
| `recording` | MediaRecorder active |
| `paused` | MediaRecorder paused, browser 지원 시만 |
| `preview` | stopped blob local preview 가능 |
| `uploading` | signed upload URL 발급 + object upload + finalize 진행 |
| `uploaded` | finalize 성공, server list reload 대기 |
| `error` | 권한/장치/업로드/finalize 실패 |

DB recording status는 기존 Phase 8 lifecycle을 그대로 사용한다.

```text
upload_pending -> uploaded -> available
                       \-> failed
delete_pending -> deleted
```

### 3.3 권한

UI는 backend authority를 대체하지 않는다.

- Read/list/playback: 기존 Phase 8 read rule 유지.
- Capture/upload mutation:
  - backend Step 3 기준 mutation은 `admin | manager | employee` + verified + fresh role + `assertCanMutateCall`.
  - frontend는 `/me` role cache로 viewer에게 capture action을 숨긴다.
  - employee가 다른 사람 call을 열었을 때는 backend 403을 authority로 처리한다.

### 3.4 Legal Notice Placeholder

Phase 9는 법무 문구를 확정하지 않는다. 다만 녹음 시작 전 최소 placeholder gate를 둔다.

- First-click inline confirmation: "녹음 전 상대방 동의가 필요할 수 있습니다."
- 확인 상태는 session-local만 유지. DB에 legal consent proof를 저장하지 않는다.
- 최종 법무/동의 workflow는 별도 Phase 후보로 남긴다.

---

## 4. Technical Contract

### 4.1 MIME Negotiation

Preferred order:

1. `audio/webm;codecs=opus`
2. `audio/webm`
3. `audio/ogg;codecs=opus`
4. `audio/ogg`
5. `audio/mp4`

Phase 8 backend allowed content types:

- `audio/webm`
- `audio/ogg`
- `audio/mpeg`
- `audio/mp4`
- `audio/wav`

Frontend must send the base content type expected by backend, not the full codec parameter, while keeping codec metadata separately when useful.

Example:

- Blob type: `audio/webm;codecs=opus`
- API `content_type`: `audio/webm`
- API `codec`: `opus` or `webm/opus`

### 4.2 Duration / Size Guard

Client-side guard is advisory; backend remains authority.

Initial defaults:

- max duration: 2 hours.
- warning at 90 minutes.
- max upload bytes: respect Phase 8 backend 250 MB default.
- if browser cannot estimate final size until stop, enforce on blob before upload.

No new backend env is required for Step 1. If server exposes max upload policy later, frontend can consume it in a separate hardening step.

### 4.3 Upload Flow

Use existing Phase 8 API.

```text
blob ready
  -> POST /calls/:id/recordings/upload
  -> PUT signed_url.url with signed_url.headers and blob body
  -> POST /calls/:id/recordings/:recordingId/finalize
  -> GET /calls/:id/recordings
  -> render existing playback surface
```

Rules:

- Never interpolate `signed_url.url` into `innerHTML`.
- Do not log signed URL, headers, object locator, checksum, bucket, access key, or raw audio.
- `PUT` uses `fetch` directly to signed URL.
- On upload failure after metadata row creation, call finalize failed path only if existing backend service supports it. If not, leave row in `upload_pending`/`failed` according to current route behavior and show retry/discard guidance.
- On finalize failure, reload recordings to reconcile server state.

### 4.4 API Helper Changes

`platform/api.js` currently has:

- `listCallRecordings`
- `getCallRecordingPlaybackUrl`
- `deleteCallRecording`

Phase 9 should add:

- `initiateCallRecordingUpload(callId, payload)`
- `finalizeCallRecording(callId, recordingId, payload)`

The helper must return parsed JSON for 201/200 and pass through existing `ApiError` behavior for 4xx/5xx.

No shared type changes are expected unless frontend type mirror docs need comments. The route schemas already exist from Phase 8.

---

## 5. Frontend Implementation Plan

### Step 1 - Plan / UX Contract

Deliverable:

- `PHASE_9_MASTER.md` (this document).

Validation:

- no runtime code touched.
- `git diff --check`.

### Step 2 - Recorder Controls

Files:

- `platform/api.js`
- `platform/calls.html`

Implementation:

- Add upload/finalize API helpers.
- Add local recorder state variables:
  - `recordingCaptureState`
  - `mediaRecorder`
  - `captureStream`
  - `captureChunks`
  - `captureStartedAt`
  - `captureElapsedTimer`
  - `capturePreviewUrl`
  - `captureEpoch`
- Add cleanup helper:
  - stop tracks
  - revoke preview object URL
  - clear timers
  - reset local state on detail close / call switch.
- Render controls in existing recording section.
- Do not add a separate page or landing view.

Expected controls:

- start
- pause/resume when supported
- stop
- discard
- upload

### Step 3 - Upload + Reconcile

Files:

- `platform/calls.html`

Implementation:

- Build upload payload from blob:
  - `content_type`
  - `size_bytes`
  - `duration_seconds`
  - `codec`
  - `recorded_at`
- Initiate upload.
- PUT blob to signed URL.
- Finalize.
- Reload recordings and render available/processing/failed state.
- If any step fails, show stable error text and reload server state.

No object locator/signed URL may be rendered or logged.

### Step 4 - Browser Smoke

Preferred verification:

- Playwright fixture page with injected mock `MediaRecorder`.
- Desktop 1440x900:
  - no recording -> start -> recording -> stop -> preview -> upload -> available.
  - permission denied -> stable error.
  - unsupported browser -> capture action disabled.
  - upload 502 -> error + reload.
- Mobile 390x844:
  - controls fit without horizontal scroll.
  - native audio preview and existing playback surface do not overlap.

Static checks:

- Function-constructor parse for `platform/api.js`.
- Extract inline script from `platform/calls.html` and parse.
- Search for unsafe logging:
  - no `console.*(signed`
  - no `console.*(url`
  - no raw `playback.url` / `upload.url` interpolation into `innerHTML`.

### Step 5 - Findings / Guide

Deliverables:

- `docs/plan/phase-9/PHASE_9_CLOSEOUT_FINDINGS.md`
- `docs/USER_GUIDE_PHASE_9.md`
- README/docs index updates.

Closeout validation:

- `git diff --check`
- `npm --prefix server run typecheck`
- `node test/sync_shared_types.mjs`
- targeted browser smoke
- full `npm --prefix server test` only if backend/shared behavior is touched. If frontend-only, cite latest backend full test and run targeted frontend/static checks.

---

## 6. XSS / Sensitive Data Rules

Every `.innerHTML` or template literal touched in `platform/calls.html` must classify interpolations.

Allowed:

- constant layout chrome.
- escaped server fields via existing `escapeHtml`.
- numeric duration/size after formatting.

Not allowed:

- raw call title/customer/server error without escaping.
- signed upload URL.
- signed playback URL.
- upload headers.
- storage bucket.
- object key.
- checksum.
- raw audio bytes.
- `Blob` contents.

Media URLs:

- local preview URL from `URL.createObjectURL(blob)` can be assigned only through `audio.src` property.
- signed upload URL can be passed only to `fetch`.
- signed playback URL remains Phase 8 behavior: `audio.src` property only.

Cleanup:

- `URL.revokeObjectURL(previewUrl)` on discard, upload success, detail close, and call switch.
- stop all `MediaStreamTrack`s on stop/cancel/detail close.

---

## 7. Browser Compatibility

Initial target:

- Chrome / Edge current desktop.
- Chrome / Safari current mobile: playback path must remain clean; capture support may be gated if `MediaRecorder` MIME support is insufficient.

Unsupported browser behavior:

- no capture button, or disabled button with short text.
- existing playback/list/delete must continue to work.

Permission denied behavior:

- stable inline error.
- no retry loop.
- user can click "다시 시도" after changing browser permission.

No-device behavior:

- stable inline error.
- no uncaught console error.

---

## 8. Testing Matrix

### Static

- `platform/api.js` parse OK.
- `platform/calls.html` inline script parse OK.
- `git diff --check`.
- grep for sensitive token leaks in touched frontend code.

### Browser Smoke

| Case | Expected |
|---|---|
| unsupported browser | capture action disabled, playback still works |
| permission denied | stable error, no upload row created |
| record stop discard | tracks stopped, object URL revoked, no API call |
| record stop upload success | upload/finalize/list calls in order, playback surface available |
| upload URL request 403 | authority error shown, no object PUT |
| object PUT failure | stable error, server state reload |
| finalize 409 | stable error, server state reload |
| detail close during recording | tracks stopped, timers cleared |
| switch call during upload | stale result ignored by epoch |
| mobile viewport | no horizontal overflow |

### Backend

No new backend behavior should be necessary. If implementation touches backend:

- add route/service tests in `server/test`.
- run `npm --prefix server run typecheck`.
- run relevant targeted tests and full server test before closeout.

---

## 9. Decisions

### 9.1 Browser-first, not desktop-native

`DESKTOP_APP_PLAN.md` correctly calls out PC app risk: Windows audio device variance, softphone restrictions, WASAPI loopback, updates, field debugging. Phase 9 avoids that by using browser microphone capture first. This creates immediate product value from the Phase 8 backend without committing to native capture complexity.

### 9.2 Microphone-only v1

System audio / remote speaker capture is not reliable in plain browser APIs and frequently requires OS-level or tab-capture permissions. v1 records the agent microphone stream only. If full two-sided call audio is required, that belongs to desktop native or telephony-provider integration.

### 9.3 Manual start/stop

No automatic call detection in Phase 9. The user explicitly controls recording. This avoids false positives and avoids binding product semantics to softphone-specific behavior.

### 9.4 No new backend upload endpoint

Phase 8 already created upload/finalize routes and storage abstraction. Phase 9 should consume them directly. New backend endpoints are a smell unless frontend discovers a concrete missing contract during implementation.

---

## 10. Open Questions

These should not block Step 2 unless product explicitly reprioritizes them.

1. Does v1 need recording replacement when an `available` recording already exists?
2. Should employees see capture UI only for own calls, or optimistically show and let backend reject?
3. Is microphone-only acceptable for pilot demos, or is two-sided audio mandatory?
4. Should local preview survive detail close? Current plan says no.
5. Should legal notice confirmation reset per session, per call, or per org? Current plan says session-local only.
6. Should max duration be 2 hours or match expected call SLA?
7. Should `recorded_at` be capture start time or upload time? Current plan says capture start time.

---

## 11. Go / No-Go

Phase 9 closeout requires:

- [ ] Browser capture works without introducing a new backend API.
- [ ] Permission denied / unsupported / no-device states do not throw uncaught errors.
- [ ] Recording tracks and object URLs are cleaned on stop/discard/upload/detail close/call switch.
- [ ] Upload/finalize success reconciles through server list, not optimistic-only state.
- [ ] Upload/finalize failure reloads server state and leaves a clear retry/discard path.
- [ ] Viewer cannot initiate upload in UI, and backend still rejects unauthorized mutation.
- [ ] signed URL / object key / bucket / checksum / raw audio are not interpolated into HTML, visible text, or console logs.
- [ ] Mobile 390px viewport has no horizontal overflow in capture controls.
- [ ] Existing Phase 8 playback/delete surface still works.
- [ ] `git diff --check` PASS and relevant static/browser checks PASS.

---

## 12. Next Step

Next implementation unit is **Phase 9 Step 2 - frontend recorder implementation**.

Recommended Codex/Claude handoff:

```text
Implement Phase 9 Step 2 only.

Scope:
- platform/api.js: add initiateCallRecordingUpload and finalizeCallRecording helpers using existing API patterns.
- platform/calls.html: add browser MediaRecorder capture controls inside the existing recording section.
- No backend, migration, shared type, or test registry changes unless a concrete blocker is found.

Requirements:
- Browser-first microphone capture only.
- Use Phase 8 upload/finalize/list/playback contracts.
- Never render/log signed upload URL, object key, bucket, checksum, provider metadata, or raw audio.
- Cleanup MediaStream tracks, timers, preview object URLs, and stale async results on detail close/call switch.
- Keep existing Phase 8 playback/delete behavior intact.

Validation:
- git diff --check.
- Parse platform/api.js and calls.html inline script.
- Browser smoke with mocked MediaRecorder for success, permission denied, unsupported browser, failure reconcile, and mobile no-overflow.
```


# Phase 9 Step 6 Plan - Recording Archive Bridge

작성일: 2026-05-21

상위 문서: `PHASE_9_MASTER.md`<br>
선행 결과: `PHASE_9_STEP_5_FINDINGS.md`, `PHASE_8_CLOSEOUT_FINDINGS.md`, `PHASE_8_STEP_3_FINDINGS.md`

> Step 6의 목적은 Step 5에서 실시간 STT까지 연결된 WPF desktop call을 Phase 8 call recording storage에 붙이는 것이다. 통화 중에는 desktop이 전체 녹취 archive를 로컬 임시 WAV로 만들고, 통화 종료 후 기존 Phase 8 `upload -> signed PUT -> finalize -> calls.html playback` 흐름으로 call에 첨부한다. Azure Speech 실호출, Flutter 전환, 장기 로컬 retry buffer, production storage 정책 변경은 이 단계 범위가 아니다.

---

## 0. Status

**Plan only. Implementation not started.**

- Step 5 realtime path는 manual E2E까지 통과했다.
- Phase 8 recording metadata, upload/finalize/list/playback/delete REST routes는 이미 있다.
- Step 6는 새 schema 없이 desktop archive writer + upload client + dev/local signed URL 처리만 연결한다.
- `PHASE_9_MASTER.md` Step 6 체크박스는 구현, 검증, findings 작성 후에만 갱신한다.

---

## 1. Goal

Step 6이 닫히면 다음이 가능해야 한다.

1. 사용자가 WPF에서 backend에 로그인하고 통화를 시작한다.
2. 앱이 realtime STT 전송과 동시에 전체 통화 archive WAV를 로컬 임시 파일로 기록한다.
3. 사용자가 통화를 종료하면 앱이 WAV header를 finalize하고 size, duration, SHA-256을 계산한다.
4. 앱이 기존 Phase 8 `POST /calls/:id/recordings/upload`를 호출한다.
5. 앱이 응답으로 받은 signed PUT URL에 archive bytes를 업로드한다.
6. 앱이 `POST /calls/:id/recordings/:recordingId/finalize`를 호출한다.
7. backend가 `call_recordings` row를 `available`로 만들고 기존 calls page에서 playback URL을 발급한다.
8. 사용자는 `platform/calls.html`의 Phase 8 recording playback surface에서 해당 녹취를 재생할 수 있다.

---

## 2. Non-Goals

- Azure Speech SDK 호출.
- real STT provider credential 추가.
- transcript와 audio timestamp 동기화 UI.
- waveform, seek marker, speaker timeline.
- Opus/WebM encoder 도입.
- local encrypted retry queue.
- failed archive를 디스크에 장기 보관.
- production S3/MinIO 운영 smoke를 기본 게이트로 강제.
- Flutter Windows 전환.
- browser recording/capture UI.

Step 6는 **desktop archive 생성 + Phase 8 upload/finalize/playback 연결**만 닫는다.

---

## 3. Existing Contracts To Reuse

### 3.1 Phase 8 Recording REST Surface

Route file:

- `server/src/routes/callRecordings.ts`

Shared type source:

- `server/src/types/callRecording.ts`
- `platform/types/callRecording.js`
- `test/sync_shared_types.mjs`

Endpoints:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/calls/:id/recordings/upload` | create `upload_pending` row and signed PUT URL |
| `POST` | `/calls/:id/recordings/:recordingId/finalize` | mark upload as `available` |
| `GET` | `/calls/:id/recordings` | list call recordings |
| `GET` | `/calls/:id/recordings/:recordingId/playback-url` | issue signed playback GET URL |
| `DELETE` | `/calls/:id/recordings/:recordingId` | delete/tombstone recording |

Upload input for Step 6:

```json
{
  "content_type": "audio/wav",
  "codec": "pcm_s16le_stereo_16000",
  "recorded_at": "2026-05-21T04:00:00.000Z",
  "duration_seconds": 123,
  "size_bytes": 1234567,
  "checksum_sha256": "64-char hex"
}
```

Finalize input:

```json
{
  "duration_seconds": 123,
  "size_bytes": 1234567,
  "checksum_sha256": "64-char hex"
}
```

Rules:

- Do not expose or log `object_key`, bucket, signed URL, checksum, raw audio bytes, or provider credentials.
- Use existing access token auth. Do not create a desktop-only auth route.
- Do not trust client-sent `org_id`.
- Preserve existing Phase 8 route error vocabulary.

### 3.2 Dev/Local Storage Gap

There is a real implementation gap that Step 6 must address before local manual E2E can pass:

- Phase 8 local storage adapter returns URL shapes such as `http://localhost.invalid/recordings/...`.
- The current backend has no public PUT/GET route that serves those local URLs.
- Route tests validate signed URL shape, but they do not upload bytes through HTTP.

Step 6 must choose one of these paths before implementation:

1. **Recommended for local development**: add a dev-only local recording URL handler, enabled only for local provider and non-production/dev flag. It should serve the `RECORDING_STORAGE_PUBLIC_BASE_URL` path, accept signed PUT uploads, and serve signed GET playback.
2. **Alternative**: require MinIO/S3 credentials for Step 6 manual E2E and leave local provider playback as contract-only.

Default decision for this plan: **implement the dev-only local handler** so the current local stack can verify upload and playback without external object storage.

---

## 4. Archive Format Decision

### 4.1 Format

Use WAV for Step 6:

- `content_type`: `audio/wav`
- `codec`: `pcm_s16le_stereo_16000`
- sample rate: `16000`
- bit depth: `16`
- channels: `2`

Channel mapping:

| Channel | Source |
|---|---|
| left | `agent_mic` |
| right | `system_loopback` |

Reason:

- Existing capture frames are already normalized to PCM16 16 kHz mono per source.
- WAV is simple, deterministic, and supported by browser `<audio>`.
- Stereo preserves source separation without diarization or mixing.
- Phase 8 already allows `audio/wav`.

Do not reuse `DiagnosticWavWriter` as the archive writer. It is dev-only, per-source, `.diagnostics/` scoped, and intentionally git-ignored. Step 6 needs a call archive writer with production-like lifecycle and cleanup.

### 4.2 Time Alignment

`CapturedAudioFrame.StartedAtMs` is the alignment source.

Archive writer behavior:

- Maintain one logical stereo timeline from call archive start.
- For an `agent_mic` frame, write samples into left channel and silence into right channel for that frame window.
- For a `system_loopback` frame, write silence into left channel and samples into right channel.
- If frames arrive with gaps, write silence for the missing time.
- If both sources have frames for the same time window, interleave them into the same stereo window when possible.
- If exact overlap handling is too complex for the first commit, use a deterministic frame-order writer and document the limitation in findings. Do not silently produce corrupt WAV.

The archive writer must close/dispose before upload so the WAV header has the final byte length.

---

## 5. Desktop Implementation Scope

Primary project:

- `desktop/Kloser.Desktop.Shell/`

Likely new files:

```text
desktop/Kloser.Desktop.Shell/
  Services/
    RecordingArchive/
      CallArchiveWavFrameSink.cs
      RecordingArchiveClient.cs
      RecordingArchiveModels.cs
      RecordingArchiveSession.cs
```

Core audio writer may live in `desktop/Kloser.Capture.Core/` if it is generic and testable, but upload/auth/UI code stays in Shell.

### 5.1 `CallArchiveWavFrameSink`

Responsibilities:

- Implement `ICapturedFrameSink`.
- Accept `CapturedAudioFrame` from the same `CaptureSessionController` pump used by realtime STT.
- Write one stereo WAV file per call session.
- Never log PCM bytes.
- Track:
  - started_at
  - ended_at
  - duration_seconds
  - frames per source
  - dropped/late frames if any
  - final file size
  - SHA-256
- Expose final archive metadata only after `CompleteAsync()` / `Dispose()`.

Local temp path:

```text
%LOCALAPPDATA%\Kloser\recordings\pending\<callId>\call.wav
```

Do not place archive files under the repo. Existing `desktop/.gitignore` protects repo-local `*.wav`, but Step 6 should use user-local app data anyway.

### 5.2 `RecordingArchiveClient`

Responsibilities:

1. Call `POST /calls/:callId/recordings/upload`.
2. Upload bytes to returned `upload.url` using returned `upload.method` and `upload.headers`.
3. Call `POST /calls/:callId/recordings/:recordingId/finalize`.
4. Best-effort cleanup with `DELETE /calls/:callId/recordings/:recordingId` if upload/finalize fails after a recording row was created.

Security rules:

- Do not log signed URL.
- Do not show signed URL in UI.
- Do not log object key. It is not in the response, but the URL path may contain it for local provider.
- Do not log checksum.
- Do not include raw HTTP response body if it could contain provider internals.

HTTP rules:

- Use the same memory-only access token already held by Step 5.
- For signed PUT, apply returned headers exactly. At minimum this includes `Content-Type: audio/wav`.
- Do not add auth bearer token to signed PUT unless the signed URL explicitly requires it; object-storage signed URLs are not Kloser API routes.

### 5.3 `RecordingArchiveSession`

State machine:

```text
Idle
  -> Recording
  -> FinalizingLocalFile
  -> UploadInitiating
  -> UploadingBytes
  -> FinalizingRemote
  -> Available
  -> Failed
```

Normal lifecycle:

1. `RealtimeCallSession.StartAsync` returns `callId`.
2. Create archive session for that `callId`.
3. Register archive sink in `CaptureSessionController` before capture begins or before the first pump after call start.
4. On End Call:
   - stop capture.
   - pump/drain once if needed.
   - complete archive writer.
   - stop realtime call (`audio_end` + `end_call`) as Step 5 already does.
   - initiate/upload/finalize recording archive.
   - delete local temp directory.

Ordering decision:

- Realtime `audio_end/end_call` should not wait for object upload to finish before closing the call.
- Archive upload can run immediately after local WAV is finalized. The call row already exists and can accept recording metadata after `end_call`.
- UI should show call ended and archive upload progress separately.

Failure policy:

- If local archive writer fails, stop archive path and keep realtime call lifecycle intact.
- If upload initiate fails, delete local temp file and show error.
- If signed PUT fails, best-effort DELETE the `upload_pending` recording row, delete local temp file, show error.
- If finalize fails, best-effort DELETE the recording row/object, delete local temp file, show error.
- Step 6 does not keep failed archive files for retry. Retry with encrypted local queue is Step 7+.

---

## 6. Backend Implementation Scope

### 6.1 Preferred: Dev-Only Local Recording URL Handler

Add a narrow route/plugin only for local development signed URL usability.

Candidate file:

- `server/src/routes/devRecordingStorage.ts`

Route shape:

```text
PUT /dev-recordings/*
GET /dev-recordings/*
```

Activation:

- only when `RECORDING_STORAGE_PROVIDER` is unset or `local`, and
- `NODE_ENV !== "production"`, and
- `RECORDING_STORAGE_PUBLIC_BASE_URL` points at this backend path, e.g. `http://localhost:32173/dev-recordings`.

Behavior:

- Parse object key from wildcard path.
- Require `expires` query param and reject expired URLs.
- For PUT:
  - require `Content-Type` compatible with the upload URL's expected type where feasible.
  - read request body with existing recording upload max cap.
  - call `app.recordingStorage.putObject`.
- For GET:
  - call local adapter read path or add a safe adapter method only if needed.
  - return `audio/wav` or requested response content type.

Safety:

- Never enable in production.
- Never log object key, bucket, full URL, request body, or raw storage error.
- Reuse the adapter's object-key traversal protection.
- Add tests for traversal, expired URL, and disabled-in-production behavior.

If implementer judges this route too risky for the current backend boundary, stop and report. Do not fake a successful upload/finalize without writing an object.

### 6.2 Backend Changes Not Allowed

- No schema migration.
- No raw audio bytes in DB.
- No bypass that marks recordings available without object upload.
- No new desktop-only auth endpoint.
- No change to `call_recordings` response shape unless shared types are updated in 3-way sync.
- No change to Step 2 realtime audio contract.

---

## 7. WPF UI Scope

Add a compact archive status area to the existing Step 5 backend/call band.

Required fields:

- archive state.
- local archive duration.
- local archive size.
- upload progress or uploaded bytes.
- recording id after upload initiate.
- final recording status after finalize.
- last archive error.

Required controls:

- archive enabled toggle, default on for Step 6 manual E2E.
- optional "open calls page" button after finalize.

Do not show:

- signed URL.
- object key.
- checksum.
- local temp full path by default.
- raw exception stack trace.

The UI can show a short sanitized message such as:

```text
녹취 업로드 완료: available
녹취 업로드 실패: recording_storage_failed
```

---

## 8. Web Platform Scope

`platform/calls.html` already has the Phase 8 recording playback surface.

Expected Step 6 web changes:

- Ideally none.

Allowed only if manual E2E exposes a real mismatch:

- refresh behavior after a desktop-originated recording appears.
- copy/label adjustment that makes the existing recording state clearer.
- bug fix in existing recording playback URL handling.

Frontend XSS rule:

- If touching `calls.html`, every server-returned field (`recording.error_message`, `codec`, timestamps) must remain escaped or assigned via safe DOM APIs.
- Playback URL must continue to be assigned through `audio.src`, not interpolated into HTML.

---

## 9. Verification Plan

### 9.1 Automatic Gates

Run from repository root:

```powershell
& "C:\Program Files\dotnet\dotnet.exe" build desktop\Kloser.Capture.Core\Kloser.Capture.Core.csproj
& "C:\Program Files\dotnet\dotnet.exe" build desktop\Kloser.Capture.Poc\Kloser.Capture.Poc.csproj
& "C:\Program Files\dotnet\dotnet.exe" build desktop\Kloser.Desktop.Shell\Kloser.Desktop.Shell.csproj
npm --prefix server run typecheck
node test/sync_shared_types.mjs
npm --prefix server test
git diff --check
```

If backend dev local URL handler is added, include focused tests:

- local signed PUT writes object through adapter.
- local signed GET returns uploaded bytes with audio content type.
- expired URL rejected.
- traversal object key rejected.
- handler disabled in production.
- logs/audit do not contain object key, signed URL, checksum, or audio bytes.

### 9.2 Manual E2E Gate

Prerequisites:

- backend running on `http://localhost:32173`.
- `RECORDING_STORAGE_PROVIDER=local`.
- `RECORDING_STORAGE_PUBLIC_BASE_URL=http://localhost:32173/dev-recordings`.
- WPF app running on Windows with microphone and render device.
- static web server running for `platform/calls.html`.

Manual flow:

1. Login/connect WPF app.
2. Start call.
3. Speak into mic and play system audio for at least 20 seconds.
4. Confirm realtime partial/final transcript still works.
5. End call.
6. Confirm archive status moves through local finalize, upload, remote finalize, available.
7. Confirm local temp file/directory is deleted.
8. Open the call in `platform/calls.html`.
9. Confirm recording surface shows `available`.
10. Play audio in browser.
11. Confirm both mic and system audio are audible as separate stereo channels or documented v1 mix.
12. Confirm `call_recordings` row has `content_type=audio/wav`, `status=available`, nonzero `duration_seconds`, nonzero `size_bytes`.
13. Confirm UI/logs/audit do not expose signed URL, object key, checksum, or raw audio bytes.

### 9.3 Regression Gates

Must still work:

- Step 5 realtime call without archive enabled.
- Step 4 capture-only mode without backend connected.
- diagnostic WAV toggle remains dev-only and separate from archive.
- console PoC still builds/runs.
- Phase 8 recording route tests still pass.
- Phase 8 calls page playback still handles existing recordings.
- Step 2 `text_chunk` and audio mock STT tests still pass.

---

## 10. Findings Deliverable

Implementation must produce:

- `docs/plan/phase-9/PHASE_9_STEP_6_FINDINGS.md`

Required sections:

1. archive format decision actually implemented.
2. exact files changed.
3. local temp path and cleanup behavior.
4. upload/finalize wire evidence.
5. dev/local signed URL handler decision and tests, if added.
6. WPF UI archive status evidence.
7. calls page playback evidence.
8. DB evidence for `call_recordings`.
9. raw audio / signed URL / object key leakage check.
10. validation command outputs.
11. known limitations and Step 7 hardening candidates.

Do not update `PHASE_9_MASTER.md` Step 6 checkbox until this findings file exists and all required gates pass.

---

## 11. Handoff Instruction

```text
Phase 9 Step 6 Recording Archive Bridge를 구현한다.

반드시 먼저 읽을 문서:
- docs/plan/phase-9/PHASE_9_MASTER.md
- docs/plan/phase-9/PHASE_9_STEP_6_PLAN.md
- docs/plan/phase-9/PHASE_9_STEP_5_FINDINGS.md
- docs/plan/phase-8/PHASE_8_CLOSEOUT_FINDINGS.md
- server/src/routes/callRecordings.ts
- server/src/types/callRecording.ts
- server/src/adapters/recordingStorage.ts

핵심 목표:
- WPF desktop call 중 전체 녹취 archive WAV를 만든다.
- End Call 후 기존 Phase 8 upload -> signed PUT -> finalize 흐름으로 call에 recording을 첨부한다.
- platform/calls.html의 기존 recording playback surface에서 재생 가능하게 한다.

범위:
- desktop archive WAV sink/session/client 추가.
- WPF archive status UI 추가.
- 필요한 경우 dev/local recording signed URL PUT/GET handler 추가.
- backend recording shared type/route contract는 가능하면 변경하지 않는다.

하지 말 것:
- Azure Speech 실호출.
- Flutter 전환.
- raw audio 장기 로컬 retry buffer.
- fake finalize without object upload.
- signed URL/object key/checksum/raw audio를 로그, audit, UI 이벤트에 노출.
- production에서 dev local URL handler 활성화.

검증:
- dotnet build 3개 project.
- server typecheck.
- shared type sync.
- server tests.
- WPF manual E2E: call start, realtime transcript, end call, archive upload/finalize, local temp cleanup.
- calls.html playback manual 확인.
- raw audio / signed URL / object key leakage check.

산출물:
- desktop/server code changes.
- docs/plan/phase-9/PHASE_9_STEP_6_FINDINGS.md.

주의:
- 기존 dirty/user edits를 되돌리지 않는다.
- Phase 8 local provider signed URL은 현재 실제 PUT/GET route가 없으므로, local E2E를 닫으려면 dev-only local handler 또는 MinIO/S3 opt-in 중 하나를 명확히 결정하고 findings에 기록한다.
```

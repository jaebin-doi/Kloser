# Phase 9 Step 5 Plan - Realtime Backend Integration

작성일: 2026-05-21

상위 문서: `PHASE_9_MASTER.md`
선행 결과: `PHASE_9_STEP_2_FINDINGS.md`, `PHASE_9_STEP_3_FINDINGS.md`, `PHASE_9_STEP_4_FINDINGS.md`

> Step 5의 목적은 Step 4 WPF shell이 캡처한 `agent_mic` / `system_loopback` PCM16 프레임을 기존 backend `/calls` Socket.io namespace로 전송하고, Step 2 mock streaming STT가 partial/final transcript를 실제 call lifecycle에 붙이는 end-to-end 경로를 닫는 것이다. Azure Speech 실호출, Flutter 전환, Phase 8 recording archive upload/finalize는 본 단계 범위가 아니다.

---

## 0. Status

**Plan only. Implementation not started.**

- Step 2 backend audio ingest skeleton은 완료되어 있다.
- Step 4 WPF shell은 구현 완료이며, 사용자가 로컬 UI 테스트가 잘 된다고 보고했다.
- Step 5는 그 WPF shell에 backend 연결, auth, call lifecycle, audio streaming sink를 붙인다.
- `PHASE_9_MASTER.md` Step 5 체크박스는 구현, 검증, findings 작성 후에만 갱신한다.

---

## 1. Goal

Step 5가 닫히면 다음이 가능해야 한다.

1. 사용자가 WPF 앱에서 backend URL과 인증 정보를 넣는다.
2. 앱이 기존 Kloser auth contract로 access token을 얻거나, dev-only access token을 메모리로 받는다.
3. 앱이 `/calls` Socket.io namespace에 인증 handshake로 연결한다.
4. 앱이 `start_call`을 보내고 backend가 생성한 `callId`를 받는다.
5. 앱이 선택된 오디오 source 목록으로 `audio_start`를 보낸다.
6. 앱이 `CapturedAudioFrame`을 `audio_chunk` metadata + binary PCM payload로 전송한다.
7. backend가 `transcript.partial`과 final `transcript`를 emit한다.
8. 앱이 partial/final transcript와 runtime error를 UI에 표시한다.
9. 사용자가 종료하면 앱이 `audio_end` 후 `end_call`을 보내고 call을 정상 종료한다.

---

## 2. Non-Goals

- Azure Speech SDK 호출.
- real STT provider credential 추가.
- STT 비용 계산 정책 변경.
- Phase 8 recording upload/finalize bridge.
- Flutter Windows shell 도입.
- installer, auto-update, background service.
- raw audio local retry buffer.
- disconnect 중 raw audio 장기 보관.
- web `platform/live.html` UI 개편.

Step 5는 **desktop -> backend realtime audio -> mock STT transcript**만 닫는다.

---

## 3. Existing Contracts To Reuse

### 3.1 Backend Socket Namespace

대상 namespace:

- backend: `/calls`
- local default base URL: `http://localhost:32173`
- auth handshake: `auth: { token: accessToken }`

Step 2 event contract:

- `start_call`
- `audio_start`
- `audio_chunk`
- `audio_end`
- `end_call`

Server emits:

- `transcript.partial`
- `transcript`
- `error`

구현자는 `server/src/ws/calls.ts`와 `server/src/types/wsAudio.ts`를 먼저 읽고, wire payload를 임의로 재정의하지 않는다.

### 3.2 Audio Wire Format

`audio_start` payload:

```json
{
  "type": "audio_start",
  "sources": ["agent_mic", "system_loopback"],
  "codec": "pcm_s16le",
  "sample_rate_hz": 16000,
  "channels": 1,
  "frame_ms": 40,
  "app_version": "phase9-step5-dev",
  "device_id": "optional-local-device-id"
}
```

`audio_chunk` event:

1. first argument: metadata object
2. second argument: binary payload, raw PCM16 little-endian bytes

metadata:

```json
{
  "type": "audio_chunk",
  "seq": 1,
  "source": "agent_mic",
  "codec": "pcm_s16le",
  "sample_rate_hz": 16000,
  "channels": 1,
  "duration_ms": 40,
  "started_at_ms": 0
}
```

Rules:

- Do not base64 encode payload.
- Do not stringify PCM bytes.
- Do not log payload bytes.
- `seq` is strictly increasing per source.
- `source` must be one of the sources declared in `audio_start`.
- Payload must stay below backend cap: 128 KiB per chunk.
- Desktop should normally send 20-100 ms frames. Step 5 default stays with the Step 4 frame picker, recommended `40 ms`.

### 3.3 Speaker Mapping

Preserve Step 2 mapping:

| Desktop source | Backend transcript speaker |
|---|---|
| `agent_mic` | `agent` |
| `system_loopback` | `customer` |

Do not mix sources before backend.

---

## 4. Desktop Implementation Scope

### 4.1 Project Changes

Primary project:

- `desktop/Kloser.Desktop.Shell/`

Expected new areas:

```text
desktop/Kloser.Desktop.Shell/
  Services/
    Realtime/
      DesktopAuthClient.cs
      CallsSocketClient.cs
      SocketIoAudioFrameSink.cs
      RealtimeCallSession.cs
      RealtimeModels.cs
```

Exact file names may change, but responsibilities should not collapse into `MainWindowViewModel`.

### 4.2 NuGet Dependency

Use a maintained .NET Socket.IO client package for Step 5. Default recommendation:

- `SocketIOClient` NuGet package.

Before implementation, pin the actual package name/version in the `.csproj` and record it in `PHASE_9_STEP_5_FINDINGS.md`.

Do not hand-roll Engine.IO / Socket.IO framing unless the package cannot send the required `audio_chunk(meta, binary)` event shape. If the package cannot support this shape, stop and report the blocker instead of switching to an incompatible JSON/base64 protocol.

### 4.3 Capture Sink Integration

Step 4 intentionally added `ICapturedFrameSink`.

Step 5 adds:

- `SocketIoAudioFrameSink : ICapturedFrameSink`

Responsibilities:

- convert `CapturedAudioFrame` to Step 2 `audio_chunk` metadata.
- keep independent sequence counters per source.
- send binary PCM bytes as binary payload.
- never retain `CapturedAudioFrame.Buffer` after `OnFrameAsync` returns.
- report send failures to `RealtimeCallSession`, not directly to UI controls.

`CaptureSessionController` currently pumps built-in counter/WAV sinks. Refactor only as much as needed to allow an external sink or composite sink. Keep diagnostic WAV and counting behavior intact.

Recommended shape:

- add `IReadOnlyList<ICapturedFrameSink>` or `CompositeFrameSink`.
- WPF session composes:
  - counting sink.
  - optional diagnostic WAV sink.
  - socket sink when realtime call is active.

### 4.4 UI Additions

Add a compact backend connection band to the existing WPF shell:

- backend URL textbox, default `http://localhost:32173`.
- auth mode:
  - login with email/password via existing `/auth/login`, or
  - dev-only pasted access token / `KLOSER_DESKTOP_ACCESS_TOKEN`.
- Connect / Disconnect.
- Start call / End call, separate from raw capture Start / Stop if needed.
- call id display.
- socket status.
- last backend error.
- chunks sent per source.
- bytes sent per source.
- latest partial transcript.
- final transcript list.

UI must stay dense and operational. Do not create a marketing/landing screen.

### 4.5 Auth Decision

Implement the least risky auth that actually exercises backend auth.

Required:

- access token must be memory-only.
- token must be redacted in UI events, logs, exceptions, and findings.
- do not write refresh token, access token, or credentials to disk.

Allowed Step 5 paths:

1. **Preferred**: desktop login calls existing `/auth/login`, stores returned `accessToken` in memory, and sends it in Socket.io handshake.
2. **Fallback/dev**: user pastes an access token or provides `KLOSER_DESKTOP_ACCESS_TOKEN`; app uses it only in memory.

If `/auth/login` returns MFA challenge or setup-required responses, Step 5 may show a clear unsupported message and allow pasted-token fallback. Full MFA desktop UX is not Step 5 scope.

Do not invent a new desktop-only auth endpoint.

---

## 5. Lifecycle

### 5.1 Happy Path

1. User opens WPF app.
2. App refreshes device list.
3. User connects to backend.
4. App obtains or accepts memory-only access token.
5. App opens `/calls` Socket.io connection with auth token.
6. User clicks Start Call.
7. App sends `start_call`.
8. App stores returned `callId`.
9. App sends `audio_start` with selected source list.
10. App starts capture.
11. `SocketIoAudioFrameSink` sends `audio_chunk(meta, bytes)`.
12. App displays `transcript.partial`.
13. User clicks End Call.
14. App stops capture.
15. App sends `audio_end { reason: "normal" }`.
16. App sends `end_call`.
17. App displays final transcript events and closed state.

### 5.2 Source Selection

If only microphone is enabled:

- `audio_start.sources = ["agent_mic"]`.

If only system loopback is enabled:

- `audio_start.sources = ["system_loopback"]`.

If both are enabled:

- `audio_start.sources = ["agent_mic", "system_loopback"]`.

Never send a chunk for a source that was not declared.

### 5.3 Stop / Error Ordering

Normal stop:

1. stop capture.
2. drain remaining in-memory frames once.
3. send `audio_end`.
4. wait for final transcript events for a short bounded timeout.
5. send `end_call`.

Backend audio runtime error:

- For `BAD_PAYLOAD`, `AUDIO_CHUNK_TOO_LARGE`, `AUDIO_BACKPRESSURE`, or `AUDIO_SEQ_OUT_OF_ORDER`, fail closed:
  - stop capture.
  - show backend error.
  - do not continue sending chunks.
  - allow user to end call or reconnect/start a new session.

Socket disconnect while capture is active:

- stop sending audio immediately.
- stop capture or pause capture.
- do not buffer raw audio to disk.
- show reconnect-required state.
- user must explicitly restart call audio after reconnect.

This is intentionally simpler than the later bounded reconnect buffer requirement. Step 7 hardening can add short memory-only buffering after the direct e2e path is proven.

---

## 6. Backend Scope

Backend code should not need contract changes for the happy path. Only touch backend if implementation proves a real mismatch.

Allowed backend changes:

- small compatibility fix for binary payload shape if Socket.IO client exposes `byte[]` differently.
- additional tests around existing Step 2 contract.
- logging redaction improvement if a desktop error path exposes unsafe data.

Not allowed:

- new auth shortcut.
- trusting `org_id` from desktop.
- raising chunk cap without a test.
- changing `text_chunk` behavior.
- replacing mock STT with Azure.
- storing raw audio bytes.

If backend changes are required, update `server/src/types/wsAudio.ts`, `platform/types/wsAudio.js`, and `test/sync_shared_types.mjs` together when the wire contract changes.

---

## 7. Verification Plan

### 7.1 Automatic Gates

Run from repository root.

```powershell
& "C:\Program Files\dotnet\dotnet.exe" build desktop\Kloser.Capture.Core\Kloser.Capture.Core.csproj
& "C:\Program Files\dotnet\dotnet.exe" build desktop\Kloser.Capture.Poc\Kloser.Capture.Poc.csproj
& "C:\Program Files\dotnet\dotnet.exe" build desktop\Kloser.Desktop.Shell\Kloser.Desktop.Shell.csproj
npm --prefix server run typecheck
node test/sync_shared_types.mjs
npm --prefix server test -- --runInBand
git diff --check
```

If the server test runner does not accept `--runInBand`, use the repository's normal `npm --prefix server test`.

### 7.2 Manual E2E Gate

Prerequisites:

- local DB/migrations/seeds ready.
- backend dev server running.
- WPF app running on Windows machine with microphone and render device.
- test user access token available through login or pasted-token fallback.

Manual flow:

1. Connect WPF app to local backend.
2. Start a call from WPF.
3. Enable microphone and system loopback.
4. Speak into mic and play system audio.
5. Confirm chunk counters increase separately for `agent_mic` and `system_loopback`.
6. Confirm first valid chunk triggers `transcript.partial`.
7. Stop/end call.
8. Confirm final `transcript` events are visible in WPF.
9. Confirm backend persisted transcript rows for the call.
10. Confirm `llm_usage_log` contains mock `stt_transcribe` row with `audio_duration_ms_sent`.
11. Confirm raw PCM sentinel bytes are not visible in logs, transcript text, usage metadata, or UI event text.

### 7.3 Regression Gates

Must still work:

- Step 4 WPF starts without backend connected.
- Step 4 local capture-only mode still shows levels.
- diagnostic WAV toggle still works when backend is disconnected.
- console PoC still works.
- Step 2 `text_chunk` tests still pass.
- backend auth errors still surface as auth failures, not generic crash.

---

## 8. Findings Deliverable

Implementation must produce:

- `docs/plan/phase-9/PHASE_9_STEP_5_FINDINGS.md`

Required sections:

1. package/version selected for Socket.IO client.
2. exact desktop files changed.
3. auth path used: login or pasted-token fallback.
4. wire event evidence: `start_call`, `audio_start`, `audio_chunk`, `audio_end`, `end_call`.
5. transcript evidence: partial + final.
6. DB evidence: transcripts + mock STT usage row.
7. raw audio leakage check.
8. validation commands and outputs.
9. manual E2E result.
10. known limitations.

Do not update `PHASE_9_MASTER.md` Step 5 checkbox until this findings file exists and the gates above pass.

---

## 9. Handoff Instruction

```text
Phase 9 Step 5 Realtime Backend Integration을 구현한다.

반드시 먼저 읽을 문서:
- docs/plan/phase-9/PHASE_9_MASTER.md
- docs/plan/phase-9/PHASE_9_STEP_5_PLAN.md
- docs/plan/phase-9/PHASE_9_STEP_4_FINDINGS.md
- docs/plan/phase-9/PHASE_9_STEP_2_FINDINGS.md

핵심 목표:
- WPF desktop app에서 /calls Socket.io namespace에 인증 연결한다.
- start_call -> audio_start -> audio_chunk(meta,binary) -> audio_end -> end_call lifecycle을 붙인다.
- Step 2 mock streaming STT partial/final transcript를 WPF UI에 표시한다.
- raw PCM은 binary payload로만 보내고, 로그/DB/UI 이벤트 텍스트에 절대 노출하지 않는다.

범위:
- desktop/Kloser.Desktop.Shell에 realtime client, auth client, SocketIoAudioFrameSink 추가.
- 필요한 만큼 CaptureSessionController sink composition만 리팩터링.
- backend contract는 가능한 한 변경하지 않는다.
- Azure Speech, Phase 8 recording archive upload/finalize, Flutter 전환은 하지 않는다.

검증:
- dotnet build 3개 project.
- server typecheck.
- shared type sync.
- server tests.
- WPF manual e2e: connect, start call, mic+loopback chunk 전송, partial transcript, final transcript, end_call.
- raw audio leakage check.

산출물:
- desktop code changes.
- docs/plan/phase-9/PHASE_9_STEP_5_FINDINGS.md.

주의:
- 기존 dirty/user edits를 되돌리지 않는다.
- access token/credential/raw audio를 파일, 로그, UI 이벤트에 남기지 않는다.
- Socket.IO package가 binary event shape를 지원하지 않으면 base64 우회하지 말고 blocker로 보고한다.
```

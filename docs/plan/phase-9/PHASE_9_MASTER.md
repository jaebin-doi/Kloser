# Phase 9 Master Plan - Windows Realtime Call Capture

작성일: 2026-05-19

상위 문서: `docs/plan/phase-8/PHASE_8_CLOSEOUT_FINDINGS.md`, `docs/plan/roadmap/DESKTOP_APP_PLAN.md`, `docs/product/realtime-call-assistant-guide.md`, `docs/research/실시간-STT-시장분석-2026.md`, `docs/research/AZURE_SPEECH_COST_GUIDE_2026.md`

> Phase 9는 browser 녹음 UI가 아니다. Kloser는 통신사 / 콜센터 / 소프트폰 provider 녹취를 받아오는 서비스가 아니라, **Windows 데스크탑 앱이 상담원 PC의 시스템 오디오와 마이크를 직접 캡처해 실시간 통화 기능을 제공하는 제품**으로 간다. 오디오 캡처 엔진은 Windows native 접근이 필요하므로 C#/.NET을 기본으로 잡고, UI가 필요하면 Flutter Windows를 얇은 shell로 붙인다.

---

## 0. 진행 상태

> **계획 수정 완료.** 직전 browser `MediaRecorder` 계획은 제품 방향과 맞지 않아 폐기한다. Phase 9의 정본 방향은 Windows 데스크탑 실시간 오디오 캡처 + backend realtime ingest다.

- [x] **Step 1 - desktop capture architecture**: Windows audio engine, UI shell, backend realtime ingest contract, STT provider, call lifecycle, security boundary 확정. 정본 계획은 `PHASE_9_STEP_1_DESKTOP_CAPTURE_ARCHITECTURE.md`.
- [ ] **Step 2 - backend audio ingest contract**: `/calls` Socket.io namespace에 `audio_start` / binary `audio_chunk` / `audio_end`를 추가하고, mock streaming STT session + Azure Speech adapter boundary + usage metadata를 정리.
- [ ] **Step 3 - Windows capture engine PoC**: C#/.NET으로 WASAPI loopback + microphone capture, resampling, channel policy, local VAD/buffering, test harness.
- [ ] **Step 4 - desktop app shell**: 로그인, org/session 선택, start/end call, device selection, capture status, reconnect/error UI. Flutter Windows 또는 C# UI 결정 후 구현.
- [ ] **Step 5 - realtime backend integration**: desktop app -> backend audio stream -> STT -> transcript/suggestion/call update 흐름 연결.
- [ ] **Step 6 - recording archive bridge**: 실시간 통화 후 녹취 파일을 Phase 8 call recording upload/finalize 표면으로 보관.
- [ ] **Step 7 - pilot hardening + closeout**: Windows device matrix, network resilience, logs, consent placeholder, user guide, final validation.

---

## 1. 핵심 판단

### 1.1 녹음은 어디서 동작하는가

Kloser backend는 오디오가 발생하는 지점이 아니다. 실제 통화 오디오는 상담원 Windows PC에서 발생한다.

따라서 Phase 9의 오디오 소스는 다음 두 개다.

1. **시스템 오디오 / 소프트폰 출력**: 고객 목소리, 상담원이 듣는 원격 음성. Windows WASAPI loopback으로 캡처.
2. **마이크 입력**: 상담원 목소리. Windows capture endpoint로 캡처.

이 둘을 데스크탑 앱에서 동시에 캡처하고, backend로 실시간 전송한다.

### 1.2 왜 브라우저가 아닌가

브라우저 `MediaRecorder`는 대개 마이크만 안정적으로 잡는다. 고객 목소리, 소프트폰 출력, Windows system audio는 일반 웹앱 권한으로 안정적으로 캡처할 수 없다. Kloser가 만들려는 것은 "상담원 메모용 녹음"이 아니라 **실시간 통화 보조 / 녹취 / STT 파이프라인**이므로 browser-first capture는 정본이 아니다.

### 1.3 왜 provider import가 아닌가

우리는 통신사 / 콜센터 / 소프트폰 provider 쪽 녹취 API에 의존하는 방향이 아니다. provider connector / webhook / import smoke는 Phase 9 범위가 아니다.

### 1.4 기술 선택

- **오디오 엔진**: C# / .NET 8 Windows native.
- **오디오 API**: WASAPI loopback + microphone capture. v1 PoC는 `NAudio`를 우선 사용하고, 필요한 capture behavior를 막을 때만 direct WASAPI wrapper로 내린다.
- **STT primary**: Azure Speech. `ko-KR`, streaming Speech SDK, Korea Central cost visibility, enterprise/compliance 경로 때문에 Phase 9의 primary realtime STT로 확정한다. NAVER CLOVA Speech streaming과 Deepgram Nova-3는 fallback/comparison 후보로만 둔다.
- **UI**:
  - 기본 판단: Step 3 PoC는 C# WPF/tray 또는 console로 먼저 검증한다. Flutter Windows는 UI polish가 필요해진 뒤 얇은 shell로 가능.
  - 단, audio capture 자체는 Dart/Flutter plugin에 맡기지 않는다. C# audio engine을 별도 process/library로 두고 Flutter는 local IPC로 제어한다.
  - 빠른 PoC는 C# console/tray/WPF로 먼저 검증한다. UI polish는 Flutter로 분리 가능.
- **전송**: WebSocket 우선. WebRTC는 브라우저/양방향 media 세션에 강하지만, Windows native app -> backend STT ingest에는 운영 복잡도가 크다.

---

## 2. Product Goal

Phase 9가 닫히면 다음이 가능해야 한다.

1. 상담원이 Windows 데스크탑 앱에 로그인한다.
2. 앱이 마이크와 시스템 오디오 장치를 감지한다.
3. 상담원이 통화 시작을 누른다.
4. 앱이 마이크 + 시스템 오디오를 동시에 캡처한다.
5. 앱이 짧은 오디오 chunk를 backend로 실시간 전송한다.
6. backend가 STT를 호출하고 transcript를 call에 append한다.
7. 기존 live/calls UI가 transcript, sentiment, suggestion, checklist update를 표시한다.
8. 통화 종료 시 전체 녹취를 Phase 8 recording storage에 보관한다.

---

## 3. In Scope

### Desktop App

- Windows desktop app.
- 자체 로그인 또는 device token 기반 auth.
- org/user/session 선택.
- microphone capture.
- WASAPI loopback system audio capture.
- device selection UI.
- start / pause / resume / end call controls.
- 100~500ms audio frame buffering.
- sample rate normalization: target 16kHz or 24kHz mono PCM for STT path.
- optional local compressed archive: Opus/WebM 또는 WAV, Step 6에서 결정.
- network reconnect with bounded local buffer.
- local logs with redaction.
- capture status UI:
  - mic active
  - system audio active
  - backend connected
  - STT receiving
  - call id
  - dropped chunks count.

### Backend

- authenticated realtime audio ingest contract.
- call lifecycle binding:
  - start call
  - audio chunk append
  - end call.
- STT adapter integration for real audio buffers.
- transcript append with sequence/timestamp.
- provider usage logging for STT.
- error vocabulary for desktop client.
- optional recording archive finalize using Phase 8 routes/service.

### Frontend Web

- Existing `live.html` / `calls.html` may receive realtime updates.
- No browser capture UI.
- Web frontend can show active call status initiated by desktop app.

---

## 4. Out of Scope

- Browser `MediaRecorder` capture.
- 통신사 / 콜센터 / 소프트폰 provider 녹취 import.
- Provider webhook tests.
- S3/MinIO real-provider smoke.
- Mobile app.
- WebRTC media session.
- Automatic legal consent workflow.
- Full production auto-update channel.
- Multi-tenant device fleet management beyond minimal device identity.
- Speaker diarization quality guarantees.
- Perfect echo cancellation.

---

## 5. Architecture

```text
Windows Desktop App
  ├─ UI shell (Flutter Windows or C# WPF/tray)
  ├─ C# Audio Engine
  │   ├─ WASAPI loopback capture (remote/customer/system audio)
  │   ├─ microphone capture (agent audio)
  │   ├─ resample + mono/stereo policy
  │   ├─ chunk framing
  │   ├─ local rolling buffer
  │   └─ optional archive encoder
  └─ Realtime Client
      ├─ auth/login
      ├─ WebSocket connect
      ├─ start_call
      ├─ audio_chunk
      ├─ end_call
      └─ reconnect/error handling

Kloser Backend
  ├─ auth + org context
  ├─ /calls realtime namespace
  ├─ audio ingest validator
  ├─ STT adapter
  ├─ transcript repository
  ├─ suggestion pipeline
  └─ Phase 8 recording storage bridge

Web Platform
  ├─ live.html realtime view
  └─ calls.html call detail + Phase 8 playback
```

---

## 6. Desktop Client Contract

### 6.1 Runtime Stack

Recommended split:

- `desktop/audio-engine/`:
  - C#/.NET 8.
  - owns all audio capture and low-level device handling.
  - exposes local IPC:
    - named pipe
    - localhost loopback HTTP
    - gRPC over named pipe
  - preferred: named pipe or gRPC named pipe to avoid exposing a network port.
- `desktop/app/`:
  - Flutter Windows UI shell, if UI is built in Flutter.
  - calls audio engine IPC.
  - handles login/session/control/status.

Alternative PoC:

- Start with single C# console/WPF app for Step 3 to prove capture quality.
- Split Flutter shell only after audio quality is acceptable.

### 6.2 Audio Sources

Required:

- microphone input device.
- system output loopback device.

Initial channel policy:

- keep two logical streams:
  - `agent_mic`
  - `system_loopback`
- backend receives source id per chunk.
- STT v1 can either:
  - mix to mono before STT for simplest transcript, or
  - send source-separated chunks to support future diarization.

Recommendation:

- Preserve source labels in the wire envelope and do not mix before backend. Azure Speech diarization is off by default because `agent_mic` and `system_loopback` already identify speaker side.

### 6.3 Chunk Format

Step 1 decision: Socket.io binary event를 사용한다. JSON+base64는 dev-only fallback 후보로만 둔다.

Initial candidate:

```json
{
  "type": "audio_chunk",
  "call_id": "uuid",
  "seq": 123,
  "source": "agent_mic",
  "codec": "pcm_s16le",
  "sample_rate_hz": 16000,
  "channels": 1,
  "duration_ms": 250,
  "started_at_ms": 30750,
  "payload_encoding": "base64"
}
```

But for production, binary frames are better than base64 JSON.

Planned progression:

1. Step 2: define metadata + binary payload framing on the existing `/calls` Socket.io namespace.
2. Step 3 PoC: desktop engine emits PCM16 16 kHz mono frames.
3. Step 5 integration: keep source-separated streams; do not mix before backend.

### 6.4 Local Buffering

Minimum:

- rolling buffer 10~30 seconds.
- if network disconnects, attempt reconnect.
- if buffer overflows, drop oldest chunks and report aggregate dropped count.
- never write raw audio to long-lived local disk unless user setting or crash diagnostic mode explicitly enables it.

### 6.5 Archive Recording

Realtime STT chunks are not the same as final recording archive.

Options:

1. backend reconstructs recording from received chunks.
2. desktop app records a local full-session file and uploads it at end via Phase 8 upload/finalize.

Recommendation for v1:

- desktop app creates local temporary archive during call.
- on `end_call`, app uploads the completed archive through Phase 8 recording upload/finalize.
- delete local temp file after successful upload/finalize.
- if upload fails, retain encrypted temp file only if product explicitly allows retry; otherwise discard and surface failure.

---

## 7. Backend Contract

### 7.1 Existing Base

Current realtime stack already has `/calls` WebSocket text spike behavior:

- `start_call`
- `text_chunk`
- `end_call`
- server emits transcript/suggestion/sentiment/checklist updates.

Phase 9 extends this with audio input.

### 7.2 Required Events

Client -> Server:

- `start_call`
  - optionally includes customer id, title, device id.
- `audio_start`
  - declares sample rate, codec, source list, app version.
- `audio_chunk`
  - binary or JSON+base64 chunk.
- `audio_end`
  - flush current STT segment.
- `end_call`
  - finalizes call.
- `client_status`
  - aggregate health counters.

Server -> Client:

- `call_started`
- `audio_ack`
  - optional, probably sampled/windowed rather than per chunk.
- `transcript`
- `suggestion`
- `sentiment`
- `checklist_update`
- `recording_archive_required`
- `error`

### 7.3 Auth / Org Context

- desktop client logs in through existing auth.
- WebSocket handshake uses access token.
- backend derives org/user from JWT.
- never trust org id sent by client body.
- use existing `orgContext` / `withOrgContext` patterns before DB writes.

### 7.4 STT Adapter

Current STT adapter supports mock fixture strings and real provider buffer path exists conceptually. Phase 9 realtime uses a new streaming adapter shape instead of repeatedly calling one-shot short recognition.

Phase 9 backend must define:

- accepted audio format for adapter input: PCM16 signed little-endian, 16 kHz, mono.
- provider session model: Azure Speech streaming via backend-side Speech SDK/custom input stream.
- partial vs final transcript semantics: partial emits to live UI only; final persists to `transcripts`.
- usage envelope with audio duration, because STT cost is per audio duration, not tokens.

Potential repository/shared changes:

- extend provider usage metadata with `audio_duration_ms_sent`.
- ensure usage cost calculator can handle STT audio-duration units.
- no transcript schema change unless timestamp precision is insufficient.

---

## 8. Step Plan

### Step 1 - Architecture And Wire Plan

Status: complete. See `PHASE_9_STEP_1_DESKTOP_CAPTURE_ARCHITECTURE.md`.

Deliverable:

- update this master with final choices:
  - C# library.
  - UI shell choice.
  - STT primary provider.
  - chunk format.
  - backend event contract.
  - archive policy.

No implementation.

Validation:

- `git diff --check`.

### Step 2 - Backend Audio Ingest Skeleton

Files likely:

- `server/src/ws/calls.ts` or current calls namespace module.
- `server/src/adapters/stt/*`.
- `server/test/*audio*`.
- docs update.

Implementation:

- accept authenticated `audio_start` / binary `audio_chunk` / `audio_end`.
- validate metadata.
- do not call Azure yet until mock streaming STT path can consume deterministic test buffers.
- append transcript from mock streaming STT in deterministic test path.
- preserve existing `text_chunk` spike behavior.

Tests:

- missing auth.
- cross-org impossible through JWT/org context.
- invalid chunk metadata rejected.
- oversized chunk rejected.
- audio chunks append transcript in order in mock path.
- no raw audio stored in DB or logs.

### Step 3 - C# Audio Engine PoC

Location:

- new top-level `desktop/` directory, exact structure decided in Step 1.

Implementation:

- enumerate output loopback devices.
- enumerate microphone devices.
- capture both streams.
- resample to target format.
- write short local diagnostic WAV only in dev mode.
- display levels / dropped frames in console or minimal UI.

No backend dependency required for first PoC.

Validation:

- manual Windows smoke.
- device unplug/replug behavior.
- mute/silence behavior.
- CPU/memory baseline.

### Step 4 - Desktop App Shell

Implementation:

- login screen.
- device selection.
- start/end call control.
- connection status.
- local error reporting.
- version display.

UI decision:

- Flutter Windows if product UI polish is needed early.
- C# WPF/tray if capture stability and IPC speed matter more for PoC.

Rule:

- Flutter must not own low-level capture.

### Step 5 - End-To-End Realtime Integration

Implementation:

- desktop app opens WebSocket.
- sends `start_call`.
- sends audio chunks.
- backend emits transcript updates.
- web live/calls surface can observe result.
- end call stamps duration.

Validation:

- local Windows manual e2e.
- backend tests for event validation and transcript writes.
- no provider/import tests.

### Step 6 - Recording Archive Bridge

Implementation:

- desktop app creates final archive from captured call.
- desktop app uses Phase 8 upload/finalize API to attach recording to call.
- calls page shows playback.

Validation:

- local archive upload.
- Phase 8 playback still works.
- local temp cleanup.
- object key/signed URL not logged.

### Step 7 - Closeout

Deliverables:

- `PHASE_9_CLOSEOUT_FINDINGS.md`.
- `docs/USER_GUIDE_PHASE_9.md`.
- desktop runbook.
- README/docs index update.

---

## 9. Security / Privacy

- raw audio must not be logged.
- chunks must not be stored in DB.
- local diagnostic files are dev-only and disabled by default.
- access token storage on desktop must use Windows Credential Manager or DPAPI, not plain file.
- desktop logs must redact:
  - access token
  - refresh token
  - signed upload/playback URL
  - object key
  - bucket
  - raw audio bytes.
- backend audit should be aggregate or call-scoped, not chunk-scoped.
- recording archive still follows Phase 8 object metadata non-exposure policy.
- legal consent UX remains a product/legal requirement before production rollout.

---

## 10. Reliability Requirements

Desktop app:

- survives temporary network disconnect.
- reports audio device loss.
- prevents duplicate active call sessions per desktop client unless explicitly allowed.
- drains/clears buffers on end call.
- has bounded memory use.
- can recover from backend reconnect without creating orphan calls.

Backend:

- enforces max chunk size.
- enforces max active session duration.
- rate-limits chunks per socket.
- handles STT provider timeout without killing socket.
- appends transcripts in order.
- avoids long DB transaction around provider/network calls.

---

## 11. Open Decisions

Step 1 answered the architecture-critical decisions:

1. C# audio library: `NAudio` first; direct WASAPI wrapper only if required.
2. UI first shell: C# WPF/tray or console PoC first; Flutter later.
3. Desktop/backend IPC if Flutter is used: Windows named pipe.
4. Audio chunk transport: binary Socket.io event from day one.
5. STT input cadence: 20-100 ms PCM frames into backend streaming session; no 1/3/5s pseudo-streaming loop.
6. Source policy: source-separated `agent_mic` / `system_loopback`; no pre-backend mix.
7. STT primary: Azure Speech; NAVER CLOVA and Deepgram are fallback/comparison.
8. Final archive format: WAV for PoC, Phase 8 upload/finalize bridge.
9. Token storage: access token memory-only; refresh/device secret via Windows Credential Manager or DPAPI.

Still product/legal decisions:

- Local encrypted retry policy for failed archive upload.
- Device identity model beyond minimal client-generated `device_id`.
- Legal consent placeholder copy.

---

## 12. Go / No-Go

Phase 9 closeout requires:

- [ ] Windows app captures microphone and system loopback audio at the same time.
- [ ] desktop app can start/end a Kloser call using authenticated user/org context.
- [ ] backend accepts realtime audio chunks without raw audio DB persistence.
- [ ] STT mock or real adapter path produces ordered transcript rows.
- [ ] web live/calls surface sees transcript updates from desktop-originated calls.
- [ ] final recording archive attaches to the call through Phase 8 upload/finalize.
- [ ] access tokens and raw audio are not logged or stored insecurely.
- [ ] network disconnect has bounded buffering and visible status.
- [ ] no telecom/provider import tests are part of the required gate.
- [ ] documentation/runbook explains Windows device setup and known limitations.

---

## 13. Explicit Non-Goals

- Do not build browser recording UI.
- Do not build telecom/provider import.
- Do not require Aircall/Twilio/Dialpad/3CX/Zoom Phone credentials.
- Do not test provider webhooks.
- Do not rely on browser tab capture.
- Do not assume system audio capture works outside Windows.

---

## 14. Next Work Instruction

Next task should be **Phase 9 Step 2 - Backend Audio Ingest Skeleton**, but implementation must start from `PHASE_9_STEP_2_PLAN.md`.

Recommended handoff:

```text
Phase 9 Step 2 plan을 기준으로 backend audio ingest skeleton을 구현한다.

정본 방향:
- Windows 데스크탑 앱이 마이크 + 시스템 오디오를 직접 캡처한다.
- 오디오 엔진은 C#/.NET 8 기반으로 잡는다.
- STT primary는 Azure Speech다.
- UI가 필요하면 Flutter Windows를 shell로 쓰되, capture는 C# engine이 담당한다.
- 통신사/콜센터/소프트폰 provider import는 범위 밖이다.
- 브라우저 MediaRecorder 녹음 UI도 범위 밖이다.

Step 2에서 구현할 것:
- `/calls` Socket.io namespace에 `audio_start`, binary `audio_chunk`, `audio_end` handler 추가.
- shared types 3-way 등록: `server/src/types/wsAudio.ts`, `platform/types/wsAudio.js`, `test/sync_shared_types.mjs`.
- source / seq / codec / sample rate / duration / max bytes validation.
- single chunk 128 KiB limit + rolling queued bytes 1 MiB limit.
- session lifecycle: duplicate `audio_start`, chunk-before-start, `end_call` flush, text/audio coexistence.
- frame/duration loose match, declared source membership, per-source monotonic seq with gaps allowed.
- mock streaming STT session 추가.
- partial은 live emit only, final은 transcript append.
- mock STT usage row를 `llm_usage_log`에 실제 INSERT.
- raw audio magic byte sentinel DB/log/audit 누설 금지 테스트.
- Azure adapter는 skeleton green 이후 붙인다.

산출물:
- docs/plan/phase-9/PHASE_9_STEP_2_PLAN.md
- server/src/ws/calls.ts
- server/src/adapters/stt/* 또는 신규 streaming STT adapter module
- server/test/*audio*
- docs/plan/phase-9/PHASE_9_STEP_2_*_FINDINGS.md

검증:
- npm --prefix server run typecheck
- targeted audio ingest tests
- git diff --check

주의:
- Azure 실 provider 호출은 Step 2 필수 아님. mock streaming path 먼저 닫는다.
- provider import / browser capture 방향으로 쓰지 않는다.
```

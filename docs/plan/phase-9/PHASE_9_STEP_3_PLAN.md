# Phase 9 Step 3 Plan - Windows Capture Engine PoC

작성일: 2026-05-19

상위 문서:

- `docs/plan/phase-9/PHASE_9_MASTER.md`
- `docs/plan/phase-9/PHASE_9_STEP_1_DESKTOP_CAPTURE_ARCHITECTURE.md`
- `docs/plan/phase-9/PHASE_9_STEP_2_PLAN.md`
- `docs/plan/phase-9/PHASE_9_STEP_2_FINDINGS.md`
- `docs/plan/roadmap/DESKTOP_APP_PLAN.md`

> 이 문서는 구현 지시서다. Step 3의 목표는 Windows PC에서 `agent_mic`과 `system_loopback`을 동시에 캡처하고, Step 2 백엔드 ingest contract와 호환되는 PCM16 16 kHz mono frame을 안정적으로 만들어내는지 증명하는 것이다. backend 연결, Azure Speech 호출, Flutter shell, Phase 8 archive upload는 이 단계 범위가 아니다.

---

## 1. Goal

Step 3은 C#/.NET 기반 Windows audio capture PoC를 만든다.

성공 조건:

1. Windows default microphone을 `agent_mic` source로 캡처한다.
2. Windows default render/output device의 WASAPI loopback을 `system_loopback` source로 캡처한다.
3. 두 source를 같은 프로세스 안에서 동시에 캡처한다.
4. 각 source를 PCM16 signed little-endian, 16 kHz, mono로 normalize한다.
5. source별 frame queue가 Step 2 backend contract와 같은 metadata를 만들 수 있다.
6. console status로 level, frame count, dropped frame, device state를 볼 수 있다.
7. dev-only diagnostic WAV를 짧게 저장해서 실제 오디오 분리 여부를 사람이 확인할 수 있다.
8. raw audio diagnostic artifact가 git에 들어가지 않는다.

Step 3의 산출물은 "실시간 STT 품질"이 아니라 "Windows 캡처와 frame 생산 경로의 신뢰성"이다.

---

## 2. Inputs From Previous Steps

### Step 1 Decisions

- Audio engine: C# / .NET 8.
- Library: NAudio first. NAudio가 필요한 WASAPI behavior를 막는 경우에만 direct WASAPI wrapper 검토.
- First shell: capture quality 검증 우선. Console PoC 또는 최소 WPF/tray 가능.
- Wire audio format: PCM16 signed little-endian, 16 kHz, mono.
- Frame cadence: 20-100 ms. Step 3 default는 40 ms.
- Source policy: `agent_mic`과 `system_loopback`을 backend 전까지 mix하지 않는다.
- Azure Speech는 backend Step 4/5 범위다. Desktop은 Azure credential을 절대 갖지 않는다.

### Step 2 Contract

Step 2 backend는 다음 audio contract를 이미 갖고 있다.

```ts
type AudioStart = {
  sources: Array<"agent_mic" | "system_loopback">;
  codec: "pcm_s16le";
  sample_rate_hz: 16000;
  channels: 1;
  frame_ms: 20 | 40 | 60 | 80 | 100;
  app_version: string;
  device_id?: string;
};

type AudioChunkMeta = {
  seq: number;
  source: "agent_mic" | "system_loopback";
  codec: "pcm_s16le";
  sample_rate_hz: 16000;
  channels: 1;
  duration_ms: number;
  started_at_ms: number;
};
```

Step 3은 backend에 전송하지 않지만, 내부 frame model은 이 contract와 1:1로 대응해야 한다.

Required source mapping:

| Desktop capture input | Source | Speaker meaning |
|---|---|---|
| Microphone capture endpoint | `agent_mic` | 상담원 |
| Render device WASAPI loopback | `system_loopback` | 고객/원격 통화음 |

Frame byte size reference:

| Frame duration | PCM16 16 kHz mono bytes |
|---:|---:|
| 20 ms | 640 bytes |
| 40 ms | 1280 bytes |
| 60 ms | 1920 bytes |
| 80 ms | 2560 bytes |
| 100 ms | 3200 bytes |

Step 2 backend chunk cap은 128 KiB이므로 Step 3 frame은 정상 조건에서 cap에 근접하면 안 된다.

---

## 3. In Scope

Implementation scope:

- New top-level `desktop/` structure.
- C#/.NET 8 Windows-only PoC project.
- NAudio-based device enumeration.
- NAudio WASAPI microphone capture.
- NAudio WASAPI loopback capture.
- Resample / channel normalize to PCM16 16 kHz mono.
- Source-separated frame queue.
- Per-source monotonic sequence numbers.
- Console status output.
- Optional dev-only diagnostic WAV writer.
- Hardware/manual smoke validation notes.
- Step 3 findings document after implementation.

Documentation scope:

- Update `PHASE_9_STEP_3_FINDINGS.md` after implementation.
- Update `PHASE_9_MASTER.md` Step 3 checkbox only after Codex validation passes.

---

## 4. Out Of Scope

Do not implement these in Step 3:

- Socket.io connection to backend.
- `audio_start` / `audio_chunk` / `audio_end` network emission.
- Azure Speech SDK.
- NAVER CLOVA / Deepgram integration.
- Flutter Windows shell.
- Login/session UI.
- Windows Credential Manager / DPAPI token storage.
- Phase 8 recording upload/finalize.
- Production installer.
- Auto-update.
- Browser `MediaRecorder`.
- Telecom/provider import.
- Speaker diarization.
- Echo cancellation guarantee.

If a later step needs these, leave a note in findings instead of expanding Step 3.

---

## 5. Proposed Project Structure

Create a small, isolated PoC first. Do not introduce a full desktop app framework yet.

```text
desktop/
  Kloser.Capture.Poc/
    Kloser.Capture.Poc.csproj
    Program.cs
    Audio/
      AudioSourceId.cs
      CapturedAudioFrame.cs
      CaptureOptions.cs
      DeviceEnumerator.cs
      MicCaptureSource.cs
      LoopbackCaptureSource.cs
      Pcm16FrameEmitter.cs
      Pcm16Resampler.cs
      LevelMeter.cs
    Diagnostics/
      DiagnosticWavWriter.cs
      StatusRenderer.cs
    README.md
  .gitignore
```

Notes:

- Keep Step 3 self-contained under `desktop/Kloser.Capture.Poc/`.
- Do not touch backend files in this step unless a typo-only doc reference is necessary.
- `desktop/.gitignore` must exclude diagnostic audio and transient local logs.

Suggested `desktop/.gitignore` entries:

```gitignore
.diagnostics/
*.wav
*.pcm
*.raw
*.log
bin/
obj/
```

Do not ignore source files or project files.

---

## 6. Runtime Decisions

### 6.1 Project Type

Use a console app for Step 3.

Reason:

- Capture quality and frame correctness are the risk.
- A console app keeps the PoC small and reviewable.
- UI shell decisions belong to Step 4.

Target:

```xml
<TargetFramework>net8.0-windows</TargetFramework>
```

Package:

- `NAudio`

No Azure SDK package in Step 3.

### 6.2 CLI Surface

The PoC should expose enough CLI controls for repeatable manual tests.

Required commands/options:

```powershell
dotnet run --project desktop/Kloser.Capture.Poc -- --list-devices
dotnet run --project desktop/Kloser.Capture.Poc -- --duration-sec 30
dotnet run --project desktop/Kloser.Capture.Poc -- --duration-sec 30 --write-diagnostic-wav
dotnet run --project desktop/Kloser.Capture.Poc -- --mic "<device-id>" --loopback "<device-id>" --duration-sec 30
```

Required options:

| Option | Required behavior |
|---|---|
| `--list-devices` | Print capture devices and render devices, including stable device id and friendly name. No capture. |
| `--mic <id>` | Use a specific microphone/capture endpoint. Default: Windows default capture endpoint. |
| `--loopback <id>` | Use a specific render endpoint for loopback. Default: Windows default render endpoint. |
| `--duration-sec <n>` | Stop automatically after `n` seconds. Default: 30 for smoke runs. |
| `--frame-ms <20|40|60|80|100>` | Frame duration. Default: 40. |
| `--write-diagnostic-wav` | Enable dev-only WAV output. Disabled by default. |
| `--diagnostic-dir <path>` | Diagnostic output directory. Default: `desktop/.diagnostics/<timestamp>/`. |

Optional:

- `--no-mic`
- `--no-loopback`
- `--status-interval-ms <n>`

Do not require admin rights for normal capture.

---

## 7. Capture Architecture

### 7.1 Device Enumeration

`DeviceEnumerator` responsibilities:

- Enumerate active capture endpoints.
- Enumerate active render endpoints.
- Identify default capture endpoint.
- Identify default render endpoint.
- Print device id, friendly name, state, data flow, and default marker.

Expected output shape:

```text
Capture devices:
  [default] <id> | Microphone Array (...)
  [active ] <id> | USB Headset Mic (...)

Render devices:
  [default] <id> | Speakers (...)
  [active ] <id> | Headset Earphones (...)
```

Device ids may be long. Do not truncate in `--list-devices`; the user must be able to pass them back to `--mic` or `--loopback`.

### 7.2 Capture Sources

Create source-specific capture classes:

- `MicCaptureSource`
- `LoopbackCaptureSource`

Both should expose the same conceptual events:

```csharp
public event EventHandler<CapturedAudioFrame>? FrameReady;
public event EventHandler<CaptureSourceError>? SourceError;
public CaptureSourceStatus GetStatus();
```

Do not let these classes know about Socket.io, backend calls, Azure, or transcript logic.

### 7.3 Resampling And Normalization

All emitted frames must be:

```text
codec = pcm_s16le
sample_rate_hz = 16000
channels = 1
```

The implementation may use NAudio conversion primitives, but the conversion boundary must be isolated in `Pcm16Resampler`.

Rules:

- Accept source-native WASAPI format from NAudio.
- Convert float or PCM input to a common sample provider if needed.
- Downmix stereo/multichannel to mono.
- Resample to 16 kHz.
- Emit signed 16-bit little-endian bytes.
- Never emit source-native format downstream.

The findings document must record the native format observed for each tested device.

### 7.4 Frame Emitter

`Pcm16FrameEmitter` responsibilities:

- Accumulate normalized PCM bytes.
- Emit exact frame-sized chunks based on `frame_ms`.
- Maintain per-source `seq` starting at 1.
- Maintain `started_at_ms` relative to capture session start.
- Track dropped frames if queue cap is exceeded.

Internal frame model:

```csharp
public sealed record CapturedAudioFrame(
    AudioSourceId Source,
    long Seq,
    string Codec,
    int SampleRateHz,
    int Channels,
    int DurationMs,
    long StartedAtMs,
    byte[] Pcm
);
```

`CapturedAudioFrame` must be directly translatable to Step 2 `AudioChunkMeta` plus binary payload.

### 7.5 Queue And Backpressure

Step 3 does not send to backend, but it must still prove bounded memory behavior.

Default queue policy:

- Per-source in-memory queue cap: 5 seconds of emitted frames.
- If the consumer loop cannot drain, drop oldest frame and increment `dropped_frames`.
- Print dropped count in status output.

Rationale:

- Desktop capture cannot block the WASAPI capture callback indefinitely.
- Step 5 network integration can replace the consumer with Socket.io sender while preserving this queue contract.

### 7.6 Level Meter

`LevelMeter` should compute lightweight diagnostics from normalized PCM:

- peak amplitude
- RMS or approximate level
- silence flag for the latest interval

Do not log raw bytes or sample arrays.

Status output should refresh every 250-1000 ms.

Example:

```text
00:00:12 | mic level=0.18 frames=300 dropped=0 | loopback level=0.42 frames=299 dropped=0 | cpu=? mem=?
```

CPU/memory can be added if cheap. If not, report process memory only.

### 7.7 Diagnostic WAV

Diagnostic WAV is allowed only as explicit dev mode.

Rules:

- Disabled by default.
- Enabled only with `--write-diagnostic-wav`.
- Write separate files:
  - `agent_mic.wav`
  - `system_loopback.wav`
- WAV format must be PCM16 16 kHz mono.
- Enforce max diagnostic duration from `--duration-sec`.
- Default run should not write audio files.
- Diagnostic output directory must be ignored by git.

Diagnostic WAV contains sensitive raw audio. Do not print absolute signed URLs, tokens, object keys, or any external upload path because none should exist in Step 3.

---

## 8. Error Handling Requirements

Step 3 must surface clear local errors. Do not hide device failures behind a generic crash.

Required cases:

| Case | Expected behavior |
|---|---|
| No microphone device | Print actionable error and exit non-zero unless `--no-mic`. |
| No render device | Print actionable error and exit non-zero unless `--no-loopback`. |
| Device id not found | Print valid `--list-devices` hint and exit non-zero. |
| Capture start fails | Print source, device name, native format if available, and exception type. |
| Device unplug during capture | Mark source unhealthy, stop that source, keep other source running if possible. |
| Silence | Do not treat as failure; show level near zero. |
| Resampler failure | Stop affected source and exit non-zero for smoke runs. |

Do not add retry loops that mask failure during PoC. Findings should describe failures plainly.

---

## 9. Security And Privacy

Step 3 handles raw local audio. Treat it as sensitive.

Requirements:

- No backend credentials.
- No Azure credentials.
- No access/refresh token handling.
- No network upload.
- No raw audio bytes in console logs.
- No raw audio bytes in exception messages.
- Diagnostic WAV disabled by default.
- Diagnostic files ignored by git.
- Diagnostic files should be short and manually removable.

The implementation should not create a hidden long-lived recording cache. Archive bridge belongs to Step 6.

---

## 10. Implementation Sequence

Recommended order for the implementer:

1. Create `desktop/Kloser.Capture.Poc` console project.
2. Add `desktop/.gitignore`.
3. Add `--list-devices` using NAudio device enumeration.
4. Implement `MicCaptureSource` and show live native-format events without resampling.
5. Implement `LoopbackCaptureSource` and show live native-format events without resampling.
6. Add `Pcm16Resampler` and verify PCM16 16 kHz mono output for mic.
7. Apply the same normalized output path to loopback.
8. Add `Pcm16FrameEmitter` with source-separated seq/frame timing.
9. Add console status renderer.
10. Add dev-only diagnostic WAV writer.
11. Run manual smoke matrix.
12. Write `PHASE_9_STEP_3_FINDINGS.md`.
13. Only after validation, update `PHASE_9_MASTER.md` Step 3 checkbox.

Do not start with WPF or Flutter.

---

## 11. Validation

### 11.1 Automated / Build Checks

Required:

```powershell
dotnet --info
dotnet restore desktop/Kloser.Capture.Poc/Kloser.Capture.Poc.csproj
dotnet build desktop/Kloser.Capture.Poc/Kloser.Capture.Poc.csproj
dotnet run --project desktop/Kloser.Capture.Poc -- --list-devices
git diff --check
```

If a .NET test project is added for pure logic, also run:

```powershell
dotnet test desktop/Kloser.Capture.Poc.Tests/Kloser.Capture.Poc.Tests.csproj
```

Unit-test candidates if the implementer adds tests:

- frame byte size calculation
- `frame_ms` validation
- per-source sequence increments
- queue cap / dropped frame policy
- `CapturedAudioFrame` metadata construction

Hardware capture itself is manual smoke, not a reliable CI test.

### 11.2 Manual Windows Smoke

Minimum smoke:

1. Run `--list-devices`; confirm default mic and default render device are visible.
2. Run capture for 30 seconds with no diagnostic WAV.
3. Speak into microphone; `agent_mic` level must move.
4. Play local audio or softphone audio; `system_loopback` level must move.
5. Mute microphone; `agent_mic` level should drop while loopback can continue.
6. Stop system audio; `system_loopback` level should drop while mic can continue.
7. Run with `--write-diagnostic-wav --duration-sec 30`.
8. Play both generated WAVs and verify source separation.
9. Confirm no diagnostic WAV is staged in git.

Device behavior smoke:

| Scenario | Required note |
|---|---|
| Built-in laptop mic + speakers | Works / fails with reason |
| USB headset mic + headset output | Works / fails with reason |
| Bluetooth headset if available | Works / fails with reason |
| Device unplug mid-run | Behavior observed |
| Silence/mute | No false fatal error |

Performance baseline:

- 5 minute run if hardware is available.
- Record average CPU and memory if easy.
- Record dropped frame count.

### 11.3 Git Safety

Before final handoff:

```powershell
git status --short --branch
git diff --stat
git diff --check
```

No `.wav`, `.pcm`, `.raw`, `.log`, `bin/`, or `obj/` artifacts may be staged.

---

## 12. Findings Document Required

After implementation, create:

```text
docs/plan/phase-9/PHASE_9_STEP_3_FINDINGS.md
```

Required contents:

- Summary of implementation.
- Exact files changed.
- Native capture formats observed.
- Final emitted format proof: PCM16 16 kHz mono.
- Frame duration and byte size.
- Device matrix results.
- Diagnostic WAV result.
- Dropped frame count.
- CPU/memory baseline if measured.
- Known limitations.
- Whether Step 4 can start.

Do not mark Step 3 complete in `PHASE_9_MASTER.md` until this findings document and validation results exist.

---

## 13. Handoff Prompt

Use this exact instruction for the implementer:

```text
Phase 9 Step 3 Windows capture engine PoC를 구현한다.

반드시 먼저 읽을 문서:
- docs/plan/phase-9/PHASE_9_MASTER.md
- docs/plan/phase-9/PHASE_9_STEP_1_DESKTOP_CAPTURE_ARCHITECTURE.md
- docs/plan/phase-9/PHASE_9_STEP_2_PLAN.md
- docs/plan/phase-9/PHASE_9_STEP_2_FINDINGS.md
- docs/plan/phase-9/PHASE_9_STEP_3_PLAN.md

범위:
- top-level desktop/ 아래 C#/.NET 8 Windows console PoC를 만든다.
- NAudio 기반으로 microphone capture와 WASAPI loopback capture를 동시에 수행한다.
- source label은 agent_mic, system_loopback만 사용한다.
- 두 source 모두 PCM16 signed little-endian, 16 kHz, mono frame으로 normalize한다.
- 기본 frame_ms는 40ms이고 20/40/60/80/100ms만 허용한다.
- 내부 CapturedAudioFrame은 Step 2 AudioChunkMeta + binary payload로 바로 변환 가능한 shape여야 한다.
- console에 level, frame count, dropped frame, device 상태를 표시한다.
- diagnostic WAV는 --write-diagnostic-wav 옵션에서만 짧게 쓰고 기본값은 off다.
- diagnostic audio와 bin/obj는 git에 포함하지 않는다.

하지 말 것:
- backend Socket.io 전송 구현 금지.
- Azure Speech 호출 금지.
- Flutter/WPF shell 구현 금지.
- 로그인/token 저장 구현 금지.
- Phase 8 recording upload/finalize 구현 금지.
- browser MediaRecorder 구현 금지.
- provider import 구현 금지.

검증:
- dotnet restore/build
- --list-devices 실행
- Windows manual smoke: mic + loopback simultaneous capture
- diagnostic WAV source separation 확인
- git diff --check

산출물:
- desktop/... PoC 코드
- docs/plan/phase-9/PHASE_9_STEP_3_FINDINGS.md
- 검증 통과 후에만 PHASE_9_MASTER.md Step 3 checkbox 업데이트
```

---

## 14. Exit Criteria

Step 3 is complete only when all are true:

- [ ] `dotnet build` passes for the PoC project.
- [ ] `--list-devices` lists capture and render devices.
- [ ] Mic and loopback can run at the same time on Windows.
- [ ] Both sources emit PCM16 16 kHz mono frames.
- [ ] Per-source seq and timing metadata are present.
- [ ] Console status shows level and dropped frame count.
- [ ] Dev-only diagnostic WAV proves source separation.
- [ ] No diagnostic audio or build artifacts are staged.
- [ ] `PHASE_9_STEP_3_FINDINGS.md` exists.
- [ ] Codex review validates the diff and checks.

Only then update `PHASE_9_MASTER.md` Step 3 from `[ ]` to `[x]`.

---

## 15. Open Items For Later Steps

Do not solve these in Step 3:

- Step 4: UI shell and desktop auth/session model.
- Step 5: Socket.io audio streaming to backend.
- Step 5: reconnect and bounded network buffer semantics.
- Step 5: Azure streaming adapter.
- Step 6: final recording archive bridge through Phase 8 upload/finalize.
- Step 7: pilot matrix hardening and user guide.

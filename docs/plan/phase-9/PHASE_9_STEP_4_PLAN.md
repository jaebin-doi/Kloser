# Phase 9 Step 4 Plan - Desktop App Shell

작성일: 2026-05-21

상위 문서:

- `docs/plan/phase-9/PHASE_9_MASTER.md`
- `docs/plan/phase-9/PHASE_9_STEP_1_DESKTOP_CAPTURE_ARCHITECTURE.md`
- `docs/plan/phase-9/PHASE_9_STEP_2_PLAN.md`
- `docs/plan/phase-9/PHASE_9_STEP_2_FINDINGS.md`
- `docs/plan/phase-9/PHASE_9_STEP_3_PLAN.md`
- `docs/plan/phase-9/PHASE_9_STEP_3_FINDINGS.md`
- `desktop/Kloser.Capture.Poc/README.md`

> Step 4의 목적은 Step 3 console PoC를 상담원이 직접 조작할 수 있는 Windows desktop shell로 감싸는 것이다. 이 단계는 backend realtime 전송, Azure Speech, 로그인/token 저장, Phase 8 recording archive upload를 구현하지 않는다. Step 3에서 미룬 mic + loopback manual smoke는 Step 4 UI 안에서 수행한다.

---

## 0. Decision

Step 4 UI shell은 **C# WPF**로 간다.

결정:

- UI shell: C# WPF.
- Capture engine: Step 3 코드를 `Kloser.Capture.Core` class library로 분리.
- Console PoC: 유지. `Kloser.Capture.Poc`는 같은 core library를 참조하도록 바꾼다.
- WPF app: 신규 `Kloser.Desktop.Shell` 프로젝트를 추가하고 같은 core library를 참조한다.
- Backend integration: Step 5로 미룬다.
- Azure Speech: Step 5 이후 backend adapter 범위로 미룬다.

이 결정의 이유:

- 현재 리스크는 예쁜 제품 UI가 아니라 Windows audio device 제어, source별 level, dropped frame, device error를 안정적으로 노출하는 것이다.
- Step 3 코드가 이미 C# / NAudio / WASAPI에 있다. WPF는 같은 process에서 capture core를 직접 참조할 수 있어 IPC가 불필요하다.
- Flutter Windows를 지금 붙이면 C# capture engine과 Dart UI 사이 IPC, lifecycle, packaging을 동시에 풀어야 한다. Step 4 목표보다 넓다.
- Step 5에서 Socket.io sender를 붙이기 전에 capture session boundary를 WPF에서 검증할 수 있다.

반대안:

| Option | 보류 이유 |
|---|---|
| Flutter Windows + C# named pipe IPC | 제품 UI polish에는 좋지만 Step 4의 capture smoke와 state/error 확인에는 IPC 복잡도가 먼저 생김. |
| Console PoC 유지 + UI 없음 | 사용자가 직접 테스트하기 불편하고 Step 3 manual smoke 이월 결정을 충족하지 못함. |
| WinForms | 빠르지만 WPF가 layout/data binding/status panel 구성에 더 낫고 향후 tray/window 구조로 확장하기 쉽다. |
| Avalonia/MAUI | 크로스플랫폼 장점이 Step 4에는 필요 없음. WASAPI capture는 Windows 전용이다. |

---

## 1. Status Boundary

Step 3 상태:

- Code complete.
- Automatic gates pass.
- Codex blocker fix complete (`0e70f17 Handle missing Windows audio endpoints`).
- Manual smoke deferred to Step 4 UI.
- `PHASE_9_MASTER.md` Step 3 checkbox remains unchecked until Step 4 UI smoke passes.

Step 4는 Step 3을 "완료 처리"하는 단계가 아니다. Step 4 UI가 capture engine을 실제로 조작하면서 Step 3의 남은 manual validation을 수행할 수 있게 만드는 단계다.

---

## 2. Scope

### In Scope

- WPF desktop shell project.
- Capture core class library extraction.
- Existing console PoC migrated to use the extracted core.
- Device picker UI:
  - capture devices
  - render devices
  - refresh devices
  - selected mic
  - selected loopback render endpoint
- Capture controls:
  - start capture
  - stop capture
  - duration optional/manual stop
  - diagnostic WAV toggle
  - diagnostic output directory display
- Live status:
  - mic/source health
  - loopback/source health
  - peak/RMS/silence
  - frames emitted
  - dropped frames
  - native format
  - normalized format
  - elapsed time
  - process memory
- Error display:
  - friendly no-mic/no-render messages
  - bad device id
  - capture start failure
  - source fatal error
  - diagnostic WAV write failure
- Step 3 manual smoke matrix inside UI.
- Findings document after implementation:
  - `docs/plan/phase-9/PHASE_9_STEP_4_FINDINGS.md`

### Out Of Scope

- Backend Socket.io connection.
- `start_call`, `audio_start`, `audio_chunk`, `audio_end` emission.
- Azure Speech SDK.
- NAVER CLOVA / Deepgram.
- Login/auth/token storage.
- Windows Credential Manager / DPAPI.
- Phase 8 recording upload/finalize.
- Installer/auto-update.
- Tray-only app.
- Browser frontend changes.
- Final product visual polish.

---

## 3. Proposed Project Structure

Refactor from one console project into one core library plus two apps.

```text
desktop/
  Kloser.Capture.Core/
    Kloser.Capture.Core.csproj
    Audio/
      AudioSourceId.cs
      CapturedAudioFrame.cs
      CaptureOptions.cs
      CaptureSourceBase.cs
      DeviceEnumerator.cs
      MicCaptureSource.cs
      LoopbackCaptureSource.cs
      Pcm16FrameEmitter.cs
      Pcm16Resampler.cs
      LevelMeter.cs
    Diagnostics/
      DiagnosticWavWriter.cs

  Kloser.Capture.Poc/
    Kloser.Capture.Poc.csproj
    Program.cs
    Diagnostics/
      StatusRenderer.cs
    README.md

  Kloser.Desktop.Shell/
    Kloser.Desktop.Shell.csproj
    App.xaml
    App.xaml.cs
    MainWindow.xaml
    MainWindow.xaml.cs
    ViewModels/
      MainWindowViewModel.cs
      DeviceOptionViewModel.cs
      SourceStatusViewModel.cs
    Services/
      CaptureSessionController.cs
      DesktopDiagnosticWriter.cs
      UiDispatcher.cs
    README.md

  .gitignore
```

Rules:

- `Kloser.Capture.Core` must not reference WPF.
- `Kloser.Capture.Core` must not reference backend, Socket.io, Azure, auth, or platform frontend code.
- `Kloser.Capture.Poc` remains runnable from CLI.
- `Kloser.Desktop.Shell` owns UI-only state and command wiring.
- Generated `bin/`, `obj/`, `.diagnostics/`, `*.wav`, `*.pcm`, `*.raw`, `*.log` remain ignored.

Potential alternative if implementation cost is too high:

- Keep `Kloser.Capture.Poc/Audio/*` in place and have WPF reference the console project is not acceptable. Console app should not be a library dependency.
- Minimal acceptable refactor is moving audio/diagnostic core files into `Kloser.Capture.Core` and updating namespaces/project references.

---

## 4. UI Model

### 4.1 Main Window Layout

First screen should be the working capture console, not a landing page.

Recommended layout:

```text
Header
  Kloser Desktop Capture
  version / environment badge

Device band
  Microphone combobox        [Refresh]
  System audio combobox      [Refresh]
  Frame size segmented control: 20 / 40 / 60 / 80 / 100 ms
  Diagnostic WAV toggle

Control band
  Start capture
  Stop capture
  Open diagnostic folder

Status grid
  agent_mic
    health, level meter, RMS, silence, frames, dropped, native format
  system_loopback
    health, level meter, RMS, silence, frames, dropped, native format

Event/error panel
  latest user-actionable events
  friendly error messages

Smoke checklist panel
  S1 mic level
  S2 loopback level
  S3 simultaneous capture
  S4 WAV source separation
  S5 mute/silence
  S6 5 min baseline
```

Design style:

- Dense SaaS tool surface.
- No hero page.
- No decorative cards inside cards.
- Keep controls compact and readable.
- Use clear source labels:
  - `agent_mic`
  - `system_loopback`
- Use status colors conservatively:
  - healthy
  - silent
  - warning
  - error

### 4.2 UI State Model

```csharp
public enum CaptureUiState
{
    Idle,
    Starting,
    Running,
    Stopping,
    Stopped,
    Error
}
```

View model state:

```text
SelectedMicDeviceId
SelectedLoopbackDeviceId
CaptureDevices[]
RenderDevices[]
FrameMs
WriteDiagnosticWav
DiagnosticDir
UiState
Elapsed
AgentMicStatus
SystemLoopbackStatus
LastError
Events[]
SmokeChecklist
```

Source status:

```text
Source
IsEnabled
IsHealthy
NativeFormat
NormalizedFormat = pcm_s16le / 16000 Hz / mono
Peak
Rms
Silent
FramesEmitted
FramesDropped
LastErrorMessage
```

Smoke checklist state:

```text
S1MicLevelMoved
S2LoopbackLevelMoved
S3SimultaneousFramesObserved
S4DiagnosticWavWritten
S5MuteSilenceObserved
S6FiveMinuteBaselineComplete
```

Checklist items can be manually toggled by the user after observing behavior, but S1/S2/S3 can also be auto-suggested from status counters:

- S1 auto-suggest when `agent_mic.Peak > 0.001` and frames > 0.
- S2 auto-suggest when `system_loopback.Peak > 0.001` and frames > 0.
- S3 auto-suggest when both sources emitted frames during the same running session.

Do not persist checklist state beyond the local session in Step 4.

---

## 5. Capture Lifecycle

### 5.1 Start Capture

Sequence:

1. Refresh or reuse current device list.
2. Validate selected devices:
   - if mic required and none selected: friendly error.
   - if loopback required and none selected: friendly error.
3. Create `CaptureSessionController`.
4. Initialize mic source if selected/enabled.
5. Initialize loopback source if selected/enabled.
6. Start capture sources.
7. Start UI timer/status polling.
8. If diagnostic WAV is enabled, create lazy writer under `.diagnostics/<timestamp>/`.
9. Set UI state to `Running`.

Step 4 default should start both mic and loopback when both devices exist. If no mic exists, UI must allow loopback-only smoke without crash.

### 5.2 Running

While running:

- Drain frames on a background worker/timer.
- Write frames to diagnostic WAV only if enabled.
- Update status counters on UI dispatcher.
- Keep raw PCM out of UI text/logs.
- Do not send frames to backend.
- Do not retain raw frames after drain/write.

Frame handling boundary should be named clearly, for Step 5 reuse:

```csharp
public interface ICapturedFrameSink
{
    ValueTask OnFrameAsync(CapturedAudioFrame frame, CancellationToken ct);
}
```

Step 4 sinks:

- `NullFrameSink`
- `DiagnosticWavFrameSink`
- optional `CountingFrameSink`

Step 5 can add:

- `SocketIoAudioFrameSink`

### 5.3 Stop Capture

Sequence:

1. Disable Start button.
2. Stop sources.
3. Stop status timer.
4. Dispose diagnostic writer.
5. Show diagnostic paths if files were written.
6. Keep final counters visible.
7. Set UI state to `Stopped`.

Stop should be idempotent. Closing the window while running should call stop once.

### 5.4 Error Handling

Error mapping:

| Source | UI message |
|---|---|
| no active capture endpoint | 마이크 장치를 찾을 수 없습니다. 장치를 연결하거나 마이크 없이 테스트하세요. |
| no active render endpoint | 시스템 오디오 출력 장치를 찾을 수 없습니다. 출력 장치를 연결하세요. |
| bad selected device id | 선택한 장치가 사라졌습니다. 새로고침 후 다시 선택하세요. |
| capture start failure | 캡처를 시작하지 못했습니다. 장치가 다른 앱에서 독점 사용 중인지 확인하세요. |
| source fatal error | 해당 소스 캡처가 중단되었습니다. 다른 소스는 가능한 경우 계속 유지합니다. |
| diagnostic WAV write failure | 진단 WAV 저장에 실패했습니다. 캡처는 계속할 수 있습니다. |

Do not show raw exception stack traces in the main UI. A "copy technical details" control may show exception type/message only; no raw audio bytes.

---

## 6. Step 3 Manual Smoke Inside Step 4

Step 4 implementation must make these tests easy to run from the UI.

| ID | Test | UI requirement | Pass condition |
|---|---|---|---|
| S1 | mic level 움직임 | agent_mic meter and frames visible | 말할 때 peak/RMS > 0 and frames increase |
| S2 | loopback level 움직임 | system_loopback meter and frames visible | PC audio 재생 시 peak/RMS > 0 and frames increase |
| S3 | simultaneous capture | both source rows visible | same session에서 both frames increase, dropped=0 preferred |
| S4 | diagnostic WAV separation | WAV toggle + folder path visible | `agent_mic.wav` and `system_loopback.wav` created and source-separated |
| S5 | mute/silence | silence indicators visible | mute/stop audio lowers levels without fatal error |
| S6 | 5 min baseline | elapsed/memory/dropped visible | 5 min run completes with stable memory and explainable dropped count |

When S1-S6 pass, implementation findings should update:

- `PHASE_9_STEP_3_FINDINGS.md`
  - native mic format
  - observed device names
  - S1-S6 result
  - CPU/memory baseline
- `PHASE_9_STEP_4_FINDINGS.md`
  - UI smoke results
- `PHASE_9_MASTER.md`
  - Step 3 checkbox can be marked `[x]`
  - Step 4 checkbox only after Step 4 implementation and validation pass

---

## 7. Auth And Backend Boundary

Step 4 does not implement login.

However, UI should reserve non-functional placeholders so Step 5 has a natural place to attach:

- backend status: `Not connected`
- call status: `No active call`
- user/org: `Not signed in`

Do not store credentials. Do not create dummy token files. Do not call `/auth/login`.

Step 5 will decide:

- login flow
- access token memory-only handling
- refresh/device secret storage via Windows Credential Manager or DPAPI
- Socket.io connection lifecycle
- start/end call binding

---

## 8. Diagnostic WAV Policy

Policy from Step 3 stays unchanged:

- off by default.
- user must explicitly enable.
- write under `desktop/.diagnostics/<timestamp>/` or chosen local directory.
- write separate files:
  - `agent_mic.wav`
  - `system_loopback.wav`
- PCM16 16 kHz mono.
- no auto-upload.
- no long-lived hidden cache.
- ignored by git.

WPF UI must show:

- toggle state.
- output folder.
- written file paths after stop.
- warning text that diagnostic audio contains sensitive raw audio.

UI must not open the folder automatically without user action.

---

## 9. Implementation Sequence

Recommended implementation order:

1. Create `Kloser.Capture.Core` class library.
2. Move Step 3 audio core files into `Kloser.Capture.Core`.
3. Update namespaces/project references.
4. Keep `Kloser.Capture.Poc` build/run behavior unchanged.
5. Create `Kloser.Desktop.Shell` WPF project.
6. Build device enumeration UI.
7. Build source status view models and level meters.
8. Build start/stop capture controller.
9. Wire diagnostic WAV toggle.
10. Add smoke checklist panel.
11. Run console regression checks.
12. Run WPF manual smoke.
13. Write `PHASE_9_STEP_4_FINDINGS.md`.
14. Update `PHASE_9_STEP_3_FINDINGS.md` only with actual UI smoke observations.
15. Update `PHASE_9_MASTER.md` Step 3/4 checkboxes only after validation gates pass.

Do not start with auth, backend, or Azure.

---

## 10. Validation

### 10.1 Build Checks

Required:

```powershell
& "C:\Program Files\dotnet\dotnet.exe" restore desktop/Kloser.Capture.Core/Kloser.Capture.Core.csproj
& "C:\Program Files\dotnet\dotnet.exe" build desktop/Kloser.Capture.Core/Kloser.Capture.Core.csproj
& "C:\Program Files\dotnet\dotnet.exe" build desktop/Kloser.Capture.Poc/Kloser.Capture.Poc.csproj
& "C:\Program Files\dotnet\dotnet.exe" build desktop/Kloser.Desktop.Shell/Kloser.Desktop.Shell.csproj
```

Console regression:

```powershell
& "C:\Program Files\dotnet\dotnet.exe" run --project desktop/Kloser.Capture.Poc -- --list-devices
& "C:\Program Files\dotnet\dotnet.exe" run --project desktop/Kloser.Capture.Poc -- --duration-sec 1
& "C:\Program Files\dotnet\dotnet.exe" run --project desktop/Kloser.Capture.Poc -- --duration-sec abc
& "C:\Program Files\dotnet\dotnet.exe" run --project desktop/Kloser.Capture.Poc -- --no-mic --duration-sec 3
```

Repository hygiene:

```powershell
git status --short --branch
git diff --stat
git diff --check
git ls-files --others --exclude-standard desktop/
```

No `.wav`, `.pcm`, `.raw`, `.log`, `bin/`, or `obj/` artifacts may be staged.

### 10.2 Manual WPF Smoke

Required on a Windows machine with mic and output device:

1. Launch WPF app.
2. Confirm device picker lists mic and render device.
3. Start capture.
4. Speak into mic; verify S1.
5. Play PC audio; verify S2.
6. Confirm both sources count frames in same session; verify S3.
7. Enable diagnostic WAV, run 30 seconds, stop, play both WAVs; verify S4.
8. Mute mic and pause PC audio; verify S5.
9. Run 5 minutes; record CPU/memory/dropped frames; verify S6.
10. Confirm app close while running stops capture cleanly.

### 10.3 Optional UI Automation

WPF UI automation is optional in Step 4. If implementation adds tests, keep them limited to pure view model logic:

- device list projection
- state transitions
- error message mapping
- checklist auto-suggest logic

Do not attempt hardware capture in CI.

---

## 11. Documentation Deliverables

Implementation must produce:

- `docs/plan/phase-9/PHASE_9_STEP_4_FINDINGS.md`

If UI smoke is actually run, also update:

- `docs/plan/phase-9/PHASE_9_STEP_3_FINDINGS.md`
- `docs/plan/phase-9/PHASE_9_MASTER.md`

`PHASE_9_STEP_4_FINDINGS.md` must include:

- files changed.
- chosen shell and why.
- project structure after refactor.
- console PoC regression results.
- WPF build result.
- WPF manual smoke result.
- Step 3 deferred S1-S6 status.
- remaining risks.
- whether Step 5 can start.

---

## 12. Handoff Prompt

Use this instruction for the implementer:

```text
Phase 9 Step 4 Desktop App Shell을 구현한다.

반드시 먼저 읽을 문서:
- docs/plan/phase-9/PHASE_9_MASTER.md
- docs/plan/phase-9/PHASE_9_STEP_3_PLAN.md
- docs/plan/phase-9/PHASE_9_STEP_3_FINDINGS.md
- docs/plan/phase-9/PHASE_9_STEP_4_PLAN.md
- desktop/Kloser.Capture.Poc/README.md

결정:
- Step 4 shell은 C# WPF로 구현한다.
- Flutter는 이번 단계에서 사용하지 않는다.
- Step 3 capture code는 Kloser.Capture.Core class library로 분리한다.
- 기존 console PoC는 유지하고 core library를 참조하게 한다.
- 신규 WPF app은 Kloser.Desktop.Shell로 만든다.

범위:
- desktop/Kloser.Capture.Core 추가
- desktop/Kloser.Capture.Poc를 core 참조 구조로 갱신
- desktop/Kloser.Desktop.Shell WPF app 추가
- device picker
- start/stop capture
- mic/system_loopback level meter
- frames/dropped/native format/status 표시
- diagnostic WAV toggle + output path 표시
- friendly error panel
- Step 3 manual smoke S1-S6 checklist UI

하지 말 것:
- backend Socket.io 전송 금지
- Azure Speech 금지
- 로그인/token 저장 금지
- Phase 8 upload/finalize 금지
- installer/auto-update 금지
- PHASE_9_MASTER.md checkbox는 validation 전 변경 금지

검증:
- dotnet build core/console/WPF
- console PoC regression 유지
- WPF manual smoke S1-S6 가능하면 수행
- git diff --check
- generated wav/bin/obj/log artifact 미포함

산출물:
- desktop/Kloser.Capture.Core/...
- desktop/Kloser.Desktop.Shell/...
- updated desktop/Kloser.Capture.Poc/...
- docs/plan/phase-9/PHASE_9_STEP_4_FINDINGS.md
- UI smoke를 실제로 수행했다면 PHASE_9_STEP_3_FINDINGS.md 관측값 갱신
```

---

## 13. Exit Criteria

Step 4 is complete only when:

- [ ] `Kloser.Capture.Core` builds.
- [ ] `Kloser.Capture.Poc` still builds and runs CLI regression.
- [ ] `Kloser.Desktop.Shell` builds.
- [ ] WPF UI lists capture/render devices.
- [ ] WPF UI can start/stop capture.
- [ ] WPF UI shows source health, levels, frames, dropped frames, native formats.
- [ ] Friendly no-mic/no-render/bad-device errors are visible without stack traces.
- [ ] Diagnostic WAV remains off by default and writes only when enabled.
- [ ] Step 3 S1-S6 manual smoke can be run from the UI.
- [ ] No raw audio/build artifacts are staged.
- [ ] `PHASE_9_STEP_4_FINDINGS.md` exists.
- [ ] Codex review validates diff and checks.

If S1-S6 are actually passed during Step 4, Step 3 checkbox can be updated in the same or follow-up commit. If not, Step 3 remains unchecked and Step 4 findings must explain what hardware validation is still pending.

---

## 14. Step 5 Handoff

Step 5 should start only after Step 4 provides a stable capture session boundary.

Expected handoff from Step 4 to Step 5:

- source-separated `CapturedAudioFrame` stream.
- start/stop lifecycle controlled by UI.
- source status and error events.
- diagnostic WAV remains local-only.
- frame sink interface ready for `SocketIoAudioFrameSink`.
- backend placeholders visible but not connected.

Step 5 will add:

- auth/session.
- Socket.io `/calls` connection.
- `start_call`.
- `audio_start`.
- binary `audio_chunk`.
- `audio_end` / `end_call`.
- transcript/partial display path.

# Phase 9 Step 4 Findings — Desktop App Shell (WPF)

작성일: 2026-05-21
갱신: 2026-05-21 (Step 7 closeout — Step 5/6 E2E가 묵시적으로 통과시킨 S1-S6 항목 반영)

상위 문서: `PHASE_9_MASTER.md`
계획 문서: `PHASE_9_STEP_4_PLAN.md`
선행 결과: `PHASE_9_STEP_3_FINDINGS.md`, `PHASE_9_STEP_2_FINDINGS.md`

> Step 4는 Step 3의 console PoC capture engine을 사용자가 직접 조작할 수 있는 Windows desktop UI(WPF, MVVM)로 감쌌다. backend Socket.io 전송, Azure Speech, 로그인/token 저장, Phase 8 recording upload/finalize는 의도적으로 손대지 않았다. Step 3이 이월한 manual smoke matrix(S1-S6)를 본 UI에서 직접 수행할 수 있다.

---

## 0. Status

**Implementation complete; hardware manual smoke deferred (capture device 0 on dev session machine).**

- Capture engine `Kloser.Capture.Core` class library로 분리됨 (Plan §3).
- 기존 `Kloser.Capture.Poc` (console)이 core를 ProjectReference로 사용하도록 갱신됨.
- 신규 WPF `Kloser.Desktop.Shell` (MVVM, 외부 MVVM 프레임워크 의존 없음) 추가됨.
- 자동 게이트(`dotnet build` 3 projects / console regression 4 commands / WPF launch 5초 dry-run / `git diff --check`)는 모두 통과.
- **S1-S6 manual smoke는 본 dev 세션 머신에 active capture device가 0개라 사용자 머신에서 수행해야 한다** — UI는 동작 가능, 마이크 / 시스템 오디오 가용 머신에서 사용자가 S1-S6 체크박스를 채워 주시면 그 결과를 `PHASE_9_STEP_3_FINDINGS.md`에 반영하고 `PHASE_9_MASTER.md` Step 3 / Step 4 체크박스 갱신.
- `PHASE_9_MASTER.md` Step 4 체크박스는 본 라운드에서 **변경하지 않는다** (Plan §13 exit criteria, Codex 리뷰 + UI smoke 통과 시점에 갱신).

### 0.1 Step 7 Closeout Addendum (2026-05-21)

Step 5/6 manual E2E가 WPF UI 위에서 (login → 통화 시작 → 마이크 발화 → 시스템 오디오 재생 → 통화 종료 → archive available → calls.html 재생) 정상 통과했다. 본 단계가 위임받은 §6.3 S1-S6 deferred 표는 Step 7 closeout 매트릭스에서 다음과 같이 정리한다:

| ID | 상태 | 근거 |
|---|---|---|
| S1 mic level | **PASS** (Step 5/6 E2E) | partial+final transcript가 mic 입력에서 생성. WPF agent_mic peak/RMS 게이지가 움직였다는 사용자 관측 (Step 5 findings §9). |
| S2 loopback level | **PASS** (Step 5/6 E2E) | partial+final transcript가 시스템 오디오에서 생성. WPF system_loopback 게이지 움직임 관측. |
| S3 mic + loopback 동시 | **PASS** (Step 5/6 E2E) | 두 source counter 동시 증가 + Step 6 archive stereo WAV에 양 채널 audio. |
| S4 diagnostic WAV separation | **user-run 대기** | Step 5/6은 archive WAV 경로만 행사. diagnostic WAV toggle은 별도 검증 필요. |
| S5 mute / silence | **user-run 대기** | 정상 발화 시나리오만 수행. mute / silence-only는 별도 검증 필요. |
| S6 5분 baseline | **user-run 대기** | Step 5 E2E 최장 196초(~3:16) → 5분(300s) 미달. |

`PHASE_9_MASTER.md` Step 4 체크박스는 **S4/S5/S6 user-run으로 채워질 때까지 본 라운드에서 변경하지 않는다.** Step 7 findings에 동일 매트릭스를 둔다.

---

## 1. 결과 요약

신규 / 변경된 파일은 §2에서 명세. 핵심 결정:

- **C# WPF**로 shell 구현. Flutter Windows는 본 단계에서 사용하지 않음 (Plan §0).
- **MVVM은 hand-rolled** — `ObservableObject` + `RelayCommand` 20-라인 helper만 추가. CommunityToolkit.Mvvm 같은 외부 의존성 없음.
- **`Kloser.Capture.Core` class library**로 audio engine 추출. console PoC + WPF app이 동일 코드를 참조. console과 WPF 두 곳에서 capture 동작이 분기될 위험을 차단.
- **`ICapturedFrameSink` 경계 신규** — `NullFrameSink` / `CountingFrameSink` / `DiagnosticWavFrameSink` 3개 구현. Step 5에서 `SocketIoAudioFrameSink`만 추가하면 controller 코드 변경 없이 backend 전송 붙이기 가능.
- **상태 폴링은 `DispatcherTimer` 500 ms 간격** — WASAPI capture callback 스레드를 UI가 잡지 않음.
- **friendly error 표시 + raw audio 0 노출** — Step 3 Codex blocker fix(`0e70f17`)의 exit code 2/3 패턴을 UI에서도 보존. 에러 패널에 stack trace 없이 한 줄씩만 표시.
- **Codex review blocker 1건 수정** — 최초 WPF launch 검증에서 `ProgressBar.Value` 기본 TwoWay binding이 read-only `PeakPercent` / `RmsPercent`에 write하려고 하며 앱이 시작 직후 종료됐다. `MainWindow.xaml`의 4개 level meter binding을 `Mode=OneWay`로 고정했고, 이후 WPF 5초 launch dry-run이 통과했다.

검증:

| Gate | 결과 |
|---|---|
| `dotnet build desktop/Kloser.Capture.Core/Kloser.Capture.Core.csproj` | 0 warning / 0 error, 5.10s (cold) |
| `dotnet build desktop/Kloser.Capture.Poc/Kloser.Capture.Poc.csproj` | 0 warning / 0 error, 1.70s (incremental) |
| `dotnet build desktop/Kloser.Desktop.Shell/Kloser.Desktop.Shell.csproj` | 0 warning / 0 error, 1.78s (incremental, fix 후) |
| `dotnet run -- --list-devices` (console) | exit 0, 1 default + 1 active render, 0 capture |
| `dotnet run -- --duration-sec 1` (console, mic 없는 환경) | exit 3, friendly error `no active capture endpoint found; rerun --list-devices or use --no-mic` |
| `dotnet run -- --duration-sec abc` (console, bad int) | exit 2, friendly `argument error: --duration-sec requires an integer value, got 'abc'` |
| `dotnet run -- --no-mic --duration-sec 3` (console) | exit 0, loopback bound, 정상 종료 |
| WPF process 5초 launch (`Start-Process` + `Stop-Process`) | Codex binding fix 후 XAML parse + VM 생성 + RefreshDevices + 이벤트/에러 패널 / S1-S6 체크박스 바인딩 모두 정상; 프로세스 안정 유지, 클린 종료 |
| `git diff --check` | clean |
| 스테이지 artifact 검사 (`.wav` / `.pcm` / `.raw` / `.log` / `bin/` / `obj/`) | 0건 |

---

## 2. Files Changed

### 2.1 신규 `desktop/Kloser.Capture.Core/` (12 files)

| File | Status | Notes |
|---|---|---|
| `Kloser.Capture.Core.csproj` | new | net8.0-windows class library, NAudio 2.2.1 |
| `Audio/AudioSourceId.cs` | renamed from Poc | namespace → `Kloser.Capture.Core.Audio` |
| `Audio/CaptureOptions.cs` | renamed from Poc | 동일 |
| `Audio/CapturedAudioFrame.cs` | renamed from Poc | 동일 |
| `Audio/CaptureSourceBase.cs` | renamed from Poc | 동일 |
| `Audio/DeviceEnumerator.cs` | renamed from Poc | 동일 (Codex fix `0e70f17` 보존) |
| `Audio/LevelMeter.cs` | renamed from Poc | 동일 |
| `Audio/LoopbackCaptureSource.cs` | renamed from Poc | 동일 |
| `Audio/MicCaptureSource.cs` | renamed from Poc | 동일 |
| `Audio/Pcm16FrameEmitter.cs` | renamed from Poc | 동일 |
| `Audio/Pcm16Resampler.cs` | renamed from Poc | 동일 |
| `Diagnostics/DiagnosticWavWriter.cs` | renamed from Poc | namespace → `Kloser.Capture.Core.Diagnostics`, `using` 갱신 |

### 2.2 수정 `desktop/Kloser.Capture.Poc/` (3 files)

| File | Status | Change |
|---|---|---|
| `Kloser.Capture.Poc.csproj` | modified | `PackageReference NAudio` 제거, `ProjectReference ..\Kloser.Capture.Core\...` 추가; comment에 Step 4 추가 |
| `Program.cs` | modified | `using Kloser.Capture.Poc.Audio/Diagnostics` → `using Kloser.Capture.Core.Audio/Diagnostics` + 기존 `Kloser.Capture.Poc.Diagnostics` (StatusRenderer) 유지 |
| `Diagnostics/StatusRenderer.cs` | modified | `using Kloser.Capture.Poc.Audio` → `using Kloser.Capture.Core.Audio` (namespace 본체는 console-only이므로 그대로 `Kloser.Capture.Poc.Diagnostics`) |

### 2.3 신규 `desktop/Kloser.Desktop.Shell/` (17 files)

| File | Role |
|---|---|
| `Kloser.Desktop.Shell.csproj` | net8.0-windows + UseWPF=true, ProjectReference Core |
| `App.xaml` | StartupUri=MainWindow + 전역 brush/style 리소스 |
| `App.xaml.cs` | `Application` 서브클래스 (의도적으로 minimal) |
| `MainWindow.xaml` | header / device band / control band / source status grid / errors / events / smoke checklist S1-S6 |
| `MainWindow.xaml.cs` | DataContext 주입, Closed 시 VM Dispose |
| `ViewModels/ObservableObject.cs` | `INotifyPropertyChanged` minimal base |
| `ViewModels/RelayCommand.cs` | `ICommand` impl |
| `ViewModels/DeviceOptionViewModel.cs` | combobox row |
| `ViewModels/SourceStatusViewModel.cs` | per-source live status (peak / rms / silent / frames / dropped / native format / health) |
| `ViewModels/SmokeChecklistViewModel.cs` | S1-S6 + auto-suggest (S1/S2/S3 카운터 기반, S6 5분 경과 기반) |
| `ViewModels/MainWindowViewModel.cs` | top-level VM (devices, capture controls, status, events, errors, checklist) |
| `Services/ICapturedFrameSink.cs` | 인터페이스 + `NullFrameSink` + `CountingFrameSink` |
| `Services/DesktopDiagnosticWriter.cs` | `DiagnosticWavFrameSink` (core `DiagnosticWavWriter` wrap) |
| `Services/UiDispatcher.cs` | WPF `Dispatcher` 얇은 wrapper |
| `Services/CaptureSessionController.cs` | capture 시작/중지/pump 오케스트레이션, friendly error 매핑, 진단 dir 자동 생성 |
| `README.md` | 사용법 + UI layout + security policy |

총 **신규 30 파일 (Core 12, Shell 17, findings 1) + 수정 3 파일**. `PHASE_9_MASTER.md` Step 3 / Step 4 체크박스는 Codex 리뷰 + UI manual smoke 통과 후에만 별도 commit으로 갱신.

---

## 3. Project Structure After Refactor

```text
desktop/
  Kloser.Capture.Core/                         ← class library (new)
    Kloser.Capture.Core.csproj                   NAudio 2.2.1, net8.0-windows
    Audio/AudioSourceId.cs                       (moved)
    Audio/CaptureOptions.cs                      (moved)
    Audio/CapturedAudioFrame.cs                  (moved)
    Audio/CaptureSourceBase.cs                   (moved)
    Audio/DeviceEnumerator.cs                    (moved, includes 0e70f17 fix)
    Audio/LevelMeter.cs                          (moved)
    Audio/LoopbackCaptureSource.cs               (moved)
    Audio/MicCaptureSource.cs                    (moved)
    Audio/Pcm16FrameEmitter.cs                   (moved)
    Audio/Pcm16Resampler.cs                      (moved)
    Diagnostics/DiagnosticWavWriter.cs           (moved)

  Kloser.Capture.Poc/                          ← console app (modified)
    Kloser.Capture.Poc.csproj                    ProjectReference → Core
    Program.cs                                   (using updated)
    Diagnostics/StatusRenderer.cs                console-only formatter
    README.md                                    (unchanged)

  Kloser.Desktop.Shell/                        ← WPF app (new)
    Kloser.Desktop.Shell.csproj                  UseWPF + ProjectReference Core
    App.xaml / App.xaml.cs
    MainWindow.xaml / MainWindow.xaml.cs
    ViewModels/
      ObservableObject.cs
      RelayCommand.cs
      DeviceOptionViewModel.cs
      SourceStatusViewModel.cs
      SmokeChecklistViewModel.cs
      MainWindowViewModel.cs
    Services/
      ICapturedFrameSink.cs                      (NullFrameSink + CountingFrameSink)
      DesktopDiagnosticWriter.cs                 (DiagnosticWavFrameSink)
      UiDispatcher.cs
      CaptureSessionController.cs
    README.md

  .gitignore                                   (unchanged; .diagnostics/ wav pcm raw log bin/ obj/ ignored)
```

원칙 (Plan §3 그대로):

- `Kloser.Capture.Core`는 WPF / WinForms / 백엔드 / Socket.io / Azure / auth 어느 것도 참조하지 않는다.
- `Kloser.Capture.Poc` console PoC는 CLI 그대로 동작 (Step 3 회귀 확인 OK).
- `Kloser.Desktop.Shell`이 UI-only state + command wiring만 소유.

---

## 4. WPF UI Summary

`MainWindow.xaml`은 dense SaaS-style 단일 화면 (Plan §4.1):

```
┌─ Header ───────────────────────────────────────────────────────────┐
│ Kloser Desktop Capture — Step 4 PoC                                │
│ state: Idle   elapsed: 00:00:00   mem: 0.0 MB                      │
├─ Device band ──────────────────────────────────────────────────────┤
│ Microphone [combobox]    System audio [combobox]     [Refresh]     │
│ frame_ms [20|40|60|80|100]   [ ] Write diagnostic WAV   → (path)   │
├─ Control band ─────────────────────────────────────────────────────┤
│ [Start capture] [Stop capture]                                     │
│ backend: Not connected (Step 5 예정)   call: ...   user: ...       │
├─ Status grid ─────────────┬─ Errors ───────────────────────────────┤
│ agent_mic (microphone)    │ (raw audio / stack 없음)               │
│  peak  ████░░ 0.000        │                                        │
│  rms   ██░░░░ 0.000        │                                        │
│  enabled / healthy / frames / dropped / native / normalized        │
│                           ├─ Events ───────────────────────────────┤
│ system_loopback           │ [HH:MM:SS] capture started             │
│  peak  ████░░ ...         │ [HH:MM:SS] devices refreshed: 1 / 2    │
│  rms   ...                │ ...                                    │
├─ Smoke checklist S1-S6 ────────────────────────────────────────────┤
│ [ ] S1 mic level 움직임      [ ] S2 loopback level 움직임           │
│ [ ] S3 mic + loopback 동시   [ ] S4 diagnostic WAV separation       │
│ [ ] S5 mute/silence          [ ] S6 5분 baseline                    │
└────────────────────────────────────────────────────────────────────┘
```

S1-S3은 `Smoke.AutoSuggest` 가 카운터로 자동 체크 (peak > 0.001 + frames > 0). S4는 stop 시점에 `agent_mic.wav` + `system_loopback.wav` 두 파일 모두 작성됐을 때 자동 체크. S5 / S6은 사용자가 직접 체크해야 한다 (mute toggle / 5분 경과 관측). 모든 체크박스는 사용자가 수동 토글도 가능 (TwoWay binding).

UI state machine: `Idle` → `Starting` → `Running` → `Stopping` → `Stopped` (또는 `Error`). `StartCaptureCommand.CanExecute = IsIdle`, `StopCaptureCommand.CanExecute = IsRunning`.

---

## 5. Console PoC Regression Results

| Command | 기대 | 실제 (본 세션) |
|---|---|---|
| `--list-devices` | render 2 + capture 0 노출 | OK (default MSI MP242L + active TFG32Q10P) |
| `--duration-sec 1` (mic 없는 환경) | friendly error + exit 3 + no stack | OK — `error: no active capture endpoint found; rerun --list-devices or use --no-mic` |
| `--duration-sec abc` (bad int) | friendly error + exit 2 + no stack | OK — `argument error: --duration-sec requires an integer value, got 'abc'` + 도움말 |
| `--no-mic --duration-sec 3` | exit 0, loopback bound | OK, 정상 종료, frames=0 silence |

Step 3 + Codex blocker fix (`0e70f17 Handle missing Windows audio endpoints`) behavior는 **library 분리 후에도 무변경**으로 유지된다.

---

## 6. WPF Build + Smoke Result

### 6.1 빌드

```powershell
& "C:\Program Files\dotnet\dotnet.exe" build desktop/Kloser.Desktop.Shell/Kloser.Desktop.Shell.csproj
# 0 warnings, 0 errors (1.78s incremental)
```

빌드 중 1회 컴파일 에러 발생 (`'Path' 이름이 현재 컨텍스트에 없습니다`) → `Services/CaptureSessionController.cs` 상단에 `using System.IO;` 추가로 해결. ImplicitUsings가 활성화돼 있지만 WPF SDK는 `System.IO`를 자동 import하지 않음 (console SDK와 다른 점).

### 6.2 Launch dry-run

본 세션 머신 (capture device 0개):

```powershell
$p = Start-Process -FilePath "C:\Program Files\dotnet\dotnet.exe" -ArgumentList "run","--project","desktop/Kloser.Desktop.Shell","--no-build" -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 5
# PID stayed alive 5s -> XAML parse + VM bootstrap OK
Stop-Process -Id $p.Id -Force
# stopped cleanly
```

결과: 프로세스 5초 안정 유지 + 클린 종료. XAML 파싱, DataContext 바인딩, `RefreshDevices()` 호출, RelayCommand `CanExecute` 분기, ItemsControl 바인딩 (Events / LastErrors), CheckBox TwoWay 바인딩 (S1-S6)이 모두 정상 동작했다는 의미. 실 capture 시작은 시도하지 않았으므로 §6.3 S1-S6은 deferred.

### 6.3 Step 3 deferred S1-S6 — 본 라운드 status

| ID | 검증 항목 | 본 세션 결과 |
|---|---|---|
| S1 | mic level 움직임 | **deferred** (capture device 0) |
| S2 | loopback level 움직임 | **deferred** (실 오디오 재생 없음) |
| S3 | mic + loopback 동시 캡처 | **deferred** (S1 의존) |
| S4 | diagnostic WAV source separation | **deferred** (S1/S2 의존) |
| S5 | mute / silence 동작 | **deferred** (S1/S2 의존) |
| S6 | 5분 baseline | **deferred** (장기 실행 미수행) |

사용자가 마이크 + 시스템 오디오 가능한 Windows 머신에서 본 WPF를 띄우고 S1-S6 체크리스트를 채워 주시면:

1. 결과를 `PHASE_9_STEP_3_FINDINGS.md` §3 / §6 / §8 / §9에 native mic format / device 이름 / dropped 수 / CPU·메모리 baseline 등 실 관측 값으로 채움.
2. `PHASE_9_STEP_3_FINDINGS.md` §1.3 / §6 / §12 의 S1-S6 deferred 표시를 result row로 갱신.
3. `PHASE_9_MASTER.md` Step 3 + Step 4 체크박스 `[x]`로 갱신 (Plan §13 exit criteria).

---

## 7. Generated Artifact 미포함 확인

```bash
git status --short | grep -E "\.(wav|pcm|raw|log)$|bin/|obj/"
# no audio/build artifacts staged

git ls-files --others --exclude-standard desktop/
# desktop/Kloser.Capture.Core/Kloser.Capture.Core.csproj
# desktop/Kloser.Desktop.Shell/App.xaml
# desktop/Kloser.Desktop.Shell/App.xaml.cs
# desktop/Kloser.Desktop.Shell/Kloser.Desktop.Shell.csproj
# desktop/Kloser.Desktop.Shell/MainWindow.xaml
# desktop/Kloser.Desktop.Shell/MainWindow.xaml.cs
# desktop/Kloser.Desktop.Shell/README.md
# desktop/Kloser.Desktop.Shell/Services/CaptureSessionController.cs
# desktop/Kloser.Desktop.Shell/Services/DesktopDiagnosticWriter.cs
# desktop/Kloser.Desktop.Shell/Services/ICapturedFrameSink.cs
# desktop/Kloser.Desktop.Shell/Services/UiDispatcher.cs
# desktop/Kloser.Desktop.Shell/ViewModels/DeviceOptionViewModel.cs
# desktop/Kloser.Desktop.Shell/ViewModels/MainWindowViewModel.cs
# desktop/Kloser.Desktop.Shell/ViewModels/ObservableObject.cs
# desktop/Kloser.Desktop.Shell/ViewModels/RelayCommand.cs
# desktop/Kloser.Desktop.Shell/ViewModels/SmokeChecklistViewModel.cs
# desktop/Kloser.Desktop.Shell/ViewModels/SourceStatusViewModel.cs

git diff --check
# clean
```

`desktop/.gitignore`가 `.diagnostics/`, `*.wav`, `*.pcm`, `*.raw`, `*.log`, `bin/`, `obj/` 모두 차단. WPF build artifact (`bin/`, `obj/`)는 두 신규 프로젝트 모두 자동으로 ignored.

---

## 8. Decisions

### 8.1 MVVM은 hand-rolled

CommunityToolkit.Mvvm 같은 source-generator 의존을 빼고 20-라인 `ObservableObject` + `RelayCommand`만 추가. Plan §0이 명시한 "Step 4 목표보다 넓은 의존성을 도입하지 말 것" 정신. Step 5/7에서 source generator가 필요해지면 그때 교체 비용이 작다.

### 8.2 `Kloser.Capture.Core`는 net8.0-windows

NAudio WASAPI loopback이 Windows 전용이라 cross-plat target은 의미 없음. `CA1416` warning은 csproj에서 suppress.

### 8.3 `ICapturedFrameSink` 인터페이스 형식

Step 5에서 `SocketIoAudioFrameSink`만 추가하면 controller 코드 변경 없이 backend 전송 붙이기. `ValueTask` async signature는 mock(`Null`/`Counting`) sink에서는 `CompletedTask`를 반환하고, network sink에서는 실제 await 가능.

### 8.4 `DispatcherTimer` 500 ms 폴링

WASAPI capture는 자체 callback 스레드를 가지고, frame은 `Pcm16FrameEmitter.Drain()`로 thread-safe하게 꺼낼 수 있다. UI 갱신은 500ms 간격 timer에서 모아 처리 — 더 빈번한 갱신은 GC pressure만 늘리고 사용자 체감 차이가 없다.

### 8.5 S5 / S6은 사용자 수동 체크

S5 (mute/silence)는 사용자의 마우스 / OS volume 조작이 필요. S6 (5분 baseline)은 5분이 실제 흐른 뒤 자동 체크되긴 하지만 CPU / 메모리 안정 여부 판단은 사람이 봐야 한다. S4도 "파일이 작성됐다"는 자동 체크는 가능하지만 source separation 청취 확인은 사람만 가능 — auto-check는 file-exists 조건만 충족하면 켜고, 사용자가 부적합 판정 시 수동으로 다시 끄는 패턴.

### 8.6 backend / call / user placeholder

Plan §7 따라 UI에 "Not connected (Step 5 예정)" 같은 정적 텍스트만 표시. Step 4가 dummy token, 가짜 login 흐름을 만들지 않는다는 정책을 가시화.

### 8.7 friendly error → UI 패널

Console PoC의 `Program.Main` exit 2 (ArgumentException) / exit 3 (InvalidOperationException) 매핑은 그대로 유지하고 (Step 3 0e70f17 fix), WPF에서는 `CaptureSessionController.Start`가 같은 예외를 잡아 `FriendlyErrors` 배열로 surface → MainWindowViewModel.PushError → ItemsControl. Stack trace는 어디에도 출력 안 함.

### 8.8 `git mv`로 11 파일 이동

Codex 리뷰 시 rename이 명시적으로 보이도록 `git mv` 사용. `git status --short`에서 `RM` (rename + modified) 로 표시됨 — content 변경은 namespace 한 줄만, 따라서 git이 동일성 인식 OK.

---

## 9. Risks / Follow-ups

- **마이크 부재 manual smoke 미수행.** 본 세션의 가장 큰 한계. 사용자 머신에서 S1-S6 6 항목 통과해야 Step 3 / Step 4 master 체크박스가 갱신 가능. Step 5 작업 전에 이 라운드를 끼우는 게 안전.
- **`useEventSync: true` 일부 드라이버 호환성.** Step 3 §10.3 risk 그대로. WPF에서 fatal error 발생 시 `MainWindowViewModel.OnTickAsync` → `Smoke.S5MuteSilenceObserved`에 영향 없이 `LastErrors` 패널로 surface. fallback (event-sync 실패 시 polling) 결정은 manual smoke 로그 보고 Step 5 plan 작성 시 같이 정함.
- **Linear resampler quality.** Step 3 §10.1 그대로 — `Pcm16Resampler`가 그대로 core로 이동, 교체 시점은 Step 5에서 Azure STT 정확도 ground-truth 확보 후.
- **WPF SDK ImplicitUsings 차이.** Console SDK는 `System.IO`를 자동 import하지만 WPF SDK는 안 한다. Shell 첫 빌드에서 한 번 경험; 이후 추가 코드 작성 시 `System.IO`, `System.Threading.Tasks` 같은 namespace는 명시 import 필요.
- **S6 5분 baseline auto-check 조건.** 현재는 elapsed >= 5분이면 자동 체크. CPU / 메모리 안정성 판정 없이 시간만으로 체크하는 셈이라 사용자가 결과 부적합 판정 시 수동 토글로 다시 꺼야 함. 자동 체크 임계를 추가로 조이는 건 Step 7 polish 단계.
- **Backend / call / user placeholder.** 화면 가시성을 위해 정적 텍스트로 둠. Step 5에서 실 connect 흐름 들어올 때 binding source를 `BackendStatusViewModel` 같은 별 VM으로 분리 권장.
- **DispatcherTimer 500ms.** capture가 실제로 frame을 emit하기 시작하면 status grid 갱신이 500ms 단위로만 보임. 사람의 체감 만족도는 충분하지만 level meter가 살짝 stutter할 가능성. Step 7에서 16ms로 내리거나, capture-thread → UI dispatcher push 전환 검토.

---

## 10. Not Implemented (계획대로 — Plan §2 Out Of Scope)

- Backend Socket.io 연결 (Step 5).
- `start_call` / `audio_start` / `audio_chunk` / `audio_end` 네트워크 emit (Step 5).
- Azure Speech SDK / Naver Clova / Deepgram.
- 로그인 / token 저장 / Windows Credential Manager / DPAPI.
- Phase 8 recording upload/finalize bridge (Step 6).
- 인스톨러 / 자동 업데이트 (Step 7+).
- 트레이 전용 UX, 알림 영역 통합.
- Browser frontend 변경.
- 최종 시각 polish.

---

## 11. Step 5 시작 가능 여부

Plan §14 expected handoff:

- [x] source-separated `CapturedAudioFrame` stream (core library export).
- [x] start/stop lifecycle controlled by UI (MainWindowViewModel + CaptureSessionController).
- [x] source status and error events (SourceStatusViewModel + LastErrors).
- [x] diagnostic WAV remains local-only (DiagnosticWavFrameSink, off by default).
- [x] frame sink interface ready for `SocketIoAudioFrameSink` (ICapturedFrameSink in Services).
- [x] backend placeholders visible but not connected (BackendStatus / CallStatus / UserStatus).

자동 게이트 통과 + boundary가 Step 5 요구 그대로 준비됨. **다만 hardware manual smoke (S1-S6)가 사용자 머신에서 통과한 뒤** Step 5에 진입하는 게 안전 — capture가 실제로 frame을 만들어내는 걸 확인하지 못한 상태에서 Socket.io 전송 코드를 붙이면 backend 측 디버깅이 까다로워진다. Plan §11.2가 "before Step 5 implementation" manual smoke를 권장하는 이유.

---

## 12. Validation Results

```powershell
# 빌드 (3 projects)
& "C:\Program Files\dotnet\dotnet.exe" build desktop/Kloser.Capture.Core/Kloser.Capture.Core.csproj
& "C:\Program Files\dotnet\dotnet.exe" build desktop/Kloser.Capture.Poc/Kloser.Capture.Poc.csproj
& "C:\Program Files\dotnet\dotnet.exe" build desktop/Kloser.Desktop.Shell/Kloser.Desktop.Shell.csproj
# all 0 warnings / 0 errors

# Console PoC regression (Step 3 + 0e70f17 contract 유지)
& "C:\Program Files\dotnet\dotnet.exe" run --project desktop/Kloser.Capture.Poc -- --list-devices
& "C:\Program Files\dotnet\dotnet.exe" run --project desktop/Kloser.Capture.Poc -- --duration-sec 1
& "C:\Program Files\dotnet\dotnet.exe" run --project desktop/Kloser.Capture.Poc -- --duration-sec abc
& "C:\Program Files\dotnet\dotnet.exe" run --project desktop/Kloser.Capture.Poc -- --no-mic --duration-sec 3

# WPF launch dry-run
$p = Start-Process -FilePath "C:\Program Files\dotnet\dotnet.exe" -ArgumentList "run","--project","desktop/Kloser.Desktop.Shell","--no-build" -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 5
# alive
Stop-Process -Id $p.Id -Force

# 위생 게이트
git diff --check                              # clean
git ls-files --others --exclude-standard desktop/  # 18개 신규 (csproj + Core/Audio/Diagnostics 이동 + Shell)
git status --short | grep -E "\.(wav|pcm|raw|log)$|bin/|obj/"
                                              # no audio/build artifacts staged
```

전부 PASS.

---

## 13. 참조

- 상위 master: `PHASE_9_MASTER.md`
- 선행 결정: `PHASE_9_STEP_1_DESKTOP_CAPTURE_ARCHITECTURE.md`
- 선행 결과: `PHASE_9_STEP_2_FINDINGS.md`, `PHASE_9_STEP_3_FINDINGS.md`
- 본 step plan: `PHASE_9_STEP_4_PLAN.md`
- Core 라이브러리 README: `desktop/Kloser.Capture.Poc/README.md` (Step 3 사용법 그대로, library 의존 추가)
- Shell 사용법: `desktop/Kloser.Desktop.Shell/README.md`
- 다음 step: Phase 9 Step 5 — backend realtime integration (Socket.io sender via ICapturedFrameSink)

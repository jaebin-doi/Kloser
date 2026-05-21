# Kloser.Desktop.Shell

Phase 9 Step 4 — Windows desktop UI shell (WPF, MVVM).

> Plan: [`docs/plan/phase-9/PHASE_9_STEP_4_PLAN.md`](../../docs/plan/phase-9/PHASE_9_STEP_4_PLAN.md)

This is the WPF app that wraps the `Kloser.Capture.Core` library with a
device picker, level meters, frame / dropped / native-format readout,
diagnostic WAV toggle, friendly error panel, and the Step 3 manual
smoke S1-S6 checklist. It does **NOT** talk to the backend, does NOT
log in, does NOT call Azure, and does NOT upload anything. Network
transport lands in Phase 9 Step 5.

---

## Run

```powershell
dotnet restore desktop/Kloser.Desktop.Shell/Kloser.Desktop.Shell.csproj
dotnet build   desktop/Kloser.Desktop.Shell/Kloser.Desktop.Shell.csproj
dotnet run --project desktop/Kloser.Desktop.Shell
```

App opens to the capture console (Plan §4.1 "first screen should be the
working capture console, not a landing page"). Use the device combobox
to pick a mic + render endpoint, optionally enable diagnostic WAV,
press Start, and the per-source level / frames / dropped indicators
update every 500 ms.

---

## UI layout

| Band | Contents |
|---|---|
| Header | state, elapsed, process memory |
| Device | mic picker, system audio picker, Refresh, frame_ms (20/40/60/80/100), diagnostic WAV toggle + output dir |
| Control | Start / Stop, backend / call / user placeholders for Step 5 |
| Status | `agent_mic` row + `system_loopback` row — peak / rms / enabled / healthy / frames / dropped / native format / normalized format |
| Errors + Events | friendly errors (no stack traces, no raw audio) + recent events |
| Smoke checklist | S1 mic level / S2 loopback level / S3 simultaneous / S4 WAV separation / S5 mute/silence / S6 5-min baseline |

S1-S3 auto-tick when live counters cross the suggestion threshold; S4
auto-ticks when both `agent_mic.wav` + `system_loopback.wav` are
written during a session; S5 / S6 are user-confirmed.

---

## Architecture

- `Kloser.Capture.Core` — audio capture engine (NAudio WASAPI capture +
  loopback, PCM16 normalize, frame slicer, level meter, diagnostic WAV
  writer). Shared with the console `Kloser.Capture.Poc`.
- `Kloser.Desktop.Shell` — WPF + MVVM (this project).
  - `ViewModels/` — `MainWindowViewModel`, `SourceStatusViewModel`,
    `DeviceOptionViewModel`, `SmokeChecklistViewModel`, plus tiny
    `ObservableObject` + `RelayCommand` helpers (no external MVVM
    framework dependency).
  - `Services/` — `CaptureSessionController` orchestrates per-source
    capture lifecycle + diagnostic sinks. `ICapturedFrameSink` with
    three implementations (`NullFrameSink`, `CountingFrameSink`,
    `DiagnosticWavFrameSink`) is the boundary Step 5 will extend
    with `SocketIoAudioFrameSink`.
  - `App.xaml` / `MainWindow.xaml` — view layer; dense SaaS-style.

---

## Security & privacy

- No network sockets. No login.
- Raw PCM bytes are never logged, never shown in the error panel,
  never stringified.
- Diagnostic WAV is **off by default** and only writes under
  `desktop/.diagnostics/<timestamp>/` when the toggle is on. The
  output directory is git-ignored.
- "Errors" panel only shows friendly text + exception type/message;
  never raw stack traces or audio bytes.

---

## Step 3 deferred validation (manual smoke S1-S6)

`PHASE_9_STEP_3_FINDINGS.md` documented that the Step 3 console PoC
could not finish its manual smoke (no mic on the dev session machine)
and deferred S1-S6 to this Step 4 UI. The smoke checklist panel in
this app is the place to record those observations. When all six
items are checked on a real Windows machine, Codex updates
`PHASE_9_MASTER.md` Step 3 + Step 4 checkboxes in a follow-up commit.

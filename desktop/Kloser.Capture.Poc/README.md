# Kloser.Capture.Poc

Phase 9 Step 3 — Windows audio capture proof-of-concept.

> Plan: [`docs/plan/phase-9/PHASE_9_STEP_3_PLAN.md`](../../docs/plan/phase-9/PHASE_9_STEP_3_PLAN.md)

This PoC validates that one Windows process can simultaneously capture
the microphone (`agent_mic`) and the system render device loopback
(`system_loopback`), normalize both sources to PCM16 16 kHz mono, and
produce frame-sized chunks matching the Phase 9 Step 2 backend ingest
contract (`AudioChunkMeta` + binary payload).

It is **NOT** the desktop app. It does NOT talk to the backend, does
NOT call Azure, does NOT log in, and does NOT upload anything. Network
transport lands in Phase 9 Step 5.

---

## Requirements

- Windows 10 / 11 (WASAPI loopback is Windows-only).
- .NET 8 SDK (`dotnet --info` must show 8.x).
- At least one active capture device (microphone) and one render
  device (speakers / headset).

---

## Build

From the repository root:

```powershell
dotnet restore desktop/Kloser.Capture.Poc/Kloser.Capture.Poc.csproj
dotnet build desktop/Kloser.Capture.Poc/Kloser.Capture.Poc.csproj
```

---

## Run

```powershell
# Print available devices and exit.
dotnet run --project desktop/Kloser.Capture.Poc -- --list-devices

# 30-second capture using Windows defaults, no audio files written.
dotnet run --project desktop/Kloser.Capture.Poc -- --duration-sec 30

# Same, but also write per-source WAV files for manual playback verification.
dotnet run --project desktop/Kloser.Capture.Poc -- --duration-sec 30 --write-diagnostic-wav

# Use specific devices (ids from --list-devices).
dotnet run --project desktop/Kloser.Capture.Poc -- `
    --mic "{0.0.1.00000000}.{abc...}" `
    --loopback "{0.0.0.00000000}.{def...}" `
    --duration-sec 30
```

Ctrl-C stops capture early. `--duration-sec` is a hard upper bound.

### CLI reference

| Option | Default | Description |
|---|---|---|
| `--list-devices` | — | List capture + render endpoints and exit. |
| `--mic <id>` | Windows default capture | Specific microphone endpoint id. |
| `--loopback <id>` | Windows default render | Specific render endpoint id (loopback binds here). |
| `--no-mic` | — | Skip microphone capture. |
| `--no-loopback` | — | Skip loopback capture. |
| `--frame-ms <n>` | 40 | One of 20 / 40 / 60 / 80 / 100. |
| `--duration-sec <n>` | 30 | 1..3600. Auto-stop. |
| `--write-diagnostic-wav` | off | Enable dev-only WAV per source. |
| `--diagnostic-dir <path>` | `desktop/.diagnostics/<timestamp>/` | Diagnostic output directory. |
| `--status-interval-ms <n>` | 500 | Status line refresh. 100..5000. |

Both `--no-mic` and `--no-loopback` together is invalid.

---

## Frame contract

Emitted frames match the backend Step 2 contract bit-for-bit:

```
codec          : pcm_s16le
sample_rate_hz : 16000
channels       : 1
frame_ms       : 20 | 40 | 60 | 80 | 100
```

Frame byte sizes (one frame, PCM16 16 kHz mono):

| frame_ms | bytes |
|---:|---:|
| 20  | 640  |
| 40  | 1280 |
| 60  | 1920 |
| 80  | 2560 |
| 100 | 3200 |

Per-source `seq` starts at 1 and is monotonically increasing.

---

## Security & privacy

- The PoC never opens a network socket.
- Raw PCM bytes are never logged, never stringified, never written
  except into `--write-diagnostic-wav` files when explicitly requested.
- Diagnostic output is git-ignored (`desktop/.gitignore`). Delete the
  `.diagnostics/<timestamp>/` directory manually after smoke runs.

---

## Manual smoke matrix

After build passes, perform these on a real Windows machine:

1. `--list-devices` lists the expected default capture and render endpoints.
2. 30 s capture with no flags: `agent_mic` level moves when you speak.
3. Play music or a sample softphone call: `system_loopback` level moves.
4. Mute mic mid-run: `agent_mic` level drops; `system_loopback` keeps moving.
5. Pause system audio: `system_loopback` drops; `agent_mic` keeps moving.
6. `--write-diagnostic-wav --duration-sec 30`: play back both `.wav`
   files; agent_mic should contain mic audio, system_loopback should
   contain the rendered audio.
7. Verify no `.wav` / `.pcm` / `.raw` / `bin/` / `obj/` is staged in git.

Findings document: `docs/plan/phase-9/PHASE_9_STEP_3_FINDINGS.md`.

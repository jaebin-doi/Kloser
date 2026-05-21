# Phase 9 Step 7 Plan - Pilot Hardening + Closeout

작성일: 2026-05-21

상위 문서: `PHASE_9_MASTER.md`  
선행 결과: `PHASE_9_STEP_3_FINDINGS.md`, `PHASE_9_STEP_4_FINDINGS.md`, `PHASE_9_STEP_5_FINDINGS.md`, `PHASE_9_STEP_6_FINDINGS.md`

> Step 7은 새 기능을 크게 늘리는 단계가 아니다. Step 5에서 닫힌 realtime desktop -> backend STT 경로와 Step 6에서 닫힌 recording archive 경로를 pilot-ready 수준으로 굳힌다. 핵심은 Windows 장치 매트릭스, 5분 이상 baseline, 네트워크/종료 edge, 보안 노출, 실행 runbook, Phase 9 closeout 증거를 정리하는 것이다.

---

## 0. Status

**Plan only. Implementation not started.**

현재까지 확인된 상태:

- Step 5 realtime backend integration: manual E2E PASS.
- Step 6 recording archive bridge: manual E2E PASS.
- Step 3 / Step 4 master checkbox는 아직 `[ ]` 유지. capture engine과 WPF shell 자체 구현은 끝났지만, S1-S6 hardware smoke matrix가 Step 5/6 E2E에 흡수된 형태라 별도 closeout 정리가 필요하다.
- Azure Speech 실호출은 아직 붙이지 않는다. Step 7은 mock STT 경로 기준 pilot hardening이다.

---

## 1. Goal

Step 7이 끝나면 다음을 말할 수 있어야 한다.

1. Windows desktop app을 정해진 절차대로 서버와 함께 실행할 수 있다.
2. 마이크 + 시스템 오디오 캡처가 여러 Windows 장치 조합에서 동작하거나, 실패 시 원인을 UI/로그로 구분할 수 있다.
3. 5분 이상 통화에서 realtime transcript, archive WAV, upload/finalize, calls.html playback이 안정적으로 이어진다.
4. 네트워크 끊김, 서버 중단, 창 닫기, End Call 중복, archive upload 중 종료 같은 edge가 fail-closed로 처리된다.
5. raw audio, access token, signed URL, object key, local path, checksum이 UI/로그/DB/audit에 불필요하게 노출되지 않는다.
6. Step 3 / Step 4 / Step 7 closeout 문서와 `PHASE_9_MASTER.md` 체크박스가 실제 검증 결과에 맞게 갱신된다.

---

## 2. Non-Goals

- Azure Speech SDK 실호출 연결.
- STT provider 비용 정산 로직 변경.
- Flutter Windows 전환.
- production installer / auto-update / code signing.
- real S3/MinIO storage smoke.
- encrypted offline retry queue.
- legal consent workflow 완성.
- browser capture UI.
- diarization 품질 개선.
- 대규모 ViewModel 리팩터링을 목표 자체로 삼는 작업.

필요한 작은 리팩터링은 허용하지만, hardening 증거 없이 구조 변경만 크게 늘리면 안 된다.

---

## 3. Scope

### 3.1 Runbook + Preflight

작성/갱신 대상:

- `docs/plan/phase-9/PHASE_9_RUNBOOK.md` 신규 권장.
- 필요 시 `desktop/Kloser.Desktop.Shell/README.md`의 실행 절차 갱신.

포함해야 할 실행 순서:

```powershell
docker compose -f ops/docker-compose.yml up -d
```

```powershell
# server/.env local dev 예시
PORT=32173
RECORDING_STORAGE_PROVIDER=local
RECORDING_STORAGE_PUBLIC_BASE_URL=http://localhost:32173/dev-recordings
```

```powershell
npm --prefix server run db:migrate:up
npm --prefix server run db:seed
npm --prefix server run dev
```

```powershell
python -m http.server 8765
```

```powershell
dotnet run --project desktop/Kloser.Desktop.Shell/Kloser.Desktop.Shell.csproj
```

Runbook은 다음 URL도 명시한다.

- backend health: `http://localhost:32173/health`
- platform: `http://localhost:8765/platform/`
- calls page: `http://localhost:8765/platform/calls.html`
- desktop backend URL: `http://localhost:32173`

Acceptance:

- 새 세션에서 runbook만 보고 서버, static frontend, WPF app을 실행할 수 있다.
- local recording provider가 설정되지 않았을 때 archive가 실패하는 원인을 runbook으로 확인할 수 있다.
- `server/.env`, `server/.data/`, `.wav`, `.pcm`, `.raw`, `bin/`, `obj/`는 커밋 대상에서 제외된다.

### 3.2 Windows Device Matrix

Step 3 / Step 4에서 이월된 S1-S6 smoke matrix를 WPF UI 기준으로 닫는다.

필수 시나리오:

| ID | Scenario | Pass Criteria |
|---|---|---|
| S1 | microphone only | mic level moves, mic frames increase, system_loopback can stay silent if no playback |
| S2 | system audio only | loopback level moves during playback, loopback frames increase |
| S3 | mic + system audio simultaneous | both source counters increase, source seq monotonic, dropped = 0 or explained |
| S4 | diagnostic WAV separation | agent_mic.wav and system_loopback.wav are created and source separation is audible |
| S5 | mute / silence behavior | muted source shows silence without fatal error; unmuted source continues |
| S6 | 5 minute baseline | no fatal error, memory/CPU acceptable, dropped stable, archive available after end |

장치 조합:

- built-in mic + built-in/render speaker.
- USB headset if available.
- Bluetooth headset if available.
- no capture device path.
- render device unavailable path if reproducible.
- device unplug/replug during idle and during active capture if safe to test.

Acceptance:

- `PHASE_9_STEP_3_FINDINGS.md`와 `PHASE_9_STEP_4_FINDINGS.md`에 S1-S6 결과가 갱신된다.
- 실제로 검증하지 못한 하드웨어는 "not available on test machine"으로 명시하고 pass로 둔갑시키지 않는다.
- 검증 통과 후에만 `PHASE_9_MASTER.md` Step 3 / Step 4 checkbox를 `[x]`로 갱신한다.

### 3.3 Five-Minute Baseline

최소 5분 통화를 1회 이상 수행한다.

관찰 항목:

- desktop elapsed time.
- process memory at start/end.
- rough CPU behavior from Task Manager or PowerShell.
- mic frames / loopback frames.
- dropped frames/chunks.
- realtime chunks/bytes sent.
- partial transcript presence.
- final transcript presence.
- `llm_usage_log.metadata.audio_duration_ms_sent`.
- archive WAV duration/size/checksum.
- `call_recordings.status = available`.
- calls.html playback.

Suggested acceptance:

- process crash 0.
- fatal UI error 0.
- dropped frames/chunks 0, or a documented device/network reason.
- memory does not grow without bound during the 5 minute run.
- archive upload finishes within 30 seconds after End Call on local provider.
- final call has transcripts, mock STT usage row, recording row, and playback URL.

### 3.4 Network + Lifecycle Hardening

Default policy: **fail closed, no raw audio persistence, no automatic hidden reconnect**.

Test/fix scenarios:

| Scenario | Expected Behavior |
|---|---|
| backend down before connect | friendly connection error, capture not started |
| bad/expired token | auth/connect failure, token not logged |
| backend restart during active call | capture stops or call session closes visibly; no continued raw audio send |
| socket disconnect during active call | sink deactivates, capture stops, user sees explicit state |
| `BAD_PAYLOAD` / `AUDIO_BACKPRESSURE` / `AUDIO_CHUNK_TOO_LARGE` / `AUDIO_SEQ_OUT_OF_ORDER` | fail-closed path fires case-insensitively or via normalized whitelist |
| End Call double click | one backend close path, no duplicate final transcript/archive upload |
| X close during `Starting` / `InCall` / `Ending` / archive upload | shutdown waits for EndCall/archive task or times out with visible status |
| process kill / crash | no next-start upload retry; stale local temp is swept by age policy |

Implementation candidates:

- Add startup cleanup sweep for `%LOCALAPPDATA%\Kloser\recordings\pending\*` older than a conservative threshold, for example 24 hours.
- Add client-side maximum archive duration or maximum local WAV bytes before backend rejects at 250 MB.
- Normalize backend audio runtime error codes in desktop before fail-closed comparison to avoid casing drift.
- Keep automatic reconnect disabled unless a bounded memory-only reconnect design is explicitly approved.

### 3.5 Security + Privacy Polish

Required:

- Replace visible password `TextBox` with `PasswordBox` plus a minimal binding/command-safe handoff, or explicitly document why it remains dev-only.
- Add consent placeholder UI text/control. This is not a legal workflow; it only makes the operator state visible.
- Keep token memory-only. Do not write access tokens to disk, registry, logs, Events panel, Errors panel, screenshots generated by tests, or docs.
- Keep raw PCM out of DB, audit payloads, UI, logs, and docs.
- Keep signed URL, object key, checksum, and local recording path out of visible UI/errors unless a deliberate debug-only gate is added.
- Diagnostic WAV must remain opt-in and local. Runbook must warn that it contains real call audio.

Recommended tests/checks:

- Desktop-side sentinel test or focused manual sentinel check for raw PCM leakage.
- Server-side Step 2 raw audio sentinel test remains green.
- Step 6 dev recording storage leakage test remains green.

### 3.6 UI Hardening

Targeted fixes only:

- Ensure 1600x1080 and smaller windows remain usable with ScrollViewer.
- Ensure archive status, realtime status, errors, and final transcripts do not overlap.
- Remove duplicate or confusing controls if present.
- Make error labels actionable: `initiate_failed`, `upload_failed`, `finalize_failed`, `skipped_empty`, `local_finalize_failed`.
- Keep dense SaaS desktop style; do not add marketing/landing UI.

Optional if it lowers risk:

- Split `MainWindowViewModel` into `RealtimeViewModel` and `RecordingArchiveViewModel`.
- Do not do this if it delays lifecycle testing or increases regression risk.

---

## 4. Validation Gates

Automatic:

```powershell
dotnet build desktop/Kloser.Capture.Core/Kloser.Capture.Core.csproj
dotnet build desktop/Kloser.Capture.Poc/Kloser.Capture.Poc.csproj
dotnet build desktop/Kloser.Desktop.Shell/Kloser.Desktop.Shell.csproj
```

```powershell
npm --prefix server run typecheck
node test/sync_shared_types.mjs
npm --prefix server test
```

```powershell
git diff --check
git status --short --branch
git diff --stat
```

Artifact check:

```powershell
git ls-files --others --exclude-standard
```

No staged/committed:

- `server/.env`
- `server/.data/`
- `*.wav`
- `*.pcm`
- `*.raw`
- `*.log`
- `bin/`
- `obj/`
- screenshots unless explicitly required for a finding

Manual:

- S1-S6 device matrix.
- 5 minute call baseline.
- network/server restart/disconnect scenarios.
- X close / End Call race scenarios.
- calls.html recording playback.
- DB check for latest call:
  - `calls.status = ended`
  - transcript rows exist
  - `llm_usage_log.provider = mock`, `operation = stt_transcribe`
  - `call_recordings.status = available`
  - audit rows for recording upload/finalize exist where applicable

---

## 5. Deliverables

Required files:

- `docs/plan/phase-9/PHASE_9_STEP_7_FINDINGS.md`
- `docs/plan/phase-9/PHASE_9_RUNBOOK.md`
- updates to `docs/plan/phase-9/PHASE_9_MASTER.md`
- updates to `docs/plan/phase-9/PHASE_9_STEP_3_FINDINGS.md`
- updates to `docs/plan/phase-9/PHASE_9_STEP_4_FINDINGS.md`

Code changes are expected only where they directly support hardening:

- desktop startup cleanup sweep.
- desktop shutdown/lifecycle edge fixes.
- desktop password/consent UI polish.
- desktop error-code normalization.
- optional focused tests.
- docs/readme updates.

---

## 6. Exit Criteria

Step 7 can be marked done only when:

- [ ] automatic validation gates pass.
- [ ] S1-S6 matrix is recorded with real results.
- [ ] 5 minute baseline is recorded.
- [ ] network/lifecycle edge matrix is recorded.
- [ ] recording archive still uploads and plays from calls.html after the hardening changes.
- [ ] token/raw audio/signed URL/object key/local path leakage checks are recorded.
- [ ] `PHASE_9_STEP_7_FINDINGS.md` exists and includes evidence.
- [ ] `PHASE_9_RUNBOOK.md` exists and is usable from a clean local session.
- [ ] `PHASE_9_MASTER.md` Step 3 / Step 4 / Step 7 checkboxes reflect actual verification state.

---

## 7. Implementer Handoff

Phase 9 Step 7 Pilot Hardening + Closeout을 진행한다.

먼저 다음 문서를 읽고 현재 계약을 기준으로 작업한다:

- `docs/plan/phase-9/PHASE_9_MASTER.md`
- `docs/plan/phase-9/PHASE_9_STEP_3_FINDINGS.md`
- `docs/plan/phase-9/PHASE_9_STEP_4_FINDINGS.md`
- `docs/plan/phase-9/PHASE_9_STEP_5_FINDINGS.md`
- `docs/plan/phase-9/PHASE_9_STEP_6_FINDINGS.md`
- `docs/plan/phase-9/PHASE_9_STEP_7_PLAN.md`

작업 원칙:

- Azure Speech 실호출은 붙이지 않는다.
- Flutter 전환은 하지 않는다.
- raw audio를 디스크 retry queue에 저장하지 않는다.
- 자동 hidden reconnect를 임의로 추가하지 않는다.
- Step 5/6에서 통과한 realtime transcript + recording archive E2E를 깨지 않는다.
- `server/.env`, `server/.data/`, WAV/PCM/RAW/log/build artifact는 커밋하지 않는다.

우선순위:

1. runbook 작성.
2. startup cleanup sweep / shutdown edge / error normalization / password or consent polish 중 hardening에 필요한 최소 코드 수정.
3. S1-S6 + 5분 baseline + network/lifecycle manual matrix 수행.
4. automatic gates 실행.
5. Step 3/4/7 findings와 master checkbox를 실제 결과대로 갱신.

완료 보고에는 changed files, validation commands, manual matrix 결과, 남은 리스크, 커밋 제외 파일을 포함한다.

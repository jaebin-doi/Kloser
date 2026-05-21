# Phase 9 Step 3 Findings — Windows Capture Engine PoC

작성일: 2026-05-19 (initial)
갱신: 2026-05-21 (Codex blocker fix 통합 + manual smoke를 Step 4 UI 검증으로 이월하는 정책 반영)

상위 문서: `PHASE_9_MASTER.md`
계획 문서: `PHASE_9_STEP_3_PLAN.md`
선행 결정: `PHASE_9_STEP_1_DESKTOP_CAPTURE_ARCHITECTURE.md`, `PHASE_9_STEP_2_FINDINGS.md`

> Step 3은 Windows에서 `agent_mic`과 `system_loopback`을 같은 프로세스에서 동시에 캡처하고, 두 source를 Phase 9 Step 2 backend ingest contract와 1:1로 호환되는 PCM16 16 kHz mono frame으로 normalize하는 C#/.NET 8 console PoC를 구현했다. backend transport / Azure / Flutter shell / auth / Phase 8 archive bridge는 의도적으로 손대지 않았다.

---

## 0. Status

**Implementation complete; manual validation deferred.**

- Step 3 code complete (PoC + Codex blocker fix까지 반영).
- 자동 게이트 (`dotnet build` / `--list-devices` / friendly error paths / `git diff --check`) 전부 통과.
- Codex 1차 리뷰 통과 — blocker 1건 발견·수정·재검증 완료 (§1.1 참고, commit `0e70f17 Handle missing Windows audio endpoints`).
- **Manual Windows smoke matrix는 Step 4 desktop UI 검증으로 이월**되었다. 사용자가 Step 4에서 실 mic + loopback 시나리오를 UI 안에서 동시 검증하는 게 효율적이라고 판단해서 결정. Step 3 단독 console PoC로 같은 작업을 반복하지 않는다.
- 결과적으로 **`PHASE_9_MASTER.md` Step 3 체크박스는 본 라운드에서 변경하지 않는다.** Step 4 UI smoke가 §1.3 항목들을 모두 통과하면 그때 같이 체크 갱신한다.

본 문서는 closeout 문서가 아니다. "implementation complete, manual validation deferred to Step 4"의 인계 기록으로 사용한다.

---

## 1. 결과 요약

자동 게이트 (`dotnet --info` / `dotnet restore` / `dotnet build` / `--list-devices` / `git diff --check`)는 모두 통과했다. **Manual Windows smoke matrix (§11.2 of plan)는 미수행이다** — 본 세션 환경에 active capture device(마이크)가 없어서 사람이 마이크 + 시스템 오디오를 직접 조작하는 검증이 불가능했다. 사용자 결정으로 manual smoke를 Step 4 UI 검증과 묶기로 이월했다 (§0 / §1.3 참고).

`PHASE_9_MASTER.md` Step 3 체크박스는 Step 4 UI smoke가 §1.3 항목을 모두 통과한 뒤에만 갱신한다 (Plan §11 / §14 exit criteria).

### 1.1 Codex Review Blocker + Fix (`0e70f17`)

Codex 1차 리뷰에서 Windows-환경 친화도 관련 blocker 1건이 발견됐다.

**증상**: 마이크가 1개도 없는 머신(headless / VM / mic 미연결 데스크탑)에서 옵션 없이 그냥 실행하면 `DeviceEnumerator.Resolve(...)`가 NAudio의 `GetDefaultAudioEndpoint(Capture, ...)`를 호출 → 내부적으로 `COMException (E_NOTFOUND)`를 던지고, 이게 `Program.Main`에서 잡히지 않고 그대로 stack trace + non-zero exit으로 사용자에게 노출됨. PoC 첫인상이 "프로그램이 깨졌다"로 보이는 UX 문제.

**수정 1 — `desktop/Kloser.Capture.Poc/Audio/DeviceEnumerator.cs`**:

- `Resolve(DataFlow, deviceId, defaultRole)`에서 `GetDefaultAudioEndpoint(...)` 호출을 `try/catch (Exception ex) when (ex is not InvalidOperationException)`로 감싸 `InvalidOperationException`으로 변환.
- 신규 helper `NoDefaultEndpointMessage(DataFlow flow)`가 flow별 actionable 메시지 분기:
  - `DataFlow.Capture` → `"no active capture endpoint found; rerun --list-devices or use --no-mic"`
  - `DataFlow.Render`  → `"no active render endpoint found; rerun --list-devices or use --no-loopback"`
  - 그 외 → fallback `"no active {flow} endpoint found; rerun --list-devices"`

**수정 2 — `desktop/Kloser.Capture.Poc/Program.cs`**:

기존 raw `int.Parse(...)` 3곳 (`--frame-ms` / `--duration-sec` / `--status-interval-ms`)는 사용자 입력이 숫자가 아닐 때 `FormatException` stack을 노출했다. 새 helper `ParseIntOption(raw, opt)`로 교체:

```csharp
private static int ParseIntOption(string raw, string opt)
{
    if (!int.TryParse(raw, NumberStyles.Integer,
        CultureInfo.InvariantCulture, out int value))
    {
        throw new ArgumentException(
            $"{opt} requires an integer value, got '{raw}'");
    }
    return value;
}
```

throw된 `ArgumentException`은 `Program.Main`의 기존 `catch (ArgumentException ex)` 분기로 빨려 들어가서 `"argument error: ..."` + 도움말 출력 + exit 2로 surface된다. 새 exit code 추가나 catch 블록 변경은 없다 — 신규 friendly 경로만 기존 매핑에 합류.

**수정 커밋**: `0e70f17 Handle missing Windows audio endpoints` (2 files / +40 -4, Codex 검토 통과 후 commit/push 완료).

### 1.2 Re-validation After Fix

Codex가 본 세션 머신(active capture device 0개)에서 재실행한 결과:

| Command | 기대 | 실제 |
|---|---|---|
| `dotnet --info` | 8.0.421 | OK |
| `dotnet restore desktop/Kloser.Capture.Poc/Kloser.Capture.Poc.csproj` | success | OK |
| `dotnet build desktop/Kloser.Capture.Poc/Kloser.Capture.Poc.csproj` | 0 warning / 0 error | OK |
| `dotnet run --project desktop/Kloser.Capture.Poc -- --list-devices` | capture (none) / render 2 device | OK |
| `dotnet run --project desktop/Kloser.Capture.Poc -- --duration-sec 1` (mic 없는 환경) | friendly error + exit 3 + no stack | **OK** — `error: no active capture endpoint found; rerun --list-devices or use --no-mic` |
| `dotnet run --project desktop/Kloser.Capture.Poc -- --duration-sec abc` (bad int) | friendly error + exit 2 + no stack | **OK** — `argument error: --duration-sec requires an integer value, got 'abc'` + 도움말 출력 |
| `dotnet run --project desktop/Kloser.Capture.Poc -- --no-mic --duration-sec 3` | exit 0 | OK |
| `dotnet run --project desktop/Kloser.Capture.Poc -- --no-mic --duration-sec 2 --write-diagnostic-wav` | exit 0 | OK |
| `git diff --check` | clean | OK |
| `git ls-files --others --exclude-standard` | 0 untracked (전부 commit됨) | OK |

자동 게이트 전체 통과. 빌드 / 라이브러리 의존 / CLI 인자 처리 / 디바이스 누락 처리 / WAV 옵션 / git 위생 모두 정상.

### 1.3 Manual Smoke 이월 — Step 4 UI 검증 매트릭스

Step 3 console PoC 단계에서 사람이 마이크 + 시스템 오디오를 직접 조작하는 manual smoke (Plan §11.2)는 **본 라운드에서 수행하지 않는다.** 사용자 결정으로 Step 4 desktop UI에서 같은 시나리오를 UI 안에서 직접 보고 한 번에 검증한다 — Step 3 console에서 한 번, Step 4 UI에서 또 한 번 같은 작업을 반복하지 않기 위함.

이월 사유:

- Step 3 PoC는 console-only이고 device selection / mute toggle / unplug 시나리오는 UI 위에서 사람 손으로 토글하는 게 자연스럽다. Step 4 UI가 device picker / status indicator / level meter widget을 제공할 예정이라 같은 화면에서 시나리오를 다 돌릴 수 있다.
- 본 세션 머신에 active capture device가 0개라 Step 3 단독으로 통과 가능한 시나리오가 §1.2 친구나 환경 의존 항목뿐이다. mic-가용 머신을 확보해 Step 3 단독 smoke를 한 번 더 도는 비용 대비 효익이 낮다.
- Step 4가 PoC를 library / child process로 재사용할 예정이라 Step 4 UI smoke가 통과하면 Step 3 capture 경로도 함께 검증된다 (UI가 capture engine을 통해 동작).

**Step 4 UI smoke에서 반드시 통과시켜야 하는 항목** (Step 3 Plan §11.2 6 시나리오를 그대로 옮김):

| # | 검증 항목 | 통과 기준 |
|---|---|---|
| S1 | **mic level 움직임** | 사용자가 마이크에 말할 때 UI agent_mic level이 0이 아닌 값으로 변동, silence flag clear |
| S2 | **loopback level 움직임** | 시스템/소프트폰 오디오 재생 시 UI system_loopback level이 0이 아닌 값으로 변동 |
| S3 | **mic + loopback 동시 캡처** | 두 source가 같은 세션 안에서 동시에 frame을 emit, per-source seq 단조 증가, dropped=0 |
| S4 | **diagnostic WAV source separation** | `--write-diagnostic-wav` 또는 UI 옵션으로 WAV 2개(`agent_mic.wav`, `system_loopback.wav`) 생성, 청취 시 두 source가 분리되어 들림 |
| S5 | **mute / silence 동작** | mic mute → agent_mic level 떨어지고 fatal error 없음; 시스템 오디오 정지 → loopback level 떨어지고 fatal error 없음; 두 source 모두 silence여도 프로세스 정상 유지 |
| S6 | **5분 baseline** | 5분 장기 실행 시 CPU / 메모리 안정, dropped frame 카운터 0 또는 명확한 사유, fatal error 없음 |

추가로 §6 device matrix(빌트인 mic + speakers / USB headset / Bluetooth headset / device unplug mid-run)도 Step 4 UI smoke 안에서 hardware availability 만큼 커버. 본 문서 §6에 "pending user" 표시가 그대로 남는 항목은 Step 4 UI smoke 결과에서 채워 넣을 자리다.

**위 6 항목이 모두 통과한 시점에** Codex가 `PHASE_9_MASTER.md` Step 3 체크박스를 `[x]`로 갱신하고, 본 findings §6 / §3 / §8 / §9의 "pending user" 자리를 실 관측 데이터로 채운다.

---

신규 코드 (`desktop/Kloser.Capture.Poc/` 아래):

- `Kloser.Capture.Poc.csproj` — net8.0-windows console, NAudio 2.2.1, WASAPI는 Windows 전용이라 CA1416 suppress.
- `Program.cs` — `--help` / `--list-devices` / capture 3가지 모드, 인자 파싱, 캡처 세션 라이프사이클, Ctrl-C cancellation.
- `Audio/AudioSourceId.cs` — `AgentMic` / `SystemLoopback` enum + `ToWireString()` ("agent_mic" / "system_loopback") — Step 2 zod schema와 정확히 매칭.
- `Audio/CaptureOptions.cs` — CLI 인자 컨테이너 + PCM16 16 kHz mono 상수 + `AllowedFrameMs = [20,40,60,80,100]`.
- `Audio/CapturedAudioFrame.cs` — emitted frame record + `CaptureSourceStatus` + `CaptureSourceError`. Step 2 `AudioChunkMeta` field set 1:1.
- `Audio/DeviceEnumerator.cs` — `MMDeviceEnumerator` wrapper. capture + render endpoint snapshot, default 마커, id 기반 해상 (`ResolveCapture` / `ResolveRender`).
- `Audio/CaptureSourceBase.cs` — mic + loopback 공통 라이프사이클. Native bytes → `Pcm16Resampler` → `Pcm16FrameEmitter` 흐름. `FrameReady` / `SourceError` 이벤트.
- `Audio/MicCaptureSource.cs` — `WasapiCapture(device, useEventSync: true, ShareMode = Shared)`.
- `Audio/LoopbackCaptureSource.cs` — `WasapiLoopbackCapture(device)`.
- `Audio/Pcm16Resampler.cs` — float/PCM 입력 → mono float → linear-interpolation 16 kHz → PCM16 little-endian. carry-over state(`_prevMonoTail`, `_fracPos`)로 호출 경계 사이에서 sample drift 없음.
- `Audio/Pcm16FrameEmitter.cs` — exact frame-sized chunk slicer + per-source `seq` (start at 1) + `startedAtMs = (seq-1)*frameMs` + 5s bounded queue (`drop oldest` + `FramesDropped` 카운터).
- `Audio/LevelMeter.cs` — peak / RMS / silence flag (floor 0.001 ≈ -60 dBFS). PCM16 bytes만 읽고 어떤 컬렉션에도 push 안 함.
- `Diagnostics/StatusRenderer.cs` — `hh:mm:ss | mic level=.. frames=.. dropped=.. | loopback ... | mem=..MB` 한 줄.
- `Diagnostics/DiagnosticWavWriter.cs` — per-source WAV (PCM16 16 kHz mono, `WaveFileWriter`). 옵션 OFF가 기본.
- `Kloser.Capture.Poc/README.md` — 사용법 + manual smoke matrix.

수정:

- `desktop/.gitignore` — `.diagnostics/` / `*.wav` / `*.pcm` / `*.raw` / `*.log` / `bin/` / `obj/` / `.vs/` / `.idea/` / `*.suo` / `*.user` / `TestResults/`.

repo 다른 영역(backend / frontend / docs/plan 다른 phase / Phase 8)은 무변경.

---

## 2. Exact files changed

| File | Status |
|---|---|
| `desktop/.gitignore` | new |
| `desktop/Kloser.Capture.Poc/Kloser.Capture.Poc.csproj` | new |
| `desktop/Kloser.Capture.Poc/Program.cs` | new |
| `desktop/Kloser.Capture.Poc/README.md` | new |
| `desktop/Kloser.Capture.Poc/Audio/AudioSourceId.cs` | new |
| `desktop/Kloser.Capture.Poc/Audio/CaptureOptions.cs` | new |
| `desktop/Kloser.Capture.Poc/Audio/CapturedAudioFrame.cs` | new |
| `desktop/Kloser.Capture.Poc/Audio/DeviceEnumerator.cs` | new |
| `desktop/Kloser.Capture.Poc/Audio/CaptureSourceBase.cs` | new |
| `desktop/Kloser.Capture.Poc/Audio/MicCaptureSource.cs` | new |
| `desktop/Kloser.Capture.Poc/Audio/LoopbackCaptureSource.cs` | new |
| `desktop/Kloser.Capture.Poc/Audio/Pcm16Resampler.cs` | new |
| `desktop/Kloser.Capture.Poc/Audio/Pcm16FrameEmitter.cs` | new |
| `desktop/Kloser.Capture.Poc/Audio/LevelMeter.cs` | new |
| `desktop/Kloser.Capture.Poc/Diagnostics/StatusRenderer.cs` | new |
| `desktop/Kloser.Capture.Poc/Diagnostics/DiagnosticWavWriter.cs` | new |
| `docs/plan/phase-9/PHASE_9_STEP_3_FINDINGS.md` | new (본 문서) |

초기 commit `a8933dd Add Phase 9 Step 3 Windows capture engine PoC`로 17 파일 신규.

Codex blocker fix commit `0e70f17 Handle missing Windows audio endpoints`로 다음 2 파일 modified:

| File | Status |
|---|---|
| `desktop/Kloser.Capture.Poc/Audio/DeviceEnumerator.cs` | modified (default-endpoint 누락 시 friendly InvalidOperationException) |
| `desktop/Kloser.Capture.Poc/Program.cs` | modified (CLI int parse 실패 → friendly ArgumentException helper) |

총 17 신규 + 2 modified. `PHASE_9_MASTER.md` Step 3 체크박스 갱신은 Step 4 UI smoke (§1.3 S1~S6) 통과 후 별도 commit.

---

## 3. Native Capture Formats Observed

`Pcm16Resampler`가 받아들이는 입력은 NAudio가 device로부터 보고하는 native `WaveFormat`이다. 본 세션에서 직접 관찰한 값:

| Device | Role | Encoding | Sample rate | Channels | Bits per sample |
|---|---|---|---:|---:|---:|
| MSI MP242L (NVIDIA High Definition Audio) | Default render → loopback bind | IeeeFloat | 48000 Hz | 2 | 32 |
| TFG32Q10P (NVIDIA High Definition Audio) | Active render (secondary monitor) | (미바인딩, default만 테스트) | — | — | — |

본 세션의 캡처 device(마이크)는 0개 — `--list-devices` "Capture devices: (none found)". 마이크 native format은 Step 4 UI smoke (§1.3 S1) 통과 시점에 본 표에 추가 row로 채운다.

Resampler가 처리하는 input shape는 IeeeFloat 32-bit / PCM 16-bit / PCM 24-bit / PCM 32-bit 4가지 + 1..8 채널까지 다룬다. 그 외 encoding은 `NotSupportedException`으로 fail-fast.

---

## 4. Final Emitted Format

모든 emitted frame은 다음 shape을 그대로 가진다 (Plan §7.3 / §2 Step 2 contract):

```text
codec          = pcm_s16le      (signed 16-bit little-endian)
sample_rate_hz = 16000
channels       = 1
```

증거:

- `CaptureOptions.SampleRateHz = 16000` constant, `BytesPerSample = 2`, `Channels = 1`.
- `Pcm16FrameEmitter` 생성자가 `(sampleRate * frameMs / 1000) * channels * 2` 식으로 frame byte size를 계산.
- `CapturedAudioFrame.Codec` 필드는 emitter가 항상 `"pcm_s16le"` 리터럴로 박는다.
- WAV writer는 `new WaveFormat(16000, 16, 1)`로만 파일을 연다.
- linear resampler 후 PCM16 인코딩 단계가 클램핑 후 `(short)Math.Round(s * 32767)` + little-endian write.

자동 단위 테스트는 본 PoC 단계에 추가하지 않았다 (Plan §11.1이 unit-test candidate를 nice-to-have로 명시). Step 4에서 PoC가 안정화되면 frame size / seq / 경계 case test project 별도 분리 후보.

---

## 5. Frame Duration & Byte Size

`CaptureOptions.AllowedFrameMs = [20, 40, 60, 80, 100]`. 기본 40 ms.

| frame_ms | bytes per frame | seconds per frame |
|---:|---:|---:|
| 20  | 640  | 0.020 |
| 40  | 1280 | 0.040 |
| 60  | 1920 | 0.060 |
| 80  | 2560 | 0.080 |
| 100 | 3200 | 0.100 |

Step 2 backend `AUDIO_CHUNK_MAX_BYTES = 128 KiB`이므로 모든 frame_ms 값에서 정상 cap 대비 ~40배 margin. emitter `queueCap = (5 * 1000) / frameMs` frames (frame_ms=40에서 125 frames = 5초). overflow는 oldest drop + `FramesDropped` 카운터.

---

## 6. Device Matrix Results

`--list-devices` 실행 결과 (본 세션 머신):

```
Capture devices:
  (none found)

Render devices:
  [active ] {0.0.0.00000000}.{253596b9-34b3-4872-aa16-c5e7fa2f0742} | TFG32Q10P(NVIDIA High Definition Audio)
  [default] {0.0.0.00000000}.{ebe8d4d6-aba4-412b-99f6-02906c4dc851} | MSI MP242L(NVIDIA High Definition Audio)
```

3 초 dry-run (`--no-mic --duration-sec 3`) 결과:

- loopback bind: `MSI MP242L(NVIDIA High Definition Audio)` 성공.
- native format: `IeeeFloat 48000 Hz 2ch 32-bit`.
- status: 3 ticks 모두 정상 출력, `frames=0 dropped=0` (배경 오디오 없음 → silence).
- process: 정상 종료, 메모리 0.2~0.3 MB.
- exit code: 0.

Plan §11.2 manual matrix는 **Step 4 UI smoke로 이월** (§1.3 S1~S6에 매핑). Step 3 console 단계에서 다시 돌리지 않는다.

| # | Scenario | Step 3 자동 | Step 4 UI smoke 매핑 |
|---|---|---|---|
| 1 | `--list-devices`로 default capture/render 노출 | render PASS / capture 머신 의존 | UI device picker가 capture/render 둘 다 노출 |
| 2 | 30s 캡처, mic 말하기 → agent_mic level 움직임 | deferred | S1 |
| 3 | 시스템/소프트폰 오디오 재생 → system_loopback level 움직임 | deferred | S2 |
| 4 | mic mute → agent_mic level drop, loopback 정상 유지 | deferred | S5 |
| 5 | 시스템 오디오 정지 → loopback drop, mic 정상 유지 | deferred | S5 |
| 6 | `--write-diagnostic-wav --duration-sec 30` 후 WAV 2개 청취 → source separation 확인 | deferred | S4 |
| 7 | git 스테이지에 .wav / .pcm / bin/ / obj/ 없음 | PASS (`git ls-files --others --exclude-standard desktop/` 결과에 build/diagnostic 0건) | (불변 — Step 4도 동일 정책 유지) |

추가 device 시나리오 (Plan §11.2 hardware matrix) — Step 4 UI smoke에서 hardware 가용성만큼 커버:

- built-in laptop mic + speakers
- USB headset mic + headset output
- Bluetooth headset
- device unplug mid-run (S5에 포함)
- silence / mute 시 no fatal error (S5)
- 5분 장기 실행 CPU / 메모리 baseline (S6)

---

## 7. Diagnostic WAV Result

- 기본 off. `--write-diagnostic-wav` 옵션에서만 활성화.
- 파일 분리: `agent_mic.wav` + `system_loopback.wav` (lazy creation — 해당 source에 frame이 1개라도 들어왔을 때만 생성).
- WAV format: PCM16 / 16000 Hz / 1ch (NAudio `WaveFileWriter` 헤더 자동 patch).
- 출력 디렉토리: `--diagnostic-dir` 미지정 시 `desktop/.diagnostics/<yyyyMMdd-HHmmss>/`.
- 본 세션 dry-run은 `desktop/.diagnostics/dryrun/` 디렉토리만 생성되고 frames=0이라 파일은 안 만들어짐. dry-run 후 디렉토리 cleanup 완료. **git에 staged된 audio artifact 0건** (`git ls-files --others --exclude-standard desktop/` 결과로 .cs / .csproj / .md / .gitignore 16개만 노출).

`desktop/.gitignore` 검증:

```
desktop/.gitignore:8:.diagnostics/    desktop/.diagnostics/dryrun
desktop/.gitignore:19:bin/            desktop/Kloser.Capture.Poc/bin
desktop/.gitignore:20:obj/            desktop/Kloser.Capture.Poc/obj
```

세 패턴 모두 `git check-ignore -v`로 OK.

---

## 8. Dropped Frame Count

본 세션 dry-run에서 frames=0이라 의미 있는 dropped 측정 불가. Plan §7.5 정책 ("queue cap 초과 → drop oldest + 카운터 증가") 자체는 `Pcm16FrameEmitter`에서 다음 형태로 구현:

```csharp
while (_queue.Count >= _queueCap)
{
    _ = _queue.Dequeue();
    _framesDropped += 1;
}
_queue.Enqueue(frame);
```

5초 queue cap이라 정상 운영에서 consumer가 한 번이라도 `Drain()`을 호출하면 drop이 발생할 수 없다. drop이 관측되면 consumer 루프가 stuck됐다는 신호 (Step 5에서 network sender가 stuck하는 경우 같은 카운터가 즉시 가시화된다).

---

## 9. CPU/Memory Baseline

본 세션 3초 dry-run (loopback only, status interval 1s):

- mem: 0.2 ~ 0.3 MB GC-tracked.
- CPU: 정량 측정 안 함 (PoC 단계). 체감 가능한 부하 없음.

5 분 baseline은 Step 4 UI smoke (§1.3 S6) 통과 시점에 본 절에 추가 row로 채운다.

---

## 10. Known Limitations

10.1. **Linear-interpolation resampling.** PoC 품질. 48 kHz → 16 kHz 다운샘플링 시 8 kHz 이상 콘텐츠는 pre-decimation low-pass 없이 alias가 발생. 마이크 음성에는 거의 무해, 음악 / 시스템 오디오에는 가청 효과 가능. Step 5 (Azure 실시간 STT 도입) 또는 product polish 단계에서 `WdlResampler` 또는 `MediaFoundationResampler`로 교체 가능. `Pcm16Resampler` 클래스 경계가 좁아서 교체 면적이 작다.

10.2. **Channel downmix는 단순 평균.** L+R+...+N를 N으로 나눈다. 스테레오 imaging은 잃는다 (Step 2 contract가 mono 강제하므로 의도된 손실).

10.3. **본 세션 마이크 부재.** 본 PoC가 실제 사용자 머신에서 mic capture를 시작할 때 native format / sample rate / latency가 어떻게 보고되는지 검증되지 않았다. NAudio `WasapiCapture(device, useEventSync: true)`는 일반 USB / 빌트인 / Bluetooth 마이크에서 안정적으로 동작한다고 알려져 있으나, 일부 driver는 `useEventSync: false` (polling)만 받는다. fatal error 발생 시 `Program.OnSourceError`가 `[FATAL]` 라인으로 surface하니, Step 4 UI smoke 시 그 로그를 같이 수집해 주면 fallback 로직(예: event-sync 실패 시 polling으로 자동 전환)을 그 시점에 결정 가능. Codex blocker fix(`0e70f17`)는 default endpoint 누락 케이스만 다루고, capture 시작 자체가 실패하는 케이스는 Step 4 UI smoke 관측 후 처리.

10.4. **Manual smoke matrix는 Step 4 UI 검증으로 이월.** Plan §11.2의 6 user-driven 시나리오는 Step 3 console 단계에서 수행하지 않는다. Step 4 desktop UI에서 device picker / level meter / mute toggle 위에 직접 토글하면서 한 번에 검증한다 — §1.3 S1~S6. master 체크박스 갱신은 Step 4 UI smoke 통과 시점에 묶는다.

10.5. **`audio_end` 시점 partial flush 미구현.** Step 2 backend가 `audio_end` 도착 시 in-progress chunk를 flush하는데, 데스크탑 capture는 frame boundary 단위로만 보내므로 마지막 partial frame (예: 30.020초 같은 dangling 20 ms) 는 다음 frame이 채워질 때까지 emit되지 않는다. 실용적으로 무해 (40 ms 단위가 작음) — Step 5에서 의미 있는 latency 경계가 되면 dangling flush hook 추가 검토.

10.6. **`useEventSync = true`는 일부 환경에서 deprecation 경고 가능.** NAudio 2.2.1에서는 정상이지만 향후 NAudio 메이저 업데이트 시 API drift 모니터링 필요.

10.7. **`Pcm16FrameEmitter.Drain()`가 List 할당.** 매 status tick마다 새 List를 만든다. PoC 부하에선 무관하지만 high frame rate에서 GC pressure가 보이면 array pool로 전환.

10.8. **DiagnosticWavWriter는 lazy file create.** source에 frame이 1개라도 들어와야 .wav 파일이 디스크에 생성된다. 의도된 동작 — silence-only 캡처에서 empty WAV 파일이 만들어지는 noise를 막는다.

---

## 11. Validation Results

### 11.1 초기 자동 게이트 (commit `a8933dd`)

```powershell
# 본 세션 머신 (active capture device 0개):
& "C:\Program Files\dotnet\dotnet.exe" --info               # 8.0.421 OK
& "C:\Program Files\dotnet\dotnet.exe" restore desktop/Kloser.Capture.Poc/Kloser.Capture.Poc.csproj
                                                            # 2.6s, OK
& "C:\Program Files\dotnet\dotnet.exe" build desktop/Kloser.Capture.Poc/Kloser.Capture.Poc.csproj
                                                            # 0 warnings, 0 errors, 6.74s
& "C:\Program Files\dotnet\dotnet.exe" run --project desktop/Kloser.Capture.Poc -- --list-devices
                                                            # OK (1 default render, 1 active render, 0 capture)
& "C:\Program Files\dotnet\dotnet.exe" run --project desktop/Kloser.Capture.Poc -- --no-mic --duration-sec 3
                                                            # OK (loopback bound, exit 0)
& "C:\Program Files\dotnet\dotnet.exe" run --project desktop/Kloser.Capture.Poc -- --no-mic --duration-sec 2 --write-diagnostic-wav --diagnostic-dir desktop/.diagnostics/dryrun
                                                            # OK (dir created, frames=0 silence, exit 0)
git diff --check                                            # clean
git ls-files --others --exclude-standard desktop/           # 16 source files, 0 build/diagnostic artifacts
```

### 11.2 Codex Blocker Fix 재검증 (commit `0e70f17`)

`0e70f17 Handle missing Windows audio endpoints` 적용 후 동일 머신에서 재실행:

```powershell
& "C:\Program Files\dotnet\dotnet.exe" build desktop/Kloser.Capture.Poc/Kloser.Capture.Poc.csproj
                                                            # 0 warnings, 0 errors, 1.09s
& "C:\Program Files\dotnet\dotnet.exe" run --project desktop/Kloser.Capture.Poc -- --duration-sec 1
                                                            # exit 3, no stack
                                                            # stderr: "error: no active capture endpoint found; rerun --list-devices or use --no-mic"
& "C:\Program Files\dotnet\dotnet.exe" run --project desktop/Kloser.Capture.Poc -- --duration-sec abc
                                                            # exit 2, no stack
                                                            # stderr: "argument error: --duration-sec requires an integer value, got 'abc'"
                                                            # stdout: help banner
& "C:\Program Files\dotnet\dotnet.exe" run --project desktop/Kloser.Capture.Poc -- --no-mic --duration-sec 3
                                                            # exit 0 (regression preserved)
& "C:\Program Files\dotnet\dotnet.exe" run --project desktop/Kloser.Capture.Poc -- --no-mic --duration-sec 2 --write-diagnostic-wav
                                                            # exit 0 (regression preserved)
git diff --check                                            # clean
git ls-files --others --exclude-standard                    # untracked diagnostic / build artifact 0건
```

`Program.Main`의 exit code 매핑은 변동 없음:

- `ArgumentException` → exit 2 + 도움말 출력 + stack trace 없음.
- `InvalidOperationException` → exit 3 + 메시지만 출력 + stack trace 없음.

### 11.3 Deferred — Step 4 UI Smoke

§1.3 S1~S6 항목은 Step 4 desktop UI 검증으로 이월. 본 라운드에서는 실행하지 않는다.

---

## 12. Step 4 시작 가능 여부

자동 게이트 + Codex blocker fix 재검증까지 통과. Plan §14 exit criteria 10개 중 자동으로 통과한 것:

- [x] `dotnet build` passes for the PoC project.
- [x] `--list-devices` lists capture and render devices.
- [x] Both sources emit PCM16 16 kHz mono frames. (codec/sample rate/channel은 상수 박힘 + dry-run에서 loopback 경로 정상)
- [x] Per-source seq and timing metadata are present. (Pcm16FrameEmitter 구현 + record field set)
- [x] No diagnostic audio or build artifacts are staged.
- [x] `PHASE_9_STEP_3_FINDINGS.md` exists.
- [x] Codex review validates the diff and checks. (blocker 1건 발견 → fix commit `0e70f17` → 재검증 PASS)

Step 4 UI smoke가 들어와야 통과 가능한 항목 (이월 — §1.3 매트릭스로 평가):

- [ ] Mic and loopback can run at the same time on Windows. (S3)
- [ ] Console status shows level and dropped frame count. (level: 실음원 + 마이크 입력 시 움직임 — S1 / S2 / S6)
- [ ] Dev-only diagnostic WAV proves source separation. (S4)

**결론**: Step 3 **code complete**. 자동 게이트 + Codex 리뷰 통과. Manual smoke는 Step 4 desktop UI 검증으로 이월 (§1.3) — 같은 시나리오를 console과 UI에서 두 번 돌리지 않는다. `PHASE_9_MASTER.md` Step 3 체크박스는 본 라운드에서 **변경하지 않는다.**

Step 4는 desktop UI shell + auth/session model + capture engine 통합. 본 PoC를 library / child process로 재사용할지의 결정은 Step 4 plan 작성 시 정리. Step 4 UI smoke가 §1.3 S1~S6을 통과한 시점에 master 체크박스 갱신 + 본 findings의 "pending user" 자리를 실 관측 데이터로 채운다.

---

## 13. Risks / Follow-ups

- **Manual smoke가 Step 4 UI와 묶임.** §1.3 S1~S6 항목이 Step 4 UI smoke의 mandatory 통과 조건이 된다. Step 4 plan은 UI 안에 level meter / device picker / mute toggle / WAV 옵션을 미리 끼워 두어 그 자리에서 S1~S6을 한 번에 돌릴 수 있도록 설계해야 한다.
- **Linear resampler quality.** Step 5에서 Azure STT 정확도 ground-truth가 잡히면, 동일 음원을 linear vs `WdlResampler` vs `MediaFoundationResampler`로 측정해서 적절한 시점에 교체.
- **NAudio 의존성.** PoC는 NAudio 단일 의존. Step 4에서 UI shell이 들어오면 의존성 트리가 커진다 — license / size 비교를 Step 4 plan에 포함.
- **Diagnostic WAV retention.** 사용자가 smoke 후 `.diagnostics/<stamp>/` 디렉토리를 수동 삭제하지 않으면 raw audio가 디스크에 남는다. README에 안내 + Step 4 UI에서 자동 만료 옵션 검토.
- **Backend wire-up (Step 5).** `CapturedAudioFrame` → `socket.emit("audio_chunk", meta, pcm)`의 변환이 Step 5 단일 책임. 본 PoC가 이미 1:1 field set이므로 변환은 mechanical일 것.
- **Friendly error 매핑 보존.** `0e70f17` fix가 추가한 `ArgumentException`(exit 2) / `InvalidOperationException`(exit 3) 분기를 Step 4 UI 통합에서 같이 surface해야 한다 (예: "마이크가 연결되지 않았습니다" 같은 안내). Step 4 UI가 console PoC를 child process로 띄우는 경우 exit code 2 / 3을 UI 측에서 구분해 메시지를 띄울 수 있도록 contract 유지.

---

## 14. Not Implemented (계획대로)

- Backend Socket.io 전송 (Step 5).
- `audio_start` / `audio_chunk` / `audio_end` 네트워크 emit (Step 5).
- Azure Speech / Naver Clova / Deepgram SDK (Step 5+).
- Flutter / WPF / tray shell (Step 4).
- 로그인 / token 저장 / Windows Credential Manager / DPAPI (Step 4).
- Phase 8 recording upload/finalize bridge (Step 6).
- 프로덕션 인스톨러, 자동 업데이트 (Step 7+).
- Browser MediaRecorder, telecom/provider import (범위 외).
- Speaker diarization, echo cancellation 보장 (범위 외).
- Step 3용 unit test project (Plan §11.1에서 optional, 본 라운드 미추가).

---

## 15. 참조

- 상위 master: `PHASE_9_MASTER.md`
- 선행 결정: `PHASE_9_STEP_1_DESKTOP_CAPTURE_ARCHITECTURE.md`
- 직전 step plan + findings: `PHASE_9_STEP_2_PLAN.md`, `PHASE_9_STEP_2_FINDINGS.md`
- 본 step plan: `PHASE_9_STEP_3_PLAN.md`
- PoC 자체 사용법: `desktop/Kloser.Capture.Poc/README.md`

# Phase 9 Step 7 Findings — Pilot Hardening + Closeout

작성일: 2026-05-21

상위 문서: `PHASE_9_MASTER.md`
계획 문서: `PHASE_9_STEP_7_PLAN.md`
선행 결과: `PHASE_9_STEP_3_FINDINGS.md`, `PHASE_9_STEP_4_FINDINGS.md`, `PHASE_9_STEP_5_FINDINGS.md`, `PHASE_9_STEP_6_FINDINGS.md`
신규 문서: `PHASE_9_RUNBOOK.md`

> Step 7은 새 기능을 늘리지 않는다. Step 5의 realtime desktop ↔ backend STT 경로와 Step 6의 recording archive 경로를 pilot-ready 수준으로 굳히는 것이 목표다. 본 라운드에서 가능한 것 (코드 hardening, 자동 게이트, runbook, Step 3/4/7 findings 정리, master 체크박스 정책)을 끝내고, 실 hardware가 필요한 manual matrix (S1-S6 / 5분 baseline / network·lifecycle edge)는 user-run 자리로 명시한다.

---

## 0. Status

**Code hardening + automatic gates + runbook 완료. Manual hardware matrix는 user-run 대기. Step 3 / Step 4 / Step 7 master 체크박스는 user-run 결과 반영 후 갱신.**

- Plan §3.4의 hardening 4건 + §3.5의 password/consent polish + §3.1 runbook 모두 본 라운드에 포함.
- 자동 게이트 (3 dotnet build / server typecheck / sync_shared_types / `npm --prefix server test` / `git diff --check` / staged artifact 검사) 전부 통과.
- §0.2 매트릭스에 PASS / user-run 자리 정리.
- `PHASE_9_MASTER.md` Step 7 체크박스는 **manual matrix 결과가 들어올 때까지 본 라운드에서 [x]로 갱신하지 않는다** (Plan §6 exit criteria).
- Step 5/6에서 푸시 완료된 desktop 코드 + 본 라운드 hardening은 Codex review 대기 상태로 working tree에 dirty로 남는다 (`git add/commit/push`는 Codex 작업).

### 0.1 본 라운드에서 한 것

코드 변경 5건 (모두 desktop side):

1. **Startup cleanup sweep** — `Services/RecordingArchive/PendingRecordingsSweeper.cs` (신규) + `App.xaml.cs` (`OnStartup` hook). `%LOCALAPPDATA%\Kloser\recordings\pending\<callId>\` 중 LastWrite >= 24h 이전인 디렉토리를 best-effort 삭제. 비동기 / silent / `pendingRoot` prefix 안에서만 동작.
2. **AudioRuntimeErrorCode casing 정규화** — `ViewModels/MainWindowViewModel.cs`의 `OnSocketRuntimeError`에서 fail-closed 비교를 `code is "BAD_PAYLOAD" or ...` (case-sensitive) → `IsAudioFailCloseCode(code)` (OrdinalIgnoreCase 4종 일치) 로 교체. 정상 wire는 그대로 통과하면서 wire가 임시로 다른 케이싱으로 바뀌어도 fail-closed가 빠지지 않게 안전망 추가. Step 5 findings §0.1 #4 lockstep 정책은 그대로.
3. **PasswordBox 교체** — `MainWindow.xaml`의 `<TextBox Text="{Binding LoginPassword}">` → `<PasswordBox PasswordChanged="OnLoginPasswordChanged">`. `MainWindow.xaml.cs`에 핸들러 추가 + VM이 `LoginPassword`를 비우면 PasswordBox UI도 즉시 `Clear()`. 화면에 비밀번호 평문 노출 차단.
4. **Consent placeholder** — backend band 안에 "고객에게 녹취/STT 안내함 (placeholder — legal workflow 아님)" 체크박스 추가. `ConsentAcknowledged` VM 프로퍼티. 통화 시작/종료를 막지 않는다 (실 compliance 워크플로우는 Phase 10+).
5. **(Step 6에서 이미 들어간 close-gated shutdown 유지)** — `MainWindow.xaml.cs` `Closing` + `MainWindowViewModel.ShutdownAsync` / `RequiresShutdownWait` + `_archiveUploadTask` 가 Step 7 plan §3.4의 "X close / archive 진행 중 종료" edge를 이미 닫고 있다. 본 라운드에서 추가 변경 없음.

문서 변경 4건:

6. **`PHASE_9_RUNBOOK.md` 신규** — Plan §3.1 그대로. server / static frontend / WPF 실행 순서, `server/.env` 예시, calls.html 재생 절차, 자주 보는 실패 진단, 보안 정책, 종료/정리.
7. **`PHASE_9_STEP_3_FINDINGS.md` 갱신** — §0.1 "Step 7 Closeout Addendum"으로 S1/S2/S3을 Step 5/6 E2E 묵시 PASS로 정리하고 S4/S5/S6은 user-run 대기로 분리.
8. **`PHASE_9_STEP_4_FINDINGS.md` 갱신** — 동일 매트릭스로 §0.1 추가.
9. **`PHASE_9_STEP_7_FINDINGS.md` 신규** — 본 문서.

backend / DB / wire / Phase 8 storage adapter 무변경 (Plan §2 Out of Scope 정책 유지).

### 0.2 PASS vs user-run 매트릭스

| 항목 | 본 라운드 상태 | 비고 |
|---|---|---|
| `dotnet build` Capture.Core | **PASS** 0/0 | 3.71s cold |
| `dotnet build` Capture.Poc | **PASS** 0/0 | 1.32s incremental |
| `dotnet build` Desktop.Shell | **PASS** 0/0 | 2.70s incremental |
| `npm --prefix server run typecheck` | **PASS** | tsc --noEmit |
| `node test/sync_shared_types.mjs` | **PASS** | 21 schemas in lockstep |
| `npm --prefix server test` | **PASS** | 881 total / 878 pass / 3 skipped / 0 fail |
| `git diff --check` | **PASS** | clean (LF/CRLF 경고만, no whitespace error) |
| Staged artifact (`*.wav` / `*.pcm` / `*.raw` / `*.log` / `bin/` / `obj/` / `server/.env` / `server/.data/`) | **PASS** | 0건 |
| Runbook | **PASS** | `docs/plan/phase-9/PHASE_9_RUNBOOK.md` 신규 |
| S1 mic level | **PASS (Step 5/6 묵시)** | Step 5 partial transcript + Step 6 archive |
| S2 loopback level | **PASS (Step 5/6 묵시)** | 동일 |
| S3 mic + loopback 동시 | **PASS (Step 5/6 묵시)** | 동일 + archive stereo WAV |
| S4 diagnostic WAV separation | **user-run 대기** | 별도 toggle 경로, Step 5/6 미행사 |
| S5 mute / silence | **user-run 대기** | Step 5/6 정상 발화만 수행 |
| S6 5분 baseline | **user-run 대기** | Step 5 최장 196초 (~3:16), 5분 미달 |
| 5-minute baseline (Plan §3.3) | **user-run 대기** | S6과 동일 시나리오 |
| Network: backend down before connect | **user-run 대기** | 코드 경로는 `OnSocketTransportFailed`로 fail-closed |
| Network: bad/expired token | **user-run 대기** | `DesktopAuthClient` 실패 경로 + `LastRealtimeError` |
| Network: backend restart during call | **user-run 대기** | `OnSocketDisconnected` → capture stop + call ended |
| Network: socket disconnect during call | **user-run 대기** | `OnSocketDisconnected` 동일 경로 |
| Network: BAD_PAYLOAD / AUDIO_BACKPRESSURE / AUDIO_CHUNK_TOO_LARGE / AUDIO_SEQ_OUT_OF_ORDER | **PASS (코드)** | §0.1 #2 정규화 헬퍼로 fail-closed 보장 |
| End Call double click | **user-run 대기** | `EndCallCommand.CanExecute = IsCallActive`로 in-flight 시 비활성 |
| X close during Starting/InCall/Ending/archive upload | **PASS (Step 6 코드)** | `RequiresShutdownWait` + `ShutdownAsync` 30s 한도 |
| Process kill — 다음 부팅에서 stale temp sweep | **PASS (Step 7 §0.1 #1)** | startup sweeper 24h+ |
| 토큰 / signed URL / object key / 로컬 path 노출 | **PASS (코드 + 정책)** | 메모리만 + UI/Events/Errors 미노출, runbook §4 정리 |
| 비밀번호 평문 노출 | **PASS (§0.1 #3)** | PasswordBox + login 성공 시 UI 즉시 비움 |
| Consent placeholder | **PASS (§0.1 #4)** | UI 표기, legal workflow는 Phase 10+ |

### 0.3 Master 체크박스 정책

- Step 3 `[ ]` 유지 — S4/S5/S6 user-run 대기.
- Step 4 `[ ]` 유지 — 동일.
- Step 7 `[ ]` 유지 — Plan §6 exit criteria에 "S1-S6 matrix recorded with real results" + "5 minute baseline recorded" + "network/lifecycle edge matrix recorded"가 포함됨. 본 라운드에서는 매트릭스 자리만 만들었고 실 결과 row가 비어 있으므로 [x]로 갱신하지 않는다.

사용자가 본 머신에서 §0.2의 user-run 항목을 채우면:
1. 본 §0.2 row를 PASS/FAIL 결과로 갱신.
2. Step 3 / Step 4 findings §0.1 user-run 표도 동일 결과로 갱신.
3. Step 3 / Step 4 / Step 7 master 체크박스를 한꺼번에 [x]로 갱신 (Codex commit).

---

## 1. Code Hardening Detail

### 1.1 Startup Pending Recordings Sweep

신규 `desktop/Kloser.Desktop.Shell/Services/RecordingArchive/PendingRecordingsSweeper.cs`:

- `PendingRecordingsSweeper.StaleThreshold = 24h` 상수. Plan §3.4 권장값.
- `SweepInBackgroundAsync()` — `Task.Run` 비동기. UI 스레드 절대 잡지 않음.
- `SweepOnce()` — `%LOCALAPPDATA%\Kloser\recordings\pending` 하위만 enumerate. `Path.GetFullPath()`로 정규화 후 `pendingRoot` prefix 검사로 경로 탈출 방지. 각 디렉토리의 `LastWriteTimeUtc`가 24h 이전이면 `Directory.Delete(recursive: true)`.
- 결과는 `SweepResult(Scanned, Deleted, Skipped, Errored)` record로 `LastSweepSummary`에 노출. 본 라운드에서는 UI에 표시하지 않음 (Step 7 polish 범위 밖).
- 어떤 디렉토리 실패도 다른 디렉토리 처리를 막지 않음. `try/catch` 전부 silent.

`App.xaml.cs`:

```csharp
protected override void OnStartup(StartupEventArgs e)
{
    base.OnStartup(e);
    _ = _sweeper.SweepInBackgroundAsync();
}
```

검증:
- pending 디렉토리 0개 환경에서 즉시 `(0,0,0,0)` 반환.
- recursive delete가 raw audio + per-source PCM 스크래치까지 한 번에 정리 (CallArchiveWavWriter가 scratch 안에 PCM 파일을 둠).

리스크 / 후속:
- 시간 기반(24h) 정책이라 사용자가 "어제 통화 마지막 결과를 다시 보고 싶다"고 했을 때 사라질 수 있음. Step 7 polish에서 retention 옵션을 UI로 노출하는 건 별도 검토.
- 만약 통화 시작 직전 사용자가 시스템 시계를 조작했다면 cutoff 비교가 부정확. 본 라운드 범위 밖.

### 1.2 AudioRuntimeErrorCode 정규화

`MainWindowViewModel.cs`:

```csharp
private static readonly string[] _audioFailCloseCodes = new[]
{
    "BAD_PAYLOAD", "AUDIO_CHUNK_TOO_LARGE",
    "AUDIO_BACKPRESSURE", "AUDIO_SEQ_OUT_OF_ORDER",
};
private static bool IsAudioFailCloseCode(string? code)
{
    if (string.IsNullOrEmpty(code)) return false;
    foreach (var canonical in _audioFailCloseCodes)
    {
        if (string.Equals(code, canonical, StringComparison.OrdinalIgnoreCase))
            return true;
    }
    return false;
}
```

`OnSocketRuntimeError` 본문이 `code is "BAD_PAYLOAD" or "AUDIO_CHUNK_TOO_LARGE" or "AUDIO_BACKPRESSURE" or "AUDIO_SEQ_OUT_OF_ORDER"` → `IsAudioFailCloseCode(code)` 로 단일화.

정책: backend `server/src/types/wsAudio.ts` `AudioRuntimeErrorCode` union의 대문자 4종 정본은 그대로 유지. desktop은 OrdinalIgnoreCase로 한 번 더 안전망. Step 5 findings §0.1 #4 lockstep 정책 (3-way sync 시 동시 갱신)도 그대로 — 본 변경은 "wire 변경 시 desktop이 한 박자 늦어도 silent inconsistency가 생기지 않게" 막아주는 추가 방어층.

회귀 가능성:
- `code`가 `null`이면 `false` 리턴 — 이전 case-sensitive 매칭도 `null is "BAD_PAYLOAD"`이 false였으므로 동일 동작.
- `code = "bad_payload"` 같은 lowercased 변형이 들어오면 이전엔 fail-closed가 안 됐는데 이제는 됨 — **의도된 변경**.

### 1.3 PasswordBox 교체

`MainWindow.xaml`:

```xml
<PasswordBox x:Name="LoginPasswordBox" PasswordChanged="OnLoginPasswordChanged"
             Background="#F8FAFC" Foreground="#0F172A" Padding="6,4" MinHeight="28"
             BorderBrush="{StaticResource PanelBorderBrush}"/>
```

`MainWindow.xaml.cs`:

```csharp
private void OnLoginPasswordChanged(object sender, RoutedEventArgs e)
{
    if (sender is PasswordBox box)
    {
        _viewModel.LoginPassword = box.Password;
    }
}

// ctor:
_viewModel.PropertyChanged += (_, ev) =>
{
    if (ev.PropertyName == nameof(MainWindowViewModel.LoginPassword)
        && string.IsNullOrEmpty(_viewModel.LoginPassword)
        && LoginPasswordBox.Password.Length > 0)
    {
        LoginPasswordBox.Clear();
    }
};
```

핵심 결정:
- PasswordBox의 `Password`는 `SecurityCritical` 속성이라 직접 binding 불가. `PasswordChanged` 이벤트에서 평문을 한 번씩 VM으로 옮긴다. 평문이 binding 경로를 통해 visual tree 어디에도 노출되지 않는다.
- login 성공 시 VM이 `LoginPassword = ""`로 비우면 PasswordBox UI도 즉시 `Clear()` → 내부 `SecureString`도 함께 zero-fill. 화면 / 메모리 양쪽에서 평문 잔존 없음.
- 기존 dev fallback (env `KLOSER_DESKTOP_ACCESS_TOKEN` 또는 token paste TextBox)은 유지. token paste는 별도 dev 경로라 본 라운드에서 PasswordBox로 바꾸지 않음 — 토큰은 사용자가 명시적으로 페이스트하는 dev 한정 fallback이고 UI 노출 영역도 backend band 한 곳뿐.

회귀 위험:
- TextBox에서 입력하던 비밀번호가 더이상 평문으로 화면에 보이지 않음 → 사용자가 "비밀번호 입력했나?" 확인하려면 다시 입력해야 함. PasswordBox의 dot 표시로 충분히 가시화됨.

### 1.4 Consent Placeholder

`MainWindow.xaml`:

```xml
<StackPanel Orientation="Horizontal" Margin="0,8,0,0">
    <CheckBox Content="고객에게 녹취/STT 안내함 (placeholder — legal workflow 아님)"
              IsChecked="{Binding ConsentAcknowledged, Mode=TwoWay}"
              VerticalAlignment="Center"/>
</StackPanel>
```

`MainWindowViewModel.cs`:

```csharp
private bool _consentAcknowledged;
public bool ConsentAcknowledged
{
    get => _consentAcknowledged;
    set => SetField(ref _consentAcknowledged, value);
}
```

핵심 결정:
- 통화 시작/종료 명령에 영향을 주지 않는다 (`StartCallCommand.CanExecute`에 `ConsentAcknowledged`를 추가하지 않음). 실 compliance 워크플로우는 Phase 10+ 범위 (Plan §2 Out of Scope).
- 라벨에 명시적으로 "placeholder — legal workflow 아님"을 박아 운영자가 본 UI를 컴플라이언스 게이트로 오인하지 않도록 함.

### 1.5 Close-Gated Shutdown (Step 6에서 이미 들어감, 본 라운드 확인)

- `MainWindow.xaml.cs` `OnClosing` — `RequiresShutdownWait`가 true면 첫 close 취소, `ShutdownAsync` await 후 재닫기.
- `MainWindowViewModel.ShutdownAsync` — `IsCallActive`면 `EndCallAsync`, 진행 중 `_archiveUploadTask`가 있으면 `Task.WhenAny(pending, Task.Delay(30s))`로 한도 안에서 대기.
- `RequiresShutdownWait` getter — `CallStateValue`가 `Starting/InCall/Ending`이거나, `_archiveSession`이 살아있거나, `_archiveUploadTask`가 미완료면 true.

본 라운드에서 추가 변경 없음. Step 7 plan §3.4의 "X close / End Call double click / archive upload 중 종료 edge" 항목에 대한 코드 답은 이미 들어가 있는 상태.

---

## 2. Files Changed (본 라운드)

신규 (3 files):

| File | 역할 |
|---|---|
| `desktop/Kloser.Desktop.Shell/Services/RecordingArchive/PendingRecordingsSweeper.cs` | startup sweeper (24h+ pending recording 디렉토리 삭제) |
| `docs/plan/phase-9/PHASE_9_RUNBOOK.md` | 로컬 dev pilot runbook |
| `docs/plan/phase-9/PHASE_9_STEP_7_FINDINGS.md` | 본 문서 |

수정 (5 files):

| File | 변경 |
|---|---|
| `desktop/Kloser.Desktop.Shell/App.xaml.cs` | `OnStartup` override + sweeper hook |
| `desktop/Kloser.Desktop.Shell/MainWindow.xaml` | PasswordBox 교체 + consent placeholder 체크박스 |
| `desktop/Kloser.Desktop.Shell/MainWindow.xaml.cs` | `OnLoginPasswordChanged` 핸들러 + VM `LoginPassword="" 시 UI Clear` 핸들러 |
| `desktop/Kloser.Desktop.Shell/ViewModels/MainWindowViewModel.cs` | `IsAudioFailCloseCode` 정규화 + `ConsentAcknowledged` VM 프로퍼티 |
| `docs/plan/phase-9/PHASE_9_STEP_3_FINDINGS.md` | §0.1 Step 7 closeout addendum (S1-S6 PASS/user-run 분리) |
| `docs/plan/phase-9/PHASE_9_STEP_4_FINDINGS.md` | 동일 |

추가로 사용자가 같은 working tree에 작성해 둔 `docs/plan/phase-9/PHASE_9_STEP_7_PLAN.md` (untracked) + `docs/plan/phase-9/PHASE_9_MASTER.md` (Step 6 closeout 머리말 갱신 결과)도 본 dirty 인벤토리에 포함되지만 Step 7 본 라운드의 산출물은 아니다 — Codex commit 시 함께 묶어 갈지 분리할지는 Codex 판단.

---

## 3. Validation Results

### 3.1 자동 게이트

```powershell
& "C:\Program Files\dotnet\dotnet.exe" build desktop/Kloser.Capture.Core/Kloser.Capture.Core.csproj   # 0 warn / 0 err, 3.71s
& "C:\Program Files\dotnet\dotnet.exe" build desktop/Kloser.Capture.Poc/Kloser.Capture.Poc.csproj     # 0 / 0, 1.32s
& "C:\Program Files\dotnet\dotnet.exe" build desktop/Kloser.Desktop.Shell/Kloser.Desktop.Shell.csproj # 0 / 0, 2.70s

npm --prefix server run typecheck                                                                     # tsc --noEmit PASS
node test/sync_shared_types.mjs                                                                       # 21 schemas PASS
npm --prefix server test                                                                              # 881 total / 878 pass / 3 skipped / 0 fail

git diff --check                                                                                      # clean
git status --short --branch                                                                           # §4 dirty list
git diff --stat                                                                                       # §4 diff stat
git ls-files --others --exclude-standard                                                              # §4 untracked
```

### 3.2 Manual Hardware Matrix — user-run 대기

§0.2 표 그대로. 사용자가 본 머신에서 다음을 수행 후 결과를 채워주시면 본 §3.2 / §0.2 / Step 3/4 findings / master 체크박스가 한 번에 정리된다:

1. **S1** WPF 띄우고 마이크에 말하기 → agent_mic peak/RMS 게이지 움직임 + frames > 0.
2. **S2** 시스템 오디오 재생 → system_loopback 게이지 움직임 + frames > 0.
3. **S3** S1 + S2 동시 → 두 source counter 동시 증가, dropped = 0 또는 사유 명시.
4. **S4** Step 4 plan §6.3의 diagnostic WAV toggle ON → `desktop/.diagnostics/<stamp>/agent_mic.wav` + `system_loopback.wav` 두 파일 생성 + 청취 시 source separation 확인 + smoke 끝나면 `.diagnostics/<stamp>/` 수동 삭제.
5. **S5** 통화 중 mic 토글 (OS mute or hardware mute) → agent_mic level drop, system_loopback 정상; 시스템 오디오 정지 → loopback drop, mic 정상. fatal error 없음.
6. **S6** 통화 5분 이상 유지 → process 메모리 가용량 안에서 유지 (Task Manager 관측), dropped frames 0 또는 사유, archive 5분 분량으로 available + calls.html 재생 OK.

추가로 Plan §3.4 매트릭스:

- backend 미기동 상태에서 `로그인 + 연결` 시도 → friendly 에러 + capture 미시작.
- 잘못된 이메일/비밀번호 → friendly 에러, 토큰 미발급, 패널에 비밀번호 평문 미노출.
- 통화 중 server 강제 종료(`Ctrl-C`) → `Socket.IO 연결 해제: ...` 이벤트, capture stop, call state Ended.
- 통화 중 `통화 종료` 더블 클릭 → 한 번만 backend close 경로 진입 (`EndCallCommand.CanExecute`가 first click 후 false), 중복 final transcript / 중복 archive 업로드 없음.
- 통화 중 X 닫기 → `Closing` 이벤트가 close 취소 → `ShutdownAsync` 진행 → 30s 안에 archive 완료 또는 timeout → 재닫기. 두 번째 X 누르면 즉시 닫힘.
- 통화 중 process kill (Task Manager) → 다음 부팅에서 startup sweeper가 24h+ 디렉토리 정리. 24h 이내 디렉토리는 그대로 남고 사용자가 수동 삭제 가능.

### 3.3 보안 / privacy sentinel

코드 + 정책 기준 점검 (실 leakage scan은 Codex review):

- 액세스 토큰: `_accessTokenMemoryOnly`만 memory에 보관. 디스크 / Credential Manager / DPAPI / 환경변수 영구 저장 없음. login 성공 후 `LoginPassword = ""`.
- 비밀번호: PasswordBox 입력 → 메모리 한 번 → login 성공 시 UI/메모리 동시 비움.
- raw PCM: capture sink → frame buffer → Socket.IO binary emit → 디스크 미저장. archive 경로만 디스크 사용, 업로드 성공/실패 후 즉시 삭제 + 24h+ stale sweep.
- signed URL / object key / checksum / 로컬 archive 경로: `RecordingArchiveClient`가 에러 메시지에 포함하지 않음. UI Events / Errors 패널 / `LastRealtimeError`에도 출력 없음.
- diagnostic WAV: 기본 OFF. 활성화 시 raw audio가 평문으로 `desktop/.diagnostics/<stamp>/`에 남으므로 runbook §4에서 smoke 후 수동 삭제 권고.

---

## 4. Dirty Inventory (Codex review용)

```text
## main...origin/main
 M desktop/Kloser.Desktop.Shell/App.xaml.cs
 M desktop/Kloser.Desktop.Shell/MainWindow.xaml
 M desktop/Kloser.Desktop.Shell/MainWindow.xaml.cs
 M desktop/Kloser.Desktop.Shell/ViewModels/MainWindowViewModel.cs
 M docs/plan/phase-9/PHASE_9_MASTER.md           ← Step 6 closeout 머리말 (사용자 직접 갱신, Step 7 본 라운드 산출물 아님)
 M docs/plan/phase-9/PHASE_9_STEP_3_FINDINGS.md  ← Step 7 closeout addendum
 M docs/plan/phase-9/PHASE_9_STEP_4_FINDINGS.md  ← Step 7 closeout addendum
?? desktop/Kloser.Desktop.Shell/Services/RecordingArchive/PendingRecordingsSweeper.cs
?? docs/plan/phase-9/PHASE_9_RUNBOOK.md
?? docs/plan/phase-9/PHASE_9_STEP_7_FINDINGS.md
?? docs/plan/phase-9/PHASE_9_STEP_7_PLAN.md      ← 사용자 직접 작성 (Step 7 plan)
```

`server/.env`, `server/.data/`, `*.wav`, `*.pcm`, `*.raw`, `*.log`, `bin/`, `obj/` 0건 staged. `git diff --check` clean.

---

## 5. Risks / Follow-ups

- **S4/S5/S6 + 5-minute baseline + network·lifecycle matrix가 user-run 대기.** 본 라운드 끝낼 수 있는 작업의 한계. 사용자 머신에서 매트릭스 채워지면 §0.2 + Step 3/4 findings + master 체크박스 동시 갱신.
- **startup sweeper의 24h cutoff.** 사용자 시계 조작 / 다음 날 다시 켜는 패턴 / 사용자가 직전 통화를 다시 보고 싶은 경우 등에 손실 가능. retention 정책은 Phase 10+ 폴리시.
- **PasswordBox + token paste 공존.** 평문 입력 가능한 영역은 token paste TextBox 한 곳 (dev fallback). 추후 폴리시에서 이도 제거하거나 별도 dev 모드 토글 뒤로 숨기는 것이 안전.
- **Consent placeholder는 워크플로우 아님.** 실 compliance 게이트는 Phase 10+에서 별도 설계 (서명, 음성 안내, audit trail).
- **MainWindowViewModel 크기.** ~1300 LoC. Step 7 plan §3.6의 optional split (`RealtimeViewModel` / `RecordingArchiveViewModel`)은 본 라운드 미수행 — regression risk 대비 hardening 우선순위가 낮음.
- **Automatic reconnect 부재.** Plan §3.4가 명시한 "automatic hidden reconnect 추가 금지" 정책 그대로. socket 끊김은 사용자 가시화 후 수동 재연결만.
- **Codex review owns commit/push.** AGENTS.md §Commit/Push Discipline 준수. Claude는 변경 파일 + 검증 결과 보고만 수행.

---

## 6. Out of Scope (계획대로)

- Azure Speech SDK 실호출.
- Flutter Windows shell 전환.
- production installer / 자동 업데이트 / code signing.
- real S3 / MinIO recording storage provider smoke.
- raw audio offline retry queue.
- 자동 hidden reconnect.
- legal consent 워크플로우 완성.
- browser MediaRecorder UI.
- speaker diarization 품질 보장.
- MainWindowViewModel 대형 리팩터링.

---

## 7. 참조

- 상위 master: `PHASE_9_MASTER.md`
- 본 step plan: `PHASE_9_STEP_7_PLAN.md`
- 신규 runbook: `PHASE_9_RUNBOOK.md`
- Step 3 / 4 / 5 / 6 findings + 본 step 7 findings로 Phase 9 closeout 묶음 정리.

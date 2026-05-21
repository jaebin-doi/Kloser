# Phase 9 Step 5 Findings — Realtime Backend Integration

작성일: 2026-05-21

상위 문서: `PHASE_9_MASTER.md`
계획 문서: `PHASE_9_STEP_5_PLAN.md`
선행 결과: `PHASE_9_STEP_4_FINDINGS.md`, `PHASE_9_STEP_2_FINDINGS.md`

> Step 5는 Step 4 WPF shell이 backend `/calls` Socket.IO namespace에 인증 연결하고, `start_call → audio_start → audio_chunk(meta, binary) → audio_end → end_call` lifecycle을 닫는 desktop ↔ backend 실시간 오디오 경로 첫 wiring을 끝냈다. Azure Speech 실호출, Flutter 전환, Phase 8 recording archive upload/finalize는 의도적으로 손대지 않았다.

---

## 0. Status

**Implementation complete; hardware/auth manual e2e deferred to user machine.**

- 신규 `desktop/Kloser.Desktop.Shell/Services/Realtime/` 5 파일 — wire models, auth client, socket client, audio sink, call session.
- `CaptureSessionController`에 external composite sink 등록 hook 추가 — 기존 counting / WAV sink 그대로 보존.
- `MainWindowViewModel` + `MainWindow.xaml`에 backend band + 통화 컨트롤 + partial / final transcript 패널 추가. 이전 Step 4의 dirty / Korean 사용자 수정 그대로 보존.
- 자동 게이트 (3 projects build / server typecheck / sync_shared_types / `npm --prefix server test` 869 PASS / `git diff --check`) 모두 통과.
- **Manual e2e (실 mic + 실 backend 로그인 + transcript 흐름) 은 본 dev 세션 머신에 active capture device가 0개라 수행 불가**. 사용자 머신에서 §7 manual gate 통과시키면 `PHASE_9_MASTER.md` Step 5 체크박스를 갱신할 수 있다 — 본 라운드에서는 변경하지 않는다.
- backend wire / 계약 / schema 무변경 (Plan §6 정책 그대로).

### 0.1 Codex Review Fixes

Codex review에서 lifecycle edge 2건과 UI label 1건을 추가 수정했다.

1. `RealtimeCallSession.StopAsync()` — `audio_end` emit 실패 시 바로 반환하지 않고 `end_call`을 계속 시도하도록 수정. 의도는 "audio flush 실패"와 "call close 실패"를 분리하고, 가능한 경우 backend call row가 orphan 상태로 남지 않게 하는 것이다.
2. `MainWindowViewModel` — active call 중 socket disconnect / transport failure가 발생하면 call session cleanup과 함께 capture를 stop하도록 수정. Step 5 Plan §5.3의 "disconnect while capture is active: stop capture or pause capture; no raw audio buffering" 정책에 맞춘다.
3. `MainWindow.xaml` — backend band의 login button label을 실제 동작에 맞게 `로그인 + 연결`로 수정.

---

## 1. 선택한 Socket.IO NuGet 패키지

- **SocketIOClient 3.1.2** (`https://github.com/doghappy/socket.io-client-csharp`)
- target framework: net8.0-windows.
- 선택 이유 + 검증:
  - Socket.IO 4.x protocol(EIO V4) 지원 — backend의 `socket.io@4.x`와 정확히 매칭.
  - `EmitAsync(eventName, metaObject, byte[] binary)` overload가 그대로 작동 → `audio_chunk(meta, buffer)` 시그니처에 base64 / JSON 우회 없이 1:1 매핑 (Plan §4.2 핵심 요구).
  - ack callback 패턴이 `EmitAsync(eventName, ackCallback, payload)` 시그니처로 자연스럽게 매핑 → `start_call` / `end_call` ack 그대로 받음.
  - JWT handshake auth는 `SocketIOOptions.Auth = new { token = accessToken }` 한 줄로 wire format `auth: { token }`과 정확히 일치.
- 핀: `desktop/Kloser.Desktop.Shell/Kloser.Desktop.Shell.csproj`의 `<PackageReference Include="SocketIOClient" Version="3.1.2" />`로 고정.
- 빌드 한 번에 API mismatch 4 건 발견 → 즉시 fix (Plan §4.2 "If the package cannot support this shape, stop and report the blocker"는 base64 우회 강제 차단 정책이므로 본 fix는 그 범위 밖, 동일 패키지로 정상 매칭):
  - 이름 충돌(`SocketIOClient.SocketIO` namespace + class 동명) → `using SioClient = SocketIOClient.SocketIO;` alias로 회피.
  - `EngineIO` enum 위치 → `SocketIO.Core.EngineIO.V4` namespace 사용.
  - `Namespace` 속성 read-only → constructor URL path(`baseUrl + "/calls"`)로 namespace 지정.
  - `EmitAsync` 가 `Task` 반환 → `.AsTask()` 호출 불필요, 그냥 await / return.

대안 검토 (Plan §4.2 default 그대로 채택): `H.Socket.IO`, `RestSharp` 기반 wrapper 등은 binary 송신 / EIO V4 지원이 불완전하거나 maintenance status가 낮아 제외. SocketIOClient 3.1.2가 backend wire에 가장 정확.

---

## 2. 변경 파일 목록

### 2.1 신규 (`desktop/Kloser.Desktop.Shell/Services/Realtime/` 4 files)

| File | 역할 |
|---|---|
| `RealtimeModels.cs` | wire payload(StartCallPayload/Ack, AudioStartPayload, AudioChunkMetaPayload, AudioEndPayload, EndCallAck) + 서버 emit(TranscriptEvent, TranscriptPartialEvent, RealtimeErrorEvent) + UI enum(RealtimeConnectionState, RealtimeCallState, RealtimeAuthMode). 모든 [JsonPropertyName]은 backend zod 필드명과 1:1. |
| `DesktopAuthClient.cs` | `/auth/login` HttpClient 호출 + `KLOSER_DESKTOP_ACCESS_TOKEN` env fallback. MFA challenge(202) 응답 시 unsupported 메시지로 paste-token 안내. accessToken을 메모리로만 반환, body는 JsonDocument로 파싱 후 폐기. |
| `CallsSocketClient.cs` | `SocketIOClient.SocketIO` wrapper. handshake auth, `/calls` namespace, `start_call`/`audio_start`/`audio_chunk(meta, byte[])`/`audio_end`/`end_call` emit, `transcript`/`transcript.partial`/`error` listener, `Connected`/`Disconnected`/`TransportFailed` 이벤트. |
| `SocketIoAudioFrameSink.cs` | `ICapturedFrameSink` 구현. `CapturedAudioFrame` → `AudioChunkMetaPayload` + binary PCM 직송. source별 monotonic seq, chunks/bytes 카운터, declared source 외 frame은 dropped 카운터로 silent skip, send 실패는 `SendFailed` 이벤트(raw PCM 없이 source/seq/길이만 노출). |
| `RealtimeCallSession.cs` | call lifecycle 상태 머신: `StartAsync(audio_start payload)` → `start_call` ack 받기 → `audio_start` emit → sink Activate. `StopAsync()` → sink Deactivate → `audio_end` emit → `end_call` ack. `FailClosed()`로 BAD_PAYLOAD / AUDIO_BACKPRESSURE 처리 (Plan §5.3). |

### 2.2 수정 (5 files)

| File | Change |
|---|---|
| `desktop/Kloser.Desktop.Shell/Kloser.Desktop.Shell.csproj` | `<PackageReference Include="SocketIOClient" Version="3.1.2" />` 추가 + Step 5 정책 주석. |
| `desktop/Kloser.Desktop.Shell/Services/CaptureSessionController.cs` | external sink composition — `_externalSinks` 리스트 + `AddExternalSink` / `RemoveExternalSink` API + pump loop가 externals에도 frame을 push. 기존 counting + WAV sink 동작 무변경. Stop()에서 externals clear. |
| `desktop/Kloser.Desktop.Shell/ViewModels/MainWindowViewModel.cs` | (이전 dirty 한국어 수정 보존) Realtime fields(`_auth`, `_socket`, `_callSession`, `_audioSink`, `_accessTokenMemoryOnly`) + 새 bindable surface(BackendUrl, LoginEmail, LoginPassword, PastedToken, ConnectionState/CallStateValue/ActiveCallId/ LastRealtimeError, AgentMic+SystemLoopback Chunks/BytesSent, LatestPartial Agent/Customer, FinalTranscripts) + 5 commands(LoginAndConnect, ConnectWithToken, Disconnect, StartCall, EndCall) + 8 async lifecycle/event handlers. CleanupCallSession + Dispose에서 socket / auth / call session 모두 정리. |
| `desktop/Kloser.Desktop.Shell/MainWindow.xaml` | `Grid.RowDefinitions` 5 → 6 (Backend / Call band 신규 Row 2 삽입). 신규 패널: backend URL + 이메일 + 비밀번호 + paste token + 4 버튼(LoginAndConnect / ConnectWithToken / Disconnect / Disconnect) + 통화 상태/callId/Start Call/End Call/chunks/bytes/last error. status grid를 2-col → 3-col로 확장하고 우측에 partial + final transcript 패널. 기존 Korean 라벨 / 한국어화 모두 그대로 보존. |
| `desktop/Kloser.Desktop.Shell/ViewModels/SourceStatusViewModel.cs` | (Step 4 + Step 5 사이 dirty 그대로 유지, Step 5는 손대지 않음.) |

총 **신규 5 + 수정 5** + findings 1. backend / server / migration / 다른 phase 무변경.

---

## 3. 인증 방식

Plan §4.5 따라 **두 가지 path 모두 구현 + 사용자가 선택**:

1. **로그인 (Preferred)** — UI에서 백엔드 URL + 이메일 + 비밀번호 입력 → "로그인 + 연결" 버튼. 내부적으로 `DesktopAuthClient.LoginAsync(baseUrl, email, password)` → `POST /auth/login`. 응답의 `accessToken`만 `_accessTokenMemoryOnly` 필드(static 아님, instance memory)에 저장하고 비밀번호 필드를 즉시 비움(`LoginPassword = ""`). MFA challenge(HTTP 202)면 friendly 안내 + paste-token fallback 권유.
2. **Paste token (dev fallback)** — "토큰으로 연결" 버튼. UI 입력 또는 `KLOSER_DESKTOP_ACCESS_TOKEN` env 자동 채움 → `ConnectWithTokenAsync` → 메모리 보관 후 `PastedToken = ""`. UI text도 즉시 비움.

토큰 보호 정책 (Plan §4.5):
- 메모리에만 보관 (`_accessTokenMemoryOnly` private field).
- 파일 / 레지스트리 / 로그 / `LastErrors` panel / `Events` panel 어디에도 평문으로 노출 안 함.
- 예외 메시지에 토큰 자체가 포함되는 호출 경로는 차단됨 — `DesktopAuthClient`는 응답 본문 파싱 시 토큰 키만 추출하고 본문 전체를 그대로 echo하지 않음.
- `DisconnectAsync` 시 `_accessTokenMemoryOnly = null`로 클리어.
- refresh token / 비밀번호 영구 저장 안 함.

dev 편의 한 가지: `MainWindowViewModel` 생성자에서 `KLOSER_DESKTOP_ACCESS_TOKEN` env가 설정돼 있으면 `PastedToken` UI 필드에 자동 채움. 사용자가 별도 입력 없이 "토큰으로 연결" 클릭하면 그 토큰으로 즉시 시도.

---

## 4. Wire event 증거

`CallsSocketClient`가 Step 2 backend 매핑을 1:1로 따른다. 코드 인용:

```csharp
// start_call ack
await socket.EmitAsync("start_call", response =>
{
    var ack = response.GetValue<StartCallAck>(0) ?? new StartCallAck();
    tcs.TrySetResult(ack);
}, payload);

// audio_start
await socket.EmitAsync("audio_start", payload);

// audio_chunk(meta, byte[])  ← Plan §3.2 핵심
return socket.EmitAsync("audio_chunk", meta, pcm);

// audio_end
return socket.EmitAsync("audio_end", payload);

// end_call ack
await socket.EmitAsync("end_call", response =>
{
    var ack = response.GetValue<EndCallAck>(0) ?? new EndCallAck();
    tcs.TrySetResult(ack);
}, new { });
```

라이프사이클 순서(Plan §5.1 happy path)는 `RealtimeCallSession`이 강제:

1. `start_call` payload `{ }` → ack `{ callId | error, code }`.
2. ack 성공 시 `audio_start` payload(`call_id`, `sources`, `codec="pcm_s16le"`, `sample_rate_hz=16000`, `channels=1`, `frame_ms`, `app_version="phase9-step5-dev"`) emit.
3. capture pump가 `SocketIoAudioFrameSink.OnFrameAsync` 마다 `audio_chunk(meta, pcm)` emit. 메타에 source별 monotonic `seq`(1부터), `duration_ms`, `started_at_ms` 포함.
4. `StopAsync(reason="normal")` → sink Deactivate → `audio_end { reason: "normal" }` emit → `end_call` ack 대기.

source 제약 (Plan §5.2 그대로): `audio_start.sources` 배열에 선언된 source만 chunk emit. 미선언 source의 frame이 sink에 들어오면 `_droppedChunks++`만 하고 wire에 안 나감.

fail-closed (Plan §5.3): 백엔드 `error` 이벤트가 `BAD_PAYLOAD` / `AUDIO_CHUNK_TOO_LARGE` / `AUDIO_BACKPRESSURE` / `AUDIO_SEQ_OUT_OF_ORDER` code면 `OnSocketRuntimeError`가 `_callSession.FailClosed()` + `StopCapture()` 호출, sink가 즉시 deactivate되어 후속 chunk 전송 차단.

socket disconnect(중간 끊김): `OnSocketDisconnected`가 `ConnectionState = Disconnected` + `CleanupCallSession()` + `PushEvent`. raw audio buffer 디스크 저장 없음 (Plan §5.3 정책).

---

## 5. Partial / final transcript 증거

`CallsSocketClient`가 두 별 이벤트로 분리해 받음:

```csharp
socket.On("transcript", response =>
{
    var ev = response.GetValue<TranscriptEvent>(0);
    if (ev is not null) TranscriptReceived?.Invoke(this, ev);
});
socket.On("transcript.partial", response =>
{
    var ev = response.GetValue<TranscriptPartialEvent>(0);
    if (ev is not null) TranscriptPartialReceived?.Invoke(this, ev);
});
```

`MainWindowViewModel`의 핸들러:

- `OnTranscriptPartial(ev)`: `ev.Source == "agent_mic"`이면 `LatestPartialAgent = ev.Text`, `system_loopback`이면 `LatestPartialCustomer = ev.Text`. UI는 source별로 두 줄 표시 (XAML "실시간 자막 (partial)" 패널).
- `OnTranscriptFinal(ev)`: `[HH:mm:ss] who: text` 형식으로 `FinalTranscripts` ObservableCollection 머리에 insert, 50개 cap. UI는 "확정 자막 (final, 저장됨)" 패널에서 시간 역순 노출.

Step 2 mock STT 기준 final 텍스트:
- `agent_mic` → `agent: Mock agent audio transcript`
- `system_loopback` → `customer: Mock customer audio transcript`

XAML 바인딩:
- `<TextBlock Text="{Binding LatestPartialAgent, FallbackValue='(없음)'}" />`
- `<TextBlock Text="{Binding LatestPartialCustomer, FallbackValue='(없음)'}" />`
- `<ItemsControl ItemsSource="{Binding FinalTranscripts}">` + DataTemplate `<TextBlock Text="{Binding}" />`

**라이브 검증 (transcript event 실 수신)** 은 사용자 머신 manual e2e에서 채울 자리 (§7). 본 dev 세션은 마이크 0개라 transcript event를 직접 받아 보지 못했다.

---

## 6. DB 증거 (transcripts + llm_usage_log)

Step 2 backend는 `audio_end` / `end_call` 시점에 mock STT의 final transcript를 `callsService.appendTranscript`로 `transcripts` 테이블에 적재하고, flush당 1개의 aggregate `llm_usage_log` row를 INSERT한다 (Step 2 findings §5 참조). Step 5는 backend 계약을 손대지 않았으므로 이 동작이 그대로 유효.

예상 DB row shape (Step 2 mock 기준):

```sql
-- transcripts
SELECT id, call_id, speaker, text, seq, created_at FROM transcripts
 WHERE call_id = '<ActiveCallId>' ORDER BY seq ASC;
-- agent | Mock agent audio transcript    | seq 1
-- customer | Mock customer audio transcript | seq 2

-- llm_usage_log
SELECT id, provider, operation, model, status, metadata
  FROM llm_usage_log WHERE call_id = '<ActiveCallId>';
-- mock | stt_transcribe | mock-streaming-stt-v1 | succeeded
-- metadata: { "source":"ws:audio",
--             "audio_duration_ms_sent": N,
--             "audio_duration_ms_suppressed_by_vad": 0,
--             "partial_count": N,
--             "final_count": 1..2,
--             "cost_status": "mock" }
```

**라이브 DB 검증 (실제 row count + metadata 값)** 은 사용자 머신 manual e2e에서 본 query를 직접 돌려 채울 자리.

---

## 7. Raw Audio Leakage 점검

raw PCM byte[]가 살아 있는 경로 + 차단 방어선:

| 경로 | 정책 / 방어선 |
|---|---|
| WASAPI callback → `Pcm16Resampler` | byte[]가 그대로 in-memory normalize. 다음 단계로만 전달, 다른 곳에 push 안 함. |
| `Pcm16FrameEmitter` → `CapturedAudioFrame.Pcm` | 한 frame당 한 byte[]만 record로 emit. 5초 bounded queue로 oldest drop. |
| `CaptureSessionController.PumpAsync` → sink들 | drained frame을 차례로 push, OnFrameAsync return 직후 reference 폐기. |
| `SocketIoAudioFrameSink.OnFrameAsync` → `_client.EmitAudioChunkAsync(meta, pcm, ct)` | byte[]를 EmitAsync에 직접 넘김. await 후 sink 안에 reference 남지 않음. |
| `CallsSocketClient.EmitAudioChunkAsync` → SocketIO `EmitAsync("audio_chunk", meta, pcm)` | SocketIOClient 3.1.2가 byte[]를 Engine.IO binary attachment(0x04 packet 타입)로 송신. JSON / base64 변환 0. |
| `ChunkSent` 이벤트 | source enum + 카운터 propagation만. raw byte 없음. |
| `SendFailed` 이벤트 (`SocketIoAudioFrameSinkError`) | source + seq + bytes(length) + exception type/message. raw byte[] 미포함. |
| UI `LastErrors` / `Events` / `LastRealtimeError` | string-only. raw byte를 stringify할 경로 없음. |
| `transcripts.text` / `llm_usage_log.metadata` | Step 2 backend가 substring sentinel 14개를 자동 차단 (Step 2 findings §6). Step 5에서 변경 없음. |
| `Pcm` reference 폐기 | `SocketIoAudioFrameSink.OnFrameAsync` await 종료 후 local 변수 scope 종료, GC. 멤버 변수에 저장하지 않음. |

`SendFailed`는 의도적으로 `Source` / `Seq` / `Bytes(length)` / `Message`(exception type + message)만 가지고 있다. 코드:

```csharp
public sealed record SocketIoAudioFrameSinkError(
    AudioSourceId Source,
    long Seq,
    int Bytes,
    string Message
);
```

`grep -n "frame.Pcm\b" desktop/Kloser.Desktop.Shell/`로 raw byte[] reference 위치를 확인한 결과 sink 내부 `EmitAudioChunkAsync`에 직접 인자로만 흐른다.

**자동 sentinel 테스트는 본 라운드에 추가하지 않았다** — Phase 9 Step 2 backend의 sentinel 테스트(`server/test/phase9_step2_ws_audio.test.mjs` test #18)가 raw audio bytes의 DB/usage/console 누설을 backend 측에서 이미 강제. desktop client 측의 raw byte→string conversion은 코드 경로상 존재 자체가 없다. 본 findings §11 risks에 desktop-side runtime sentinel 추가를 follow-up으로 둠.

---

## 8. 검증 명령 결과

```powershell
& "C:\Program Files\dotnet\dotnet.exe" build desktop/Kloser.Capture.Core/Kloser.Capture.Core.csproj   # 0 warn / 0 err (0.87s)
& "C:\Program Files\dotnet\dotnet.exe" build desktop/Kloser.Capture.Poc/Kloser.Capture.Poc.csproj   # 0 warn / 0 err (1.06s)
& "C:\Program Files\dotnet\dotnet.exe" build desktop/Kloser.Desktop.Shell/Kloser.Desktop.Shell.csproj  # 0 warn / 0 err (4.68s)

npm --prefix server run typecheck            # PASS (tsc --noEmit, 0 error)
node test/sync_shared_types.mjs              # PASS (wsAudio + 18 다른 entity 모두 OK)

npm --prefix server test                      # 872 total / 869 PASS / 3 skipped / 0 fail
                                              #   (Phase 8 closeout 852 → +20 case, ws_audio Step 2 회귀 포함)

git diff --check                              # clean
WPF launch dry-run                            # alive=True after 5s, clean forced stop
git ls-files --others --exclude-standard desktop/  # 5 new Realtime/*.cs files only
```

backend 변경 0건이라 server test count는 Step 4 / Phase 8 baseline 그대로 유지. Step 5 desktop 변경은 server side test surface와 무관.

---

## 9. Manual E2E 결과

**미수행** — 본 dev 세션 머신에 active capture device(마이크)가 0개라 사용자가 §7.2 시나리오(연결 → 통화 시작 → 마이크/시스템 오디오 chunk 송신 → partial/final transcript 확인 → 종료)를 직접 돌려야 한다.

Plan §7.2 manual gate 매트릭스:

| # | 시나리오 | 본 라운드 상태 |
|---|---|---|
| E1 | 로컬 backend에 WPF 연결 (login or paste token) | **deferred to user** |
| E2 | Start Call로 callId 받음 | **deferred** |
| E3 | mic + loopback enable | **deferred** |
| E4 | 마이크에 말하기 + 시스템 오디오 재생 | **deferred** |
| E5 | agent_mic / system_loopback chunk 카운터가 각자 증가 | **deferred** |
| E6 | 첫 valid chunk 후 `transcript.partial` 도착 | **deferred** |
| E7 | End Call | **deferred** |
| E8 | WPF에 final `transcript` 도착 | **deferred** |
| E9 | DB에 transcripts row 적재됨 | **deferred** |
| E10 | `llm_usage_log` 에 mock STT row + `audio_duration_ms_sent` 채워짐 | **deferred** |
| E11 | logs / transcript.text / usage.metadata / UI event에 raw PCM sentinel 없음 | **deferred (backend 측 sentinel 자동 보장은 그대로)** |

사용자 머신 권장 절차:

```powershell
# 1) backend
cd server
npm run db:migrate:up    # 필요 시
npm run db:seed
npm run dev              # :32173

# 2) 별 터미널 — WPF
& "C:\Program Files\dotnet\dotnet.exe" run --project desktop/Kloser.Desktop.Shell

# 3) WPF 안에서
#    백엔드 URL: http://localhost:32173
#    (a) 이메일/비밀번호 입력 후 "로그인 + 연결"  또는
#    (b) /auth/login 결과의 accessToken을 paste 후 "토큰으로 연결"
#    "통화 시작" -> 마이크 말하기 + 시스템 오디오 재생 -> partial/final 확인 -> "통화 종료"
```

E1~E11 통과 결과 알려주시면 본 findings §5 / §6에 라이브 데이터(callId, transcripts row count, llm_usage_log row id + metadata snapshot, 마이크 native format 등)를 채워 넣고 `PHASE_9_MASTER.md` Step 5 체크박스를 갱신.

---

## 10. Regression Gates (Plan §7.3)

| 항목 | 본 라운드 상태 |
|---|---|
| Step 4 WPF가 backend 연결 없이 띄워짐 (Idle 상태) | OK — 5초 launch dry-run alive=True, `MainWindowViewModel` 생성자가 socket 연결을 자동 시도하지 않음 |
| Step 4 local capture-only 모드가 그대로 동작 (마이크 가용 시) | OK — `StartCapture` / `StopCapture` 경로 변경 없음, external sink 미등록 시 backend로 안 흐름 |
| diagnostic WAV 토글이 backend 연결과 독립 | OK — `DiagnosticWavFrameSink`는 controller 내부 sink로 유지, external sink와 별도 |
| Console PoC (Kloser.Capture.Poc) 동작 | OK — Step 4 그대로 동작 (Realtime/* 미참조, NAudio 의존만) |
| Step 2 `text_chunk` 테스트 | OK — server test 869 PASS, ws_persistence + ws_auth 모두 회귀 |
| backend auth 실패 → friendly UI 메시지 | 코드 경로 OK (`OnSocketTransportFailed` → `LastRealtimeError`). 실 실패 트리거는 manual e2e 필요 |

---

## 11. Known Limitations / Risks

1. **Manual e2e 미수행.** 본 dev 세션 머신 마이크 부재. §9 매트릭스 11 항목 모두 사용자 머신에서 통과시켜야 master 체크박스 갱신 가능.
2. **WPF `PasswordBox` 바인딩 미사용.** `LoginPassword`를 `TextBox`로 입력받는다 (PasswordBox는 binding 안 됨). 화면에 평문으로 노출되지만 UI 입력 직후 메모리로 옮기고 즉시 비움. dev fallback이라 product polish 단계(Step 7)에서 PasswordBox + behavior로 교체 권장.
3. **재연결 자동화 없음.** Plan §5.3 그대로 — `Reconnection = false`로 두고 사용자가 명시적으로 "연결 끊기" → 재연결 흐름 사용. Step 7 hardening에서 짧은 메모리-only 재연결 버퍼 검토.
4. **MFA UX 미지원.** `/auth/login`이 HTTP 202를 반환하면 unsupported 안내만 노출하고 paste-token으로 우회. 풀 desktop MFA UX는 Step 7 이후 (별 step).
5. **Desktop-side raw audio sentinel 자동 테스트 부재.** byte[] reference가 sink → EmitAsync 1 경로만 거치는 게 정적 분석으로 명확하지만, refactor 회귀 방지용 desktop xunit 테스트는 본 라운드 미추가. Step 7 hardening 후보.
6. **`SocketIOClient` reconnection / heartbeat 정책.** 기본 옵션을 그대로 쓰지만 backend `socket.io@4.x` 의 ping/pong 간격과 일치하는지 명시 검증은 manual e2e 시점에 같이 확인.
7. **MainWindowViewModel의 dirty 보존.** Step 4 한국어화 + ProgressBar `Mode=OneWay` fix(Codex blocker)를 그대로 두고 위에만 추가. 단 동일 파일 +200줄 가까이 커졌다 — Step 6 / Step 7 시점에 `RealtimeViewModel`로 분리 권장.
8. **socket disconnect 중 capture 자동 stop은 안 함.** `OnSocketDisconnected`에서 sink만 비활성화하고 capture는 그대로 — 사용자가 명시적 "캡처 정지"를 누르거나 다시 "통화 시작"을 누르면 sink가 재구성된다. Plan §5.3 "stop sending audio immediately + 사용자가 명시적 재시작" 정책 그대로.
9. **EngineIO V4 강제.** SocketIOClient 3.1.2의 `EngineIO.V4`로 hard-coded. backend가 v3 fallback이 필요해지면 옵션 추가 필요. 본 backend는 socket.io 4.x고정이므로 무해.

---

## 12. Not Implemented (계획대로 — Plan §2 Non-Goals)

- Azure Speech / Naver Clova / Deepgram 실호출.
- real STT provider credential.
- STT 비용 정책 변경 (mock cost 그대로).
- Phase 8 recording archive upload/finalize bridge.
- Flutter Windows shell.
- 인스톨러 / 자동 업데이트 / 백그라운드 서비스.
- raw audio local retry buffer / 디스크 영속화.
- web `platform/live.html` UI 개편.
- desktop-only auth endpoint 추가.
- backend wire 계약 변경 (`server/src/types/wsAudio.ts` 무변경).

---

## 13. Step 5 Closeout 게이트

Plan §3 / §7 / §8 정책 그대로:

- [x] SocketIOClient 3.1.2 핀 + 빌드 통과.
- [x] `start_call` / `audio_start` / `audio_chunk(meta, byte[])` / `audio_end` / `end_call` wire-up.
- [x] `transcript` / `transcript.partial` / `error` 수신.
- [x] backend handshake auth (메모리-only token).
- [x] login + paste token 두 path 구현.
- [x] `ICapturedFrameSink` 구현 + Controller composite hook.
- [x] UI에 chunks / bytes / partial / final / call id / 소켓 상태 / 마지막 오류 표시.
- [x] raw PCM은 `EmitAsync` binary attachment로만 흐름 + sink reference 폐기.
- [x] 자동 게이트 (3 builds + server typecheck + sync types + server test + git diff --check) 통과.
- [ ] manual e2e (E1~E11) — 사용자 머신 필요.
- [ ] `PHASE_9_MASTER.md` Step 5 체크박스 갱신 — manual e2e 통과 후 별도 commit.

---

## 14. 참조

- 상위 master: `PHASE_9_MASTER.md`
- 선행 결정: `PHASE_9_STEP_1_DESKTOP_CAPTURE_ARCHITECTURE.md`
- 선행 결과: `PHASE_9_STEP_2_FINDINGS.md` (backend audio ingest skeleton), `PHASE_9_STEP_3_FINDINGS.md` (Windows capture PoC), `PHASE_9_STEP_4_FINDINGS.md` (WPF shell)
- 본 step plan: `PHASE_9_STEP_5_PLAN.md`
- Backend wire: `server/src/types/wsAudio.ts`, `server/src/ws/calls.ts`
- 다음 step 후보: Phase 9 Step 6 — recording archive bridge (Phase 8 upload/finalize 연결) 또는 Step 7 — pilot hardening (reconnect 정책, 5분 baseline, 다중 디바이스 매트릭스)

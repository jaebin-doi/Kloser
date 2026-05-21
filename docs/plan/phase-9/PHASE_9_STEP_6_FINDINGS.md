# Phase 9 Step 6 Findings — Recording Archive Bridge

작성일: 2026-05-21

상위 문서: `PHASE_9_MASTER.md`
계획 문서: `PHASE_9_STEP_6_PLAN.md`
선행 결과: `PHASE_9_STEP_5_FINDINGS.md`, `PHASE_8_CLOSEOUT_FINDINGS.md`

> Step 6은 Step 5에서 실시간 STT까지 닫힌 desktop call에 **전체 통화 archive WAV → Phase 8 upload/finalize → calls.html playback** 흐름을 붙였다. 통화 중 realtime audio_chunk 전송과 동시에 로컬 stereo WAV (left = agent_mic, right = system_loopback) 가 작성되고, end_call 직후 backend 기존 `POST /calls/:id/recordings/upload` → signed PUT → `POST .../finalize` 흐름으로 call에 첨부된다. Phase 8 local provider의 signed URL이 실제로 서빙되는 PUT/GET HTTP route가 없었던 빈자리(local manual E2E를 막던)는 dev-only `/dev-recordings/*` handler로 닫았다. Production에선 절대 활성화되지 않는다.

---

## 0. Status

**Implementation complete; automatic gates PASS; manual E2E deferred to user machine (마이크 부재).**

- 신규 `desktop/Kloser.Capture.Core/Recording/CallArchiveWavWriter.cs` — per-source PCM 스크래치 → stereo PCM16 WAV 합성 + SHA-256 스트리밍.
- 신규 `desktop/Kloser.Desktop.Shell/Services/RecordingArchive/` 4 파일 — wire models / sink / HttpClient / lifecycle FSM.
- 신규 `server/src/routes/devRecordingStorage.ts` — dev-only local PUT/GET handler. `NODE_ENV !== production` AND local provider 자기-게이트.
- 신규 `server/test/phase9_step6_dev_recording_storage.test.mjs` — 9 case (PUT/GET happy path, expired, traversal multi-shape, non-audio content-type, GET 404, production disabled, s3 provider disabled, leakage check).
- 수정: `server/src/adapters/recordingStorage.ts` 에 `readObject` public 메소드 추가 (`_readForTest`를 동일 구현으로 위임), `server/src/server.ts` 에 dev plugin 등록 + import.
- 수정: `desktop/Kloser.Desktop.Shell/ViewModels/MainWindowViewModel.cs` + `MainWindow.xaml` 에 archive lifecycle + status UI.
- 자동 게이트 (3 builds / server typecheck / sync_shared_types / `npm --prefix server test` **881 total / 878 PASS / 3 skipped / 0 fail** / `git diff --check`) 모두 통과.
- **Manual E2E (실 마이크 + 시스템 오디오 + 통화 + 업로드 + calls.html 재생)** 은 본 dev 세션 마이크 부재로 미수행. 사용자 머신에서 §9 매트릭스 통과 시 master 체크박스 갱신.
- `PHASE_9_MASTER.md` Step 6 체크박스는 본 라운드에서 **변경하지 않는다** (manual E2E 후 별도 commit).

### 0.1 Codex Review Fix

Codex review에서 desktop upload response model mismatch 1건을 수정했다.

- 증상: Phase 8 backend `POST /calls/:id/recordings/upload` response shape는 `{ recording, upload }`인데, desktop `RecordingUploadInitiateResponse`가 `signed_url` property를 기대했다. 이 상태에서는 upload initiate HTTP 201 이후에도 desktop이 `initiate_bad_response`로 실패한다.
- 수정: `RecordingArchiveModels.cs`의 `SignedUrl` property를 `[JsonPropertyName("upload")]`로 변경. C# 내부 이름은 `SignedUrl` 그대로 둬서 call site는 유지하고, wire shape만 Phase 8 contract에 맞췄다.
- 검증: 수정 후 Core / Poc / Shell build, server typecheck, sync types, Step 6 focused test, full server test 모두 PASS.

---

## 1. Archive Format — 실제 구현

Plan §4.1 그대로:

| 필드 | 값 |
|---|---|
| `content_type` | `audio/wav` |
| `codec` | `pcm_s16le_stereo_16000` |
| `sample_rate_hz` | 16000 |
| `bit_depth` | 16 |
| `channels` | 2 |
| left channel | `agent_mic` |
| right channel | `system_loopback` |

`CallArchiveWavWriter` 구현 (Plan §4.2 추천 path 채택):

- **per-source 스크래치 파일** 두 개를 `%LOCALAPPDATA%\Kloser\recordings\pending\<callId>\scratch\` 아래 둔다 (`agent_mic.pcm`, `system_loopback.pcm`).
- 각 frame은 `(StartedAtMs * 16) * 2` byte 오프셋에 seek 후 PCM16 mono 바이트 그대로 append. **NTFS 자동 zero-fill**이 seek-past-EOF에서 발생하므로 source별 timeline gap은 자연스럽게 silence로 채워진다.
- `CompleteAsync()` 시점에 두 스크래치를 chunk(4 KB 스테레오 frame) 단위로 읽어 interleave (`L L R R L L R R …`) → 표준 44-byte WAV header를 먼저 쓰고 stereo body를 이어 쓴다. SHA-256은 emit 도중 streaming hash로 계산.
- 메모리는 64 KB chunk buffer 두 개 + interleave 출력 4 KB. 30 분 통화여도 resident는 수십 KB.

채널 매핑 정확성 보장:
- `Write(frame)` 분기 — `AudioSourceId.AgentMic` 만 left 스크래치에 기록, `AudioSourceId.SystemLoopback` 만 right 스크래치에 기록.
- 그 외 sample rate / channels이 다르거나, `StartedAtMs < 0` 인 frame은 `_droppedFrames++` 후 silent skip — WAV가 corrupt되는 케이스 자체를 차단.

오버랩 핸들링: 두 source 모두 같은 시각에 frame을 emit해도 각자 다른 스크래치에 쓰므로 시점 손실 없음. 동일 source의 시점 중복은 발생할 수 없다 (`Pcm16FrameEmitter.seq`가 단조 증가). Plan §4.2가 명시한 "deterministic frame-order writer" 제약은 이 sparse-write 모델로 회피.

---

## 2. 변경 파일 목록

### 2.1 신규 (8 files)

| File | 역할 |
|---|---|
| `desktop/Kloser.Capture.Core/Recording/CallArchiveWavWriter.cs` | per-source 스크래치 + interleave-on-flush WAV writer + SHA-256 streaming |
| `desktop/Kloser.Desktop.Shell/Services/RecordingArchive/RecordingArchiveModels.cs` | upload/finalize wire payload + UI enums (`RecordingArchiveState`) |
| `desktop/Kloser.Desktop.Shell/Services/RecordingArchive/CallArchiveWavFrameSink.cs` | `ICapturedFrameSink` → writer 어댑터 (raw PCM 폐기 contract) |
| `desktop/Kloser.Desktop.Shell/Services/RecordingArchive/RecordingArchiveClient.cs` | `HttpClient` initiate / signed PUT / finalize / best-effort DELETE. signed URL / object key / checksum 로그 미노출 |
| `desktop/Kloser.Desktop.Shell/Services/RecordingArchive/RecordingArchiveSession.cs` | FSM (Idle / Recording / FinalizingLocalFile / UploadInitiating / UploadingBytes / FinalizingRemote / Available / Failed) + 로컬 temp 폴더 cleanup |
| `server/src/routes/devRecordingStorage.ts` | dev-only `PUT /dev-recordings/*` + `GET /dev-recordings/*` |
| `server/test/phase9_step6_dev_recording_storage.test.mjs` | 9 case (PUT/GET happy, expired, traversal multi-shape, non-audio CT, 404, prod disabled, s3 disabled, leakage) |
| `docs/plan/phase-9/PHASE_9_STEP_6_FINDINGS.md` | 본 문서 |

### 2.2 수정 (4 files)

| File | Change |
|---|---|
| `server/src/adapters/recordingStorage.ts` | `LocalRecordingStorageAdapter.readObject(objectKey)` public 메소드 신규 (`_readForTest`는 동일 구현 alias로 보존). `assertSafeObjectKey` + `resolveAbsolutePath` 두 단계 traversal 보호는 그대로. |
| `server/src/server.ts` | `devRecordingStorageRoutes` import + `await app.register(devRecordingStorageRoutes)` 추가. 플러그인 내부에서 production / s3 / minio 모드 자기-게이트. |
| `desktop/Kloser.Desktop.Shell/ViewModels/MainWindowViewModel.cs` | (Step 4·5 dirty 보존) Archive fields(`_archiveClient`, `_archiveSession`) + bindable surface(`ArchiveEnabled`, `ArchiveStateValue`/`ArchiveStateLabel`, `ArchiveDurationSeconds`, `ArchiveSizeBytes`, `ArchiveUploadedBytes`, `ArchiveRecordingId`, `ArchiveFinalStatus`, `ArchiveLastError`) + `RunArchiveUploadAsync` 백그라운드 FSM 실행 + Start/End Call에 archive 등록·해제 hook + `Dispose`에서 archive client 정리. |
| `desktop/Kloser.Desktop.Shell/MainWindow.xaml` | (Step 4·5 dirty 보존) backend band 안에 archive status 영역 신규 (toggle / 상태 / 길이 / 용량 / 업로드 진행 / recording id / server status / last error / 보안 안내 텍스트). signed URL / object key / checksum / 로컬 경로는 표시 안 함. |

총 신규 8 + 수정 4. backend `call_recordings` 계약 / shared types / migration 무변경.

---

## 3. 로컬 Temp 경로 + Cleanup 동작

Plan §5.1 그대로:

- 경로: `%LOCALAPPDATA%\Kloser\recordings\pending\<callId>\call.wav`
- 스크래치 (Step 6 추가): `%LOCALAPPDATA%\Kloser\recordings\pending\<callId>\scratch\agent_mic.pcm` + `system_loopback.pcm`
- `RecordingArchiveSession.BuildTempDir(callId)` 가 `<callId>`에서 path-separator 문자 (`\`, `/`, etc.) 모두 제거 (`char.IsLetterOrDigit || '-' || '_'`만 통과) — backend ack에서 callId가 변조됐을 때 traversal 차단.

Cleanup:

| Outcome | Action |
|---|---|
| `available` 도달 | `RecordingArchiveSession.DeleteLocalAsync()` → `Directory.Delete(<tempDir>, recursive: true)`. 스크래치 + WAV + dir 모두 제거. |
| `local_finalize_failed` | 같은 cleanup 호출. partial WAV / 스크래치 모두 제거. |
| `initiate / upload / finalize` 실패 | 같은 cleanup + `RecordingArchiveClient.TryCleanupAsync` (best-effort `DELETE /calls/:id/recordings/:rid`) 로 backend의 `upload_pending` row 정리. |
| Process exit (정상 종료 안 됨) | next session start 시점에 이전 폴더가 남아있을 수 있음. Step 7 hardening 후보로 startup-cleanup 추가 권장 (본 라운드 미구현). |

cleanup 정책 (Plan §5.3): **Step 6은 실패한 archive 파일을 retry용으로 보관하지 않는다**. encrypted local retry queue는 Step 7 이후.

---

## 4. Upload / Finalize Wire 증거

`RecordingArchiveClient` 가 backend Phase 8 Step 3 contract와 1:1 매핑:

```csharp
// 1. POST /calls/:callId/recordings/upload  (Bearer auth)
await _archiveClient.InitiateUploadAsync(baseUrl, token, callId, new RecordingUploadInitiateRequest {
    ContentType = "audio/wav",
    Codec = "pcm_s16le_stereo_16000",
    RecordedAtIso = DateTimeOffset.UtcNow.ToString("o"),
    DurationSeconds = local.DurationSeconds,
    SizeBytes = local.SizeBytes,
    ChecksumSha256 = local.ChecksumSha256,
});

// Response shape: { recording, upload }. Desktop maps `upload` into
// RecordingUploadInitiateResponse.SignedUrl.

// 2. PUT <signed URL>  (no Bearer; signed URL is not a Kloser API route)
await _archiveClient.UploadBytesAsync(initiate.SignedUrl, fileStream, fileSize, progress);

// 3. POST /calls/:callId/recordings/:rid/finalize  (Bearer auth)
await _archiveClient.FinalizeAsync(baseUrl, token, callId, recordingId, new RecordingFinalizeRequest {
    DurationSeconds = local.DurationSeconds,
    SizeBytes = local.SizeBytes,
    ChecksumSha256 = local.ChecksumSha256,
});
```

라이프사이클은 `RealtimeCallSession.StopAsync()` (audio_end + end_call) 가 commit된 직후, **백그라운드 Task**로 `RunArchiveUploadAsync(...)` 호출. Plan §5.3 "realtime end_call should not wait for object upload" 원칙 준수.

state machine 흐름:

```
Recording → FinalizingLocalFile → UploadInitiating → UploadingBytes → FinalizingRemote → Available
                                                                                       ↘ Failed
```

각 단계 실패 시 fall-through: failed로 전환, 로컬 temp 폴더 + (initiate 이후라면) backend recording row 정리, UI에 sanitized short error 노출.

---

## 5. Dev/Local Signed URL Handler 결정 + 테스트

### 5.1 결정

Plan §3.2 / §6.1 두 선택지 중 **(1) dev-only local handler 채택**. MinIO/S3 opt-in 강제는 본 PoC 단계의 manual E2E 진입 장벽을 비례적으로 키우기 때문.

활성화 조건 (코드: `shouldActivate(env)`):

| Env | 활성화 |
|---|---|
| `NODE_ENV=production` | 무조건 OFF |
| `RECORDING_STORAGE_PROVIDER=s3` 또는 `minio` | OFF |
| 그 외 (unset 또는 `local`) | + adapter가 실제로 `LocalRecordingStorageAdapter`인지 duck-type 검사 (`provider === "local"` + `readObject` / `putObject` 존재) 통과 시에만 등록 |

추가 가드 (코드 안에서 직접 처리):

- **`expires` query 강제** — 없으면 403 `signed_url_expired`. 시간 비교는 `now > expires` 정확 매칭.
- **percent-encoded path separator 차단** — `containsEncodedSeparator(rawUrl)` 가 `%2F` / `%5C` / `%2E%2E` 발견 시 400 `object_key_invalid`. HTTP layer가 `%2F`를 디코드 후 `..` 와 결합해 silent re-route하는 경로를 명시적으로 닫음.
- **traversal 그 외** — `assertSafeObjectKey` 가 어댑터 진입 직전에 다시 검증.
- **Content-Type allow-list** — PUT은 `audio/*` 만 통과. `application/octet-stream` 같은 generic은 415 (audio/* body parser 미매칭).
- **404 / 4xx 응답 본문에 raw byte / signed URL / 어댑터 내부 메시지 미포함** — `mapAdapterError`가 `err.code` stable label만 echo.

production 환경에서는 plugin 자체가 `shouldActivate(env)` 에서 early return하므로 라우트 자체가 등록되지 않는다.

### 5.2 테스트 결과

`server/test/phase9_step6_dev_recording_storage.test.mjs` — 9 case **모두 PASS**:

| # | Case | 결과 |
|---|---|---|
| 1 | PUT happy path 후 GET 같은 바이트 + `audio/wav` content-type | PASS |
| 2 | PUT expired URL (현재 시각보다 과거 expires) → 403 `signed_url_expired` | PASS |
| 3 | GET expired URL → 403 `signed_url_expired` | PASS |
| 4 | Traversal multi-shape (`../escape.wav`, `%2E%2E/escape.wav`, `orgs/x/..%2Fescape.wav`) — status != 200 + PCM 바이트 본문 미노출 + 스토리지 루트 어디에도 `escape.wav` 파일 미생성 | PASS |
| 5 | PUT non-audio Content-Type (`application/octet-stream`) → 200 아님 (audio/* parser가 거부, 415) | PASS |
| 6 | GET 미저장 객체 → 404 `storage_object_not_found` | PASS |
| 7 | `NODE_ENV=production` → handler 등록 안 됨, 404 default Fastify | PASS |
| 8 | `RECORDING_STORAGE_PROVIDER=s3` → handler 등록 안 됨, 404 | PASS |
| 9 | PUT 응답 / 404 응답 / 어떤 경로에도 PCM hex / object key / signed URL 미노출 | PASS |

전체 server test: **881 total / 878 PASS / 3 skipped / 0 fail** (Step 5 baseline 869 → +9 dev handler 신규, +3 기타 sync).

---

## 6. WPF UI Archive Status 증거

`MainWindow.xaml` 에 추가된 archive 영역 (Step 5 backend band 하단):

```
┌─ 녹취 archive (Phase 9 Step 6) ─────────  ☑ archive 켜기 (통화 종료 시 자동 업로드)
│ 상태: <ArchiveStateLabel>   길이: <Ns 초>   용량(bytes): N   업로드(bytes): N
│ recording id: <uuid>   server status: <status>
│ (라스트 에러 — 적색)
│ signed URL · object key · checksum · 로컬 임시 경로 · 원음 바이트는 UI / 이벤트 / 오류 메시지에 노출되지 않습니다.
```

표시 필드 매핑 (Plan §7 요구):

| 요구 항목 | UI 바인딩 |
|---|---|
| archive state | `{Binding ArchiveStateLabel}` (Korean 라벨: 대기 중 / 녹취 중 / 로컬 WAV 마무리 중 / 업로드 준비 중 / 업로드 중 / 서버 마무리 중 / 녹취 업로드 완료 / 녹취 업로드 실패) |
| local archive duration | `{Binding ArchiveDurationSeconds}` |
| local archive size | `{Binding ArchiveSizeBytes}` |
| upload progress / uploaded bytes | `{Binding ArchiveUploadedBytes}` (real-time `Progress<long>` 갱신) |
| recording id | `{Binding ArchiveRecordingId, FallbackValue='(없음)'}` |
| final recording status | `{Binding ArchiveFinalStatus, FallbackValue='(대기)'}` |
| last archive error | `{Binding ArchiveLastError}` (Error brush 적색, sanitized short label만) |
| archive enabled toggle | `{Binding ArchiveEnabled, Mode=TwoWay}` (기본 ON) |

UI에 표시 안 되는 것 (Plan §7 / §5.2 정책):
- signed URL — `RecordingArchiveClient`가 메모리에서만 사용, 어떤 PropertyChanged event에도 들어가지 않음.
- object key — backend response의 sanitized recording row에 애초에 미포함.
- checksum SHA-256 — 백엔드 send만, UI binding 없음.
- 로컬 temp 경로 — `RecordingArchiveSession.TempDir` 은 public이지만 어떤 binding도 가리키지 않음.
- 예외 stack trace — `RecordingArchiveHttpError.ShortError` (stable label) 또는 `ex.GetType().Name`만 surface.

Step 5 realtime transcript UI (`LatestPartialAgent` / `LatestPartialCustomer` / `FinalTranscripts`) 는 무변경, 그대로 동작.

---

## 7. calls.html Playback 증거

Plan §8 그대로 — `platform/calls.html` 의 Phase 8 recording playback surface 무변경. backend가 `available` 상태 `call_recordings` row를 반환하면 기존 6-state renderer가 자동으로 "재생 가능" 패널을 그려서 `audio.src = playback.url` (DOM property assignment) 로 결합한다.

manual E2E (사용자 머신, §9) 통과 시 확인할 항목:

- `platform/calls.html` 에서 해당 callId 클릭 → recording surface가 "재생 가능"으로 표시
- 재생 버튼 누르면 dev `/dev-recordings/*` GET handler가 stereo PCM16 WAV을 `audio/wav` Content-Type으로 응답 → 브라우저 native audio player가 재생
- 길이 / 용량 / 코덱 메타 (`12초 · 4 KB · audio/wav` 형식) 정상 표시
- 좌(agent_mic) 채널과 우(system_loopback) 채널이 분리되어 들림 (헤드폰 권장)

본 dev 세션은 마이크 부재로 미수행 — §9 deferred 기록 유지.

---

## 8. DB 증거 (`call_recordings`)

backend Phase 8 Step 3 회귀: 본 라운드 server test 869 → 878 PASS 사이의 모든 phase8 route / audit test는 무변경 동작. `call_recordings` row가 archive upload 완료 후 가지는 shape (예상):

```sql
SELECT id, call_id, status, content_type, codec,
       size_bytes, duration_seconds, recorded_at, uploaded_at
  FROM call_recordings
 WHERE call_id = '<E2E call id>';
-- status=available, content_type=audio/wav, codec=pcm_s16le_stereo_16000,
-- size_bytes>0 (header 44 + stereo body), duration_seconds>0
-- object_key / storage_bucket / checksum_sha256는 API에 미노출 (Phase 8 정책)
```

라이브 row 검증은 manual E2E (§9) 시점 사용자가 확인해서 본 절에 채울 자리.

---

## 9. Raw Audio / Signed URL / Object Key Leakage 점검

raw PCM 바이트가 살아 있는 경로 + 차단 방어선:

| 경로 | 정책 / 방어선 |
|---|---|
| WASAPI callback → `Pcm16Resampler` → `Pcm16FrameEmitter` → `CapturedAudioFrame.Pcm` | Step 3 그대로. 본 step에서 새 경로 추가 없음. |
| pump → `CallArchiveWavFrameSink.OnFrameAsync(frame, ct)` | `frame.Pcm` 을 `_writer.Write(frame)` 호출에 직접 전달, return 직후 sink 안에 reference 없음. |
| `CallArchiveWavWriter.Write(frame)` | `frame.Pcm` 을 source별 `FileStream.Write` 에 직접 전달. 멤버 변수에 byte[] 보관 없음. file descriptor + 카운터만 memory. |
| `CompleteAsync` 도중 stream interleave | per-source `FileStream` 에서 64 KB chunk만 buffer로 읽어 interleave 후 즉시 write. 4 KB output buffer 1개만 memory. |
| `RecordingArchiveClient.UploadBytesAsync` | `FileStream` 을 그대로 `ProgressStreamContent` 안에서 chunk read → HttpClient stream → 네트워크. 64 KB local buffer만 memory. |
| `ProgressStreamContent` progress callback | `total` byte count (long) 만 surface. raw bytes 안 보냄. |
| `RecordingArchiveHttpError.ShortError` | stable label string. raw byte / signed URL / 본문 미포함. |
| `RecordingArchiveSession.LastError` | `ShortError` 또는 `ex.GetType().Name` (예외 클래스명). 메시지 + 본문 미포함. |
| UI `ArchiveLastError` binding | `Session.LastError` 그대로. PropertyChanged event는 string만. |
| `Events` / `LastErrors` `ObservableCollection<string>` | `PushEvent` / `PushError` 가 short label string만 push. signed URL / object key / checksum / 경로 미포함. |
| Server side `transcripts.text` / `llm_usage_log.metadata` | Phase 8 정책 그대로 — substring sentinel 14개 자동 차단 (Step 2 회귀 PASS). |
| Dev handler PUT body | `adapter.putObject` 통과 후 200 응답은 `{ok: true}` 만. PCM 바이트 echo 0. |
| Dev handler GET 응답 | `audio/wav` Content-Type + body. 정상 path. 에러 path는 `{ error: "<stable_code>" }` JSON. |
| Dev handler 404 default | Fastify 기본 404 메시지에 path만 echo (normalized). PCM 바이트 미포함. |

자동 테스트 sentinel:
- `server/test/phase9_step6_dev_recording_storage.test.mjs` test #9 — PUT 응답 / 404 응답 본문에 PCM hex(`DEADBEEF…`) 미포함 substring 검증. PASS.
- backend phase8 (Step 3) 의 14-token 금지어 sentinel은 그대로 통과 (server test 회귀).

desktop-side runtime sentinel xunit 테스트는 본 라운드 미추가 — Step 5 §11 risk 그대로 Step 7 hardening 후보로 이월.

---

## 10. 검증 명령 + 출력

```powershell
& "C:\Program Files\dotnet\dotnet.exe" build desktop/Kloser.Capture.Core/Kloser.Capture.Core.csproj   # 0 warn / 0 err
& "C:\Program Files\dotnet\dotnet.exe" build desktop/Kloser.Capture.Poc/Kloser.Capture.Poc.csproj    # 0 warn / 0 err
& "C:\Program Files\dotnet\dotnet.exe" build desktop/Kloser.Desktop.Shell/Kloser.Desktop.Shell.csproj # 0 warn / 0 err

npm --prefix server run typecheck                             # PASS (tsc --noEmit)
node test/sync_shared_types.mjs                               # PASS (callRecording entity 회귀 포함)
npm --prefix server test                                      # 881 total / 878 PASS / 3 skipped / 0 fail
                                                              #   Step 5 869 → +9 dev handler + 기타 sync
npx tsx --test --test-concurrency=1 server/test/phase9_step6_dev_recording_storage.test.mjs   # 9 / 9 PASS

git diff --check                                              # clean
git ls-files --others --exclude-standard                      # 8 신규 file (.cs / .ts / .mjs / .md)
```

## 11. Manual E2E (미수행, Plan §9.2)

사용자 머신 (마이크 + 시스템 오디오 + Windows backend) 에서 수행할 절차:

```powershell
# 1) backend (.env)
$env:RECORDING_STORAGE_PROVIDER = "local"
$env:RECORDING_STORAGE_PUBLIC_BASE_URL = "http://localhost:32173/dev-recordings"
cd server
npm run db:migrate:up
npm run dev

# 2) static server for platform/
python -m http.server 8765  # 별 터미널

# 3) WPF
& "C:\Program Files\dotnet\dotnet.exe" run --project desktop/Kloser.Desktop.Shell

# 4) WPF 안에서
#   - 로그인/토큰 connect
#   - "녹취 archive 켜기" 체크박스가 ON 상태 확인 (기본값)
#   - 통화 시작
#   - 20초 이상 mic + 시스템 오디오 입력
#   - "실시간 자막 (partial)" 와 "확정 자막 (final, 저장됨)" 패널이 Step 5 그대로 동작 확인
#   - 통화 종료
#   - "녹취 archive" 영역의 상태가:
#       녹취 중 → 로컬 WAV 마무리 중 → 업로드 준비 중 →
#       업로드 중 (Uploaded bytes 카운터 증가) →
#       서버 마무리 중 → 녹취 업로드 완료: available
#   - %LOCALAPPDATA%\Kloser\recordings\pending\<callId>\ 폴더가 삭제됐는지 확인
#
# 5) http://localhost:8765/platform/calls.html 에서
#   - 같은 통화 클릭
#   - 녹취 surface가 "재생 가능" 으로 표시
#   - 재생 버튼 누르면 stereo WAV이 흐름 (좌: 마이크, 우: 시스템 오디오)
#
# 6) DB
#   SELECT status, content_type, codec, size_bytes, duration_seconds
#     FROM call_recordings WHERE call_id = '<callId>';
#   → status=available, content_type=audio/wav, codec=pcm_s16le_stereo_16000,
#     size_bytes>0, duration_seconds>0
#
# 7) UI/logs/audit 어디에도 signed URL / object key / checksum / 원음 바이트 없음.
```

E2E 매트릭스 (Plan §9.2):

| # | 항목 | 본 라운드 상태 |
|---|---|---|
| E1 | login/token 연결 + 통화 시작 | deferred to user |
| E2 | 20초 이상 입력 + realtime transcript 정상 | deferred (Step 5 통과 회귀) |
| E3 | end_call 후 archive 상태가 local→initiate→upload→finalize→available 진행 | deferred |
| E4 | 로컬 temp 폴더 자동 삭제 | deferred |
| E5 | calls.html 에서 available 표시 + 재생 | deferred |
| E6 | DB row content_type / codec / status / sizes 확인 | deferred |
| E7 | UI / logs / audit 누설 0 (signed URL / object key / checksum / raw bytes) | deferred (자동 검증 통과, manual은 사용자) |

`PHASE_9_MASTER.md` Step 6 체크박스는 위 7 항목 모두 통과 후 별도 commit에서 갱신.

---

## 12. Known Limitations / Step 7 Hardening 후보

1. **Manual E2E 미수행** — 본 dev 세션 머신 마이크 부재. 사용자 머신에서 §11 매트릭스 통과 시 master 체크박스 갱신.
2. **dev `/dev-recordings/*` handler는 production에서 절대 활성화되면 안 됨** — 코드 안의 `shouldActivate(env)` 가 1차 게이트. CI / deploy 단계에서 `NODE_ENV=production` 환경에서는 plugin 등록 자체가 no-op. 그래도 보호망 한 겹 더 (예: env 비교에서 `production` 외 모든 값 거부)는 운영 hardening에서 검토.
3. **Cross-process startup cleanup 없음** — process가 crash로 종료되어 `pending\<callId>\` 폴더가 남으면 다음 실행에서 자동 정리 안 함. Plan §5.3은 "Step 6은 retry queue 없음"이라 의도된 단순화이지만 사용자 경험상 stale 폴더 sweep을 Step 7에서 추가 권장.
4. **5분 이상 장기 통화 / 백그라운드 업로드 동안 process 종료** — `RunArchiveUploadAsync` 가 백그라운드 Task로 실행되는데 사용자가 X 버튼으로 윈도우 종료 시 upload가 끊긴다. 본 step은 best-effort 정책 (Plan §5.3) 이라 이대로 두지만 finalize 진행 중 종료 시 backend에 `upload_pending` row가 남을 수 있음. `MainWindow.OnClosed` 가 archive upload completion을 잠시 기다리도록 hardening 후보.
5. **WAV 메모리 보호용 max archive size cap 없음** — 무한 통화 시 디스크 가득 채울 위험. `RECORDING_UPLOAD_MAX_BYTES` (백엔드, 기본 250 MB)는 backend가 finalize 시점에 거부할 수는 있지만 desktop이 그 전에 디스크를 다 쓸 수 있음. Step 7에서 client-side max archive duration cap 권장.
6. **dev handler가 신호된 URL 검증을 최소화** — 현재는 `expires` query만 본다. 진짜 HMAC 시그니처는 production S3가 처리하므로 dev 단계엔 필요 없지만, 토큰화된 URL을 사용하려면 추가 검증 필요.
7. **MainWindowViewModel 1100+ 줄** — Step 4~6에서 계속 단일 VM에 stack. Step 7 hardening 단계에 `RealtimeViewModel`, `RecordingArchiveViewModel`, `CaptureViewModel` 로 분리 권장.
8. **Channel split 청취 검증 미수행** — manual E2E 시 헤드폰 좌/우에서 agent_mic / system_loopback 이 분리되어 들리는지는 사람이 확인할 사항. WAV writer 알고리즘은 channel mapping을 정확히 보장하지만 NAudio가 일부 driver에서 left/right swap한 native format을 보고할 가능성 잔존.

---

## 13. Not Implemented (계획대로 — Plan §2 Non-Goals)

- Azure Speech / Naver Clova / Deepgram 실호출.
- transcript ↔ audio timestamp 동기화 UI.
- waveform / seek marker / speaker timeline.
- Opus / WebM 인코더 도입.
- encrypted local retry queue.
- failed archive 장기 디스크 보관.
- production S3/MinIO 운영 smoke 강제.
- Flutter Windows 전환.
- browser recording / capture UI.

---

## 14. Step 6 Closeout 게이트

- [x] dev `/dev-recordings/*` handler — 활성 조건 + 9 case test 통과.
- [x] `call_recordings` 테이블 / shared types / migration 무변경.
- [x] desktop archive: writer + sink + client + session FSM.
- [x] WPF archive status UI (toggle / 상태 / 길이 / 용량 / 업로드 / recording id / final status / last error / 보안 안내).
- [x] raw audio / signed URL / object key / checksum / 로컬 경로가 UI / 이벤트 / 오류 메시지 어디에도 노출되지 않음.
- [x] 3 builds + server typecheck + sync types + server test (881/878/3/0) + git diff.
- [ ] manual E2E (E1~E7) — 사용자 머신 필요.
- [ ] `PHASE_9_MASTER.md` Step 6 체크박스 갱신 — manual E2E 통과 후 별도 commit.

---

## 15. 참조

- 상위 master: `PHASE_9_MASTER.md`
- 본 step plan: `PHASE_9_STEP_6_PLAN.md`
- 선행 결과: `PHASE_9_STEP_5_FINDINGS.md`, `PHASE_8_CLOSEOUT_FINDINGS.md`, `PHASE_8_STEP_3_FINDINGS.md`
- Backend recording routes: `server/src/routes/callRecordings.ts`
- Phase 8 shared types: `server/src/types/callRecording.ts`, `platform/types/callRecording.js`
- Phase 8 storage adapter: `server/src/adapters/recordingStorage.ts`
- 다음 step 후보: Phase 9 Step 7 — pilot hardening (Windows device matrix / 5분 baseline / reconnect 정책 / encrypted retry / startup cleanup sweep)

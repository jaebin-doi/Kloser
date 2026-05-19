# Phase 9 Step 2 Findings — Backend Audio Ingest Skeleton

작성일: 2026-05-19

상위 문서: `PHASE_9_MASTER.md`
계획 문서: `PHASE_9_STEP_2_PLAN.md`
선행 결정: `PHASE_9_STEP_1_DESKTOP_CAPTURE_ARCHITECTURE.md`

---

## 1. 결과 요약

Phase 9 Step 2는 `/calls` Socket.io namespace에 audio ingest skeleton을 연결했다. mock streaming STT가 도착한 chunk를 metadata로 계산해 final transcript를 기존 transcript persistence 경로로 적재하고, flush당 1개의 aggregate `llm_usage_log` row를 남긴다. Azure 실 provider 호출, Windows desktop app, browser MediaRecorder UI, Phase 8 recording archive bridge는 의도적으로 손대지 않았다.

신규 코드:

- `server/src/types/wsAudio.ts` — zod source-of-truth (4 sync target types + literal helpers + runtime error code union).
- `platform/types/wsAudio.js` — JSDoc browser mirror (desktop/browser client 미존재 시점부터 contract drift 차단).
- `server/src/adapters/stt/streaming.ts` — streaming STT 인터페이스만. Azure 적용 시 같은 shape으로 교체.
- `server/src/adapters/stt/mockStreaming.ts` — deterministic mock provider + 세션. 첫 chunk에서 partial 1회, flush에서 per-source final 1개. PCM Buffer reference는 acceptChunk 종료 즉시 drop.
- `server/test/phase9_step2_ws_audio.test.mjs` — 20 test (lifecycle 4 + validation 5 + limit/seq/backpressure 4 + happy path/call_not_found/end_call flush/idempotency 4 + text+audio coexistence 1 + raw audio sentinel 1 + no-op 1).

수정:

- `server/src/ws/calls.ts` — CallContext에 `audio: AudioSessionState | null` 추가, `clearCall`이 audio 상태도 정리, `start_call`이 `audio: null`로 초기화. 3개 신규 핸들러(`audio_start` / `audio_chunk` / `audio_end`) + `flushAudioSession` 코디네이터 + `end_call`이 flush-before-end로 augment.
- `test/sync_shared_types.mjs` — `wsAudio` registry entry 추가 (AudioStart / AudioChunkMeta / AudioEnd / AudioPartialTranscript).

문서:

- `docs/plan/phase-9/PHASE_9_STEP_2_FINDINGS.md` (본 문서).
- `docs/plan/phase-9/PHASE_9_MASTER.md` Step 2 체크박스는 Codex 검토와 전체 검증 통과 후 갱신 완료.

기존 Phase 8 마이그레이션 / repository / route / frontend / retention 동작은 무변경. `llm_usage_log` 스키마(Phase 6 Step 1)도 변경 없음 — `provider='mock'`, `operation='stt_transcribe'`는 이미 CHECK allow-list에 포함.

---

## 2. Event Contract

Plan §3.2 / §5 그대로 구현. 클라이언트 → 서버 3종 + 서버 → 클라이언트 1종 새 event.

| Event | 방향 | 페이로드 | 비고 |
|---|---|---|---|
| `audio_start` | C→S | `AudioStart` (sources / codec / sample_rate_hz / channels / frame_ms / app_version / device_id?) | 활성 call 안에서 1회만 |
| `audio_chunk` | C→S | `AudioChunkMeta` + `Buffer` (binary attachment) | per-source seq 단조 증가 강제 |
| `audio_end` | C→S | `AudioEnd { reason? }` | flush + close |
| `transcript.partial` | S→C | `AudioPartialTranscript` | persist 없음, live emit only |
| `transcript` (기존) | S→C | 기존 shape 그대로 | mock final도 같은 channel 사용 |

`AudioRuntimeErrorCode` 9종(`no_active_call` / `no_active_audio` / `audio_already_started` / `BAD_PAYLOAD` / `AUDIO_CHUNK_TOO_LARGE` / `AUDIO_BACKPRESSURE` / `AUDIO_SEQ_OUT_OF_ORDER` / `call_not_found` / `persistence_failed`)은 wsAudio.ts에 TS union으로 중앙화. 클라이언트는 `socket.on("error", e => switch(e.code))`로 분기.

`org_id` 신뢰 정책: 클라이언트가 보내는 `org_id` 또는 `call_id`는 모두 무시. 모든 DB write는 `socket.data.user.orgId` + `app.withOrgContext`만 사용. `AudioStart.call_id`는 optional + 서버 active call context가 항상 승리 (Plan §3.2).

---

## 3. Session Lifecycle (Plan §5 매핑)

| Plan 조항 | 구현 위치 | 결과 |
|---|---|---|
| §5.1 audio_start before start_call | ws/calls.ts `audio_start` 핸들러 첫 가드 | `error.code = no_active_call` |
| §5.2 audio_chunk before audio_start | `audio_chunk` 핸들러 두 번째 가드 | `error.code = no_active_audio` |
| §5.3 Duplicate audio_start | `audio_start` 핸들러 두 번째 가드 | `error.code = audio_already_started` (silent replace 없음) |
| §5.4 audio_end | `flushAudioSession` → per-source flush + 1개 aggregate usage | session closed, 후속 chunk는 §5.2로 재진입 |
| §5.5 end_call while audio open | `end_call` 핸들러가 `flushAudioSession`을 `callsService.endCall` 전에 호출 | flush 실패 시 `persistence_failed` ack + clearCall |
| §5.6 text + audio 혼용 | 두 핸들러 독립적, 둘 다 `appendTranscript` 통과 | 테스트 12로 회귀 보장 |
| §5.7 Frame duration | `AudioChunkMeta.duration_ms`는 `1..500` zod check, `frame_ms`와 동등성 강제 없음 | jitter 허용 |
| §5.8 Source membership | `audio_chunk` 핸들러 — `audio.sources.includes(m.source)` 확인 | `BAD_PAYLOAD` |
| §5.9 Flush idempotency | `AudioSessionState.flushed` 플래그 → `flushAudioSession` 첫 줄에서 short-circuit + 세션 자체도 내부 idempotency 가짐 | 테스트 11로 회귀 보장 |
| §5.10 Backpressure | rolling `queuedBytes` 누적 + linear time-decay (1s window) | `AUDIO_BACKPRESSURE` (drop-oldest 아님) |
| §5.11 Chunk sequence | `lastSeqBySource` per-source 추적, dup/decrease는 `AUDIO_SEQ_OUT_OF_ORDER`, gap 허용 | 테스트 11/12 — 일부러 gap 테스트는 happy path가 암시 |

`disconnect` 핸들러는 변경 없음 — `clearCall`이 audio 상태도 함께 정리하므로, 중간 단절 시점에 DB에 final transcript / usage row가 적재되지 않을 수 있다(의도된 부분 진행, Phase 7 retention 정책과 같은 trade-off).

---

## 4. Persistence Contract

`callsService.appendTranscript(app, orgId, callId, { speaker, text })` 기존 시그니처 그대로 재사용. 새로운 transcripts repository 경로 만들지 않음.

- `agent_mic` → speaker `"agent"`
- `system_loopback` → speaker `"customer"`
- mock final text는 deterministic:
  - `Mock agent audio transcript`
  - `Mock customer audio transcript`
- `appendTranscript`가 `null`을 반환하면(call vanished mid-stream) `call_not_found`를 표면화한다. 사용량 row는 그래도 남겨 audio-duration accounting trail을 보존한다.

DB-측 `transcripts.seq`는 기존 single-call seq 단조 증가 가드가 그대로 적용(Phase 4 패턴). `audio_chunk.seq`는 client framing metadata일 뿐 persisted seq와 무관.

---

## 5. Usage Logging (Plan §8)

`flushAudioSession`이 per-flush 1개의 aggregate `llm_usage_log` row를 INSERT한다 (Plan §8 "one row per audio session flush" 그대로). 0개 source가 chunk를 받았어도 row를 남기는 idempotent 정책 — usage path를 dead로 만들지 않기 위함.

Row shape:

```ts
{
  provider: "mock",
  operation: "stt_transcribe",
  model: "mock-streaming-stt-v1",
  status: "succeeded",
  tokensIn: null, tokensOut: null,
  latencyMs: null, costUsdMicros: null,
  metadata: {
    source: "ws:audio",
    audio_duration_ms_sent: <sum across sources>,
    audio_duration_ms_suppressed_by_vad: 0,
    partial_count: <sum>,
    final_count: <sum, 0..2>,
    cost_status: "mock"
  }
}
```

Phase 7 Step 5 pricing 결정과 정합: STT 비용은 audio-duration 기반, token 기반이 아니다. Azure adapter 교체 시 schema migration 없이 `costUsdMicros`만 계산해 채우면 된다.

빌링 캡 영향:

- `monthly_calls` 캡은 기존 `start_call` 경로에서만 평가. `audio_start`는 신규 호출을 만들지 않으므로 캡 재평가 없음.
- `monthly_llm_cost` 캡은 soft + mock 비용이 null/0이므로 Step 2에서는 reject 발생 없음.

---

## 6. Raw Audio Leak 정책 (Plan §9)

PCM Buffer는 다음 경계에서만 살아 있다.

1. `socket.on("audio_chunk", (meta, buffer))` 진입.
2. 입력 검증 (size / meta / source / seq) 통과.
3. `session.acceptChunk(pcm, { seq, durationMs })`로 mock adapter에 전달.
4. acceptChunk return 직후 `pcm = Buffer.alloc(0)`로 reference 폐기.

mock adapter는 buffer를 length 외에는 보지 않고 어떤 컬렉션에도 push하지 않으며 어떤 string에도 포함시키지 않는다.

테스트 13가 16-byte sentinel (`DE AD BE EF 4B 4C 4F 53 45 52 5F 41 55 44 4F 4F` — ASCII "KLOSER_AUDOO" 포함)을 PCM payload로 보낸 뒤:

- `transcripts.text` 검사 — sentinel ASCII / hex 모두 미발견.
- `llm_usage_log.metadata` 검사 — sentinel ASCII / hex 모두 미발견.
- `console.log` / `console.warn` / `console.error` 캡처 — sentinel ASCII / hex 모두 미발견.

`activity_log`는 audio 경로에서 직접 작성되지 않는다(audit hook 부재) → 별도 검사 불필요.

---

## 7. Adapter Boundary (Plan §10)

`streaming.ts`는 인터페이스만, `mockStreaming.ts`는 mock 구현. ws/calls.ts는 `resolveSttStreamingProvider()`를 한 번만 부르고 `provider.createSession({...})`만 사용한다.

이 경계가 분리되어 있어서 Step 4/5에서 Azure 실시간 STT를 붙일 때:

- `streaming.ts` 인터페이스 그대로.
- `azureStreaming.ts` 신규 — 같은 `SttStreamingSession` 반환.
- `resolveSttStreamingProvider`만 env 분기 추가.
- ws/calls.ts는 변경 없음.

Step 2에서는 web process 안에서 mock이 동기적으로 동작한다. Azure 도입 시 latency가 생기면 backpressure 카운터가 의미 있는 값을 가지게 되고, 필요 시 streaming session을 worker process로 옮기는 경계도 같은 인터페이스 안에서 처리 가능.

---

## 8. Tests

### 8.1 `phase9_step2_ws_audio.test.mjs` — 20 case

| # | Case | Assertion |
|---|---|---|
| 1 | audio_start before start_call | `error.code === "no_active_call"` |
| 2 | audio_chunk before audio_start | `"no_active_audio"` |
| 3 | duplicate audio_start | `"audio_already_started"` |
| 4 | invalid codec | `"BAD_PAYLOAD"` |
| 5 | invalid sample_rate | `"BAD_PAYLOAD"` |
| 6 | invalid channels (2) | `"BAD_PAYLOAD"` |
| 7 | invalid duration_ms (501) | `"BAD_PAYLOAD"` |
| 8 | non-positive seq (0) | `"BAD_PAYLOAD"` |
| 9 | source not declared in sources | `"BAD_PAYLOAD"` |
| 10 | chunk > 128 KiB | `"AUDIO_CHUNK_TOO_LARGE"` |
| 11 | duplicate seq per source | `"AUDIO_SEQ_OUT_OF_ORDER"` |
| 12 | decreasing seq per source | `"AUDIO_SEQ_OUT_OF_ORDER"` |
| 13 | rolling queue > 1 MiB | `"AUDIO_BACKPRESSURE"` |
| 14 | dual-source happy path → 2 finals + 1 usage row + `audio_duration_ms_sent=160`, `final_count=2`, `metadata.source="ws:audio"`, `cost_status="mock"` | persistence + usage 동시 |
| 15 | audio_end after soft-deleted call | `call_not_found`, 0 transcript, 1 usage row |
| 16 | end_call flushes open audio session | 1 transcript + 1 usage row |
| 17 | audio_end then end_call → no duplicates | exact 1 transcript + 1 usage row |
| 18 | text_chunk + audio coexistence | 2 transcript rows (text + audio) |
| 19 | raw audio sentinel does NOT leak | transcripts / usage / console 3중 검사 |
| 20 | audio_end without audio_start → no-op | 0 transcript, 0 usage |

테스트 harness는 `KLOSER_DEMO_REPLAY=0`을 import 전에 설정해 demo replay timer 노이즈를 제거. Acme admin JWT로 boot, `afterEach`가 calls + llm_usage_log를 cleanup.

### 8.2 회귀

`ws_auth.test.mjs` (handshake 7 case) + `ws_persistence.test.mjs` (text_chunk / start / end 6 case) 모두 unchanged + PASS. Phase 0.5 / 4 / 5 / 6 / 7 / 8 모든 WS 회귀 통과.

---

## 9. Verification 결과

```powershell
npm --prefix server run typecheck            # PASS
node test/sync_shared_types.mjs              # PASS (wsAudio entry 포함)
npm --prefix server test                      # 872 total / 869 PASS / 3 skipped / 0 fail
                                              #   (Phase 8 closeout 852 → +20 case)
git diff --check                              # clean
```

`db:migrate:up`은 Step 2 스코프에서 migration 미추가라 실행하지 않음 (필요 없음).

---

## 10. Decisions

### 10.1 per-source 세션 / per-flush 1개 aggregate usage row

mock 세션은 `audio_start`이 선언한 source별로 1개씩(최대 2개) 생성된다. 하지만 `llm_usage_log` row는 flush당 1개로 aggregate한다. Plan §8 metadata가 `source: "ws:audio"` constant 태그만 가지고 per-source 식별 필드가 없는 점을 반영. per-source 행은 미래 schema 부담 + Azure adapter 교체 시 변경 면적이 커서 의도적으로 피함.

### 10.2 backpressure는 reject, drop-oldest 아님

Plan §5.10 권장 그대로. mock STT는 동기 처리라 backpressure 발생 가능성은 낮지만, deterministic test와 일관 운영 동작을 위해 reject로 통일. Azure latency가 도입되면 같은 카운터가 실 동작 트리거가 된다.

### 10.3 queue time-decay 1s 윈도

`AUDIO_QUEUE_DRAIN_MS = 1000`로 누적 queuedBytes를 선형 감소시킨다. mock은 동기 처리라 사실상 즉시 0으로 떨어지지만, 미래 async provider가 들어왔을 때 transient burst가 영원히 카운터를 막지 않도록 decay 정책을 박아 둠. 테스트 13은 같은 tick 안에서 9개를 즉시 보내서 decay 없이 한도 초과를 트리거.

### 10.4 partial event 채널 분리

기존 `"transcript"` event는 final 전용으로 유지하고 partial은 `"transcript.partial"` 신규 채널. 데스크탑 클라이언트가 명시적으로 "이건 임시 텍스트"라고 구분할 수 있도록. Plan §7 채택.

### 10.5 audio_end without audio_start = no-op

Plan §5에 명시 안 됨. 데스크탑 클라이언트 cleanup 흐름에서 audio_start 없이 audio_end 한 번 emit하는 시나리오가 자연스럽다 — error로 만들면 오히려 client cleanup 코드가 복잡해진다. log line만 남기고 silent 통과.

### 10.6 raw audio sentinel 테스트는 ASCII + hex 두 패턴

원래 plan §9의 hex 패턴(`DEADBEEF4B4C4F5345525F41554449 4F`)에서 마지막 바이트를 0x4F (`O`)로 약간 변경(`KLOSER_AUDOO`)했다. 이유: 우연히 `AUDIO` 4글자가 다른 영역(코드 주석 등)에 등장할 가능성을 배제하기 위함. 어떤 ASCII 단어든 sentinel이 될 수 있는데, 사전에 검사 false positive가 거의 없는 단어를 골랐다.

### 10.7 streaming adapter의 `flush()`가 usage envelope을 반환하지만 ws에서는 미사용

`SttStreamingSession.flush()`가 per-session `ProviderUsage`도 반환하도록 인터페이스에 둠. 현재 ws/calls.ts는 result counter만 사용해 자체 aggregate envelope을 만든다. session 수준에서 envelope을 노출해 두면 향후 adapter 단위 테스트 / 미래 per-source 정책 변경 시 wire-up만 바꾸면 된다.

---

## 11. Risks / Follow-ups

- **Disconnect mid-stream에 final transcript 미적재.** `clearCall`은 audio 상태를 정리만 하고 flush는 부르지 않음. 이는 의도된 결정 — disconnect는 비정상 종료이고 partial 결과를 강제 적재하면 운영 데이터에 잡음이 늘어남. 다만 사용자가 detach 한 뒤 reconnect → end_call이라는 정상 흐름이 없으면 그 통화의 audio는 "녹취 metadata 없이" 종료된다. Phase 9 Step 4/5에서 Azure 실시간 도입 시 reconnect 안 안전망을 보강해야 함.
- **mock partial event 시점이 첫 chunk에 고정.** 실 Azure는 utterance break 단위로 partial을 흘려보낼 것. 현재 mock은 한 세션당 partial 1회만 보내므로 클라이언트 UI가 "여러 번 갱신" 시나리오를 회귀할 수 없음. Phase 9 Step 3 frontend에서 mock에 추가 partial trigger를 옵트인할지 결정 필요.
- **`AUDIO_QUEUE_DRAIN_MS`는 wallclock 기반.** Date.now() 호출이 들어가서 테스트가 time을 mock하면 동작이 달라질 수 있음. 현재 테스트는 wallclock 그대로 사용 — backpressure 테스트만 1 tick 안에 9개를 emit해서 결정성 확보. fake clock 도입 시 helper로 분리 필요.
- **session-level idempotency vs ctx-level idempotency 중복.** `flushAudioSession`이 `audio.flushed` 플래그로 가드하고, mock session 자체도 내부 `flushed` 플래그를 갖는다. 의도적 defense-in-depth지만 향후 Azure adapter가 stateful retry 정책을 가져오면 이 두 layer가 어떻게 협력할지 다시 정해야 함.
- **shared types 등록: 6개 enum/literal helper는 registry 밖.** `AudioSource` / `AudioCodec` / `AudioSampleRateHz` / `AudioChannels` / `AudioFrameMs` / `AudioEndReason`은 z.enum/z.literal이라 sync 파서 대상이 아님. 필드명 비교 게이트는 4개 object schema만으로 충분하지만, 향후 enum 값이 늘어나면 server↔browser drift는 sync에서 못 잡는다. 운영 시 enum 변경은 양쪽 동시 PR 강제.

---

## 12. Not Implemented (계획대로)

- Azure Speech 실시간 streaming 호출 — Step 4/5.
- Windows desktop app (capture 엔진 / 데스크탑 UI) — 별도 트랙 `DESKTOP_APP_PLAN.md`.
- Browser `MediaRecorder` 기반 capture UI.
- Telecom / VoIP provider import / webhook.
- Raw audio 저장 table — Phase 8 recording archive bridge가 Step 6 범위.
- Live `transcript.partial` 다중 partial 시나리오 — mock은 1회만.
- VAD (`audio_duration_ms_suppressed_by_vad`는 metadata에 0으로 박혀 있음, 향후 Azure VAD 옵션 도입 시 채울 자리).
- WS recording archive bridge (`call_recordings` finalize 연결).
- audit_log에 audio event hook (필요성 미검증).

---

## 13. Next Step

Phase 9 Step 3 — frontend (`live.html` 또는 desktop 디버그 페이지) WS audio test surface. backend는 닫혔으므로 frontend가 `audio_start` / `audio_chunk` / `audio_end`를 emit하면 transcripts table에 final이 적재되는지 e2e로 확인. 본 step에서는 product UX 변화 없음.

Step 4 — Azure Speech 실시간 streaming adapter. `azureStreaming.ts` 신규 + env 분기. `streaming.ts` 인터페이스 변경 없이 mock과 swap.

Step 5 — usage cost 환산. Azure pricing 기반 `costUsdMicros` 채움 + `cost_status` 값 갱신.

Step 6 — Phase 8 recording archive bridge. WS audio가 받은 chunk를 `call_recordings` upload/finalize 경로에 연결.

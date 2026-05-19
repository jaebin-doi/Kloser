# Phase 9 Step 2 Plan - Backend Audio Ingest Skeleton

작성일: 2026-05-19

상위 문서: `PHASE_9_MASTER.md`  
선행 결정: `PHASE_9_STEP_1_DESKTOP_CAPTURE_ARCHITECTURE.md`  
참조: `docs/research/실시간-STT-시장분석-2026.md`, `docs/research/AZURE_SPEECH_COST_GUIDE_2026.md`

> 본 Step은 구현자가 바로 코드를 쓰기 전에 합의해야 하는 backend audio ingest 계약이다. Azure 실 provider 호출, Windows desktop app, recording archive bridge는 아직 범위가 아니다. 목표는 `/calls` Socket.io namespace가 source-separated PCM audio chunk를 안전하게 받고, mock streaming STT로 transcript/usage/logging 계약을 검증하는 것이다.

---

## 1. Scope

### In

- Existing `/calls` Socket.io namespace 확장.
- `audio_start`, binary `audio_chunk`, `audio_end` event 추가.
- 기존 `start_call`, `text_chunk`, `end_call`, `heartbeat` 동작 보존.
- Mock streaming STT session 추가.
- `transcript.partial`은 live emit only.
- `transcript.final`만 기존 transcript persistence 경로로 저장.
- `llm_usage_log`에 mock STT usage row 실제 INSERT.
- Shared type contract 3-way 등록.
- Raw audio leak sentinel 테스트.

### Out

- Azure Speech 실 API 호출.
- Windows desktop app 구현.
- Browser `MediaRecorder` UI.
- Telecom/provider import/webhook.
- Raw audio 저장 table.
- Phase 8 recording upload/finalize bridge. 이건 Step 6 범위다.

---

## 2. Required Context For Implementer

구현자는 다음 문서를 먼저 읽고 시작한다.

1. `docs/plan/phase-9/PHASE_9_MASTER.md`
2. `docs/plan/phase-9/PHASE_9_STEP_1_DESKTOP_CAPTURE_ARCHITECTURE.md`
3. `server/src/ws/calls.ts`
4. `server/src/services/calls.ts`
5. `server/src/services/llmUsage.ts`
6. `server/src/types/transcript.ts`
7. `test/sync_shared_types.mjs`

주의: `PHASE_9_STEP_1_FINDINGS.md`는 현재 존재하지 않는다. Step 1 인계 정본은 `PHASE_9_STEP_1_DESKTOP_CAPTURE_ARCHITECTURE.md`다.

---

## 3. Event Contract

### 3.1 Shared Types

신규 event contract는 3-way shared type sync 대상이다.

Required files:

- `server/src/types/wsAudio.ts`
- `platform/types/wsAudio.js`
- `test/sync_shared_types.mjs` registry entry

서버 runtime validation은 zod source인 `server/src/types/wsAudio.ts`에서 가져온 schema를 사용한다. Browser JSDoc mirror는 desktop client 구현 전이라도 contract drift 방지를 위해 추가한다.

### 3.2 Client -> Server

```ts
type AudioStart = {
  type: "audio_start";
  call_id?: string; // optional; server active call context wins
  sources: Array<"agent_mic" | "system_loopback">;
  codec: "pcm_s16le";
  sample_rate_hz: 16000;
  channels: 1;
  frame_ms: 20 | 40 | 60 | 80 | 100;
  app_version: string;
  device_id?: string;
};

type AudioChunkMeta = {
  type: "audio_chunk";
  seq: number;
  source: "agent_mic" | "system_loopback";
  codec: "pcm_s16le";
  sample_rate_hz: 16000;
  channels: 1;
  duration_ms: number;
  started_at_ms: number;
};

// Socket.io event shape:
// socket.emit("audio_chunk", meta, pcmBuffer)

type AudioEnd = {
  type: "audio_end";
  reason?: "normal" | "pause" | "device_lost" | "network_reconnect";
};
```

Client-sent `org_id` is forbidden. If present, ignore or reject as bad payload. Org identity comes only from the existing Socket.io JWT handshake (`socket.data.user.orgId`) and all DB writes go through `app.withOrgContext`.

---

## 4. Limits

PCM16 16 kHz mono is 32,000 bytes/sec. 100 ms is about 3.2 KB. The limits below intentionally leave room for framing jitter while blocking memory abuse.

| Limit | Value | Behavior |
|---|---:|---|
| Single `audio_chunk` binary payload | 128 KiB max | reject with `AUDIO_CHUNK_TOO_LARGE` |
| `duration_ms` per chunk | 1..500 ms | reject with `BAD_PAYLOAD` |
| Active audio session rolling queued bytes | 1 MiB max | drop oldest unprocessed mock buffers or reject with `AUDIO_BACKPRESSURE` |
| Active call duration via audio path | use existing call lifecycle; no new cap in Step 2 | do not duplicate monthly call cap |

Step 2 must not introduce unbounded arrays of raw audio buffers. Mock STT can accumulate counters and deterministic fixture state, but not the full audio stream.

---

## 5. Session Lifecycle

### 5.1 `audio_start` Before `start_call`

Return runtime `error`:

```json
{ "code": "no_active_call", "message": "audio_start requires a prior start_call" }
```

### 5.2 `audio_chunk` Before `audio_start`

Return runtime `error`:

```json
{ "code": "no_active_audio", "message": "audio_chunk requires a prior audio_start" }
```

This is distinct from `no_active_call`; it tells the desktop client to re-declare format/source metadata without starting a new call.

### 5.3 Duplicate `audio_start`

Reject by default:

```json
{ "code": "audio_already_started", "message": "audio_start already received for this call" }
```

Do not silently close and replace the previous session in Step 2. Replacement semantics can hide desktop bugs.

### 5.4 `audio_end`

`audio_end` flushes the mock streaming STT session, emits any final transcript, records one usage row, and marks the audio session closed. A later `audio_chunk` requires a new `audio_start`.

### 5.5 `end_call` While Audio Session Is Open

`end_call` must call the same flush/close path as `audio_end` before `callsService.endCall`. The final transcript should be flushed if mock STT has pending final content.

If flush fails, clear socket-local audio state and return `{ ok: false, error: "persistence_failed" }` only if transcript persistence failed. Do not leave the socket with a dangling active audio session.

### 5.6 Mixing `text_chunk` And `audio_chunk`

Allowed during Step 2 for backward compatibility and E2E stability. Both append through the same transcript service path. The audio path must not disable or reinterpret existing `text_chunk` demo behavior.

---

## 6. Persistence Contract

Use the existing `callsService.appendTranscript` signature and behavior. If a small wrapper is needed for mock STT, it must preserve the same contract:

- input org comes from authenticated socket user.
- call id comes from socket active call context.
- speaker is derived from source:
  - `agent_mic` -> `agent`
  - `system_loopback` -> `customer`
- cross-org / vanished call behavior remains `call_not_found`.

Do not add a new transcript repository path unless the existing service cannot express the needed operation. If a new helper is required, it must still run through `app.withOrgContext`.

---

## 7. Mock Streaming STT

Step 2 adds a mock streaming STT session. It must be deterministic and not depend on Azure.

Minimum behavior:

- `audio_start` creates one mock session per source.
- `audio_chunk` updates per-source counters.
- The mock can emit a partial event after the first valid chunk.
- `audio_end` or `end_call` emits one final transcript per source that received audio.
- Final transcript text can be deterministic, for example:
  - `agent_mic`: `Mock agent audio transcript`
  - `system_loopback`: `Mock customer audio transcript`

Partial events are socket emits only. Final events are persisted.

---

## 8. Usage Logging

Do not leave usage metadata as a dead path. Step 2 must INSERT one `llm_usage_log` row per audio session flush.

Use `services/llmUsage.recordProviderUsage`.

Required row shape:

```ts
{
  provider: "mock",
  operation: "stt_transcribe",
  model: "mock-streaming-stt-v1",
  status: "succeeded",
  tokensIn: null,
  tokensOut: null,
  latencyMs: null,
  costUsdMicros: null,
  metadata: {
    source: "ws:audio",
    audio_duration_ms_sent: number,
    audio_duration_ms_suppressed_by_vad: 0,
    partial_count: number,
    final_count: number,
    cost_status: "mock"
  }
}
```

This aligns with the Phase 7 pricing decision that STT is audio-duration based and not token based. Azure adapter replacement should not require a schema migration.

Billing caps:

- `monthly_calls` is evaluated only by existing `start_call`.
- `audio_start` must not create or count a new call.
- `monthly_llm_cost` is soft and mock STT cost is null/zero; no new cap rejection in Step 2.

---

## 9. Raw Audio Leak Sentinel Tests

Tests must send a fixed magic byte pattern inside `audio_chunk`, for example:

```text
DE AD BE EF 4B 4C 4F 53 45 52 5F 41 55 44 49 4F
```

Then assert the sentinel does not appear in:

- `transcripts.text`
- `llm_usage_log.metadata`
- activity/audit payloads touched by this path
- captured console/log messages, if the test harness captures them

The server may process the Buffer in memory. It must not stringify, persist, or log it.

---

## 10. Process Boundary

Step 2 mock streaming STT may run in the web process. However, the adapter/session boundary must be isolated enough that Azure streaming can move behind a Fastify decorator or worker-facing service later.

Do not bury provider/session state directly inside route-local anonymous closures if that makes Step 4/5 extraction hard.

Recommended shape:

- `server/src/adapters/stt/streaming.ts` for interface/types.
- `server/src/adapters/stt/mockStreaming.ts` for mock implementation.
- `server/src/ws/calls.ts` wires socket events to a session object.

---

## 11. Tests

Required targeted tests:

- auth handshake regressions still pass.
- `audio_start` before `start_call` -> `no_active_call`.
- `audio_chunk` before `audio_start` -> `no_active_audio`.
- duplicate `audio_start` -> `audio_already_started`.
- invalid source / codec / sample rate / channels / duration / seq -> `BAD_PAYLOAD`.
- chunk > 128 KiB -> `AUDIO_CHUNK_TOO_LARGE`.
- valid chunks -> mock final transcript append on `audio_end`.
- `end_call` flushes open audio session.
- text and audio paths can coexist without breaking existing `text_chunk`.
- `llm_usage_log` row is inserted with `audio_duration_ms_sent`.
- raw audio sentinel does not leak.
- shared type sync passes.

---

## 12. Verification

```powershell
npm --prefix server run typecheck
npm --prefix server test
node test/sync_shared_types.mjs
git diff --check
```

Targeted test files should be called out in the Step 2 findings document once implemented.

---

## 13. Deliverables

Implementation deliverables:

- `server/src/types/wsAudio.ts`
- `platform/types/wsAudio.js`
- `test/sync_shared_types.mjs` registry update
- `server/src/adapters/stt/streaming.ts`
- `server/src/adapters/stt/mockStreaming.ts`
- `server/src/ws/calls.ts`
- `server/test/*audio*`
- `docs/plan/phase-9/PHASE_9_STEP_2_FINDINGS.md`
- `docs/plan/phase-9/PHASE_9_MASTER.md` Step 2 checkbox update only after tests pass

Review rule:

- Do not mark Step 2 complete until implementation, targeted tests, full required validation, and findings are all done.

# Phase 9 Step 1 Plan - Desktop Capture Architecture

작성일: 2026-05-19

상위 문서: `PHASE_9_MASTER.md`
참조: `docs/research/실시간-STT-시장분석-2026.md`, `docs/research/AZURE_SPEECH_COST_GUIDE_2026.md`, `docs/product/realtime-call-assistant-guide.md`

> 본 Step은 구현이 아니라 Phase 9의 Windows desktop capture + realtime STT 아키텍처 결정을 닫는 단계다. 결론은 **Windows C# audio engine + source-separated PCM16 stream + backend Azure Speech primary adapter**다.

---

## 1. Final Decisions

| Topic | Decision |
|---|---|
| STT primary vendor | **Azure Speech** |
| STT fallback / comparison | NAVER CLOVA Speech streaming, Deepgram Nova-3 |
| Not primary STT | OpenAI Realtime transcription, Whisper |
| Audio capture engine | C# / .NET 8 |
| C# audio library | NAudio first; direct WASAPI wrapper only if NAudio blocks required capture behavior |
| First UI shell | C# WPF/tray PoC; Flutter Windows deferred until capture quality is proven |
| Flutter-to-engine IPC if needed later | Windows named pipe with length-prefixed JSON control/status messages |
| Desktop -> backend transport | Existing Socket.io `/calls` namespace with binary `audio_chunk` payloads |
| Audio format on wire | PCM16 signed little-endian, 16 kHz, mono |
| Chunk cadence | 20-100 ms frames; backend may coalesce up to 250 ms before provider write |
| Source policy | Preserve `agent_mic` and `system_loopback`; do not mix before backend |
| Diarization default | Off |
| Final archive v1 | Local temp WAV for PoC, upload through Phase 8 upload/finalize on `end_call` |
| Token storage | Access token in memory; refresh/device secret via Windows Credential Manager or DPAPI |

---

## 2. STT Decision

### 2.1 Chosen Primary: Azure Speech

Azure Speech is the Phase 9 primary STT provider.

Reasons:

- It is the most conservative Korean realtime STT baseline in the local research docs.
- Official Azure docs list `ko-KR` support.
- The Speech SDK supports custom audio input streams, which fits a backend STT gateway that receives audio from the Windows app.
- The .NET / Microsoft ecosystem fits the C# desktop capture direction.
- Korea Central retail prices are already quantified in `AZURE_SPEECH_COST_GUIDE_2026.md`.
- Enterprise, region, compliance, and contract paths are clearer than low-latency specialist vendors.

As of 2026-05-19, the Azure Retail Prices API still returns the same Korea Central KRW meters used by the cost guide for the core MVP path:

| Meter | Price |
|---|---:|
| `S1 Speech To Text` | 1,473.55 KRW / audio hour |
| `S1 Speech to Text Enhanced Feature Audio` | 442.065 KRW / audio hour |
| `S1 Custom Speech To Text` | 1,768.26 KRW / audio hour |
| `S1 Speech to Text Batch` | 265.239 KRW / audio hour |
| `Fast Transcription Speech To Text` | 530.478 KRW / audio hour |

MVP default:

```text
Azure S1 Speech To Text
diarization off
Custom Speech off
Batch/Fast Transcription off
```

### 2.2 Why Diarization Is Off By Default

Phase 9 captures two logical sources:

- `agent_mic`: 상담원 마이크
- `system_loopback`: 고객/원격 통화 오디오

Because the source already identifies the speaker side, Kloser should not pay the realtime enhanced diarization add-on by default. Diarization is only a later option for mixed single-channel audio, meetings, or degraded source separation.

### 2.3 Fallback / Comparison Providers

NAVER CLOVA Speech streaming remains the Korea-region fallback candidate. It is useful if a pilot customer requires domestic vendor preference or Azure Korean quality is not sufficient. Its gRPC and PCM constraints must be absorbed in the backend gateway.

Deepgram Nova-3 remains the latency comparison candidate. It should not replace Azure as primary until Korean 상담 품질, compliance, and cost are measured against the same benchmark set.

OpenAI Realtime transcription is not the primary STT provider for Phase 9. It remains a future voice-agent / multimodal UX candidate.

Whisper is not a realtime primary. It can be used for batch backfill, offline research, or outage fallback only.

---

## 3. Runtime Architecture

```text
Windows Desktop App
  ├─ C# WPF/tray PoC UI
  ├─ C# Audio Engine
  │   ├─ NAudio WASAPI loopback capture -> system_loopback
  │   ├─ NAudio microphone capture -> agent_mic
  │   ├─ resample to PCM16 16 kHz mono
  │   ├─ source-tagged frame queue
  │   └─ local temp WAV archive
  └─ Socket.io client
      ├─ existing Kloser auth
      ├─ start_call
      ├─ audio_start
      ├─ audio_chunk(metadata, binary)
      ├─ audio_end
      └─ end_call

Kloser Backend
  ├─ /calls Socket.io namespace
  ├─ authenticated user/org context
  ├─ audio ingest validator
  ├─ per-source Azure Speech stream/session
  ├─ normalized transcript.partial / transcript.final events
  ├─ transcript persistence via existing call service/repositories
  ├─ llm_usage_log / STT usage metadata
  └─ Phase 8 recording storage bridge
```

The desktop app never receives Azure credentials. All vendor access is server-side.

---

## 4. Wire Contract

Phase 9 keeps the existing `/calls` Socket.io namespace. Do not create a separate unauthenticated raw WebSocket for v1.

Client -> Server:

```ts
type AudioStart = {
  type: "audio_start";
  call_id: string;
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
  call_id: string;
  seq: number;
  source: "agent_mic" | "system_loopback";
  codec: "pcm_s16le";
  sample_rate_hz: 16000;
  channels: 1;
  duration_ms: number;
  started_at_ms: number;
};

// Socket.io binary event:
// socket.emit("audio_chunk", meta, pcmBuffer)
```

Server -> Client:

```ts
type AudioAck = {
  ok: true;
  call_id: string;
  received_seq?: number;
  source?: "agent_mic" | "system_loopback";
};

type SttPartial = {
  type: "transcript.partial";
  call_id: string;
  source: "agent_mic" | "system_loopback";
  speaker: "agent" | "customer";
  text: string;
  started_at_ms?: number;
  ended_at_ms?: number;
  vendor: "azure";
  received_at: number;
};

type SttFinal = SttPartial & {
  type: "transcript.final";
  seq: number;
  confidence?: number;
};
```

Persistence rule:

- `transcript.partial` is emitted to live UI only.
- `transcript.final` is persisted to `transcripts`.
- Raw audio chunks are never stored in DB or logs.

---

## 5. Backend STT Adapter Contract

Phase 9 should add a streaming adapter shape rather than forcing Azure streaming into the existing one-shot `transcribeChunk()` contract.

```ts
export interface StreamingSttAdapter {
  readonly provider: "azure" | "clova" | "deepgram" | "mock";

  start(input: {
    orgId: string;
    callId: string;
    source: "agent_mic" | "system_loopback";
    language: "ko-KR";
    sampleRateHz: 16000;
    channels: 1;
    onPartial: (event: NormalizedSttPartial) => void;
    onFinal: (event: NormalizedSttFinal) => void;
    onError: (event: NormalizedSttError) => void;
  }): Promise<StreamingSttSession>;
}

export interface StreamingSttSession {
  write(chunk: Buffer, meta: AudioChunkMeta): void | Promise<void>;
  finish(): Promise<void>;
  close(): Promise<void>;
}
```

The existing `STTAdapter.transcribeChunk()` can remain for tests and short/batch paths. Phase 9 realtime should not build around repeatedly calling a short-recognition API every 1-5 seconds.

---

## 6. Usage / Cost Logging

Azure billing is audio-duration based, not token based. Phase 9 must extend provider usage logging before real STT can be trusted in production.

Required metadata:

```text
provider=azure
operation=stt_transcribe
model / meter=S1 Speech To Text
source=agent_mic | system_loopback
audio_duration_ms_sent
audio_duration_ms_suppressed_by_vad
partial_count
final_count
first_partial_ms
final_after_silence_ms
estimated_cost_krw
```

Implementation choice:

- Short term: store `audio_duration_ms_sent` and related counters in `llm_usage_log.metadata`.
- Follow-up migration only if reporting needs first-class indexed STT usage rows.

Do not rely on token fields for STT cost.

---

## 7. Security / Privacy

- Azure credentials live only in backend env.
- Desktop stores no vendor credentials.
- Access token is memory-only.
- Refresh token or device secret must use Windows Credential Manager or DPAPI.
- Logs must redact access tokens, refresh tokens, object keys, signed URLs, and raw audio.
- Raw audio chunks must not be written to DB.
- Local temp WAV archive is allowed only during an active call and is deleted after successful Phase 8 upload/finalize.
- Failed upload retry with retained audio requires an explicit encrypted-retention product decision. Default is discard + visible failure.

---

## 8. Pilot Matrix

Minimum manual smoke matrix before Step 7 closeout:

| Axis | Required coverage |
|---|---|
| OS | Windows 11 23H2/24H2; Windows 10 22H2 if pilot customer still uses it |
| Audio output | default speakers, USB headset, Bluetooth headset |
| Mic input | laptop mic, USB headset mic, Bluetooth headset mic |
| Softphone | pilot-selected softphone only; do not promise all providers |
| Call length | 5 min, 30 min |
| Network | normal, brief disconnect, reconnect |
| Audio states | silence, mute/unmute, device unplug/replug |

---

## 9. Next Step

Phase 9 Step 2 should implement the backend audio ingest skeleton first:

- Socket.io `audio_start` / binary `audio_chunk` / `audio_end`.
- Validation for source, seq, codec, sample rate, duration, and max chunk bytes.
- Mock streaming STT session for deterministic tests.
- No raw audio DB persistence or logging.
- Azure adapter can be introduced after the skeleton contract is green.

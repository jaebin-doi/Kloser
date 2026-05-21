// Phase 9 Step 5 — wire models + UI event records for backend realtime path.
//
// Wire payload는 Step 2 backend가 zod로 강제하는 형식과 1:1로 일치한다.
// 임의 필드 추가 / 이름 변경은 금지 — `server/src/types/wsAudio.ts` 정본.
//
// Step 5 Plan §3.2 / §5 매핑:
//   * AudioStartPayload    -> AudioStart  (audio_start emit)
//   * AudioChunkMetaPayload -> AudioChunkMeta (audio_chunk meta)
//   * AudioEndPayload      -> AudioEnd    (audio_end emit)
//   * TranscriptPartialEvent / TranscriptEvent / RealtimeErrorEvent
//     은 서버 -> 클라이언트 emit shape이다.
//
// 절대 raw PCM byte[]을 이 모델 안에 저장하지 않는다 — 별도 인자로 전송하고
// EmitAsync 호출 직후 reference를 폐기한다.

using System.Text.Json.Serialization;

namespace Kloser.Desktop.Shell.Services.Realtime;

public sealed class StartCallPayload
{
    // start_call 페이로드. Phase 9 Step 5 단계에서는 customer 선택 UX가
    // 없으므로 customerId를 보내지 않는다. backend는 customerId 미설정
    // 통화로 row를 만든다 (Phase 4 Step 3 fallback 그대로).
    [JsonPropertyName("customerId")]
    public string? CustomerId { get; init; }
}

public sealed class StartCallAck
{
    [JsonPropertyName("callId")]
    public string? CallId { get; init; }

    [JsonPropertyName("error")]
    public string? Error { get; init; }

    [JsonPropertyName("code")]
    public string? Code { get; init; }
}

public sealed class AudioStartPayload
{
    [JsonPropertyName("type")]
    public string Type => "audio_start";

    [JsonPropertyName("call_id")]
    public string? CallId { get; init; }

    [JsonPropertyName("sources")]
    public string[] Sources { get; init; } = Array.Empty<string>();

    [JsonPropertyName("codec")]
    public string Codec => "pcm_s16le";

    [JsonPropertyName("sample_rate_hz")]
    public int SampleRateHz => 16000;

    [JsonPropertyName("channels")]
    public int Channels => 1;

    [JsonPropertyName("frame_ms")]
    public int FrameMs { get; init; }

    [JsonPropertyName("app_version")]
    public string AppVersion { get; init; } = "phase9-step5-dev";

    [JsonPropertyName("device_id")]
    public string? DeviceId { get; init; }

    public Dictionary<string, object?> ToWireObject()
    {
        var wire = new Dictionary<string, object?>
        {
            ["type"] = Type,
            ["sources"] = Sources,
            ["codec"] = Codec,
            ["sample_rate_hz"] = SampleRateHz,
            ["channels"] = Channels,
            ["frame_ms"] = FrameMs,
            ["app_version"] = AppVersion,
        };
        if (!string.IsNullOrWhiteSpace(CallId)) wire["call_id"] = CallId;
        if (!string.IsNullOrWhiteSpace(DeviceId)) wire["device_id"] = DeviceId;
        return wire;
    }
}

public sealed class AudioChunkMetaPayload
{
    [JsonPropertyName("type")]
    public string Type => "audio_chunk";

    [JsonPropertyName("seq")]
    public long Seq { get; init; }

    [JsonPropertyName("source")]
    public string Source { get; init; } = "";

    [JsonPropertyName("codec")]
    public string Codec => "pcm_s16le";

    [JsonPropertyName("sample_rate_hz")]
    public int SampleRateHz => 16000;

    [JsonPropertyName("channels")]
    public int Channels => 1;

    [JsonPropertyName("duration_ms")]
    public int DurationMs { get; init; }

    [JsonPropertyName("started_at_ms")]
    public long StartedAtMs { get; init; }

    public Dictionary<string, object?> ToWireObject() => new()
    {
        ["type"] = Type,
        ["seq"] = Seq,
        ["source"] = Source,
        ["codec"] = Codec,
        ["sample_rate_hz"] = SampleRateHz,
        ["channels"] = Channels,
        ["duration_ms"] = DurationMs,
        ["started_at_ms"] = StartedAtMs,
    };
}

public sealed class AudioEndPayload
{
    [JsonPropertyName("type")]
    public string Type => "audio_end";

    [JsonPropertyName("reason")]
    public string? Reason { get; init; }

    public Dictionary<string, object?> ToWireObject()
    {
        var wire = new Dictionary<string, object?> { ["type"] = Type };
        if (!string.IsNullOrWhiteSpace(Reason)) wire["reason"] = Reason;
        return wire;
    }
}

public sealed class EndCallAck
{
    [JsonPropertyName("ok")]
    public bool Ok { get; init; }

    [JsonPropertyName("error")]
    public string? Error { get; init; }
}

// ---- server -> client emits ---------------------------------------------- //

/// <summary>
/// `transcript` event는 final 전사 + 기존 text_chunk echo 둘 다 같은 채널로
/// 흐른다. Step 2 mock STT 기준 final은 `who` ∈ { agent, customer },
/// `text` = "Mock agent audio transcript" / "Mock customer audio transcript".
/// </summary>
public sealed class TranscriptEvent
{
    [JsonPropertyName("seq")]
    public long Seq { get; init; }

    [JsonPropertyName("who")]
    public string? Who { get; init; }

    [JsonPropertyName("text")]
    public string? Text { get; init; }

    [JsonPropertyName("clientSentAt")]
    public long? ClientSentAt { get; init; }

    [JsonPropertyName("serverSentAt")]
    public long? ServerSentAt { get; init; }
}

public sealed class TranscriptPartialEvent
{
    [JsonPropertyName("callId")]
    public string? CallId { get; init; }

    [JsonPropertyName("source")]
    public string? Source { get; init; }

    [JsonPropertyName("who")]
    public string? Who { get; init; }

    [JsonPropertyName("text")]
    public string? Text { get; init; }

    [JsonPropertyName("atMs")]
    public long AtMs { get; init; }

    [JsonPropertyName("serverSentAt")]
    public long ServerSentAt { get; init; }
}

public sealed class RealtimeErrorEvent
{
    [JsonPropertyName("code")]
    public string? Code { get; init; }

    [JsonPropertyName("message")]
    public string? Message { get; init; }
}

// ---- UI-side helpers (not wire) ----------------------------------------- //

public enum RealtimeConnectionState
{
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
    Failed,
}

public enum RealtimeCallState
{
    Idle,
    Starting,
    InCall,
    Ending,
    Ended,
}

public enum RealtimeAuthMode
{
    PastedToken,
    Login,
}

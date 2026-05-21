// Phase 9 Step 6 — recording archive wire models + UI enums.
//
// Wire payloads match Phase 8 Step 3 backend `server/src/types/callRecording.ts`
// 1:1. Adding fields here would force a 3-way shared-type update (zod +
// platform JSDoc + sync registry); Step 6 does not change the contract.
//
// Field names mirror backend zod camelCase / snake_case mix.

using System.Text.Json.Serialization;

namespace Kloser.Desktop.Shell.Services.RecordingArchive;

public sealed class RecordingUploadInitiateRequest
{
    [JsonPropertyName("content_type")]
    public string ContentType { get; init; } = "audio/wav";

    [JsonPropertyName("codec")]
    public string Codec { get; init; } = "pcm_s16le_stereo_16000";

    [JsonPropertyName("recorded_at")]
    public string? RecordedAtIso { get; init; }

    [JsonPropertyName("duration_seconds")]
    public int DurationSeconds { get; init; }

    [JsonPropertyName("size_bytes")]
    public long SizeBytes { get; init; }

    [JsonPropertyName("checksum_sha256")]
    public string? ChecksumSha256 { get; init; }
}

public sealed class RecordingUploadInitiateResponse
{
    [JsonPropertyName("recording")]
    public RecordingMetaPayload? Recording { get; init; }

    // Phase 8 route response shape is `{ recording, upload }`.
    [JsonPropertyName("upload")]
    public SignedUploadPayload? SignedUrl { get; init; }
}

public sealed class RecordingMetaPayload
{
    [JsonPropertyName("id")]
    public string? Id { get; init; }

    [JsonPropertyName("status")]
    public string? Status { get; init; }
}

public sealed class SignedUploadPayload
{
    [JsonPropertyName("url")]
    public string? Url { get; init; }

    [JsonPropertyName("method")]
    public string? Method { get; init; }

    [JsonPropertyName("headers")]
    public Dictionary<string, string>? Headers { get; init; }

    [JsonPropertyName("expires_at")]
    public string? ExpiresAtIso { get; init; }
}

public sealed class RecordingFinalizeRequest
{
    [JsonPropertyName("duration_seconds")]
    public int DurationSeconds { get; init; }

    [JsonPropertyName("size_bytes")]
    public long SizeBytes { get; init; }

    [JsonPropertyName("checksum_sha256")]
    public string? ChecksumSha256 { get; init; }
}

public enum RecordingArchiveState
{
    Idle,
    Recording,
    FinalizingLocalFile,
    UploadInitiating,
    UploadingBytes,
    FinalizingRemote,
    Available,
    Failed,
}

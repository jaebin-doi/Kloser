// Phase 9 Step 3 — emitted frame model.
//
// Plan §7.4. Each emitted frame is exactly translatable to the Phase 9
// Step 2 backend AudioChunkMeta + binary payload pair:
//
//     AudioChunkMeta {
//       type: "audio_chunk",
//       seq, source, codec, sample_rate_hz, channels,
//       duration_ms, started_at_ms
//     }
//     + binary Buffer (Pcm)
//
// The PoC never serializes this off the desktop process — Step 5
// will. But the field set must match 1:1 today so the wire-up later
// is mechanical.

namespace Kloser.Capture.Core.Audio;

public sealed record CapturedAudioFrame(
    AudioSourceId Source,
    long Seq,
    string Codec,
    int SampleRateHz,
    int Channels,
    int DurationMs,
    long StartedAtMs,
    byte[] Pcm
);

/// <summary>
/// Aggregate status snapshot from one capture source. Reported by
/// StatusRenderer; never includes raw PCM bytes.
/// </summary>
public sealed record CaptureSourceStatus(
    AudioSourceId Source,
    bool IsHealthy,
    long FramesEmitted,
    long FramesDropped,
    double LastLevelPeak,
    double LastLevelRms,
    bool LastSilent,
    string? LastErrorMessage
);

/// <summary>
/// Non-fatal error envelope surfaced by capture sources. Plain
/// strings only; never embed raw audio bytes or sample data.
/// </summary>
public sealed record CaptureSourceError(
    AudioSourceId Source,
    string ErrorKind,
    string Message,
    bool Fatal
);

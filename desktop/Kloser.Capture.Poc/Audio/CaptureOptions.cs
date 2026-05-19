// Phase 9 Step 3 — capture session options parsed from CLI.
//
// Plan §6.2 — CLI surface.

namespace Kloser.Capture.Poc.Audio;

public sealed class CaptureOptions
{
    /// <summary>Empty / null means "Windows default capture endpoint".</summary>
    public string? MicDeviceId { get; init; }

    /// <summary>Empty / null means "Windows default render endpoint".</summary>
    public string? LoopbackDeviceId { get; init; }

    public bool NoMic { get; init; }

    public bool NoLoopback { get; init; }

    /// <summary>20 / 40 / 60 / 80 / 100 only. Default 40 (Step 1 decision).</summary>
    public int FrameMs { get; init; } = 40;

    /// <summary>Auto-stop after this many seconds. Default 30 for smoke.</summary>
    public int DurationSec { get; init; } = 30;

    public bool WriteDiagnosticWav { get; init; }

    /// <summary>Diagnostic output directory; default chosen at runtime.</summary>
    public string? DiagnosticDir { get; init; }

    public int StatusIntervalMs { get; init; } = 500;

    public const int SampleRateHz = 16000;
    public const int Channels = 1;
    public const int BytesPerSample = 2; // PCM16

    /// <summary>
    /// Exact byte count of one normalized frame at the configured
    /// frame_ms. PCM16 16 kHz mono.
    /// </summary>
    public int FrameByteSize => (SampleRateHz * FrameMs / 1000) * Channels * BytesPerSample;

    public static readonly int[] AllowedFrameMs = { 20, 40, 60, 80, 100 };
}

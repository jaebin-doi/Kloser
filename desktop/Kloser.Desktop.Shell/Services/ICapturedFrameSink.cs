// Phase 9 Step 4 — frame sink boundary (Plan §5.2).
//
// CaptureSessionController drains source frames and pushes them through
// one sink per session. Step 4 ships three implementations:
//   * NullFrameSink         — discards frames (default).
//   * CountingFrameSink     — counts frames for UI aggregate display.
//   * DiagnosticWavFrameSink — writes per-source PCM16 WAV files.
//
// Step 5 will add SocketIoAudioFrameSink that forwards frames to the
// /calls Socket.io namespace; the sink contract is intentionally
// network-free and async so the same controller code keeps working.

using Kloser.Capture.Core.Audio;

namespace Kloser.Desktop.Shell.Services;

public interface ICapturedFrameSink
{
    /// <summary>
    /// Called once per drained frame. The byte buffer is owned by the
    /// frame; sinks must NOT retain a reference beyond the awaited task.
    /// Raw PCM must never be logged, persisted, or stringified.
    /// </summary>
    ValueTask OnFrameAsync(CapturedAudioFrame frame, CancellationToken ct);
}

public sealed class NullFrameSink : ICapturedFrameSink
{
    public ValueTask OnFrameAsync(CapturedAudioFrame frame, CancellationToken ct)
        => ValueTask.CompletedTask;
}

public sealed class CountingFrameSink : ICapturedFrameSink
{
    private long _count;
    public long Count => Interlocked.Read(ref _count);
    public ValueTask OnFrameAsync(CapturedAudioFrame frame, CancellationToken ct)
    {
        Interlocked.Increment(ref _count);
        return ValueTask.CompletedTask;
    }
}

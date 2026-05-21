// Phase 9 Step 6 — ICapturedFrameSink that hands frames to the call
// archive WAV writer.
//
// Plan §5.1. The sink is registered in CaptureSessionController alongside
// the Step 5 SocketIoAudioFrameSink. Both observe the same frames from
// the same pump tick; archive does not interfere with realtime STT.
//
// Raw PCM bytes are NEVER retained by this sink past the synchronous
// writer.Write() call — the underlying `CallArchiveWavWriter` only
// keeps file handles + counters in memory.

using Kloser.Capture.Core.Audio;
using Kloser.Capture.Core.Recording;
using Kloser.Desktop.Shell.Services;

namespace Kloser.Desktop.Shell.Services.RecordingArchive;

public sealed class CallArchiveWavFrameSink : ICapturedFrameSink
{
    private readonly CallArchiveWavWriter _writer;
    private bool _active;

    public CallArchiveWavFrameSink(CallArchiveWavWriter writer)
    {
        _writer = writer ?? throw new ArgumentNullException(nameof(writer));
    }

    public bool IsActive => _active;
    public CallArchiveWavWriter Writer => _writer;

    public void Activate() => _active = true;
    public void Deactivate() => _active = false;

    public ValueTask OnFrameAsync(CapturedAudioFrame frame, CancellationToken ct)
    {
        if (!_active) return ValueTask.CompletedTask;
        _writer.Write(frame);
        return ValueTask.CompletedTask;
    }
}

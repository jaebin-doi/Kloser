// Phase 9 Step 4 — diagnostic WAV sink adapter.
//
// Wraps Kloser.Capture.Core.Diagnostics.DiagnosticWavWriter behind the
// ICapturedFrameSink contract so the controller treats it as just one
// more sink. Off by default (Plan §8) — the controller only constructs
// this sink when the WriteDiagnosticWav toggle is on.

using Kloser.Capture.Core.Audio;
using Kloser.Capture.Core.Diagnostics;

namespace Kloser.Desktop.Shell.Services;

public sealed class DiagnosticWavFrameSink : ICapturedFrameSink, IDisposable
{
    private readonly DiagnosticWavWriter _writer;
    private bool _disposed;

    public string OutputDir => _writer.OutputDir;

    public DiagnosticWavFrameSink(string outputDir)
    {
        _writer = new DiagnosticWavWriter(outputDir);
    }

    public ValueTask OnFrameAsync(CapturedAudioFrame frame, CancellationToken ct)
    {
        if (_disposed) return ValueTask.CompletedTask;
        _writer.Write(frame);
        return ValueTask.CompletedTask;
    }

    public IReadOnlyDictionary<AudioSourceId, string> GetWrittenPaths()
        => _writer.GetWrittenPaths();

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _writer.Dispose();
    }
}

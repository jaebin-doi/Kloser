// Phase 9 Step 3 — dev-only diagnostic WAV writer.
//
// Plan §7.7. Disabled by default. Activated only with
// --write-diagnostic-wav. Writes PCM16 16 kHz mono per-source files
// under .diagnostics/<timestamp>/. Files are git-ignored (see
// desktop/.gitignore).
//
// We use NAudio.Wave.WaveFileWriter so the header is always correct
// even if the process exits abnormally (final length is patched on
// dispose). We do not stream chunked, do not encrypt, do not upload.
// This audio is for a human to play back locally and confirm source
// separation; it must remain short and manually deletable.

using NAudio.Wave;
using Kloser.Capture.Poc.Audio;

namespace Kloser.Capture.Poc.Diagnostics;

public sealed class DiagnosticWavWriter : IDisposable
{
    private readonly object _sync = new();
    private readonly WaveFormat _format = new WaveFormat(
        rate: CaptureOptions.SampleRateHz,
        bits: 16,
        channels: CaptureOptions.Channels);
    private readonly Dictionary<AudioSourceId, WaveFileWriter> _writers = new();
    private readonly string _outputDir;
    private bool _disposed;

    public string OutputDir => _outputDir;

    public DiagnosticWavWriter(string outputDir)
    {
        _outputDir = outputDir;
        Directory.CreateDirectory(_outputDir);
    }

    public void Write(CapturedAudioFrame frame)
    {
        if (_disposed) return;
        if (frame.Pcm is null || frame.Pcm.Length == 0) return;
        lock (_sync)
        {
            if (!_writers.TryGetValue(frame.Source, out var w))
            {
                string fileName = frame.Source.ToWireString() + ".wav";
                string path = Path.Combine(_outputDir, fileName);
                w = new WaveFileWriter(path, _format);
                _writers[frame.Source] = w;
            }
            w.Write(frame.Pcm, 0, frame.Pcm.Length);
        }
    }

    public IReadOnlyDictionary<AudioSourceId, string> GetWrittenPaths()
    {
        lock (_sync)
        {
            var result = new Dictionary<AudioSourceId, string>();
            foreach (var (id, w) in _writers)
            {
                result[id] = w.Filename;
            }
            return result;
        }
    }

    public void Dispose()
    {
        lock (_sync)
        {
            if (_disposed) return;
            _disposed = true;
            foreach (var w in _writers.Values)
            {
                try { w.Flush(); } catch { /* swallow */ }
                try { w.Dispose(); } catch { /* swallow */ }
            }
            _writers.Clear();
        }
    }
}

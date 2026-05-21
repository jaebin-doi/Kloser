// Phase 9 Step 4 — orchestrates capture sources, sinks, and status
// polling on behalf of the UI view model. The view model holds a
// reference to this controller and calls Start / Stop / Dispose in
// response to user actions.
//
// Plan §5 lifecycle:
//   Start -> resolve devices via DeviceEnumerator -> create sources ->
//     start status DispatcherTimer -> running.
//   Stop  -> stop status timer -> stop sources -> dispose sinks ->
//     stopped.
//
// All raw PCM Buffers stay inside the per-source emitter (Step 3
// Pcm16FrameEmitter). The controller drains frames on the status tick
// and pushes them through ICapturedFrameSink — never logs, never
// stringifies.

using System.IO;
using Kloser.Capture.Core.Audio;
using NAudio.CoreAudioApi;

namespace Kloser.Desktop.Shell.Services;

public sealed class CaptureSessionStartParameters
{
    public string? MicDeviceId { get; init; }
    public string? LoopbackDeviceId { get; init; }
    public bool EnableMic { get; init; } = true;
    public bool EnableLoopback { get; init; } = true;
    public int FrameMs { get; init; } = 40;
    public bool WriteDiagnosticWav { get; init; }
    public string? DiagnosticDir { get; init; }
}

public sealed class CaptureSessionStartResult
{
    public bool MicStarted { get; init; }
    public bool LoopbackStarted { get; init; }
    public string? MicNativeFormat { get; init; }
    public string? LoopbackNativeFormat { get; init; }
    public string? DiagnosticDir { get; init; }
    public List<string> FriendlyErrors { get; init; } = new();
}

public sealed class CaptureSessionStopResult
{
    public IReadOnlyDictionary<AudioSourceId, string> DiagnosticWavPaths { get; init; }
        = new Dictionary<AudioSourceId, string>();
}

public sealed class CaptureSessionController : IDisposable
{
    private readonly object _sync = new();
    private DeviceEnumerator? _enumerator;
    private MicCaptureSource? _mic;
    private LoopbackCaptureSource? _loopback;
    private DiagnosticWavFrameSink? _wavSink;
    private CountingFrameSink? _counter;
    private long _sessionStartMs;
    private bool _running;

    public bool IsRunning { get { lock (_sync) return _running; } }
    public long SessionStartMs { get { lock (_sync) return _sessionStartMs; } }

    public CaptureSourceStatus? MicStatus
    {
        get { lock (_sync) return _mic?.GetStatus(); }
    }
    public CaptureSourceStatus? LoopbackStatus
    {
        get { lock (_sync) return _loopback?.GetStatus(); }
    }

    public AudioSourceId? Source { get; }
    public string? DiagnosticDir { get { lock (_sync) return _wavSink?.OutputDir; } }

    public CaptureSessionStartResult Start(CaptureSessionStartParameters p)
    {
        lock (_sync)
        {
            if (_running)
            {
                throw new InvalidOperationException("capture session already running");
            }
            _sessionStartMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            _enumerator = new DeviceEnumerator();

            bool micStarted = false;
            bool loopStarted = false;
            string? micFormat = null;
            string? loopFormat = null;
            string? diagnosticDir = null;
            var errors = new List<string>();

            if (p.EnableMic)
            {
                try
                {
                    var device = _enumerator.ResolveCapture(p.MicDeviceId);
                    _mic = new MicCaptureSource(p.FrameMs, _sessionStartMs);
                    _mic.Start(device);
                    micStarted = true;
                    micFormat = DescribeFormat(_mic.NativeFormat);
                }
                catch (InvalidOperationException ex)
                {
                    errors.Add($"mic: {ex.Message}");
                    _mic = null;
                }
                catch (Exception ex)
                {
                    errors.Add(
                        $"mic: 캡처를 시작하지 못했습니다 — {ex.GetType().Name}: {ex.Message}");
                    _mic = null;
                }
            }

            if (p.EnableLoopback)
            {
                try
                {
                    var device = _enumerator.ResolveRender(p.LoopbackDeviceId);
                    _loopback = new LoopbackCaptureSource(p.FrameMs, _sessionStartMs);
                    _loopback.Start(device);
                    loopStarted = true;
                    loopFormat = DescribeFormat(_loopback.NativeFormat);
                }
                catch (InvalidOperationException ex)
                {
                    errors.Add($"loopback: {ex.Message}");
                    _loopback = null;
                }
                catch (Exception ex)
                {
                    errors.Add(
                        $"loopback: 캡처를 시작하지 못했습니다 — {ex.GetType().Name}: {ex.Message}");
                    _loopback = null;
                }
            }

            if (_mic is null && _loopback is null)
            {
                _enumerator?.Dispose();
                _enumerator = null;
                if (errors.Count == 0)
                {
                    errors.Add(
                        "캡처할 소스가 없습니다. 마이크 또는 시스템 오디오 장치를 선택하세요.");
                }
                return new CaptureSessionStartResult
                {
                    MicStarted = false,
                    LoopbackStarted = false,
                    MicNativeFormat = micFormat,
                    LoopbackNativeFormat = loopFormat,
                    FriendlyErrors = errors,
                };
            }

            if (p.WriteDiagnosticWav)
            {
                try
                {
                    var dir = p.DiagnosticDir ?? DefaultDiagnosticDir();
                    _wavSink = new DiagnosticWavFrameSink(dir);
                    diagnosticDir = _wavSink.OutputDir;
                }
                catch (Exception ex)
                {
                    errors.Add(
                        $"진단 WAV 저장 디렉토리 생성 실패: {ex.GetType().Name}: {ex.Message}");
                    _wavSink = null;
                }
            }

            _counter = new CountingFrameSink();
            _running = true;
            return new CaptureSessionStartResult
            {
                MicStarted = micStarted,
                LoopbackStarted = loopStarted,
                MicNativeFormat = micFormat,
                LoopbackNativeFormat = loopFormat,
                DiagnosticDir = diagnosticDir,
                FriendlyErrors = errors,
            };
        }
    }

    /// <summary>
    /// Called by the UI status timer. Drains both sources, pushes the
    /// frames through the active sinks, and returns the latest status
    /// snapshots for the view model to apply.
    /// </summary>
    public async ValueTask PumpAsync(int maxFramesPerSource = 64, CancellationToken ct = default)
    {
        MicCaptureSource? mic;
        LoopbackCaptureSource? loop;
        DiagnosticWavFrameSink? wav;
        CountingFrameSink? counter;
        lock (_sync)
        {
            mic = _mic;
            loop = _loopback;
            wav = _wavSink;
            counter = _counter;
        }

        if (mic is not null)
        {
            foreach (var frame in mic.Drain(maxFramesPerSource))
            {
                if (counter is not null) await counter.OnFrameAsync(frame, ct).ConfigureAwait(false);
                if (wav is not null) await wav.OnFrameAsync(frame, ct).ConfigureAwait(false);
            }
        }
        if (loop is not null)
        {
            foreach (var frame in loop.Drain(maxFramesPerSource))
            {
                if (counter is not null) await counter.OnFrameAsync(frame, ct).ConfigureAwait(false);
                if (wav is not null) await wav.OnFrameAsync(frame, ct).ConfigureAwait(false);
            }
        }
    }

    public CaptureSessionStopResult Stop()
    {
        MicCaptureSource? mic;
        LoopbackCaptureSource? loop;
        DiagnosticWavFrameSink? wav;
        DeviceEnumerator? enumerator;
        lock (_sync)
        {
            if (!_running)
            {
                return new CaptureSessionStopResult();
            }
            _running = false;
            mic = _mic;
            loop = _loopback;
            wav = _wavSink;
            enumerator = _enumerator;
            _mic = null;
            _loopback = null;
            _wavSink = null;
            _enumerator = null;
            _counter = null;
        }
        try { mic?.Stop(); } catch { /* swallow */ }
        try { loop?.Stop(); } catch { /* swallow */ }
        var paths = wav?.GetWrittenPaths() ?? new Dictionary<AudioSourceId, string>();
        try { wav?.Dispose(); } catch { /* swallow */ }
        try { enumerator?.Dispose(); } catch { /* swallow */ }
        return new CaptureSessionStopResult { DiagnosticWavPaths = paths };
    }

    public void Dispose()
    {
        try { Stop(); } catch { /* swallow */ }
    }

    private static string DescribeFormat(NAudio.Wave.WaveFormat? fmt)
    {
        if (fmt is null) return "(unknown)";
        return $"{fmt.Encoding} · {fmt.SampleRate} Hz · {fmt.Channels}ch · {fmt.BitsPerSample}-bit";
    }

    private static string DefaultDiagnosticDir()
    {
        string stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
        string repoCandidate = Path.Combine(
            Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..")),
            ".diagnostics", stamp);
        return repoCandidate;
    }

    public IReadOnlyList<DeviceSnapshot> ListCaptureDevices()
    {
        using var e = new DeviceEnumerator();
        return e.ListCaptureDevices();
    }
    public IReadOnlyList<DeviceSnapshot> ListRenderDevices()
    {
        using var e = new DeviceEnumerator();
        return e.ListRenderDevices();
    }
}

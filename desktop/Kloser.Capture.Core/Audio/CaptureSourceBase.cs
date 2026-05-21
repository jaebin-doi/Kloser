// Phase 9 Step 3 — shared capture source plumbing.
//
// Plan §7.2. Mic and loopback share lifecycle, resampling, framing,
// and level-meter wiring. Only the underlying NAudio capture client
// differs (`WasapiCapture` vs `WasapiLoopbackCapture`). The subclass
// in MicCaptureSource.cs / LoopbackCaptureSource.cs provides a factory
// method that returns the NAudio object bound to a given MMDevice.

using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace Kloser.Capture.Core.Audio;

public abstract class CaptureSourceBase : IDisposable
{
    private readonly object _sync = new();
    private readonly AudioSourceId _source;
    private readonly int _frameMs;
    private readonly long _sessionStartMs;

    private IWaveIn? _waveIn;
    private Pcm16Resampler? _resampler;
    private Pcm16FrameEmitter? _emitter;
    private LevelMeter? _level;
    private bool _started;
    private bool _stopped;
    private string? _lastErrorMessage;
    private bool _isHealthy;
    private WaveFormat? _nativeFormat;
    private MMDevice? _deviceOwned;

    public AudioSourceId Source => _source;
    public bool IsHealthy { get { lock (_sync) return _isHealthy; } }
    public WaveFormat? NativeFormat { get { lock (_sync) return _nativeFormat; } }

    /// <summary>
    /// FrameReady is raised on the NAudio capture thread. Subscribers
    /// should treat this as a notification — actual frame draining
    /// is via <see cref="Drain"/> which is concurrency-safe.
    /// </summary>
    public event EventHandler<CapturedAudioFrame>? FrameReady;
    public event EventHandler<CaptureSourceError>? SourceError;

    protected CaptureSourceBase(AudioSourceId source, int frameMs, long sessionStartMs)
    {
        _source = source;
        _frameMs = frameMs;
        _sessionStartMs = sessionStartMs;
    }

    /// <summary>
    /// Subclass returns an IWaveIn bound to the given MMDevice. The
    /// base class owns the disposal of both the IWaveIn and the
    /// MMDevice handed back via the out param.
    /// </summary>
    protected abstract IWaveIn CreateClient(MMDevice device);

    public void Start(MMDevice device)
    {
        lock (_sync)
        {
            if (_started)
            {
                throw new InvalidOperationException(
                    $"{_source} capture already started");
            }
            _deviceOwned = device;
            try
            {
                _waveIn = CreateClient(device);
                _nativeFormat = _waveIn.WaveFormat;
                _resampler = new Pcm16Resampler(_waveIn.WaveFormat);
                _emitter = new Pcm16FrameEmitter(_source, _frameMs, _sessionStartMs);
                _level = new LevelMeter();
                _waveIn.DataAvailable += OnDataAvailable;
                _waveIn.RecordingStopped += OnRecordingStopped;
                _waveIn.StartRecording();
                _started = true;
                _isHealthy = true;
            }
            catch (Exception ex)
            {
                _isHealthy = false;
                _lastErrorMessage = $"{ex.GetType().Name}: {ex.Message}";
                throw;
            }
        }
    }

    private void OnDataAvailable(object? sender, WaveInEventArgs e)
    {
        if (e.BytesRecorded <= 0) return;
        Pcm16Resampler? resampler;
        Pcm16FrameEmitter? emitter;
        LevelMeter? level;
        lock (_sync)
        {
            resampler = _resampler;
            emitter = _emitter;
            level = _level;
        }
        if (resampler is null || emitter is null || level is null) return;
        try
        {
            byte[] pcm16 = resampler.Convert(e.Buffer, 0, e.BytesRecorded);
            if (pcm16.Length == 0) return;
            level.Observe(pcm16);
            int produced = emitter.Push(pcm16, 0, pcm16.Length);
            if (produced > 0 && FrameReady is { } handler)
            {
                // Notify subscribers; consumers should Drain() to get
                // the actual frames. We send a sentinel frame with the
                // most recent seq just so listeners can react cheaply.
                var sentinel = new CapturedAudioFrame(
                    Source: _source,
                    Seq: emitter.FramesEmitted,
                    Codec: "pcm_s16le",
                    SampleRateHz: CaptureOptions.SampleRateHz,
                    Channels: CaptureOptions.Channels,
                    DurationMs: _frameMs,
                    StartedAtMs: 0,
                    Pcm: Array.Empty<byte>()
                );
                handler.Invoke(this, sentinel);
            }
        }
        catch (Exception ex)
        {
            SourceError?.Invoke(this, new CaptureSourceError(
                _source,
                ErrorKind: "data_available",
                Message: $"{ex.GetType().Name}: {ex.Message}",
                Fatal: false
            ));
        }
    }

    private void OnRecordingStopped(object? sender, StoppedEventArgs e)
    {
        bool fatal = e.Exception != null;
        lock (_sync)
        {
            _isHealthy = !fatal && !_stopped;
            if (fatal)
            {
                _lastErrorMessage = $"{e.Exception!.GetType().Name}: {e.Exception.Message}";
            }
        }
        if (fatal)
        {
            SourceError?.Invoke(this, new CaptureSourceError(
                _source,
                ErrorKind: "recording_stopped",
                Message: _lastErrorMessage ?? "unknown",
                Fatal: true
            ));
        }
    }

    public void Stop()
    {
        IWaveIn? waveIn;
        Pcm16FrameEmitter? emitter;
        MMDevice? device;
        lock (_sync)
        {
            if (!_started || _stopped) return;
            _stopped = true;
            waveIn = _waveIn;
            emitter = _emitter;
            device = _deviceOwned;
        }
        try { waveIn?.StopRecording(); } catch { /* swallow during shutdown */ }
        try { waveIn?.Dispose(); } catch { /* swallow */ }
        try { device?.Dispose(); } catch { /* swallow */ }
        emitter?.Reset();
    }

    public IReadOnlyList<CapturedAudioFrame> Drain(int maxCount)
    {
        Pcm16FrameEmitter? emitter;
        lock (_sync) emitter = _emitter;
        if (emitter is null) return Array.Empty<CapturedAudioFrame>();
        return emitter.Drain(maxCount);
    }

    public CaptureSourceStatus GetStatus()
    {
        Pcm16FrameEmitter? emitter;
        LevelMeter? level;
        bool healthy;
        string? err;
        lock (_sync)
        {
            emitter = _emitter;
            level = _level;
            healthy = _isHealthy;
            err = _lastErrorMessage;
        }
        return new CaptureSourceStatus(
            Source: _source,
            IsHealthy: healthy,
            FramesEmitted: emitter?.FramesEmitted ?? 0,
            FramesDropped: emitter?.FramesDropped ?? 0,
            LastLevelPeak: level?.LastPeak ?? 0,
            LastLevelRms: level?.LastRms ?? 0,
            LastSilent: level?.LastSilent ?? true,
            LastErrorMessage: err
        );
    }

    public void Dispose() => Stop();
}

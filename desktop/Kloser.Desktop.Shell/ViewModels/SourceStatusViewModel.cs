// Phase 9 Step 4 — per-source live status row.
//
// Plan §4.2 / §6 — agent_mic and system_loopback each get one of these
// inside the main view model. UI binds Peak/Rms for the level meter,
// FramesEmitted/FramesDropped for counters, IsHealthy for status pill.

using Kloser.Capture.Core.Audio;

namespace Kloser.Desktop.Shell.ViewModels;

public sealed class SourceStatusViewModel : ObservableObject
{
    private bool _isEnabled = true;
    private bool _isHealthy;
    private string _nativeFormat = "(not started)";
    private string _normalizedFormat = "pcm_s16le · 16000 Hz · mono";
    private double _peak;
    private double _rms;
    private bool _silent = true;
    private long _framesEmitted;
    private long _framesDropped;
    private string? _lastErrorMessage;

    public AudioSourceId Source { get; }

    /// <summary>Wire-format label (agent_mic / system_loopback).</summary>
    public string SourceLabel => Source.ToWireString();

    /// <summary>Human label for the UI header.</summary>
    public string DisplayLabel => Source == AudioSourceId.AgentMic
        ? "agent_mic (microphone)"
        : "system_loopback (system audio)";

    public bool IsEnabled
    {
        get => _isEnabled;
        set => SetField(ref _isEnabled, value);
    }
    public bool IsHealthy
    {
        get => _isHealthy;
        set => SetField(ref _isHealthy, value);
    }
    public string NativeFormat
    {
        get => _nativeFormat;
        set => SetField(ref _nativeFormat, value);
    }
    public string NormalizedFormat
    {
        get => _normalizedFormat;
        set => SetField(ref _normalizedFormat, value);
    }
    public double Peak
    {
        get => _peak;
        set { if (SetField(ref _peak, value)) OnPropertyChanged(nameof(PeakPercent)); }
    }
    public double Rms
    {
        get => _rms;
        set { if (SetField(ref _rms, value)) OnPropertyChanged(nameof(RmsPercent)); }
    }
    public bool Silent
    {
        get => _silent;
        set => SetField(ref _silent, value);
    }
    public long FramesEmitted
    {
        get => _framesEmitted;
        set => SetField(ref _framesEmitted, value);
    }
    public long FramesDropped
    {
        get => _framesDropped;
        set => SetField(ref _framesDropped, value);
    }
    public string? LastErrorMessage
    {
        get => _lastErrorMessage;
        set => SetField(ref _lastErrorMessage, value);
    }

    /// <summary>0..100 for the level-meter ProgressBar width binding.</summary>
    public double PeakPercent => Math.Clamp(Peak * 100.0, 0, 100);
    public double RmsPercent => Math.Clamp(Rms * 100.0, 0, 100);

    public SourceStatusViewModel(AudioSourceId source)
    {
        Source = source;
    }

    public void ApplyStatus(CaptureSourceStatus status)
    {
        IsHealthy = status.IsHealthy;
        Peak = status.LastLevelPeak;
        Rms = status.LastLevelRms;
        Silent = status.LastSilent;
        FramesEmitted = status.FramesEmitted;
        FramesDropped = status.FramesDropped;
        LastErrorMessage = status.LastErrorMessage;
    }

    public void Reset()
    {
        IsHealthy = false;
        NativeFormat = "(not started)";
        Peak = 0;
        Rms = 0;
        Silent = true;
        FramesEmitted = 0;
        FramesDropped = 0;
        LastErrorMessage = null;
    }
}

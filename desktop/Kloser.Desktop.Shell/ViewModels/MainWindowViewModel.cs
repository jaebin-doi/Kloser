// Phase 9 Step 4 — main view model.
//
// Plan §4. Holds the device pickers, capture controls, source statuses,
// error panel, and S1-S6 smoke checklist. Capture work goes through
// CaptureSessionController on a DispatcherTimer pump so the WASAPI
// callback thread is never blocked.

using System.Collections.ObjectModel;
using System.Windows.Threading;
using Kloser.Capture.Core.Audio;
using Kloser.Desktop.Shell.Services;
using NAudio.CoreAudioApi;

namespace Kloser.Desktop.Shell.ViewModels;

public enum CaptureUiState { Idle, Starting, Running, Stopping, Stopped, Error }

public sealed class MainWindowViewModel : ObservableObject, IDisposable
{
    private readonly CaptureSessionController _controller = new();
    private readonly UiDispatcher _ui;
    private DispatcherTimer? _pumpTimer;
    private DateTime _sessionStartUtc;

    // ---------- public bindable surface ---------- //

    public ObservableCollection<DeviceOptionViewModel> CaptureDevices { get; } = new();
    public ObservableCollection<DeviceOptionViewModel> RenderDevices { get; } = new();

    public SourceStatusViewModel AgentMicStatus { get; } = new(AudioSourceId.AgentMic);
    public SourceStatusViewModel SystemLoopbackStatus { get; } = new(AudioSourceId.SystemLoopback);

    public ObservableCollection<string> Events { get; } = new();
    public ObservableCollection<string> LastErrors { get; } = new();

    public SmokeChecklistViewModel Smoke { get; } = new();

    public IReadOnlyList<int> AllowedFrameMs { get; } = new[] { 20, 40, 60, 80, 100 };

    public string AppVersion => "Kloser Desktop Capture — Step 4 PoC";

    private DeviceOptionViewModel? _selectedMic;
    public DeviceOptionViewModel? SelectedMic
    {
        get => _selectedMic;
        set => SetField(ref _selectedMic, value);
    }

    private DeviceOptionViewModel? _selectedLoopback;
    public DeviceOptionViewModel? SelectedLoopback
    {
        get => _selectedLoopback;
        set => SetField(ref _selectedLoopback, value);
    }

    private int _selectedFrameMs = 40;
    public int SelectedFrameMs
    {
        get => _selectedFrameMs;
        set
        {
            if (Array.IndexOf(CaptureOptions.AllowedFrameMs, value) < 0) return;
            SetField(ref _selectedFrameMs, value);
        }
    }

    private bool _writeDiagnosticWav;
    public bool WriteDiagnosticWav
    {
        get => _writeDiagnosticWav;
        set => SetField(ref _writeDiagnosticWav, value);
    }

    private string? _diagnosticDir;
    public string? DiagnosticDir
    {
        get => _diagnosticDir;
        set => SetField(ref _diagnosticDir, value);
    }

    private string _backendStatus = "Not connected (Step 5 예정)";
    public string BackendStatus
    {
        get => _backendStatus;
        set => SetField(ref _backendStatus, value);
    }
    private string _callStatus = "No active call (Step 5 예정)";
    public string CallStatus
    {
        get => _callStatus;
        set => SetField(ref _callStatus, value);
    }
    private string _userStatus = "Not signed in (Step 5 예정)";
    public string UserStatus
    {
        get => _userStatus;
        set => SetField(ref _userStatus, value);
    }

    private CaptureUiState _uiState = CaptureUiState.Idle;
    public CaptureUiState UiState
    {
        get => _uiState;
        set
        {
            if (SetField(ref _uiState, value))
            {
                OnPropertyChanged(nameof(IsRunning));
                OnPropertyChanged(nameof(IsIdle));
                OnPropertyChanged(nameof(UiStateLabel));
                StartCaptureCommand.RaiseCanExecuteChanged();
                StopCaptureCommand.RaiseCanExecuteChanged();
            }
        }
    }
    public bool IsRunning => UiState == CaptureUiState.Running;
    public bool IsIdle => UiState is CaptureUiState.Idle or CaptureUiState.Stopped or CaptureUiState.Error;
    public string UiStateLabel => UiState.ToString();

    private string _elapsedDisplay = "00:00:00";
    public string ElapsedDisplay
    {
        get => _elapsedDisplay;
        set => SetField(ref _elapsedDisplay, value);
    }

    private double _memoryMb;
    public double MemoryMb
    {
        get => _memoryMb;
        set => SetField(ref _memoryMb, value);
    }

    public RelayCommand RefreshDevicesCommand { get; }
    public RelayCommand StartCaptureCommand { get; }
    public RelayCommand StopCaptureCommand { get; }

    public MainWindowViewModel(UiDispatcher ui)
    {
        _ui = ui ?? throw new ArgumentNullException(nameof(ui));
        RefreshDevicesCommand = new RelayCommand(RefreshDevices);
        StartCaptureCommand = new RelayCommand(StartCapture, () => IsIdle);
        StopCaptureCommand = new RelayCommand(StopCapture, () => IsRunning);
        RefreshDevices();
    }

    // ---------- device picker ---------- //

    public void RefreshDevices()
    {
        try
        {
            var captures = _controller.ListCaptureDevices();
            var renders = _controller.ListRenderDevices();
            CaptureDevices.Clear();
            foreach (var d in captures)
            {
                CaptureDevices.Add(new DeviceOptionViewModel(
                    d.DeviceId, d.FriendlyName, d.IsDefault, DataFlow.Capture));
            }
            RenderDevices.Clear();
            foreach (var d in renders)
            {
                RenderDevices.Add(new DeviceOptionViewModel(
                    d.DeviceId, d.FriendlyName, d.IsDefault, DataFlow.Render));
            }

            if (SelectedMic is null || CaptureDevices.All(d => d.DeviceId != SelectedMic.DeviceId))
            {
                SelectedMic = CaptureDevices.FirstOrDefault(d => d.IsDefault) ?? CaptureDevices.FirstOrDefault();
            }
            if (SelectedLoopback is null || RenderDevices.All(d => d.DeviceId != SelectedLoopback.DeviceId))
            {
                SelectedLoopback = RenderDevices.FirstOrDefault(d => d.IsDefault) ?? RenderDevices.FirstOrDefault();
            }

            PushEvent(
                $"devices refreshed: {CaptureDevices.Count} capture / {RenderDevices.Count} render");
        }
        catch (Exception ex)
        {
            PushError($"devices refresh failed — {ex.GetType().Name}: {ex.Message}");
        }
    }

    // ---------- capture controls ---------- //

    public void StartCapture()
    {
        if (UiState is CaptureUiState.Running or CaptureUiState.Starting) return;
        UiState = CaptureUiState.Starting;
        LastErrors.Clear();
        AgentMicStatus.Reset();
        SystemLoopbackStatus.Reset();
        AgentMicStatus.IsEnabled = SelectedMic is not null;
        SystemLoopbackStatus.IsEnabled = SelectedLoopback is not null;
        _sessionStartUtc = DateTime.UtcNow;

        var p = new CaptureSessionStartParameters
        {
            MicDeviceId = SelectedMic?.DeviceId,
            LoopbackDeviceId = SelectedLoopback?.DeviceId,
            EnableMic = SelectedMic is not null,
            EnableLoopback = SelectedLoopback is not null,
            FrameMs = SelectedFrameMs,
            WriteDiagnosticWav = WriteDiagnosticWav,
        };
        try
        {
            var result = _controller.Start(p);
            DiagnosticDir = result.DiagnosticDir;
            if (result.MicStarted) AgentMicStatus.NativeFormat = result.MicNativeFormat ?? "(unknown)";
            else AgentMicStatus.IsEnabled = false;
            if (result.LoopbackStarted) SystemLoopbackStatus.NativeFormat = result.LoopbackNativeFormat ?? "(unknown)";
            else SystemLoopbackStatus.IsEnabled = false;
            foreach (var e in result.FriendlyErrors) PushError(e);

            if (!result.MicStarted && !result.LoopbackStarted)
            {
                UiState = CaptureUiState.Error;
                return;
            }

            PushEvent("capture started");
            if (DiagnosticDir is not null)
            {
                PushEvent($"diagnostic WAV → {DiagnosticDir}");
            }
            StartPumpTimer();
            UiState = CaptureUiState.Running;
        }
        catch (Exception ex)
        {
            PushError($"start failed — {ex.GetType().Name}: {ex.Message}");
            UiState = CaptureUiState.Error;
        }
    }

    public void StopCapture()
    {
        if (UiState is not CaptureUiState.Running) return;
        UiState = CaptureUiState.Stopping;
        StopPumpTimer();
        try
        {
            var result = _controller.Stop();
            if (result.DiagnosticWavPaths.Count > 0)
            {
                foreach (var (id, path) in result.DiagnosticWavPaths)
                {
                    PushEvent($"WAV {id.ToWireString()} → {path}");
                }
                // Auto-suggest S4 only when BOTH source files were
                // written. Source separation still requires the user
                // to actually play back and confirm — but at least the
                // mechanical "two files exist" gate is observable.
                if (result.DiagnosticWavPaths.ContainsKey(AudioSourceId.AgentMic)
                    && result.DiagnosticWavPaths.ContainsKey(AudioSourceId.SystemLoopback))
                {
                    Smoke.S4DiagnosticWavWritten = true;
                }
            }
            PushEvent("capture stopped");
        }
        catch (Exception ex)
        {
            PushError($"stop error — {ex.GetType().Name}: {ex.Message}");
        }
        UiState = CaptureUiState.Stopped;
    }

    // ---------- pump timer ---------- //

    private void StartPumpTimer()
    {
        StopPumpTimer();
        _pumpTimer = new DispatcherTimer
        {
            Interval = TimeSpan.FromMilliseconds(500),
        };
        _pumpTimer.Tick += async (_, _) => await OnTickAsync().ConfigureAwait(true);
        _pumpTimer.Start();
    }

    private void StopPumpTimer()
    {
        if (_pumpTimer is not null)
        {
            _pumpTimer.Stop();
            _pumpTimer = null;
        }
    }

    private async ValueTask OnTickAsync()
    {
        try
        {
            await _controller.PumpAsync().ConfigureAwait(true);
            var micStatus = _controller.MicStatus;
            var loopStatus = _controller.LoopbackStatus;
            if (micStatus is not null) AgentMicStatus.ApplyStatus(micStatus);
            if (loopStatus is not null) SystemLoopbackStatus.ApplyStatus(loopStatus);

            var elapsed = DateTime.UtcNow - _sessionStartUtc;
            ElapsedDisplay = elapsed.ToString(@"hh\:mm\:ss");
            MemoryMb = Math.Round(GC.GetTotalMemory(false) / 1024.0 / 1024.0, 1);

            Smoke.AutoSuggest(AgentMicStatus, SystemLoopbackStatus, elapsed);
        }
        catch (Exception ex)
        {
            PushError($"pump error — {ex.GetType().Name}: {ex.Message}");
            StopPumpTimer();
            UiState = CaptureUiState.Error;
        }
    }

    // ---------- event/error helpers ---------- //

    private void PushEvent(string message)
    {
        _ui.Post(() =>
        {
            var stamped = $"[{DateTime.Now:HH:mm:ss}] {message}";
            Events.Insert(0, stamped);
            while (Events.Count > 30) Events.RemoveAt(Events.Count - 1);
        });
    }

    private void PushError(string message)
    {
        _ui.Post(() =>
        {
            var stamped = $"[{DateTime.Now:HH:mm:ss}] {message}";
            LastErrors.Insert(0, stamped);
            while (LastErrors.Count > 10) LastErrors.RemoveAt(LastErrors.Count - 1);
        });
    }

    public void Dispose()
    {
        StopPumpTimer();
        _controller.Dispose();
    }
}

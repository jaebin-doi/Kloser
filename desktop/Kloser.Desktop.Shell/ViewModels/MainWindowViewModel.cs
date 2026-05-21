// Phase 9 Step 4 — main view model (device pickers, capture, status, S1-S6).
// Phase 9 Step 5 — realtime backend integration:
//   * DesktopAuthClient: /auth/login + KLOSER_DESKTOP_ACCESS_TOKEN env fallback.
//   * CallsSocketClient: /calls Socket.IO connection w/ JWT handshake.
//   * RealtimeCallSession: start_call -> audio_start -> audio_chunk -> audio_end -> end_call.
//   * SocketIoAudioFrameSink: ICapturedFrameSink => audio_chunk(meta, byte[]).
//   * partial / final transcript event subscriptions.
// Raw PCM byte[]은 sink 안에서만 살아 있고 UI string / 이벤트 / 오류에 절대 노출되지 않는다.

using System.Collections.ObjectModel;
using System.Windows.Threading;
using Kloser.Capture.Core.Audio;
using Kloser.Desktop.Shell.Services;
using Kloser.Desktop.Shell.Services.Realtime;
using NAudio.CoreAudioApi;

namespace Kloser.Desktop.Shell.ViewModels;

public enum CaptureUiState { Idle, Starting, Running, Stopping, Stopped, Error }

public sealed class MainWindowViewModel : ObservableObject, IDisposable
{
    private readonly CaptureSessionController _controller = new();
    private readonly UiDispatcher _ui;
    private DispatcherTimer? _pumpTimer;
    private DateTime _sessionStartUtc;

    // ---------- Phase 9 Step 5 — realtime backend integration ---------- //
    // 메모리 only. 파일 / 레지스트리에 저장하지 않는다.
    private readonly DesktopAuthClient _auth = new();
    private readonly CallsSocketClient _socket = new();
    private RealtimeCallSession? _callSession;
    private SocketIoAudioFrameSink? _audioSink;
    private string? _accessTokenMemoryOnly;

    // ---------- public bindable surface ---------- //

    public ObservableCollection<DeviceOptionViewModel> CaptureDevices { get; } = new();
    public ObservableCollection<DeviceOptionViewModel> RenderDevices { get; } = new();

    public SourceStatusViewModel AgentMicStatus { get; } = new(AudioSourceId.AgentMic);
    public SourceStatusViewModel SystemLoopbackStatus { get; } = new(AudioSourceId.SystemLoopback);

    public ObservableCollection<string> Events { get; } = new();
    public ObservableCollection<string> LastErrors { get; } = new();

    public SmokeChecklistViewModel Smoke { get; } = new();

    public IReadOnlyList<int> AllowedFrameMs { get; } = new[] { 20, 40, 60, 80, 100 };

    public string AppVersion => "클로저 데스크탑 캡처 — Step 4 PoC";

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

    private string _backendStatus = "연결 안 됨 (Step 5 예정)";
    public string BackendStatus
    {
        get => _backendStatus;
        set => SetField(ref _backendStatus, value);
    }
    private string _callStatus = "활성 통화 없음 (Step 5 예정)";
    public string CallStatus
    {
        get => _callStatus;
        set => SetField(ref _callStatus, value);
    }
    private string _userStatus = "로그인 안 됨 (Step 5 예정)";
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

    // ---------- Phase 9 Step 5 realtime bindable surface ---------- //

    private string _backendUrl = "http://localhost:32173";
    public string BackendUrl
    {
        get => _backendUrl;
        set => SetField(ref _backendUrl, value);
    }

    private string _loginEmail = "";
    public string LoginEmail
    {
        get => _loginEmail;
        set => SetField(ref _loginEmail, value);
    }

    private string _loginPassword = "";
    public string LoginPassword
    {
        get => _loginPassword;
        set => SetField(ref _loginPassword, value);
    }

    private string _pastedToken = "";
    public string PastedToken
    {
        get => _pastedToken;
        set => SetField(ref _pastedToken, value);
    }

    private RealtimeConnectionState _connectionState = RealtimeConnectionState.Disconnected;
    public RealtimeConnectionState ConnectionState
    {
        get => _connectionState;
        set
        {
            if (SetField(ref _connectionState, value))
            {
                OnPropertyChanged(nameof(IsConnected));
                OnPropertyChanged(nameof(ConnectionStateLabel));
                LoginAndConnectCommand.RaiseCanExecuteChanged();
                ConnectWithTokenCommand.RaiseCanExecuteChanged();
                DisconnectCommand.RaiseCanExecuteChanged();
                StartCallCommand.RaiseCanExecuteChanged();
                EndCallCommand.RaiseCanExecuteChanged();
            }
        }
    }
    public bool IsConnected => ConnectionState == RealtimeConnectionState.Connected;
    public string ConnectionStateLabel => ConnectionState switch
    {
        RealtimeConnectionState.Disconnected => "연결 안 됨",
        RealtimeConnectionState.Connecting => "연결 중…",
        RealtimeConnectionState.Connected => "연결됨",
        RealtimeConnectionState.Reconnecting => "재연결 중…",
        RealtimeConnectionState.Failed => "연결 실패",
        _ => ConnectionState.ToString(),
    };

    private RealtimeCallState _callState = RealtimeCallState.Idle;
    public RealtimeCallState CallStateValue
    {
        get => _callState;
        set
        {
            if (SetField(ref _callState, value))
            {
                OnPropertyChanged(nameof(IsCallActive));
                OnPropertyChanged(nameof(CallStateLabel));
                StartCallCommand.RaiseCanExecuteChanged();
                EndCallCommand.RaiseCanExecuteChanged();
            }
        }
    }
    public bool IsCallActive => CallStateValue == RealtimeCallState.InCall;
    public string CallStateLabel => CallStateValue switch
    {
        RealtimeCallState.Idle => "대기 중",
        RealtimeCallState.Starting => "통화 시작 중…",
        RealtimeCallState.InCall => "통화 중",
        RealtimeCallState.Ending => "통화 종료 중…",
        RealtimeCallState.Ended => "통화 종료됨",
        _ => CallStateValue.ToString(),
    };

    private string? _activeCallId;
    public string? ActiveCallId
    {
        get => _activeCallId;
        set => SetField(ref _activeCallId, value);
    }

    private string? _lastRealtimeError;
    public string? LastRealtimeError
    {
        get => _lastRealtimeError;
        set => SetField(ref _lastRealtimeError, value);
    }

    private long _agentMicChunksSent;
    public long AgentMicChunksSent
    {
        get => _agentMicChunksSent;
        set => SetField(ref _agentMicChunksSent, value);
    }
    private long _systemLoopbackChunksSent;
    public long SystemLoopbackChunksSent
    {
        get => _systemLoopbackChunksSent;
        set => SetField(ref _systemLoopbackChunksSent, value);
    }
    private long _agentMicBytesSent;
    public long AgentMicBytesSent
    {
        get => _agentMicBytesSent;
        set => SetField(ref _agentMicBytesSent, value);
    }
    private long _systemLoopbackBytesSent;
    public long SystemLoopbackBytesSent
    {
        get => _systemLoopbackBytesSent;
        set => SetField(ref _systemLoopbackBytesSent, value);
    }

    private string? _latestPartialAgent;
    public string? LatestPartialAgent
    {
        get => _latestPartialAgent;
        set => SetField(ref _latestPartialAgent, value);
    }
    private string? _latestPartialCustomer;
    public string? LatestPartialCustomer
    {
        get => _latestPartialCustomer;
        set => SetField(ref _latestPartialCustomer, value);
    }

    public ObservableCollection<string> FinalTranscripts { get; } = new();

    public RelayCommand LoginAndConnectCommand { get; }
    public RelayCommand ConnectWithTokenCommand { get; }
    public RelayCommand DisconnectCommand { get; }
    public RelayCommand StartCallCommand { get; }
    public RelayCommand EndCallCommand { get; }

    public MainWindowViewModel(UiDispatcher ui)
    {
        _ui = ui ?? throw new ArgumentNullException(nameof(ui));
        RefreshDevicesCommand = new RelayCommand(RefreshDevices);
        StartCaptureCommand = new RelayCommand(StartCapture, () => IsIdle);
        StopCaptureCommand = new RelayCommand(StopCapture, () => IsRunning);
        // Phase 9 Step 5 — realtime commands. async lifecycle은 fire-and-forget
        // 으로 호출하고 결과는 PushEvent / PushError로 surface한다.
        LoginAndConnectCommand = new RelayCommand(
            () => _ = LoginAndConnectAsync(),
            () => ConnectionState is RealtimeConnectionState.Disconnected
                or RealtimeConnectionState.Failed);
        ConnectWithTokenCommand = new RelayCommand(
            () => _ = ConnectWithTokenAsync(),
            () => ConnectionState is RealtimeConnectionState.Disconnected
                or RealtimeConnectionState.Failed);
        DisconnectCommand = new RelayCommand(
            () => _ = DisconnectAsync(),
            () => ConnectionState is RealtimeConnectionState.Connected
                or RealtimeConnectionState.Connecting);
        StartCallCommand = new RelayCommand(
            () => _ = StartCallAsync(),
            () => IsConnected && CallStateValue is RealtimeCallState.Idle or RealtimeCallState.Ended);
        EndCallCommand = new RelayCommand(
            () => _ = EndCallAsync(),
            () => IsCallActive);

        // dev fallback: KLOSER_DESKTOP_ACCESS_TOKEN env 자동 채우기.
        var envToken = DesktopAuthClient.TryReadDevTokenFromEnv();
        if (!string.IsNullOrEmpty(envToken)) PastedToken = envToken;

        _socket.Connected += OnSocketConnected;
        _socket.Disconnected += OnSocketDisconnected;
        _socket.TransportFailed += OnSocketTransportFailed;
        _socket.ErrorReceived += OnSocketRuntimeError;
        _socket.TranscriptPartialReceived += OnTranscriptPartial;
        _socket.TranscriptReceived += OnTranscriptFinal;

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
                $"장치 새로고침 완료: 캡처 {CaptureDevices.Count}개 / 출력 {RenderDevices.Count}개");
        }
        catch (Exception ex)
        {
            PushError($"장치 새로고침 실패 — {ex.GetType().Name}: {ex.Message}");
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

            PushEvent("캡처 시작");
            if (DiagnosticDir is not null)
            {
                PushEvent($"진단 WAV 저장 위치 → {DiagnosticDir}");
            }
            StartPumpTimer();
            UiState = CaptureUiState.Running;
        }
        catch (Exception ex)
        {
            PushError($"캡처 시작 실패 — {ex.GetType().Name}: {ex.Message}");
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
                    PushEvent($"진단 WAV {id.ToWireString()} 저장됨 → {path}");
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
            PushEvent("캡처 정지");
        }
        catch (Exception ex)
        {
            PushError($"캡처 정지 실패 — {ex.GetType().Name}: {ex.Message}");
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
            PushError($"상태 갱신 실패 — {ex.GetType().Name}: {ex.Message}");
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

    // ---------- Phase 9 Step 5 — async realtime lifecycle ---------- //

    private async Task LoginAndConnectAsync()
    {
        if (ConnectionState is RealtimeConnectionState.Connecting
            or RealtimeConnectionState.Connected) return;
        ConnectionState = RealtimeConnectionState.Connecting;
        LastRealtimeError = null;
        try
        {
            var result = await _auth.LoginAsync(
                BackendUrl, LoginEmail, LoginPassword).ConfigureAwait(true);
            if (!result.Success)
            {
                LastRealtimeError = result.FriendlyMessage;
                ConnectionState = RealtimeConnectionState.Failed;
                PushError($"로그인 실패: {result.FriendlyMessage}");
                return;
            }
            _accessTokenMemoryOnly = result.AccessToken;
            // 비밀번호는 메모리에서 즉시 비움 (이후 재로그인 시 다시 입력).
            LoginPassword = "";
            await ConnectSocketAsync().ConfigureAwait(true);
        }
        catch (Exception ex)
        {
            ConnectionState = RealtimeConnectionState.Failed;
            LastRealtimeError = $"{ex.GetType().Name}: {ex.Message}";
            PushError($"연결 실패: {ex.GetType().Name}: {ex.Message}");
        }
    }

    private async Task ConnectWithTokenAsync()
    {
        if (ConnectionState is RealtimeConnectionState.Connecting
            or RealtimeConnectionState.Connected) return;
        if (string.IsNullOrWhiteSpace(PastedToken))
        {
            PushError("access token을 붙여 넣은 뒤 다시 시도하세요.");
            return;
        }
        var normalized = DesktopAuthClient.NormalizeAccessTokenInput(PastedToken);
        if (!normalized.Success)
        {
            LastRealtimeError = normalized.FriendlyMessage;
            PushError($"토큰 확인 실패: {normalized.FriendlyMessage}");
            return;
        }
        ConnectionState = RealtimeConnectionState.Connecting;
        LastRealtimeError = null;
        _accessTokenMemoryOnly = normalized.AccessToken;
        try
        {
            await ConnectSocketAsync().ConfigureAwait(true);
            // 연결 성공 후 UI에서는 token을 평문으로 두지 않는다.
            PastedToken = "";
        }
        catch (Exception ex)
        {
            ConnectionState = RealtimeConnectionState.Failed;
            LastRealtimeError = $"{ex.GetType().Name}: {ex.Message}";
            PushError($"Socket 연결 실패: {ex.GetType().Name}: {ex.Message}");
        }
    }

    private async Task ConnectSocketAsync()
    {
        if (string.IsNullOrWhiteSpace(_accessTokenMemoryOnly))
        {
            ConnectionState = RealtimeConnectionState.Failed;
            PushError("access token이 비어 있습니다.");
            return;
        }
        await _socket.ConnectAsync(BackendUrl, _accessTokenMemoryOnly!).ConfigureAwait(true);
        // OnSocketConnected가 ConnectionState를 Connected로 갱신.
    }

    private async Task DisconnectAsync()
    {
        try
        {
            if (IsCallActive) await EndCallAsync().ConfigureAwait(true);
            await _socket.DisconnectAsync().ConfigureAwait(true);
        }
        catch (Exception ex)
        {
            PushError($"연결 끊기 실패: {ex.GetType().Name}: {ex.Message}");
        }
        finally
        {
            ConnectionState = RealtimeConnectionState.Disconnected;
            _accessTokenMemoryOnly = null;
        }
    }

    private async Task StartCallAsync()
    {
        if (!IsConnected) return;
        if (CallStateValue is RealtimeCallState.Starting or RealtimeCallState.InCall) return;
        CallStateValue = RealtimeCallState.Starting;
        FinalTranscripts.Clear();
        LatestPartialAgent = null;
        LatestPartialCustomer = null;
        AgentMicChunksSent = 0;
        SystemLoopbackChunksSent = 0;
        AgentMicBytesSent = 0;
        SystemLoopbackBytesSent = 0;
        LastRealtimeError = null;
        bool startedCaptureForCall = false;

        // 캡처가 켜져 있지 않으면 먼저 자동으로 켠다 — 사용자가 캡처를
        // 따로 시작하지 않아도 통화 시작 = 캡처 시작 + audio_start로 묶임.
        if (!IsRunning)
        {
            StartCapture();
            if (UiState != CaptureUiState.Running)
            {
                PushError("캡처를 먼저 시작할 수 없어 통화 시작을 중단했습니다.");
                CallStateValue = RealtimeCallState.Idle;
                return;
            }
            startedCaptureForCall = true;
        }

        var sources = new List<AudioSourceId>();
        if (AgentMicStatus.IsEnabled) sources.Add(AudioSourceId.AgentMic);
        if (SystemLoopbackStatus.IsEnabled) sources.Add(AudioSourceId.SystemLoopback);
        if (sources.Count == 0)
        {
            PushError("audio_start로 보낼 source가 없습니다 (마이크/시스템 모두 비활성).");
            CallStateValue = RealtimeCallState.Idle;
            if (startedCaptureForCall && IsRunning) StopCapture();
            return;
        }

        _audioSink = new SocketIoAudioFrameSink(_socket, sources);
        _audioSink.ChunkSent += OnAudioChunkSent;
        _audioSink.SendFailed += OnAudioSendFailed;
        _controller.AddExternalSink(_audioSink);

        _callSession = new RealtimeCallSession(_socket, _audioSink);
        _callSession.StateChanged += OnCallStateChanged;

        var audioStart = new AudioStartPayload
        {
            Sources = sources.Select(s => s.ToWireString()).ToArray(),
            FrameMs = SelectedFrameMs,
            AppVersion = "phase9-step5-dev",
        };

        var startResult = await _callSession.StartAsync(audioStart).ConfigureAwait(true);
        if (!startResult.Success)
        {
            PushError($"통화 시작 실패: {startResult.FriendlyMessage}");
            LastRealtimeError = startResult.FriendlyMessage;
            CleanupCallSession();
            CallStateValue = RealtimeCallState.Idle;
            if (startedCaptureForCall && IsRunning) StopCapture();
            return;
        }
        ActiveCallId = startResult.CallId;
        PushEvent($"통화 시작: callId={startResult.CallId}");
    }

    private async Task EndCallAsync()
    {
        if (_callSession is null) return;
        if (CallStateValue is RealtimeCallState.Idle or RealtimeCallState.Ended) return;
        CallStateValue = RealtimeCallState.Ending;
        var stopResult = await _callSession.StopAsync().ConfigureAwait(true);
        if (!stopResult.Success)
        {
            PushError($"통화 종료 중 오류: {stopResult.FriendlyMessage}");
            LastRealtimeError = stopResult.FriendlyMessage;
        }
        else
        {
            PushEvent("통화 종료");
        }
        CleanupCallSession();
        if (IsRunning) StopCapture();
    }

    private void CleanupCallSession()
    {
        if (_audioSink is not null)
        {
            _audioSink.ChunkSent -= OnAudioChunkSent;
            _audioSink.SendFailed -= OnAudioSendFailed;
            _controller.RemoveExternalSink(_audioSink);
            _audioSink = null;
        }
        if (_callSession is not null)
        {
            _callSession.StateChanged -= OnCallStateChanged;
            _callSession = null;
        }
    }

    // ---------- realtime event handlers ---------- //

    private void OnSocketConnected(object? sender, EventArgs e)
    {
        _ui.Post(() =>
        {
            ConnectionState = RealtimeConnectionState.Connected;
            PushEvent("Socket.IO /calls 연결됨");
        });
    }

    private void OnSocketDisconnected(object? sender, string? reason)
    {
        _ui.Post(() =>
        {
            var hadActiveCall = _callSession is not null;
            ConnectionState = RealtimeConnectionState.Disconnected;
            CallStateValue = RealtimeCallState.Idle;
            ActiveCallId = null;
            CleanupCallSession();
            if (hadActiveCall && IsRunning) StopCapture();
            PushEvent($"Socket.IO 연결 해제: {reason ?? "(no reason)"}");
        });
    }

    private void OnSocketTransportFailed(object? sender, Exception ex)
    {
        _ui.Post(() =>
        {
            var hadActiveCall = _callSession is not null;
            ConnectionState = RealtimeConnectionState.Failed;
            LastRealtimeError = $"{ex.GetType().Name}: {ex.Message}";
            _callSession?.FailClosed();
            CleanupCallSession();
            if (hadActiveCall) CallStateValue = RealtimeCallState.Ended;
            if (hadActiveCall && IsRunning) StopCapture();
            PushError($"Socket 전송 오류: {LastRealtimeError}");
        });
    }

    private void OnSocketRuntimeError(object? sender, RealtimeErrorEvent err)
    {
        _ui.Post(() =>
        {
            var code = err.Code ?? "unknown";
            var msg = err.Message ?? "";
            LastRealtimeError = $"{code}: {msg}";
            PushError($"백엔드 런타임 오류: {code} — {msg}");
            // Plan §5.3 fail-closed: BAD_PAYLOAD / AUDIO_BACKPRESSURE 등 audio 관련
            // 오류는 capture 중단 + sink deactivate.
            if (code is "BAD_PAYLOAD" or "AUDIO_CHUNK_TOO_LARGE"
                or "AUDIO_BACKPRESSURE" or "AUDIO_SEQ_OUT_OF_ORDER")
            {
                _callSession?.FailClosed();
                if (IsRunning) StopCapture();
                CallStateValue = RealtimeCallState.Ended;
            }
        });
    }

    private void OnTranscriptPartial(object? sender, TranscriptPartialEvent ev)
    {
        _ui.Post(() =>
        {
            if (ev.Source == "agent_mic") LatestPartialAgent = ev.Text;
            else if (ev.Source == "system_loopback") LatestPartialCustomer = ev.Text;
        });
    }

    private void OnTranscriptFinal(object? sender, TranscriptEvent ev)
    {
        _ui.Post(() =>
        {
            var who = ev.Who ?? "?";
            var text = ev.Text ?? "";
            var stamped = $"[{DateTime.Now:HH:mm:ss}] {who}: {text}";
            FinalTranscripts.Insert(0, stamped);
            while (FinalTranscripts.Count > 50) FinalTranscripts.RemoveAt(FinalTranscripts.Count - 1);
        });
    }

    private void OnCallStateChanged(object? sender, RealtimeCallState newState)
    {
        _ui.Post(() => CallStateValue = newState);
    }

    private void OnAudioChunkSent(object? sender, AudioSourceId source)
    {
        if (_audioSink is null) return;
        _ui.Post(() =>
        {
            AgentMicChunksSent = _audioSink.AgentMicChunks;
            SystemLoopbackChunksSent = _audioSink.SystemLoopbackChunks;
            AgentMicBytesSent = _audioSink.AgentMicBytes;
            SystemLoopbackBytesSent = _audioSink.SystemLoopbackBytes;
        });
    }

    private void OnAudioSendFailed(object? sender, SocketIoAudioFrameSinkError err)
    {
        _ui.Post(() =>
        {
            LastRealtimeError = err.Message;
            PushError(
                $"audio_chunk 전송 실패 ({err.Source.ToWireString()} seq={err.Seq}, {err.Bytes} bytes): {err.Message}");
        });
    }

    public void Dispose()
    {
        StopPumpTimer();
        try { CleanupCallSession(); } catch { /* swallow */ }
        try { _socket.Dispose(); } catch { /* swallow */ }
        try { _auth.Dispose(); } catch { /* swallow */ }
        _controller.Dispose();
    }
}

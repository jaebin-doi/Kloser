// Phase 9 Step 5 — call lifecycle 상태 머신.
//
// Plan §5.1 happy path:
//   StartCallAsync()      -> start_call ack -> InCall
//                            audio_start emit -> ICapturedFrameSink로 활성화
//   StopCallAsync()       -> sink deactivate -> audio_end -> end_call -> Ended
//
// Plan §5.3 fail-closed (BAD_PAYLOAD / AUDIO_BACKPRESSURE 등):
//   FailClosed()          -> sink deactivate, capture stop은 VM이 별도 처리,
//                            UI는 Ended 상태로 surface.
//
// 본 클래스는 capture controller / VM과 직접 결합되지 않는다. VM이
// CallsSocketClient + sink를 가지고 와서 본 세션을 driver로 쓴다.

using Kloser.Capture.Core.Audio;

namespace Kloser.Desktop.Shell.Services.Realtime;

public sealed class RealtimeCallSession
{
    private readonly object _sync = new();
    private readonly CallsSocketClient _client;
    private readonly SocketIoAudioFrameSink _sink;
    private string? _callId;
    private RealtimeCallState _state = RealtimeCallState.Idle;

    public event EventHandler<RealtimeCallState>? StateChanged;

    public RealtimeCallState State { get { lock (_sync) return _state; } }
    public string? CallId { get { lock (_sync) return _callId; } }
    public SocketIoAudioFrameSink Sink => _sink;

    public RealtimeCallSession(CallsSocketClient client, SocketIoAudioFrameSink sink)
    {
        _client = client ?? throw new ArgumentNullException(nameof(client));
        _sink = sink ?? throw new ArgumentNullException(nameof(sink));
    }

    public async Task<RealtimeCallStartResult> StartAsync(
        AudioStartPayload audioStart,
        CancellationToken ct = default)
    {
        SetState(RealtimeCallState.Starting);
        try
        {
            var ack = await _client.EmitStartCallAsync(new StartCallPayload(), ct).ConfigureAwait(false);
            if (!string.IsNullOrEmpty(ack.Error))
            {
                SetState(RealtimeCallState.Idle);
                return RealtimeCallStartResult.Failure($"start_call ack 오류: {ack.Error}");
            }
            if (string.IsNullOrEmpty(ack.CallId))
            {
                SetState(RealtimeCallState.Idle);
                return RealtimeCallStartResult.Failure("start_call ack에 callId가 없습니다.");
            }
            lock (_sync) _callId = ack.CallId;
            // audio_start의 call_id는 백엔드 active context가 승리하므로
            // 메타로만 같이 보낸다 (디버깅 친화).
            var startWithCallId = new AudioStartPayload
            {
                CallId = ack.CallId,
                Sources = audioStart.Sources,
                FrameMs = audioStart.FrameMs,
                AppVersion = audioStart.AppVersion,
                DeviceId = audioStart.DeviceId,
            };
            await _client.EmitAudioStartAsync(startWithCallId, ct).ConfigureAwait(false);
            _sink.Activate();
            SetState(RealtimeCallState.InCall);
            return RealtimeCallStartResult.Ok(ack.CallId);
        }
        catch (Exception ex)
        {
            SetState(RealtimeCallState.Idle);
            return RealtimeCallStartResult.Failure(
                $"start 흐름 실패: {ex.GetType().Name}: {ex.Message}");
        }
    }

    public async Task<RealtimeCallStopResult> StopAsync(
        string reason = "normal",
        CancellationToken ct = default)
    {
        if (State is RealtimeCallState.Idle or RealtimeCallState.Ended)
        {
            return RealtimeCallStopResult.Ok();
        }
        SetState(RealtimeCallState.Ending);
        _sink.Deactivate();
        string? audioEndError = null;
        try
        {
            await _client.EmitAudioEndAsync(new AudioEndPayload { Reason = reason }, ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            // audio_end emit이 실패해도 end_call은 시도한다. raw audio 전송
            // 자체는 sink가 이미 deactivate된 상태이므로 안전.
            // raw byte 노출 없이 type/message만 surface.
            audioEndError = $"audio_end 실패: {ex.GetType().Name}: {ex.Message}";
        }
        EndCallAck ack;
        try
        {
            ack = await _client.EmitEndCallAsync(ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            SetState(RealtimeCallState.Ended);
            return RealtimeCallStopResult.Failure(
                $"end_call 실패: {ex.GetType().Name}: {ex.Message}");
        }
        SetState(RealtimeCallState.Ended);
        if (audioEndError is not null)
        {
            return RealtimeCallStopResult.Failure(audioEndError);
        }
        if (!ack.Ok)
        {
            return RealtimeCallStopResult.Failure(
                $"end_call ack 오류: {ack.Error ?? "unknown"}");
        }
        return RealtimeCallStopResult.Ok();
    }

    /// <summary>
    /// 백엔드 BAD_PAYLOAD / AUDIO_BACKPRESSURE 같은 fail-closed 케이스
    /// (Plan §5.3). sink만 끄고 상태는 Ended로. capture stop은 caller가
    /// 별도로 호출한다.
    /// </summary>
    public void FailClosed()
    {
        _sink.Deactivate();
        SetState(RealtimeCallState.Ended);
    }

    private void SetState(RealtimeCallState next)
    {
        bool changed;
        lock (_sync)
        {
            changed = _state != next;
            _state = next;
        }
        if (changed) StateChanged?.Invoke(this, next);
    }
}

public sealed class RealtimeCallStartResult
{
    public bool Success { get; private init; }
    public string? CallId { get; private init; }
    public string? FriendlyMessage { get; private init; }

    public static RealtimeCallStartResult Ok(string callId) => new()
    {
        Success = true,
        CallId = callId,
    };
    public static RealtimeCallStartResult Failure(string message) => new()
    {
        Success = false,
        FriendlyMessage = message,
    };
}

public sealed class RealtimeCallStopResult
{
    public bool Success { get; private init; }
    public string? FriendlyMessage { get; private init; }

    public static RealtimeCallStopResult Ok() => new() { Success = true };
    public static RealtimeCallStopResult Failure(string message) => new()
    {
        Success = false,
        FriendlyMessage = message,
    };
}

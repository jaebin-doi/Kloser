// Phase 9 Step 5 — `/calls` Socket.IO client wrapper.
//
// Plan §3.1 / §5. SocketIOClient 3.1.2 (doghappy/socket.io-client-csharp)
// 를 그대로 사용해서 backend `server/src/ws/calls.ts`의 wire와 1:1로 매칭.
//
// Wire 매핑:
//   handshake auth: { token: accessToken }
//   start_call(payload, ackCallback)   -> { callId | error, code, ... }
//   audio_start(payload)               -> error event 또는 silent
//   audio_chunk(metaPayload, byte[])   -> error event 또는 silent
//   audio_end(payload)                 -> error event 또는 silent
//   end_call(payload?, ackCallback)    -> { ok, error? }
//
//   server emits:
//     "transcript"          -> TranscriptEvent
//     "transcript.partial"  -> TranscriptPartialEvent
//     "error"               -> RealtimeErrorEvent
//
// 본 클래스는 raw PCM byte[]를 절대 저장하지 않는다. EmitAsync 호출 직후
// caller가 reference를 폐기한다.

// SocketIOClient 3.x는 클래스명과 namespace가 같아 (`SocketIOClient.SocketIO`)
// 이름 충돌이 잦다. type alias로 충돌을 차단한다.
using SioClient = SocketIOClient.SocketIO;
using SocketIOClient;
using SocketIO.Core;

namespace Kloser.Desktop.Shell.Services.Realtime;

public sealed class CallsSocketClient : IDisposable
{
    private readonly object _sync = new();
    private SioClient? _socket;
    private bool _disposed;

    // External event surface — RealtimeCallSession subscribes.
    public event EventHandler? Connected;
    public event EventHandler<string?>? Disconnected;
    public event EventHandler<TranscriptEvent>? TranscriptReceived;
    public event EventHandler<TranscriptPartialEvent>? TranscriptPartialReceived;
    public event EventHandler<RealtimeErrorEvent>? ErrorReceived;
    public event EventHandler<Exception>? TransportFailed;

    public bool IsConnected
    {
        get
        {
            lock (_sync) return _socket?.Connected == true;
        }
    }

    public async Task ConnectAsync(string baseUrl, string accessToken, CancellationToken ct = default)
    {
        if (_disposed) throw new ObjectDisposedException(nameof(CallsSocketClient));
        if (string.IsNullOrWhiteSpace(baseUrl))
        {
            throw new InvalidOperationException("백엔드 URL이 비어 있습니다.");
        }
        if (string.IsNullOrWhiteSpace(accessToken))
        {
            throw new InvalidOperationException("access token이 비어 있습니다.");
        }

        SioClient socket;
        lock (_sync)
        {
            if (_socket is not null)
            {
                throw new InvalidOperationException("이미 연결 중이거나 연결되어 있습니다.");
            }
            // /calls namespace는 URL path로 직접 넘긴다 (SocketIOClient 3.x에서
            // SocketIO.Namespace 속성이 read-only이므로 constructor URL로 지정).
            var ns = "/calls";
            var trimmed = baseUrl.TrimEnd('/');
            var uri = new Uri(trimmed + ns);
            socket = new SioClient(uri, new SocketIOOptions
            {
                EIO = EngineIO.V4,
                Reconnection = false,           // Step 5는 명시적 재연결 흐름 사용
                Auth = new { token = accessToken },
                ConnectionTimeout = TimeSpan.FromSeconds(10),
            });
            _socket = socket;
        }

        socket.OnConnected += (_, _) => Connected?.Invoke(this, EventArgs.Empty);
        socket.OnDisconnected += (_, reason) => Disconnected?.Invoke(this, reason);
        socket.OnError += (_, err) => TransportFailed?.Invoke(
            this, new InvalidOperationException(err));

        socket.On("transcript", response =>
        {
            try
            {
                var ev = response.GetValue<TranscriptEvent>(0);
                if (ev is not null) TranscriptReceived?.Invoke(this, ev);
            }
            catch (Exception ex)
            {
                TransportFailed?.Invoke(this, ex);
            }
        });
        socket.On("transcript.partial", response =>
        {
            try
            {
                var ev = response.GetValue<TranscriptPartialEvent>(0);
                if (ev is not null) TranscriptPartialReceived?.Invoke(this, ev);
            }
            catch (Exception ex)
            {
                TransportFailed?.Invoke(this, ex);
            }
        });
        socket.On("error", response =>
        {
            try
            {
                var ev = response.GetValue<RealtimeErrorEvent>(0);
                if (ev is not null) ErrorReceived?.Invoke(this, ev);
            }
            catch (Exception ex)
            {
                TransportFailed?.Invoke(this, ex);
            }
        });

        try
        {
            await socket.ConnectAsync().WaitAsync(ct).ConfigureAwait(false);
        }
        catch
        {
            lock (_sync) _socket = null;
            try { socket.Dispose(); } catch { /* swallow */ }
            throw;
        }
    }

    public async Task DisconnectAsync()
    {
        SioClient? socket;
        lock (_sync)
        {
            socket = _socket;
            _socket = null;
        }
        if (socket is null) return;
        try { await socket.DisconnectAsync().ConfigureAwait(false); } catch { /* swallow */ }
        try { socket.Dispose(); } catch { /* swallow */ }
    }

    public async Task<StartCallAck> EmitStartCallAsync(StartCallPayload payload, CancellationToken ct = default)
    {
        var socket = RequireSocket();
        var tcs = new TaskCompletionSource<StartCallAck>(TaskCreationOptions.RunContinuationsAsynchronously);
        await socket.EmitAsync("start_call", response =>
        {
            try
            {
                var ack = response.GetValue<StartCallAck>(0) ?? new StartCallAck();
                tcs.TrySetResult(ack);
            }
            catch (Exception ex)
            {
                tcs.TrySetException(ex);
            }
        }, payload).ConfigureAwait(false);
        using var reg = ct.Register(() => tcs.TrySetCanceled(ct));
        return await tcs.Task.ConfigureAwait(false);
    }

    public Task EmitAudioStartAsync(AudioStartPayload payload, CancellationToken ct = default)
    {
        var socket = RequireSocket();
        return socket.EmitAsync("audio_start", payload.ToWireObject());
    }

    /// <summary>
    /// `audio_chunk` event. meta는 첫 번째 인자, 바이너리 PCM은 두 번째
    /// 인자. SocketIOClient 3.x는 같은 EmitAsync overload로 byte[]를
    /// binary attachment로 변환한다.
    /// </summary>
    public Task EmitAudioChunkAsync(AudioChunkMetaPayload meta, byte[] pcm, CancellationToken ct = default)
    {
        var socket = RequireSocket();
        return socket.EmitAsync("audio_chunk", meta.ToWireObject(), pcm);
    }

    public Task EmitAudioEndAsync(AudioEndPayload payload, CancellationToken ct = default)
    {
        var socket = RequireSocket();
        return socket.EmitAsync("audio_end", payload.ToWireObject());
    }

    public async Task<EndCallAck> EmitEndCallAsync(CancellationToken ct = default)
    {
        var socket = RequireSocket();
        var tcs = new TaskCompletionSource<EndCallAck>(TaskCreationOptions.RunContinuationsAsynchronously);
        await socket.EmitAsync("end_call", response =>
        {
            try
            {
                var ack = response.GetValue<EndCallAck>(0) ?? new EndCallAck();
                tcs.TrySetResult(ack);
            }
            catch (Exception ex)
            {
                tcs.TrySetException(ex);
            }
        }, new { }).ConfigureAwait(false);
        using var reg = ct.Register(() => tcs.TrySetCanceled(ct));
        return await tcs.Task.ConfigureAwait(false);
    }

    private SioClient RequireSocket()
    {
        SioClient? socket;
        lock (_sync) socket = _socket;
        if (socket is null || !socket.Connected)
        {
            throw new InvalidOperationException("Socket.IO 연결이 활성 상태가 아닙니다.");
        }
        return socket;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        // DisconnectAsync는 비동기지만 Dispose 경로에서는 best-effort.
        SioClient? socket;
        lock (_sync)
        {
            socket = _socket;
            _socket = null;
        }
        if (socket is null) return;
        try { socket.DisconnectAsync().GetAwaiter().GetResult(); } catch { /* swallow */ }
        try { socket.Dispose(); } catch { /* swallow */ }
    }
}

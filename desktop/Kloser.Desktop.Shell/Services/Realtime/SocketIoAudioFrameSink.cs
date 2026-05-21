// Phase 9 Step 5 — `ICapturedFrameSink`로 캡처 엔진과 backend를 잇는 어댑터.
//
// Plan §4.3 책임:
//   * CapturedAudioFrame -> AudioChunkMetaPayload + raw byte[] 전송.
//   * source별 sequence counter (1부터 monotonically increasing).
//   * binary PCM은 그대로 보내고 sink reference는 OnFrameAsync return 이후 폐기.
//   * send 실패는 직접 UI에 노출하지 않고 RealtimeCallSession이 받는다.
//
// 정책:
//   * raw byte[] 누설 금지 — exception message / log / counter 어디에도
//     pcm 바이트를 포함하지 않는다.
//   * declared sources 안에 있는 source만 전송. 다른 source가 도달하면
//     dropped 카운터만 증가시키고 send 자체는 skip.
//   * call이 아직 active가 아닌 동안 frame이 들어오면 silently drop.

using Kloser.Capture.Core.Audio;
using Kloser.Desktop.Shell.Services;

namespace Kloser.Desktop.Shell.Services.Realtime;

public sealed class SocketIoAudioFrameSink : ICapturedFrameSink
{
    private readonly CallsSocketClient _client;
    private readonly HashSet<AudioSourceId> _declaredSources;
    private long _agentMicSeq;
    private long _systemLoopbackSeq;
    private long _agentMicBytes;
    private long _systemLoopbackBytes;
    private long _agentMicChunks;
    private long _systemLoopbackChunks;
    private long _droppedChunks;
    private long _failedSends;
    private bool _isActive;

    /// <summary>
    /// Raised when a chunk is accepted (post-emit). Consumers can read
    /// the counters via the properties below.
    /// </summary>
    public event EventHandler<AudioSourceId>? ChunkSent;

    /// <summary>
    /// Raised when EmitAudioChunkAsync throws. The exception is wrapped
    /// in a friendly message — RealtimeCallSession decides whether to
    /// fail closed (per Step 5 Plan §5.3).
    /// </summary>
    public event EventHandler<SocketIoAudioFrameSinkError>? SendFailed;

    public bool IsActive => _isActive;
    public long AgentMicChunks => Interlocked.Read(ref _agentMicChunks);
    public long SystemLoopbackChunks => Interlocked.Read(ref _systemLoopbackChunks);
    public long AgentMicBytes => Interlocked.Read(ref _agentMicBytes);
    public long SystemLoopbackBytes => Interlocked.Read(ref _systemLoopbackBytes);
    public long DroppedChunks => Interlocked.Read(ref _droppedChunks);
    public long FailedSends => Interlocked.Read(ref _failedSends);

    public SocketIoAudioFrameSink(
        CallsSocketClient client,
        IEnumerable<AudioSourceId> declaredSources)
    {
        _client = client ?? throw new ArgumentNullException(nameof(client));
        _declaredSources = new HashSet<AudioSourceId>(declaredSources);
        if (_declaredSources.Count == 0)
        {
            throw new ArgumentException(
                "declaredSources must contain at least one source",
                nameof(declaredSources));
        }
    }

    public void Activate() => _isActive = true;
    public void Deactivate() => _isActive = false;

    public async ValueTask OnFrameAsync(CapturedAudioFrame frame, CancellationToken ct)
    {
        if (!_isActive)
        {
            // call이 아직 시작 전 / 이미 종료 후 — silently drop, raw audio
            // 누설 없음.
            Interlocked.Increment(ref _droppedChunks);
            return;
        }
        if (!_declaredSources.Contains(frame.Source))
        {
            // audio_start에 선언되지 않은 source는 backend가 BAD_PAYLOAD로
            // 거부할 것이므로 사전에 skip.
            Interlocked.Increment(ref _droppedChunks);
            return;
        }
        if (frame.Pcm is null || frame.Pcm.Length == 0)
        {
            Interlocked.Increment(ref _droppedChunks);
            return;
        }

        long seq = frame.Source == AudioSourceId.AgentMic
            ? Interlocked.Increment(ref _agentMicSeq)
            : Interlocked.Increment(ref _systemLoopbackSeq);

        var meta = new AudioChunkMetaPayload
        {
            Seq = seq,
            Source = frame.Source.ToWireString(),
            DurationMs = frame.DurationMs,
            StartedAtMs = frame.StartedAtMs,
        };

        try
        {
            await _client.EmitAudioChunkAsync(meta, frame.Pcm, ct).ConfigureAwait(false);
            if (frame.Source == AudioSourceId.AgentMic)
            {
                Interlocked.Increment(ref _agentMicChunks);
                Interlocked.Add(ref _agentMicBytes, frame.Pcm.Length);
            }
            else
            {
                Interlocked.Increment(ref _systemLoopbackChunks);
                Interlocked.Add(ref _systemLoopbackBytes, frame.Pcm.Length);
            }
            ChunkSent?.Invoke(this, frame.Source);
        }
        catch (Exception ex)
        {
            Interlocked.Increment(ref _failedSends);
            // exception payload에 raw byte 포함되지 않도록 길이 / source / seq만 surface.
            SendFailed?.Invoke(this, new SocketIoAudioFrameSinkError(
                Source: frame.Source,
                Seq: seq,
                Bytes: frame.Pcm.Length,
                Message: $"{ex.GetType().Name}: {ex.Message}"));
        }
    }
}

public sealed record SocketIoAudioFrameSinkError(
    AudioSourceId Source,
    long Seq,
    int Bytes,
    string Message
);

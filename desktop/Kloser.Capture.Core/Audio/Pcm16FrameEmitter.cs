// Phase 9 Step 3 — frame slicer + per-source seq + bounded queue.
//
// Plan §7.4 / §7.5.
//
// Responsibilities:
//   * Accumulate PCM16 16 kHz mono bytes coming out of Pcm16Resampler.
//   * Emit exact frame-sized chunks based on options.FrameMs.
//   * Maintain per-source monotonic seq starting at 1.
//   * Track started_at_ms relative to capture session start.
//   * Apply a bounded in-memory queue. If the consumer cannot drain,
//     drop the oldest frame and increment FramesDropped — never block
//     the WASAPI capture callback (Plan §7.5).
//
// What this class does NOT do:
//   * Talk to backend or Azure.
//   * Persist anywhere except in the bounded queue.
//   * Stringify or log raw PCM bytes.

namespace Kloser.Capture.Core.Audio;

public sealed class Pcm16FrameEmitter
{
    private readonly object _sync = new();
    private readonly AudioSourceId _source;
    private readonly int _frameByteSize;
    private readonly int _frameMs;
    private readonly Queue<CapturedAudioFrame> _queue;
    private readonly int _queueCap; // frames; defaults to 5 seconds worth

    private readonly byte[] _pending; // accumulates normalized bytes
    private int _pendingLen;
    private long _seq;
    private readonly long _sessionStartMs;
    private long _framesEmitted;
    private long _framesDropped;

    public AudioSourceId Source => _source;
    public long FramesEmitted { get { lock (_sync) return _framesEmitted; } }
    public long FramesDropped { get { lock (_sync) return _framesDropped; } }

    public int FrameByteSize => _frameByteSize;
    public int FrameMs => _frameMs;

    public Pcm16FrameEmitter(
        AudioSourceId source,
        int frameMs,
        long sessionStartMs,
        int? queueCapFrames = null)
    {
        if (Array.IndexOf(CaptureOptions.AllowedFrameMs, frameMs) < 0)
        {
            throw new ArgumentOutOfRangeException(
                nameof(frameMs),
                frameMs,
                "frameMs must be one of " + string.Join("/", CaptureOptions.AllowedFrameMs));
        }
        _source = source;
        _frameMs = frameMs;
        _frameByteSize = (CaptureOptions.SampleRateHz * frameMs / 1000)
            * CaptureOptions.Channels
            * CaptureOptions.BytesPerSample;
        // 5 seconds of frames per Plan §7.5.
        var defaultCap = (5 * 1000) / frameMs;
        _queueCap = queueCapFrames ?? defaultCap;
        // Allocate up to two frames of slack so we never reallocate on
        // a normal capture buffer slightly larger than one frame.
        _pending = new byte[_frameByteSize * 2 + _frameByteSize];
        _pendingLen = 0;
        _seq = 0;
        _sessionStartMs = sessionStartMs;
        _queue = new Queue<CapturedAudioFrame>(_queueCap);
    }

    /// <summary>
    /// Push normalized PCM16 16 kHz mono bytes. Returns the number of
    /// frames produced and enqueued by this call.
    /// </summary>
    public int Push(byte[] pcm, int offset, int count)
    {
        if (pcm is null) throw new ArgumentNullException(nameof(pcm));
        if (count <= 0) return 0;

        int produced = 0;
        lock (_sync)
        {
            int read = 0;
            while (read < count)
            {
                int want = _frameByteSize - _pendingLen;
                int take = Math.Min(want, count - read);
                EnsurePending(_pendingLen + take);
                Buffer.BlockCopy(pcm, offset + read, _pending, _pendingLen, take);
                _pendingLen += take;
                read += take;
                if (_pendingLen >= _frameByteSize)
                {
                    EmitOneLocked();
                    produced++;
                }
            }
        }
        return produced;
    }

    private void EnsurePending(int neededSize)
    {
        if (neededSize <= _pending.Length) return;
        // Defensive: we sized the buffer for two-frame slack already.
        // Bigger inputs are split across multiple Push iterations.
        throw new InvalidOperationException(
            $"frame accumulator overflow: needed {neededSize}, have {_pending.Length}");
    }

    private void EmitOneLocked()
    {
        var bytes = new byte[_frameByteSize];
        Buffer.BlockCopy(_pending, 0, bytes, 0, _frameByteSize);
        // Shift any extra past the frame down to the start of pending.
        int extra = _pendingLen - _frameByteSize;
        if (extra > 0)
        {
            Buffer.BlockCopy(_pending, _frameByteSize, _pending, 0, extra);
        }
        _pendingLen = extra;

        _seq += 1;
        long startedAt = (_seq - 1) * _frameMs;
        var frame = new CapturedAudioFrame(
            Source: _source,
            Seq: _seq,
            Codec: "pcm_s16le",
            SampleRateHz: CaptureOptions.SampleRateHz,
            Channels: CaptureOptions.Channels,
            DurationMs: _frameMs,
            StartedAtMs: startedAt,
            Pcm: bytes
        );

        // Bounded queue: drop oldest if at cap.
        while (_queue.Count >= _queueCap)
        {
            _ = _queue.Dequeue();
            _framesDropped += 1;
        }
        _queue.Enqueue(frame);
        _framesEmitted += 1;
    }

    /// <summary>
    /// Drain at most maxCount frames. Used by the consumer loop.
    /// Bytes ownership transfers to the caller; the emitter no longer
    /// holds a reference. PoC consumer typically just inspects level
    /// + (optional) writes to diagnostic WAV.
    /// </summary>
    public List<CapturedAudioFrame> Drain(int maxCount)
    {
        var result = new List<CapturedAudioFrame>(maxCount);
        lock (_sync)
        {
            int n = Math.Min(maxCount, _queue.Count);
            for (int i = 0; i < n; i++)
            {
                result.Add(_queue.Dequeue());
            }
        }
        return result;
    }

    /// <summary>Drop pending bytes and clear the queue. Used at shutdown.</summary>
    public void Reset()
    {
        lock (_sync)
        {
            _queue.Clear();
            _pendingLen = 0;
        }
    }
}

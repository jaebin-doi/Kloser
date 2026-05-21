// Phase 9 Step 6 — call archive WAV writer.
//
// Plan: docs/plan/phase-9/PHASE_9_STEP_6_PLAN.md §4 / §5.1.
//
// Combines per-source PCM16 16 kHz mono frames (agent_mic / system_loopback)
// into a single stereo WAV file:
//   * left  channel = agent_mic
//   * right channel = system_loopback
//   * sample_rate_hz = 16000
//   * bit_depth      = 16
//   * channels       = 2
//   * codec          = pcm_s16le_stereo_16000
//   * content_type   = audio/wav
//
// Design (Plan §4.2):
//   Frames from the two sources arrive interleaved per pump tick and do
//   NOT necessarily arrive in strict time order. To stay sample-accurate
//   with bounded memory we keep two raw per-source PCM scratch files
//   under the call's local temp directory. Each frame writes to its
//   source's scratch file at `(StartedAtMs / 1000) * 16000 * 2` bytes;
//   NTFS auto-zero-fills any gap created by seek+write past EOF, so
//   missing-time windows naturally become silence.
//
//   On `CompleteAsync()` we close both scratches, take the longer one
//   as the canonical length, read both back in chunks, and emit one
//   PCM16 stereo WAV with the standard 44-byte header. SHA-256 is
//   streamed during emit so we never have to re-read the WAV.
//
// What we DO NOT do:
//   * log raw PCM bytes (counter / size / duration only)
//   * keep partial archives around — caller deletes the temp dir on
//     either success or failure (Plan §5.3).
//
// Memory bound: at most one buffered chunk per channel during emit.
// 30 min call = ~115 MB on disk across the two scratches + one WAV;
// resident memory stays in the tens of KB.

using System.Security.Cryptography;
using Kloser.Capture.Core.Audio;

namespace Kloser.Capture.Core.Recording;

public sealed class CallArchiveWavWriter : IAsyncDisposable
{
    private const int SampleRateHz = 16000;
    private const int Channels = 2;
    private const int BytesPerSampleMono = 2;
    private const int BytesPerFrameStereo = Channels * BytesPerSampleMono; // 4

    private readonly object _sync = new();
    private readonly string _scratchDir;
    private readonly string _agentMicPath;
    private readonly string _loopbackPath;
    private readonly long _sessionStartMsUtc;

    private FileStream? _agentMicStream;
    private FileStream? _loopbackStream;
    private long _agentMicFrames;
    private long _loopbackFrames;
    private long _droppedFrames;
    private long _maxStereoSampleIndex; // exclusive end (one past the last sample)
    private bool _disposed;
    private bool _completed;

    public CallArchiveWavWriter(string scratchDir, long sessionStartMsUtc)
    {
        if (string.IsNullOrWhiteSpace(scratchDir))
        {
            throw new ArgumentException(
                "scratchDir must be a non-empty directory",
                nameof(scratchDir));
        }
        _scratchDir = scratchDir;
        _sessionStartMsUtc = sessionStartMsUtc;
        Directory.CreateDirectory(_scratchDir);
        _agentMicPath = Path.Combine(_scratchDir, "agent_mic.pcm");
        _loopbackPath = Path.Combine(_scratchDir, "system_loopback.pcm");
        _agentMicStream = OpenScratch(_agentMicPath);
        _loopbackStream = OpenScratch(_loopbackPath);
    }

    private static FileStream OpenScratch(string path)
    {
        return new FileStream(
            path,
            FileMode.Create,
            FileAccess.ReadWrite,
            FileShare.None,
            bufferSize: 64 * 1024,
            FileOptions.WriteThrough);
    }

    public long AgentMicFrames { get { lock (_sync) return _agentMicFrames; } }
    public long SystemLoopbackFrames { get { lock (_sync) return _loopbackFrames; } }
    public long DroppedFrames { get { lock (_sync) return _droppedFrames; } }

    public TimeSpan CurrentDuration
    {
        get
        {
            lock (_sync)
            {
                if (_maxStereoSampleIndex <= 0) return TimeSpan.Zero;
                double seconds = (double)_maxStereoSampleIndex / SampleRateHz;
                return TimeSpan.FromSeconds(seconds);
            }
        }
    }

    public long CurrentScratchBytes
    {
        get
        {
            lock (_sync)
            {
                long a = _agentMicStream?.Length ?? 0;
                long b = _loopbackStream?.Length ?? 0;
                return a + b;
            }
        }
    }

    /// <summary>
    /// Append a captured frame to its source's scratch file. Frames whose
    /// `StartedAtMs` is before zero (clock drift) or whose channel
    /// scratch stream is no longer open are silently dropped — the
    /// `DroppedFrames` counter rises so the UI can surface it without
    /// the writer aborting the whole archive.
    /// </summary>
    public void Write(CapturedAudioFrame frame)
    {
        if (frame is null) return;
        if (frame.Pcm is null || frame.Pcm.Length == 0) return;
        if (frame.StartedAtMs < 0)
        {
            Interlocked.Increment(ref _droppedFrames);
            return;
        }
        if (frame.SampleRateHz != SampleRateHz || frame.Channels != 1)
        {
            // Capture.Core normalizes to PCM16 16 kHz mono. Anything else
            // is a contract bug at the source — count and skip rather
            // than corrupt the WAV.
            Interlocked.Increment(ref _droppedFrames);
            return;
        }
        lock (_sync)
        {
            if (_completed || _disposed) return;
            FileStream? target = frame.Source switch
            {
                AudioSourceId.AgentMic => _agentMicStream,
                AudioSourceId.SystemLoopback => _loopbackStream,
                _ => null,
            };
            if (target is null)
            {
                _droppedFrames++;
                return;
            }
            long startedAtSample = (long)Math.Round(
                (double)frame.StartedAtMs * SampleRateHz / 1000.0);
            long byteOffset = startedAtSample * BytesPerSampleMono;
            // Seek past EOF triggers NTFS zero-fill on the next write —
            // the gap becomes silence automatically. We do NOT call
            // SetLength explicitly to keep the file sparse where possible.
            target.Seek(byteOffset, SeekOrigin.Begin);
            target.Write(frame.Pcm, 0, frame.Pcm.Length);

            long monoSampleCount = frame.Pcm.Length / BytesPerSampleMono;
            long endSample = startedAtSample + monoSampleCount;
            if (endSample > _maxStereoSampleIndex)
            {
                _maxStereoSampleIndex = endSample;
            }
            if (frame.Source == AudioSourceId.AgentMic) _agentMicFrames++;
            else if (frame.Source == AudioSourceId.SystemLoopback) _loopbackFrames++;
        }
    }

    /// <summary>
    /// Close per-source scratches and emit a single stereo PCM16 WAV at
    /// <paramref name="outputWavPath"/>. Streams SHA-256 during emit so
    /// the returned metadata is final without a second file read. Caller
    /// owns deletion of the scratch dir afterwards.
    /// </summary>
    public async Task<CallArchiveResult> CompleteAsync(string outputWavPath, CancellationToken ct = default)
    {
        FileStream? mic;
        FileStream? loop;
        long endSample;
        lock (_sync)
        {
            if (_completed)
            {
                throw new InvalidOperationException("archive already completed");
            }
            _completed = true;
            mic = _agentMicStream;
            loop = _loopbackStream;
            _agentMicStream = null;
            _loopbackStream = null;
            endSample = _maxStereoSampleIndex;
        }

        // Close scratch streams so we can reopen for read at offset 0.
        try { mic?.Flush(); } catch { /* swallow */ }
        try { loop?.Flush(); } catch { /* swallow */ }
        try { mic?.Dispose(); } catch { /* swallow */ }
        try { loop?.Dispose(); } catch { /* swallow */ }

        Directory.CreateDirectory(Path.GetDirectoryName(outputWavPath)
            ?? throw new ArgumentException(
                "outputWavPath has no directory", nameof(outputWavPath)));

        await using var output = new FileStream(
            outputWavPath,
            FileMode.Create,
            FileAccess.ReadWrite,
            FileShare.None,
            bufferSize: 64 * 1024,
            FileOptions.WriteThrough);

        long dataSize = endSample * BytesPerFrameStereo;
        WriteWavHeader(output, dataSize);

        // Stream-interleave both scratch files. If one ended early, fill
        // its channel with zeros for the rest.
        await using var micRead = OpenScratchForRead(_agentMicPath);
        await using var loopRead = OpenScratchForRead(_loopbackPath);

        using var sha = SHA256.Create();
        // Hash the header bytes that we just wrote.
        long savedPos = output.Position;
        output.Seek(0, SeekOrigin.Begin);
        var headerBytes = new byte[44];
        await output.ReadAsync(headerBytes.AsMemory(0, 44), ct).ConfigureAwait(false);
        sha.TransformBlock(headerBytes, 0, 44, null, 0);
        output.Seek(savedPos, SeekOrigin.Begin);

        const int interleaveStereoFrames = 1024; // 4 KB stereo at a time
        var leftBuf = new byte[interleaveStereoFrames * BytesPerSampleMono];
        var rightBuf = new byte[interleaveStereoFrames * BytesPerSampleMono];
        var stereoBuf = new byte[interleaveStereoFrames * BytesPerFrameStereo];

        long remaining = endSample;
        while (remaining > 0)
        {
            int wantSamples = (int)Math.Min(remaining, interleaveStereoFrames);
            int wantBytes = wantSamples * BytesPerSampleMono;
            int gotMic = await ReadFullyZeroPad(micRead, leftBuf, wantBytes, ct).ConfigureAwait(false);
            int gotLoop = await ReadFullyZeroPad(loopRead, rightBuf, wantBytes, ct).ConfigureAwait(false);
            // We don't care about gotMic/gotLoop's actual byte count;
            // ReadFullyZeroPad guarantees the requested length is filled
            // (zero-padded where the scratch ended early).
            _ = gotMic; _ = gotLoop;

            // Interleave: stereoBuf[2*i .. 2*i+1] = left, [2*i+2 .. 2*i+3] = right.
            for (int i = 0; i < wantSamples; i++)
            {
                int outOff = i * BytesPerFrameStereo;
                int inOff = i * BytesPerSampleMono;
                stereoBuf[outOff]     = leftBuf[inOff];
                stereoBuf[outOff + 1] = leftBuf[inOff + 1];
                stereoBuf[outOff + 2] = rightBuf[inOff];
                stereoBuf[outOff + 3] = rightBuf[inOff + 1];
            }
            int stereoBytes = wantSamples * BytesPerFrameStereo;
            await output.WriteAsync(stereoBuf.AsMemory(0, stereoBytes), ct).ConfigureAwait(false);
            sha.TransformBlock(stereoBuf, 0, stereoBytes, null, 0);
            remaining -= wantSamples;
        }

        sha.TransformFinalBlock(Array.Empty<byte>(), 0, 0);
        string hex = ToHex(sha.Hash ?? Array.Empty<byte>());

        await output.FlushAsync(ct).ConfigureAwait(false);
        long totalSize = output.Length;

        double seconds = (double)endSample / SampleRateHz;
        int durationSeconds = (int)Math.Round(seconds);

        return new CallArchiveResult(
            OutputPath: outputWavPath,
            DurationSeconds: durationSeconds,
            SizeBytes: totalSize,
            ChecksumSha256: hex,
            AgentMicFrames: _agentMicFrames,
            SystemLoopbackFrames: _loopbackFrames,
            DroppedFrames: _droppedFrames,
            ContentType: "audio/wav",
            Codec: "pcm_s16le_stereo_16000"
        );
    }

    private static FileStream OpenScratchForRead(string path)
    {
        return new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            bufferSize: 64 * 1024);
    }

    private static async Task<int> ReadFullyZeroPad(FileStream src, byte[] dst, int wantBytes, CancellationToken ct)
    {
        int filled = 0;
        while (filled < wantBytes)
        {
            int read = await src.ReadAsync(dst.AsMemory(filled, wantBytes - filled), ct).ConfigureAwait(false);
            if (read <= 0) break;
            filled += read;
        }
        if (filled < wantBytes)
        {
            Array.Clear(dst, filled, wantBytes - filled);
        }
        return filled;
    }

    private static void WriteWavHeader(FileStream output, long dataSize)
    {
        // Standard 44-byte RIFF/WAVE/PCM header.
        // Riff chunk
        WriteAscii(output, "RIFF");
        WriteUInt32LE(output, (uint)Math.Min(uint.MaxValue, dataSize + 36));
        WriteAscii(output, "WAVE");
        // fmt chunk
        WriteAscii(output, "fmt ");
        WriteUInt32LE(output, 16);       // fmt chunk size
        WriteUInt16LE(output, 1);        // PCM
        WriteUInt16LE(output, (ushort)Channels);
        WriteUInt32LE(output, SampleRateHz);
        WriteUInt32LE(output, SampleRateHz * Channels * BytesPerSampleMono); // byte rate
        WriteUInt16LE(output, (ushort)(Channels * BytesPerSampleMono));      // block align
        WriteUInt16LE(output, 16);       // bits per sample
        // data chunk
        WriteAscii(output, "data");
        WriteUInt32LE(output, (uint)Math.Min(uint.MaxValue, dataSize));
    }

    private static void WriteAscii(FileStream output, string s)
    {
        var bytes = new byte[s.Length];
        for (int i = 0; i < s.Length; i++) bytes[i] = (byte)s[i];
        output.Write(bytes, 0, bytes.Length);
    }
    private static void WriteUInt32LE(FileStream output, uint v)
    {
        output.WriteByte((byte)(v & 0xff));
        output.WriteByte((byte)((v >> 8) & 0xff));
        output.WriteByte((byte)((v >> 16) & 0xff));
        output.WriteByte((byte)((v >> 24) & 0xff));
    }
    private static void WriteUInt16LE(FileStream output, ushort v)
    {
        output.WriteByte((byte)(v & 0xff));
        output.WriteByte((byte)((v >> 8) & 0xff));
    }
    private static string ToHex(byte[] bytes)
    {
        var chars = new char[bytes.Length * 2];
        const string hex = "0123456789abcdef";
        for (int i = 0; i < bytes.Length; i++)
        {
            chars[i * 2]     = hex[(bytes[i] >> 4) & 0xf];
            chars[i * 2 + 1] = hex[bytes[i] & 0xf];
        }
        return new string(chars);
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;
        FileStream? mic;
        FileStream? loop;
        lock (_sync)
        {
            mic = _agentMicStream;
            loop = _loopbackStream;
            _agentMicStream = null;
            _loopbackStream = null;
        }
        if (mic is not null) await mic.DisposeAsync().ConfigureAwait(false);
        if (loop is not null) await loop.DisposeAsync().ConfigureAwait(false);
    }
}

public sealed record CallArchiveResult(
    string OutputPath,
    int DurationSeconds,
    long SizeBytes,
    string ChecksumSha256,
    long AgentMicFrames,
    long SystemLoopbackFrames,
    long DroppedFrames,
    string ContentType,
    string Codec
);

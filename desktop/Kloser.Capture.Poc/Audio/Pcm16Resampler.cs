// Phase 9 Step 3 — native WASAPI → PCM16 16 kHz mono normalizer.
//
// Plan §7.3 — the conversion boundary is isolated here. Capture sources
// hand raw native bytes (any sample format, any sample rate, any
// channel layout NAudio reports). This class hands back deterministic
// PCM16 16 kHz mono bytes that the FrameEmitter can slice.
//
// PoC quality:
//   * Linear-interpolation resampling. Adequate for speech-quality
//     mic input. Music / loopback content above 8 kHz will alias
//     because we do not apply a pre-decimation low-pass filter.
//     Step 5 / production can swap in WdlResampler or
//     MediaFoundationResampler behind this class boundary.
//   * Downmix is simple channel-average (L+R+...)/N. Step 5 can
//     adopt a perceptual downmix.
//
// What we DO guarantee:
//   * Float32 / Pcm16 / Pcm24 / Pcm32 inputs all flow through.
//   * Output is byte-exact PCM16 little-endian at exactly 16000 Hz mono.
//   * No internal buffering of raw native bytes beyond one call.

using NAudio.Wave;

namespace Kloser.Capture.Poc.Audio;

public sealed class Pcm16Resampler
{
    private readonly WaveFormat _nativeFormat;
    private readonly int _nativeChannels;
    private readonly int _nativeSampleRate;
    private readonly bool _nativeIsFloat;
    private readonly int _nativeBytesPerSample;
    private readonly double _stepIn; // input frames consumed per 1 output frame

    /// <summary>
    /// Carry-over state between Convert() calls: the last input sample
    /// per channel (for linear interpolation across buffer boundaries)
    /// and the fractional position into the input stream.
    /// </summary>
    private float[] _prevMonoTail = new float[1];
    private double _fracPos; // 0 means "next output samples next input"

    public int TargetSampleRate => CaptureOptions.SampleRateHz;
    public int TargetChannels => CaptureOptions.Channels;

    public Pcm16Resampler(WaveFormat nativeFormat)
    {
        _nativeFormat = nativeFormat ?? throw new ArgumentNullException(nameof(nativeFormat));
        _nativeChannels = nativeFormat.Channels;
        _nativeSampleRate = nativeFormat.SampleRate;
        _nativeBytesPerSample = nativeFormat.BitsPerSample / 8;
        _nativeIsFloat = nativeFormat.Encoding == WaveFormatEncoding.IeeeFloat;
        if (!_nativeIsFloat && nativeFormat.Encoding != WaveFormatEncoding.Pcm)
        {
            throw new NotSupportedException(
                $"native format {nativeFormat.Encoding} not supported; expected PCM or IEEE float");
        }
        if (_nativeChannels < 1 || _nativeChannels > 8)
        {
            throw new NotSupportedException(
                $"unsupported channel count {_nativeChannels}");
        }
        _stepIn = (double)_nativeSampleRate / CaptureOptions.SampleRateHz;
    }

    /// <summary>
    /// Convert one chunk of native bytes. The returned byte[] is
    /// freshly allocated PCM16 little-endian 16 kHz mono. Length may
    /// be 0 when too few input samples were provided to advance even
    /// one output sample given prior fractional carry-over.
    /// </summary>
    public byte[] Convert(byte[] nativeBuffer, int offset, int count)
    {
        if (nativeBuffer is null) throw new ArgumentNullException(nameof(nativeBuffer));
        if (count <= 0) return Array.Empty<byte>();

        // 1. Decode native bytes to mono float32 at native rate.
        int frameByteSize = _nativeBytesPerSample * _nativeChannels;
        if (count % frameByteSize != 0)
        {
            // Truncate to a whole-frame boundary. WASAPI generally
            // delivers full frames; this is defensive.
            count -= count % frameByteSize;
            if (count <= 0) return Array.Empty<byte>();
        }
        int nativeFrameCount = count / frameByteSize;
        Span<float> mono = nativeFrameCount <= 8192
            ? stackalloc float[8192].Slice(0, nativeFrameCount)
            : new float[nativeFrameCount];

        DecodeToMonoFloat(nativeBuffer.AsSpan(offset, count), mono);

        // 2. Resample mono float to target rate via linear interpolation.
        //    Output frame count is approximately nativeFrameCount / stepIn,
        //    accounting for the fractional carry-over state.
        //    Estimate generously to avoid a second allocation.
        int outCapacity = (int)Math.Ceiling((nativeFrameCount + 1) / _stepIn) + 2;
        var outFloat = new float[outCapacity];
        int outCount = LinearResample(mono, outFloat);

        // 3. Convert to PCM16 little-endian bytes.
        var pcm = new byte[outCount * 2];
        for (int i = 0; i < outCount; i++)
        {
            float s = outFloat[i];
            if (s > 1f) s = 1f; else if (s < -1f) s = -1f;
            short v = (short)Math.Round(s * 32767f);
            pcm[i * 2] = (byte)(v & 0xff);
            pcm[i * 2 + 1] = (byte)((v >> 8) & 0xff);
        }
        return pcm;
    }

    private void DecodeToMonoFloat(ReadOnlySpan<byte> src, Span<float> dst)
    {
        int channels = _nativeChannels;
        int bps = _nativeBytesPerSample;
        int frames = dst.Length;
        for (int f = 0; f < frames; f++)
        {
            int baseOff = f * channels * bps;
            float sum = 0f;
            for (int c = 0; c < channels; c++)
            {
                int o = baseOff + c * bps;
                float sample;
                if (_nativeIsFloat)
                {
                    // IEEE float32
                    sample = BitConverter.ToSingle(src.Slice(o, 4));
                }
                else
                {
                    // PCM — read MSB-aligned signed integer, scale to [-1,1]
                    sample = bps switch
                    {
                        2 => (short)(src[o] | (src[o + 1] << 8)) / 32768f,
                        3 => ReadPcm24(src.Slice(o, 3)) / 8388608f,
                        4 => (src[o] | (src[o + 1] << 8) | (src[o + 2] << 16) | (src[o + 3] << 24)) / 2147483648f,
                        _ => throw new NotSupportedException($"unsupported PCM bit depth: {bps * 8}"),
                    };
                }
                sum += sample;
            }
            dst[f] = sum / channels;
        }
    }

    private static int ReadPcm24(ReadOnlySpan<byte> b)
    {
        int v = b[0] | (b[1] << 8) | (b[2] << 16);
        if ((v & 0x800000) != 0) v |= unchecked((int)0xff000000);
        return v;
    }

    /// <summary>
    /// Linear-interpolation resampler with carry-over state across
    /// Convert() invocations. Returns the number of output samples
    /// actually written to <paramref name="dst"/>.
    /// </summary>
    private int LinearResample(ReadOnlySpan<float> src, Span<float> dst)
    {
        int written = 0;
        // _prevMonoTail[0] holds the last source sample from the
        // previous call so we can interpolate across the boundary.
        // _fracPos in [0, 1) is the fractional output-sample position
        // between _prevMonoTail[0] and src[0]; or between src[i] and
        // src[i+1] after the first iteration.
        double pos = _fracPos; // input-domain position
        int srcLen = src.Length;
        while (true)
        {
            int iLow = (int)Math.Floor(pos);
            double frac = pos - iLow;
            // We need samples at indexes iLow and iLow+1.
            float a, b;
            if (iLow < 0)
            {
                // Reading into the previous-tail slot.
                a = _prevMonoTail[0];
                b = srcLen > 0 ? src[0] : a;
            }
            else if (iLow + 1 < srcLen)
            {
                a = src[iLow];
                b = src[iLow + 1];
            }
            else
            {
                // Need src[iLow] and src[iLow+1]; not enough input.
                break;
            }
            float s = (float)(a + (b - a) * frac);
            if (written >= dst.Length) break;
            dst[written++] = s;
            pos += _stepIn;
        }

        // Save the last source sample for the next call's interpolation,
        // and shift _fracPos to be relative to "next src[0]".
        if (srcLen > 0)
        {
            _prevMonoTail[0] = src[srcLen - 1];
        }
        _fracPos = pos - srcLen;
        return written;
    }
}

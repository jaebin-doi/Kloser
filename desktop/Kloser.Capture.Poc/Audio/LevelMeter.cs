// Phase 9 Step 3 — peak / RMS / silence-flag computation.
//
// Plan §7.6. Lightweight; runs on the capture thread per data buffer.
// Never logs raw sample bytes. Outputs three scalars only.

namespace Kloser.Capture.Poc.Audio;

public sealed class LevelMeter
{
    // Silence floor at roughly -60 dBFS. Movements below this report
    // as silent; the status renderer uses this for the silence flag.
    private const double SilenceFloor = 0.001;

    private readonly object _sync = new();
    private double _peak;
    private double _rms;
    private bool _silent = true;

    public double LastPeak { get { lock (_sync) return _peak; } }
    public double LastRms { get { lock (_sync) return _rms; } }
    public bool LastSilent { get { lock (_sync) return _silent; } }

    /// <summary>
    /// Update peak / RMS from a PCM16 little-endian byte buffer.
    /// Buffer ownership is unchanged; this only reads.
    /// </summary>
    public void Observe(byte[] pcm16)
    {
        if (pcm16 is null || pcm16.Length < 2) return;
        int sampleCount = pcm16.Length / 2;
        double peak = 0;
        double sumSquares = 0;
        for (int i = 0; i < sampleCount; i++)
        {
            short s = (short)(pcm16[i * 2] | (pcm16[i * 2 + 1] << 8));
            double v = s / 32768.0;
            double av = v < 0 ? -v : v;
            if (av > peak) peak = av;
            sumSquares += v * v;
        }
        double rms = sampleCount > 0 ? Math.Sqrt(sumSquares / sampleCount) : 0;
        bool silent = peak < SilenceFloor && rms < SilenceFloor;
        lock (_sync)
        {
            _peak = peak;
            _rms = rms;
            _silent = silent;
        }
    }
}

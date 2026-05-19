// Phase 9 Step 3 — console status renderer.
//
// Plan §7.6 status sample shape. Refreshes every status-interval-ms.

using Kloser.Capture.Poc.Audio;

namespace Kloser.Capture.Poc.Diagnostics;

public sealed class StatusRenderer
{
    private readonly long _sessionStartMs;

    public StatusRenderer(long sessionStartMs)
    {
        _sessionStartMs = sessionStartMs;
    }

    public string Render(
        CaptureSourceStatus? mic,
        CaptureSourceStatus? loopback)
    {
        long elapsedMs = Math.Max(0, NowMs() - _sessionStartMs);
        var t = TimeSpan.FromMilliseconds(elapsedMs);
        var sb = new System.Text.StringBuilder(160);
        sb.Append(t.ToString(@"hh\:mm\:ss"));
        sb.Append(" | ");
        AppendSource(sb, "mic", mic);
        sb.Append(" | ");
        AppendSource(sb, "loopback", loopback);
        sb.Append(" | mem=");
        sb.Append(Math.Round(GC.GetTotalMemory(false) / 1024.0 / 1024.0, 1));
        sb.Append("MB");
        return sb.ToString();
    }

    private static void AppendSource(System.Text.StringBuilder sb, string label, CaptureSourceStatus? s)
    {
        if (s is null)
        {
            sb.Append(label).Append(" disabled");
            return;
        }
        sb.Append(label);
        sb.Append(' ');
        if (!s.IsHealthy)
        {
            sb.Append("UNHEALTHY ");
            if (!string.IsNullOrEmpty(s.LastErrorMessage))
            {
                sb.Append('(').Append(s.LastErrorMessage).Append(") ");
            }
        }
        sb.Append("level=");
        sb.Append(s.LastLevelPeak.ToString("F2"));
        if (s.LastSilent) sb.Append("(silent)");
        sb.Append(" rms=");
        sb.Append(s.LastLevelRms.ToString("F3"));
        sb.Append(" frames=");
        sb.Append(s.FramesEmitted);
        sb.Append(" dropped=");
        sb.Append(s.FramesDropped);
    }

    public static long NowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
}

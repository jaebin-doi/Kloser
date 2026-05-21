// Phase 9 Step 4 — Step 3 manual smoke S1-S6 checklist.
//
// Plan §4.2 / §6. S1/S2/S3 can be auto-suggested from live counters;
// S4/S5/S6 require user observation. Checklist state is session-local
// only — not persisted (Plan §4.2 "Do not persist checklist state").

namespace Kloser.Desktop.Shell.ViewModels;

public sealed class SmokeChecklistViewModel : ObservableObject
{
    private bool _s1MicLevelMoved;
    public bool S1MicLevelMoved
    {
        get => _s1MicLevelMoved;
        set => SetField(ref _s1MicLevelMoved, value);
    }

    private bool _s2LoopbackLevelMoved;
    public bool S2LoopbackLevelMoved
    {
        get => _s2LoopbackLevelMoved;
        set => SetField(ref _s2LoopbackLevelMoved, value);
    }

    private bool _s3SimultaneousFramesObserved;
    public bool S3SimultaneousFramesObserved
    {
        get => _s3SimultaneousFramesObserved;
        set => SetField(ref _s3SimultaneousFramesObserved, value);
    }

    private bool _s4DiagnosticWavWritten;
    public bool S4DiagnosticWavWritten
    {
        get => _s4DiagnosticWavWritten;
        set => SetField(ref _s4DiagnosticWavWritten, value);
    }

    private bool _s5MuteSilenceObserved;
    public bool S5MuteSilenceObserved
    {
        get => _s5MuteSilenceObserved;
        set => SetField(ref _s5MuteSilenceObserved, value);
    }

    private bool _s6FiveMinuteBaselineComplete;
    public bool S6FiveMinuteBaselineComplete
    {
        get => _s6FiveMinuteBaselineComplete;
        set => SetField(ref _s6FiveMinuteBaselineComplete, value);
    }

    private const double LevelSuggestionThreshold = 0.001;

    /// <summary>
    /// Soft-auto-tick S1/S2/S3 when live counters cross the suggestion
    /// thresholds. Never un-tick — once observed, stays checked for the
    /// session. S6 auto-checks at the 5-minute mark.
    /// </summary>
    public void AutoSuggest(
        SourceStatusViewModel mic,
        SourceStatusViewModel loopback,
        TimeSpan elapsed)
    {
        if (mic.IsEnabled && mic.FramesEmitted > 0 && mic.Peak > LevelSuggestionThreshold)
        {
            S1MicLevelMoved = true;
        }
        if (loopback.IsEnabled && loopback.FramesEmitted > 0 && loopback.Peak > LevelSuggestionThreshold)
        {
            S2LoopbackLevelMoved = true;
        }
        if (mic.IsEnabled && loopback.IsEnabled
            && mic.FramesEmitted > 0 && loopback.FramesEmitted > 0)
        {
            S3SimultaneousFramesObserved = true;
        }
        if (elapsed >= TimeSpan.FromMinutes(5))
        {
            S6FiveMinuteBaselineComplete = true;
        }
    }

    public void Reset()
    {
        S1MicLevelMoved = false;
        S2LoopbackLevelMoved = false;
        S3SimultaneousFramesObserved = false;
        S4DiagnosticWavWritten = false;
        S5MuteSilenceObserved = false;
        S6FiveMinuteBaselineComplete = false;
    }
}

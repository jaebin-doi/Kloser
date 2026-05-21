// Phase 9 Step 4 — WPF Application bootstrap.
//
// Step 4은 의도적으로 비워뒀고, Step 7 hardening에서 아래 한 가지 hook만
// 추가됐다: stale pending recording 디렉토리 startup sweep. raw audio가
// 디스크에 24h 이상 남는 시나리오 차단 (Plan Step 7 §3.4).
//
// DI 컨테이너 / 텔레메트리 / 자동 업데이트 / 인스톨러 hook 같은 production
// 단계 인프라는 본 phase 범위에서 의도적으로 배제 (Plan §2 Out of Scope).

using System.Windows;
using Kloser.Desktop.Shell.Services.RecordingArchive;

namespace Kloser.Desktop.Shell;

public partial class App : System.Windows.Application
{
    private readonly PendingRecordingsSweeper _sweeper = new();

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        // Fire-and-forget; sweep 실패는 사용자 작업과 무관하므로 await하지 않는다.
        _ = _sweeper.SweepInBackgroundAsync();
    }
}

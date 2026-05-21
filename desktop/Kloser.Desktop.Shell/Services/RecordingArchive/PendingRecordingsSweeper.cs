// Phase 9 Step 7 — startup sweep for stale pending recording directories.
//
// Plan §3.4: %LOCALAPPDATA%\Kloser\recordings\pending\<callId>\ 디렉토리는
// 정상 경로에선 RunArchiveUploadAsync 끝에 DeleteLocalAsync가 지운다. 그러나
// process crash / 강제 종료 / OS shutdown / 디스크 IO 실패 같은 비정상 경로에선
// 남는다. raw audio가 디스크에 24h 이상 남아 있는 것은 보안 정책상 허용하지
// 않으므로 앱 시작 시 한 번 청소한다.
//
// 정책:
//   * threshold: 24h (Plan §3.4 권장값). 1h로 줄여도 안전하지만 사용자가
//     일과 마치고 다음 날 다시 켜는 패턴을 깨면 안 돼서 24h로.
//   * "오래됨" 기준: 디렉토리 LastWriteTimeUtc. 통화 끝나면 archive 파일이
//     다 쓰여진 시점이 LastWrite이고, upload 도중 중단되면 그 시점 이후엔
//     기록이 없으니 한 번의 통화 길이만큼 + 24h 그 이상이면 stale.
//   * best-effort: 어떤 디렉토리 하나가 락이거나 권한 문제여도 다른 것들은
//     계속 시도. 실패는 silent — Step 7 hardening에서 사용자가 추가 액션할
//     게 없다.
//   * 비동기: 메인 UI 스레드 절대 잡지 않음. Task.Run으로 띄우고 결과는
//     `LastSweepSummary` getter로 노출.
//
// 안전성: pending 디렉토리만 청소한다. `%LOCALAPPDATA%\Kloser\recordings\`
// 하위에 pending이 아닌 디렉토리가 미래에 생겨도 건드리지 않는다. 절대
// 경로를 단단히 검사해서 "pending" 단어가 들어간 디렉토리만 삭제 대상으로
// 본다.

using System.IO;

namespace Kloser.Desktop.Shell.Services.RecordingArchive;

public sealed class PendingRecordingsSweeper
{
    public static readonly TimeSpan StaleThreshold = TimeSpan.FromHours(24);

    public sealed record SweepResult(int Scanned, int Deleted, int Skipped, int Errored);

    public SweepResult? LastSweepSummary { get; private set; }

    public Task SweepInBackgroundAsync()
    {
        return Task.Run(() =>
        {
            try
            {
                LastSweepSummary = SweepOnce();
            }
            catch
            {
                // 어떤 예외도 메인 프로세스를 죽이지 못 하게.
                LastSweepSummary = new SweepResult(0, 0, 0, 1);
            }
        });
    }

    public SweepResult SweepOnce()
    {
        var root = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var pendingRoot = Path.Combine(root, "Kloser", "recordings", "pending");
        if (!Directory.Exists(pendingRoot))
        {
            return new SweepResult(0, 0, 0, 0);
        }

        int scanned = 0;
        int deleted = 0;
        int skipped = 0;
        int errored = 0;
        DateTime cutoffUtc = DateTime.UtcNow - StaleThreshold;

        IEnumerable<string> dirs;
        try
        {
            dirs = Directory.EnumerateDirectories(pendingRoot, "*", SearchOption.TopDirectoryOnly);
        }
        catch
        {
            return new SweepResult(0, 0, 0, 1);
        }

        foreach (var dir in dirs)
        {
            scanned++;

            // Defensive: 절대로 pendingRoot 위로 탈출하지 않게 relative path로 비교.
            string fullDir;
            try
            {
                fullDir = Path.GetFullPath(dir);
            }
            catch { errored++; continue; }
            string relativePath;
            try
            {
                relativePath = Path.GetRelativePath(pendingRoot, fullDir);
            }
            catch { errored++; continue; }
            if (Path.IsPathRooted(relativePath)
                || relativePath == "."
                || relativePath.StartsWith("..", StringComparison.Ordinal))
            {
                skipped++;
                continue;
            }

            DateTime lastWriteUtc;
            try
            {
                lastWriteUtc = Directory.GetLastWriteTimeUtc(dir);
            }
            catch { errored++; continue; }
            if (lastWriteUtc > cutoffUtc)
            {
                skipped++;
                continue;
            }

            try
            {
                Directory.Delete(dir, recursive: true);
                deleted++;
            }
            catch
            {
                errored++;
            }
        }

        return new SweepResult(scanned, deleted, skipped, errored);
    }
}

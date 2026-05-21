// Phase 9 Step 6 — call archive lifecycle state machine.
//
// Plan §5.3. Owns the temp-directory + writer + upload orchestration so
// MainWindowViewModel can treat archive as a single async session.
//
// Local temp path (Plan §5.1):
//   %LOCALAPPDATA%\Kloser\recordings\pending\<callId>\call.wav
//
// Cleanup invariants (Plan §5.3):
//   * success path deletes the entire pending\<callId>\ directory after
//     `available` is observed.
//   * failure path deletes the entire pending\<callId>\ directory and
//     best-effort DELETEs the recording row.
//   * we DO NOT keep failed archive files around for retry.

using System.IO;
using Kloser.Capture.Core.Recording;

namespace Kloser.Desktop.Shell.Services.RecordingArchive;

public sealed class RecordingArchiveSession : IAsyncDisposable
{
    private readonly object _sync = new();
    private readonly string _callId;
    private readonly string _tempDir;
    private readonly string _outputWavPath;
    private readonly long _sessionStartMsUtc;
    private readonly CallArchiveWavWriter _writer;
    private readonly CallArchiveWavFrameSink _sink;
    private CallArchiveResult? _result;
    private RecordingArchiveState _state = RecordingArchiveState.Idle;
    private string? _recordingId;
    private string? _recordingStatus;
    private string? _lastError;
    private long _uploadedBytes;
    private bool _disposed;

    public event EventHandler<RecordingArchiveState>? StateChanged;
    public event EventHandler? StatsChanged;

    public string CallId => _callId;
    public RecordingArchiveState State { get { lock (_sync) return _state; } }
    public string? RecordingId { get { lock (_sync) return _recordingId; } }
    public string? RecordingStatus { get { lock (_sync) return _recordingStatus; } }
    public string? LastError { get { lock (_sync) return _lastError; } }
    public long UploadedBytes { get { lock (_sync) return _uploadedBytes; } }
    public CallArchiveResult? Result { get { lock (_sync) return _result; } }
    public CallArchiveWavFrameSink Sink => _sink;
    public CallArchiveWavWriter Writer => _writer;

    public RecordingArchiveSession(string callId, long sessionStartMsUtc)
    {
        if (string.IsNullOrWhiteSpace(callId))
        {
            throw new ArgumentException("callId must be non-empty", nameof(callId));
        }
        _callId = callId;
        _sessionStartMsUtc = sessionStartMsUtc;
        _tempDir = BuildTempDir(callId);
        _outputWavPath = Path.Combine(_tempDir, "call.wav");
        // Scratch dir for raw per-source PCM files; sibling of the WAV
        // so a single Directory.Delete cleans both up.
        var scratchDir = Path.Combine(_tempDir, "scratch");
        _writer = new CallArchiveWavWriter(scratchDir, sessionStartMsUtc);
        _sink = new CallArchiveWavFrameSink(_writer);
    }

    private static string BuildTempDir(string callId)
    {
        var root = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        // Defensive: callId comes from backend ack but we sanitize against
        // path separators anyway to keep the tree under our own subfolder.
        var safe = string.Concat(callId.Where(c =>
            char.IsLetterOrDigit(c) || c == '-' || c == '_'));
        if (safe.Length == 0) safe = "unknown";
        return Path.Combine(root, "Kloser", "recordings", "pending", safe);
    }

    public void BeginRecording()
    {
        SetState(RecordingArchiveState.Recording);
        _sink.Activate();
    }

    /// <summary>
    /// Stop accepting frames, finalize the WAV header, return metadata.
    /// Caller decides whether to upload (e.g., short calls with no audio
    /// may skip).
    /// </summary>
    public async Task<CallArchiveResult> FinalizeLocalAsync(CancellationToken ct = default)
    {
        SetState(RecordingArchiveState.FinalizingLocalFile);
        _sink.Deactivate();
        var result = await _writer.CompleteAsync(_outputWavPath, ct).ConfigureAwait(false);
        lock (_sync) _result = result;
        RaiseStats();
        return result;
    }

    public void MarkUploadInitiating()  => SetState(RecordingArchiveState.UploadInitiating);
    public void MarkUploadingBytes()    => SetState(RecordingArchiveState.UploadingBytes);
    public void MarkFinalizingRemote()  => SetState(RecordingArchiveState.FinalizingRemote);
    public void MarkAvailable()         => SetState(RecordingArchiveState.Available);

    public void MarkFailed(string? shortError)
    {
        lock (_sync) _lastError = shortError;
        SetState(RecordingArchiveState.Failed);
    }

    public void SetRecordingId(string? id)
    {
        lock (_sync) _recordingId = id;
        RaiseStats();
    }
    public void SetRecordingStatus(string? status)
    {
        lock (_sync) _recordingStatus = status;
        RaiseStats();
    }
    public void ReportUploadProgress(long bytes)
    {
        lock (_sync) _uploadedBytes = bytes;
        RaiseStats();
    }

    public string OutputWavPath => _outputWavPath;
    public string TempDir => _tempDir;

    public async ValueTask DeleteLocalAsync()
    {
        if (string.IsNullOrEmpty(_tempDir)) return;
        try
        {
            // Disposing the writer closes any remaining file handles
            // so Directory.Delete won't hit "in use" errors.
            await _writer.DisposeAsync().ConfigureAwait(false);
        }
        catch { /* swallow */ }
        try
        {
            if (Directory.Exists(_tempDir))
            {
                Directory.Delete(_tempDir, recursive: true);
            }
        }
        catch
        {
            // Surface as a soft failure but do not throw — caller may
            // already be handling another error. Step 7 hardening can
            // add a scheduled cleanup sweep.
        }
    }

    private void SetState(RecordingArchiveState next)
    {
        bool changed;
        lock (_sync)
        {
            changed = _state != next;
            _state = next;
        }
        if (changed) StateChanged?.Invoke(this, next);
    }

    private void RaiseStats() => StatsChanged?.Invoke(this, EventArgs.Empty);

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;
        try { await _writer.DisposeAsync().ConfigureAwait(false); } catch { /* swallow */ }
    }
}

// Phase 9 Step 6 — Phase 8 recording REST surface client.
//
// Plan §5.2. Three calls per archive upload:
//   1. POST /calls/:callId/recordings/upload       -> upload_pending + signed PUT URL
//   2. PUT  <signed_url>                            -> object storage write
//   3. POST /calls/:callId/recordings/:rid/finalize -> mark available
//
// Failure cleanup: best-effort DELETE /calls/:callId/recordings/:rid to
// avoid leaving an `upload_pending` row hanging.
//
// Security policy (Plan §5.2):
//   * memory-only Bearer token (reused from Step 5 auth flow)
//   * signed URL is never logged / surfaced
//   * object key may live in the signed URL path; we do not echo it
//   * checksum is sent in the upload initiate body and NOT logged
//   * raw audio bytes go to signed URL as `audio/wav`; never stringified

using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace Kloser.Desktop.Shell.Services.RecordingArchive;

public sealed class RecordingArchiveClient : IDisposable
{
    private readonly HttpClient _http;
    private bool _disposed;

    public RecordingArchiveClient(HttpClient? http = null)
    {
        _http = http ?? new HttpClient
        {
            // Upload may take longer than a quick auth call.
            Timeout = TimeSpan.FromMinutes(5),
        };
    }

    /// <summary>POST /calls/:callId/recordings/upload with Bearer token.</summary>
    public async Task<RecordingUploadInitiateResponse> InitiateUploadAsync(
        string baseUrl,
        string accessToken,
        string callId,
        RecordingUploadInitiateRequest body,
        CancellationToken ct = default)
    {
        if (_disposed) throw new ObjectDisposedException(nameof(RecordingArchiveClient));
        EnsureNotEmpty(baseUrl, nameof(baseUrl));
        EnsureNotEmpty(accessToken, nameof(accessToken));
        EnsureNotEmpty(callId, nameof(callId));

        var url = Combine(baseUrl, $"/calls/{Uri.EscapeDataString(callId)}/recordings/upload");
        using var req = new HttpRequestMessage(HttpMethod.Post, url);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        req.Content = JsonContent.Create(body);
        using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        var text = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode)
        {
            throw new RecordingArchiveHttpError(
                Stage: "initiate",
                StatusCode: (int)res.StatusCode,
                ShortError: TryReadErrorCode(text) ?? "initiate_failed");
        }
        var parsed = JsonSerializer.Deserialize<RecordingUploadInitiateResponse>(text);
        if (parsed is null || parsed.Recording is null || parsed.SignedUrl is null
            || string.IsNullOrEmpty(parsed.Recording.Id)
            || string.IsNullOrEmpty(parsed.SignedUrl.Url))
        {
            throw new RecordingArchiveHttpError(
                Stage: "initiate",
                StatusCode: (int)res.StatusCode,
                ShortError: "initiate_bad_response");
        }
        return parsed;
    }

    /// <summary>
    /// PUT raw audio bytes at the signed URL. Headers from the upload
    /// response (typically `Content-Type: audio/wav`) are applied exactly.
    /// We do NOT add an `Authorization` header here — object storage
    /// signed URLs are not Kloser API routes.
    /// </summary>
    public async Task UploadBytesAsync(
        SignedUploadPayload signed,
        Stream body,
        long contentLength,
        IProgress<long>? progress,
        CancellationToken ct = default)
    {
        if (_disposed) throw new ObjectDisposedException(nameof(RecordingArchiveClient));
        if (signed.Url is null) throw new InvalidOperationException("signed.url is null");
        var method = signed.Method?.ToUpperInvariant() ?? "PUT";
        if (method != "PUT")
        {
            throw new InvalidOperationException($"unsupported upload method: {signed.Method}");
        }

        using var req = new HttpRequestMessage(HttpMethod.Put, signed.Url);
        var streamContent = new ProgressStreamContent(body, progress);
        streamContent.Headers.ContentLength = contentLength;
        // Apply backend-prescribed headers. Content-Type is the critical one.
        if (signed.Headers is not null)
        {
            foreach (var (k, v) in signed.Headers)
            {
                if (string.Equals(k, "Content-Type", StringComparison.OrdinalIgnoreCase))
                {
                    streamContent.Headers.ContentType = new MediaTypeHeaderValue(v);
                }
                else
                {
                    // ContentMD5 / x-amz-* / etc. go on the content headers.
                    streamContent.Headers.TryAddWithoutValidation(k, v);
                }
            }
        }
        req.Content = streamContent;
        using var res = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode)
        {
            // Do NOT include the signed URL or response body in the surface.
            throw new RecordingArchiveHttpError(
                Stage: "upload",
                StatusCode: (int)res.StatusCode,
                ShortError: "upload_failed");
        }
    }

    /// <summary>POST /calls/:callId/recordings/:rid/finalize with Bearer token.</summary>
    public async Task FinalizeAsync(
        string baseUrl,
        string accessToken,
        string callId,
        string recordingId,
        RecordingFinalizeRequest body,
        CancellationToken ct = default)
    {
        if (_disposed) throw new ObjectDisposedException(nameof(RecordingArchiveClient));
        EnsureNotEmpty(baseUrl, nameof(baseUrl));
        EnsureNotEmpty(accessToken, nameof(accessToken));
        EnsureNotEmpty(callId, nameof(callId));
        EnsureNotEmpty(recordingId, nameof(recordingId));

        var url = Combine(baseUrl,
            $"/calls/{Uri.EscapeDataString(callId)}/recordings/{Uri.EscapeDataString(recordingId)}/finalize");
        using var req = new HttpRequestMessage(HttpMethod.Post, url);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        req.Content = JsonContent.Create(body);
        using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode)
        {
            var text = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            throw new RecordingArchiveHttpError(
                Stage: "finalize",
                StatusCode: (int)res.StatusCode,
                ShortError: TryReadErrorCode(text) ?? "finalize_failed");
        }
    }

    /// <summary>
    /// Best-effort DELETE /calls/:callId/recordings/:rid. Swallows any
    /// failure so cleanup never throws further over a primary error.
    /// </summary>
    public async Task TryCleanupAsync(
        string baseUrl,
        string accessToken,
        string callId,
        string recordingId,
        CancellationToken ct = default)
    {
        if (_disposed) return;
        if (string.IsNullOrEmpty(baseUrl) || string.IsNullOrEmpty(accessToken)
            || string.IsNullOrEmpty(callId) || string.IsNullOrEmpty(recordingId)) return;
        try
        {
            var url = Combine(baseUrl,
                $"/calls/{Uri.EscapeDataString(callId)}/recordings/{Uri.EscapeDataString(recordingId)}");
            using var req = new HttpRequestMessage(HttpMethod.Delete, url);
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
            using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
            _ = res; // best-effort, ignore status
        }
        catch
        {
            // swallow — best-effort cleanup
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _http.Dispose();
    }

    private static void EnsureNotEmpty(string s, string param)
    {
        if (string.IsNullOrWhiteSpace(s))
        {
            throw new ArgumentException($"{param} must be non-empty", param);
        }
    }

    private static string Combine(string baseUrl, string relative)
    {
        var t = baseUrl.TrimEnd('/');
        var r = relative.StartsWith('/') ? relative : "/" + relative;
        return t + r;
    }

    private static string? TryReadErrorCode(string body)
    {
        if (string.IsNullOrWhiteSpace(body)) return null;
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.TryGetProperty("error", out var e))
            {
                return e.GetString();
            }
            if (doc.RootElement.TryGetProperty("code", out var c))
            {
                return c.GetString();
            }
        }
        catch (JsonException) { /* keep null */ }
        return null;
    }
}

public sealed class RecordingArchiveHttpError : Exception
{
    public string Stage { get; }
    public int StatusCode { get; }
    public string ShortError { get; }

    public RecordingArchiveHttpError(string Stage, int StatusCode, string ShortError)
        : base($"recording archive {Stage} failed: {StatusCode} {ShortError}")
    {
        this.Stage = Stage;
        this.StatusCode = StatusCode;
        this.ShortError = ShortError;
    }
}

/// <summary>
/// HttpContent wrapper that reports upload progress through an IProgress
/// without buffering the source stream in memory.
/// </summary>
internal sealed class ProgressStreamContent : HttpContent
{
    private const int BufferSize = 64 * 1024;
    private readonly Stream _source;
    private readonly IProgress<long>? _progress;

    public ProgressStreamContent(Stream source, IProgress<long>? progress)
    {
        _source = source;
        _progress = progress;
    }

    protected override async Task SerializeToStreamAsync(Stream stream, System.Net.TransportContext? context)
    {
        var buffer = new byte[BufferSize];
        long total = 0;
        int read;
        while ((read = await _source.ReadAsync(buffer.AsMemory(0, BufferSize)).ConfigureAwait(false)) > 0)
        {
            await stream.WriteAsync(buffer.AsMemory(0, read)).ConfigureAwait(false);
            total += read;
            _progress?.Report(total);
        }
    }

    protected override bool TryComputeLength(out long length)
    {
        if (_source.CanSeek)
        {
            length = _source.Length;
            return true;
        }
        length = -1;
        return false;
    }

    protected override void Dispose(bool disposing)
    {
        // We do NOT dispose the source stream — caller owns its lifetime
        // (RecordingArchiveSession opens it from the on-disk WAV file
        // and deletes the temp dir explicitly).
        base.Dispose(disposing);
    }
}

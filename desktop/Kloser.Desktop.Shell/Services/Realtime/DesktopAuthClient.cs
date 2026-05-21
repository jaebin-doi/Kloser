// Phase 9 Step 5 — desktop auth client.
//
// Plan §4.5 — 두 가지 path만 지원:
//   1. login: existing `/auth/login` 호출, 응답에서 accessToken만 메모리로 보관.
//   2. pasted-token: 사용자가 직접 access token을 붙여넣음 (dev fallback).
//      또는 `KLOSER_DESKTOP_ACCESS_TOKEN` env에서 읽음.
//
// 정책 (Plan §4.5):
//   * accessToken은 메모리에만. 파일 / 레지스트리 / 로그에 절대 저장 안 함.
//   * UI 이벤트 / 오류 메시지 / 예외 메시지에 토큰을 그대로 노출하지 않음.
//   * refresh token / 비밀번호는 디스크에 안 씀.
//   * MFA challenge 응답이 오면 unsupported 알리고 paste fallback 안내.
//
// 본 클라이언트는 raw HttpClient를 쓰고 SocketIOClient와는 무관하다.

using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Kloser.Desktop.Shell.Services.Realtime;

public sealed class DesktopAuthClient : IDisposable
{
    private readonly HttpClient _http;
    private bool _disposed;

    public DesktopAuthClient(HttpClient? http = null)
    {
        _http = http ?? new HttpClient
        {
            Timeout = TimeSpan.FromSeconds(15),
        };
    }

    /// <summary>
    /// POST `<baseUrl>/auth/login` with email + password. Returns the
    /// access token from the response on success. On MFA challenge or
    /// any non-2xx response, returns a typed failure for the UI.
    /// </summary>
    public async Task<DesktopAuthResult> LoginAsync(
        string baseUrl,
        string email,
        string password,
        CancellationToken ct = default)
    {
        if (_disposed) throw new ObjectDisposedException(nameof(DesktopAuthClient));
        if (string.IsNullOrWhiteSpace(baseUrl))
        {
            return DesktopAuthResult.Failure(
                "백엔드 URL이 비어 있습니다.");
        }
        if (string.IsNullOrWhiteSpace(email) || string.IsNullOrWhiteSpace(password))
        {
            return DesktopAuthResult.Failure(
                "이메일과 비밀번호를 모두 입력하세요.");
        }
        var url = CombineUrl(baseUrl, "/auth/login");
        HttpResponseMessage response;
        try
        {
            response = await _http.PostAsJsonAsync(url, new LoginRequest
            {
                Email = email,
                Password = password,
            }, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            return DesktopAuthResult.Failure(
                $"백엔드 연결 실패: {ex.GetType().Name}");
        }

        var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if ((int)response.StatusCode == 202)
        {
            // backend returns 202 Accepted when MFA challenge is required.
            // Step 5 does not implement MFA UX — surface clear unsupported
            // message and steer to pasted-token fallback (Plan §4.5).
            return DesktopAuthResult.MfaRequired(
                "2단계 인증이 필요한 계정입니다. 본 PoC는 MFA UX를 지원하지 않으니 paste-token 방식으로 사용하세요.");
        }
        if (!response.IsSuccessStatusCode)
        {
            // Surface backend's error envelope without leaking PII; we
            // only echo `error` and short status text, not body bytes.
            string brief = "백엔드 응답 오류";
            try
            {
                using var doc = JsonDocument.Parse(body);
                if (doc.RootElement.TryGetProperty("error", out var err))
                {
                    brief = err.GetString() ?? brief;
                }
            }
            catch (JsonException) { /* keep generic */ }
            return DesktopAuthResult.Failure(
                $"로그인 실패 ({(int)response.StatusCode}): {brief}");
        }

        string? accessToken;
        try
        {
            using var doc = JsonDocument.Parse(body);
            accessToken = doc.RootElement.TryGetProperty("accessToken", out var t)
                ? t.GetString()
                : null;
        }
        catch (JsonException)
        {
            return DesktopAuthResult.Failure("백엔드 응답을 해석할 수 없습니다.");
        }
        if (string.IsNullOrEmpty(accessToken))
        {
            return DesktopAuthResult.Failure("응답에 accessToken이 없습니다.");
        }
        return DesktopAuthResult.Ok(accessToken);
    }

    /// <summary>
    /// Returns the value of `KLOSER_DESKTOP_ACCESS_TOKEN` if present.
    /// Used by the WPF on startup to pre-fill the paste-token field for
    /// dev convenience. The env is not persisted by this app; the
    /// operating system owns the lifetime.
    /// </summary>
    public static string? TryReadDevTokenFromEnv()
    {
        var raw = Environment.GetEnvironmentVariable("KLOSER_DESKTOP_ACCESS_TOKEN");
        if (string.IsNullOrWhiteSpace(raw)) return null;
        return raw.Trim();
    }

    private static string CombineUrl(string baseUrl, string relativePath)
    {
        var trimmed = baseUrl.TrimEnd('/');
        var rel = relativePath.StartsWith('/') ? relativePath : "/" + relativePath;
        return trimmed + rel;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _http.Dispose();
    }

    private sealed class LoginRequest
    {
        [JsonPropertyName("email")]
        public string Email { get; init; } = "";

        [JsonPropertyName("password")]
        public string Password { get; init; } = "";
    }
}

public sealed class DesktopAuthResult
{
    public bool Success { get; private init; }
    public bool MfaChallenge { get; private init; }
    public string? AccessToken { get; private init; }
    public string? FriendlyMessage { get; private init; }

    public static DesktopAuthResult Ok(string token) => new()
    {
        Success = true,
        AccessToken = token,
    };

    public static DesktopAuthResult Failure(string message) => new()
    {
        Success = false,
        FriendlyMessage = message,
    };

    public static DesktopAuthResult MfaRequired(string message) => new()
    {
        Success = false,
        MfaChallenge = true,
        FriendlyMessage = message,
    };
}

/* Kloser platform — fetch wrapper + auth client (Phase 1 step 4).
 *
 * Loaded as a classic <script>; no module/build step. Exposes
 * `window.kloserApi`.
 *
 * Design:
 *   - Access token lives only in this module's closure. Reloads lose
 *     it; pages recover by calling `kloserApi.refreshAccessToken()`
 *     on boot (the HttpOnly refresh cookie supplies the new token).
 *   - login / logout / refreshAccessToken use a low-level fetch that
 *     skips the Bearer header and skips the auto-refresh-on-401
 *     loop. These are the primitives the loop itself depends on, so
 *     wrapping them in the loop would self-recurse and risk
 *     refresh-token family revoke.
 *   - apiGet / apiPost attach `Authorization: Bearer <token>` and on
 *     401 run a single in-flight refresh + retry the original
 *     request once. Concurrent 401s share the one in-flight refresh
 *     promise — no thundering herd against /auth/refresh.
 *   - Every request prefixes the configured API_BASE_URL so the
 *     cross-origin between the static server (e.g. :8765) and the
 *     API server (:3001) is explicit, not implicit. Override:
 *       <meta name="kloser-api-base" content="https://api.example">
 *       window.KLOSER_API_BASE = "https://api.example"  (BEFORE this script)
 *
 * Error contract:
 *   - login() / apiGet() / apiPost() throw on network failure.
 *   - login() throws an Error with `.status` and `.body` when the
 *     server responds 4xx — the caller inspects `err.body.code` and
 *     `err.body.availableOrgs` to render the multi-membership UX.
 *   - apiGet/apiPost return the Response (even for non-OK), so the
 *     caller checks res.ok and reads res.json(). Terminal 401 (after
 *     refresh retry also failed) triggers `loginRedirect()` before
 *     the caller can act on the response.
 */
(function () {
  'use strict';

  const DEFAULT_API_BASE = 'http://localhost:3001';
  const LOGIN_PATH = '/platform/login.html';
  const REFRESH_ENDPOINT = '/auth/refresh';

  function resolveApiBase() {
    if (typeof window.KLOSER_API_BASE === 'string' && window.KLOSER_API_BASE.length > 0) {
      return window.KLOSER_API_BASE.replace(/\/+$/, '');
    }
    const meta = document.querySelector('meta[name="kloser-api-base"]');
    if (meta && typeof meta.content === 'string' && meta.content.length > 0) {
      return meta.content.replace(/\/+$/, '');
    }
    return DEFAULT_API_BASE;
  }

  const API_BASE_URL = resolveApiBase();

  // Module-local mutable state.
  let accessToken = null;
  let refreshing = null;  // Promise<void> while a refresh is in-flight.

  function setAccessToken(t) {
    accessToken = (typeof t === 'string' && t.length > 0) ? t : null;
  }
  function clearAccessToken() {
    accessToken = null;
  }
  function getAccessToken() {
    return accessToken;
  }

  function buildUrl(path) {
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error('[kloserApi] path is required');
    }
    if (!path.startsWith('/')) path = '/' + path;
    return API_BASE_URL + path;
  }

  // Low-level fetch — no Bearer, no auto-refresh, but always sends
  // cookies (refresh cookie lives at Path=/auth and travels here).
  function rawFetch(path, init) {
    const merged = Object.assign({ credentials: 'include' }, init || {});
    return fetch(buildUrl(path), merged);
  }

  // Authenticated fetch — Bearer + 401 → single in-flight refresh + retry once.
  async function authFetch(path, init) {
    init = init || {};
    const firstHeaders = Object.assign({}, init.headers || {});
    if (accessToken) firstHeaders['Authorization'] = 'Bearer ' + accessToken;

    const first = await fetch(
      buildUrl(path),
      Object.assign({ credentials: 'include' }, init, { headers: firstHeaders }),
    );
    if (first.status !== 401) return first;

    // Try refresh + single retry. If refresh itself fails, this is
    // terminal: clear local token and bounce to login.
    try {
      await refreshAccessToken();
    } catch (err) {
      clearAccessToken();
      loginRedirect();
      throw err;
    }

    const retryHeaders = Object.assign({}, init.headers || {});
    if (accessToken) retryHeaders['Authorization'] = 'Bearer ' + accessToken;
    const second = await fetch(
      buildUrl(path),
      Object.assign({ credentials: 'include' }, init, { headers: retryHeaders }),
    );
    if (second.status === 401) {
      // Refresh succeeded but the resource still 401s — token is fine
      // but the action is unauthorized. Treat as terminal session
      // failure (the most common cause is a server-side membership
      // disappearance), bounce to login.
      clearAccessToken();
      loginRedirect();
    }
    return second;
  }

  // Single in-flight refresh promise. Concurrent callers await the
  // same one; success/failure both clear the slot so the NEXT 401 in
  // the future can refresh again.
  function refreshAccessToken() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const res = await rawFetch(REFRESH_ENDPOINT, { method: 'POST' });
      if (!res.ok) {
        const err = new Error('refresh_failed_' + res.status);
        err.status = res.status;
        throw err;
      }
      const body = await res.json();
      if (body && typeof body.accessToken === 'string') {
        setAccessToken(body.accessToken);
      } else {
        throw new Error('refresh_response_missing_access_token');
      }
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function login(input) {
    const res = await rawFetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input || {}),
    });
    let body = null;
    const text = await res.text();
    if (text.length > 0) {
      try { body = JSON.parse(text); } catch (_) { /* leave null */ }
    }
    if (!res.ok) {
      const err = new Error('login_failed_' + res.status);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    if (body && typeof body.accessToken === 'string') {
      setAccessToken(body.accessToken);
    }
    return body;
  }

  async function logout() {
    try {
      await rawFetch('/auth/logout', { method: 'POST' });
    } finally {
      // Clear local memory regardless of server outcome — the cookie
      // will already be cleared if the server responded 204; if the
      // network failed, the local token is still useless because the
      // session row may or may not be revoked. login redirect from
      // here is the caller's choice.
      clearAccessToken();
    }
  }

  function apiGet(path, opts) {
    const optsLocal = opts || {};
    return authFetch(path, {
      method: optsLocal.method || 'GET',
      headers: optsLocal.headers,
    });
  }

  function apiPost(path, body, opts) {
    const optsLocal = opts || {};
    const headers = Object.assign(
      { 'Content-Type': 'application/json' },
      optsLocal.headers || {},
    );
    return authFetch(path, {
      method: optsLocal.method || 'POST',
      headers: headers,
      body: typeof body === 'string' ? body : JSON.stringify(body || {}),
    });
  }

  function loginRedirect() {
    const here = window.location.pathname + window.location.search;
    const url = LOGIN_PATH + '?returnUrl=' + encodeURIComponent(here);
    window.location.replace(url);
  }

  window.kloserApi = {
    // Token store (memory-only).
    setAccessToken: setAccessToken,
    clearAccessToken: clearAccessToken,
    getAccessToken: getAccessToken,

    // Auth flow (skip auto-Bearer + auto-refresh).
    login: login,
    logout: logout,
    refreshAccessToken: refreshAccessToken,

    // Authenticated requests.
    apiGet: apiGet,
    apiPost: apiPost,

    // Utility.
    loginRedirect: loginRedirect,

    // Read-only config — ws.js consumes this so the WS URL stays in
    // sync with the API base.
    apiBaseUrl: API_BASE_URL,
  };
})();

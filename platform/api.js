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
 *     API server (:32173) is explicit, not implicit. Override
 *     priority (Phase 1 Step 5):
 *       1. window.KLOSER_API_BASE (string — empty allowed)
 *       2. <meta name="kloser-api-base" content="..."> (empty allowed)
 *       3. AUTO: https + hostname=localhost → "" (Caddy single-origin)
 *       4. default "http://localhost:32173" (split-origin dev)
 *     Empty string means "use relative URLs (same-origin)".
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

  const DEFAULT_API_BASE = 'http://localhost:32173';
  const LOGIN_PATH = '/platform/login.html';
  const REFRESH_ENDPOINT = '/auth/refresh';

  function resolveApiBase() {
    // 1. Explicit window override — empty string passes through as the
    //    operator-set same-origin signal.
    if (typeof window.KLOSER_API_BASE === 'string') {
      return window.KLOSER_API_BASE.replace(/\/+$/, '');
    }
    // 2. Explicit <meta> override — same empty-string passthrough. We
    //    check hasAttribute('content') so a copy-paste-without-content
    //    isn't treated as same-origin by accident.
    const meta = document.querySelector('meta[name="kloser-api-base"]');
    if (meta && meta.hasAttribute('content')) {
      return meta.content.replace(/\/+$/, '');
    }
    // 3. Auto: HTTPS on localhost is almost certainly a Caddy
    //    single-origin dev (or prod-equivalent reverse proxy) setup.
    //    Use relative URLs so fetch targets the page's own origin.
    //    Plain http://localhost:8765 keeps falling through to step 4.
    if (
      window.location.protocol === 'https:' &&
      window.location.hostname === 'localhost'
    ) {
      return '';
    }
    // 4. Default — split-origin dev (http://localhost:8765 page hits
    //    http://localhost:32173 API).
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

  // ─────────────────────────────────────────────
  // Phase 3 Step 6 — anonymous endpoint helpers.
  //
  // All five return { status, body } (no throw). Pages branch on status
  // and read body.code for the 4xx detail message. Accept needs status
  // to distinguish 201 (new user) vs 200 (existing-user multi-org) —
  // body shape is identical AuthResult, only status differs.
  //
  // signup / acceptInvitation: success body has accessToken — auto-store
  // it via setAccessToken so the caller can redirect into a protected
  // page without another /auth/refresh round-trip.
  //
  // verifyEmail / requestPasswordReset / resetPassword: no token issued
  // on success. Caller does not need to setAccessToken.
  // ─────────────────────────────────────────────
  async function parseJsonResponse(res) {
    const text = await res.text();
    if (text.length === 0) return null;
    try { return JSON.parse(text); } catch (_) { return null; }
  }

  async function signup(input) {
    const res = await rawFetch('/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input || {}),
    });
    const body = await parseJsonResponse(res);
    if (res.ok && body && typeof body.accessToken === 'string') {
      setAccessToken(body.accessToken);
    }
    return { status: res.status, body: body };
  }

  async function acceptInvitation(input) {
    const res = await rawFetch('/invitations/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input || {}),
    });
    const body = await parseJsonResponse(res);
    if (res.ok && body && typeof body.accessToken === 'string') {
      setAccessToken(body.accessToken);
    }
    return { status: res.status, body: body };
  }

  async function verifyEmail(token) {
    const res = await rawFetch('/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token }),
    });
    return { status: res.status, body: await parseJsonResponse(res) };
  }

  async function requestPasswordReset(email) {
    const res = await rawFetch('/auth/password/forgot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email }),
    });
    return { status: res.status, body: await parseJsonResponse(res) };
  }

  async function resetPassword(token, newPassword) {
    const res = await rawFetch('/auth/password/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token, newPassword: newPassword }),
    });
    return { status: res.status, body: await parseJsonResponse(res) };
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

  function apiPatch(path, body, opts) {
    const optsLocal = opts || {};
    const headers = Object.assign(
      { 'Content-Type': 'application/json' },
      optsLocal.headers || {},
    );
    return authFetch(path, {
      method: 'PATCH',
      headers: headers,
      body: typeof body === 'string' ? body : JSON.stringify(body || {}),
    });
  }

  function apiDelete(path, opts) {
    const optsLocal = opts || {};
    return authFetch(path, {
      method: 'DELETE',
      headers: optsLocal.headers,
    });
  }

  function loginRedirect() {
    const here = window.location.pathname + window.location.search;
    const url = LOGIN_PATH + '?returnUrl=' + encodeURIComponent(here);
    window.location.replace(url);
  }

  // ─────────────────────────────────────────────
  // Phase 4 Step 4 — calls + transcripts + action items + dashboard.
  //
  // All helpers thin-wrap apiGet/apiPost/apiPatch and return the raw
  // Response so callers stay consistent with Phase 2/3 (`res.ok` →
  // `res.json()`, non-OK → branch on `res.status`). The server already
  // collapses cross-org / soft-deleted / missing into a uniform 404
  // shape (`{ error: 'not_found' }`), so the wrappers don't try to
  // pre-decode that.
  //
  // listCalls accepts a query object and serialises it with
  // URLSearchParams. undefined values are skipped (so callers can pass
  // partial objects without sentinel checking). `customerId: null` is
  // intentionally encoded as the literal string "null" because the
  // server's CallListQuery preprocessor reads "null" → null (used to
  // filter rows whose customer_id IS NULL).
  // ─────────────────────────────────────────────

  function listCalls(query) {
    const q = query || {};
    const params = new URLSearchParams();
    Object.keys(q).forEach(function (k) {
      const v = q[k];
      if (v === undefined) return;
      if (v === null) { params.set(k, 'null'); return; }
      params.set(k, String(v));
    });
    const qs = params.toString();
    return apiGet('/calls' + (qs ? '?' + qs : ''));
  }

  function getCall(id) {
    return apiGet('/calls/' + encodeURIComponent(id));
  }

  function createCall(input) {
    return apiPost('/calls', input || {});
  }

  function patchCallNotes(id, notes) {
    return apiPost('/calls/' + encodeURIComponent(id) + '/notes', { notes: notes });
  }

  function endCall(id, input) {
    return apiPost('/calls/' + encodeURIComponent(id) + '/end', input || {});
  }

  function listTranscript(callId) {
    return apiGet('/calls/' + encodeURIComponent(callId) + '/transcript');
  }

  function appendTranscript(callId, input) {
    return apiPost('/calls/' + encodeURIComponent(callId) + '/transcript', input || {});
  }

  function listActionItems(callId) {
    return apiGet('/calls/' + encodeURIComponent(callId) + '/action-items');
  }

  function createActionItem(callId, input) {
    return apiPost('/calls/' + encodeURIComponent(callId) + '/action-items', input || {});
  }

  function patchActionItemStatus(id, status) {
    return apiPost(
      '/call-action-items/' + encodeURIComponent(id) + '/status',
      { status: status },
    );
  }

  function patchActionItemAssignee(id, assigneeUserId) {
    return apiPost(
      '/call-action-items/' + encodeURIComponent(id) + '/assignee',
      { assignee_user_id: assigneeUserId },
    );
  }

  function getDashboardSummary() {
    return apiGet('/dashboard/summary');
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

    // Phase 3 Step 6 — anonymous endpoint wrappers, all return
    // { status, body } so pages can branch without a try/catch.
    signup: signup,
    acceptInvitation: acceptInvitation,
    verifyEmail: verifyEmail,
    requestPasswordReset: requestPasswordReset,
    resetPassword: resetPassword,

    // Authenticated requests.
    apiGet: apiGet,
    apiPost: apiPost,
    apiPatch: apiPatch,
    apiDelete: apiDelete,

    // Utility.
    loginRedirect: loginRedirect,

    // Phase 4 — calls / transcripts / action items / dashboard.
    listCalls: listCalls,
    getCall: getCall,
    createCall: createCall,
    patchCallNotes: patchCallNotes,
    endCall: endCall,
    listTranscript: listTranscript,
    appendTranscript: appendTranscript,
    listActionItems: listActionItems,
    createActionItem: createActionItem,
    patchActionItemStatus: patchActionItemStatus,
    patchActionItemAssignee: patchActionItemAssignee,
    getDashboardSummary: getDashboardSummary,

    // Read-only config — ws.js consumes this so the WS URL stays in
    // sync with the API base.
    apiBaseUrl: API_BASE_URL,
  };
})();

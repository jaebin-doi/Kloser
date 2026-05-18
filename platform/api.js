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
    // Phase 7 Step 2 — 200 happy-path body carries `accessToken`; the
    // 202 MFA challenge body carries `{ mfa: {...} }` instead and we
    // must NOT set an access token. The caller branches on body.mfa.
    if (body && typeof body.accessToken === 'string') {
      setAccessToken(body.accessToken);
    }
    return body;
  }

  // ─────────────────────────────────────────────
  // Phase 7 Step 2 — MFA login helpers.
  //
  // All three are anonymous (no Bearer header) — they consume a
  // short-lived `challengeToken` from /auth/login's 202 response in
  // its place. The token lives 5 minutes server-side; do NOT persist
  // it to localStorage / sessionStorage. The login page should hold
  // it in a closure variable for the duration of the MFA step and
  // drop it once the flow completes (success or back-to-password).
  //
  // verifyLoginMfa / confirmLoginMfaChallenge return AuthResult on 200
  // (same shape as /auth/login happy path). They auto-stash the
  // accessToken so the caller can navigate immediately, mirroring
  // signup() / acceptInvitation().
  //
  // setupLoginMfaChallenge returns { otpauthUri, secretBase32 } and
  // does NOT mint a session — the user must come back through
  // /auth/mfa/totp/confirm-challenge to actually get an access token.
  //
  // All three return { status, body } (no throw on 4xx) so the page
  // can branch on body.code for error variants like:
  //   401 mfa_invalid_challenge / mfa_invalid_code
  //   423 mfa_locked
  //   500 mfa_secret_corrupt
  // ─────────────────────────────────────────────
  async function verifyLoginMfa(challengeToken, code) {
    const res = await rawFetch('/auth/mfa/totp/verify-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeToken: challengeToken, code: code }),
    });
    const body = await parseJsonResponse(res);
    if (res.ok && body && typeof body.accessToken === 'string') {
      setAccessToken(body.accessToken);
    }
    return { status: res.status, body: body };
  }

  async function setupLoginMfaChallenge(challengeToken) {
    const res = await rawFetch('/auth/mfa/totp/setup-challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeToken: challengeToken }),
    });
    return { status: res.status, body: await parseJsonResponse(res) };
  }

  async function confirmLoginMfaChallenge(challengeToken, code) {
    const res = await rawFetch('/auth/mfa/totp/confirm-challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeToken: challengeToken, code: code }),
    });
    const body = await parseJsonResponse(res);
    if (res.ok && body && typeof body.accessToken === 'string') {
      setAccessToken(body.accessToken);
    }
    return { status: res.status, body: body };
  }

  // ─────────────────────────────────────────────
  // Phase 7 Step 2 — Authenticated MFA management.
  //
  // These ride on the existing session (Bearer + auto-refresh), so
  // they return the raw Response like other Phase 4/5 helpers. The
  // caller is expected to inspect res.ok and read res.json() — error
  // bodies follow the AuthError shape `{ error, code }`.
  //
  // disableTotp sends a body on DELETE, which the in-tree apiDelete
  // helper doesn't support, so it calls authFetch directly with the
  // explicit Content-Type header.
  // ─────────────────────────────────────────────
  function startAuthenticatedTotpSetup(currentPassword) {
    return apiPost('/auth/mfa/totp/setup', { currentPassword: currentPassword });
  }

  function confirmAuthenticatedTotp(code) {
    return apiPost('/auth/mfa/totp/confirm', { code: code });
  }

  function disableTotp(currentPassword, code) {
    return authFetch('/auth/mfa/totp', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: currentPassword, code: code }),
    });
  }

  // ─────────────────────────────────────────────
  // Phase 7 Step 2 — Organization security (admin-only on PATCH).
  //
  // GET surfaces { mfa_required, current_user_mfa_enabled,
  // members_without_mfa_count? }. PATCH body is strict — only
  // `mfa_required` is accepted; stray fields hit 400. Non-admin
  // callers get 403 on both endpoints.
  // ─────────────────────────────────────────────
  function getOrganizationSecurity() {
    return apiGet('/organization/security');
  }

  function setOrganizationMfaRequired(required) {
    return apiPatch('/organization/security', { mfa_required: !!required });
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

  // Phase 6 Step 3 — hard delete. Server returns 204 No Content on
  // success; the caller should reload the detail panel afterwards.
  function deleteActionItem(id) {
    return apiDelete('/call-action-items/' + encodeURIComponent(id));
  }

  function getDashboardSummary() {
    return apiGet('/dashboard/summary');
  }

  // Phase 6 Step 4 + Phase 7 Step 7 — manager / admin team-scope report.
  //   params.teamId : optional uuid. Admin without teamId returns the
  //                   org-wide summary; manager omits to get own team.
  //                   Server returns 403 for employee/viewer or manager
  //                   other-team, 404 for cross-org team_id.
  //   params.from   : optional YYYY-MM-DD (UTC). Must be paired with
  //                   params.to or the server returns 400.
  //   params.to     : optional YYYY-MM-DD (UTC), inclusive UI end.
  // When from/to are both omitted the server resolves a default 30-day
  // window. URLSearchParams.set() handles all string escaping; never
  // concatenate raw strings into the URL.
  function getTeamReportSummary(params) {
    const p = params || {};
    const qs = new URLSearchParams();
    if (p.teamId) qs.set('team_id', String(p.teamId));
    if (p.from) qs.set('from', String(p.from));
    if (p.to) qs.set('to', String(p.to));
    const query = qs.toString();
    return apiGet('/reports/team-summary' + (query ? '?' + query : ''));
  }

  // ─────────────────────────────────────────────
  // Phase 5 — knowledge bases / checklist templates / call checklist /
  // call suggestions / call meta (link, summary). Plan:
  // docs/plan/phase-5/PHASE_5_STEP_4_CLIENT.md §3.
  //
  // All helpers return the raw Response so callers stay consistent with
  // Phase 4. The server collapses missing / cross-org / soft-deleted
  // into 404; 403 surfaces forbidden; 409 surfaces conflict_state for
  // suggestion already-used/dismissed transitions and conflict for
  // unique constraint hits.
  // ─────────────────────────────────────────────

  // Knowledge bases ---------------------------------------------------

  function listKnowledgeBases(query) {
    const q = query || {};
    const params = new URLSearchParams();
    Object.keys(q).forEach(function (k) {
      const v = q[k];
      if (v === undefined || v === null || v === '') return;
      params.set(k, String(v));
    });
    const qs = params.toString();
    return apiGet('/knowledge-bases' + (qs ? '?' + qs : ''));
  }

  function getKnowledgeBase(id) {
    return apiGet('/knowledge-bases/' + encodeURIComponent(id));
  }

  function createKnowledgeBase(input) {
    return apiPost('/knowledge-bases', input || {});
  }

  function patchKnowledgeBase(id, input) {
    return apiPatch('/knowledge-bases/' + encodeURIComponent(id), input || {});
  }

  function deleteKnowledgeBase(id) {
    return apiDelete('/knowledge-bases/' + encodeURIComponent(id));
  }

  function replaceKnowledgeChunks(id, chunks) {
    return apiPost(
      '/knowledge-bases/' + encodeURIComponent(id) + '/chunks/replace',
      { chunks: chunks || [] },
    );
  }

  function searchKnowledge(query, limit) {
    const body = { query: query };
    if (typeof limit === 'number') body.limit = limit;
    return apiPost('/knowledge-bases/search', body);
  }

  // Checklist templates ----------------------------------------------

  function listChecklistTemplates() {
    return apiGet('/call-checklist-templates');
  }

  function createChecklistTemplate(input) {
    return apiPost('/call-checklist-templates', input || {});
  }

  function patchChecklistTemplate(id, input) {
    return apiPatch(
      '/call-checklist-templates/' + encodeURIComponent(id),
      input || {},
    );
  }

  function deleteChecklistTemplate(id) {
    return apiDelete('/call-checklist-templates/' + encodeURIComponent(id));
  }

  // Call checklist (per-call snapshot) -------------------------------

  function initializeCallChecklist(callId) {
    return apiPost(
      '/calls/' + encodeURIComponent(callId) + '/checklist/initialize',
      {},
    );
  }

  function listCallChecklist(callId) {
    return apiGet('/calls/' + encodeURIComponent(callId) + '/checklist');
  }

  function patchCallChecklistItemStatus(itemId, status) {
    return apiPost(
      '/call-checklist-items/' + encodeURIComponent(itemId) + '/status',
      { status: status },
    );
  }

  // Call suggestions --------------------------------------------------

  function listCallSuggestions(callId) {
    return apiGet('/calls/' + encodeURIComponent(callId) + '/suggestions');
  }

  function useCallSuggestion(id) {
    return apiPost(
      '/call-suggestions/' + encodeURIComponent(id) + '/use',
      {},
    );
  }

  function dismissCallSuggestion(id) {
    return apiPost(
      '/call-suggestions/' + encodeURIComponent(id) + '/dismiss',
      {},
    );
  }

  // Call meta — customer link / manual summary -----------------------

  function linkCallCustomer(callId, customerId) {
    return apiPost(
      '/calls/' + encodeURIComponent(callId) + '/link-customer',
      { customer_id: customerId },
    );
  }

  function unlinkCallCustomer(callId) {
    return apiPost(
      '/calls/' + encodeURIComponent(callId) + '/unlink-customer',
      {},
    );
  }

  // input shape: { summary, needs, issues, sentiment }. Callers pass
  // null for cleared fields (server CallSummaryManualInput accepts
  // string|null on each of the four fields).
  function patchCallManualSummary(callId, input) {
    return apiPost(
      '/calls/' + encodeURIComponent(callId) + '/summary/manual',
      input || {},
    );
  }

  // /calls/:id/heartbeat exists as a REST fallback (Step 3 routes plan
  // §2.3) but the primary path is the WS heartbeat event, so the page
  // helper for that lives in ws.js. We still expose this thin wrapper
  // for the rare fallback case (WebSocket blocked by corporate proxy).
  function postCallHeartbeat(callId) {
    return apiPost(
      '/calls/' + encodeURIComponent(callId) + '/heartbeat',
      {},
    );
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

    // Phase 7 Step 2 — MFA login (anonymous, 5-min challengeToken).
    verifyLoginMfa: verifyLoginMfa,
    setupLoginMfaChallenge: setupLoginMfaChallenge,
    confirmLoginMfaChallenge: confirmLoginMfaChallenge,

    // Phase 7 Step 2 — MFA management (authenticated).
    startAuthenticatedTotpSetup: startAuthenticatedTotpSetup,
    confirmAuthenticatedTotp: confirmAuthenticatedTotp,
    disableTotp: disableTotp,

    // Phase 7 Step 2 — Organization security (admin-only PATCH).
    getOrganizationSecurity: getOrganizationSecurity,
    setOrganizationMfaRequired: setOrganizationMfaRequired,

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
    deleteActionItem: deleteActionItem,
    getDashboardSummary: getDashboardSummary,
    getTeamReportSummary: getTeamReportSummary,

    // Phase 5 — knowledge / checklist / suggestion / call meta.
    listKnowledgeBases: listKnowledgeBases,
    getKnowledgeBase: getKnowledgeBase,
    createKnowledgeBase: createKnowledgeBase,
    patchKnowledgeBase: patchKnowledgeBase,
    deleteKnowledgeBase: deleteKnowledgeBase,
    replaceKnowledgeChunks: replaceKnowledgeChunks,
    searchKnowledge: searchKnowledge,
    listChecklistTemplates: listChecklistTemplates,
    createChecklistTemplate: createChecklistTemplate,
    patchChecklistTemplate: patchChecklistTemplate,
    deleteChecklistTemplate: deleteChecklistTemplate,
    initializeCallChecklist: initializeCallChecklist,
    listCallChecklist: listCallChecklist,
    patchCallChecklistItemStatus: patchCallChecklistItemStatus,
    listCallSuggestions: listCallSuggestions,
    useCallSuggestion: useCallSuggestion,
    dismissCallSuggestion: dismissCallSuggestion,
    linkCallCustomer: linkCallCustomer,
    unlinkCallCustomer: unlinkCallCustomer,
    patchCallManualSummary: patchCallManualSummary,
    postCallHeartbeat: postCallHeartbeat,

    // Read-only config — ws.js consumes this so the WS URL stays in
    // sync with the API base.
    apiBaseUrl: API_BASE_URL,
  };
})();

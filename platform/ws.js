/* Kloser Platform — WebSocket client wrapper (Phase 1 step 4).
 *
 * Thin facade over socket.io-client for the /calls namespace.
 * Loaded as a classic <script>; depends on:
 *   - window.io           (socket.io-client UMD bundle, loaded earlier)
 *   - window.kloserApi    (api.js, loaded earlier — for refresh + apiBaseUrl)
 *
 * Surface (window.kloserWS):
 *   - connectCallNamespace({ baseUrl?, tokenProvider, onAuthFailure? }) -> socket
 *   - startCall(socket, payload) -> Promise<{ callId }>
 *   - sendTextChunk(socket, { seq, text })  // clientSentAt auto-injected
 *   - endCall(socket) -> Promise<{ ok: boolean }>
 *   - onTranscript / onSuggestion / onSentiment / onError(socket, cb)
 *
 * Step 4 contract changes vs. the Phase 0.5 spike:
 *   - `userId` query parameter is gone. Identity comes from the JWT.
 *   - `auth: { token: tokenProvider() }` is the only handshake signal.
 *     `tokenProvider` is a function so reconnect attempts can pull a
 *     freshly refreshed token without recreating the socket.
 *   - On `connect_error` with err.data.code in
 *     {missing_token, expired_token, invalid_token}, the wrapper
 *     calls kloserApi.refreshAccessToken() and reconnects exactly
 *     once. If refresh fails, onAuthFailure() is called (default:
 *     kloserApi.loginRedirect()).
 *   - `__liveSocket` dev handle is set ONLY on localhost variants
 *     (localhost / 127.0.0.1 / ::1 / [::1]). Any other host — prod,
 *     staging, *.localhost.test — gets no global handle.
 */
(function () {
  'use strict';

  function requireSocketIO() {
    if (typeof window.io !== 'function') {
      throw new Error('[kloserWS] socket.io-client not loaded — include the CDN script before ws.js');
    }
  }

  function isDevHost() {
    const h = window.location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  }

  function defaultBaseUrl() {
    if (window.kloserApi && typeof window.kloserApi.apiBaseUrl === 'string' && window.kloserApi.apiBaseUrl.length > 0) {
      return window.kloserApi.apiBaseUrl;
    }
    return 'http://localhost:3001';
  }

  function connectCallNamespace(opts) {
    requireSocketIO();
    opts = opts || {};
    const tokenProvider = opts.tokenProvider;
    if (typeof tokenProvider !== 'function') {
      throw new Error('[kloserWS] connectCallNamespace requires opts.tokenProvider () => string|null');
    }
    const onAuthFailure =
      typeof opts.onAuthFailure === 'function'
        ? opts.onAuthFailure
        : function () {
            if (window.kloserApi && typeof window.kloserApi.loginRedirect === 'function') {
              window.kloserApi.loginRedirect();
            }
          };
    const baseUrl = (opts.baseUrl || defaultBaseUrl()).replace(/\/+$/, '');
    const url = baseUrl + '/calls';

    const socket = window.io(url, {
      auth: { token: tokenProvider() || '' },
      transports: ['websocket'],
      reconnection: true,
    });

    // Automatic reconnects need a fresh token. socket.auth is read at
    // each connection attempt; updating the field before reconnect_attempt
    // (or before our manual socket.connect()) is enough.
    socket.io.on('reconnect_attempt', function () {
      socket.auth = { token: tokenProvider() || '' };
    });

    // The `recovering` latch is set when we kick off a refresh+reconnect
    // and is cleared only when the next `connect` succeeds. If the new
    // attempt also fails with an auth code, we treat it as terminal —
    // refreshAccessToken returned a token the server still rejects, so
    // looping refresh would just burn the refresh-token family.
    let recovering = false;

    socket.on('connect', function () {
      console.log('[kloserWS] connected', socket.id);
      recovering = false;
    });
    socket.on('disconnect', function (reason) {
      console.log('[kloserWS] disconnected', reason);
    });

    // connect_error from server middleware. Server-side codes are
    // pinned: missing_token / expired_token / invalid_token. On any
    // of these, refresh once and try again. On any OTHER error (e.g.,
    // transport failure), let socket.io's own reconnection handle it.
    socket.on('connect_error', function (err) {
      const code = err && err.data && err.data.code;
      console.warn('[kloserWS] connect_error', code || '(no code)', err && err.message);
      const isAuthCode =
        code === 'expired_token' ||
        code === 'invalid_token' ||
        code === 'missing_token';
      if (!isAuthCode) return;

      if (recovering) {
        // We already refreshed once and the new attempt still tripped
        // an auth-code error. Don't burn the refresh family with another
        // pass — surface terminal failure to the caller.
        console.error('[kloserWS] auth refresh did not unblock /calls; bouncing to login');
        try { socket.disconnect(); } catch (_) { /* ignore */ }
        recovering = false;
        onAuthFailure();
        return;
      }

      recovering = true;
      (async function () {
        try {
          if (!window.kloserApi || typeof window.kloserApi.refreshAccessToken !== 'function') {
            throw new Error('kloserApi.refreshAccessToken unavailable');
          }
          await window.kloserApi.refreshAccessToken();
          socket.auth = { token: tokenProvider() || '' };
          socket.connect();
          // Leave `recovering` true here on purpose. It clears when the
          // socket actually `connect`s; if instead another connect_error
          // fires, the early-return branch above takes over.
        } catch (refreshErr) {
          console.error('[kloserWS] auth refresh failed; bouncing to login', refreshErr);
          try { socket.disconnect(); } catch (_) { /* ignore */ }
          recovering = false;
          onAuthFailure();
        }
      })();
    });

    // Dev handle — for tests and console debugging on local boxes only.
    if (isDevHost()) {
      window.__liveSocket = socket;
    }

    return socket;
  }

  function startCall(socket, payload) {
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        reject(new Error('[kloserWS] start_call ack timeout'));
      }, 5000);
      socket.emit('start_call', payload || {}, function (resp) {
        clearTimeout(timer);
        resolve(resp);
      });
    });
  }

  function sendTextChunk(socket, payload) {
    if (!payload || typeof payload.seq !== 'number' || typeof payload.text !== 'string') {
      throw new Error('[kloserWS] sendTextChunk requires { seq:number, text:string }');
    }
    socket.emit('text_chunk', {
      seq: payload.seq,
      text: payload.text,
      clientSentAt: Date.now(),
    });
  }

  function endCall(socket) {
    return new Promise(function (resolve) {
      const timer = setTimeout(function () {
        resolve({ ok: false, reason: 'ack-timeout' });
      }, 2000);
      socket.emit('end_call', {}, function (resp) {
        clearTimeout(timer);
        resolve(resp || { ok: true });
      });
    });
  }

  function onTranscript(socket, cb) { socket.on('transcript', cb); }
  function onSuggestion(socket, cb) { socket.on('suggestion', cb); }
  function onSentiment(socket, cb)  { socket.on('sentiment', cb); }
  function onError(socket, cb)      { socket.on('error', cb); }

  window.kloserWS = {
    connectCallNamespace: connectCallNamespace,
    startCall: startCall,
    sendTextChunk: sendTextChunk,
    endCall: endCall,
    onTranscript: onTranscript,
    onSuggestion: onSuggestion,
    onSentiment: onSentiment,
    onError: onError,
  };
})();

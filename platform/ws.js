/* Kloser Platform — WebSocket client wrapper (Phase 0.5 spike)
 *
 * Thin facade over socket.io-client for the /calls namespace.
 * Loaded as a classic <script>; depends on the socket.io-client UMD
 * bundle being loaded earlier on the page (window.io).
 *
 * Surface (window.kloserWS):
 *   - connectCallNamespace({ baseUrl, userId }) -> socket
 *   - startCall(socket, payload) -> Promise<{ callId }>
 *   - sendTextChunk(socket, { seq, text })  // clientSentAt auto-injected
 *   - endCall(socket) -> Promise<{ ok: boolean }>
 *   - onTranscript / onSuggestion / onSentiment / onError(socket, cb)
 *
 * This file MUST stay light (no build step). Phase 1 may replace it
 * with a typed shared module when monorepo build is decided.
 */
(function () {
  'use strict';

  function requireSocketIO() {
    if (typeof window.io !== 'function') {
      throw new Error('[kloserWS] socket.io-client not loaded — include the CDN script before ws.js');
    }
  }

  function connectCallNamespace(opts) {
    requireSocketIO();
    const baseUrl = (opts && opts.baseUrl) || 'http://localhost:3001';
    const userId = (opts && opts.userId) || 'anonymous';
    const url = baseUrl.replace(/\/$/, '') + '/calls';
    const socket = window.io(url, {
      query: { userId: userId },
      transports: ['websocket'],
      reconnection: true,
    });
    socket.on('connect', function () {
      console.log('[kloserWS] connected', socket.id);
    });
    socket.on('disconnect', function (reason) {
      console.log('[kloserWS] disconnected', reason);
    });
    socket.on('connect_error', function (err) {
      console.error('[kloserWS] connect_error', err.message);
    });
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

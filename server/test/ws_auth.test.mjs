/* /calls WS handshake auth + invariants — Phase 1 Step 4 §1.7.
 *
 * Boots a real Fastify + socket.io server on a random localhost port
 * and drives it with socket.io-client. Verifies the contract pinned
 * in PHASE_1_STEP_4_CLIENT_WIRING.md §1.4 from the client's vantage —
 * server-internal state (`socket.data.user`) isn't observable from a
 * client test, so the happy path checks the connection itself:
 *
 *   handshake `connect_error` codes (3):
 *     - missing_token
 *     - expired_token
 *     - invalid_token
 *   handshake happy path:
 *     - client receives `connect` (server granted the handshake, which
 *       it only does when validateAccessTokenPayload accepts the JWT)
 *   runtime `error` event (1):
 *     - no_active_call (text_chunk without prior start_call)
 *   runtime happy path:
 *     - start_call ack → text_chunk → transcript echo carrying our
 *       clientSentAt — the JWT-derived identity is implicitly verified
 *       because `transcript` only fires for accepted sockets.
 *
 * No DB session row is required for handshake — the JWT signature
 * itself is the trust boundary. We mint tokens directly with
 * app.jwt.sign() so the test doesn't depend on /auth/login.
 *
 * dbPlugin is registered for parity with the other test boots; the
 * handshake doesn't currently touch the DB but will once WS handlers
 * start using `withOrgContext` (Phase 4 calls REST + dashboard).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import { Server as IOServer } from "socket.io";
import { io as ioClient } from "socket.io-client";
import authPlugin from "../src/plugins/auth.js";
import dbPlugin from "../src/plugins/db.js";
import { registerCallsNamespace } from "../src/ws/calls.js";

// Seeded fixtures — see server/seeds/0001_demo.sql.
const ACME_ID                = "11111111-1111-1111-1111-111111111111";
const ACME_ADMIN_USER_ID     = "aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa";
const ACME_ADMIN_MEMBERSHIP  = "cccccccc-0001-0001-0001-cccccccccccc";
// `sid` doesn't have to map to a real session row at handshake time;
// the WS middleware only checks UUID shape on it.
const FAKE_SID               = "11111111-2222-3333-4444-555555555555";

let app;
let io;
let port;

function validPayload() {
  return {
    sub:          ACME_ADMIN_USER_ID,
    orgId:        ACME_ID,
    membershipId: ACME_ADMIN_MEMBERSHIP,
    role:         "admin",
    sid:          FAKE_SID,
  };
}

before(async () => {
  app = Fastify({ logger: false });
  await app.register(authPlugin);
  await app.register(dbPlugin);
  await app.listen({ host: "127.0.0.1", port: 0 });
  io = new IOServer(app.server);
  registerCallsNamespace(io, app);
  port = app.server.address().port;
});

after(async () => {
  if (io) io.close();
  if (app) await app.close();
});

function clientUrl() {
  return `http://127.0.0.1:${port}/calls`;
}

function clientOpts(extra) {
  return Object.assign(
    { transports: ["websocket"], reconnection: false, timeout: 3000 },
    extra || {},
  );
}

// Helpers — listen for either connect or connect_error and resolve once.
function awaitConnectError(socket) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for connect_error")), 3000);
    socket.once("connect_error", (err) => { clearTimeout(t); resolve(err); });
    socket.once("connect", () => { clearTimeout(t); reject(new Error("expected connect_error but connected")); });
  });
}
function awaitConnect(socket) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for connect")), 3000);
    socket.once("connect", () => { clearTimeout(t); resolve(); });
    socket.once("connect_error", (err) => { clearTimeout(t); reject(err); });
  });
}

// --- handshake — error codes ---

test("handshake: missing token → connect_error code 'missing_token'", async () => {
  const socket = ioClient(clientUrl(), clientOpts({ auth: {} }));
  try {
    const err = await awaitConnectError(socket);
    assert.equal(err.data?.code, "missing_token");
  } finally {
    socket.disconnect();
  }
});

test("handshake: empty token string → connect_error code 'missing_token'", async () => {
  const socket = ioClient(clientUrl(), clientOpts({ auth: { token: "   " } }));
  try {
    const err = await awaitConnectError(socket);
    assert.equal(err.data?.code, "missing_token");
  } finally {
    socket.disconnect();
  }
});

test("handshake: invalid token (mangled signature) → 'invalid_token'", async () => {
  const valid = app.jwt.sign(validPayload());
  // Mangle the signature segment by replacing the trailing characters.
  const broken = valid.slice(0, -10) + "ZZZZZZZZZZ";
  const socket = ioClient(clientUrl(), clientOpts({ auth: { token: broken } }));
  try {
    const err = await awaitConnectError(socket);
    assert.equal(err.data?.code, "invalid_token");
  } finally {
    socket.disconnect();
  }
});

test("handshake: expired token → 'expired_token'", async () => {
  const expired = app.jwt.sign(validPayload(), { expiresIn: "1ms" });
  // Wait long enough that exp is in the past for any reasonable clock skew.
  await new Promise((r) => setTimeout(r, 50));
  const socket = ioClient(clientUrl(), clientOpts({ auth: { token: expired } }));
  try {
    const err = await awaitConnectError(socket);
    assert.equal(err.data?.code, "expired_token");
  } finally {
    socket.disconnect();
  }
});

test("handshake: malformed shape (valid signature but wrong payload) → 'invalid_token'", async () => {
  // Sign a payload that fails validateAccessTokenPayload (role enum bad).
  const token = app.jwt.sign({ ...validPayload(), role: "supreme-leader" });
  const socket = ioClient(clientUrl(), clientOpts({ auth: { token } }));
  try {
    const err = await awaitConnectError(socket);
    assert.equal(err.data?.code, "invalid_token");
  } finally {
    socket.disconnect();
  }
});

// --- handshake — happy path ---

test("handshake: valid token → connects", async () => {
  const token = app.jwt.sign(validPayload());
  const socket = ioClient(clientUrl(), clientOpts({ auth: { token } }));
  try {
    await awaitConnect(socket);
    assert.ok(socket.connected, "socket.connected after connect event");
    assert.equal(typeof socket.id, "string");
  } finally {
    socket.disconnect();
  }
});

// --- runtime — invariant ---

test("runtime: text_chunk before start_call → error code 'no_active_call'", async () => {
  const token = app.jwt.sign(validPayload());
  const socket = ioClient(clientUrl(), clientOpts({ auth: { token } }));
  try {
    await awaitConnect(socket);
    const err = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting for error event")), 2000);
      socket.once("error", (e) => { clearTimeout(t); resolve(e); });
      socket.emit("text_chunk", { seq: 1, text: "no_call", clientSentAt: Date.now() });
    });
    assert.equal(err.code, "no_active_call");
  } finally {
    socket.disconnect();
  }
});

// --- runtime — happy path ---

test("runtime: start_call → text_chunk → transcript echo with our clientSentAt", async () => {
  const token = app.jwt.sign(validPayload());
  const socket = ioClient(clientUrl(), clientOpts({ auth: { token } }));
  try {
    await awaitConnect(socket);

    // 1. start_call ack
    const ack = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("start_call ack timeout")), 2000);
      socket.emit("start_call", { customerId: "test-customer" }, (resp) => {
        clearTimeout(t);
        resolve(resp);
      });
    });
    assert.ok(ack && typeof ack.callId === "string", "start_call returned a callId");

    // 2. emit text_chunk; wait for the transcript that carries OUR
    //    clientSentAt back. The demo fixture pushes its own transcripts
    //    too (without clientSentAt), so filter explicitly.
    const stamp = Date.now();
    const echo = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("echo timeout")), 2000);
      const handler = (ev) => {
        if (ev && ev.clientSentAt === stamp) {
          socket.off("transcript", handler);
          clearTimeout(t);
          resolve(ev);
        }
      };
      socket.on("transcript", handler);
      socket.emit("text_chunk", { seq: 99, text: "hello kloser", clientSentAt: stamp });
    });
    assert.equal(echo.seq, 99);
    assert.equal(echo.text, "hello kloser");
    assert.equal(echo.clientSentAt, stamp);
    assert.equal(typeof echo.serverSentAt, "number");
  } finally {
    socket.disconnect();
  }
});

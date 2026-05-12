/* Phase 4 Step 3 — /calls WS persistence hook.
 *
 * Plan: docs/plan/phase-4/PHASE_4_STEP_3_ROUTES.md §6, §7.4.
 *
 * Boots a Fastify + socket.io server on a random localhost port and
 * drives the namespace with socket.io-client to verify the persistence
 * additions:
 *
 *   - start_call ack returns a DB-resident call id
 *   - text_chunk persists one transcripts row before the echo
 *   - end_call flips status='ended' and timestamps
 *   - BAD_PAYLOAD / no_active_call legacy invariants stay intact
 *
 * The handshake / runtime spec tests stay in ws_auth.test.mjs so this
 * file scopes purely to persistence.
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import { Server as IOServer } from "socket.io";
import { io as ioClient } from "socket.io-client";
import authPlugin from "../src/plugins/auth.js";
import dbPlugin from "../src/plugins/db.js";
import { registerCallsNamespace } from "../src/ws/calls.js";

const ACME_ID                = "11111111-1111-1111-1111-111111111111";
const ACME_ADMIN_USER_ID     = "aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa";
const ACME_ADMIN_MEMBERSHIP  = "cccccccc-0001-0001-0001-cccccccccccc";
const FAKE_SID               = "11111111-2222-3333-4444-555555555555";

let app;
let io;
let port;

function validPayload() {
    return {
        sub: ACME_ADMIN_USER_ID,
        orgId: ACME_ID,
        membershipId: ACME_ADMIN_MEMBERSHIP,
        role: "admin",
        sid: FAKE_SID,
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
    if (app) {
        await app.withOrgContext(ACME_ID, async (client) => {
            await client.query(
                `DELETE FROM calls WHERE agent_user_id = $1`,
                [ACME_ADMIN_USER_ID],
            );
        });
        await app.close();
    }
});

afterEach(async () => {
    await app.withOrgContext(ACME_ID, async (client) => {
        await client.query(
            `DELETE FROM calls WHERE agent_user_id = $1`,
            [ACME_ADMIN_USER_ID],
        );
    });
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

function awaitConnect(socket) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("connect timeout")), 3000);
        socket.once("connect", () => { clearTimeout(t); resolve(); });
        socket.once("connect_error", (err) => { clearTimeout(t); reject(err); });
    });
}

async function connected() {
    const token = app.jwt.sign(validPayload());
    const socket = ioClient(clientUrl(), clientOpts({ auth: { token } }));
    await awaitConnect(socket);
    return socket;
}

function startCall(socket, customerId) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("start_call ack timeout")), 3000);
        socket.emit("start_call", { customerId }, (resp) => {
            clearTimeout(t);
            resolve(resp);
        });
    });
}

function endCall(socket) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("end_call ack timeout")), 3000);
        socket.emit("end_call", {}, (resp) => {
            clearTimeout(t);
            resolve(resp);
        });
    });
}

function emitTextChunk(socket, payload) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("transcript echo timeout")), 3000);
        const handler = (ev) => {
            if (ev && ev.clientSentAt === payload.clientSentAt) {
                socket.off("transcript", handler);
                clearTimeout(t);
                resolve(ev);
            }
        };
        socket.on("transcript", handler);
        socket.emit("text_chunk", payload);
    });
}

async function readCallRow(callId) {
    return app.withOrgContext(ACME_ID, async (client) => {
        const r = await client.query(
            `SELECT id, status, ended_at, agent_user_id
               FROM calls WHERE id = $1`,
            [callId],
        );
        return r.rows[0] ?? null;
    });
}

async function readTranscriptCount(callId) {
    return app.withOrgContext(ACME_ID, async (client) => {
        const r = await client.query(
            `SELECT count(*)::int AS n FROM transcripts WHERE call_id = $1`,
            [callId],
        );
        return r.rows[0].n;
    });
}

// ----------------------------------------------------------------- //
// 1. start_call persists a calls row
// ----------------------------------------------------------------- //

test("start_call ack returns a callId backed by a real calls row", async () => {
    const socket = await connected();
    try {
        const ack = await startCall(socket, null);
        assert.ok(ack && typeof ack.callId === "string");
        const row = await readCallRow(ack.callId);
        assert.ok(row, "calls row should exist");
        assert.equal(row.status, "in_progress");
        assert.equal(row.agent_user_id, ACME_ADMIN_USER_ID);
    } finally {
        socket.disconnect();
    }
});

// ----------------------------------------------------------------- //
// 2. text_chunk persists a transcripts row before the echo
// ----------------------------------------------------------------- //

test("text_chunk appends a transcripts row and still echoes the same chunk", async () => {
    const socket = await connected();
    try {
        const ack = await startCall(socket, null);
        const stamp = Date.now();
        const echo = await emitTextChunk(socket, {
            seq: 0,
            text: "안녕하세요 카운터",
            clientSentAt: stamp,
        });
        assert.equal(echo.seq, 0);
        assert.equal(echo.text, "안녕하세요 카운터");
        assert.equal(echo.clientSentAt, stamp);
        // DB-side count: at least 1. The demo replay also pushes
        // server-driven transcripts on a delay, but they emit on the
        // `transcript` channel only — not into our DB. So count=1.
        const count = await readTranscriptCount(ack.callId);
        assert.equal(count, 1);
    } finally {
        socket.disconnect();
    }
});

// ----------------------------------------------------------------- //
// 3. end_call marks the row ended in DB
// ----------------------------------------------------------------- //

test("end_call sets status='ended' and stamps ended_at", async () => {
    const socket = await connected();
    try {
        const ack = await startCall(socket, null);
        const endAck = await endCall(socket);
        assert.deepEqual(endAck, { ok: true });
        const row = await readCallRow(ack.callId);
        assert.ok(row);
        assert.equal(row.status, "ended");
        assert.ok(row.ended_at instanceof Date);
    } finally {
        socket.disconnect();
    }
});

// ----------------------------------------------------------------- //
// 4. text_chunk before start_call → no_active_call (unchanged)
// ----------------------------------------------------------------- //

test("text_chunk before start_call → error code 'no_active_call' (preserved)", async () => {
    const socket = await connected();
    try {
        const err = await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error("error timeout")), 2000);
            socket.once("error", (e) => { clearTimeout(t); resolve(e); });
            socket.emit("text_chunk", { seq: 1, text: "nope", clientSentAt: Date.now() });
        });
        assert.equal(err.code, "no_active_call");
    } finally {
        socket.disconnect();
    }
});

// ----------------------------------------------------------------- //
// 5. malformed text_chunk shape → BAD_PAYLOAD (unchanged)
// ----------------------------------------------------------------- //

test("text_chunk malformed payload → error code 'BAD_PAYLOAD' (preserved)", async () => {
    const socket = await connected();
    try {
        await startCall(socket, null);
        const err = await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error("error timeout")), 2000);
            socket.once("error", (e) => { clearTimeout(t); resolve(e); });
            socket.emit("text_chunk", { seq: "wrong", text: 42 });
        });
        assert.equal(err.code, "BAD_PAYLOAD");
    } finally {
        socket.disconnect();
    }
});

// ----------------------------------------------------------------- //
// 6. end_call without an active context → ack { ok:false, error:'no_active_call' }
// ----------------------------------------------------------------- //

test("end_call without active call → ack { ok:false, error:'no_active_call' }", async () => {
    const socket = await connected();
    try {
        const ack = await endCall(socket);
        assert.equal(ack.ok, false);
        assert.equal(ack.error, "no_active_call");
    } finally {
        socket.disconnect();
    }
});

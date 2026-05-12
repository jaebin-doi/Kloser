/* Phase 5 Step 3 — /calls WS heartbeat persistence.
 *
 * Plan: docs/plan/phase-5/PHASE_5_STEP_3_ROUTES.md §4, §5.1.
 *
 * Verifies the heartbeat event:
 *   - no_active_call before start_call
 *   - { ok: true, lastSeenAt } after start_call, with DB row reflecting it
 *   - { ok: false, error: 'call_ended' } when the call is no longer in_progress
 *
 * Reuses the bootstrapping pattern from ws_persistence.test.mjs.
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { Server as IOServer } from "socket.io";
import { io as ioClient } from "socket.io-client";
import authPlugin from "../src/plugins/auth.js";
import dbPlugin from "../src/plugins/db.js";
import { registerCallsNamespace } from "../src/ws/calls.js";

const ACME_ID                = "11111111-1111-1111-1111-111111111111";
const ACME_ADMIN_USER_ID     = "aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa";
const ACME_ADMIN_MEMBERSHIP  = "cccccccc-0001-0001-0001-cccccccccccc";

let app;
let io;
let port;

function validPayload() {
    return {
        sub: ACME_ADMIN_USER_ID,
        orgId: ACME_ID,
        membershipId: ACME_ADMIN_MEMBERSHIP,
        role: "admin",
        sid: randomUUID(),
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

function emitWithAck(socket, event, payload) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${event} ack timeout`)), 3000);
        socket.emit(event, payload ?? {}, (resp) => {
            clearTimeout(t);
            resolve(resp);
        });
    });
}

async function readLastSeen(callId) {
    return app.withOrgContext(ACME_ID, async (client) => {
        const r = await client.query(
            `SELECT last_seen_at, status FROM calls WHERE id = $1`,
            [callId],
        );
        return r.rows[0] ?? null;
    });
}

// ----------------------------------------------------------------- //
// 1. heartbeat before start_call → no_active_call
// ----------------------------------------------------------------- //

test("heartbeat before start_call → ack { ok:false, error:'no_active_call' }", async () => {
    const socket = await connected();
    try {
        const ack = await emitWithAck(socket, "heartbeat");
        assert.equal(ack.ok, false);
        assert.equal(ack.error, "no_active_call");
    } finally {
        socket.disconnect();
    }
});

// ----------------------------------------------------------------- //
// 2. heartbeat after start_call → updates last_seen_at
// ----------------------------------------------------------------- //

test("heartbeat after start_call returns ok and updates last_seen_at in DB", async () => {
    const socket = await connected();
    try {
        const start = await emitWithAck(socket, "start_call", { customerId: null });
        assert.ok(start.callId);

        const before = await readLastSeen(start.callId);
        assert.equal(before.last_seen_at, null);

        const ack = await emitWithAck(socket, "heartbeat");
        assert.equal(ack.ok, true);
        assert.ok(ack.lastSeenAt);

        const after = await readLastSeen(start.callId);
        assert.ok(after.last_seen_at instanceof Date);
    } finally {
        socket.disconnect();
    }
});

// ----------------------------------------------------------------- //
// 3. heartbeat after end_call → call_ended
// ----------------------------------------------------------------- //

test("heartbeat after end_call → ack { ok:false, error:'call_ended' }", async () => {
    const socket = await connected();
    try {
        const start = await emitWithAck(socket, "start_call", { customerId: null });
        // Mark the call ended directly in DB (the socket clears its
        // local ctx on end_call ack, which would yield 'no_active_call'
        // — we want the "DB says ended" path).
        await app.withOrgContext(ACME_ID, async (client) => {
            await client.query(
                `UPDATE calls SET status = 'ended', ended_at = now() WHERE id = $1`,
                [start.callId],
            );
        });
        const ack = await emitWithAck(socket, "heartbeat");
        assert.equal(ack.ok, false);
        assert.equal(ack.error, "call_ended");
    } finally {
        socket.disconnect();
    }
});

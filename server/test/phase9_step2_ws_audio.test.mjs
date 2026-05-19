/* Phase 9 Step 2 — /calls WS audio ingest.
 *
 * Plan: docs/plan/phase-9/PHASE_9_STEP_2_PLAN.md.
 *
 * Boots a Fastify + socket.io server on a random localhost port and
 * drives the namespace with socket.io-client. Covers Plan §11 test list:
 *
 *   - lifecycle: audio_start before start_call / chunk before start /
 *                duplicate audio_start
 *   - validation: codec, sample rate, channels, duration, seq, source
 *   - limits: chunk too large, queue backpressure
 *   - happy path: chunks -> final transcript on audio_end
 *   - end_call flushes open audio session
 *   - audio_end then end_call does not duplicate transcript/usage
 *   - text_chunk + audio_chunk coexistence
 *   - llm_usage_log row carries audio_duration_ms_sent / cost_status:mock
 *   - raw audio sentinel does NOT leak to transcripts/usage/console
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";

// Demo replay timers would emit `transcript` events on a delay during
// start_call. They do not persist, but they would pollute our event
// listeners under test. Disable here BEFORE importing ws/calls.ts.
process.env.KLOSER_DEMO_REPLAY = "0";

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

// 16-byte raw audio sentinel — must never appear in DB / usage / console.
const SENTINEL_HEX = "DEADBEEF4B4C4F5345525F4155444F4F";
const SENTINEL_ASCII = "KLOSER_AUDOO"; // matches bytes 4..15 above as text
const SENTINEL_BYTES = Buffer.from(SENTINEL_HEX, "hex");

let app;
let io;
let port;
let consoleCapture = null;
let origConsoleLog;
let origConsoleWarn;
let origConsoleError;

function validPayload() {
    return {
        sub: ACME_ADMIN_USER_ID,
        orgId: ACME_ID,
        membershipId: ACME_ADMIN_MEMBERSHIP,
        role: "admin",
        sid: FAKE_SID,
    };
}

function startConsoleCapture() {
    consoleCapture = [];
    origConsoleLog = console.log;
    origConsoleWarn = console.warn;
    origConsoleError = console.error;
    const push = (level) => (...args) => {
        try {
            consoleCapture.push(level + ": " + args.map(stringifyArg).join(" "));
        } catch {
            consoleCapture.push(level + ": [unstringifiable]");
        }
    };
    console.log = push("log");
    console.warn = push("warn");
    console.error = push("error");
}
function stringifyArg(a) {
    if (Buffer.isBuffer(a)) return `<Buffer length=${a.length}>`;
    if (typeof a === "string") return a;
    try { return JSON.stringify(a); } catch { return String(a); }
}
function stopConsoleCapture() {
    if (origConsoleLog) console.log = origConsoleLog;
    if (origConsoleWarn) console.warn = origConsoleWarn;
    if (origConsoleError) console.error = origConsoleError;
    const out = consoleCapture ?? [];
    consoleCapture = null;
    origConsoleLog = origConsoleWarn = origConsoleError = undefined;
    return out;
}

before(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    await app.register(dbPlugin);
    await app.listen({ host: "127.0.0.1", port: 0 });
    io = new IOServer(app.server, { maxHttpBufferSize: 2 * 1024 * 1024 });
    registerCallsNamespace(io, app);
    port = app.server.address().port;
});

after(async () => {
    if (io) io.close();
    if (app) {
        await cleanupDb();
        await app.close();
    }
});

afterEach(async () => {
    await cleanupDb();
});

async function cleanupDb() {
    await app.withOrgContext(ACME_ID, async (client) => {
        await client.query(
            `DELETE FROM llm_usage_log
              WHERE call_id IN (SELECT id FROM calls WHERE agent_user_id = $1)`,
            [ACME_ADMIN_USER_ID],
        );
        await client.query(
            `DELETE FROM calls WHERE agent_user_id = $1`,
            [ACME_ADMIN_USER_ID],
        );
    });
}

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
function startCall(socket) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("start_call ack timeout")), 3000);
        socket.emit("start_call", {}, (resp) => { clearTimeout(t); resolve(resp); });
    });
}
function endCall(socket) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("end_call ack timeout")), 3000);
        socket.emit("end_call", {}, (resp) => { clearTimeout(t); resolve(resp); });
    });
}
function nextError(socket) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("error event timeout")), 2000);
        socket.once("error", (e) => { clearTimeout(t); resolve(e); });
    });
}
function waitMs(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function audioStart(sources = ["agent_mic"], extra = {}) {
    return {
        type: "audio_start",
        sources,
        codec: "pcm_s16le",
        sample_rate_hz: 16000,
        channels: 1,
        frame_ms: 40,
        app_version: "test-0.0.1",
        ...extra,
    };
}
function chunkMeta(source, seq, durationMs = 40) {
    return {
        type: "audio_chunk",
        seq,
        source,
        codec: "pcm_s16le",
        sample_rate_hz: 16000,
        channels: 1,
        duration_ms: durationMs,
        started_at_ms: 0,
    };
}
function pcmBytes(byteLen, fill = 0x77) {
    // 0x77 keeps content away from common patterns including 0x00.
    const b = Buffer.alloc(byteLen);
    b.fill(fill);
    return b;
}

async function readTranscripts(callId) {
    return app.withOrgContext(ACME_ID, async (client) => {
        const r = await client.query(
            `SELECT seq, speaker, text
               FROM transcripts WHERE call_id = $1 ORDER BY seq ASC`,
            [callId],
        );
        return r.rows;
    });
}
async function readUsageRows(callId) {
    return app.withOrgContext(ACME_ID, async (client) => {
        const r = await client.query(
            `SELECT provider, operation, model, status, metadata
               FROM llm_usage_log WHERE call_id = $1
              ORDER BY created_at ASC`,
            [callId],
        );
        return r.rows;
    });
}

// --------------------------------------------------------------------- //
// 1. audio_start before start_call -> no_active_call
// --------------------------------------------------------------------- //
test("audio_start before start_call -> error no_active_call", async () => {
    const socket = await connected();
    try {
        const errP = nextError(socket);
        socket.emit("audio_start", audioStart());
        const err = await errP;
        assert.equal(err.code, "no_active_call");
    } finally { socket.disconnect(); }
});

// --------------------------------------------------------------------- //
// 2. audio_chunk before audio_start -> no_active_audio
// --------------------------------------------------------------------- //
test("audio_chunk before audio_start -> error no_active_audio", async () => {
    const socket = await connected();
    try {
        await startCall(socket);
        const errP = nextError(socket);
        socket.emit("audio_chunk", chunkMeta("agent_mic", 1), pcmBytes(64));
        const err = await errP;
        assert.equal(err.code, "no_active_audio");
    } finally { socket.disconnect(); }
});

// --------------------------------------------------------------------- //
// 3. duplicate audio_start -> audio_already_started
// --------------------------------------------------------------------- //
test("duplicate audio_start -> error audio_already_started", async () => {
    const socket = await connected();
    try {
        await startCall(socket);
        socket.emit("audio_start", audioStart());
        await waitMs(40); // first audio_start does not ack; let it land
        const errP = nextError(socket);
        socket.emit("audio_start", audioStart());
        const err = await errP;
        assert.equal(err.code, "audio_already_started");
    } finally { socket.disconnect(); }
});

// --------------------------------------------------------------------- //
// 4. invalid meta fields -> BAD_PAYLOAD (codec / sample_rate / channels /
//    duration / seq)
// --------------------------------------------------------------------- //
test("audio_chunk meta invalid codec -> BAD_PAYLOAD", async () => {
    const socket = await connected();
    try {
        await startCall(socket);
        socket.emit("audio_start", audioStart());
        await waitMs(40);
        const errP = nextError(socket);
        socket.emit("audio_chunk",
            { ...chunkMeta("agent_mic", 1), codec: "opus" },
            pcmBytes(64),
        );
        const err = await errP;
        assert.equal(err.code, "BAD_PAYLOAD");
    } finally { socket.disconnect(); }
});

test("audio_chunk meta invalid sample_rate -> BAD_PAYLOAD", async () => {
    const socket = await connected();
    try {
        await startCall(socket);
        socket.emit("audio_start", audioStart());
        await waitMs(40);
        const errP = nextError(socket);
        socket.emit("audio_chunk",
            { ...chunkMeta("agent_mic", 1), sample_rate_hz: 48000 },
            pcmBytes(64),
        );
        const err = await errP;
        assert.equal(err.code, "BAD_PAYLOAD");
    } finally { socket.disconnect(); }
});

test("audio_chunk meta invalid channels -> BAD_PAYLOAD", async () => {
    const socket = await connected();
    try {
        await startCall(socket);
        socket.emit("audio_start", audioStart());
        await waitMs(40);
        const errP = nextError(socket);
        socket.emit("audio_chunk",
            { ...chunkMeta("agent_mic", 1), channels: 2 },
            pcmBytes(64),
        );
        const err = await errP;
        assert.equal(err.code, "BAD_PAYLOAD");
    } finally { socket.disconnect(); }
});

test("audio_chunk meta invalid duration_ms (>500) -> BAD_PAYLOAD", async () => {
    const socket = await connected();
    try {
        await startCall(socket);
        socket.emit("audio_start", audioStart());
        await waitMs(40);
        const errP = nextError(socket);
        socket.emit("audio_chunk",
            { ...chunkMeta("agent_mic", 1, 501) },
            pcmBytes(64),
        );
        const err = await errP;
        assert.equal(err.code, "BAD_PAYLOAD");
    } finally { socket.disconnect(); }
});

test("audio_chunk meta non-positive seq -> BAD_PAYLOAD", async () => {
    const socket = await connected();
    try {
        await startCall(socket);
        socket.emit("audio_start", audioStart());
        await waitMs(40);
        const errP = nextError(socket);
        socket.emit("audio_chunk",
            { ...chunkMeta("agent_mic", 0) },
            pcmBytes(64),
        );
        const err = await errP;
        assert.equal(err.code, "BAD_PAYLOAD");
    } finally { socket.disconnect(); }
});

// --------------------------------------------------------------------- //
// 5. source not in declared sources -> BAD_PAYLOAD
// --------------------------------------------------------------------- //
test("audio_chunk source not in audio_start.sources -> BAD_PAYLOAD", async () => {
    const socket = await connected();
    try {
        await startCall(socket);
        socket.emit("audio_start", audioStart(["agent_mic"]));
        await waitMs(40);
        const errP = nextError(socket);
        socket.emit("audio_chunk",
            chunkMeta("system_loopback", 1),
            pcmBytes(64),
        );
        const err = await errP;
        assert.equal(err.code, "BAD_PAYLOAD");
    } finally { socket.disconnect(); }
});

// --------------------------------------------------------------------- //
// 6. chunk > 128 KiB -> AUDIO_CHUNK_TOO_LARGE
// --------------------------------------------------------------------- //
test("audio_chunk > 128 KiB -> AUDIO_CHUNK_TOO_LARGE", async () => {
    const socket = await connected();
    try {
        await startCall(socket);
        socket.emit("audio_start", audioStart());
        await waitMs(40);
        const errP = nextError(socket);
        socket.emit("audio_chunk",
            chunkMeta("agent_mic", 1),
            pcmBytes(128 * 1024 + 1),
        );
        const err = await errP;
        assert.equal(err.code, "AUDIO_CHUNK_TOO_LARGE");
    } finally { socket.disconnect(); }
});

// --------------------------------------------------------------------- //
// 7. duplicate / decreasing per-source seq -> AUDIO_SEQ_OUT_OF_ORDER
// --------------------------------------------------------------------- //
test("duplicate seq for same source -> AUDIO_SEQ_OUT_OF_ORDER", async () => {
    const socket = await connected();
    try {
        await startCall(socket);
        socket.emit("audio_start", audioStart());
        await waitMs(40);
        socket.emit("audio_chunk", chunkMeta("agent_mic", 5), pcmBytes(64));
        await waitMs(20);
        const errP = nextError(socket);
        socket.emit("audio_chunk", chunkMeta("agent_mic", 5), pcmBytes(64));
        const err = await errP;
        assert.equal(err.code, "AUDIO_SEQ_OUT_OF_ORDER");
    } finally { socket.disconnect(); }
});

test("decreasing seq for same source -> AUDIO_SEQ_OUT_OF_ORDER", async () => {
    const socket = await connected();
    try {
        await startCall(socket);
        socket.emit("audio_start", audioStart());
        await waitMs(40);
        socket.emit("audio_chunk", chunkMeta("agent_mic", 5), pcmBytes(64));
        await waitMs(20);
        const errP = nextError(socket);
        socket.emit("audio_chunk", chunkMeta("agent_mic", 3), pcmBytes(64));
        const err = await errP;
        assert.equal(err.code, "AUDIO_SEQ_OUT_OF_ORDER");
    } finally { socket.disconnect(); }
});

// --------------------------------------------------------------------- //
// 8. queue overflow -> AUDIO_BACKPRESSURE
//
// Send a burst of max-size chunks faster than the 1s decay window.
// 1 MiB cap / 128 KiB per chunk -> 8 fit, the 9th must trip.
// --------------------------------------------------------------------- //
test("rolling queued bytes > 1 MiB -> AUDIO_BACKPRESSURE", async () => {
    const socket = await connected();
    try {
        await startCall(socket);
        socket.emit("audio_start", audioStart());
        await waitMs(20);
        const errP = nextError(socket);
        for (let i = 1; i <= 9; i++) {
            socket.emit(
                "audio_chunk",
                chunkMeta("agent_mic", i),
                pcmBytes(128 * 1024),
            );
        }
        const err = await errP;
        assert.equal(err.code, "AUDIO_BACKPRESSURE");
    } finally { socket.disconnect(); }
});

// --------------------------------------------------------------------- //
// 9. valid chunks -> mock final transcript appended on audio_end
//    + llm_usage_log row carries audio_duration_ms_sent / cost_status:mock
// --------------------------------------------------------------------- //
test("audio_end after valid chunks persists mock final + usage row", async () => {
    const socket = await connected();
    try {
        const ack = await startCall(socket);
        const callId = ack.callId;
        socket.emit("audio_start", audioStart(["agent_mic", "system_loopback"]));
        await waitMs(40);
        // 2 frames per source, duration_ms=40 each -> total 160 ms
        socket.emit("audio_chunk", chunkMeta("agent_mic", 1, 40), pcmBytes(64));
        socket.emit("audio_chunk", chunkMeta("agent_mic", 2, 40), pcmBytes(64));
        socket.emit("audio_chunk", chunkMeta("system_loopback", 1, 40), pcmBytes(64));
        socket.emit("audio_chunk", chunkMeta("system_loopback", 2, 40), pcmBytes(64));
        await waitMs(60);
        socket.emit("audio_end", { type: "audio_end", reason: "normal" });
        await waitMs(120);

        const rows = await readTranscripts(callId);
        const texts = rows.map((r) => `${r.speaker}:${r.text}`).sort();
        assert.deepEqual(texts, [
            "agent:Mock agent audio transcript",
            "customer:Mock customer audio transcript",
        ]);

        const usage = await readUsageRows(callId);
        assert.equal(usage.length, 1);
        assert.equal(usage[0].provider, "mock");
        assert.equal(usage[0].operation, "stt_transcribe");
        assert.equal(usage[0].model, "mock-streaming-stt-v1");
        assert.equal(usage[0].status, "succeeded");
        assert.equal(usage[0].metadata.source, "ws:audio");
        assert.equal(usage[0].metadata.cost_status, "mock");
        assert.equal(usage[0].metadata.audio_duration_ms_sent, 160);
        assert.equal(usage[0].metadata.final_count, 2);
    } finally { socket.disconnect(); }
});

// --------------------------------------------------------------------- //
// 10. end_call flushes an open audio session before tearing the call down
// --------------------------------------------------------------------- //
test("audio_end surfaces call_not_found when call vanished before flush", async () => {
    const socket = await connected();
    try {
        const ack = await startCall(socket);
        socket.emit("audio_start", audioStart(["agent_mic"]));
        await waitMs(30);
        socket.emit("audio_chunk", chunkMeta("agent_mic", 1, 60), pcmBytes(64));
        await waitMs(30);

        await app.withOrgContext(ACME_ID, async (client) => {
            await client.query(
                `UPDATE calls SET deleted_at = now() WHERE id = $1`,
                [ack.callId],
            );
        });

        const errP = nextError(socket);
        socket.emit("audio_end", { type: "audio_end" });
        const err = await errP;
        assert.equal(err.code, "call_not_found");

        const rows = await readTranscripts(ack.callId);
        assert.equal(rows.length, 0);
        const usage = await readUsageRows(ack.callId);
        assert.equal(usage.length, 1);
        assert.equal(usage[0].metadata.audio_duration_ms_sent, 60);
    } finally { socket.disconnect(); }
});

// --------------------------------------------------------------------- //
// 11. end_call flushes an open audio session before tearing the call down
// --------------------------------------------------------------------- //
test("end_call flushes open audio session", async () => {
    const socket = await connected();
    try {
        const ack = await startCall(socket);
        socket.emit("audio_start", audioStart(["agent_mic"]));
        await waitMs(30);
        socket.emit("audio_chunk", chunkMeta("agent_mic", 1, 60), pcmBytes(64));
        await waitMs(30);
        const endAck = await endCall(socket);
        assert.deepEqual(endAck, { ok: true });

        const rows = await readTranscripts(ack.callId);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].text, "Mock agent audio transcript");

        const usage = await readUsageRows(ack.callId);
        assert.equal(usage.length, 1);
        assert.equal(usage[0].metadata.audio_duration_ms_sent, 60);
    } finally { socket.disconnect(); }
});

// --------------------------------------------------------------------- //
// 12. audio_end then end_call -> idempotent flush (no duplicate rows)
// --------------------------------------------------------------------- //
test("audio_end then end_call does not duplicate transcript/usage rows", async () => {
    const socket = await connected();
    try {
        const ack = await startCall(socket);
        socket.emit("audio_start", audioStart(["agent_mic"]));
        await waitMs(30);
        socket.emit("audio_chunk", chunkMeta("agent_mic", 1, 80), pcmBytes(64));
        await waitMs(30);
        socket.emit("audio_end", { type: "audio_end" });
        await waitMs(120);
        const endAck = await endCall(socket);
        assert.deepEqual(endAck, { ok: true });

        const rows = await readTranscripts(ack.callId);
        assert.equal(rows.length, 1, "single transcript after dual flush");
        const usage = await readUsageRows(ack.callId);
        assert.equal(usage.length, 1, "single usage row after dual flush");
    } finally { socket.disconnect(); }
});

// --------------------------------------------------------------------- //
// 13. text_chunk + audio_chunk can coexist; text_chunk regression intact
// --------------------------------------------------------------------- //
test("text_chunk and audio_chunk coexist in the same call", async () => {
    const socket = await connected();
    try {
        const ack = await startCall(socket);
        const stamp = Date.now();
        // text_chunk first; echo confirms it persisted via existing path.
        const echo = await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error("text echo timeout")), 3000);
            const onTranscript = (ev) => {
                if (ev.clientSentAt === stamp) {
                    clearTimeout(t);
                    socket.off("transcript", onTranscript);
                    resolve(ev);
                }
            };
            socket.on("transcript", onTranscript);
            socket.emit("text_chunk", { seq: 0, text: "from text", clientSentAt: stamp });
        });
        assert.equal(echo.text, "from text");

        // Now start audio and feed a chunk.
        socket.emit("audio_start", audioStart(["agent_mic"]));
        await waitMs(30);
        socket.emit("audio_chunk", chunkMeta("agent_mic", 1, 40), pcmBytes(64));
        await waitMs(30);
        socket.emit("audio_end", { type: "audio_end" });
        await waitMs(120);

        const rows = await readTranscripts(ack.callId);
        // 1 from text + 1 from audio mock final
        assert.equal(rows.length, 2);
        const texts = rows.map((r) => r.text).sort();
        assert.deepEqual(texts, ["Mock agent audio transcript", "from text"]);
    } finally { socket.disconnect(); }
});

// --------------------------------------------------------------------- //
// 14. raw audio sentinel does NOT leak to DB / usage / console
// --------------------------------------------------------------------- //
test("raw audio bytes never appear in transcripts/usage/console", async () => {
    const socket = await connected();
    startConsoleCapture();
    try {
        const ack = await startCall(socket);
        socket.emit("audio_start", audioStart(["agent_mic"]));
        await waitMs(30);
        // Send the sentinel pattern inside the PCM payload. The handler
        // must process it in memory and not surface the bytes anywhere.
        socket.emit("audio_chunk", chunkMeta("agent_mic", 1, 80), SENTINEL_BYTES);
        await waitMs(30);
        socket.emit("audio_end", { type: "audio_end" });
        await waitMs(120);

        const rows = await readTranscripts(ack.callId);
        for (const r of rows) {
            assert.ok(!r.text.includes(SENTINEL_ASCII), "sentinel ASCII in transcripts.text");
            assert.ok(!/DEADBEEF/i.test(r.text), "sentinel hex in transcripts.text");
        }
        const usage = await readUsageRows(ack.callId);
        for (const u of usage) {
            const meta = JSON.stringify(u.metadata);
            assert.ok(!meta.includes(SENTINEL_ASCII), "sentinel ASCII in usage.metadata");
            assert.ok(!/DEADBEEF/i.test(meta), "sentinel hex in usage.metadata");
        }
    } finally {
        socket.disconnect();
        const captured = stopConsoleCapture();
        const joined = captured.join("\n");
        assert.ok(!joined.includes(SENTINEL_ASCII), "sentinel ASCII in console output");
        assert.ok(!/DEADBEEF/i.test(joined), "sentinel hex in console output");
    }
});

// --------------------------------------------------------------------- //
// 15. audio_end with no prior audio_start -> silent no-op (no DB writes)
// --------------------------------------------------------------------- //
test("audio_end without audio_start -> no-op, no DB writes", async () => {
    const socket = await connected();
    try {
        const ack = await startCall(socket);
        socket.emit("audio_end", { type: "audio_end" });
        await waitMs(60);
        const rows = await readTranscripts(ack.callId);
        assert.equal(rows.length, 0);
        const usage = await readUsageRows(ack.callId);
        assert.equal(usage.length, 0);
    } finally { socket.disconnect(); }
});

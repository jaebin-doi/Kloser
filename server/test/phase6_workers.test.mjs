/* Phase 6 Step 1 — worker + queue integration tests.
 *
 * Plan: docs/plan/phase-6/PHASE_6_STEP_1_PLAN.md §7,
 *       docs/plan/phase-6/PHASE_6_STEP_1_IMPLEMENTATION_PLAN.md §3.
 *
 * Covers:
 *   - endCall best-effort enqueue (success + Redis-down tolerance)
 *   - callSummary Worker happy path + manual-summary guard
 *   - heartbeat sweep cutoff / cross-org / idempotency
 *   - WS text_chunk → suggestion persistence (id-bearing event)
 *   - KLOSER_DEMO_REPLAY=0 disables fixture replay
 *
 * Test data uses the `phase6test-` prefix everywhere so cleanup is
 * deterministic. Seed users / customers / orgs are never touched.
 *
 * Redis: requires the dev `kloser-dev-postgres-1` companion Redis on
 * localhost:6379 (ops/docker-compose.yml). The queue tests obliterate
 * their queues in `before` / `after` so prior runs don't leak.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import "dotenv/config";
import Fastify from "fastify";
import { Server as IOServer } from "socket.io";
import { io as ioClient } from "socket.io-client";
import authPlugin from "../src/plugins/auth.js";
import dbPlugin from "../src/plugins/db.js";

// Workers/queues read env at module load time for some knobs; set the
// short test values BEFORE the modules are imported below.
process.env.KLOSER_HEARTBEAT_CUTOFF_SEC = "1";
process.env.KLOSER_SUGGESTION_INTERVAL_MS = "200";
process.env.KLOSER_DEMO_REPLAY = "0"; // off for tests so fixture timers don't bleed

const { enqueueCallSummary, closeQueues, closeRedis } = await import(
    "../src/queue/index.js"
);
const { getCallSummaryQueue, CALL_SUMMARY_QUEUE } = await import(
    "../src/queue/queues.js"
);
const { createCallSummaryWorker, makeCallSummaryProcessor } = await import(
    "../src/workers/callSummary.worker.js"
);
const { registerCallsNamespace } = await import("../src/ws/calls.js");
const callsService = await import("../src/services/calls.js");
const callHeartbeatService = await import("../src/services/callHeartbeat.js");

const ORG_ACME = "11111111-1111-1111-1111-111111111111";
const ORG_BETA = "22222222-2222-2222-2222-222222222222";
const USER_ACME_ADMIN     = "aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa";
const MEMBERSHIP_ACME_ADMIN = "cccccccc-0001-0001-0001-cccccccccccc";
const FAKE_SID = "11111111-2222-3333-4444-555555555555";

const PREFIX = "phase6test-";

let app;
let io;
let port;

before(async () => {
    // Single Fastify hosts both the DB pool we drive from worker tests
    // and the socket.io HTTP listener for the WS tests. Two instances
    // would each register dbPlugin and try to .end() the same shared
    // pool — pg throws on the second close.
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    await app.register(dbPlugin);
    await app.listen({ host: "127.0.0.1", port: 0 });
    io = new IOServer(app.server);
    registerCallsNamespace(io, app);
    port = app.server.address().port;

    // Fresh queue state — drop anything that survived a prior interrupted run.
    try {
        await getCallSummaryQueue().obliterate({ force: true });
    } catch (_err) { /* queue may not exist; ignore */ }
});

after(async () => {
    // Sweep phase6test rows from both orgs (RLS-scoped via withOrgContext).
    for (const orgId of [ORG_ACME, ORG_BETA]) {
        try {
            await app.withOrgContext(orgId, async (client) => {
                await client.query(
                    `DELETE FROM call_suggestions
                       WHERE title LIKE $1
                          OR call_id IN (SELECT id FROM calls WHERE notes LIKE $1 OR title LIKE $1)`,
                    [`${PREFIX}%`],
                );
                await client.query(
                    `DELETE FROM call_action_items
                       WHERE call_id IN (SELECT id FROM calls WHERE notes LIKE $1 OR title LIKE $1)`,
                    [`${PREFIX}%`],
                );
                await client.query(
                    `DELETE FROM call_checklist_items
                       WHERE call_id IN (SELECT id FROM calls WHERE notes LIKE $1 OR title LIKE $1)`,
                    [`${PREFIX}%`],
                );
                await client.query(
                    `DELETE FROM transcripts
                       WHERE text LIKE $1
                          OR call_id IN (SELECT id FROM calls WHERE notes LIKE $1 OR title LIKE $1)`,
                    [`${PREFIX}%`],
                );
                await client.query(
                    `DELETE FROM calls WHERE notes LIKE $1 OR title LIKE $1`,
                    [`${PREFIX}%`],
                );
            });
        } catch (_err) { /* ignore */ }
    }

    try { await getCallSummaryQueue().obliterate({ force: true }); } catch (_e) {}
    try { await closeQueues(); } catch (_e) {}
    try { await closeRedis(); } catch (_e) {}
    if (io) io.close();
    if (app) await app.close();
});

// ─────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────

async function insertCallRaw(orgId, fields = {}) {
    return app.withOrgContext(orgId, async (client) => {
        const r = await client.query(
            `INSERT INTO calls (
                org_id, customer_id, agent_user_id, direction, status,
                title, started_at, last_seen_at, summary, summary_source
             ) VALUES ($1,$2,$3,$4,COALESCE($5,'in_progress'),$6,$7,$8,$9,$10)
             RETURNING *`,
            [
                orgId,
                fields.customer_id ?? null,
                fields.agent_user_id ?? null,
                fields.direction ?? "inbound",
                fields.status ?? null,
                fields.title ?? `${PREFIX}default`,
                fields.started_at ?? new Date(),
                fields.last_seen_at ?? null,
                fields.summary ?? null,
                fields.summary_source ?? null,
            ],
        );
        return r.rows[0];
    });
}

async function readCall(orgId, callId) {
    return app.withOrgContext(orgId, async (client) => {
        const r = await client.query(`SELECT * FROM calls WHERE id = $1`, [callId]);
        return r.rows[0] ?? null;
    });
}

async function insertTranscript(orgId, callId, speaker, text) {
    return app.withOrgContext(orgId, async (client) => {
        const r = await client.query(
            `INSERT INTO transcripts (call_id, org_id, seq, speaker, text)
             VALUES ($1,$2,(SELECT COALESCE(MAX(seq)+1,0) FROM transcripts WHERE call_id=$1),$3,$4)
             RETURNING id`,
            [callId, orgId, speaker, text],
        );
        return r.rows[0].id;
    });
}

// =============================================================
//                  endCall enqueue best-effort
// =============================================================

test("endCall enqueues a call-summary job with { orgId, callId }", async () => {
    const queue = getCallSummaryQueue();
    await queue.drain(true);
    const call = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}enqueue-happy`,
        agent_user_id: USER_ACME_ADMIN,
    });
    try {
        const ended = await callsService.endCall(app, ORG_ACME, call.id);
        assert.ok(ended);
        assert.equal(ended.status, "ended");

        // Confirm job sits on the queue with the canonical jobId.
        const jobId = `call-summary:${ORG_ACME}:${call.id}`;
        const job = await queue.getJob(jobId);
        assert.ok(job, `job ${jobId} should be present`);
        assert.deepEqual(job.data, { orgId: ORG_ACME, callId: call.id });
    } finally {
        await queue.remove(`call-summary:${ORG_ACME}:${call.id}`).catch(() => {});
    }
});

test("endCall succeeds even if enqueueCallSummary throws", async () => {
    // Force enqueue to fail by closing the queue temporarily; that
    // causes the producer to throw. endCall must still return the row.
    const queue = getCallSummaryQueue();
    const call = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}enqueue-fail`,
        agent_user_id: USER_ACME_ADMIN,
    });
    const origAdd = queue.add.bind(queue);
    queue.add = async () => { throw new Error("simulated redis down"); };
    try {
        const ended = await callsService.endCall(app, ORG_ACME, call.id);
        assert.ok(ended);
        assert.equal(ended.status, "ended");
    } finally {
        queue.add = origAdd;
    }
});

// =============================================================
//                  callSummary worker happy path
// =============================================================

test("callSummary worker fills summary fields from mock LLM transcript", async () => {
    const call = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}worker-happy`,
        agent_user_id: USER_ACME_ADMIN,
    });
    // Seed transcript so the mock LLM has something to summarize.
    await insertTranscript(ORG_ACME, call.id, "agent",
        `${PREFIX}transcript 고객사 CRM 연동을 위한 시연 일정을 잡고 싶습니다.`);

    // Drive the processor directly (no live Redis worker loop). This
    // matches the production behaviour 1:1 — Worker is just a thin
    // wrapper that calls the same processor function on each job.
    const processor = makeCallSummaryProcessor(app);
    const result = await processor({ data: { orgId: ORG_ACME, callId: call.id } });
    assert.ok(result);
    assert.notEqual(result.skipped, true);

    const updated = await readCall(ORG_ACME, call.id);
    assert.equal(updated.summary_source, "ai");
    assert.ok(updated.summary && updated.summary.length > 0);
    assert.ok(updated.summary_generated_at instanceof Date);
});

test("callSummary worker is a no-op when summary_source='manual'", async () => {
    const call = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}worker-manual-guard`,
        agent_user_id: USER_ACME_ADMIN,
        summary: `${PREFIX}user wrote this`,
        summary_source: "manual",
    });
    await insertTranscript(ORG_ACME, call.id, "agent",
        `${PREFIX}transcript should not overwrite manual`);

    const processor = makeCallSummaryProcessor(app);
    const result = await processor({ data: { orgId: ORG_ACME, callId: call.id } });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "manual_summary_locked");

    const updated = await readCall(ORG_ACME, call.id);
    assert.equal(updated.summary_source, "manual");
    assert.equal(updated.summary, `${PREFIX}user wrote this`);
});

test("callSummary worker no-op when call vanished", async () => {
    const processor = makeCallSummaryProcessor(app);
    const result = await processor({
        data: { orgId: ORG_ACME, callId: randomUUID() },
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "call_not_found");
});

// =============================================================
//                  heartbeat sweep cutoff + cross-org
// =============================================================

test("heartbeat sweep marks stale calls dropped + leaves fresh ones alone", async () => {
    const past = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes ago
    const fresh = new Date(); // now

    const stale = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}sweep-stale`,
        agent_user_id: USER_ACME_ADMIN,
        last_seen_at: past,
    });
    const live = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}sweep-live`,
        agent_user_id: USER_ACME_ADMIN,
        last_seen_at: fresh,
    });

    const cutoff = new Date(Date.now() - 60 * 1000); // 60s ago
    const n = await callHeartbeatService.markTimedOutCallsDropped(
        app, ORG_ACME, cutoff,
    );
    assert.ok(n >= 1, `expected at least one dropped, got ${n}`);

    const staleAfter = await readCall(ORG_ACME, stale.id);
    const liveAfter = await readCall(ORG_ACME, live.id);
    assert.equal(staleAfter.status, "dropped");
    assert.equal(staleAfter.dropped_reason, "server_timeout");
    assert.equal(liveAfter.status, "in_progress");
});

test("heartbeat sweep does not cross orgs", async () => {
    const past = new Date(Date.now() - 5 * 60 * 1000);
    const acmeCall = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}sweep-acme-cross`,
        agent_user_id: USER_ACME_ADMIN,
        last_seen_at: past,
    });
    const betaCall = await insertCallRaw(ORG_BETA, {
        title: `${PREFIX}sweep-beta-cross`,
        last_seen_at: past,
    });

    const cutoff = new Date(Date.now() - 60 * 1000);
    await callHeartbeatService.markTimedOutCallsDropped(app, ORG_ACME, cutoff);

    const acmeAfter = await readCall(ORG_ACME, acmeCall.id);
    const betaAfter = await readCall(ORG_BETA, betaCall.id);
    assert.equal(acmeAfter.status, "dropped");
    assert.equal(betaAfter.status, "in_progress",
        "Beta call must remain in_progress when only Acme is swept");
});

test("heartbeat sweep is idempotent (second run = 0 updates)", async () => {
    const past = new Date(Date.now() - 5 * 60 * 1000);
    await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}sweep-idem`,
        agent_user_id: USER_ACME_ADMIN,
        last_seen_at: past,
    });
    const cutoff = new Date(Date.now() - 60 * 1000);
    const first = await callHeartbeatService.markTimedOutCallsDropped(app, ORG_ACME, cutoff);
    const second = await callHeartbeatService.markTimedOutCallsDropped(app, ORG_ACME, cutoff);
    assert.ok(first >= 1);
    assert.equal(second, 0);
});

// =============================================================
//                  WS suggestion persistence
// =============================================================

function validJwtPayload() {
    return {
        sub: USER_ACME_ADMIN,
        orgId: ORG_ACME,
        membershipId: MEMBERSHIP_ACME_ADMIN,
        role: "admin",
        sid: FAKE_SID,
    };
}

function wsClient() {
    const token = app.jwt.sign(validJwtPayload());
    const socket = ioClient(`http://127.0.0.1:${port}/calls`, {
        transports: ["websocket"],
        reconnection: false,
        timeout: 3000,
        auth: { token },
    });
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("connect timeout")), 3000);
        socket.once("connect", () => { clearTimeout(t); resolve(socket); });
        socket.once("connect_error", (err) => { clearTimeout(t); reject(err); });
    });
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

function nextEvent(socket, name, filter, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${name} timeout`)), timeoutMs);
        const handler = (ev) => {
            if (!filter || filter(ev)) {
                clearTimeout(t);
                socket.off(name, handler);
                resolve(ev);
            }
        };
        socket.on(name, handler);
    });
}

test("text_chunk timer fires → call_suggestions row persisted + WS event has id", async () => {
    const socket = await wsClient();
    let callId;
    try {
        const start = await emitWithAck(socket, "start_call", { customerId: null });
        callId = start.callId;
        assert.ok(callId);
        // Tag the call so cleanup catches it.
        await app.withOrgContext(ORG_ACME, async (client) => {
            await client.query(`UPDATE calls SET title = $1 WHERE id = $2`,
                [`${PREFIX}ws-suggestion`, callId]);
        });

        // 1st text_chunk arms the 200ms timer.
        socket.emit("text_chunk", {
            seq: 1,
            text: "고객사 CRM 연동을 위한 시연 일정을 잡고 싶습니다.",
            clientSentAt: Date.now(),
        });

        const sug = await nextEvent(socket, "suggestion",
            (ev) => Array.isArray(ev?.suggestions) && ev.suggestions[0]?.id);
        assert.ok(sug.suggestions.length >= 1);
        for (const s of sug.suggestions) {
            assert.ok(typeof s.id === "string");
            assert.equal(s.group_seq, 0);
        }

        // Confirm DB has the row.
        const rows = await app.withOrgContext(ORG_ACME, async (client) => {
            const r = await client.query(
                `SELECT id, group_seq, title FROM call_suggestions WHERE call_id = $1`,
                [callId],
            );
            return r.rows;
        });
        assert.ok(rows.length >= 1);
        assert.equal(rows[0].group_seq, 0);
    } finally {
        socket.disconnect();
    }
});

test("KLOSER_DEMO_REPLAY=0 — no fixture replay events fire", async () => {
    const socket = await wsClient();
    try {
        const start = await emitWithAck(socket, "start_call", { customerId: null });
        // Tag for cleanup.
        await app.withOrgContext(ORG_ACME, async (client) => {
            await client.query(`UPDATE calls SET title = $1 WHERE id = $2`,
                [`${PREFIX}ws-demo-off`, start.callId]);
        });

        // Wait 800ms and confirm no transcript events arrived (the demo
        // fixture would normally emit several within the first second).
        let transcriptCount = 0;
        socket.on("transcript", () => { transcriptCount += 1; });
        await new Promise((r) => setTimeout(r, 800));
        assert.equal(transcriptCount, 0,
            `demo replay should be off; got ${transcriptCount} transcript events`);
    } finally {
        socket.disconnect();
    }
});

// =============================================================
//                  Worker close cleanup
// =============================================================

test("call summary worker can be created and closed cleanly", async () => {
    const w = createCallSummaryWorker(app);
    assert.equal(w.name, CALL_SUMMARY_QUEUE);
    await w.close();
});

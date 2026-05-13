/* Phase 6 Step 2 — llmUsage service tests.
 *
 * Plan: docs/plan/phase-6/PHASE_6_STEP_2_PLAN.md §6, §8.3.
 *
 * `services/llmUsage.recordProviderUsage` wraps the append-only
 * `llm_usage_log` repository with two guarantees the wiring commit
 * will rely on:
 *
 *   1. INSERTs run inside `withOrgContext` so RLS sees the correct
 *      `app.org_id` and the row lands in the actor's org.
 *   2. Logging failure must NOT throw out of the service — the user
 *      already paid for the LLM tokens; if logging blows up we record
 *      a warning and return null so the worker / WS / route can keep
 *      handing the value back to the user.
 *
 * Cleanup pattern: rows tag themselves through
 * `metadata.test_tag = 'phase6test-llmusage-...'`; the after hook uses
 * the admin migration URL to delete by prefix (the table has no
 * DELETE policy for the app role).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import pg from "pg";
import dbPlugin from "../src/plugins/db.js";
import * as llmUsageService from "../src/services/llmUsage.js";
import * as llmUsageRepo from "../src/repositories/llmUsage.js";

const ORG_ACME = "11111111-1111-1111-1111-111111111111";
const ORG_BETA = "22222222-2222-2222-2222-222222222222";
const USER_ACME_ADMIN = "aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa";

const PREFIX = `phase6test-llmusage-${process.pid}-${Date.now()}-`;
const TEST_TAG = `${PREFIX}svc`;

let app;

async function withAdminClient(fn) {
    const url = process.env.MIGRATE_DATABASE_URL;
    if (!url) {
        throw new Error(
            "MIGRATE_DATABASE_URL is required for llm_usage_log service test cleanup",
        );
    }
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
        return await fn(client);
    } finally {
        await client.end();
    }
}

before(async () => {
    app = Fastify({ logger: false });
    await app.register(dbPlugin);
});

after(async () => {
    await withAdminClient(async (client) => {
        await client.query(
            `DELETE FROM llm_usage_log WHERE metadata->>'test_tag' LIKE $1`,
            [`${PREFIX}%`],
        );
        await client.query(
            `DELETE FROM calls WHERE title LIKE $1`,
            [`${PREFIX}%`],
        );
    });
    await app.close();
});

function makeUsage(overrides = {}) {
    return {
        provider: "mock",
        operation: "call_summary",
        model: "mock-llm-summary-v1",
        status: "succeeded",
        tokensIn: 12,
        tokensOut: 34,
        latencyMs: 5,
        costUsdMicros: 0,
        metadata: { test_tag: TEST_TAG },
        ...overrides,
    };
}

async function insertCall(orgId, agentUserId, suffix) {
    return app.withOrgContext(orgId, async (client) => {
        const r = await client.query(
            `INSERT INTO calls (
                org_id, agent_user_id, direction, status,
                title, started_at
             ) VALUES ($1, $2, 'inbound', 'in_progress', $3, now())
             RETURNING id, org_id`,
            [orgId, agentUserId, `${PREFIX}${suffix}`],
        );
        return r.rows[0];
    });
}

// =============================================================
//                       happy paths
// =============================================================

test("recordProviderUsage inserts a row under the caller's org", async () => {
    const inserted = await llmUsageService.recordProviderUsage(
        app,
        ORG_ACME,
        null,
        makeUsage(),
    );
    assert.ok(inserted, "service must return the inserted row on success");
    assert.equal(inserted.org_id, ORG_ACME);
    assert.equal(inserted.provider, "mock");
    assert.equal(inserted.operation, "call_summary");
    assert.equal(inserted.status, "succeeded");
    assert.equal(inserted.tokens_in, 12);
    assert.equal(inserted.tokens_out, 34);
    assert.equal(inserted.latency_ms, 5);
    // pg returns bigint as a string by default; the repository row
    // type intentionally widens to `number | null` for ergonomics but
    // the runtime value is a string for non-null bigints.
    assert.equal(String(inserted.cost_usd_micros), "0");
    assert.equal(inserted.call_id, null);
    assert.deepEqual(inserted.metadata, { test_tag: TEST_TAG });
});

test("recordProviderUsage links a usage row to a same-org call", async () => {
    const call = await insertCall(ORG_ACME, USER_ACME_ADMIN, "linked-call");

    const inserted = await llmUsageService.recordProviderUsage(
        app,
        ORG_ACME,
        call.id,
        makeUsage({ operation: "call_suggestion", tokensOut: 99 }),
    );
    assert.ok(inserted);
    assert.equal(inserted.call_id, call.id);
    assert.equal(inserted.operation, "call_suggestion");
    assert.equal(inserted.tokens_out, 99);

    const listed = await app.withOrgContext(ORG_ACME, (client) =>
        llmUsageRepo.listForCallInCurrentOrg(client, call.id),
    );
    assert.ok(listed.some((r) => r.id === inserted.id));
});

test("recordProviderUsage merges service metadata onto the usage envelope", async () => {
    const inserted = await llmUsageService.recordProviderUsage(
        app,
        ORG_ACME,
        null,
        makeUsage({ metadata: { test_tag: TEST_TAG, source: "adapter" } }),
        { metadata: { worker: "callSummary", attempt: 1 } },
    );
    assert.ok(inserted);
    assert.equal(inserted.metadata.test_tag, TEST_TAG);
    assert.equal(inserted.metadata.source, "adapter");
    assert.equal(inserted.metadata.worker, "callSummary");
    assert.equal(inserted.metadata.attempt, 1);
});

test("recordProviderUsage accepts null tokens/latency/cost (real STT path)", async () => {
    const inserted = await llmUsageService.recordProviderUsage(
        app,
        ORG_ACME,
        null,
        makeUsage({
            operation: "stt_transcribe",
            model: "mock-stt-v1",
            tokensIn: null,
            tokensOut: null,
            latencyMs: null,
            costUsdMicros: null,
        }),
    );
    assert.ok(inserted);
    assert.equal(inserted.tokens_in, null);
    assert.equal(inserted.tokens_out, null);
    assert.equal(inserted.latency_ms, null);
    assert.equal(inserted.cost_usd_micros, null);
});

test("recordProviderUsage scopes inserts to the actor's org (Beta can't read Acme row)", async () => {
    const inserted = await llmUsageService.recordProviderUsage(
        app,
        ORG_ACME,
        null,
        makeUsage({ metadata: { test_tag: TEST_TAG, leg: "scope" } }),
    );
    assert.ok(inserted);

    const fromBeta = await app.withOrgContext(ORG_BETA, (client) =>
        llmUsageRepo.listForCurrentOrgByTestTagPrefix(client, PREFIX),
    );
    assert.equal(
        fromBeta.find((r) => r.id === inserted.id),
        undefined,
        "Beta context must not read Acme service-recorded usage rows",
    );
});

// =============================================================
//                       failure isolation
// =============================================================

test("recordProviderUsage returns null when withOrgContext throws (logging failure does not propagate)", async () => {
    // Build a fake Fastify-shaped object whose `withOrgContext` always
    // throws. The real `app.log.warn` is replaced with a spy so we can
    // confirm the warning was emitted but the promise still resolves.
    const warns = [];
    const fakeApp = {
        log: {
            warn: (...args) => warns.push(args),
        },
        async withOrgContext() {
            throw new Error("simulated DB outage");
        },
    };

    const result = await llmUsageService.recordProviderUsage(
        fakeApp,
        ORG_ACME,
        null,
        makeUsage(),
    );
    assert.equal(result, null, "service must swallow logging failures");
    assert.equal(warns.length, 1, "exactly one warn line should be emitted");
});

test("recordProviderUsage returns null when the INSERT itself throws (e.g. invalid enum)", async () => {
    // Bypass migration constraints by trying to insert an unsupported
    // status. The CHECK constraint trips inside the transaction, the
    // service catches it, logs a warn, and returns null instead of
    // bubbling the error up to the worker.
    const result = await llmUsageService.recordProviderUsage(
        app,
        ORG_ACME,
        null,
        makeUsage({ status: "not-a-real-status" }),
    );
    assert.equal(result, null);
});

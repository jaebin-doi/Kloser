/* Phase 7 Step 1 — email delivery worker processor tests.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_1_PLAN.md §5.4.
 *
 * Coverage:
 *   - no-op when config is null (EMAIL_PROVIDER!=resend).
 *   - happy path: lease → decrypt → adapter.send → markDelivered + scrub.
 *     Verifies the adapter received the rendered text with raw token
 *     restored from sensitive_payload, and that scrub cleared the three
 *     ciphertext columns.
 *   - retryable failure → status='failed', attempt_count incremented,
 *     next_attempt_at in the future (exponential backoff).
 *   - max attempts reached → dead-letter + scrub.
 *   - permanent 4xx → dead-letter + scrub regardless of attempt count.
 *   - decrypt failure (tampered ciphertext) → dead-letter + scrub, no
 *     adapter call.
 *   - SKIP LOCKED concurrency: two concurrent ticks on a single pending
 *     row → exactly one adapter call.
 *   - error message hygiene: adapter messages persisted into
 *     error_message do not echo RESEND_API_KEY / raw token / raw URL.
 *
 * Org strategy: all tests use ORG_BETA (clean of pending rows at suite
 * start). Each test begins with a Beta pending/sending purge so the
 * lease scan picks deterministically.
 *
 * Run: cd server && npm test
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import dbPlugin from "../src/plugins/db.js";
import * as emailOutbox from "../src/repositories/emailOutbox.js";
import {
    EmailEncryptionConfigError,
    encryptEmailSensitivePayload,
} from "../src/services/emailSensitivePayload.js";
import {
    FakeEmailDeliveryAdapter,
    PermanentEmailDeliveryError,
    ResendEmailDeliveryAdapter,
    RetryableEmailDeliveryError,
} from "../src/adapters/email/index.js";
import {
    makeEmailDeliveryProcessor,
    computeBackoffMs,
    EmailDeliveryConfigError,
    loadEmailDeliveryConfigFromEnv,
} from "../src/workers/emailDelivery.worker.js";
const ORG_BETA = "22222222-2222-2222-2222-222222222222";
const PREFIX = `phase7worker-${process.pid}-${Date.now()}-`;
const TEST_KEY = Buffer.alloc(32, 9);
const TEST_KEY_B64 = TEST_KEY.toString("base64");
const RESEND_API_KEY = "re_FAKE_KEY_MUST_NOT_LEAK";

const RAW_TOKEN = "raw-token-worker-marker-9876543210";
const RAW_URL = `http://localhost:8765/platform/verify.html?token=${encodeURIComponent(RAW_TOKEN)}`;
const REDACTED_URL = `http://localhost:8765/platform/verify.html?token=[redacted]`;

let app;

before(async () => {
    app = Fastify({ logger: false });
    await app.register(dbPlugin);
});

after(async () => {
    await app.withOrgContext(ORG_BETA, async (client) => {
        await client.query(
            `DELETE FROM email_outbox WHERE metadata->>'test_tag' LIKE $1`,
            [`${PREFIX}%`],
        );
    });
    await app.close();
});

async function purgeBetaActive() {
    await app.withOrgContext(ORG_BETA, async (client) => {
        await client.query(
            `DELETE FROM email_outbox
              WHERE org_id = $1
                AND status IN ('pending','failed','sending')`,
            [ORG_BETA],
        );
    });
}

function buildPendingInput(tag, overrides = {}) {
    const sensitive = encryptEmailSensitivePayload(RAW_URL, TEST_KEY);
    return {
        orgId: ORG_BETA,
        toEmail: `worker-${randomUUID()}@example.test`,
        subject: "[Kloser test] verify your email",
        bodyText: `verify: ${REDACTED_URL}`,
        template: "email_verification",
        metadata: { test_tag: tag, verifyUrl: REDACTED_URL },
        provider: "resend",
        sensitivePayload: { ...sensitive, keyVersion: 1 },
        ...overrides,
    };
}

async function insertPendingBeta(tag, overrides) {
    return app.withOrgContext(ORG_BETA, (client) =>
        emailOutbox.insertPendingEmail(client, buildPendingInput(tag, overrides)),
    );
}

async function readRow(id) {
    return app.withOrgContext(ORG_BETA, async (client) => {
        const r = await client.query(
            `SELECT id, status, attempt_count, next_attempt_at, delivered_at,
                    dead_lettered_at, error_message, provider_message_id,
                    sensitive_payload_ciphertext, sensitive_payload_iv,
                    sensitive_payload_tag, locked_at, lock_token
               FROM email_outbox WHERE id = $1`,
            [id],
        );
        return r.rows[0];
    });
}

function baseConfig(adapter, overrides = {}) {
    return {
        adapter,
        from: "Kloser <no-reply@example.test>",
        apiKey: RESEND_API_KEY,
        encryptionKey: TEST_KEY,
        maxAttempts: 3,
        baseBackoffMs: 60_000,
        ...overrides,
    };
}

async function withMockFetch(handler, fn) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = handler;
    try {
        return await fn();
    } finally {
        globalThis.fetch = originalFetch;
    }
}

function jsonResponse(status, body) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

const ADAPTER_INPUT = {
    toEmail: "recipient@example.test",
    subject: "Subject",
    text: `body ${RAW_URL}`,
    html: null,
    from: "Kloser <no-reply@example.test>",
    apiKey: RESEND_API_KEY,
};

// =============================================================
//                       RESEND ADAPTER
// =============================================================

test("Resend adapter posts email payload and returns provider message id", async () => {
    let seenUrl;
    let seenInit;
    await withMockFetch(async (url, init) => {
        seenUrl = url;
        seenInit = init;
        return jsonResponse(200, { id: "resend-id-1" });
    }, async () => {
        const adapter = new ResendEmailDeliveryAdapter("https://resend.test/emails");
        const result = await adapter.send(ADAPTER_INPUT);
        assert.equal(result.providerMessageId, "resend-id-1");
    });

    assert.equal(seenUrl, "https://resend.test/emails");
    assert.equal(seenInit.method, "POST");
    assert.equal(seenInit.redirect, "manual");
    assert.equal(seenInit.headers.Authorization, `Bearer ${RESEND_API_KEY}`);
    const body = JSON.parse(seenInit.body);
    assert.equal(body.from, ADAPTER_INPUT.from);
    assert.equal(body.to, ADAPTER_INPUT.toEmail);
    assert.equal(body.subject, ADAPTER_INPUT.subject);
    assert.equal(body.text, ADAPTER_INPUT.text);
});

test("Resend adapter classifies 4xx/3xx as permanent without echoing provider message", async () => {
    const adapter = new ResendEmailDeliveryAdapter("https://resend.test/emails");
    const secretMessage = `${RAW_URL} ${RESEND_API_KEY}`;

    await withMockFetch(async () => jsonResponse(422, {
        name: "validation_error",
        message: secretMessage,
    }), async () => {
        await assert.rejects(
            () => adapter.send(ADAPTER_INPUT),
            (err) => {
                assert.ok(err instanceof PermanentEmailDeliveryError);
                assert.equal(err.message, "resend 422 validation_error");
                assert.ok(!err.message.includes(RAW_TOKEN));
                assert.ok(!err.message.includes(RESEND_API_KEY));
                return true;
            },
        );
    });

    await withMockFetch(async () => jsonResponse(302, { name: "redirect" }), async () => {
        await assert.rejects(
            () => adapter.send(ADAPTER_INPUT),
            (err) => {
                assert.ok(err instanceof PermanentEmailDeliveryError);
                assert.equal(err.message, "resend 302 redirect");
                return true;
            },
        );
    });
});

test("Resend adapter classifies 5xx/network/missing id as retryable", async () => {
    const adapter = new ResendEmailDeliveryAdapter("https://resend.test/emails");

    await withMockFetch(async () => jsonResponse(503, { name: "internal_error" }), async () => {
        await assert.rejects(
            () => adapter.send(ADAPTER_INPUT),
            (err) => {
                assert.ok(err instanceof RetryableEmailDeliveryError);
                assert.equal(err.message, "resend 503 internal_error");
                return true;
            },
        );
    });

    await withMockFetch(async () => jsonResponse(200, {}), async () => {
        await assert.rejects(
            () => adapter.send(ADAPTER_INPUT),
            (err) => {
                assert.ok(err instanceof RetryableEmailDeliveryError);
                assert.equal(err.message, "resend 200 missing message id");
                return true;
            },
        );
    });

    await withMockFetch(async () => {
        throw new Error(`${RAW_URL} ${RESEND_API_KEY}`);
    }, async () => {
        await assert.rejects(
            () => adapter.send(ADAPTER_INPUT),
            (err) => {
                assert.ok(err instanceof RetryableEmailDeliveryError);
                assert.equal(err.message, "resend network failure (Error)");
                assert.ok(!err.message.includes(RAW_TOKEN));
                assert.ok(!err.message.includes(RESEND_API_KEY));
                return true;
            },
        );
    });
});

// =============================================================
//                       NO-OP / CONFIG NULL
// =============================================================

test("processor is a no-op when config is null", async () => {
    const processor = makeEmailDeliveryProcessor(app, { config: null });
    const r = await processor();
    assert.equal(r.skipped, true);
    assert.equal(r.reason, "no_adapter");
    assert.equal(r.leased, 0);
});

test("env loader returns null for dev provider modes", () => {
    assert.equal(loadEmailDeliveryConfigFromEnv({ EMAIL_PROVIDER: "dev_outbox" }), null);
    assert.equal(loadEmailDeliveryConfigFromEnv({ EMAIL_PROVIDER: "" }), null);
    assert.equal(loadEmailDeliveryConfigFromEnv({}), null);
});

test("env loader fail-fasts on unknown EMAIL_PROVIDER without echoing the value", () => {
    assert.throws(
        () => loadEmailDeliveryConfigFromEnv({ EMAIL_PROVIDER: "resnd-secret-token" }),
        (err) => {
            assert.ok(err instanceof EmailDeliveryConfigError);
            assert.match(err.message, /Unknown EMAIL_PROVIDER/);
            assert.ok(!err.message.includes("resnd-secret-token"));
            return true;
        },
    );
});

test("env loader fail-fasts when EMAIL_PROVIDER=resend is missing required env", () => {
    assert.throws(
        () => loadEmailDeliveryConfigFromEnv({ EMAIL_PROVIDER: "resend" }),
        (err) => {
            assert.ok(err instanceof EmailDeliveryConfigError);
            assert.match(err.message, /EMAIL_FROM/);
            return true;
        },
    );

    assert.throws(
        () => loadEmailDeliveryConfigFromEnv({
            EMAIL_PROVIDER: "resend",
            EMAIL_FROM: "Kloser <no-reply@example.test>",
            RESEND_API_KEY: "",
        }),
        (err) => {
            assert.ok(err instanceof EmailDeliveryConfigError);
            assert.match(err.message, /RESEND_API_KEY/);
            assert.ok(!err.message.includes(RESEND_API_KEY));
            return true;
        },
    );
});

test("env loader fail-fasts on malformed encryption key in resend mode", () => {
    assert.throws(
        () => loadEmailDeliveryConfigFromEnv({
            EMAIL_PROVIDER: "resend",
            EMAIL_FROM: "Kloser <no-reply@example.test>",
            RESEND_API_KEY,
            EMAIL_OUTBOX_ENCRYPTION_KEY: "not-base64!",
        }),
        (err) => {
            assert.ok(err instanceof EmailEncryptionConfigError);
            assert.ok(!err.message.includes(RESEND_API_KEY));
            return true;
        },
    );
});

test("env loader builds resend config with valid env", () => {
    const adapter = new FakeEmailDeliveryAdapter();
    const config = loadEmailDeliveryConfigFromEnv({
        EMAIL_PROVIDER: "  ReSeNd  ",
        EMAIL_FROM: "Kloser <no-reply@example.test>",
        RESEND_API_KEY,
        EMAIL_OUTBOX_ENCRYPTION_KEY: TEST_KEY_B64,
        KLOSER_EMAIL_MAX_ATTEMPTS: "5",
    }, () => adapter);

    assert.equal(config.adapter, adapter);
    assert.equal(config.from, "Kloser <no-reply@example.test>");
    assert.equal(config.apiKey, RESEND_API_KEY);
    assert.equal(config.maxAttempts, 5);
    assert.deepEqual(config.encryptionKey, TEST_KEY);
});

// =============================================================
//                       HAPPY PATH
// =============================================================

test("happy path: lease → decrypt → adapter.send → delivered + scrub", async () => {
    await purgeBetaActive();
    const inserted = await insertPendingBeta(`${PREFIX}happy`);

    const adapter = new FakeEmailDeliveryAdapter([{ kind: "deliver", providerMessageId: "fake-happy-1" }]);
    const processor = makeEmailDeliveryProcessor(app, { config: baseConfig(adapter) });
    const r = await processor();

    assert.equal(r.delivered, 1);
    assert.equal(r.leased, 1);
    assert.equal(adapter.calls.length, 1);
    // Adapter must receive the raw URL — proving sensitive_payload decrypt + body re-render.
    const sent = adapter.calls[0];
    assert.equal(sent.toEmail, inserted.to_email);
    assert.equal(sent.from, "Kloser <no-reply@example.test>");
    assert.equal(sent.apiKey, RESEND_API_KEY);
    assert.ok(sent.text.includes(RAW_URL), "rendered text must contain raw URL");
    assert.ok(!sent.text.includes("[redacted]"), "rendered text must not contain [redacted]");

    const row = await readRow(inserted.id);
    assert.equal(row.status, "delivered");
    assert.equal(row.provider_message_id, "fake-happy-1");
    assert.ok(row.delivered_at);
    assert.equal(row.sensitive_payload_ciphertext, null);
    assert.equal(row.sensitive_payload_iv, null);
    assert.equal(row.sensitive_payload_tag, null);
    assert.equal(row.locked_at, null);
    assert.equal(row.lock_token, null);
});

// =============================================================
//                       RETRYABLE FAILURE
// =============================================================

test("retryable failure: marks failed, increments attempt_count, sets future next_attempt_at", async () => {
    await purgeBetaActive();
    const inserted = await insertPendingBeta(`${PREFIX}retry-1`);

    const adapter = new FakeEmailDeliveryAdapter([{ kind: "retryable", reason: "resend 502" }]);
    const processor = makeEmailDeliveryProcessor(app, { config: baseConfig(adapter) });
    const start = Date.now();
    const r = await processor();

    assert.equal(r.retried, 1);
    assert.equal(r.delivered, 0);
    assert.equal(r.deadLettered, 0);

    const row = await readRow(inserted.id);
    assert.equal(row.status, "failed");
    assert.equal(row.attempt_count, 1);
    assert.equal(row.error_message, "resend 502");
    assert.ok(row.next_attempt_at);
    // Backoff for first failure = baseBackoffMs * 2^0 = baseBackoffMs (60s).
    const delayMs = row.next_attempt_at.getTime() - start;
    assert.ok(delayMs >= 55_000, `next_attempt_at delay too short: ${delayMs}ms`);
    assert.ok(delayMs <= 65_000, `next_attempt_at delay too long: ${delayMs}ms`);
    // Lock cleared so the next eligible tick can pick it back up.
    assert.equal(row.locked_at, null);
    assert.equal(row.lock_token, null);
    // Sensitive payload kept for the next attempt.
    assert.ok(row.sensitive_payload_ciphertext);
});

// =============================================================
//                       MAX ATTEMPTS → DEAD LETTER
// =============================================================

test("retryable failure at attempt_count==maxAttempts-1 dead-letters + scrubs", async () => {
    await purgeBetaActive();
    const inserted = await insertPendingBeta(`${PREFIX}retry-max`);
    // Pre-bump attempt_count so the next failure trips max.
    await app.withOrgContext(ORG_BETA, async (client) => {
        await client.query(
            `UPDATE email_outbox SET attempt_count = $2 WHERE id = $1`,
            [inserted.id, 2],
        );
    });

    const adapter = new FakeEmailDeliveryAdapter([{ kind: "retryable", reason: "resend 503" }]);
    const processor = makeEmailDeliveryProcessor(app, { config: baseConfig(adapter, { maxAttempts: 3 }) });
    const r = await processor();
    assert.equal(r.deadLettered, 1);
    assert.equal(r.retried, 0);

    const row = await readRow(inserted.id);
    assert.equal(row.status, "dead_lettered");
    assert.equal(row.attempt_count, 3);
    assert.equal(row.error_message, "resend 503");
    assert.ok(row.dead_lettered_at);
    // Scrub on dead-letter.
    assert.equal(row.sensitive_payload_ciphertext, null);
    assert.equal(row.sensitive_payload_iv, null);
    assert.equal(row.sensitive_payload_tag, null);
});

// =============================================================
//                       PERMANENT 4xx → DEAD LETTER
// =============================================================

test("permanent failure dead-letters immediately regardless of attempt_count", async () => {
    await purgeBetaActive();
    const inserted = await insertPendingBeta(`${PREFIX}perm`);

    const adapter = new FakeEmailDeliveryAdapter([{ kind: "permanent", reason: "resend 422 validation_error" }]);
    const processor = makeEmailDeliveryProcessor(app, { config: baseConfig(adapter) });
    const r = await processor();
    assert.equal(r.deadLettered, 1);

    const row = await readRow(inserted.id);
    assert.equal(row.status, "dead_lettered");
    assert.equal(row.attempt_count, 1);
    assert.equal(row.error_message, "resend 422 validation_error");
    assert.ok(row.dead_lettered_at);
    assert.equal(row.sensitive_payload_ciphertext, null);
});

// =============================================================
//                       DECRYPT FAILURE
// =============================================================

test("tampered sensitive payload dead-letters + scrubs without calling adapter", async () => {
    await purgeBetaActive();
    const inserted = await insertPendingBeta(`${PREFIX}decrypt-fail`);
    // Tamper the tag so AES-GCM auth fails.
    await app.withOrgContext(ORG_BETA, async (client) => {
        await client.query(
            `UPDATE email_outbox
                SET sensitive_payload_tag = $2
              WHERE id = $1`,
            [inserted.id, Buffer.alloc(16, 0).toString("base64")],
        );
    });

    const adapter = new FakeEmailDeliveryAdapter([{ kind: "deliver" }]);
    const processor = makeEmailDeliveryProcessor(app, { config: baseConfig(adapter) });
    const r = await processor();
    assert.equal(r.decryptFailed, 1);
    assert.equal(r.deadLettered, 1);
    assert.equal(adapter.calls.length, 0, "adapter must not be called when decrypt fails");

    const row = await readRow(inserted.id);
    assert.equal(row.status, "dead_lettered");
    assert.equal(row.error_message, "decrypt_failed");
    assert.equal(row.sensitive_payload_ciphertext, null);
});

// =============================================================
//                       SKIP LOCKED CONCURRENCY
// =============================================================

test("concurrent ticks lease the same row exactly once", async () => {
    await purgeBetaActive();
    const inserted = await insertPendingBeta(`${PREFIX}skip-locked`);

    // Two separate fake adapters so we can count whose send fired.
    const adapterA = new FakeEmailDeliveryAdapter([{ kind: "deliver", providerMessageId: "fake-A" }]);
    const adapterB = new FakeEmailDeliveryAdapter([{ kind: "deliver", providerMessageId: "fake-B" }]);
    const procA = makeEmailDeliveryProcessor(app, { config: baseConfig(adapterA) });
    const procB = makeEmailDeliveryProcessor(app, { config: baseConfig(adapterB) });

    const [rA, rB] = await Promise.all([procA(), procB()]);
    assert.equal(rA.delivered + rB.delivered, 1, "exactly one tick must deliver");
    assert.equal(adapterA.calls.length + adapterB.calls.length, 1,
        "exactly one adapter must be invoked");

    const row = await readRow(inserted.id);
    assert.equal(row.status, "delivered");
    // provider_message_id matches whichever adapter ran.
    assert.ok(["fake-A", "fake-B"].includes(row.provider_message_id));
});

// =============================================================
//                       ERROR HYGIENE
// =============================================================

test("persisted error_message does not echo apiKey / raw token / raw URL", async () => {
    await purgeBetaActive();
    const inserted = await insertPendingBeta(`${PREFIX}hygiene`);

    // Fake adapter that throws a Permanent error mentioning only a
    // non-sensitive label. We verify the worker stores exactly that
    // (not the raw token, raw URL, or api key).
    const adapter = new FakeEmailDeliveryAdapter([{ kind: "permanent", reason: "resend 401 unauthorized" }]);
    const processor = makeEmailDeliveryProcessor(app, { config: baseConfig(adapter) });
    await processor();

    const row = await readRow(inserted.id);
    assert.ok(!row.error_message.includes(RAW_TOKEN));
    assert.ok(!row.error_message.includes(RAW_URL));
    assert.ok(!row.error_message.includes(RESEND_API_KEY));
});

test("unexpected (non-classified) adapter throw is treated as retryable but message is sanitised", async () => {
    await purgeBetaActive();
    const inserted = await insertPendingBeta(`${PREFIX}unexpected`);

    // Adapter throws a generic Error whose message contains a fake secret-
    // looking string. Worker must record only the error name, not the
    // message — defensive against future libraries that print URLs/headers.
    const SECRET_LEAK = `${RAW_TOKEN}-and-${RESEND_API_KEY}`;
    const adapter = new FakeEmailDeliveryAdapter([{
        kind: "unexpected",
        reason: SECRET_LEAK,
    }]);
    const processor = makeEmailDeliveryProcessor(app, { config: baseConfig(adapter) });
    const r = await processor();
    assert.equal(r.retried, 1);

    const row = await readRow(inserted.id);
    assert.equal(row.status, "failed");
    assert.ok(!row.error_message.includes(RAW_TOKEN));
    assert.ok(!row.error_message.includes(RESEND_API_KEY));
    assert.match(row.error_message, /^unexpected:/);
});

// =============================================================
//                       BACKOFF UNIT
// =============================================================

test("computeBackoffMs scales exponentially and caps at 1h", () => {
    const base = 60_000;
    assert.equal(computeBackoffMs(1, base), 60_000);
    assert.equal(computeBackoffMs(2, base), 120_000);
    assert.equal(computeBackoffMs(3, base), 240_000);
    // Cap kicks in well before huge attempt counts.
    assert.equal(computeBackoffMs(20, base), 60 * 60 * 1000);
});

/* Phase 7 Step 1 — email_outbox repository + encryption helper tests.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_1_PLAN.md §4 (repository unit test
 * matrix) and §5.2 (encryption helper).
 *
 * Coverage:
 *   - encryption: round-trip, wrong key, tampered tag, plaintext never
 *     surfaces in error messages, env loader fail-fast cases.
 *   - dev INSERT path: status='delivered', provider='dev_outbox',
 *     delivered_at populated, sensitive_payload_* NULL.
 *   - pending INSERT path: status='pending', sensitive_payload_*
 *     populated, body_text redacted of raw token.
 *   - RLS: Beta cannot read or update Acme rows through bare SQL.
 *   - leaseDueEmail: picks pending row, sets sending + lock metadata,
 *     does NOT increment attempt_count, honors next_attempt_at > now,
 *     ignores 'delivered' rows, FOR UPDATE SKIP LOCKED issues one lease.
 *   - markDelivered: sets delivered_at + provider_message_id, clears lock;
 *     composes cleanly with scrubSensitivePayload.
 *   - markRetryableFailure: increments attempt_count, sets failed_at /
 *     error_message / next_attempt_at, clears lock.
 *   - markDeadLetter: sets status / dead_lettered_at / error_message,
 *     increments attempt_count.
 *   - scrubSensitivePayload: clears the three ciphertext columns.
 *
 * Org strategy:
 *   - Acme rows: used for dev INSERT + RLS isolation tests. We add rows
 *     tagged with the per-process PREFIX and clean them up in `after`.
 *   - Beta rows: dedicated to lease + transition tests. Beta starts the
 *     suite with zero pending rows (only the dev provider has ever written
 *     to it, and only as 'delivered'). Each lease test begins by deleting
 *     ALL pending/failed Beta rows so the lease pick is deterministic.
 *     Other test files don't write pending rows to Beta, so this purge is
 *     contained.
 *
 * Cleanup:
 *   - PREFIX-tagged rows removed in `after` from both orgs.
 *
 * Run: cd server && npm test
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import dbPlugin from "../src/plugins/db.js";
import * as outboxRepo from "../src/repositories/emailOutbox.js";
import {
    EmailEncryptionConfigError,
    EmailEncryptionFailureError,
    encryptEmailSensitivePayload,
    decryptEmailSensitivePayload,
    loadEmailOutboxEncryptionKey,
} from "../src/services/emailSensitivePayload.js";

const ORG_ACME = "11111111-1111-1111-1111-111111111111";
const ORG_BETA = "22222222-2222-2222-2222-222222222222";

const PREFIX = `phase7test-${process.pid}-${Date.now()}-`;

// Two distinct 32-byte keys for negative-path tests.
const TEST_KEY  = Buffer.alloc(32, 1);
const WRONG_KEY = Buffer.alloc(32, 2);

const RAW_URL = "https://example.test/verify?token=raw-token-9999";
const REDACTED_URL = "https://example.test/verify?token=[redacted]";

let app;

before(async () => {
    app = Fastify({ logger: false });
    await app.register(dbPlugin);
});

after(async () => {
    for (const orgId of [ORG_ACME, ORG_BETA]) {
        await app.withOrgContext(orgId, async (client) => {
            await client.query(
                `DELETE FROM email_outbox WHERE metadata->>'test_tag' LIKE $1`,
                [`${PREFIX}%`],
            );
        });
    }
    await app.close();
});

function makeSensitive() {
    const ct = encryptEmailSensitivePayload(RAW_URL, TEST_KEY);
    return { ...ct, keyVersion: 1 };
}

function devInput(overrides = {}) {
    return {
        orgId: ORG_ACME,
        toEmail: `dev-${randomUUID()}@example.test`,
        subject: "[Kloser test] verify your email",
        bodyText: `verify: ${RAW_URL}`,
        template: "email_verification",
        metadata: { test_tag: `${PREFIX}dev`, verifyUrl: RAW_URL },
        ...overrides,
    };
}

function pendingInput(overrides = {}) {
    return {
        orgId: ORG_BETA,
        toEmail: `pending-${randomUUID()}@example.test`,
        subject: "[Kloser test] verify your email",
        bodyText: `verify: ${REDACTED_URL}`,
        template: "email_verification",
        metadata: { test_tag: `${PREFIX}pending`, verifyUrl: REDACTED_URL },
        provider: "resend",
        sensitivePayload: makeSensitive(),
        ...overrides,
    };
}

async function purgeBetaPending() {
    await app.withOrgContext(ORG_BETA, async (client) => {
        await client.query(
            `DELETE FROM email_outbox
              WHERE org_id = $1
                AND status IN ('pending','failed','sending')`,
            [ORG_BETA],
        );
    });
}

// =============================================================
//                       ENCRYPTION HELPER
// =============================================================

test("encryption round-trip recovers plaintext", () => {
    const ct = encryptEmailSensitivePayload(RAW_URL, TEST_KEY);
    assert.ok(ct.ciphertext.length > 0);
    assert.ok(ct.iv.length > 0);
    assert.ok(ct.tag.length > 0);
    // ciphertext / iv / tag are base64 — none of them carries plaintext.
    assert.ok(!ct.ciphertext.includes("raw-token"));
    const recovered = decryptEmailSensitivePayload(ct, TEST_KEY);
    assert.equal(recovered, RAW_URL);
});

test("decryption with wrong key fails with EmailEncryptionFailureError", () => {
    const ct = encryptEmailSensitivePayload(RAW_URL, TEST_KEY);
    assert.throws(
        () => decryptEmailSensitivePayload(ct, WRONG_KEY),
        (err) => err instanceof EmailEncryptionFailureError,
    );
});

test("decryption with tampered tag fails with EmailEncryptionFailureError", () => {
    const ct = encryptEmailSensitivePayload(RAW_URL, TEST_KEY);
    const tampered = { ...ct, tag: Buffer.alloc(16, 0).toString("base64") };
    assert.throws(
        () => decryptEmailSensitivePayload(tampered, TEST_KEY),
        (err) => err instanceof EmailEncryptionFailureError,
    );
});

test("decryption error message does not echo plaintext", () => {
    const secret = "super-secret-marker-string-9999";
    const ct = encryptEmailSensitivePayload(secret, TEST_KEY);
    try {
        decryptEmailSensitivePayload(ct, WRONG_KEY);
        assert.fail("expected throw");
    } catch (err) {
        assert.ok(err instanceof EmailEncryptionFailureError);
        assert.ok(
            !String(err.message).includes(secret),
            "error message must not contain plaintext",
        );
    }
});

test("loadEmailOutboxEncryptionKey rejects missing env", () => {
    assert.throws(
        () => loadEmailOutboxEncryptionKey({}),
        (err) => err instanceof EmailEncryptionConfigError,
    );
});

test("loadEmailOutboxEncryptionKey rejects wrong-length key", () => {
    assert.throws(
        () => loadEmailOutboxEncryptionKey({
            EMAIL_OUTBOX_ENCRYPTION_KEY:
                Buffer.from("short", "utf8").toString("base64"),
        }),
        (err) => err instanceof EmailEncryptionConfigError,
    );
});

test("loadEmailOutboxEncryptionKey rejects non-base64 characters even when decoded length would be valid", () => {
    assert.throws(
        () => loadEmailOutboxEncryptionKey({
            EMAIL_OUTBOX_ENCRYPTION_KEY: `${TEST_KEY.toString("base64")}!`,
        }),
        (err) => err instanceof EmailEncryptionConfigError,
    );
});

test("loadEmailOutboxEncryptionKey accepts valid 32-byte base64 key", () => {
    const key = loadEmailOutboxEncryptionKey({
        EMAIL_OUTBOX_ENCRYPTION_KEY: TEST_KEY.toString("base64"),
    });
    assert.ok(Buffer.isBuffer(key));
    assert.equal(key.length, 32);
});

// =============================================================
//                       INSERT PATHS
// =============================================================

test("insertDeliveredDevEmail produces dev_outbox delivered row", async () => {
    const row = await app.withOrgContext(ORG_ACME, (client) =>
        outboxRepo.insertDeliveredDevEmail(client, devInput()),
    );
    assert.equal(row.org_id, ORG_ACME);
    assert.equal(row.status, "delivered");
    assert.equal(row.provider, "dev_outbox");
    assert.ok(row.delivered_at, "delivered_at must be set");
    assert.equal(row.failed_at, null);
    assert.equal(row.attempt_count, 0);
    assert.equal(row.provider_message_id, null);
    assert.equal(row.locked_at, null);
    assert.equal(row.lock_token, null);
    // dev archive keeps raw URL for Phase 3 e2e token extraction.
    assert.ok(row.body_text.includes("raw-token-9999"));
    // sensitive_payload_* stay NULL — dev provider never encrypts.
    assert.equal(row.sensitive_payload_ciphertext, null);
    assert.equal(row.sensitive_payload_iv, null);
    assert.equal(row.sensitive_payload_tag, null);
});

test("insertPendingEmail produces pending row with sensitive payload set", async () => {
    const row = await app.withOrgContext(ORG_BETA, (client) =>
        outboxRepo.insertPendingEmail(client, pendingInput()),
    );
    assert.equal(row.org_id, ORG_BETA);
    assert.equal(row.status, "pending");
    assert.equal(row.provider, "resend");
    assert.equal(row.delivered_at, null);
    assert.equal(row.attempt_count, 0);
    assert.ok(row.next_attempt_at, "pending row must be immediately due");
    assert.ok(row.sensitive_payload_ciphertext);
    assert.ok(row.sensitive_payload_iv);
    assert.ok(row.sensitive_payload_tag);
    assert.equal(row.sensitive_payload_key_version, 1);
    // body_text must NOT contain the raw token in real-provider mode.
    assert.ok(
        !row.body_text.includes("raw-token-9999"),
        "pending body_text must be redacted",
    );
    // Decrypt the stored ciphertext to confirm the worker can recover the URL.
    const decrypted = decryptEmailSensitivePayload(
        {
            ciphertext: row.sensitive_payload_ciphertext,
            iv: row.sensitive_payload_iv,
            tag: row.sensitive_payload_tag,
        },
        TEST_KEY,
    );
    assert.equal(decrypted, RAW_URL);
});

// =============================================================
//                       RLS ISOLATION
// =============================================================

test("Beta context cannot SELECT an Acme email_outbox row", async () => {
    const acmeRow = await app.withOrgContext(ORG_ACME, (client) =>
        outboxRepo.insertDeliveredDevEmail(client, devInput({
            metadata: { test_tag: `${PREFIX}rls-select`, verifyUrl: RAW_URL },
        })),
    );

    const visibleFromBeta = await app.withOrgContext(ORG_BETA, async (client) => {
        const r = await client.query(
            `SELECT id FROM email_outbox WHERE id = $1`,
            [acmeRow.id],
        );
        return r.rowCount;
    });
    assert.equal(visibleFromBeta, 0);
});

test("Beta context UPDATE on Acme row affects zero rows", async () => {
    const acmeRow = await app.withOrgContext(ORG_ACME, (client) =>
        outboxRepo.insertDeliveredDevEmail(client, devInput({
            metadata: { test_tag: `${PREFIX}rls-update`, verifyUrl: RAW_URL },
        })),
    );

    await app.withOrgContext(ORG_BETA, async (client) => {
        const r = await client.query(
            `UPDATE email_outbox SET status = 'failed' WHERE id = $1`,
            [acmeRow.id],
        );
        assert.equal(r.rowCount, 0);
    });

    const reread = await app.withOrgContext(ORG_ACME, async (client) => {
        const r = await client.query(
            `SELECT status FROM email_outbox WHERE id = $1`,
            [acmeRow.id],
        );
        return r.rows[0];
    });
    assert.equal(reread.status, "delivered");
});

// =============================================================
//                       LEASE
// =============================================================

test("leaseDueEmail picks pending row and marks it sending", async () => {
    await purgeBetaPending();
    const pending = await app.withOrgContext(ORG_BETA, (client) =>
        outboxRepo.insertPendingEmail(client, pendingInput({
            metadata: { test_tag: `${PREFIX}lease-basic`, verifyUrl: REDACTED_URL },
        })),
    );

    const lockToken = randomUUID();
    const leased = await app.withOrgContext(ORG_BETA, (client) =>
        outboxRepo.leaseDueEmail(client, new Date(), lockToken),
    );

    assert.ok(leased, "lease must return a row");
    assert.equal(leased.id, pending.id);
    assert.equal(leased.status, "sending");
    assert.equal(leased.lock_token, lockToken);
    assert.ok(leased.locked_at, "locked_at must be set");
    assert.ok(leased.last_attempt_at, "last_attempt_at must be set");
    // lease must NOT bump attempt_count — mark* helpers own that.
    assert.equal(leased.attempt_count, 0);
});

test("leaseDueEmail returns null when no row is due", async () => {
    await purgeBetaPending();

    const leased = await app.withOrgContext(ORG_BETA, (client) =>
        outboxRepo.leaseDueEmail(client, new Date(), randomUUID()),
    );
    assert.equal(leased, null);
});

test("leaseDueEmail skips delivered rows", async () => {
    await purgeBetaPending();
    // Insert a delivered (dev) Beta row — it must never be leased.
    const delivered = await app.withOrgContext(ORG_BETA, (client) =>
        outboxRepo.insertDeliveredDevEmail(client, devInput({
            orgId: ORG_BETA,
            metadata: { test_tag: `${PREFIX}lease-skip-delivered`, verifyUrl: RAW_URL },
        })),
    );
    assert.equal(delivered.status, "delivered");

    const leased = await app.withOrgContext(ORG_BETA, (client) =>
        outboxRepo.leaseDueEmail(client, new Date(), randomUUID()),
    );
    assert.equal(leased, null, "delivered row must not be leased");
});

test("leaseDueEmail respects next_attempt_at in the future", async () => {
    await purgeBetaPending();
    const future = new Date(Date.now() + 60 * 60 * 1000); // +1h
    await app.withOrgContext(ORG_BETA, (client) =>
        outboxRepo.insertPendingEmail(client, pendingInput({
            metadata: { test_tag: `${PREFIX}lease-future`, verifyUrl: REDACTED_URL },
            nextAttemptAt: future,
        })),
    );

    const leased = await app.withOrgContext(ORG_BETA, (client) =>
        outboxRepo.leaseDueEmail(client, new Date(), randomUUID()),
    );
    assert.equal(leased, null, "row not yet due must not be leased");
});

test("leaseDueEmail with FOR UPDATE SKIP LOCKED issues exactly one lease", async () => {
    await purgeBetaPending();
    const seeded = await app.withOrgContext(ORG_BETA, (client) =>
        outboxRepo.insertPendingEmail(client, pendingInput({
            metadata: { test_tag: `${PREFIX}lease-skip-locked`, verifyUrl: REDACTED_URL },
        })),
    );

    // Open two raw pool clients so both transactions overlap. If we ran
    // leaseDueEmail through withOrgContext serially, the first tx would
    // commit before the second tx began and SKIP LOCKED would have
    // nothing to demonstrate.
    const tokenA = randomUUID();
    const tokenB = randomUUID();
    const clientA = await app.pg.connect();
    const clientB = await app.pg.connect();
    let leasedA = null;
    let leasedB = null;
    try {
        await clientA.query("BEGIN");
        await clientA.query(
            "SELECT set_config('app.org_id', $1, true)", [ORG_BETA],
        );
        await clientB.query("BEGIN");
        await clientB.query(
            "SELECT set_config('app.org_id', $1, true)", [ORG_BETA],
        );

        leasedA = await outboxRepo.leaseDueEmail(clientA, new Date(), tokenA);
        leasedB = await outboxRepo.leaseDueEmail(clientB, new Date(), tokenB);

        await clientA.query("COMMIT");
        await clientB.query("COMMIT");
    } finally {
        clientA.release();
        clientB.release();
    }

    assert.ok(leasedA, "first concurrent lease must succeed");
    assert.equal(leasedA.id, seeded.id);
    assert.equal(leasedA.lock_token, tokenA);
    assert.equal(leasedB, null, "second concurrent lease must SKIP LOCKED");
});

// =============================================================
//                       MARK TRANSITIONS
// =============================================================

test("markDelivered records success and clears lock metadata", async () => {
    await purgeBetaPending();
    await app.withOrgContext(ORG_BETA, (client) =>
        outboxRepo.insertPendingEmail(client, pendingInput({
            metadata: { test_tag: `${PREFIX}mark-delivered`, verifyUrl: REDACTED_URL },
        })),
    );
    const leased = await app.withOrgContext(ORG_BETA, (client) =>
        outboxRepo.leaseDueEmail(client, new Date(), randomUUID()),
    );
    assert.ok(leased);

    await app.withOrgContext(ORG_BETA, (client) =>
        outboxRepo.markDelivered(client, leased.id, "resend-msg-001"),
    );

    const reread = await app.withOrgContext(ORG_BETA, async (client) => {
        const r = await client.query(
            `SELECT status, delivered_at, provider_message_id,
                    locked_at, lock_token, attempt_count
               FROM email_outbox WHERE id = $1`,
            [leased.id],
        );
        return r.rows[0];
    });
    assert.equal(reread.status, "delivered");
    assert.ok(reread.delivered_at);
    assert.equal(reread.provider_message_id, "resend-msg-001");
    assert.equal(reread.locked_at, null);
    assert.equal(reread.lock_token, null);
    // markDelivered alone does not increment attempt_count — that's the
    // worker's last_attempt_at semantic. attempt_count only moves on
    // explicit failure / dead-letter.
    assert.equal(reread.attempt_count, 0);
});

test("markDelivered composes with scrubSensitivePayload", async () => {
    await purgeBetaPending();
    await app.withOrgContext(ORG_BETA, (client) =>
        outboxRepo.insertPendingEmail(client, pendingInput({
            metadata: { test_tag: `${PREFIX}mark-scrub`, verifyUrl: REDACTED_URL },
        })),
    );
    const leased = await app.withOrgContext(ORG_BETA, (client) =>
        outboxRepo.leaseDueEmail(client, new Date(), randomUUID()),
    );
    assert.ok(leased);

    await app.withOrgContext(ORG_BETA, async (client) => {
        await outboxRepo.markDelivered(client, leased.id, "resend-msg-002");
        await outboxRepo.scrubSensitivePayload(client, leased.id);
    });

    const reread = await app.withOrgContext(ORG_BETA, async (client) => {
        const r = await client.query(
            `SELECT sensitive_payload_ciphertext, sensitive_payload_iv,
                    sensitive_payload_tag, sensitive_payload_key_version
               FROM email_outbox WHERE id = $1`,
            [leased.id],
        );
        return r.rows[0];
    });
    assert.equal(reread.sensitive_payload_ciphertext, null);
    assert.equal(reread.sensitive_payload_iv, null);
    assert.equal(reread.sensitive_payload_tag, null);
    // key_version is intentionally retained — it records which key
    // produced the now-removed ciphertext.
    assert.equal(reread.sensitive_payload_key_version, 1);
});

test("markRetryableFailure increments attempt_count and sets retry fields", async () => {
    await purgeBetaPending();
    await app.withOrgContext(ORG_BETA, (client) =>
        outboxRepo.insertPendingEmail(client, pendingInput({
            metadata: { test_tag: `${PREFIX}mark-retry`, verifyUrl: REDACTED_URL },
        })),
    );
    const leased = await app.withOrgContext(ORG_BETA, (client) =>
        outboxRepo.leaseDueEmail(client, new Date(), randomUUID()),
    );
    assert.ok(leased);

    const nextAt = new Date(Date.now() + 5 * 60 * 1000);
    await app.withOrgContext(ORG_BETA, (client) =>
        outboxRepo.markRetryableFailure(client, leased.id, "503 upstream", nextAt),
    );

    const reread = await app.withOrgContext(ORG_BETA, async (client) => {
        const r = await client.query(
            `SELECT status, failed_at, error_message, attempt_count,
                    next_attempt_at, locked_at, lock_token
               FROM email_outbox WHERE id = $1`,
            [leased.id],
        );
        return r.rows[0];
    });
    assert.equal(reread.status, "failed");
    assert.ok(reread.failed_at);
    assert.equal(reread.error_message, "503 upstream");
    assert.equal(reread.attempt_count, 1);
    assert.equal(reread.next_attempt_at.getTime(), nextAt.getTime());
    assert.equal(reread.locked_at, null);
    assert.equal(reread.lock_token, null);
});

test("markDeadLetter sets terminal state and increments attempt_count", async () => {
    await purgeBetaPending();
    await app.withOrgContext(ORG_BETA, (client) =>
        outboxRepo.insertPendingEmail(client, pendingInput({
            metadata: { test_tag: `${PREFIX}mark-dead`, verifyUrl: REDACTED_URL },
        })),
    );
    const leased = await app.withOrgContext(ORG_BETA, (client) =>
        outboxRepo.leaseDueEmail(client, new Date(), randomUUID()),
    );
    assert.ok(leased);

    await app.withOrgContext(ORG_BETA, (client) =>
        outboxRepo.markDeadLetter(client, leased.id, "permanent: bad recipient"),
    );

    const reread = await app.withOrgContext(ORG_BETA, async (client) => {
        const r = await client.query(
            `SELECT status, dead_lettered_at, error_message, attempt_count,
                    locked_at, lock_token
               FROM email_outbox WHERE id = $1`,
            [leased.id],
        );
        return r.rows[0];
    });
    assert.equal(reread.status, "dead_lettered");
    assert.ok(reread.dead_lettered_at);
    assert.equal(reread.error_message, "permanent: bad recipient");
    assert.equal(reread.attempt_count, 1);
    assert.equal(reread.locked_at, null);
    assert.equal(reread.lock_token, null);
});

test("mark* helpers reject rows not in 'sending' state", async () => {
    await purgeBetaPending();
    const row = await app.withOrgContext(ORG_BETA, (client) =>
        outboxRepo.insertPendingEmail(client, pendingInput({
            metadata: { test_tag: `${PREFIX}mark-guard`, verifyUrl: REDACTED_URL },
        })),
    );
    // row is 'pending', not 'sending' — markDelivered must throw.
    await assert.rejects(
        app.withOrgContext(ORG_BETA, (client) =>
            outboxRepo.markDelivered(client, row.id, "should-not-stick"),
        ),
        /expected status='sending'/,
    );
});

// =============================================================
//                       SCRUB IDEMPOTENCY
// =============================================================

test("scrubSensitivePayload is idempotent", async () => {
    await purgeBetaPending();
    await app.withOrgContext(ORG_BETA, (client) =>
        outboxRepo.insertPendingEmail(client, pendingInput({
            metadata: { test_tag: `${PREFIX}scrub-idem`, verifyUrl: REDACTED_URL },
        })),
    );
    const leased = await app.withOrgContext(ORG_BETA, (client) =>
        outboxRepo.leaseDueEmail(client, new Date(), randomUUID()),
    );
    assert.ok(leased);

    await app.withOrgContext(ORG_BETA, async (client) => {
        await outboxRepo.markDelivered(client, leased.id, "resend-msg-idem");
        await outboxRepo.scrubSensitivePayload(client, leased.id);
        // Second scrub is a no-op.
        await outboxRepo.scrubSensitivePayload(client, leased.id);
    });

    const reread = await app.withOrgContext(ORG_BETA, async (client) => {
        const r = await client.query(
            `SELECT sensitive_payload_ciphertext, sensitive_payload_iv,
                    sensitive_payload_tag
               FROM email_outbox WHERE id = $1`,
            [leased.id],
        );
        return r.rows[0];
    });
    assert.equal(reread.sensitive_payload_ciphertext, null);
    assert.equal(reread.sensitive_payload_iv, null);
    assert.equal(reread.sensitive_payload_tag, null);
});

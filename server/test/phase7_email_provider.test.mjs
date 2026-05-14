/* Phase 7 Step 1 — email provider resolver + dev/queued behavior tests.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_1_PLAN.md §5.1, §5.3, §10.
 *
 * Coverage:
 *   Resolver:
 *     - unset / empty / 'dev_outbox' → DevOutboxEmailProvider
 *     - 'resend' with missing EMAIL_FROM      → fail-fast
 *     - 'resend' with missing RESEND_API_KEY  → fail-fast
 *     - 'resend' with missing EMAIL_OUTBOX_ENCRYPTION_KEY → fail-fast
 *     - 'resend' with invalid encryption key  → fail-fast
 *     - unknown provider value                → fail-fast
 *     - all valid env                         → QueuedEmailProvider
 *     - error messages never echo RESEND_API_KEY / EMAIL_FROM secret-shape
 *
 *   Dev provider (Phase 3 archive contract):
 *     - sendVerificationEmail writes status='delivered', provider='dev_outbox',
 *       body_text + metadata.verifyUrl both contain the raw token.
 *     - sendPasswordResetEmail keeps raw URL in body_text (route test compat).
 *     - sendInvitationEmail keeps raw URL in metadata.acceptUrl (route test compat).
 *
 *   Queued provider:
 *     - writes status='pending', provider='resend' row.
 *     - body_text + metadata.<*>Url carry ?token=[redacted], NOT raw token.
 *     - sensitive_payload_* populated; decrypt round-trip recovers raw URL.
 *
 *   Cleanup: PREFIX-tagged rows removed in `after`.
 *
 * Run: cd server && npm test
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import dbPlugin from "../src/plugins/db.js";
import {
    DevOutboxEmailProvider,
    QueuedEmailProvider,
    EmailProviderConfigError,
    resolveEmailProvider,
} from "../src/services/email.js";
import {
    EmailEncryptionConfigError,
    decryptEmailSensitivePayload,
} from "../src/services/emailSensitivePayload.js";

const ORG_ACME = "11111111-1111-1111-1111-111111111111";

const PREFIX = `phase7provider-${process.pid}-${Date.now()}-`;
const TEST_KEY = Buffer.alloc(32, 7);
const TEST_KEY_B64 = TEST_KEY.toString("base64");

const RAW_TOKEN = "raw-token-marker-1234567890";
const VERIFY_URL = `http://localhost:8765/platform/verify.html?token=${encodeURIComponent(RAW_TOKEN)}`;
const ACCEPT_URL = `http://localhost:8765/platform/accept-invitation.html?token=${encodeURIComponent(RAW_TOKEN)}`;
const RESET_URL  = `http://localhost:8765/platform/reset-password.html?token=${encodeURIComponent(RAW_TOKEN)}`;

let app;

before(async () => {
    app = Fastify({ logger: false });
    await app.register(dbPlugin);
});

after(async () => {
    await app.withOrgContext(ORG_ACME, async (client) => {
        await client.query(
            `DELETE FROM email_outbox WHERE metadata->>'test_tag' LIKE $1`,
            [`${PREFIX}%`],
        );
    });
    await app.close();
});

// Helper to read the most recent outbox row tagged for this test.
async function readByTag(tag) {
    return app.withOrgContext(ORG_ACME, async (client) => {
        const r = await client.query(
            `SELECT id, status, provider, body_text, metadata, delivered_at,
                    sensitive_payload_ciphertext, sensitive_payload_iv,
                    sensitive_payload_tag, sensitive_payload_key_version
               FROM email_outbox
              WHERE metadata->>'test_tag' = $1
              ORDER BY created_at DESC LIMIT 1`,
            [tag],
        );
        return r.rows[0];
    });
}

// =============================================================
//                       RESOLVER — DEFAULT / DEV
// =============================================================

test("resolveEmailProvider with no env returns DevOutboxEmailProvider", () => {
    const p = resolveEmailProvider({});
    assert.ok(p instanceof DevOutboxEmailProvider);
});

test("resolveEmailProvider with empty EMAIL_PROVIDER returns dev", () => {
    const p = resolveEmailProvider({ EMAIL_PROVIDER: "" });
    assert.ok(p instanceof DevOutboxEmailProvider);
});

test("resolveEmailProvider with EMAIL_PROVIDER=dev_outbox returns dev", () => {
    const p = resolveEmailProvider({ EMAIL_PROVIDER: "dev_outbox" });
    assert.ok(p instanceof DevOutboxEmailProvider);
});

test("resolveEmailProvider tolerates whitespace and case (Dev_Outbox)", () => {
    const p = resolveEmailProvider({ EMAIL_PROVIDER: "  Dev_Outbox  " });
    assert.ok(p instanceof DevOutboxEmailProvider);
});

// =============================================================
//                       RESOLVER — RESEND HAPPY PATH
// =============================================================

test("resolveEmailProvider with full resend env returns QueuedEmailProvider", () => {
    const p = resolveEmailProvider({
        EMAIL_PROVIDER: "resend",
        EMAIL_FROM: "Kloser <no-reply@example.test>",
        RESEND_API_KEY: "re_test_key_should_not_appear_anywhere",
        EMAIL_OUTBOX_ENCRYPTION_KEY: TEST_KEY_B64,
    });
    assert.ok(p instanceof QueuedEmailProvider);
});

// =============================================================
//                       RESOLVER — RESEND FAIL-FAST
// =============================================================

test("resolveEmailProvider EMAIL_PROVIDER=resend without EMAIL_FROM fails fast", () => {
    assert.throws(
        () => resolveEmailProvider({ EMAIL_PROVIDER: "resend" }),
        (err) => err instanceof EmailProviderConfigError &&
                 /EMAIL_FROM/.test(err.message),
    );
});

test("resolveEmailProvider EMAIL_PROVIDER=resend without RESEND_API_KEY fails fast", () => {
    assert.throws(
        () => resolveEmailProvider({
            EMAIL_PROVIDER: "resend",
            EMAIL_FROM: "k@x",
        }),
        (err) => err instanceof EmailProviderConfigError &&
                 /RESEND_API_KEY/.test(err.message),
    );
});

test("resolveEmailProvider EMAIL_PROVIDER=resend without EMAIL_OUTBOX_ENCRYPTION_KEY fails fast", () => {
    assert.throws(
        () => resolveEmailProvider({
            EMAIL_PROVIDER: "resend",
            EMAIL_FROM: "k@x",
            RESEND_API_KEY: "re_anything",
        }),
        (err) => err instanceof EmailEncryptionConfigError &&
                 /EMAIL_OUTBOX_ENCRYPTION_KEY/.test(err.message),
    );
});

test("resolveEmailProvider EMAIL_PROVIDER=resend with invalid (short) key fails fast", () => {
    assert.throws(
        () => resolveEmailProvider({
            EMAIL_PROVIDER: "resend",
            EMAIL_FROM: "k@x",
            RESEND_API_KEY: "re_anything",
            EMAIL_OUTBOX_ENCRYPTION_KEY:
                Buffer.from("too-short", "utf8").toString("base64"),
        }),
        (err) => err instanceof EmailEncryptionConfigError,
    );
});

test("resolveEmailProvider with unknown EMAIL_PROVIDER value fails fast", () => {
    assert.throws(
        () => resolveEmailProvider({ EMAIL_PROVIDER: "smtp" }),
        (err) => err instanceof EmailProviderConfigError &&
                 /Unknown EMAIL_PROVIDER/.test(err.message) &&
                 !err.message.includes("smtp"),
    );
});

test("fail-fast error messages do not echo secret RESEND_API_KEY value", () => {
    const secret = "re_VERY_SECRET_API_KEY_DO_NOT_LEAK";
    try {
        resolveEmailProvider({
            EMAIL_PROVIDER: "resend",
            EMAIL_FROM: "k@x",
            RESEND_API_KEY: secret,
            // EMAIL_OUTBOX_ENCRYPTION_KEY missing → throws here
        });
        assert.fail("expected throw");
    } catch (err) {
        assert.ok(
            !String(err.message).includes(secret),
            "error message must not include RESEND_API_KEY value",
        );
    }
});

test("fail-fast error messages do not echo raw URL / raw token values", () => {
    try {
        resolveEmailProvider({ EMAIL_PROVIDER: "smtp+token=raw-secret" });
        assert.fail("expected throw");
    } catch (err) {
        assert.ok(err instanceof EmailProviderConfigError);
        assert.ok(!String(err.message).includes("raw-secret"));
        assert.ok(!String(err.message).includes("token="));
    }
});

// =============================================================
//                  DEV PROVIDER — PHASE 3 ARCHIVE CONTRACT
// =============================================================

test("dev provider keeps raw token in body_text + metadata.verifyUrl", async () => {
    const provider = new DevOutboxEmailProvider();
    const tag = `${PREFIX}dev-verify`;

    await app.withOrgContext(ORG_ACME, async (client) => {
        // Pass a metadata-bearing override is impossible (provider builds it),
        // so we tag the resulting row by querying for raw token presence and
        // marking it post-INSERT.
        await provider.sendVerificationEmail({
            client,
            orgId: ORG_ACME,
            toEmail: `dev-verify-${randomUUID()}@example.test`,
            toName: "Verify Tester",
            verifyUrl: VERIFY_URL,
            rawToken: RAW_TOKEN,
        });
        await client.query(
            `UPDATE email_outbox
                SET metadata = metadata || jsonb_build_object('test_tag', $1::text)
              WHERE id = (
                  SELECT id FROM email_outbox
                   WHERE template = 'email_verification'
                     AND metadata ? 'verifyUrl'
                   ORDER BY created_at DESC LIMIT 1
              )`,
            [tag],
        );
    });

    const row = await readByTag(tag);
    assert.ok(row, "dev verify row must be readable");
    assert.equal(row.status, "delivered");
    assert.equal(row.provider, "dev_outbox");
    assert.ok(row.delivered_at);
    assert.ok(
        row.body_text.includes(RAW_TOKEN),
        "Phase 3 contract: dev body_text must contain raw token",
    );
    assert.equal(row.metadata.verifyUrl, VERIFY_URL);
    assert.equal(row.sensitive_payload_ciphertext, null);
});

test("dev provider keeps raw token in body_text for password reset", async () => {
    const provider = new DevOutboxEmailProvider();
    const tag = `${PREFIX}dev-reset`;

    await app.withOrgContext(ORG_ACME, async (client) => {
        await provider.sendPasswordResetEmail({
            client,
            orgId: ORG_ACME,
            toEmail: `dev-reset-${randomUUID()}@example.test`,
            toName: "Reset Tester",
            resetUrl: RESET_URL,
            rawToken: RAW_TOKEN,
        });
        await client.query(
            `UPDATE email_outbox
                SET metadata = metadata || jsonb_build_object('test_tag', $1::text)
              WHERE id = (
                  SELECT id FROM email_outbox
                   WHERE template = 'password_reset'
                     AND metadata ? 'resetUrl'
                   ORDER BY created_at DESC LIMIT 1
              )`,
            [tag],
        );
    });

    const row = await readByTag(tag);
    assert.ok(row);
    assert.equal(row.status, "delivered");
    assert.equal(row.provider, "dev_outbox");
    assert.ok(
        row.body_text.includes(RAW_TOKEN),
        "password_reset_routes test extracts token from body_text",
    );
    assert.equal(row.metadata.resetUrl, RESET_URL);
});

test("dev provider keeps raw token in metadata.acceptUrl for invitation", async () => {
    const provider = new DevOutboxEmailProvider();
    const tag = `${PREFIX}dev-invite`;
    const invitationId = randomUUID();

    await app.withOrgContext(ORG_ACME, async (client) => {
        await provider.sendInvitationEmail({
            client,
            orgId: ORG_ACME,
            toEmail: `dev-invite-${randomUUID()}@example.test`,
            toName: "Invite Tester",
            inviterName: "Alice",
            organizationName: "Acme",
            acceptUrl: ACCEPT_URL,
            invitationId,
            rawToken: RAW_TOKEN,
        });
        await client.query(
            `UPDATE email_outbox
                SET metadata = metadata || jsonb_build_object('test_tag', $2::text)
              WHERE id = (
                  SELECT id FROM email_outbox
                   WHERE template = 'invitation'
                     AND metadata->>'invitation_id' = $1
                   ORDER BY created_at DESC LIMIT 1
              )`,
            [invitationId, tag],
        );
    });

    const row = await readByTag(tag);
    assert.ok(row);
    assert.equal(row.status, "delivered");
    assert.equal(row.provider, "dev_outbox");
    // invitation_routes.test.mjs extracts the token from metadata.acceptUrl,
    // so the raw URL must be preserved verbatim there.
    assert.equal(row.metadata.acceptUrl, ACCEPT_URL);
    assert.equal(row.metadata.invitation_id, invitationId);
});

// =============================================================
//                  QUEUED PROVIDER — PENDING + REDACTED
// =============================================================

test("queued provider writes pending row with redacted body + encrypted payload", async () => {
    const provider = new QueuedEmailProvider({ encryptionKey: TEST_KEY });
    const tag = `${PREFIX}queued-verify`;

    await app.withOrgContext(ORG_ACME, async (client) => {
        await provider.sendVerificationEmail({
            client,
            orgId: ORG_ACME,
            toEmail: `queued-verify-${randomUUID()}@example.test`,
            toName: "Verify Tester",
            verifyUrl: VERIFY_URL,
            rawToken: RAW_TOKEN,
        });
        await client.query(
            `UPDATE email_outbox
                SET metadata = metadata || jsonb_build_object('test_tag', $1::text)
              WHERE id = (
                  SELECT id FROM email_outbox
                   WHERE template = 'email_verification'
                     AND status = 'pending'
                     AND provider = 'resend'
                   ORDER BY created_at DESC LIMIT 1
              )`,
            [tag],
        );
    });

    const row = await readByTag(tag);
    assert.ok(row, "queued verify row must exist");
    assert.equal(row.status, "pending");
    assert.equal(row.provider, "resend");
    assert.equal(row.delivered_at, null);
    // Raw token MUST NOT survive in archive fields.
    assert.ok(
        !row.body_text.includes(RAW_TOKEN),
        "queued provider must redact raw token from body_text",
    );
    assert.ok(
        !String(row.metadata.verifyUrl).includes(RAW_TOKEN),
        "queued provider must redact raw token from metadata.verifyUrl",
    );
    assert.match(row.metadata.verifyUrl, /\?token=\[redacted\]$/);
    // Sensitive payload is populated and decryptable.
    assert.ok(row.sensitive_payload_ciphertext);
    assert.ok(row.sensitive_payload_iv);
    assert.ok(row.sensitive_payload_tag);
    assert.equal(row.sensitive_payload_key_version, 1);
    const decrypted = decryptEmailSensitivePayload({
        ciphertext: row.sensitive_payload_ciphertext,
        iv: row.sensitive_payload_iv,
        tag: row.sensitive_payload_tag,
    }, TEST_KEY);
    assert.equal(decrypted, VERIFY_URL);
});

test("queued provider redacts invitation acceptUrl and encrypts the raw URL", async () => {
    const provider = new QueuedEmailProvider({ encryptionKey: TEST_KEY });
    const tag = `${PREFIX}queued-invite`;
    const invitationId = randomUUID();

    await app.withOrgContext(ORG_ACME, async (client) => {
        await provider.sendInvitationEmail({
            client,
            orgId: ORG_ACME,
            toEmail: `queued-invite-${randomUUID()}@example.test`,
            toName: "Invite Tester",
            inviterName: "Alice",
            organizationName: "Acme",
            acceptUrl: ACCEPT_URL,
            invitationId,
            rawToken: RAW_TOKEN,
        });
        await client.query(
            `UPDATE email_outbox
                SET metadata = metadata || jsonb_build_object('test_tag', $2::text)
              WHERE id = (
                  SELECT id FROM email_outbox
                   WHERE template = 'invitation'
                     AND status = 'pending'
                     AND metadata->>'invitation_id' = $1
                   ORDER BY created_at DESC LIMIT 1
              )`,
            [invitationId, tag],
        );
    });

    const row = await readByTag(tag);
    assert.ok(row);
    assert.equal(row.status, "pending");
    assert.equal(row.provider, "resend");
    assert.ok(!row.body_text.includes(RAW_TOKEN));
    assert.ok(!String(row.metadata.acceptUrl).includes(RAW_TOKEN));
    assert.match(row.metadata.acceptUrl, /\?token=\[redacted\]$/);
    const decrypted = decryptEmailSensitivePayload({
        ciphertext: row.sensitive_payload_ciphertext,
        iv: row.sensitive_payload_iv,
        tag: row.sensitive_payload_tag,
    }, TEST_KEY);
    assert.equal(decrypted, ACCEPT_URL);
});

test("queued provider redacts password-reset URL and encrypts the raw URL", async () => {
    const provider = new QueuedEmailProvider({ encryptionKey: TEST_KEY });
    const tag = `${PREFIX}queued-reset`;

    await app.withOrgContext(ORG_ACME, async (client) => {
        await provider.sendPasswordResetEmail({
            client,
            orgId: ORG_ACME,
            toEmail: `queued-reset-${randomUUID()}@example.test`,
            toName: "Reset Tester",
            resetUrl: RESET_URL,
            rawToken: RAW_TOKEN,
        });
        await client.query(
            `UPDATE email_outbox
                SET metadata = metadata || jsonb_build_object('test_tag', $1::text)
              WHERE id = (
                  SELECT id FROM email_outbox
                   WHERE template = 'password_reset'
                     AND status = 'pending'
                     AND provider = 'resend'
                   ORDER BY created_at DESC LIMIT 1
              )`,
            [tag],
        );
    });

    const row = await readByTag(tag);
    assert.ok(row);
    assert.equal(row.status, "pending");
    assert.equal(row.provider, "resend");
    assert.ok(!row.body_text.includes(RAW_TOKEN));
    assert.ok(!String(row.metadata.resetUrl).includes(RAW_TOKEN));
    const decrypted = decryptEmailSensitivePayload({
        ciphertext: row.sensitive_payload_ciphertext,
        iv: row.sensitive_payload_iv,
        tag: row.sensitive_payload_tag,
    }, TEST_KEY);
    assert.equal(decrypted, RESET_URL);
});

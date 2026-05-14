/* Phase 7 Step 2 — TOTP + MFA secret encryption helper tests.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_2_PLAN.md §4.1, §4.2.
 *
 * No DB. All tests are pure functional unit tests on the two helper
 * modules under `server/src/services/`.
 *
 * TOTP coverage:
 *   - generateTotpSecret returns 20 raw bytes + 32-char base32.
 *   - base32 round-trips for the generated secret.
 *   - buildOtpauthUri produces the documented shape with all RFC 6238
 *     parameters (algorithm/period/digits/issuer).
 *   - RFC 6238 Appendix B fixture (secret = ASCII "12345678901234567890")
 *     reproduces published 8-digit codes truncated to 6 digits.
 *   - verifyTotp accepts current step + step -1 + step +1.
 *   - verifyTotp rejects step ±2 (outside drift window).
 *   - verifyTotp rejects malformed input: wrong length, non-digits,
 *     empty, whitespace, leading sign.
 *
 * MFA secret encryption coverage:
 *   - round-trip on a 20-byte Buffer (the actual TOTP secret shape).
 *   - decryption with wrong key → MfaSecretEncryptionFailureError.
 *   - decryption with tampered tag → MfaSecretEncryptionFailureError.
 *   - loadMfaSecretEncryptionKey: missing / non-base64 / wrong length.
 *   - error messages never echo plaintext / ciphertext / key bytes.
 *   - the loader reads MFA_SECRET_ENCRYPTION_KEY only (not the email
 *     outbox key) — env isolation from emailSensitivePayload.
 *
 * Run: cd server && npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
    base32Decode,
    base32Encode,
    buildOtpauthUri,
    generateTotp,
    generateTotpSecret,
    hotp,
    TOTP_DIGITS,
    TOTP_DRIFT_STEPS,
    TOTP_PERIOD_SECONDS,
    verifyTotp,
} from "../src/services/totp.js";
import {
    decryptMfaSecret,
    encryptMfaSecret,
    loadMfaSecretEncryptionKey,
    MfaSecretEncryptionConfigError,
    MfaSecretEncryptionFailureError,
} from "../src/services/mfaSecretEncryption.js";

// =============================================================
//                       TOTP — secret + URI
// =============================================================

test("generateTotpSecret returns 20 raw bytes + 32-char base32", () => {
    const s = generateTotpSecret();
    assert.equal(s.raw.length, 20);
    assert.equal(s.base32.length, 32);
    // 20-byte input must NOT need padding (160 bits / 5 = 32 chars).
    assert.ok(!s.base32.includes("="), "20-byte secret should not pad");
    // Alphabet check
    assert.match(s.base32, /^[A-Z2-7]+$/);
});

test("base32 round-trips the generated secret bytes", () => {
    const s = generateTotpSecret();
    const decoded = base32Decode(s.base32);
    assert.equal(decoded.length, 20);
    assert.deepEqual(decoded, s.raw);
});

test("base32 tolerates whitespace and lowercase + rejects garbage", () => {
    const original = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00]);
    const b32 = base32Encode(original);
    // Authenticator UIs often render with spaces every 4 chars.
    const spaced = b32.replace(/(.{4})/g, "$1 ");
    assert.deepEqual(base32Decode(spaced), original);
    // Lowercase round-trips.
    assert.deepEqual(base32Decode(b32.toLowerCase()), original);
    // Garbage rejected.
    assert.throws(() => base32Decode("!!!"));
    assert.throws(() => base32Decode("12345678")); // 1 + 8 not in alphabet
    assert.throws(() => base32Decode(""));
});

test("buildOtpauthUri carries every RFC 6238 parameter", () => {
    const secret = "JBSWY3DPEHPK3PXP";
    const uri = buildOtpauthUri({
        issuer: "Kloser",
        accountEmail: "user@example.test",
        secretBase32: secret,
    });
    // Path label is issuer:account, both URI-encoded.
    assert.ok(uri.startsWith("otpauth://totp/Kloser:"));
    const parsed = new URL(uri);
    assert.equal(parsed.searchParams.get("secret"), secret);
    assert.equal(parsed.searchParams.get("issuer"), "Kloser");
    assert.equal(parsed.searchParams.get("digits"), String(TOTP_DIGITS));
    assert.equal(parsed.searchParams.get("period"), String(TOTP_PERIOD_SECONDS));
    assert.equal(parsed.searchParams.get("algorithm"), "SHA1");
});

test("buildOtpauthUri URL-encodes account email special chars", () => {
    const uri = buildOtpauthUri({
        issuer: "Kloser",
        accountEmail: "name+tag@example.test",
        secretBase32: "JBSWY3DPEHPK3PXP",
    });
    // '+' and '@' both need encoding when they appear inside the label
    // (the authenticator app parses the path between scheme and ?).
    assert.ok(uri.includes("Kloser:name%2Btag%40example.test"),
        `expected encoded label in: ${uri}`);
});

// =============================================================
//                       TOTP — RFC 6238 vectors
// =============================================================
//
// RFC 6238 Appendix B uses ASCII secret "12345678901234567890" and lists
// 8-digit codes for several T values. A 6-digit code is the last 6
// digits of the 8-digit code because
//   (binary % 10^8) % 10^6 === binary % 10^6
// so we can use the same fixture without re-running the algorithm.

const RFC6238_SECRET_BYTES  = Buffer.from("12345678901234567890", "utf8");
const RFC6238_SECRET_BASE32 = base32Encode(RFC6238_SECRET_BYTES);

const RFC_VECTORS = [
    { unixSeconds: 59,         eightDigit: "94287082", sixDigit: "287082" },
    { unixSeconds: 1111111109, eightDigit: "07081804", sixDigit: "081804" },
    { unixSeconds: 1111111111, eightDigit: "14050471", sixDigit: "050471" },
    { unixSeconds: 1234567890, eightDigit: "89005924", sixDigit: "005924" },
    { unixSeconds: 2000000000, eightDigit: "69279037", sixDigit: "279037" },
];

for (const v of RFC_VECTORS) {
    test(`RFC 6238 fixture T=${v.unixSeconds} → ${v.sixDigit}`, () => {
        // hotp() takes the counter (T / period); generateTotp takes a Date.
        // Cover both surfaces so neither drifts independently.
        const counter = BigInt(Math.floor(v.unixSeconds / TOTP_PERIOD_SECONDS));
        assert.equal(hotp(RFC6238_SECRET_BYTES, counter), v.sixDigit);

        const at = new Date(v.unixSeconds * 1000);
        assert.equal(generateTotp({ secretBase32: RFC6238_SECRET_BASE32, now: at }), v.sixDigit);

        assert.equal(verifyTotp({
            secretBase32: RFC6238_SECRET_BASE32,
            code: v.sixDigit,
            now: at,
        }), true);
    });
}

// =============================================================
//                       TOTP — drift window
// =============================================================

test("verifyTotp accepts the previous step within ±1 drift", () => {
    const now = new Date(1234567890_000); // unix s = 1234567890
    // Server clock is `now`. The user authenticator's clock was -30s, so
    // the user sees the code for unixSeconds=1234567860, but the server
    // is verifying at unixSeconds=1234567890. Server must still accept.
    const oldStep = new Date((1234567890 - TOTP_PERIOD_SECONDS) * 1000);
    const userCode = generateTotp({ secretBase32: RFC6238_SECRET_BASE32, now: oldStep });
    assert.equal(verifyTotp({
        secretBase32: RFC6238_SECRET_BASE32,
        code: userCode,
        now,
    }), true);
});

test("verifyTotp accepts the next step within ±1 drift", () => {
    const now = new Date(1234567890_000);
    const futureStep = new Date((1234567890 + TOTP_PERIOD_SECONDS) * 1000);
    const userCode = generateTotp({ secretBase32: RFC6238_SECRET_BASE32, now: futureStep });
    assert.equal(verifyTotp({
        secretBase32: RFC6238_SECRET_BASE32,
        code: userCode,
        now,
    }), true);
});

test("verifyTotp rejects step −2 (outside drift window)", () => {
    const now = new Date(1234567890_000);
    const farPast = new Date((1234567890 - 2 * TOTP_PERIOD_SECONDS) * 1000);
    const code = generateTotp({ secretBase32: RFC6238_SECRET_BASE32, now: farPast });
    assert.equal(verifyTotp({
        secretBase32: RFC6238_SECRET_BASE32,
        code,
        now,
    }), false);
});

test("verifyTotp rejects step +2 (outside drift window)", () => {
    const now = new Date(1234567890_000);
    const farFuture = new Date((1234567890 + 2 * TOTP_PERIOD_SECONDS) * 1000);
    const code = generateTotp({ secretBase32: RFC6238_SECRET_BASE32, now: farFuture });
    assert.equal(verifyTotp({
        secretBase32: RFC6238_SECRET_BASE32,
        code,
        now,
    }), false);
});

test("TOTP_DRIFT_STEPS is exactly 1 per plan §2.1", () => {
    assert.equal(TOTP_DRIFT_STEPS, 1);
});

// =============================================================
//                       TOTP — malformed input
// =============================================================

test("verifyTotp rejects wrong-length codes (5 / 7 digits)", () => {
    const at = new Date(1234567890_000);
    assert.equal(verifyTotp({ secretBase32: RFC6238_SECRET_BASE32, code: "00592", now: at }), false);
    assert.equal(verifyTotp({ secretBase32: RFC6238_SECRET_BASE32, code: "0059240", now: at }), false);
});

test("verifyTotp rejects non-digit characters", () => {
    const at = new Date(1234567890_000);
    assert.equal(verifyTotp({ secretBase32: RFC6238_SECRET_BASE32, code: "00592a", now: at }), false);
    assert.equal(verifyTotp({ secretBase32: RFC6238_SECRET_BASE32, code: "0059 4", now: at }), false);
    assert.equal(verifyTotp({ secretBase32: RFC6238_SECRET_BASE32, code: "-05924", now: at }), false);
    assert.equal(verifyTotp({ secretBase32: RFC6238_SECRET_BASE32, code: "+05924", now: at }), false);
});

test("verifyTotp rejects empty / non-string input", () => {
    const at = new Date(1234567890_000);
    assert.equal(verifyTotp({ secretBase32: RFC6238_SECRET_BASE32, code: "", now: at }), false);
    // @ts-expect-error — runtime guard surface
    assert.equal(verifyTotp({ secretBase32: RFC6238_SECRET_BASE32, code: 5924, now: at }), false);
    // @ts-expect-error — null is also rejected
    assert.equal(verifyTotp({ secretBase32: RFC6238_SECRET_BASE32, code: null, now: at }), false);
});

// =============================================================
//                       MFA secret encryption
// =============================================================

const TEST_KEY     = Buffer.alloc(32, 7);  // 32 bytes, deterministic
const WRONG_KEY    = Buffer.alloc(32, 9);
const TEST_KEY_B64 = TEST_KEY.toString("base64");

test("encrypt/decrypt round-trips a 20-byte TOTP secret", () => {
    const secretBytes = Buffer.from("12345678901234567890", "utf8");
    const ct = encryptMfaSecret(secretBytes, TEST_KEY);
    assert.ok(ct.ciphertext);
    assert.ok(ct.iv);
    assert.ok(ct.tag);
    // ciphertext must not contain the plaintext bytes (base64 of
    // encrypted bytes won't match the ASCII secret).
    assert.ok(!ct.ciphertext.includes("MTIzNDU2Nzg5MDEyMzQ1Njc4OTA"),
        "base64 of plaintext must not survive in ciphertext");
    const round = decryptMfaSecret(ct, TEST_KEY);
    assert.deepEqual(round, secretBytes);
});

test("decryptMfaSecret rejects wrong key with MfaSecretEncryptionFailureError", () => {
    const ct = encryptMfaSecret(Buffer.from("1234567890", "utf8"), TEST_KEY);
    assert.throws(
        () => decryptMfaSecret(ct, WRONG_KEY),
        (err) => err instanceof MfaSecretEncryptionFailureError,
    );
});

test("decryptMfaSecret rejects tampered tag with MfaSecretEncryptionFailureError", () => {
    const ct = encryptMfaSecret(Buffer.from("1234567890", "utf8"), TEST_KEY);
    const tampered = { ...ct, tag: Buffer.alloc(16, 0).toString("base64") };
    assert.throws(
        () => decryptMfaSecret(tampered, TEST_KEY),
        (err) => err instanceof MfaSecretEncryptionFailureError,
    );
});

test("MFA secret encryption errors do not echo plaintext / key / ciphertext", () => {
    const secretMarker = Buffer.from("super-secret-mfa-marker-9999", "utf8");
    const ct = encryptMfaSecret(secretMarker, TEST_KEY);
    try {
        decryptMfaSecret(ct, WRONG_KEY);
        assert.fail("expected throw");
    } catch (err) {
        assert.ok(err instanceof MfaSecretEncryptionFailureError);
        const msg = String(err.message);
        // Plaintext must not appear.
        assert.ok(!msg.includes("super-secret-mfa-marker-9999"),
            `message leaks plaintext: ${msg}`);
        // Ciphertext base64 must not appear.
        assert.ok(!msg.includes(ct.ciphertext),
            `message leaks ciphertext: ${msg}`);
        // Key bytes (base64) must not appear.
        assert.ok(!msg.includes(TEST_KEY.toString("base64")),
            "message leaks key bytes");
    }
});

test("loadMfaSecretEncryptionKey rejects missing env", () => {
    assert.throws(
        () => loadMfaSecretEncryptionKey({}),
        (err) => err instanceof MfaSecretEncryptionConfigError &&
                 /MFA_SECRET_ENCRYPTION_KEY/.test(err.message),
    );
});

test("loadMfaSecretEncryptionKey rejects non-base64 input", () => {
    assert.throws(
        () => loadMfaSecretEncryptionKey({
            MFA_SECRET_ENCRYPTION_KEY: `${TEST_KEY_B64}!`,
        }),
        (err) => err instanceof MfaSecretEncryptionConfigError,
    );
});

test("loadMfaSecretEncryptionKey rejects wrong-length key (decoded ≠ 32 bytes)", () => {
    assert.throws(
        () => loadMfaSecretEncryptionKey({
            MFA_SECRET_ENCRYPTION_KEY: Buffer.from("short", "utf8").toString("base64"),
        }),
        (err) => err instanceof MfaSecretEncryptionConfigError,
    );
});

test("loadMfaSecretEncryptionKey accepts a valid 32-byte base64 key", () => {
    const key = loadMfaSecretEncryptionKey({
        MFA_SECRET_ENCRYPTION_KEY: TEST_KEY_B64,
    });
    assert.ok(Buffer.isBuffer(key));
    assert.equal(key.length, 32);
});

test("loadMfaSecretEncryptionKey ignores EMAIL_OUTBOX_ENCRYPTION_KEY (env separation)", () => {
    // Even with the email outbox key set, missing MFA_SECRET_ENCRYPTION_KEY
    // must fail — plan §2.4 explicitly forbids the two values from being
    // treated interchangeably.
    assert.throws(
        () => loadMfaSecretEncryptionKey({
            EMAIL_OUTBOX_ENCRYPTION_KEY: TEST_KEY_B64,
        }),
        (err) => err instanceof MfaSecretEncryptionConfigError,
    );
});

test("loadMfaSecretEncryptionKey error message does not echo attempted key value", () => {
    const sentinel = "sentinel-attempt-value-XXXXXX";
    try {
        loadMfaSecretEncryptionKey({
            MFA_SECRET_ENCRYPTION_KEY: Buffer.from(sentinel, "utf8").toString("base64"),
        });
        assert.fail("expected throw");
    } catch (err) {
        assert.ok(err instanceof MfaSecretEncryptionConfigError);
        assert.ok(!String(err.message).includes(sentinel),
            "config error must not echo attempted key value");
    }
});

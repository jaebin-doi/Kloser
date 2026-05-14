/* MFA secret encryption — Phase 7 Step 2.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_2_PLAN.md §2.4, §4.2.
 *
 * Wraps the raw TOTP secret bytes (20 bytes from `totp.generateTotpSecret()`)
 * with AES-256-GCM before they touch `users.mfa_secret_ciphertext`. The
 * shape mirrors `services/emailSensitivePayload.ts`, but the modules are
 * deliberately separated so:
 *
 *   - the two key materials never share a value (plan §2.4 explicitly
 *     forbids reusing `EMAIL_OUTBOX_ENCRYPTION_KEY`),
 *   - a future key rotation of one factor does not force a rotation of
 *     the other, and
 *   - the error classes are distinct so the auth login path's catch
 *     branches can distinguish MFA-side data damage from email-side data
 *     damage without parsing messages.
 *
 * Why Buffer-in / Buffer-out (not string): the TOTP secret is binary by
 * spec — the base32 form is for display only. Storing the base32 string
 * encrypted would just round-trip the encoding for free. Keeping the
 * encrypted form bound to the raw bytes also lets a future key version
 * decode + re-encrypt without re-deriving base32.
 *
 * Error policy:
 *   - Config errors describe the env var shape only; no key bytes / no
 *     ciphertext bytes / no plaintext bytes are ever included in the
 *     message.
 *   - Failure errors describe the failed step (auth tag mismatch, bad
 *     iv length) and nothing more. Per plan §2.4 these are NOT swallowed
 *     by the auth layer as "wrong code" — they surface as 5xx so an
 *     operator can investigate.
 */
import * as crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES  = 12;
const TAG_BYTES = 16;

export class MfaSecretEncryptionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MfaSecretEncryptionConfigError";
  }
}

export class MfaSecretEncryptionFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MfaSecretEncryptionFailureError";
  }
}

export interface MfaSecretCiphertext {
  ciphertext: string; // base64 of AES-GCM ciphertext
  iv:         string; // base64 of 12-byte nonce
  tag:        string; // base64 of 16-byte auth tag
}

// Load and validate the 32-byte key from env. Real MFA boot code calls
// this once at service start and caches the Buffer; missing/malformed
// env is fail-fast.
export function loadMfaSecretEncryptionKey(
  env: NodeJS.ProcessEnv = process.env,
): Buffer {
  const raw = env.MFA_SECRET_ENCRYPTION_KEY;
  if (!raw || raw.trim().length === 0) {
    throw new MfaSecretEncryptionConfigError(
      "MFA_SECRET_ENCRYPTION_KEY is required when MFA is enabled",
    );
  }
  const normalized = raw.trim();
  if (
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)
  ) {
    throw new MfaSecretEncryptionConfigError(
      "MFA_SECRET_ENCRYPTION_KEY must be a base64 string",
    );
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(normalized, "base64");
  } catch {
    throw new MfaSecretEncryptionConfigError(
      "MFA_SECRET_ENCRYPTION_KEY must be a base64 string",
    );
  }
  if (buf.length !== KEY_BYTES) {
    throw new MfaSecretEncryptionConfigError(
      `MFA_SECRET_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${buf.length})`,
    );
  }
  return buf;
}

export function encryptMfaSecret(
  plaintext: Buffer,
  key: Buffer,
): MfaSecretCiphertext {
  assertKey(key);
  if (!Buffer.isBuffer(plaintext)) {
    // Defensive — callers should always pass a Buffer. We don't echo
    // the offending value because we'd potentially log the secret.
    throw new MfaSecretEncryptionConfigError(
      "encryptMfaSecret: plaintext must be a Buffer",
    );
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ct  = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ct.toString("base64"),
    iv:         iv.toString("base64"),
    tag:        tag.toString("base64"),
  };
}

export function decryptMfaSecret(
  input: MfaSecretCiphertext,
  key: Buffer,
): Buffer {
  assertKey(key);

  let ct:  Buffer;
  let iv:  Buffer;
  let tag: Buffer;
  try {
    ct  = Buffer.from(input.ciphertext, "base64");
    iv  = Buffer.from(input.iv,         "base64");
    tag = Buffer.from(input.tag,        "base64");
  } catch {
    throw new MfaSecretEncryptionFailureError(
      "MFA secret ciphertext/iv/tag must be base64",
    );
  }
  if (iv.length !== IV_BYTES) {
    throw new MfaSecretEncryptionFailureError(
      `MFA secret iv must be ${IV_BYTES} bytes`,
    );
  }
  if (tag.length !== TAG_BYTES) {
    throw new MfaSecretEncryptionFailureError(
      `MFA secret auth tag must be ${TAG_BYTES} bytes`,
    );
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    // node's GCM final() throws on tag mismatch with a message that
    // varies by version. Coalesce into one stable, payload-free
    // surface so the auth layer can branch on the error class alone.
    throw new MfaSecretEncryptionFailureError(
      "MFA secret authentication failed",
    );
  }
}

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new MfaSecretEncryptionConfigError(
      `MFA secret encryption key must be a ${KEY_BYTES}-byte Buffer`,
    );
  }
}

/* Phase 7 Step 1 — encrypted sensitive payload for email_outbox.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_1_PLAN.md §2.2, §5.2.
 *
 * In real-provider mode (`EMAIL_PROVIDER=resend`) the raw verify / reset /
 * invite URL must NOT live in `email_outbox.body_text` or `metadata`. Those
 * archive fields stay redacted (`...?token=[redacted]`). The actual URL is
 * encrypted with AES-256-GCM and stored only in the
 * `sensitive_payload_{ciphertext,iv,tag,key_version}` columns until the
 * worker successfully delivers (or dead-letters) the row — at which point
 * the four columns are scrubbed to NULL by
 * `emailOutbox.scrubSensitivePayload()`.
 *
 * Key material:
 *   `EMAIL_OUTBOX_ENCRYPTION_KEY` — base64-encoded 32-byte key.
 *   Loaded once at boot when the real-provider path is selected; missing
 *   or malformed key is fail-fast (`EmailEncryptionConfigError`). The dev
 *   provider path never needs the key and never loads it.
 *
 * Error policy:
 *   - Config errors (`EmailEncryptionConfigError`) describe the env var
 *     shape but never include attempted key/ciphertext bytes.
 *   - Failure errors (`EmailEncryptionFailureError`) describe the failed
 *     step (auth tag mismatch, bad iv length, …) without echoing
 *     plaintext, ciphertext, or key bytes.
 *
 * This file ships no caller wiring. The follow-up commit (provider resolver
 * + QueuedEmailProvider) decides where to call `loadEmailOutboxEncryptionKey`
 * and `encryptEmailSensitivePayload`.
 */
import * as crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES  = 12;
const TAG_BYTES = 16;

export class EmailEncryptionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailEncryptionConfigError";
  }
}

export class EmailEncryptionFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailEncryptionFailureError";
  }
}

export interface EmailSensitiveCiphertext {
  ciphertext: string; // base64 of AES-GCM ciphertext
  iv:         string; // base64 of 12-byte nonce
  tag:        string; // base64 of 16-byte auth tag
}

// Load and validate the 32-byte key from env. Real-provider boot code
// calls this once and caches the Buffer. dev path never calls this — its
// outbox rows never set the sensitive_payload_* columns.
export function loadEmailOutboxEncryptionKey(
  env: NodeJS.ProcessEnv = process.env,
): Buffer {
  const raw = env.EMAIL_OUTBOX_ENCRYPTION_KEY;
  if (!raw || raw.trim().length === 0) {
    throw new EmailEncryptionConfigError(
      "EMAIL_OUTBOX_ENCRYPTION_KEY is required when EMAIL_PROVIDER selects a real provider",
    );
  }
  const normalized = raw.trim();
  if (
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)
  ) {
    throw new EmailEncryptionConfigError(
      "EMAIL_OUTBOX_ENCRYPTION_KEY must be a base64 string",
    );
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(normalized, "base64");
  } catch {
    throw new EmailEncryptionConfigError(
      "EMAIL_OUTBOX_ENCRYPTION_KEY must be a base64 string",
    );
  }
  if (buf.length !== KEY_BYTES) {
    throw new EmailEncryptionConfigError(
      `EMAIL_OUTBOX_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${buf.length})`,
    );
  }
  return buf;
}

export function encryptEmailSensitivePayload(
  plaintext: string,
  key: Buffer,
): EmailSensitiveCiphertext {
  assertKey(key);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ct  = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ct.toString("base64"),
    iv:         iv.toString("base64"),
    tag:        tag.toString("base64"),
  };
}

export function decryptEmailSensitivePayload(
  input: EmailSensitiveCiphertext,
  key: Buffer,
): string {
  assertKey(key);

  let ct:  Buffer;
  let iv:  Buffer;
  let tag: Buffer;
  try {
    ct  = Buffer.from(input.ciphertext, "base64");
    iv  = Buffer.from(input.iv,         "base64");
    tag = Buffer.from(input.tag,        "base64");
  } catch {
    throw new EmailEncryptionFailureError(
      "sensitive payload ciphertext/iv/tag must be base64",
    );
  }
  if (iv.length !== IV_BYTES) {
    throw new EmailEncryptionFailureError(
      `sensitive payload iv must be ${IV_BYTES} bytes`,
    );
  }
  if (tag.length !== TAG_BYTES) {
    throw new EmailEncryptionFailureError(
      `sensitive payload auth tag must be ${TAG_BYTES} bytes`,
    );
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  try {
    const out = Buffer.concat([decipher.update(ct), decipher.final()]);
    return out.toString("utf8");
  } catch {
    // node's GCM final() throws on tag mismatch. Treat any cipher error
    // the same way — we never echo the underlying message because it
    // may include byte-level hints about the payload.
    throw new EmailEncryptionFailureError(
      "sensitive payload authentication failed",
    );
  }
}

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new EmailEncryptionConfigError(
      `email outbox encryption key must be a ${KEY_BYTES}-byte Buffer`,
    );
  }
}

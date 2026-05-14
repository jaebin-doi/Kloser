/* TOTP service — Phase 7 Step 2.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_2_PLAN.md §2.1, §4.1.
 *
 * Implements TOTP (RFC 6238) over HOTP (RFC 4226) for the MFA-first-step
 * flow. Constants are pinned to the plan-mandated shape:
 *
 *   period: 30 seconds
 *   digits: 6
 *   algorithm: SHA-1
 *   drift window for verify: ±1 step (current, previous, next)
 *
 * Secrets are 20 random bytes per RFC recommendation; that maps to a
 * 32-character base32 string with no padding (20 bytes = 160 bits =
 * 32 * 5 bits), which is exactly what authenticator apps expect when the
 * user types the secret manually from the otpauth URI.
 *
 * No third-party dependency. Node `crypto.createHmac('sha1', ...)`,
 * `crypto.randomBytes()`, and `crypto.timingSafeEqual()` cover the full
 * surface. A dedicated `otplib`-style library would bring nicer ergonomics
 * but plan §2.1 prefers staying dependency-free.
 *
 * Error policy: this module does NOT throw on a wrong code — it returns
 * `false`. Throwing would conflate user mistake (wrong digits) with
 * server-side misconfig (bad secret encoding), which the service layer
 * needs to keep separate for correct response codes. `base32Decode` does
 * throw for malformed input because that genuinely indicates a programmer
 * bug (we generated the secret here too) or DB corruption — not a
 * user-visible auth failure.
 */
import * as crypto from "node:crypto";

const PERIOD_SECONDS = 30;
const DIGITS         = 6;
const DRIFT_STEPS    = 1; // verify accepts [-1, 0, +1]

// RFC 4648 base32 alphabet. Authenticator apps (Google Authenticator,
// Authy, 1Password, etc.) all use this exact alphabet — no extended /
// lowercase / Crockford variants.
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// ---------------------------------------------------------------------------
// Base32 (RFC 4648)
// ---------------------------------------------------------------------------

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  // Pad to a multiple of 8 chars per RFC 4648. For 20-byte input the
  // result is already a multiple of 8 (32 chars) so no padding is added;
  // we keep the branch so encode() round-trips arbitrary byte buffers
  // through the decoder cleanly.
  while (out.length % 8 !== 0) out += "=";
  return out;
}

export function base32Decode(s: string): Buffer {
  // Strip pad chars + whitespace (some authenticator UIs insert space
  // separators every 4 chars when showing a secret) and normalise case.
  const stripped = s.replace(/=+$/g, "").replace(/\s+/g, "").toUpperCase();
  if (stripped.length === 0) {
    throw new Error("base32Decode: empty input");
  }
  if (!/^[A-Z2-7]+$/.test(stripped)) {
    // Don't echo the offending character or position — we'd be writing
    // the secret straight into a log line.
    throw new Error("base32Decode: invalid base32 character");
  }
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of stripped) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    // idx === -1 already eliminated by the regex above, but the
    // defensive guard stays so a future regex tweak can't silently
    // skip an unknown char.
    if (idx === -1) {
      throw new Error("base32Decode: invalid base32 character");
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------
// Secret + otpauth URI
// ---------------------------------------------------------------------------

export interface TotpSecret {
  raw: Buffer;       // 20 bytes — what the encryption layer stores
  base32: string;    // 32 chars — what the user sees / scans
}

export function generateTotpSecret(): TotpSecret {
  const raw = crypto.randomBytes(20);
  return { raw, base32: base32Encode(raw) };
}

export interface OtpauthUriInput {
  issuer: string;       // e.g. "Kloser"
  accountEmail: string; // user email shown in the authenticator entry
  secretBase32: string; // from generateTotpSecret().base32
}

// otpauth://totp/<issuer>:<account>?secret=...&issuer=...&digits=6&period=30&algorithm=SHA1
//
// Both <issuer> and <account> appear in the path label as a single
// URI-encoded token separated by ':'. Authenticator apps display the
// label verbatim, so a stray reserved char (like ':' inside the
// accountEmail) would break parsing. We encode both halves.
export function buildOtpauthUri(input: OtpauthUriInput): string {
  const label =
    encodeURIComponent(input.issuer) +
    ":" +
    encodeURIComponent(input.accountEmail);
  const params = new URLSearchParams({
    secret: input.secretBase32,
    issuer: input.issuer,
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
    algorithm: "SHA1",
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// HOTP / TOTP core
// ---------------------------------------------------------------------------

// HOTP (RFC 4226 §5.3): HMAC-SHA1(K, counter) → dynamic-truncate → modulo.
// Exported for tests so a known counter vector can be checked directly
// without relying on `Date.now()`.
export function hotp(secret: Buffer, counter: bigint): string {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(counter, 0);
  const hash = crypto.createHmac("sha1", secret).update(counterBuf).digest();
  // dynamic truncation per RFC 4226 §5.4
  const offset = hash[hash.length - 1]! & 0x0f;
  const binary =
    ((hash[offset]!     & 0x7f) << 24) |
    ((hash[offset + 1]! & 0xff) << 16) |
    ((hash[offset + 2]! & 0xff) <<  8) |
     (hash[offset + 3]! & 0xff);
  const otp = binary % 10 ** DIGITS;
  return String(otp).padStart(DIGITS, "0");
}

function counterAt(now: Date): bigint {
  // floor(unix_seconds / 30). Date.getTime() is ms.
  return BigInt(Math.floor(now.getTime() / 1000 / PERIOD_SECONDS));
}

// Render the current TOTP for a given secret. Exported for tests and for
// any future "rotate secret -> compute expected code internally" flow.
// Production verify code paths must use `verifyTotp` so the drift window
// and timing-safe compare are applied.
export function generateTotp(opts: { secretBase32: string; now?: Date }): string {
  const secret = base32Decode(opts.secretBase32);
  return hotp(secret, counterAt(opts.now ?? new Date()));
}

// Timing-safe compare of two ASCII digit strings. Both inputs are
// fixed-length 6 chars, so length disclosure is a non-issue. We still
// short-circuit on length mismatch so we can be called with arbitrary
// user input.
function constantTimeEqualDigits(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return crypto.timingSafeEqual(ab, bb);
}

export interface VerifyTotpInput {
  secretBase32: string;
  code: string;        // exactly 6 ASCII digits — caller must not pre-parse
  now?: Date;          // injectable for tests; production passes undefined
}

// Verify a candidate 6-digit code against the secret across the drift
// window [-1, +1]. Returns false on any malformed input (wrong length,
// non-digit chars, leading whitespace) so callers can treat the boolean
// as the user-visible decision. Decoder errors (bad base32 in the
// stored secret) bubble up — that is a server-side data integrity
// problem, not a user-visible auth failure.
export function verifyTotp(input: VerifyTotpInput): boolean {
  // Strict shape: exactly 6 decimal digits. Leading zeroes are valid
  // (e.g. "005924" in RFC test vectors).
  if (typeof input.code !== "string" || !/^\d{6}$/.test(input.code)) {
    return false;
  }
  const secret = base32Decode(input.secretBase32);
  const center = counterAt(input.now ?? new Date());
  // Iterate the three drift steps and constant-time compare each. We
  // don't short-circuit on first match because that would leak the
  // step index via timing — every verify call computes all three
  // candidates and compares them all.
  let matched = false;
  for (let i = -DRIFT_STEPS; i <= DRIFT_STEPS; i++) {
    const expected = hotp(secret, center + BigInt(i));
    if (constantTimeEqualDigits(input.code, expected)) {
      matched = true;
    }
  }
  return matched;
}

// Exported constants so tests + future service code can reference the
// same numbers without re-deriving them from the algorithm.
export const TOTP_PERIOD_SECONDS = PERIOD_SECONDS;
export const TOTP_DIGITS         = DIGITS;
export const TOTP_DRIFT_STEPS    = DRIFT_STEPS;

/* Token lifecycle helpers for email_verification / password_reset / invitation.
 *
 * Phase 3 Step 2. Plan: docs/plan/phase-3/PHASE_3_STEP_2_SIGNUP_VERIFY.md §3.
 *
 * Single auth_tokens table, three purposes. sha256(raw) is stored; raw lives
 * only at mint time (returned to the caller for embedding in an email body).
 *
 * All three functions take a PoolClient — they never open their own
 * transaction. The caller (signup, verify wrapper, invite-create, etc.) owns
 * the transaction boundary. This is what makes /auth/verify safe: the verify
 * wrapper opens one servicePool transaction, runs consumeToken + the user
 * UPDATE, and commits/rolls back as a unit. See plan §2.6.
 *
 * AuthError is reused from services/auth.ts so the route layer's existing
 * AuthError catch path handles these the same way as login errors.
 */
import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { AuthError } from "./auth.js";

export type TokenPurpose =
  | "email_verification"
  | "password_reset"
  | "invitation";

export interface MintTokenInput {
  client: PoolClient;
  orgId: string;
  userId?: string | null;
  invitationId?: string | null;
  purpose: TokenPurpose;
  ttlMs: number;
}

export interface MintTokenResult {
  rawToken: string;            // returned to caller; never stored
  tokenId: string;             // auth_tokens.id
  expiresAt: Date;
}

export interface InvalidateActiveTokensInput {
  client: PoolClient;
  userId: string;
  purpose: TokenPurpose;
}

export interface ConsumedToken {
  id: string;
  orgId: string;
  userId: string | null;
  invitationId: string | null;
}

// ---------------------------------------------------------------------------
// Raw / hash helpers
// ---------------------------------------------------------------------------

/** 32 random bytes → URL-safe base64 → 43 chars. URL-safe so it embeds in
 *  query params without escaping. Phase 1 refresh tokens follow the same
 *  shape (services/auth.ts:createRefreshToken). */
function createRawToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** sha256 hex, 64 chars. Matches Phase 1's hashRefreshToken format so a
 *  future auditor sees one hashing convention across all bearer tokens. */
export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

// ---------------------------------------------------------------------------
// mintToken
// ---------------------------------------------------------------------------

export async function mintToken(input: MintTokenInput): Promise<MintTokenResult> {
  const rawToken = createRawToken();
  const tokenHash = sha256Hex(rawToken);
  const expiresAt = new Date(Date.now() + input.ttlMs);

  const r = await input.client.query<{ id: string; expires_at: Date }>(
    `INSERT INTO auth_tokens (org_id, user_id, invitation_id, purpose,
                              token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, expires_at`,
    [
      input.orgId,
      input.userId ?? null,
      input.invitationId ?? null,
      input.purpose,
      tokenHash,
      expiresAt,
    ],
  );

  const row = r.rows[0]!;
  return { rawToken, tokenId: row.id, expiresAt: row.expires_at };
}

// ---------------------------------------------------------------------------
// invalidateActiveTokens
// ---------------------------------------------------------------------------

/** Marks every active (purpose, user_id) token as invalidated. Resend flows
 *  call this immediately before mintToken so the UNIQUE partial index
 *  (auth_tokens_user_purpose_active_idx) admits the new row.
 *
 *  Returns the count of rows touched — typically 0 or 1, but the SQL
 *  applies to all matches to defend against any historical drift. */
export async function invalidateActiveTokens(
  input: InvalidateActiveTokensInput,
): Promise<number> {
  const r = await input.client.query(
    `UPDATE auth_tokens
        SET invalidated_at = now()
      WHERE user_id        = $1
        AND purpose        = $2
        AND consumed_at    IS NULL
        AND invalidated_at IS NULL`,
    [input.userId, input.purpose],
  );
  return r.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// consumeToken
// ---------------------------------------------------------------------------

/** Looks up a token by sha256(raw) + purpose, validates state, and marks it
 *  consumed in one round-trip. NEVER opens its own transaction — the caller
 *  passes a PoolClient that already has BEGIN, and consume happens within
 *  that same transaction so the caller's downstream UPDATE (e.g. users
 *  email_verified_at) is atomic with consume.
 *
 *  Throws distinct AuthError codes so tests can assert reason. The route
 *  layer collapses all four into a single 410 generic response — see
 *  routes/auth.ts and plan §7. */
export async function consumeToken(
  client: PoolClient,
  rawToken: string,
  purpose: TokenPurpose,
): Promise<ConsumedToken> {
  const tokenHash = sha256Hex(rawToken);

  const r = await client.query<{
    id: string;
    org_id: string;
    user_id: string | null;
    invitation_id: string | null;
    expires_at: Date;
    consumed_at: Date | null;
    invalidated_at: Date | null;
  }>(
    `SELECT id, org_id, user_id, invitation_id, expires_at,
            consumed_at, invalidated_at
       FROM auth_tokens
      WHERE token_hash = $1
        AND purpose    = $2
      FOR UPDATE`,
    [tokenHash, purpose],
  );

  if (r.rows.length === 0) {
    throw new AuthError(404, "token_not_found", "token not found");
  }
  const row = r.rows[0]!;
  if (row.consumed_at) {
    throw new AuthError(410, "token_already_used", "token already used");
  }
  if (row.invalidated_at) {
    throw new AuthError(410, "token_invalidated", "token invalidated");
  }
  if (row.expires_at < new Date()) {
    throw new AuthError(410, "token_expired", "token expired");
  }

  await client.query(
    `UPDATE auth_tokens SET consumed_at = now() WHERE id = $1`,
    [row.id],
  );

  return {
    id: row.id,
    orgId: row.org_id,
    userId: row.user_id,
    invitationId: row.invitation_id,
  };
}

// ---------------------------------------------------------------------------
// Split helpers for invitation accept (Phase 3 Step 5)
// ---------------------------------------------------------------------------
//
// acceptInvitation needs the lock and the UPDATE separated so the mark
// (`consumed_at = now()`) only happens on the happy path. Mid-flow 409s
// (account_disabled / already_member) ROLLBACK the whole tx, leaving the
// token untouched — so retrying the same token yields the same 409 until
// the underlying condition is resolved. See plan §6.1.
//
// Lock order across all invitation flows is `invitations → auth_tokens`
// (cancel/resend serialize the same way). accept therefore reads the
// token row WITHOUT a lock first to discover invitation_id, locks the
// invitation row, and only then locks + validates the token row.
//
// verifyEmail / resetPassword keep using `consumeToken` (no post-consume
// 409 branches → simpler atomic helper is fine).

export interface RawTokenLookup {
  tokenId: string;
  invitationId: string | null;
  userId: string | null;
  orgId: string;
}

/** Read an auth_tokens row by sha256(raw) + purpose without any locking.
 *  Returns the row identifiers used by acceptInvitation to lock the
 *  invitation row first (lock order: invitations → auth_tokens). Returns
 *  null if no row matches — the caller decides whether to throw 410
 *  (token_not_found) or treat as silent no-op (Step 3 forgot uses neither
 *  — it owns its own lookup). */
export async function findTokenByRaw(
  client: PoolClient,
  rawToken: string,
  purpose: TokenPurpose,
): Promise<RawTokenLookup | null> {
  const tokenHash = sha256Hex(rawToken);
  const r = await client.query<{
    id: string;
    org_id: string;
    user_id: string | null;
    invitation_id: string | null;
  }>(
    `SELECT id, org_id, user_id, invitation_id
       FROM auth_tokens
      WHERE token_hash = $1
        AND purpose    = $2`,
    [tokenHash, purpose],
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0]!;
  return {
    tokenId: row.id,
    invitationId: row.invitation_id,
    userId: row.user_id,
    orgId: row.org_id,
  };
}

/** SELECT … FOR UPDATE on an auth_tokens row by id, plus validity check
 *  (consumed_at / invalidated_at / expires_at). Throws the same AuthError
 *  codes as consumeToken so sendTokenError can collapse them to 410.
 *  Does NOT update consumed_at — that's markTokenConsumed at the end. */
export async function lockAndValidateTokenById(
  client: PoolClient,
  tokenId: string,
  purpose: TokenPurpose,
): Promise<void> {
  const r = await client.query<{
    expires_at: Date;
    consumed_at: Date | null;
    invalidated_at: Date | null;
  }>(
    `SELECT expires_at, consumed_at, invalidated_at
       FROM auth_tokens
      WHERE id      = $1
        AND purpose = $2
      FOR UPDATE`,
    [tokenId, purpose],
  );
  if (r.rows.length === 0) {
    // findTokenByRaw said the row existed but it's now gone — extremely
    // narrow race (the row's referenced invitation was deleted between
    // the two queries, cascading the token away). Surface as not_found.
    throw new AuthError(404, "token_not_found", "token not found");
  }
  const row = r.rows[0]!;
  if (row.consumed_at) {
    throw new AuthError(410, "token_already_used", "token already used");
  }
  if (row.invalidated_at) {
    throw new AuthError(410, "token_invalidated", "token invalidated");
  }
  if (row.expires_at < new Date()) {
    throw new AuthError(410, "token_expired", "token expired");
  }
}

/** Set consumed_at = now() on a token already locked by
 *  lockAndValidateTokenById. Called as the final mutation in
 *  acceptInvitation's happy path so a mid-flow throw + ROLLBACK leaves
 *  the token untouched (retry yields the same 409 until the underlying
 *  condition is resolved). */
export async function markTokenConsumed(
  client: PoolClient,
  tokenId: string,
): Promise<void> {
  await client.query(
    `UPDATE auth_tokens SET consumed_at = now() WHERE id = $1`,
    [tokenId],
  );
}

// ---------------------------------------------------------------------------
// TTL constants (per Master §2-5/6/7)
// ---------------------------------------------------------------------------

export const TTL_EMAIL_VERIFICATION_MS = 24 * 60 * 60 * 1000;       // 24h
export const TTL_PASSWORD_RESET_MS     = 1 * 60 * 60 * 1000;        // 1h
export const TTL_INVITATION_MS         = 7 * 24 * 60 * 60 * 1000;   // 7d

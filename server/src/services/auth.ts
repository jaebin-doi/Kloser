import crypto from "node:crypto";
import argon2 from "argon2";
import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";
import { getServicePool } from "../db/servicePool.js";
import { authEnv } from "../config/authEnv.js";
import type { MembershipRole } from "../repositories/memberships.js";
import {
  createUserWithPasswordHash,
  getByEmailWithPasswordHash,
  toPublicAuthUser,
  type PublicAuthUser,
} from "../repositories/authUsers.js";
import {
  createSession,
  findByRefreshTokenHashForUpdate,
  getByIdForUpdate,
  markMfaVerified,
  revokeSession,
  revokeTokenFamily,
  touchLastUsed,
  type AuthSession,
} from "../repositories/sessions.js";
import {
  consumeToken,
  findTokenByRaw,
  invalidateActiveTokens,
  lockAndValidateTokenById,
  markTokenConsumed,
  mintToken,
  TTL_EMAIL_VERIFICATION_MS,
  TTL_MFA_CHALLENGE_MS,
  TTL_PASSWORD_RESET_MS,
} from "./auth-tokens.js";
import {
  buildResetUrl,
  buildVerifyUrl,
  emailProvider,
} from "./email.js";
import * as mfaUsers from "../repositories/mfaUsers.js";
import {
  decryptMfaSecret,
  encryptMfaSecret,
  loadMfaSecretEncryptionKey,
  MfaSecretEncryptionConfigError,
  MfaSecretEncryptionFailureError,
} from "./mfaSecretEncryption.js";
import {
  base32Encode,
  buildOtpauthUri,
  generateTotpSecret,
  verifyTotp,
} from "./totp.js";
import {
  recordActivity,
  recordMfaDisabled,
  recordMfaEnabled,
} from "./activityLog.js";

export interface AccessTokenPayload {
  sub: string;
  orgId: string;
  membershipId: string;
  role: MembershipRole;
  sid: string;
}

export interface AuthenticatedUser {
  id: string;
  orgId: string;
  membershipId: string;
  role: MembershipRole;
  sessionId: string;
}

export interface AuthOrganization {
  id: string;
  name: string;
  plan: string;
}

export interface AuthMembership {
  id: string;
  org_id: string;
  user_id: string;
  role: MembershipRole;
  status: string;
}

export interface AvailableOrg {
  id: string;
  name: string;
  role: MembershipRole;
}

export interface AuthResult {
  user: PublicAuthUser;
  organization: AuthOrganization;
  membership: AuthMembership;
  session: AuthSession;
  accessPayload: AccessTokenPayload;
  refreshToken: string;
}

export interface RefreshResult {
  session: AuthSession;
  accessPayload: AccessTokenPayload;
  refreshToken?: string;
}

// Phase 7 Step 2 — `login()` no longer always returns a session. When MFA
// is required for the resolved org/user, the service mints an
// `mfa_challenge` auth token and returns the challenge-only branches. The
// route layer turns those into a 202 response with no access token and
// no refresh cookie. Plan §2.2 / §2.3.
//
// `challengeToken` is the raw bearer the client must echo back to
// /auth/mfa/totp/verify-login. It is response-only — DB stores only
// sha256(rawToken) on auth_tokens.token_hash.
export type LoginMfaMethod = "totp";

export type LoginResult =
  | { kind: "authenticated"; auth: AuthResult }
  | {
      kind: "mfa_required";
      challengeToken: string;
      method: LoginMfaMethod;
      expiresAt: Date;
    }
  | {
      kind: "mfa_setup_required";
      challengeToken: string;
      expiresAt: Date;
    };

export class AuthError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

class CommitAuthError extends AuthError {}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ROLE_SET = new Set<MembershipRole>([
  "admin",
  "manager",
  "employee",
  "viewer",
]);

export function isMembershipRole(value: unknown): value is MembershipRole {
  return typeof value === "string" && ROLE_SET.has(value as MembershipRole);
}

export function validateAccessTokenPayload(
  payload: unknown,
): AccessTokenPayload {
  if (!payload || typeof payload !== "object") {
    throw new AuthError(401, "invalid_token", "invalid access token");
  }

  const p = payload as Record<string, unknown>;
  const sub = p.sub;
  const orgId = p.orgId;
  const membershipId = p.membershipId;
  const sid = p.sid;
  const role = p.role;

  if (
    typeof sub !== "string" ||
    typeof orgId !== "string" ||
    typeof membershipId !== "string" ||
    typeof sid !== "string" ||
    !UUID_RE.test(sub) ||
    !UUID_RE.test(orgId) ||
    !UUID_RE.test(membershipId) ||
    !UUID_RE.test(sid) ||
    !isMembershipRole(role)
  ) {
    throw new AuthError(401, "invalid_token", "invalid access token");
  }

  return { sub, orgId, membershipId, role, sid };
}

export function toAuthenticatedUser(
  payload: AccessTokenPayload,
): AuthenticatedUser {
  return {
    id: payload.sub,
    orgId: payload.orgId,
    membershipId: payload.membershipId,
    role: payload.role,
    sessionId: payload.sid,
  };
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(
  hash: string,
  password: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function createRefreshToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashRefreshToken(refreshToken: string): string {
  return crypto.createHash("sha256").update(refreshToken).digest("hex");
}

function ttlToDate(ttl: string, from = new Date()): Date {
  const m = /^(\d+)([smhd])$/.exec(ttl.trim());
  if (!m) {
    throw new Error(`Unsupported TTL format: ${ttl}`);
  }
  const amount = Number.parseInt(m[1]!, 10);
  const unit = m[2]!;
  const ms =
    unit === "s" ? amount * 1000 :
    unit === "m" ? amount * 60 * 1000 :
    unit === "h" ? amount * 60 * 60 * 1000 :
    amount * 24 * 60 * 60 * 1000;
  return new Date(from.getTime() + ms);
}

function refreshExpiresAt(): Date {
  return ttlToDate(authEnv.refreshTokenTtl);
}

async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    client.release();
    return result;
  } catch (err) {
    if (err instanceof CommitAuthError) {
      await client.query("COMMIT");
      client.release();
      throw err;
    }
    try {
      await client.query("ROLLBACK");
      client.release();
    } catch (rollbackErr) {
      client.release(rollbackErr as Error);
    }
    throw err;
  }
}

async function setOrgContext(client: PoolClient, orgId: string): Promise<void> {
  await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
}

async function getActiveMembershipInCurrentOrg(
  client: PoolClient,
  input: { userId: string; orgId: string },
): Promise<{ membership: AuthMembership; organization: AuthOrganization } | null> {
  const r = await client.query<AuthMembership & {
    organization_name: string;
    organization_plan: string;
  }>(
    `SELECT m.id, m.org_id, m.user_id, m.role, m.status,
            o.name AS organization_name, o.plan AS organization_plan
       FROM memberships m
       JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = $1
        AND m.org_id = $2
        AND m.status = 'active'`,
    [input.userId, input.orgId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    membership: {
      id: row.id,
      org_id: row.org_id,
      user_id: row.user_id,
      role: row.role,
      status: row.status,
    },
    organization: {
      id: row.org_id,
      name: row.organization_name,
      plan: row.organization_plan,
    },
  };
}

// Exported so Phase 3 Step 3 (password reset) can pick an org for an
// otherwise-unauthenticated user without re-implementing the RLS-safe org
// probe. The function sets the GUC on `client` as a side effect (last loop
// iteration's setOrgContext lingers) — callers that care must reset it.
export async function listActiveMembershipsAcrossOrgs(
  client: PoolClient,
  userId: string,
): Promise<Array<{ membership: AuthMembership; organization: AuthOrganization }>> {
  // Login happens before an org context exists. Because memberships is
  // RLS-scoped, we probe each org under its own SET LOCAL context instead of
  // doing an unscoped membership query.
  const orgs = await client.query<AuthOrganization>(
    "SELECT id, name, plan FROM organizations ORDER BY created_at",
  );
  const results: Array<{
    membership: AuthMembership;
    organization: AuthOrganization;
  }> = [];

  for (const org of orgs.rows) {
    await setOrgContext(client, org.id);
    const found = await getActiveMembershipInCurrentOrg(client, {
      userId,
      orgId: org.id,
    });
    if (found) results.push(found);
  }

  return results;
}

async function resolveMembershipForLogin(
  client: PoolClient,
  input: { userId: string; orgId?: string },
): Promise<{ membership: AuthMembership; organization: AuthOrganization }> {
  if (input.orgId) {
    if (!UUID_RE.test(input.orgId)) {
      throw new AuthError(401, "invalid_credentials", "invalid credentials");
    }
    await setOrgContext(client, input.orgId);
    const found = await getActiveMembershipInCurrentOrg(client, {
      userId: input.userId,
      orgId: input.orgId,
    });
    if (!found) {
      throw new AuthError(401, "invalid_credentials", "invalid credentials");
    }
    return found;
  }

  const memberships = await listActiveMembershipsAcrossOrgs(client, input.userId);
  if (memberships.length === 0) {
    // user existed + password verified + no active membership in any org =
    // every per-org membership disabled. Phase 3 Step 4 surfaces this as
    // a distinct code so the client can show "your account has been
    // deactivated" instead of "wrong credentials". The trade-off (email
    // existence leaked when the password is correct) is the intentional
    // policy in PHASE_3_MASTER.md §11 / Step 4 plan §1-8.
    //
    // The explicit-orgId branch above keeps `invalid_credentials` so a
    // wrong orgId guess never reveals which orgs the user does belong to.
    throw new AuthError(401, "account_disabled", "account is disabled");
  }
  if (memberships.length > 1) {
    const availableOrgs: AvailableOrg[] = memberships.map((m) => ({
      id: m.organization.id,
      name: m.organization.name,
      role: m.membership.role,
    }));
    throw new AuthError(
      400,
      "org_id_required",
      "orgId required",
      { availableOrgs },
    );
  }
  return memberships[0]!;
}

export function buildAccessPayload(
  session: AuthSession,
  role: MembershipRole,
): AccessTokenPayload {
  return {
    sub: session.user_id,
    orgId: session.org_id,
    membershipId: session.membership_id,
    role,
    sid: session.id,
  };
}

async function getSessionMembershipRole(
  client: PoolClient,
  session: AuthSession,
): Promise<MembershipRole> {
  await setOrgContext(client, session.org_id);
  const found = await getActiveMembershipInCurrentOrg(client, {
    userId: session.user_id,
    orgId: session.org_id,
  });
  if (!found || found.membership.id !== session.membership_id) {
    throw new AuthError(401, "invalid_session", "invalid session");
  }
  return found.membership.role;
}

export async function createSessionWithToken(
  client: PoolClient,
  input: {
    userId: string;
    orgId: string;
    membershipId: string;
    userAgent?: string | null;
    ip?: string | null;
    tokenFamilyId?: string;
    // Phase 7 Step 2 — verify-login passes both fields after a
    // successful TOTP check; refresh rotation copies them from the
    // leased session into its replacement. The sessions repository
    // (createSession) enforces both-or-neither at the boundary, so
    // forwarding either alone here would throw — by design.
    mfaVerifiedAt?: Date | null;
    mfaMethod?: "totp" | "webauthn" | "recovery_code" | null;
  },
): Promise<{ session: AuthSession; refreshToken: string }> {
  const refreshToken = createRefreshToken();
  const session = await createSession(client, {
    userId: input.userId,
    orgId: input.orgId,
    membershipId: input.membershipId,
    refreshTokenHash: hashRefreshToken(refreshToken),
    expiresAt: refreshExpiresAt(),
    userAgent: input.userAgent,
    ip: input.ip,
    tokenFamilyId: input.tokenFamilyId,
    mfaVerifiedAt: input.mfaVerifiedAt,
    mfaMethod: input.mfaMethod,
  });
  return { session, refreshToken };
}

export async function signup(input: {
  organizationName: string;
  name: string;
  email: string;
  password: string;
  userAgent?: string | null;
  ip?: string | null;
}): Promise<AuthResult> {
  return withTransaction(async (client) => {
    const passwordHash = await hashPassword(input.password);

    const org = await client.query<AuthOrganization>(
      `INSERT INTO organizations (name, plan)
       VALUES ($1, 'starter')
       RETURNING id, name, plan`,
      [input.organizationName],
    );

    let user;
    try {
      user = await createUserWithPasswordHash(client, {
        email: input.email,
        name: input.name,
        passwordHash,
      });
    } catch (err) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        err.code === "23505"
      ) {
        throw new AuthError(409, "email_conflict", "email already exists");
      }
      throw err;
    }

    const organization = org.rows[0]!;
    await setOrgContext(client, organization.id);
    const membershipResult = await client.query<AuthMembership>(
      `INSERT INTO memberships (org_id, user_id, role)
       VALUES ($1, $2, 'admin')
       RETURNING id, org_id, user_id, role, status`,
      [organization.id, user.id],
    );
    const membership = membershipResult.rows[0]!;

    // Mint the email-verification token + write its outbox row in the same
    // transaction as the org/user/membership inserts. If anything throws
    // between here and COMMIT, all six writes roll back together — no row
    // in email_outbox can point at a user that doesn't exist.
    const verification = await mintToken({
      client,
      orgId:    organization.id,
      userId:   user.id,
      purpose:  "email_verification",
      ttlMs:    TTL_EMAIL_VERIFICATION_MS,
    });
    await emailProvider.sendVerificationEmail({
      client,
      orgId:     organization.id,
      toEmail:   user.email,
      toName:    user.name,
      verifyUrl: buildVerifyUrl(verification.rawToken),
      rawToken:  verification.rawToken,
    });

    const { session, refreshToken } = await createSessionWithToken(client, {
      userId: user.id,
      orgId: organization.id,
      membershipId: membership.id,
      userAgent: input.userAgent,
      ip: input.ip,
    });

    return {
      user: toPublicAuthUser(user),
      organization,
      membership,
      session,
      accessPayload: buildAccessPayload(session, membership.role),
      refreshToken,
    };
  });
}

// ---------------------------------------------------------------------------
// Email verification (Phase 3 Step 2)
// ---------------------------------------------------------------------------

/** Anonymous /auth/verify flow.
 *
 * Owns ONE servicePool transaction so consumeToken + the users update are
 * atomic: a successfully consumed token always corresponds to a verified
 * user, and a thrown error rolls both back. Plan §2.6.
 *
 * Throws AuthError(404 'token_not_found' | 410 token_already_used |
 * token_invalidated | token_expired) — the route layer collapses all four
 * to a single generic 410 response. */
export async function verifyEmail(rawToken: string): Promise<void> {
  const client = await getServicePool().connect();
  try {
    await client.query("BEGIN");
    const consumed = await consumeToken(client, rawToken, "email_verification");
    if (!consumed.userId) {
      // CHECK auth_tokens_invitation_purpose_check guarantees non-invitation
      // purposes have user_id NOT NULL. Defensive — should be unreachable.
      throw new AuthError(500, "verify_internal_inconsistency",
        "verification token missing user_id");
    }
    await client.query(
      `UPDATE users SET email_verified_at = now() WHERE id = $1`,
      [consumed.userId],
    );
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      client.release(rollbackErr as Error);
      throw err;
    }
    client.release();
    throw err;
  }
  client.release();
}

/** Authenticated /auth/verify/resend flow.
 *
 * Uses the regular app pool because the caller is authenticated — JWT
 * gives us the user/org context. Invalidates the user's currently active
 * verification token (if any) and mints a fresh one, then writes a new
 * outbox row. Already-verified users get a 409 rather than spam.
 *
 * Throws AuthError(409 'already_verified') if the user has email_verified_at
 * set; the route layer surfaces the code unchanged. */
export async function resendVerificationEmail(input: {
  userId: string;
  orgId: string;
}): Promise<void> {
  await withTransaction(async (client) => {
    await setOrgContext(client, input.orgId);

    // Re-read the user inside the transaction so an already-verified state
    // race (e.g. user verified in another tab) is detected with FOR UPDATE.
    const userResult = await client.query<{
      email: string;
      name: string;
      email_verified_at: Date | null;
    }>(
      `SELECT email, name, email_verified_at
         FROM users
        WHERE id = $1
        FOR UPDATE`,
      [input.userId],
    );
    const userRow = userResult.rows[0];
    if (!userRow) {
      throw new AuthError(404, "user_not_found", "user not found");
    }
    if (userRow.email_verified_at) {
      throw new AuthError(409, "already_verified", "email already verified");
    }

    await invalidateActiveTokens({
      client,
      userId:  input.userId,
      purpose: "email_verification",
    });
    const fresh = await mintToken({
      client,
      orgId:   input.orgId,
      userId:  input.userId,
      purpose: "email_verification",
      ttlMs:   TTL_EMAIL_VERIFICATION_MS,
    });
    await emailProvider.sendVerificationEmail({
      client,
      orgId:     input.orgId,
      toEmail:   userRow.email,
      toName:    userRow.name,
      verifyUrl: buildVerifyUrl(fresh.rawToken),
      rawToken:  fresh.rawToken,
    });
  });
}

// ---------------------------------------------------------------------------
// Password reset (Phase 3 Step 3)
// ---------------------------------------------------------------------------

/** Anonymous /auth/password/forgot flow.
 *
 * App pool, single transaction. Resolves silently in three expected no-op
 * branches (unknown email, user.disabled_at set, no active membership) so
 * the route can always return 200 without leaking which path was taken.
 * Unexpected errors (DB / argon2 / EmailProvider) bubble up — the route
 * does NOT catch them; Fastify's default handler returns 500. See
 * PHASE_3_STEP_3_PASSWORD_RESET.md §2.1 / §5.
 *
 * memberships is RLS-scoped, so we cannot SELECT it without a GUC. The
 * login path solves the same problem by probing each organizations row
 * under its own SET LOCAL context — listActiveMembershipsAcrossOrgs.
 * We reuse it here. Its last loop iteration leaves the GUC set; we
 * re-set explicitly below so the intent stays visible. */
export async function requestPasswordReset(input: {
  email: string;
}): Promise<void> {
  await withTransaction(async (client) => {
    // 1) users is NOT RLS-scoped — direct lookup is safe.
    const user = await getByEmailWithPasswordHash(client, input.email);
    if (!user) return;                  // unknown email — enumeration shield
    if (user.disabled_at) return;       // globally disabled — recovery denied

    // 2) Pick the user's first active membership (created_at ASC inside
    //    the helper) so the token's org_id is deterministic.
    const memberships = await listActiveMembershipsAcrossOrgs(client, user.id);
    if (memberships.length === 0) return; // every membership disabled

    const orgId = memberships[0]!.organization.id;
    await setOrgContext(client, orgId);

    // 3) Invalidate any prior active password_reset token for this user.
    //    Required to satisfy auth_tokens_user_purpose_active_idx UNIQUE.
    await invalidateActiveTokens({
      client,
      userId:  user.id,
      purpose: "password_reset",
    });

    // 4) Mint a fresh 1h token.
    const fresh = await mintToken({
      client,
      orgId,
      userId:  user.id,
      purpose: "password_reset",
      ttlMs:   TTL_PASSWORD_RESET_MS,
    });

    // 5) Write the outbox row in the same transaction. If anything throws
    //    between mint and now, both rollback together.
    await emailProvider.sendPasswordResetEmail({
      client,
      orgId,
      toEmail:  user.email,
      toName:   user.name,
      resetUrl: buildResetUrl(fresh.rawToken),
      rawToken: fresh.rawToken,
    });
  });
}

/** Anonymous /auth/password/reset flow.
 *
 * Owns ONE servicePool transaction so consumeToken + UPDATE users +
 * UPDATE sessions revoke are atomic. Same pattern as verifyEmail.
 *
 * hashPassword runs BEFORE the transaction opens — argon2id takes tens of
 * ms and holding a pool connection idle through it is wasteful. The race
 * window is fine: if anything changes between hash and consume, consume's
 * FOR UPDATE catches it.
 *
 * Sessions: every active session for the user is revoked with reason
 * 'password_reset'. Old refresh cookies will 401 on next /auth/refresh.
 * Access JWTs are stateless and remain valid until their TTL — PHASE_3_
 * STEP_3_PASSWORD_RESET.md §1-10 and §4 document the trade-off.
 *
 * Throws AuthError(token_not_found | token_already_used |
 * token_invalidated | token_expired) — the route collapses all four to a
 * generic 410 via sendTokenError. */
export async function resetPassword(input: {
  rawToken: string;
  newPassword: string;
}): Promise<void> {
  const passwordHash = await hashPassword(input.newPassword);

  const client = await getServicePool().connect();
  try {
    await client.query("BEGIN");
    const consumed = await consumeToken(client, input.rawToken, "password_reset");
    if (!consumed.userId) {
      // CHECK auth_tokens_invitation_purpose_check forces non-invitation
      // purposes to carry user_id NOT NULL. Defensive — unreachable.
      throw new AuthError(500, "reset_internal_inconsistency",
        "password_reset token missing user_id");
    }

    await client.query(
      `UPDATE users SET password_hash = $1 WHERE id = $2`,
      [passwordHash, consumed.userId],
    );

    // Revoke every active session for this user. COALESCE preserves prior
    // revoked_at / revoked_reason so a session already revoked for another
    // reason keeps its original timestamp + reason.
    await client.query(
      `UPDATE sessions
          SET revoked_at     = COALESCE(revoked_at, now()),
              revoked_reason = COALESCE(revoked_reason, 'password_reset')
        WHERE user_id    = $1
          AND revoked_at IS NULL`,
      [consumed.userId],
    );

    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      client.release(rollbackErr as Error);
      throw err;
    }
    client.release();
    throw err;
  }
  client.release();
}

// Phase 7 Step 2 — invalidate every active `mfa_challenge` for a user
// across all orgs.
//
// Why service pool: auth_tokens has FORCE RLS scoped to the row's
// org_id. The runtime app role can only see rows in the current GUC's
// org, so invalidating from inside the login transaction would miss a
// stale challenge from another org the user belongs to. That stale row
// would then collide with the new mint via the partial UNIQUE index
// `auth_tokens_user_purpose_active_idx (user_id, purpose) WHERE
// consumed_at IS NULL AND invalidated_at IS NULL`, throwing 23505 from
// the mint and surfacing as an opaque 500 to the user.
//
// Service pool has BYPASSRLS via its dedicated role and the Phase 3
// service_grants migration already gives it SELECT/INSERT/UPDATE on
// `auth_tokens` — no new grant needed.
//
// Trade-off: if the surrounding login transaction rolls back after this
// runs, the invalidated_at flips are NOT undone. That's fine because
// any row we touched here was already not the user's intended in-flight
// challenge (the new login flow about to start replaces it).
async function invalidateStaleMfaChallenges(userId: string): Promise<void> {
  await getServicePool().query(
    `UPDATE auth_tokens
        SET invalidated_at = now()
      WHERE user_id        = $1
        AND purpose        = 'mfa_challenge'
        AND consumed_at    IS NULL
        AND invalidated_at IS NULL`,
    [userId],
  );
}

// Phase 7 Step 2 — read the two MFA flags after membership is resolved.
// `users` and `organizations` are not RLS-scoped, so this runs as the
// same app role inside the login transaction. We trust the user/org
// ids that have just survived `resolveMembershipForLogin` — never the
// request body.
async function loadLoginMfaState(
  client: PoolClient,
  input: { userId: string; orgId: string },
): Promise<{ userMfaEnabledAt: Date | null; orgRequiresMfa: boolean }> {
  const r = await client.query<{
    user_mfa_enabled_at: Date | null;
    org_mfa_required: boolean;
  }>(
    `SELECT u.mfa_enabled_at AS user_mfa_enabled_at,
            o.mfa_required   AS org_mfa_required
       FROM users u
       JOIN organizations o ON o.id = $2
      WHERE u.id = $1`,
    [input.userId, input.orgId],
  );
  const row = r.rows[0];
  if (!row) {
    // Both id lookups already succeeded in resolveMembershipForLogin —
    // this would be a server-side invariant violation, not a user-
    // visible auth failure.
    throw new AuthError(500, "login_internal_inconsistency",
      "user or org missing after membership resolution");
  }
  return {
    userMfaEnabledAt: row.user_mfa_enabled_at,
    orgRequiresMfa: row.org_mfa_required,
  };
}

export async function login(input: {
  email: string;
  password: string;
  orgId?: string;
  userAgent?: string | null;
  ip?: string | null;
}): Promise<LoginResult> {
  return withTransaction(async (client) => {
    const user = await getByEmailWithPasswordHash(client, input.email);
    if (!user || user.disabled_at) {
      throw new AuthError(401, "invalid_credentials", "invalid credentials");
    }

    const ok = await verifyPassword(user.password_hash, input.password);
    if (!ok) {
      throw new AuthError(401, "invalid_credentials", "invalid credentials");
    }

    // Multi-org orgId-required / account_disabled / invalid_credentials
    // all surface from here. No challenge mint above this line — wrong
    // password / missing orgId never advances to MFA evaluation.
    const { membership, organization } = await resolveMembershipForLogin(client, {
      userId: user.id,
      orgId: input.orgId,
    });

    // resolveMembershipForLogin's cross-org probe loop
    // (listActiveMembershipsAcrossOrgs) iterates every organization row
    // to find the user's memberships and leaves the GUC at whichever
    // org came last in `ORDER BY created_at`. The legacy single-org
    // happy path didn't care because it only INSERTs into `sessions`,
    // which has no RLS. Phase 7 Step 2 changes that: `mintToken` writes
    // into `auth_tokens`, which has FORCE RLS + a WITH CHECK on
    // `org_id = current_app_org_id()`. Pin the GUC to the resolved org
    // before any RLS-scoped mutation.
    await setOrgContext(client, organization.id);

    // Phase 7 Step 2 — decide whether to issue a session now or hand
    // back an mfa_challenge instead. Per plan §2.2 the trigger is
    // `org.mfa_required OR user.mfa_enabled_at IS NOT NULL`; the kind
    // depends on which condition fires:
    //   user enabled                       -> mfa_required (verify TOTP)
    //   user not enabled + org required    -> mfa_setup_required (setup TOTP)
    //   neither                            -> authenticated (existing path)
    const mfa = await loadLoginMfaState(client, {
      userId: user.id,
      orgId: organization.id,
    });
    const userMfaEnabled    = mfa.userMfaEnabledAt !== null;
    const orgRequiresMfa    = mfa.orgRequiresMfa;
    const mfaChallengeNeeded = userMfaEnabled || orgRequiresMfa;

    if (mfaChallengeNeeded) {
      // Cross-org sweep first (see helper docstring for why), then
      // invalidate inside the current org's GUC for completeness — the
      // service-pool sweep already covers it but doing both keeps the
      // log trail consistent (current-org invalidation is observable
      // from the app role).
      await invalidateStaleMfaChallenges(user.id);
      await invalidateActiveTokens({
        client,
        userId:  user.id,
        purpose: "mfa_challenge",
      });
      const challenge = await mintToken({
        client,
        orgId:   organization.id,
        userId:  user.id,
        purpose: "mfa_challenge",
        ttlMs:   TTL_MFA_CHALLENGE_MS,
      });

      // Phase 7 Step 3 — audit the challenge issuance. Inside the same
      // withTransaction so an audit failure rolls back the token mint
      // (high-risk: the alternative is silently issuing a challenge with
      // no audit trail). target_id is the auth_tokens row id; the raw
      // token is NEVER recorded — it would be a bearer credential for
      // the next 5 minutes.
      await recordActivity(client, {
        orgId:       organization.id,
        actorUserId: user.id,
        action:      "mfa.login_challenge_issued",
        targetType:  "auth_token",
        targetId:    challenge.tokenId,
        payload: {
          kind:       userMfaEnabled ? "mfa_required" : "mfa_setup_required",
          method:     userMfaEnabled ? "totp" : null,
          expires_at: challenge.expiresAt,
        },
      });

      if (userMfaEnabled) {
        return {
          kind: "mfa_required" as const,
          challengeToken: challenge.rawToken,
          method: "totp" as const,
          expiresAt: challenge.expiresAt,
        };
      }
      return {
        kind: "mfa_setup_required" as const,
        challengeToken: challenge.rawToken,
        expiresAt: challenge.expiresAt,
      };
    }

    const { session, refreshToken } = await createSessionWithToken(client, {
      userId: user.id,
      orgId: organization.id,
      membershipId: membership.id,
      userAgent: input.userAgent,
      ip: input.ip,
    });

    return {
      kind: "authenticated" as const,
      auth: {
        user: toPublicAuthUser(user),
        organization,
        membership,
        session,
        accessPayload: buildAccessPayload(session, membership.role),
        refreshToken,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// MFA verify-login (Phase 7 Step 2)
// ---------------------------------------------------------------------------

// Plan: docs/plan/phase-7/PHASE_7_STEP_2_PLAN.md §4.4.
//
// Second step of the login flow for an already-enrolled MFA user. The user
// has the `challengeToken` returned by `POST /auth/login` (202 response) and
// types the 6-digit TOTP code from their authenticator app.
//
// Anonymous endpoint — no JWT yet — so we run on the BYPASSRLS service pool
// just like `verifyEmail` and `resetPassword`. The challenge token row's
// user_id + org_id are the only authority we have to decide what session to
// mint; we trust nothing from the client beyond the raw token + 6-digit
// code.
//
// Lockout policy (plan §4.4): five wrong codes inside one MFA-enabled user
// trigger a 10-minute `mfa_locked_until`. Locked attempts return 423
// (Locked) and DO NOT consume the challenge token — that way the user can
// finish logging in once the lock expires without restarting from
// password.
//
// Wrong-code path: increment `mfa_failed_attempt_count` AND COMMIT before
// throwing. The counter would silently roll back under the default
// "throw -> ROLLBACK" pattern and the lockout could never trip.

export const MFA_LOCKOUT_THRESHOLD     = 5;
export const MFA_LOCKOUT_DURATION_MS   = 10 * 60 * 1000; // 10 min

interface ChallengeUserContext {
  user: PublicAuthUser;
  organization: AuthOrganization;
  membership: AuthMembership;
}

// Load the user / membership / org tied to a challenge row that just
// passed `lockAndValidateTokenById`. Verifies the membership is still
// active and the user is not globally disabled. Returns invalid_credentials
// if either invariant has broken since the original login.
async function loadChallengeContext(
  client: PoolClient,
  input: { userId: string; orgId: string },
): Promise<ChallengeUserContext> {
  // users / organizations are not RLS-scoped. memberships IS — we need
  // the GUC pointing at the right org before reading it.
  await setOrgContext(client, input.orgId);

  const userRow = await client.query<{
    id: string;
    email: string;
    name: string;
    avatar_url: string | null;
    email_verified_at: Date | null;
    disabled_at: Date | null;
  }>(
    `SELECT id, email, name, avatar_url, email_verified_at, disabled_at
       FROM users
      WHERE id = $1`,
    [input.userId],
  );
  if (!userRow.rows[0] || userRow.rows[0].disabled_at) {
    throw new AuthError(401, "invalid_credentials", "invalid credentials");
  }
  const u = userRow.rows[0];

  const found = await getActiveMembershipInCurrentOrg(client, {
    userId: input.userId,
    orgId: input.orgId,
  });
  if (!found) {
    // Membership disabled between the original login and the verify
    // step. Surface the same 401 the login path would — we don't want
    // verify-login to leak "your account got revoked since you typed
    // your password" via a different code.
    throw new AuthError(401, "invalid_credentials", "invalid credentials");
  }

  return {
    user: {
      id: u.id,
      email: u.email,
      name: u.name,
      avatar_url: u.avatar_url,
      email_verified_at: u.email_verified_at,
    },
    organization: found.organization,
    membership: found.membership,
  };
}

export async function verifyLoginMfa(input: {
  challengeToken: string;
  code: string;
  userAgent?: string | null;
  ip?: string | null;
}): Promise<AuthResult> {
  // The encryption key MUST exist for verify-login to work. Loading it up
  // front so a misconfigured deploy returns a stable 500 before we even
  // touch the DB, instead of throwing midway after a partial UPDATE.
  // MfaSecretEncryptionConfigError is operator misconfig, not a user
  // failure (plan §2.4).
  let encryptionKey: Buffer;
  try {
    encryptionKey = loadMfaSecretEncryptionKey();
  } catch (err) {
    if (err instanceof MfaSecretEncryptionConfigError) {
      throw new AuthError(500, "mfa_unconfigured",
        "MFA verification is not configured on this deploy");
    }
    throw err;
  }

  // Anonymous endpoint — no JWT yet — so we use the BYPASSRLS service
  // pool, same pattern as verifyEmail / resetPassword. CommitAuthError
  // is the existing escape hatch that tells the outer try/catch to
  // COMMIT before re-throwing (so a wrong-code increment to
  // mfa_failed_attempt_count persists even though we throw 401).
  const client = await getServicePool().connect();
  try {
    await client.query("BEGIN");

    // ---- 1. validate the challenge token (no consume yet) ----
    const lookup = await findTokenByRaw(client, input.challengeToken, "mfa_challenge");
    if (!lookup) {
      throw new AuthError(401, "mfa_invalid_challenge",
        "invalid or expired MFA challenge");
    }
    if (!lookup.userId) {
      // CHECK auth_tokens_invitation_purpose_check forces non-invitation
      // purposes to carry user_id NOT NULL. Defensive — unreachable.
      throw new AuthError(500, "mfa_internal_inconsistency",
        "challenge token missing user_id");
    }
    try {
      await lockAndValidateTokenById(client, lookup.tokenId, "mfa_challenge");
    } catch (err) {
      // Collapse the four token-state errors (not_found / already_used
      // / invalidated / expired) into one user-visible code. Plan §2.3
      // (no premature consume) is honored because we never reach
      // markTokenConsumed on any of these branches.
      if (err instanceof AuthError && err.statusCode >= 400 && err.statusCode < 500) {
        throw new AuthError(401, "mfa_invalid_challenge",
          "invalid or expired MFA challenge");
      }
      throw err;
    }

    const userId = lookup.userId;
    const orgId  = lookup.orgId;

    // ---- 2. load MFA state + handle lockout window ----
    const mfaState = await mfaUsers.getMfaState(client, userId);
    if (!mfaState) {
      throw new AuthError(401, "invalid_credentials", "invalid credentials");
    }

    const now = new Date();

    // Lockout still in effect: refuse without consuming the token and
    // without incrementing the counter. No mutations to commit on this
    // branch — plain AuthError (rollback path) is correct.
    if (mfaState.mfa_locked_until && mfaState.mfa_locked_until > now) {
      throw new AuthError(423, "mfa_locked",
        "MFA temporarily locked due to too many failed attempts");
    }

    // Lockout expired: clear the lock and the counter so a now-correct
    // attempt isn't immediately re-locked by the stale count of 5.
    if (mfaState.mfa_locked_until && mfaState.mfa_locked_until <= now) {
      await mfaUsers.setLockedUntil(client, userId, null);
      await mfaUsers.resetFailedAttempts(client, userId);
    }

    // ---- 3. enforce "user must have MFA enabled" for this endpoint ----
    // Plan: setup-required flow is the next commit. verify-login only
    // closes the path for already-enrolled users.
    if (!mfaState.mfa_enabled_at) {
      throw new AuthError(409, "mfa_not_enrolled",
        "user has not enrolled MFA; use the setup flow");
    }
    if (
      !mfaState.mfa_secret_ciphertext ||
      !mfaState.mfa_secret_iv ||
      !mfaState.mfa_secret_tag
    ) {
      // DB CHECK guarantees this is unreachable when mfa_enabled_at is
      // set, but a future migration loosening the check should not let
      // verify-login fall through to verifyTotp(secret=NaN).
      throw new AuthError(500, "mfa_internal_inconsistency",
        "MFA enabled without secret");
    }

    // ---- 4. decrypt the stored TOTP secret ----
    let rawSecret: Buffer;
    try {
      rawSecret = decryptMfaSecret(
        {
          ciphertext: mfaState.mfa_secret_ciphertext,
          iv:         mfaState.mfa_secret_iv,
          tag:        mfaState.mfa_secret_tag,
        },
        encryptionKey,
      );
    } catch (err) {
      // Decrypt failure (wrong key post-rotation, tampered ciphertext)
      // is server-side data damage, not a user mistake. Surface as 500
      // with a sanitised code — never echo the underlying message which
      // may include byte-level hints.
      if (err instanceof MfaSecretEncryptionFailureError ||
          err instanceof MfaSecretEncryptionConfigError) {
        throw new AuthError(500, "mfa_secret_corrupt",
          "MFA secret could not be decoded");
      }
      throw err;
    }

    // ---- 5. verify the TOTP code ----
    const secretBase32 = base32Encode(rawSecret);
    const ok = verifyTotp({ secretBase32, code: input.code, now });
    if (!ok) {
      // Wrong code: bump the counter and possibly trip the lockout.
      // Both writes must persist even though we're about to throw,
      // so use CommitAuthError — the outer catch commits before
      // re-raising, mirroring refresh()'s family-revoke pattern.
      const newCount = await mfaUsers.incrementFailedAttempts(client, userId);
      if (newCount >= MFA_LOCKOUT_THRESHOLD) {
        await mfaUsers.setLockedUntil(
          client,
          userId,
          new Date(now.getTime() + MFA_LOCKOUT_DURATION_MS),
        );
        throw new CommitAuthError(423, "mfa_locked",
          "MFA temporarily locked due to too many failed attempts");
      }
      throw new CommitAuthError(401, "mfa_invalid_code", "invalid TOTP code");
    }

    // ---- 6. happy path: consume + reset + mint session ----
    await markTokenConsumed(client, lookup.tokenId);
    await mfaUsers.resetFailedAttempts(client, userId);
    // Defensive — clear any leftover lockout. The "expired-lockout"
    // branch above already does this, but a future exit point added
    // before §6 should still leave the user clean after success.
    await mfaUsers.setLockedUntil(client, userId, null);

    const ctx = await loadChallengeContext(client, { userId, orgId });
    // GUC is now pinned to orgId by loadChallengeContext.

    const { session, refreshToken } = await createSessionWithToken(client, {
      userId:        ctx.user.id,
      orgId:         ctx.organization.id,
      membershipId:  ctx.membership.id,
      userAgent:     input.userAgent,
      ip:            input.ip,
      mfaVerifiedAt: now,
      mfaMethod:     "totp",
    });

    await client.query("COMMIT");
    client.release();

    return {
      user:          ctx.user,
      organization:  ctx.organization,
      membership:    ctx.membership,
      session,
      accessPayload: buildAccessPayload(session, ctx.membership.role),
      refreshToken,
    };
  } catch (err) {
    if (err instanceof CommitAuthError) {
      // Wrong-code path: persist the counter increment + optional
      // lockout, then surface the AuthError unchanged. If the COMMIT
      // itself fails we fall through to release(err) and re-throw the
      // original CommitAuthError — the counter just didn't persist.
      try {
        await client.query("COMMIT");
        client.release();
      } catch {
        client.release(err as Error);
      }
      throw err;
    }
    try {
      await client.query("ROLLBACK");
      client.release();
    } catch (rollbackErr) {
      // Rollback failed on a poisoned connection — release(truthy)
      // tells pg to destroy it rather than returning it to the pool.
      client.release(rollbackErr as Error);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// MFA setup / confirm during login (Phase 7 Step 2)
// ---------------------------------------------------------------------------

// Plan: docs/plan/phase-7/PHASE_7_STEP_2_PLAN.md §2.7 / §4.4.
//
// Closes the "org requires MFA but user has not enrolled" door that login
// opens with a `mfa_setup_required` challenge. Two endpoints in series:
//
//   POST /auth/mfa/totp/setup-challenge
//     Mints a fresh TOTP secret for the user, encrypts it, stores it as
//     PENDING (`mfa_enabled_at` stays NULL), and returns the otpauth URI
//     + base32 string so the client can render a QR code or show the
//     secret for manual entry. The challenge token is NOT consumed — the
//     user must come back with a valid TOTP code to actually finish.
//
//   POST /auth/mfa/totp/confirm-challenge
//     Verifies the TOTP code against the pending secret. On success:
//     promotes the pending secret to enabled, consumes the challenge,
//     mints a real session stamped with mfa_verified_at / mfa_method.
//     On wrong code: increments the failed-attempt counter (and trips
//     the 10-minute lockout at threshold) without consuming.
//
// Both endpoints reuse the same `mfa_challenge` token issued by /auth/
// login, so a user who walked away mid-setup can come back inside the
// 5-minute TTL and pick up where they left off. After TTL expiry the
// user re-enters their password and gets a fresh challenge — the
// pending secret in `users` is overwritten by the next setup-challenge
// call (storePendingSecret nulls mfa_enabled_at by design).
//
// Service-pool (BYPASSRLS) connection mirrors verifyLoginMfa: the user
// has no JWT yet and `auth_tokens` is FORCE-RLS-scoped on org_id, so the
// regular app pool would need a GUC dance every step. The CommitAuthError
// pattern is reused for the wrong-code path so the counter increment
// persists even though we throw.

export async function setupLoginMfaChallenge(input: {
  challengeToken: string;
}): Promise<{ otpauthUri: string; secretBase32: string }> {
  // Fail-fast on operator misconfig before opening a DB connection. Plan
  // §2.4: a deploy with no MFA_SECRET_ENCRYPTION_KEY must return a stable
  // 500 instead of half-encrypting then half-failing.
  let encryptionKey: Buffer;
  try {
    encryptionKey = loadMfaSecretEncryptionKey();
  } catch (err) {
    if (err instanceof MfaSecretEncryptionConfigError) {
      throw new AuthError(500, "mfa_unconfigured",
        "MFA verification is not configured on this deploy");
    }
    throw err;
  }

  const client = await getServicePool().connect();
  try {
    await client.query("BEGIN");

    // ---- 1. validate the challenge token (no consume yet) ----
    const lookup = await findTokenByRaw(client, input.challengeToken, "mfa_challenge");
    if (!lookup) {
      throw new AuthError(401, "mfa_invalid_challenge",
        "invalid or expired MFA challenge");
    }
    if (!lookup.userId) {
      throw new AuthError(500, "mfa_internal_inconsistency",
        "challenge token missing user_id");
    }
    try {
      await lockAndValidateTokenById(client, lookup.tokenId, "mfa_challenge");
    } catch (err) {
      if (err instanceof AuthError && err.statusCode >= 400 && err.statusCode < 500) {
        throw new AuthError(401, "mfa_invalid_challenge",
          "invalid or expired MFA challenge");
      }
      throw err;
    }

    const userId = lookup.userId;
    const orgId  = lookup.orgId;

    // ---- 2. user must NOT already be enrolled ----
    // verify-login owns the post-enrollment path; setup is single-use.
    const mfaState = await mfaUsers.getMfaState(client, userId);
    if (!mfaState) {
      throw new AuthError(401, "invalid_credentials", "invalid credentials");
    }
    if (mfaState.mfa_enabled_at) {
      throw new AuthError(409, "mfa_already_enrolled",
        "user already enrolled in MFA; use verify-login");
    }

    // ---- 3. load user + membership + org (pins GUC) ----
    const ctx = await loadChallengeContext(client, { userId, orgId });

    // ---- 4. org policy must still require MFA ----
    // Race: org admin flipped `mfa_required` off between /auth/login and
    // this call. The challenge token is valid (still inside TTL), but
    // the "you must enrol" justification has gone away. Refuse rather
    // than silently force-enrol — the user can re-login and will now
    // get a normal session.
    const orgRow = await client.query<{ mfa_required: boolean }>(
      `SELECT mfa_required FROM organizations WHERE id = $1`,
      [orgId],
    );
    if (!orgRow.rows[0]?.mfa_required) {
      throw new AuthError(409, "mfa_setup_not_required",
        "MFA is no longer required for this organization");
    }

    // ---- 5. generate + encrypt + store pending secret ----
    // `storePendingSecret` nulls `mfa_enabled_at` + zeros the counter,
    // so calling setup-challenge twice in a row replaces the previous
    // pending secret cleanly — the user might have scanned the first
    // QR into the wrong account and is restarting.
    const secret    = generateTotpSecret();
    const wrapped   = encryptMfaSecret(secret.raw, encryptionKey);
    await mfaUsers.storePendingSecret(client, userId, {
      ciphertext: wrapped.ciphertext,
      iv:         wrapped.iv,
      tag:        wrapped.tag,
      keyVersion: 1,
    });

    // Challenge is NOT marked consumed — the user must come back with a
    // valid TOTP code via confirm-challenge to actually complete.

    await client.query("COMMIT");
    client.release();

    const otpauthUri = buildOtpauthUri({
      issuer:       "Kloser",
      accountEmail: ctx.user.email,
      secretBase32: secret.base32,
    });

    return { otpauthUri, secretBase32: secret.base32 };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
      client.release();
    } catch (rollbackErr) {
      client.release(rollbackErr as Error);
    }
    throw err;
  }
}

export async function confirmLoginMfaChallenge(input: {
  challengeToken: string;
  code: string;
  userAgent?: string | null;
  ip?: string | null;
}): Promise<AuthResult> {
  // Same fail-fast as setup-challenge.
  let encryptionKey: Buffer;
  try {
    encryptionKey = loadMfaSecretEncryptionKey();
  } catch (err) {
    if (err instanceof MfaSecretEncryptionConfigError) {
      throw new AuthError(500, "mfa_unconfigured",
        "MFA verification is not configured on this deploy");
    }
    throw err;
  }

  const client = await getServicePool().connect();
  try {
    await client.query("BEGIN");

    // ---- 1. validate the challenge token (no consume yet) ----
    const lookup = await findTokenByRaw(client, input.challengeToken, "mfa_challenge");
    if (!lookup) {
      throw new AuthError(401, "mfa_invalid_challenge",
        "invalid or expired MFA challenge");
    }
    if (!lookup.userId) {
      throw new AuthError(500, "mfa_internal_inconsistency",
        "challenge token missing user_id");
    }
    try {
      await lockAndValidateTokenById(client, lookup.tokenId, "mfa_challenge");
    } catch (err) {
      if (err instanceof AuthError && err.statusCode >= 400 && err.statusCode < 500) {
        throw new AuthError(401, "mfa_invalid_challenge",
          "invalid or expired MFA challenge");
      }
      throw err;
    }

    const userId = lookup.userId;
    const orgId  = lookup.orgId;

    // ---- 2. load MFA state + handle lockout window ----
    const mfaState = await mfaUsers.getMfaState(client, userId);
    if (!mfaState) {
      throw new AuthError(401, "invalid_credentials", "invalid credentials");
    }

    const now = new Date();

    if (mfaState.mfa_locked_until && mfaState.mfa_locked_until > now) {
      throw new AuthError(423, "mfa_locked",
        "MFA temporarily locked due to too many failed attempts");
    }
    if (mfaState.mfa_locked_until && mfaState.mfa_locked_until <= now) {
      await mfaUsers.setLockedUntil(client, userId, null);
      await mfaUsers.resetFailedAttempts(client, userId);
    }

    // ---- 3. enforce setup discipline ----
    // Already enrolled — wrong endpoint, route the user to verify-login.
    if (mfaState.mfa_enabled_at) {
      throw new AuthError(409, "mfa_already_enrolled",
        "user already enrolled in MFA; use verify-login");
    }
    // Must have called setup-challenge first — no pending secret means
    // we have nothing to verify against.
    if (
      !mfaState.mfa_secret_ciphertext ||
      !mfaState.mfa_secret_iv ||
      !mfaState.mfa_secret_tag
    ) {
      throw new AuthError(409, "mfa_setup_not_started",
        "no pending TOTP secret; call setup-challenge first");
    }

    // ---- 4. decrypt the pending secret ----
    let rawSecret: Buffer;
    try {
      rawSecret = decryptMfaSecret(
        {
          ciphertext: mfaState.mfa_secret_ciphertext,
          iv:         mfaState.mfa_secret_iv,
          tag:        mfaState.mfa_secret_tag,
        },
        encryptionKey,
      );
    } catch (err) {
      if (err instanceof MfaSecretEncryptionFailureError ||
          err instanceof MfaSecretEncryptionConfigError) {
        throw new AuthError(500, "mfa_secret_corrupt",
          "MFA secret could not be decoded");
      }
      throw err;
    }

    // ---- 5. verify the TOTP code ----
    const secretBase32 = base32Encode(rawSecret);
    const ok = verifyTotp({ secretBase32, code: input.code, now });
    if (!ok) {
      // Wrong code: bump counter + maybe lock. CommitAuthError so the
      // outer try/catch commits before re-raising, mirroring verify-
      // login. We don't promote the pending secret to enabled here —
      // the user can retry with the same secret and same challenge
      // (the challenge is NOT consumed on failure).
      const newCount = await mfaUsers.incrementFailedAttempts(client, userId);
      if (newCount >= MFA_LOCKOUT_THRESHOLD) {
        await mfaUsers.setLockedUntil(
          client,
          userId,
          new Date(now.getTime() + MFA_LOCKOUT_DURATION_MS),
        );
        throw new CommitAuthError(423, "mfa_locked",
          "MFA temporarily locked due to too many failed attempts");
      }
      throw new CommitAuthError(401, "mfa_invalid_code", "invalid TOTP code");
    }

    // ---- 6. policy still requires MFA? (race: org flipped off after setup) ----
    // setup-challenge had the same gate (mfa_setup_not_required) but the
    // admin can flip `organizations.mfa_required = false` after the
    // pending secret was stored. Without this re-check the user would
    // be force-enrolled by their now-valid TOTP code even though the
    // policy no longer demands it. Re-read inside the SAME transaction
    // as enableMfa so there's no further race window.
    //
    // Disposition on rejection:
    //   - challenge: NOT consumed (transaction rolls back).
    //   - pending secret: PRESERVED. It's AES-GCM-wrapped, useless
    //     without the challenge token (which expires in 5 minutes),
    //     and the next setup-challenge call cleanly overwrites it.
    //     Clearing here would force a CommitAuthError + extra UPDATE
    //     for no meaningful security gain (the secret is already
    //     practically unreachable).
    const orgRow = await client.query<{ mfa_required: boolean }>(
      `SELECT mfa_required FROM organizations WHERE id = $1`,
      [orgId],
    );
    if (!orgRow.rows[0]?.mfa_required) {
      throw new AuthError(409, "mfa_setup_not_required",
        "MFA is no longer required for this organization");
    }

    // ---- 7. happy path: enable + consume + mint MFA-verified session ----
    const enabledCount = await mfaUsers.enableMfa(client, userId, now);
    if (enabledCount !== 1) {
      // The WHERE guard inside enableMfa requires mfa_secret_ciphertext
      // IS NOT NULL — we just verified that above. A 0 row count would
      // mean a concurrent process wiped the secret between our state
      // load and this UPDATE.
      throw new AuthError(500, "mfa_internal_inconsistency",
        "MFA could not be enabled");
    }
    await markTokenConsumed(client, lookup.tokenId);
    await mfaUsers.resetFailedAttempts(client, userId);
    await mfaUsers.setLockedUntil(client, userId, null);

    const ctx = await loadChallengeContext(client, { userId, orgId });

    const { session, refreshToken } = await createSessionWithToken(client, {
      userId:        ctx.user.id,
      orgId:         ctx.organization.id,
      membershipId:  ctx.membership.id,
      userAgent:     input.userAgent,
      ip:            input.ip,
      // Setup-then-confirm IS a factor confirmation — stamp the
      // session so refresh's MFA gate (assertRefreshMfaGate) and any
      // downstream policy see this as a real MFA-verified session.
      mfaVerifiedAt: now,
      mfaMethod:     "totp",
    });

    await client.query("COMMIT");
    client.release();

    return {
      user:          ctx.user,
      organization:  ctx.organization,
      membership:    ctx.membership,
      session,
      accessPayload: buildAccessPayload(session, ctx.membership.role),
      refreshToken,
    };
  } catch (err) {
    if (err instanceof CommitAuthError) {
      // Wrong-code path: persist counter / lockout, then re-raise.
      try {
        await client.query("COMMIT");
        client.release();
      } catch {
        client.release(err as Error);
      }
      throw err;
    }
    try {
      await client.query("ROLLBACK");
      client.release();
    } catch (rollbackErr) {
      client.release(rollbackErr as Error);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Authenticated MFA setup / confirm / disable (Phase 7 Step 2)
// ---------------------------------------------------------------------------

// Plan: docs/plan/phase-7/PHASE_7_STEP_2_PLAN.md §2.7.
//
// Authenticated counterparts of the login-time setup/confirm flow. The
// user already has a real session (JWT carries `sid`), so we use the
// regular app pool with an org GUC instead of the BYPASSRLS service
// pool. There is no `mfa_challenge` token — the JWT is the proof of
// identity for setup/confirm/disable.
//
// Current-password verification gates `setup` and `disable`, but NOT
// `confirm` — by the time the user is typing their TOTP code into the
// confirm form they have already produced the password inside the same
// browser tab, and re-prompting would be friction without a meaningful
// security gain.
//
// Disable extras (per plan §2.7):
//   - org.mfa_required = true → 409 mfa_required_by_org. The user cannot
//     opt out of a policy their organization enforces.
//   - current TOTP code is mandatory (not just password). This stops a
//     stolen-cookie attacker who happens to know the password from
//     unilaterally tearing MFA off the account.
//
// Failed-attempt counter + 10-minute lockout apply to BOTH confirm and
// disable wrong codes (shared with the login-time flow). A locked user
// cannot enroll OR disable until the window expires.

export async function startAuthenticatedTotpSetup(input: {
  userId: string;
  orgId: string;
  currentPassword: string;
}): Promise<{ otpauthUri: string; secretBase32: string }> {
  // Same fail-fast as the login-time flow — operator misconfig surfaces
  // as a stable 500 before any DB work.
  let encryptionKey: Buffer;
  try {
    encryptionKey = loadMfaSecretEncryptionKey();
  } catch (err) {
    if (err instanceof MfaSecretEncryptionConfigError) {
      throw new AuthError(500, "mfa_unconfigured",
        "MFA verification is not configured on this deploy");
    }
    throw err;
  }

  return withTransaction(async (client) => {
    await setOrgContext(client, input.orgId);

    // Membership in the current org must still be active. JWT just says
    // "at issuance time, user X was a member of org Y" — between then
    // and now the membership could have been disabled.
    const found = await getActiveMembershipInCurrentOrg(client, {
      userId: input.userId,
      orgId:  input.orgId,
    });
    if (!found) {
      throw new AuthError(401, "invalid_credentials", "invalid credentials");
    }

    const userResult = await client.query<{
      email: string;
      password_hash: string;
      disabled_at: Date | null;
    }>(
      `SELECT email, password_hash, disabled_at FROM users WHERE id = $1`,
      [input.userId],
    );
    const userRow = userResult.rows[0];
    if (!userRow || userRow.disabled_at) {
      throw new AuthError(401, "invalid_credentials", "invalid credentials");
    }

    const passwordOk = await verifyPassword(userRow.password_hash, input.currentPassword);
    if (!passwordOk) {
      throw new AuthError(401, "invalid_credentials", "invalid credentials");
    }

    // Already-enrolled users go through the disable flow first, then
    // re-setup. We do NOT allow setup to silently overwrite an enabled
    // secret — that would let a stolen-password (no TOTP) attacker
    // factor-replace the legitimate user's device.
    const mfaState = await mfaUsers.getMfaState(client, input.userId);
    if (mfaState?.mfa_enabled_at) {
      throw new AuthError(409, "mfa_already_enrolled",
        "user already enrolled in MFA");
    }

    const secret  = generateTotpSecret();
    const wrapped = encryptMfaSecret(secret.raw, encryptionKey);
    await mfaUsers.storePendingSecret(client, input.userId, {
      ciphertext: wrapped.ciphertext,
      iv:         wrapped.iv,
      tag:        wrapped.tag,
      keyVersion: 1,
    });

    // Phase 7 Step 3 — audit the start of authenticated enrollment.
    // Payload carries only the flow tag + method; the secret material
    // (raw / ciphertext / iv / tag / otpauthUri / base32) is forbidden
    // from audit by the sanitizer's key rules anyway, but we don't
    // construct it into payload either — defense in depth.
    await recordActivity(client, {
      orgId:       input.orgId,
      actorUserId: input.userId,
      action:      "mfa.setup_started",
      targetType:  "user",
      targetId:    input.userId,
      payload: {
        flow:   "authenticated",
        method: "totp",
      },
    });

    const otpauthUri = buildOtpauthUri({
      issuer:       "Kloser",
      accountEmail: userRow.email,
      secretBase32: secret.base32,
    });

    return { otpauthUri, secretBase32: secret.base32 };
  });
}

export async function confirmAuthenticatedTotp(input: {
  userId: string;
  orgId: string;
  sessionId: string;
  code: string;
}): Promise<{ mfaEnabledAt: Date }> {
  let encryptionKey: Buffer;
  try {
    encryptionKey = loadMfaSecretEncryptionKey();
  } catch (err) {
    if (err instanceof MfaSecretEncryptionConfigError) {
      throw new AuthError(500, "mfa_unconfigured",
        "MFA verification is not configured on this deploy");
    }
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setOrgContext(client, input.orgId);

    const found = await getActiveMembershipInCurrentOrg(client, {
      userId: input.userId,
      orgId:  input.orgId,
    });
    if (!found) {
      throw new AuthError(401, "invalid_credentials", "invalid credentials");
    }

    const mfaState = await mfaUsers.getMfaState(client, input.userId);
    if (!mfaState) {
      throw new AuthError(401, "invalid_credentials", "invalid credentials");
    }

    const now = new Date();

    if (mfaState.mfa_locked_until && mfaState.mfa_locked_until > now) {
      throw new AuthError(423, "mfa_locked",
        "MFA temporarily locked due to too many failed attempts");
    }
    if (mfaState.mfa_locked_until && mfaState.mfa_locked_until <= now) {
      await mfaUsers.setLockedUntil(client, input.userId, null);
      await mfaUsers.resetFailedAttempts(client, input.userId);
    }

    if (mfaState.mfa_enabled_at) {
      throw new AuthError(409, "mfa_already_enrolled",
        "user already enrolled in MFA");
    }
    if (
      !mfaState.mfa_secret_ciphertext ||
      !mfaState.mfa_secret_iv ||
      !mfaState.mfa_secret_tag
    ) {
      throw new AuthError(409, "mfa_setup_not_started",
        "no pending TOTP secret; call setup first");
    }

    let rawSecret: Buffer;
    try {
      rawSecret = decryptMfaSecret(
        {
          ciphertext: mfaState.mfa_secret_ciphertext,
          iv:         mfaState.mfa_secret_iv,
          tag:        mfaState.mfa_secret_tag,
        },
        encryptionKey,
      );
    } catch (err) {
      if (err instanceof MfaSecretEncryptionFailureError ||
          err instanceof MfaSecretEncryptionConfigError) {
        throw new AuthError(500, "mfa_secret_corrupt",
          "MFA secret could not be decoded");
      }
      throw err;
    }

    const secretBase32 = base32Encode(rawSecret);
    const ok = verifyTotp({ secretBase32, code: input.code, now });
    if (!ok) {
      const newCount = await mfaUsers.incrementFailedAttempts(client, input.userId);
      // Phase 7 Step 3 — audit the failed attempt. CommitAuthError below
      // makes the outer catch COMMIT before re-raising, so the counter
      // UPDATE + this audit row + any lockout UPDATE all persist together.
      // payload carries only the flow + the new counter value; the user-
      // typed code is NEVER recorded (audit must not echo credentials).
      await recordActivity(client, {
        orgId:       input.orgId,
        actorUserId: input.userId,
        action:      "mfa.failed_attempt",
        targetType:  "user",
        targetId:    input.userId,
        payload: {
          flow:                 "authenticated_confirm",
          failed_attempt_count: newCount,
        },
      });
      if (newCount >= MFA_LOCKOUT_THRESHOLD) {
        const lockedUntil = new Date(now.getTime() + MFA_LOCKOUT_DURATION_MS);
        await mfaUsers.setLockedUntil(client, input.userId, lockedUntil);
        // Phase 7 Step 3 — only record `mfa.locked` on the transition
        // (this branch fires only when newCount JUST hit the threshold).
        // Subsequent attempts while locked throw at the top-of-function
        // `mfa_locked_until > now` check and never reach this branch,
        // so there's no spam-on-retry.
        await recordActivity(client, {
          orgId:       input.orgId,
          actorUserId: input.userId,
          action:      "mfa.locked",
          targetType:  "user",
          targetId:    input.userId,
          payload: {
            flow:         "authenticated_confirm",
            locked_until: lockedUntil,
          },
        });
        throw new CommitAuthError(423, "mfa_locked",
          "MFA temporarily locked due to too many failed attempts");
      }
      throw new CommitAuthError(401, "mfa_invalid_code", "invalid TOTP code");
    }

    const enabledCount = await mfaUsers.enableMfa(client, input.userId, now);
    if (enabledCount !== 1) {
      // Pending secret was wiped between our state-load and this UPDATE.
      throw new AuthError(500, "mfa_internal_inconsistency",
        "MFA could not be enabled");
    }

    // Stamp the CURRENT session. markMfaVerified excludes revoked rows
    // — rowCount=0 means the JWT's session got revoked while the user
    // was filling in the confirm form (logout in another tab, password
    // reset, etc.). We refuse rather than leave a half-state where
    // mfa_enabled_at is set but no session is marked: the throw rolls
    // the whole transaction back, including enableMfa. The user
    // re-logs in and re-runs setup → confirm cleanly.
    const markedCount = await markMfaVerified(client, {
      sessionId: input.sessionId,
      method:    "totp",
      now,
    });
    if (markedCount !== 1) {
      throw new AuthError(401, "invalid_session",
        "current session is no longer active");
    }

    await mfaUsers.resetFailedAttempts(client, input.userId);
    await mfaUsers.setLockedUntil(client, input.userId, null);

    // Phase 7 Step 3 — audit successful enrollment. actor=target because
    // authenticated confirm is self-enrollment; helper writes
    // action='mfa.enabled', target_type='user', payload={method:'totp'}.
    await recordMfaEnabled(client, {
      orgId:        input.orgId,
      actorUserId:  input.userId,
      targetUserId: input.userId,
      method:       "totp",
    });

    await client.query("COMMIT");
    client.release();
    return { mfaEnabledAt: now };
  } catch (err) {
    if (err instanceof CommitAuthError) {
      try {
        await client.query("COMMIT");
        client.release();
      } catch {
        client.release(err as Error);
      }
      throw err;
    }
    try {
      await client.query("ROLLBACK");
      client.release();
    } catch (rollbackErr) {
      client.release(rollbackErr as Error);
    }
    throw err;
  }
}

export async function disableTotp(input: {
  userId: string;
  orgId: string;
  currentPassword: string;
  code: string;
}): Promise<void> {
  let encryptionKey: Buffer;
  try {
    encryptionKey = loadMfaSecretEncryptionKey();
  } catch (err) {
    if (err instanceof MfaSecretEncryptionConfigError) {
      throw new AuthError(500, "mfa_unconfigured",
        "MFA verification is not configured on this deploy");
    }
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setOrgContext(client, input.orgId);

    const found = await getActiveMembershipInCurrentOrg(client, {
      userId: input.userId,
      orgId:  input.orgId,
    });
    if (!found) {
      throw new AuthError(401, "invalid_credentials", "invalid credentials");
    }

    const userResult = await client.query<{
      password_hash: string;
      disabled_at:   Date | null;
    }>(
      `SELECT password_hash, disabled_at FROM users WHERE id = $1`,
      [input.userId],
    );
    const userRow = userResult.rows[0];
    if (!userRow || userRow.disabled_at) {
      throw new AuthError(401, "invalid_credentials", "invalid credentials");
    }

    const passwordOk = await verifyPassword(userRow.password_hash, input.currentPassword);
    if (!passwordOk) {
      // Password gate first — never reveal anything about MFA state or
      // org policy to someone who can't prove their identity.
      throw new AuthError(401, "invalid_credentials", "invalid credentials");
    }

    // Org-level lock: cannot opt out of an enforced policy.
    const orgRow = await client.query<{ mfa_required: boolean }>(
      `SELECT mfa_required FROM organizations WHERE id = $1`,
      [input.orgId],
    );
    if (orgRow.rows[0]?.mfa_required) {
      throw new AuthError(409, "mfa_required_by_org",
        "MFA is required by this organization and cannot be disabled");
    }

    const mfaState = await mfaUsers.getMfaState(client, input.userId);
    if (!mfaState || !mfaState.mfa_enabled_at) {
      throw new AuthError(409, "mfa_not_enrolled",
        "user is not enrolled in MFA");
    }

    const now = new Date();

    if (mfaState.mfa_locked_until && mfaState.mfa_locked_until > now) {
      throw new AuthError(423, "mfa_locked",
        "MFA temporarily locked due to too many failed attempts");
    }
    if (mfaState.mfa_locked_until && mfaState.mfa_locked_until <= now) {
      await mfaUsers.setLockedUntil(client, input.userId, null);
      await mfaUsers.resetFailedAttempts(client, input.userId);
    }

    if (
      !mfaState.mfa_secret_ciphertext ||
      !mfaState.mfa_secret_iv ||
      !mfaState.mfa_secret_tag
    ) {
      // DB CHECK guarantees this is unreachable when mfa_enabled_at is
      // set, but a future migration loosening the check should not let
      // disable fall through to verifyTotp(secret=NaN).
      throw new AuthError(500, "mfa_internal_inconsistency",
        "MFA enabled without secret");
    }

    let rawSecret: Buffer;
    try {
      rawSecret = decryptMfaSecret(
        {
          ciphertext: mfaState.mfa_secret_ciphertext,
          iv:         mfaState.mfa_secret_iv,
          tag:        mfaState.mfa_secret_tag,
        },
        encryptionKey,
      );
    } catch (err) {
      if (err instanceof MfaSecretEncryptionFailureError ||
          err instanceof MfaSecretEncryptionConfigError) {
        throw new AuthError(500, "mfa_secret_corrupt",
          "MFA secret could not be decoded");
      }
      throw err;
    }

    const secretBase32 = base32Encode(rawSecret);
    const ok = verifyTotp({ secretBase32, code: input.code, now });
    if (!ok) {
      const newCount = await mfaUsers.incrementFailedAttempts(client, input.userId);
      await recordActivity(client, {
        orgId:       input.orgId,
        actorUserId: input.userId,
        action:      "mfa.failed_attempt",
        targetType:  "user",
        targetId:    input.userId,
        payload: {
          flow:                 "disable",
          failed_attempt_count: newCount,
        },
      });
      if (newCount >= MFA_LOCKOUT_THRESHOLD) {
        const lockedUntil = new Date(now.getTime() + MFA_LOCKOUT_DURATION_MS);
        await mfaUsers.setLockedUntil(client, input.userId, lockedUntil);
        await recordActivity(client, {
          orgId:       input.orgId,
          actorUserId: input.userId,
          action:      "mfa.locked",
          targetType:  "user",
          targetId:    input.userId,
          payload: {
            flow:         "disable",
            locked_until: lockedUntil,
          },
        });
        throw new CommitAuthError(423, "mfa_locked",
          "MFA temporarily locked due to too many failed attempts");
      }
      throw new CommitAuthError(401, "mfa_invalid_code", "invalid TOTP code");
    }

    // Drop the secret triple + key_version + enabled_at + counters in
    // one UPDATE. Current session's mfa_verified_at / mfa_method are
    // intentionally NOT cleared.
    //
    // Policy: an MFA-stamped session keeps its stamp until expiry or
    // logout — that record is an audit fact about how the session was
    // established, and `assertRefreshMfaGate` deliberately short-
    // circuits ("session.mfa_verified_at !== null → pass") to preserve
    // continuity for the active rotation chain. So a user who disables
    // MFA in this tab keeps refreshing cleanly through their current
    // refresh family; any FUTURE login (password-only because MFA is
    // off now) creates a fresh non-MFA session, and if an admin later
    // flips `mfa_required=true` again, refresh on those new sessions
    // hits the gate as expected. Clearing the stamp here would also
    // force a contortion to keep the both-or-neither check-constraint
    // pairing intact without breaking the active session.
    await mfaUsers.clearMfa(client, input.userId);

    // Phase 7 Step 3 — audit successful disable. self-disable, so
    // actor=target. Helper writes action='mfa.disabled', target_type=
    // 'user', payload={method:'totp'}.
    await recordMfaDisabled(client, {
      orgId:        input.orgId,
      actorUserId:  input.userId,
      targetUserId: input.userId,
      method:       "totp",
    });

    await client.query("COMMIT");
    client.release();
    return;
  } catch (err) {
    if (err instanceof CommitAuthError) {
      try {
        await client.query("COMMIT");
        client.release();
      } catch {
        client.release(err as Error);
      }
      throw err;
    }
    try {
      await client.query("ROLLBACK");
      client.release();
    } catch (rollbackErr) {
      client.release(rollbackErr as Error);
    }
    throw err;
  }
}

// Phase 7 Step 2 — refresh-time MFA gate.
//
// Plan §2.5: if the current org/user requires MFA but the session whose
// refresh token we're trying to rotate was never MFA-verified
// (mfa_verified_at IS NULL), do NOT issue a new access token. The session
// row + token family stay intact so the user can re-login through the
// proper TOTP flow without an admin having to manually rebuild trust;
// the route layer's existing 401 clearCookie still drops the now-useless
// cookie from the browser.
//
// MFA-verified sessions skip the gate entirely — they represent a
// completed factor confirmation and refresh just rotates them.
//
// `loadLoginMfaState` lives in this file and reads users + organizations
// (both non-RLS-scoped), so no GUC setup is required up here. The caller
// has already pinned the GUC inside `getSessionMembershipRole` for its
// own membership check.
async function assertRefreshMfaGate(
  client: PoolClient,
  session: AuthSession,
): Promise<void> {
  if (session.mfa_verified_at !== null) return;
  const state = await loadLoginMfaState(client, {
    userId: session.user_id,
    orgId:  session.org_id,
  });
  if (state.userMfaEnabledAt !== null || state.orgRequiresMfa) {
    // Phase 7 Step 3 — record the gated refresh. CommitAuthError makes
    // the withTransaction wrapper COMMIT before re-raising so the audit
    // row persists; the original plan §2.5 "no UPDATE/INSERT lingers"
    // intent is preserved because the only DB write on this path IS
    // the audit row (the refresh path never touched sessions/auth_tokens
    // before we got here). Family revoke is still NOT issued.
    //
    // GUC is already pinned on session.org_id by the upstream
    // getSessionMembershipRole call in refresh() (both the grace branch
    // and the fresh-rotation branch run it before this gate).
    //
    // payload is reason-only — no refresh token, no session token, no
    // raw cookie material. target_type=session anchors the audit row to
    // the session whose rotation was blocked, so an admin can pivot
    // "which session got bounced" via the org+target index.
    await recordActivity(client, {
      orgId:       session.org_id,
      actorUserId: session.user_id,
      action:      "auth.refresh_mfa_required",
      targetType:  "session",
      targetId:    session.id,
      payload: {
        reason: state.userMfaEnabledAt !== null
          ? "user_mfa_enabled_session_not_verified"
          : "org_mfa_required_session_not_verified",
      },
    });
    throw new CommitAuthError(401, "mfa_required", "MFA verification required");
  }
}

export async function refresh(refreshToken: string): Promise<RefreshResult> {
  return withTransaction(async (client) => {
    const session = await findByRefreshTokenHashForUpdate(
      client,
      hashRefreshToken(refreshToken),
    );
    if (!session) {
      throw new AuthError(401, "invalid_refresh", "invalid refresh token");
    }

    const now = new Date();
    if (session.revoked_at) {
      const withinGrace =
        session.replaced_by_session_id !== null &&
        now.getTime() - session.revoked_at.getTime() <=
          authEnv.refreshGraceWindowSeconds * 1000;

      if (!withinGrace) {
        await revokeTokenFamily(client, {
          tokenFamilyId: session.token_family_id,
          reason: "reuse_detected",
        });
        throw new CommitAuthError(
          401,
          "invalid_refresh",
          "invalid refresh token",
        );
      }

      const replacement = await getByIdForUpdate(
        client,
        session.replaced_by_session_id!,
      );
      if (!replacement || replacement.revoked_at || replacement.expires_at <= now) {
        await revokeTokenFamily(client, {
          tokenFamilyId: session.token_family_id,
          reason: "reuse_detected",
        });
        throw new CommitAuthError(
          401,
          "invalid_refresh",
          "invalid refresh token",
        );
      }

      const role = await getSessionMembershipRole(client, replacement);
      // Phase 7 Step 2 — gate the grace return on the REPLACEMENT
      // session's MFA fields (it's the row backing the access token we
      // would issue here). The original `session` is already rotated;
      // its mfa_verified_at no longer matters for this call.
      await assertRefreshMfaGate(client, replacement);
      await touchLastUsed(client, replacement.id);
      return {
        session: replacement,
        accessPayload: buildAccessPayload(replacement, role),
      };
    }

    if (session.expires_at <= now) {
      throw new AuthError(401, "invalid_refresh", "invalid refresh token");
    }

    let role: MembershipRole;
    try {
      role = await getSessionMembershipRole(client, session);
    } catch (err) {
      await revokeTokenFamily(client, {
        tokenFamilyId: session.token_family_id,
        reason: "membership_inactive",
      });
      if (err instanceof AuthError) {
        throw new CommitAuthError(err.statusCode, err.code, err.message);
      }
      throw err;
    }

    // Phase 7 Step 2 — gate the fresh-rotation path on the LEASED
    // session's MFA fields. If the gate trips, it commits only the
    // auth.refresh_mfa_required audit row before rethrowing; the family
    // and the leased row stay untouched.
    await assertRefreshMfaGate(client, session);

    const replacement = await createSessionWithToken(client, {
      userId: session.user_id,
      orgId: session.org_id,
      membershipId: session.membership_id,
      userAgent: session.user_agent,
      ip: session.ip,
      tokenFamilyId: session.token_family_id,
      // Phase 7 Step 2 — forward the MFA verification stamps so the
      // replacement carries the same factor record across rotation.
      // Both fields move together (the sessions repository enforces
      // both-or-neither at the boundary), and on a password-only
      // session both are null which is exactly the legacy shape.
      mfaVerifiedAt: session.mfa_verified_at,
      mfaMethod:     session.mfa_method,
    });

    await revokeSession(client, {
      sessionId: session.id,
      reason: "rotated",
      replacedBySessionId: replacement.session.id,
    });

    return {
      session: replacement.session,
      accessPayload: buildAccessPayload(replacement.session, role),
      refreshToken: replacement.refreshToken,
    };
  });
}

export async function logout(refreshToken?: string): Promise<void> {
  if (!refreshToken) return;

  await withTransaction(async (client) => {
    const session = await findByRefreshTokenHashForUpdate(
      client,
      hashRefreshToken(refreshToken),
    );
    if (session) {
      await revokeSession(client, {
        sessionId: session.id,
        reason: "logout",
      });
    }
  });
}

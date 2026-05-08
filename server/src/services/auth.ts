import crypto from "node:crypto";
import argon2 from "argon2";
import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";
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
  revokeSession,
  revokeTokenFamily,
  touchLastUsed,
  type AuthSession,
} from "../repositories/sessions.js";

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

async function listActiveMembershipsAcrossOrgs(
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
    throw new AuthError(401, "invalid_credentials", "invalid credentials");
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

function buildAccessPayload(
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

async function createSessionWithToken(
  client: PoolClient,
  input: {
    userId: string;
    orgId: string;
    membershipId: string;
    userAgent?: string | null;
    ip?: string | null;
    tokenFamilyId?: string;
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

export async function login(input: {
  email: string;
  password: string;
  orgId?: string;
  userAgent?: string | null;
  ip?: string | null;
}): Promise<AuthResult> {
  return withTransaction(async (client) => {
    const user = await getByEmailWithPasswordHash(client, input.email);
    if (!user || user.disabled_at) {
      throw new AuthError(401, "invalid_credentials", "invalid credentials");
    }

    const ok = await verifyPassword(user.password_hash, input.password);
    if (!ok) {
      throw new AuthError(401, "invalid_credentials", "invalid credentials");
    }

    const { membership, organization } = await resolveMembershipForLogin(client, {
      userId: user.id,
      orgId: input.orgId,
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

    const replacement = await createSessionWithToken(client, {
      userId: session.user_id,
      orgId: session.org_id,
      membershipId: session.membership_id,
      userAgent: session.user_agent,
      ip: session.ip,
      tokenFamilyId: session.token_family_id,
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

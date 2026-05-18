/* Invitation service.
 *
 * Phase 3 Step 5. Plan: docs/plan/phase-3/PHASE_3_STEP_5_INVITATION_API.md §2~6.
 *
 * Five public functions:
 *   - createInvitation             (admin → POST /invitations)
 *   - listActivePendingInvitations (admin → GET /invitations)
 *   - resendInvitation             (admin → POST /:id/resend)
 *   - cancelInvitation             (admin → DELETE /:id)
 *   - acceptInvitation             (anonymous → POST /accept)
 *
 * Lock order across ALL functions:
 *     invitations row → auth_tokens row
 * Unifying the order prevents cross-flow deadlock (cancel↔accept etc.).
 *
 * Pool choice:
 *   - createInvitation / list / resend / cancel: app pool, caller wraps
 *     withOrgContext (RLS enforces same-org access).
 *   - acceptInvitation: servicePool wrapper (BYPASSRLS) — token is the
 *     only server-side identity. No org context to set.
 *
 * Error mapping:
 *   - 409 invitation_already_pending — duplicate live pending OR partial
 *     unique 23505 race.
 *   - 409 invitation_already_finalized — resend/cancel target already
 *     accepted or canceled.
 *   - 409 already_member             — email already has a membership in
 *     the target org (pre-guard + memberships 23505 race fallback).
 *   - 409 account_disabled           — accept-time existing user has
 *     users.disabled_at set.
 *   - 400 invalid_team               — POST /invitations teamId in a
 *     different org / non-existent.
 *   - 404 not_found                  — resend/cancel id doesn't exist
 *     (RLS or genuine).
 *   - 410 token_* (via accept)       — collapsed to 410 generic by route.
 *
 * accept's 409 ROLLBACKs the entire tx so the token is NOT consumed —
 * retrying the same token yields the same 409 until the underlying
 * condition is resolved.
 */
import type { PoolClient } from "pg";
import { getServicePool } from "../db/servicePool.js";
import {
  AuthError,
  buildAccessPayload,
  createSessionWithToken,
  hashPassword,
  type AccessTokenPayload,
  type AuthMembership,
  type AuthOrganization,
  type AuthResult,
} from "./auth.js";
import {
  findTokenByRaw,
  lockAndValidateTokenById,
  markTokenConsumed,
  mintToken,
  TTL_INVITATION_MS,
} from "./auth-tokens.js";
import {
  buildAcceptInvitationUrl,
  emailProvider,
} from "./email.js";
import {
  cancelInvitationRow,
  createInvitationRow,
  findActiveTokenByInvitationForUpdate,
  findPendingByOrgEmailForUpdate,
  getByIdForUpdate,
  getListItemById,
  listActivePendingForCurrentOrg,
  markAcceptedRow,
  touchLastSentAt,
  type InvitationListItem,
  type InvitationRow,
} from "../repositories/invitations.js";
import type { MembershipRole } from "../repositories/memberships.js";
import type { PublicAuthUser } from "../repositories/authUsers.js";
import {
  recordActivityVoid,
  recordInvitationCancelled,
  recordInvitationCreated,
  recordInvitationResent,
} from "./activityLog.js";
import {
  assertPlanAllows,
  BILLING_PLAN_LIMITS,
  PlanLimitExceededError,
} from "./billing.js";
const PARTIAL_UNIQUE_INVITATION_IDX = "invitations_active_org_email_idx";

function is23505(err: unknown, constraint?: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as Record<string, unknown>;
  if (e.code !== "23505") return false;
  if (!constraint) return true;
  return e.constraint === constraint;
}

// ===========================================================================
// createInvitation — POST /invitations
// ===========================================================================

export interface CreateInvitationInput {
  email: string;
  role: MembershipRole;
  teamId?: string | null;
}

export async function createInvitation(
  client: PoolClient,
  orgId: string,
  invitedByUserId: string,
  input: CreateInvitationInput,
): Promise<{ invitation: InvitationListItem; rawToken: string }> {
  const email = input.email.trim().toLowerCase();
  const teamId = input.teamId ?? null;

  // 1) teamId belongs to same org? RLS makes the SELECT auto-scope.
  if (teamId !== null) {
    const t = await client.query<{ one: number }>(
      `SELECT 1 AS one FROM teams WHERE id = $1`,
      [teamId],
    );
    if (t.rows.length === 0) {
      throw new AuthError(400, "invalid_team",
        "team is not in this organization");
    }
  }

  // 2) already_member pre-guard. lower(email) matches active OR disabled
  //    membership in the same org → 409. RLS-scoped memberships.
  const m = await client.query<{ one: number }>(
    `SELECT 1 AS one FROM memberships ms
       JOIN users u ON u.id = ms.user_id
      WHERE ms.org_id = $1
        AND lower(u.email::text) = lower($2)
      LIMIT 1`,
    [orgId, email],
  );
  if (m.rows.length > 0) {
    throw new AuthError(409, "already_member",
      "user is already a member of this organization");
  }

  // 3) Lock the (org, lower(email)) active pending row, if any. Anyone
  //    else trying to insert the same pair will wait for our tx.
  const existing = await findPendingByOrgEmailForUpdate(client, orgId, email);
  if (existing) {
    // Then look at its paired token row to decide live vs expired.
    const token = await findActiveTokenByInvitationForUpdate(client, existing.id);
    const live = token !== null && token.expires_at > new Date();
    if (live) {
      throw new AuthError(409, "invitation_already_pending",
        "an active invitation already exists for this email");
    }
    // Expired pending — auto-cancel old, fall through to new invite.
    // (a) cancel the old invitation row
    // (b) invalidate the old token row (if any — may be NULL if it was
    //     already invalidated for some other reason)
    await cancelInvitationRow(client, existing.id);
    if (token) {
      await client.query(
        `UPDATE auth_tokens SET invalidated_at = now() WHERE id = $1`,
        [token.id],
      );
    }
    // After this point the partial unique index no longer matches the old
    // row (canceled_at IS NOT NULL), so the INSERT below is safe.
  }

  // Phase 7 Step 9 — seats cap. Locks the org row + counts
  // active_members + pending_invitations; throws PlanLimitExceededError
  // if this invitation would push us past the plan's seat cap. This must
  // run AFTER the same-email pending check above:
  //
  //   - live pending duplicate should return invitation_already_pending,
  //     not plan_limit_exceeded just because that pending row already
  //     consumes the last starter seat.
  //   - expired pending replacement first cancels the old row, then adds
  //     the new one, so the net seat count is unchanged and should be
  //     allowed at cap.
  //
  // The order is still "cap check → new row write → audit" for the
  // actual INSERT below.
  await assertPlanAllows(client, { limitKey: "seats", increment: 1 });

  // 4) INSERT new invitation. 23505 on partial unique is the race fallback
  //    (two concurrent admins both passed step 3 simultaneously).
  let invitation: InvitationRow;
  try {
    invitation = await createInvitationRow(client, {
      orgId,
      email,
      role: input.role,
      teamId,
      invitedByUserId,
    });
  } catch (err) {
    if (is23505(err, PARTIAL_UNIQUE_INVITATION_IDX)) {
      throw new AuthError(409, "invitation_already_pending",
        "an active invitation already exists for this email");
    }
    throw err;
  }

  // 5) Mint the matching auth_tokens row (7d TTL, UNIQUE partial on
  //    invitation_id is naturally satisfied — we just canceled the old).
  const tok = await mintToken({
    client,
    orgId,
    invitationId: invitation.id,
    purpose: "invitation",
    ttlMs: TTL_INVITATION_MS,
  });

  // Phase 7 Step 3 — audit invitation.created. Same transaction as the
  // invitation/token INSERTs + email outbox write (below), so an audit
  // failure rolls the whole invite back. Payload deliberately carries
  // role + team_id only — no email, no raw token, no acceptUrl.
  await recordInvitationCreated(client, {
    orgId,
    actorUserId:  invitedByUserId,
    invitationId: invitation.id,
    role:         input.role,
    teamId,
  });

  // 6) Send the invitation email (writes the outbox row inside this tx).
  const inviter = await client.query<{ name: string }>(
    `SELECT name FROM users WHERE id = $1`,
    [invitedByUserId],
  );
  const org = await client.query<{ name: string }>(
    `SELECT name FROM organizations WHERE id = $1`,
    [orgId],
  );
  await emailProvider.sendInvitationEmail({
    client,
    orgId,
    toEmail: email,
    toName: email,
    inviterName: inviter.rows[0]?.name ?? "Kloser admin",
    organizationName: org.rows[0]?.name ?? "Kloser",
    acceptUrl: buildAcceptInvitationUrl(tok.rawToken),
    invitationId: invitation.id,
    rawToken: tok.rawToken,
  });

  // Read back the row in the canonical Invitation shape (joins teams +
  // inviter + active token expires_at). Same shape as GET /invitations
  // items so clients can render the create response uniformly.
  const listItem = await getListItemById(client, invitation.id);
  if (!listItem) {
    // Should be unreachable — we just inserted the invitation + token.
    throw new AuthError(500, "create_internal_inconsistency",
      "invitation row missing after insert");
  }
  return { invitation: listItem, rawToken: tok.rawToken };
}

// ===========================================================================
// listActivePendingInvitations — GET /invitations
// ===========================================================================

export async function listActivePendingInvitations(
  client: PoolClient,
): Promise<InvitationListItem[]> {
  return listActivePendingForCurrentOrg(client);
}

// ===========================================================================
// resendInvitation — POST /invitations/:id/resend
// ===========================================================================

export async function resendInvitation(
  client: PoolClient,
  orgId: string,
  invitationId: string,
  // Phase 7 Step 3 — actor for invitation.resent audit row. POST /:id/
  // resend is admin-only at the route layer, so request.user.id is
  // always populated.
  actorUserId: string,
): Promise<void> {
  // Lock order: invitations first.
  const row = await getByIdForUpdate(client, invitationId);
  if (!row) {
    // RLS-scoped: a cross-org id shows up as 404, not 403 — same contract
    // as Step 4 PATCH /memberships/:id and team PATCH.
    throw new AuthError(404, "not_found", "invitation not found");
  }
  if (row.accepted_at || row.canceled_at) {
    throw new AuthError(409, "invitation_already_finalized",
      "invitation is already accepted or canceled");
  }

  // Invalidate the prior active token (if any). Both consumed_at and
  // expired tokens stay alone — only `active` rows match the partial idx,
  // so the new mintToken won't collide.
  const existing = await findActiveTokenByInvitationForUpdate(client, row.id);
  if (existing) {
    await client.query(
      `UPDATE auth_tokens SET invalidated_at = now() WHERE id = $1`,
      [existing.id],
    );
  }

  // Mint a fresh 7d token.
  const tok = await mintToken({
    client,
    orgId,
    invitationId: row.id,
    purpose: "invitation",
    ttlMs: TTL_INVITATION_MS,
  });

  // Bump last_sent_at and write a new outbox row.
  await touchLastSentAt(client, row.id);

  const inviter = row.invited_by_user_id
    ? await client.query<{ name: string }>(
        `SELECT name FROM users WHERE id = $1`,
        [row.invited_by_user_id],
      )
    : null;
  const org = await client.query<{ name: string }>(
    `SELECT name FROM organizations WHERE id = $1`,
    [orgId],
  );
  await emailProvider.sendInvitationEmail({
    client,
    orgId,
    toEmail: row.email,
    toName: row.email,
    inviterName: inviter?.rows[0]?.name ?? "Kloser admin",
    organizationName: org.rows[0]?.name ?? "Kloser",
    acceptUrl: buildAcceptInvitationUrl(tok.rawToken),
    invitationId: row.id,
    rawToken: tok.rawToken,
  });

  // Phase 7 Step 3 — audit invitation.resent. payload carries the
  // invitation id only; no raw token, no acceptUrl, no email.
  await recordInvitationResent(client, {
    orgId,
    actorUserId,
    invitationId: row.id,
  });
}

// ===========================================================================
// cancelInvitation — DELETE /invitations/:id
// ===========================================================================

export async function cancelInvitation(
  client: PoolClient,
  invitationId: string,
  // Phase 7 Step 3 — orgId + actor for the audit row. orgId is needed
  // because the audit row's org_id column must be set explicitly; the
  // service no longer relies on `current_app_org_id()` for the audit
  // insert. DELETE /:id is admin-only at the route layer.
  audit: { orgId: string; actorUserId: string },
): Promise<void> {
  // Lock order: invitations first.
  const row = await getByIdForUpdate(client, invitationId);
  if (!row) {
    throw new AuthError(404, "not_found", "invitation not found");
  }
  if (row.accepted_at || row.canceled_at) {
    throw new AuthError(409, "invitation_already_finalized",
      "invitation is already accepted or canceled");
  }

  await cancelInvitationRow(client, row.id);

  // Invalidate the paired active token so the old raw can't accept.
  const existing = await findActiveTokenByInvitationForUpdate(client, row.id);
  if (existing) {
    await client.query(
      `UPDATE auth_tokens SET invalidated_at = now() WHERE id = $1`,
      [existing.id],
    );
  }

  // Phase 7 Step 3 — audit invitation.cancelled. payload carries the
  // invitation id only; no raw token, no acceptUrl, no email.
  await recordInvitationCancelled(client, {
    orgId:        audit.orgId,
    actorUserId:  audit.actorUserId,
    invitationId: row.id,
  });
}

// ===========================================================================
// acceptInvitation — POST /invitations/accept
// ===========================================================================

export interface AcceptInvitationInput {
  rawToken: string;
  name: string;
  password: string;
  userAgent?: string | null;
  ip?: string | null;
}

export interface AcceptInvitationResult {
  created: boolean;
  result: AuthResult;
}

interface InvitationAcceptRow {
  id: string;
  org_id: string;
  email: string;
  role: MembershipRole;
  team_id: string | null;
  accepted_at: Date | null;
  canceled_at: Date | null;
}

interface ExistingUserRow {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  email_verified_at: Date | null;
  disabled_at: Date | null;
}

const MEMBERSHIPS_USER_ORG_UNIQUE_RE = /memberships.*org_id.*user_id|user_id.*org_id/i;

function isMembershipUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as Record<string, unknown>;
  if (e.code !== "23505") return false;
  // The phase 1 schema declares the constraint as `UNIQUE (org_id, user_id)`
  // without a custom name — pg may surface it as the table's auto-named
  // constraint. Match liberally on (org_id, user_id) phrasing.
  const detail = typeof e.detail === "string" ? e.detail : "";
  const constraint = typeof e.constraint === "string" ? e.constraint : "";
  return MEMBERSHIPS_USER_ORG_UNIQUE_RE.test(detail) ||
         MEMBERSHIPS_USER_ORG_UNIQUE_RE.test(constraint);
}

export async function acceptInvitation(
  input: AcceptInvitationInput,
): Promise<AcceptInvitationResult> {
  // argon2id runs OUTSIDE the transaction — long-running hash + idle pool
  // connection wastes resources. The race window is fine: any state that
  // matters is re-checked inside the tx (token lock, user re-lookup, etc.)
  const passwordHash = await hashPassword(input.password);

  const client = await getServicePool().connect();
  let outcome: AcceptInvitationResult;
  try {
    await client.query("BEGIN");

    // (1) Token row identifier (no lock). lock order: invitations →
    // auth_tokens (cancel/resend hold the same order). If we locked the
    // token first we'd deadlock against a concurrent cancel.
    const tok = await findTokenByRaw(client, input.rawToken, "invitation");
    if (!tok) {
      throw new AuthError(404, "token_not_found", "invitation token not found");
    }
    if (!tok.invitationId) {
      // CHECK auth_tokens_invitation_purpose_check forces invitation
      // purpose rows to carry invitation_id NOT NULL. Defensive.
      throw new AuthError(500, "accept_internal_inconsistency",
        "invitation token missing invitation_id");
    }

    // (2) invitations FOR UPDATE (same lock order as cancel/resend).
    const invRes = await client.query<InvitationAcceptRow>(
      `SELECT id, org_id, email, role, team_id, accepted_at, canceled_at
         FROM invitations WHERE id = $1 FOR UPDATE`,
      [tok.invitationId],
    );
    const inv = invRes.rows[0];
    if (!inv || inv.accepted_at || inv.canceled_at) {
      // Concurrent-accept serialized branch — second arrival sees the
      // first commit's accepted_at. Collapse to 410 generic.
      throw new AuthError(410, "token_invalidated", "invitation finalized");
    }

    // (3) auth_tokens FOR UPDATE + validity re-check. Between (1) and
    // here, a concurrent cancel/resend could have flipped invalidated_at;
    // this catches it.
    await lockAndValidateTokenById(client, tok.tokenId, "invitation");

    // Phase 7 Step 9 — seats cap re-check at accept time. Accept doesn't
    // increase total seats (one pending → one active is net zero), so
    // this guard only trips when:
    //   (a) the plan was downgraded between invite create and accept, or
    //   (b) the seat count already exceeds the cap for some other reason
    //       (admin direct DB edit, etc.).
    // We run on servicePool which BYPASSRLS — direct id-scoped counts
    // are correct here; the GUC-based `assertPlanAllows` would not work
    // because servicePool transactions don't set `app.org_id`.
    // Plain SELECT (no FOR UPDATE) — servicePool role lacks UPDATE on
    // organizations, and accept is net-zero seat impact anyway (one
    // pending → one active = same total). A concurrent accept that
    // overshoots would still resolve to the same total, so the locked
    // count is unnecessary here.
    const planLockRes = await client.query<{ plan: keyof typeof BILLING_PLAN_LIMITS }>(
      `SELECT plan FROM organizations WHERE id = $1`,
      [inv.org_id],
    );
    const orgPlan = planLockRes.rows[0]?.plan;
    if (!orgPlan) {
      throw new AuthError(500, "accept_internal_inconsistency",
        "organization row missing after token lock");
    }
    const seatLimit = BILLING_PLAN_LIMITS[orgPlan].seats;
    if (seatLimit !== null) {
      const seatCountRes = await client.query<{
        active: number;
        pending: number;
      }>(
        `SELECT
           (SELECT count(*)::int FROM memberships
             WHERE org_id = $1 AND status = 'active') AS active,
           (SELECT count(*)::int FROM invitations
             WHERE org_id = $1
               AND accepted_at IS NULL
               AND canceled_at IS NULL) AS pending`,
        [inv.org_id],
      );
      const seats =
        seatCountRes.rows[0]!.active + seatCountRes.rows[0]!.pending;
      // After accept: pending -1, active +1 → seat count unchanged.
      // So we reject when the existing seat count is already over cap.
      if (seats > seatLimit) {
        throw new PlanLimitExceededError({
          limitKey: "seats",
          plan: orgPlan,
          current: seats,
          limit: seatLimit,
          attempted: seats,
        });
      }
    }

    // (4) Existing user lookup. users is NOT RLS-scoped — direct SELECT.
    // Include disabled_at to gate global-disabled accept attempts.
    const existingRes = await client.query<ExistingUserRow>(
      `SELECT id, email, name, avatar_url, email_verified_at, disabled_at
         FROM users WHERE email = $1`,
      [inv.email],
    );
    let userId: string;
    let isNew = false;
    let publicUser: PublicAuthUser;

    const existing = existingRes.rows[0];
    if (existing) {
      if (existing.disabled_at) {
        // ROLLBACK → token still active → retrying same token yields the
        // same 409 until admin re-enables the user (or never).
        throw new AuthError(409, "account_disabled",
          "user account is disabled");
      }
      userId = existing.id;

      // Pre-check membership. Avoids the noisier 23505 path on the common
      // "already invited" case. RLS off in servicePool, so query org_id
      // explicitly.
      const m = await client.query<{ one: number }>(
        `SELECT 1 AS one FROM memberships
          WHERE org_id = $1 AND user_id = $2
          LIMIT 1`,
        [inv.org_id, existing.id],
      );
      if (m.rows.length > 0) {
        throw new AuthError(409, "already_member",
          "user is already a member of this organization");
      }
      publicUser = {
        id: existing.id,
        email: existing.email,
        name: existing.name,
        avatar_url: existing.avatar_url,
        email_verified_at: existing.email_verified_at,
      };
    } else {
      // (5) New user INSERT. Concurrent two-org accept on the same brand-
      // new email could 23505 on users.email — handled via ON CONFLICT
      // DO NOTHING + re-lookup → fall through to multi-org membership.
      const created = await client.query<{
        id: string;
        email: string;
        name: string;
        avatar_url: string | null;
        email_verified_at: Date;
      }>(
        `INSERT INTO users (email, password_hash, name, email_verified_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (email) DO NOTHING
         RETURNING id, email, name, avatar_url, email_verified_at`,
        [inv.email, passwordHash, input.name],
      );
      if (created.rows.length > 0) {
        const row = created.rows[0]!;
        userId = row.id;
        isNew = true;
        publicUser = {
          id: row.id,
          email: row.email,
          name: row.name,
          avatar_url: row.avatar_url,
          email_verified_at: row.email_verified_at,
        };
      } else {
        // Race: another tx just inserted this email. Re-lookup, gate on
        // disabled_at / already_member, then fall through to multi-org.
        const refound = await client.query<ExistingUserRow>(
          `SELECT id, email, name, avatar_url, email_verified_at, disabled_at
             FROM users WHERE email = $1`,
          [inv.email],
        );
        const row = refound.rows[0];
        if (!row) {
          throw new AuthError(500, "accept_internal_inconsistency",
            "user not found after ON CONFLICT DO NOTHING");
        }
        if (row.disabled_at) {
          throw new AuthError(409, "account_disabled",
            "user account is disabled");
        }
        const m2 = await client.query<{ one: number }>(
          `SELECT 1 AS one FROM memberships
            WHERE org_id = $1 AND user_id = $2
            LIMIT 1`,
          [inv.org_id, row.id],
        );
        if (m2.rows.length > 0) {
          throw new AuthError(409, "already_member",
            "user is already a member of this organization");
        }
        userId = row.id;
        publicUser = {
          id: row.id,
          email: row.email,
          name: row.name,
          avatar_url: row.avatar_url,
          email_verified_at: row.email_verified_at,
        };
      }
    }

    // (6) team_id: copy as-is from invitation. invitations.team_id
    // REFERENCES teams(id) ON DELETE SET NULL → if team was deleted
    // between create and accept, invitation.team_id is already NULL.
    // No teams SELECT here (servicePool grant table excludes teams).
    const teamIdForMembership = inv.team_id;

    // (7) Membership INSERT. Race fallback: 23505 on UNIQUE
    // (org_id, user_id) → 409 already_member.
    let membership: AuthMembership;
    try {
      const ins = await client.query<AuthMembership>(
        `INSERT INTO memberships (org_id, user_id, role, team_id, status)
         VALUES ($1, $2, $3, $4, 'active')
         RETURNING id, org_id, user_id, role, status`,
        [inv.org_id, userId, inv.role, teamIdForMembership],
      );
      membership = ins.rows[0]!;
    } catch (err) {
      if (isMembershipUniqueViolation(err)) {
        throw new AuthError(409, "already_member",
          "user is already a member of this organization");
      }
      throw err;
    }

    // (8) Mark invitation accepted.
    await markAcceptedRow(client, inv.id);

    // (9) Session + refresh token (sessions table — refresh stored there).
    const { session, refreshToken } = await createSessionWithToken(client, {
      userId,
      orgId: inv.org_id,
      membershipId: membership.id,
      userAgent: input.userAgent,
      ip: input.ip,
    });

    // (10) Token consume mark — final mutation in happy path. From here
    // any ROLLBACK undoes consume, but at this point only post-commit
    // failures can interfere (and we go straight to COMMIT below).
    await markTokenConsumed(client, tok.tokenId);

    // Phase 7 Step 3 — audit invitation.accepted. recordActivityVoid
    // because this runs on the servicePool whose role has INSERT-only
    // privilege on activity_log (no RETURNING allowed). actor=user who
    // just accepted (they are the subject of the new membership too).
    // Payload carries the operational shape — invitation/membership/
    // role/team — but no email, no raw token, no acceptUrl, no
    // password (already discarded as hash above).
    await recordActivityVoid(client, {
      orgId:       inv.org_id,
      actorUserId: userId,
      action:      "invitation.accepted",
      targetType:  "invitation",
      targetId:    inv.id,
      payload: {
        invitation_id: inv.id,
        membership_id: membership.id,
        role:          inv.role,
        team_id:       teamIdForMembership,
      },
    });

    // (11) Organization metadata for AuthResult.
    const orgRes = await client.query<AuthOrganization>(
      `SELECT id, name, plan FROM organizations WHERE id = $1`,
      [inv.org_id],
    );
    const organization = orgRes.rows[0]!;

    const accessPayload: AccessTokenPayload = buildAccessPayload(
      session,
      membership.role,
    );

    outcome = {
      created: isNew,
      result: {
        user: publicUser,
        organization,
        membership,
        session,
        accessPayload,
        refreshToken,
      },
    };
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
  return outcome;
}

export type { InvitationListItem, InvitationRow };

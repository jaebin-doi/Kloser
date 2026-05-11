/* invitations repository.
 *
 * Phase 3 Step 5. Plan: docs/plan/phase-3/PHASE_3_STEP_5_INVITATION_API.md §2~6.
 *
 * invitations has RLS FORCED — every read/write through this module from
 * the app pool runs inside withOrgContext, so an explicit org_id filter is
 * NOT needed for the SELECT/UPDATE paths. The cross-org accept flow uses
 * servicePool (BYPASSRLS); its queries pass org_id explicitly to scope
 * results manually.
 *
 * Lock order across the invitations API is `invitations → auth_tokens`
 * (cancel / resend / accept all serialize the same way) — preventing
 * cross-flow deadlock (Step 5 plan §6.1 race table).
 */
import type { PoolClient } from "pg";
import type { MembershipRole } from "./memberships.js";

export interface InvitationRow {
  id: string;
  org_id: string;
  email: string;
  role: MembershipRole;
  team_id: string | null;
  invited_by_user_id: string | null;
  accepted_at: Date | null;
  canceled_at: Date | null;
  last_sent_at: Date;
  created_at: Date;
}

export interface InvitationListItem {
  id: string;
  org_id: string;
  email: string;
  role: MembershipRole;
  team_id: string | null;
  team_name: string | null;
  invited_by_user_id: string | null;
  invited_by_name: string | null;
  last_sent_at: Date;
  token_expires_at: Date;
  created_at: Date;
}

const INVITATION_COLUMNS =
  "id, org_id, email, role, team_id, invited_by_user_id, " +
  "accepted_at, canceled_at, last_sent_at, created_at";

// ---------------------------------------------------------------------------
// Pending lookup with FOR UPDATE (createInvitation step 3)
// ---------------------------------------------------------------------------

/** Lock the (org, lower(email)) active pending invitation row, if any.
 *  Returns null when no row matches — caller continues with a fresh INSERT.
 *  RLS-scoped: must run inside withOrgContext. */
export async function findPendingByOrgEmailForUpdate(
  client: PoolClient,
  orgId: string,
  email: string,
): Promise<InvitationRow | null> {
  const r = await client.query<InvitationRow>(
    `SELECT ${INVITATION_COLUMNS}
       FROM invitations
      WHERE org_id = $1
        AND lower(email::text) = lower($2)
        AND accepted_at IS NULL
        AND canceled_at IS NULL
      FOR UPDATE`,
    [orgId, email],
  );
  return r.rows[0] ?? null;
}

/** Lock the active auth_tokens row paired with the given invitation id.
 *  Returns the (expires_at, invalidated/consumed) marker columns so the
 *  caller can decide live vs expired. NULL when no active token row
 *  exists (resend-after-cancel races, etc.). Uses RLS scope so a wrong-org
 *  query returns nothing. */
export async function findActiveTokenByInvitationForUpdate(
  client: PoolClient,
  invitationId: string,
): Promise<{
  id: string;
  expires_at: Date;
  consumed_at: Date | null;
  invalidated_at: Date | null;
} | null> {
  const r = await client.query<{
    id: string;
    expires_at: Date;
    consumed_at: Date | null;
    invalidated_at: Date | null;
  }>(
    `SELECT id, expires_at, consumed_at, invalidated_at
       FROM auth_tokens
      WHERE invitation_id  = $1
        AND purpose        = 'invitation'
        AND consumed_at    IS NULL
        AND invalidated_at IS NULL
      FOR UPDATE`,
    [invitationId],
  );
  return r.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// INSERT (createInvitation step 5)
// ---------------------------------------------------------------------------

export interface CreateInvitationRowInput {
  orgId: string;
  email: string;
  role: MembershipRole;
  teamId: string | null;
  invitedByUserId: string;
}

export async function createInvitationRow(
  client: PoolClient,
  input: CreateInvitationRowInput,
): Promise<InvitationRow> {
  const r = await client.query<InvitationRow>(
    `INSERT INTO invitations
       (org_id, email, role, team_id, invited_by_user_id, last_sent_at)
     VALUES ($1, $2, $3, $4, $5, now())
     RETURNING ${INVITATION_COLUMNS}`,
    [
      input.orgId,
      input.email,
      input.role,
      input.teamId,
      input.invitedByUserId,
    ],
  );
  return r.rows[0]!;
}

// ---------------------------------------------------------------------------
// Single-row mutations (cancel / mark accepted / touch last_sent_at)
// ---------------------------------------------------------------------------

// invitations has NO updated_at column (Phase 1 schema + Phase 3 §2-4
// boost only added team_id / invited_by_user_id / canceled_at /
// last_sent_at). The lifecycle markers below double as audit timestamps;
// there's no separate touch trigger.

export async function cancelInvitationRow(
  client: PoolClient,
  invitationId: string,
): Promise<void> {
  await client.query(
    `UPDATE invitations SET canceled_at = now() WHERE id = $1`,
    [invitationId],
  );
}

export async function markAcceptedRow(
  client: PoolClient,
  invitationId: string,
): Promise<void> {
  await client.query(
    `UPDATE invitations SET accepted_at = now() WHERE id = $1`,
    [invitationId],
  );
}

export async function touchLastSentAt(
  client: PoolClient,
  invitationId: string,
): Promise<void> {
  await client.query(
    `UPDATE invitations SET last_sent_at = now() WHERE id = $1`,
    [invitationId],
  );
}

// ---------------------------------------------------------------------------
// Single-row lookups (resend / cancel target read with FOR UPDATE)
// ---------------------------------------------------------------------------

export async function getByIdForUpdate(
  client: PoolClient,
  invitationId: string,
): Promise<InvitationRow | null> {
  const r = await client.query<InvitationRow>(
    `SELECT ${INVITATION_COLUMNS}
       FROM invitations WHERE id = $1 FOR UPDATE`,
    [invitationId],
  );
  return r.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// List (GET /invitations)
// ---------------------------------------------------------------------------

/** Single-row variant of listActivePendingForCurrentOrg — used by
 *  createInvitation / resendInvitation to shape the 201 / 200 response.
 *  Returns null if no active pending invitation row matches (canceled /
 *  accepted / no active token). RLS-scoped. */
export async function getListItemById(
  client: PoolClient,
  invitationId: string,
): Promise<InvitationListItem | null> {
  const r = await client.query<InvitationListItem>(
    `SELECT i.id, i.org_id, i.email, i.role, i.team_id,
            t.name AS team_name,
            i.invited_by_user_id,
            u.name AS invited_by_name,
            i.last_sent_at,
            at.expires_at AS token_expires_at,
            i.created_at
       FROM invitations i
       JOIN auth_tokens at
         ON at.invitation_id  = i.id
        AND at.purpose        = 'invitation'
        AND at.consumed_at    IS NULL
        AND at.invalidated_at IS NULL
       LEFT JOIN teams t ON t.id = i.team_id
       LEFT JOIN users u ON u.id = i.invited_by_user_id
      WHERE i.id = $1
        AND i.accepted_at IS NULL
        AND i.canceled_at IS NULL`,
    [invitationId],
  );
  return r.rows[0] ?? null;
}

/** Active pending list — invitation rows with a live (not consumed /
 *  not invalidated / not expired) invitation token. Joins teams +
 *  inviter user for display. RLS-scoped — caller wraps in withOrgContext. */
export async function listActivePendingForCurrentOrg(
  client: PoolClient,
): Promise<InvitationListItem[]> {
  const r = await client.query<{
    id: string;
    org_id: string;
    email: string;
    role: MembershipRole;
    team_id: string | null;
    team_name: string | null;
    invited_by_user_id: string | null;
    invited_by_name: string | null;
    last_sent_at: Date;
    token_expires_at: Date;
    created_at: Date;
  }>(
    `SELECT i.id, i.org_id, i.email, i.role, i.team_id,
            t.name AS team_name,
            i.invited_by_user_id,
            u.name AS invited_by_name,
            i.last_sent_at,
            at.expires_at AS token_expires_at,
            i.created_at
       FROM invitations i
       JOIN auth_tokens at
         ON at.invitation_id  = i.id
        AND at.purpose        = 'invitation'
        AND at.consumed_at    IS NULL
        AND at.invalidated_at IS NULL
       LEFT JOIN teams t ON t.id = i.team_id
       LEFT JOIN users u ON u.id = i.invited_by_user_id
      WHERE i.accepted_at IS NULL
        AND i.canceled_at IS NULL
        AND at.expires_at > now()
      ORDER BY i.created_at DESC`,
  );
  return r.rows;
}

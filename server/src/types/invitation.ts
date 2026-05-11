/* invitation shared types — server source-of-truth.
 *
 * Phase 3 Step 5. Plan: docs/plan/phase-3/PHASE_3_STEP_5_INVITATION_API.md §8.
 *
 * Sync target schemas (must keep top-level `export const X = z.object({ ... })`
 * literal form — no .extend / .merge / .partial / satisfies on these):
 *   - Invitation
 *   - InvitationCreateInput
 *   - InvitationAcceptInput
 *
 * The platform/types/invitation.js JSDoc mirror tracks the same field names;
 * test/sync_shared_types.mjs verifies parity.
 */
import { z } from "zod";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = z.string().regex(UUID_RE);

const ROLE = z.enum(["admin", "manager", "employee", "viewer"]);

// Response shape for GET /invitations + POST /invitations 201 body.
// last_sent_at and token_expires_at are ISO strings on the wire.
export const Invitation = z.object({
  id:                  z.string(),
  org_id:              z.string(),
  email:               z.string(),
  role:                ROLE,
  team_id:             z.string().nullable(),
  team_name:           z.string().nullable(),
  invited_by_user_id:  z.string().nullable(),
  invited_by_name:     z.string().nullable(),
  last_sent_at:        z.string(),
  token_expires_at:    z.string(),
  created_at:          z.string(),
});

export const InvitationCreateInput = z.object({
  email:  z.string().min(3).max(320),
  role:   ROLE,
  teamId: uuid.nullable().optional(),
});

export const InvitationAcceptInput = z.object({
  token:    z.string().min(1).max(512),
  name:     z.string().min(1).max(200),
  password: z.string().min(8).max(1024),
});

export type Invitation            = z.infer<typeof Invitation>;
export type InvitationCreateInput = z.infer<typeof InvitationCreateInput>;
export type InvitationAcceptInput = z.infer<typeof InvitationAcceptInput>;

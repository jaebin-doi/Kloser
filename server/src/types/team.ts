/* team / membership shared types — server source-of-truth.
 *
 * Phase 3 Step 4. Plan: docs/plan/phase-3/PHASE_3_STEP_4_TEAM_MEMBER_API.md §8.
 *
 * Sync target schemas (must keep top-level `export const X = z.object({ ... })`
 * literal form — no .extend / .merge / .partial / satisfies on these):
 *   - Team
 *   - TeamCreateInput
 *   - TeamPatchInput
 *   - Member
 *
 * MembershipPatchInput uses .refine() (at least one of role/status required)
 * and is intentionally NOT a sync target — derived schemas live on the
 * server only. The platform mirror tracks field names of the sync targets.
 */
import { z } from "zod";

// Permissive UUID matching Phase 1 / Phase 2 / Phase 3 conventions —
// 8-4-4-4-12 hex without RFC 4122 strict version/variant bits. Seed
// UUIDs (eeee-... / 1ff... / 7711... / etc.) violate strict.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = z.string().regex(UUID_RE);

const ROLE = z.enum(["admin", "manager", "employee", "viewer"]);
const STATUS = z.enum(["active", "disabled"]);

export const Team = z.object({
  id:         z.string(),
  org_id:     z.string(),
  name:       z.string(),
  manager_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const TeamCreateInput = z.object({
  name:      z.string().min(1).max(200),
  managerId: uuid.nullable().optional(),
});

export const TeamPatchInput = z.object({
  name:      z.string().min(1).max(200).optional(),
  managerId: uuid.nullable().optional(),
});

export const Member = z.object({
  id:                     z.string(),
  role:                   ROLE,
  status:                 STATUS,
  team_id:                z.string().nullable(),
  team_name:              z.string().nullable(),
  user_id:                z.string(),
  user_email:             z.string(),
  user_name:              z.string(),
  user_email_verified_at: z.string().nullable(),
  created_at:             z.string(),
  updated_at:             z.string(),
});

// Derived — not a sync target. Refine ensures the route rejects empty
// PATCH bodies as 400 invalid_input (vs surfacing as "ok no-op" 200).
export const MembershipPatchInput = z
  .object({
    role:   ROLE.optional(),
    status: STATUS.optional(),
  })
  .refine((v) => v.role !== undefined || v.status !== undefined, {
    message: "at least one of role/status required",
  });

export type Team                 = z.infer<typeof Team>;
export type TeamCreateInput      = z.infer<typeof TeamCreateInput>;
export type TeamPatchInput       = z.infer<typeof TeamPatchInput>;
export type Member               = z.infer<typeof Member>;
export type MembershipPatchInput = z.infer<typeof MembershipPatchInput>;

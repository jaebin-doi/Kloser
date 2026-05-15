/* organization security shared types — server source-of-truth.
 *
 * Phase 7 Step 2. Plan: docs/plan/phase-7/PHASE_7_STEP_2_PLAN.md §5.2 / §5.3.
 *
 * Sync target schemas (must keep top-level `export const X = z.object({ ... })`
 * literal form — no .extend / .merge / .partial / satisfies on these):
 *   - OrganizationSecurityResponse
 *   - OrganizationSecurityPatchInput
 *
 * Field naming follows backend snake_case convention (mfa_required,
 * current_user_mfa_enabled, members_without_mfa_count) so the wire shape
 * matches the existing organizations / users column names.
 *
 * `members_without_mfa_count` is optional on the wire — the GET handler
 * returns it for admin diagnostics, future endpoints (login challenge
 * response, etc.) that surface a subset of this entity may omit it.
 *
 * Rejection of stray request-body fields (e.g. an injected `org_id`)
 * is enforced at the Fastify route level by re-wrapping this schema
 * with zod `.strict()` inside `routes/organizationSecurity.ts` — the
 * source schema here stays a plain `z.object({ ... })` literal so the
 * sync_shared_types parser keeps working (its regex expects a bare
 * `})` close, no chained `.strict()` on the source side). A pure
 * JSON-Schema `additionalProperties:false` would NOT reject under
 * Fastify's default AJV (`removeAdditional:true` strips silently);
 * route-level `.strict()` is what actually surfaces stray fields as
 * 400 invalid_input via the plugin's ZodError handler.
 */
import { z } from "zod";

export const OrganizationSecurityResponse = z.object({
  mfa_required:               z.boolean(),
  current_user_mfa_enabled:   z.boolean(),
  members_without_mfa_count:  z.number().int().nonnegative().optional(),
});

export const OrganizationSecurityPatchInput = z.object({
  mfa_required: z.boolean(),
});

export type OrganizationSecurityResponse  = z.infer<typeof OrganizationSecurityResponse>;
export type OrganizationSecurityPatchInput = z.infer<typeof OrganizationSecurityPatchInput>;

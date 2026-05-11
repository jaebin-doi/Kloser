/* signup / verify shared types — server source-of-truth.
 *
 * Plan: docs/plan/phase-3/PHASE_3_STEP_2_SIGNUP_VERIFY.md §9.
 *
 * Sync target schemas (must keep top-level `export const X = z.object({ ... })`
 * literal form — no .extend / .merge / .partial / satisfies on these):
 *   - SignupInput
 *   - VerifyEmailInput
 *
 * The platform/types/signup.js JSDoc mirror tracks the same field names.
 * test/sync_shared_types.mjs diffs them per phase-2 STEP_3 convention.
 *
 * Validation hardening (regex on email, password strength rules) is out of
 * scope for Phase 3 — Phase 6+ Edge / WAF / front-of-app layer.
 */
import { z } from "zod";

export const SignupInput = z.object({
  organizationName: z.string().min(1).max(200),
  name:             z.string().min(1).max(200),
  email:            z.string().min(3).max(320),
  password:         z.string().min(8).max(1024),
});

export const VerifyEmailInput = z.object({
  token: z.string().min(1).max(512),
});

export type SignupInput      = z.infer<typeof SignupInput>;
export type VerifyEmailInput = z.infer<typeof VerifyEmailInput>;

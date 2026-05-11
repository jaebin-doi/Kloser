/* password reset shared types — server source-of-truth.
 *
 * Plan: docs/plan/phase-3/PHASE_3_STEP_3_PASSWORD_RESET.md §6.
 *
 * Sync target schemas (must keep top-level `export const X = z.object({ ... })`
 * literal form — no .extend / .merge / .partial / satisfies on these):
 *   - ForgotPasswordInput
 *   - ResetPasswordInput
 *
 * platform/types/password-reset.js mirrors the same field names; the sync
 * test (test/sync_shared_types.mjs) diffs both sides.
 *
 * Validation policy:
 *   - email is min 3 / max 320 chars — same as signup. Strict RFC 5321
 *     validation is out of scope (Phase 6+ edge / WAF / front-of-app).
 *   - newPassword is min 8 / max 1024 chars — same as signup. Password
 *     strength rules (complexity, common-password ban) are Phase 6+.
 */
import { z } from "zod";

export const ForgotPasswordInput = z.object({
  email: z.string().min(3).max(320),
});

export const ResetPasswordInput = z.object({
  token:       z.string().min(1).max(512),
  newPassword: z.string().min(8).max(1024),
});

export type ForgotPasswordInput = z.infer<typeof ForgotPasswordInput>;
export type ResetPasswordInput  = z.infer<typeof ResetPasswordInput>;

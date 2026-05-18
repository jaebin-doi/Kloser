/* /billing/* routes — Phase 7 Step 9.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_9_PLAN.md §5.4, §7.
 *
 * Two endpoints:
 *
 *   GET   /billing/overview   — admin-only. Returns plan + profile +
 *                                entitlements + usage + per-cap state.
 *   PATCH /billing/profile    — admin-only. Updates billing_email and/
 *                                or tax_id only. Plan changes go
 *                                through the future provider flow,
 *                                NOT this route.
 *
 * Authorization:
 *   requireAuth → orgContext → requireRole("admin") → requireFreshRole
 *
 * The `requireFreshRole` guard is added on GET as well: billing data is
 * operational and a stale admin (since-demoted) should not retain
 * visibility.
 *
 * Error mapping:
 *   - ZodError                  → 400 invalid_input
 *   - PlanLimitExceededError    → 403 plan_limit_exceeded
 *   - BillingNotFoundError      → 404 not_found
 *   - PermissionError           → 403 forbidden
 *   - AuthError                 → AuthError-mapped status
 *   - pg 42501 (RLS)            → 500 rls_violation
 */
import type { FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { orgContext } from "../middleware/orgContext.js";
import { requireRole } from "../middleware/role.js";
import { requireFreshRole } from "../middleware/requireFreshRole.js";
import { requireVerified } from "../middleware/requireVerified.js";
import { AuthError } from "../services/auth.js";
import { PermissionError } from "../services/callPermissions.js";
import {
  BillingNotFoundError,
  PlanLimitExceededError,
  getBillingOverview,
  patchBillingProfile,
} from "../services/billing.js";
import { BillingProfilePatchInput } from "../types/billing.js";

async function billingRoutes(app: FastifyInstance) {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply
        .code(400)
        .send({ error: "invalid_input", issues: err.flatten() });
    }
    if (err instanceof PlanLimitExceededError) {
      return reply.code(403).send({
        error: "plan_limit_exceeded",
        code: "plan_limit_exceeded",
        limit_key: err.limitKey,
        plan: err.plan,
        current: err.current,
        limit: err.limit,
        attempted: err.attempted,
      });
    }
    if (err instanceof BillingNotFoundError) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (err instanceof PermissionError) {
      return reply.code(403).send({ error: "forbidden" });
    }
    if (err instanceof AuthError) {
      const body: Record<string, unknown> = {
        error: err.message,
        code: err.code,
      };
      if (err.details && typeof err.details === "object") {
        Object.assign(body, err.details as Record<string, unknown>);
      }
      return reply.code(err.statusCode).send(body);
    }
    const pgCode = (err as { code?: string } | null)?.code;
    if (pgCode === "42501") {
      return reply.code(500).send({ error: "rls_violation" });
    }
    reply.send(err);
  });

  // -------------------------------------------------------------- //
  // GET /billing/overview
  // -------------------------------------------------------------- //
  app.get(
    "/billing/overview",
    {
      preHandler: [
        requireAuth,
        orgContext,
        requireVerified,
        requireRole("admin"),
        requireFreshRole,
      ],
    },
    async (request, reply) => {
      const user = request.user!;
      const summary = await getBillingOverview(app, user.orgId, user.id);
      return reply.code(200).send(summary);
    },
  );

  // -------------------------------------------------------------- //
  // PATCH /billing/profile
  // -------------------------------------------------------------- //
  app.patch(
    "/billing/profile",
    {
      preHandler: [
        requireAuth,
        orgContext,
        requireVerified,
        requireRole("admin"),
        requireFreshRole,
      ],
    },
    async (request, reply) => {
      // Drop undefined keys before validation so the patch shape ends up
      // matching the repo's hasOwnProperty contract. Zod still validates
      // the remaining keys against the email/length constraints.
      const raw = request.body as Record<string, unknown> | null | undefined;
      const cleaned: Record<string, unknown> = {};
      if (raw && typeof raw === "object") {
        if (Object.prototype.hasOwnProperty.call(raw, "billing_email")) {
          // empty string → null so the UI's "clear field" form submission
          // doesn't need to know about the null shape.
          const v = raw.billing_email;
          cleaned.billing_email =
            typeof v === "string" && v.trim() === "" ? null : v;
        }
        if (Object.prototype.hasOwnProperty.call(raw, "tax_id")) {
          const v = raw.tax_id;
          cleaned.tax_id =
            typeof v === "string" && v.trim() === "" ? null : v;
        }
      }
      // empty object → 400 invalid_input ("nothing to update").
      if (Object.keys(cleaned).length === 0) {
        return reply.code(400).send({
          error: "invalid_input",
          code: "empty_patch",
        });
      }

      const patch = BillingProfilePatchInput.parse(cleaned);
      const user = request.user!;
      const profile = await patchBillingProfile(app, user.orgId, user.id, patch);
      return reply.code(200).send({ profile });
    },
  );
}

export default billingRoutes;

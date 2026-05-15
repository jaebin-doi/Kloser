/* /organization/security routes — Phase 7 Step 2.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_2_PLAN.md §5.2.
 *
 * Surface (admin-only):
 *   GET   /organization/security  → OrganizationSecurityResponse
 *   PATCH /organization/security  → OrganizationSecurityResponse
 *
 * preHandler:
 *   - GET   → [requireAuth, orgContext, requireRole("admin")]
 *   - PATCH → [requireAuth, orgContext, requireRole("admin"),
 *              requireFreshRole]
 *
 * PATCH is an org-wide security mutation (org.mfa_required), so it
 * follows the same chain as team / invitations / teams mutations —
 * requireFreshRole re-reads the caller's membership row so a freshly
 * demoted admin cannot keep flipping the org MFA flag with a still-
 * valid access token. GET intentionally skips requireFreshRole: it is
 * a cheap read and re-running the DB role check per GET costs a round
 * trip with no security gain (a stale admin can already read most of
 * what they would see anyway via /me).
 *
 * Both endpoints scope to the JWT-derived orgId via orgContext + the
 * service's repository helpers (which pin every query on
 * `current_app_org_id()`). There is intentionally NO `org_id` parameter
 * in the request.
 *
 * Stray-field rejection on PATCH bodies happens via zod `.strict()`
 * applied at the route boundary (not on the shared-type source, which
 * stays a plain `z.object({})` so `test/sync_shared_types.mjs`'s
 * regex parser keeps working). A pure Fastify JSON-Schema with
 * `additionalProperties: false` would NOT reject — Fastify's default
 * AJV uses `removeAdditional: true`, which strips unknown keys
 * silently. zod `.strict()` actually throws, and the local
 * setErrorHandler converts the ZodError to 400 invalid_input.
 */
import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { orgContext } from "../middleware/orgContext.js";
import { requireRole } from "../middleware/role.js";
import { requireFreshRole } from "../middleware/requireFreshRole.js";
import { AuthError } from "../services/auth.js";
import {
  getOrganizationSecurity,
  setOrganizationMfaRequired,
} from "../services/organizationSecurity.js";
import { OrganizationSecurityPatchInput } from "../types/organizationSecurity.js";

// Strict variant lives at the ROUTE layer only — the shared type stays
// a bare `z.object({})` literal so the sync_shared_types regex parser
// recognises the close. `.strict()` rejects unknown keys with a
// ZodError instead of silently stripping them.
const PATCH_INPUT_STRICT = OrganizationSecurityPatchInput.strict();

async function organizationSecurityRoutes(app: FastifyInstance) {
  // Plugin-scoped error handler — matches the pattern in routes/team.ts.
  // ZodError → 400 invalid_input (covers strict-mode unknown-key
  // rejection AND any future schema tightening). AuthError surfaces as
  // its declared statusCode/code. Anything else falls through to
  // Fastify's default handler (5xx + logging).
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error:  "invalid_input",
        code:   "invalid_input",
        issues: err.flatten(),
      });
    }
    if (err instanceof AuthError) {
      const body: Record<string, unknown> = {
        error: err.message,
        code:  err.code,
      };
      if (err.details && typeof err.details === "object") {
        Object.assign(body, err.details as Record<string, unknown>);
      }
      return reply.code(err.statusCode).send(body);
    }
    throw err;
  });

  app.get(
    "/organization/security",
    {
      preHandler: [requireAuth, orgContext, requireRole("admin")],
    },
    async (request, reply) => {
      if (!request.user || !request.orgId) {
        return reply
          .code(401)
          .send({ error: "authentication required", code: "auth_required" });
      }
      const result = await app.withOrgContext(
        request.orgId,
        (client) => getOrganizationSecurity(client, {
          userId: request.user!.id,
        }),
      );
      return reply.code(200).send(result);
    },
  );

  app.patch(
    "/organization/security",
    {
      // requireFreshRole is intentionally last: it pays for a DB hit,
      // so we only want to spend it after the cheap claim-only checks
      // (requireAuth, orgContext, requireRole) have already passed.
      // Matches the chain in routes/team.ts admin mutations.
      preHandler: [
        requireAuth,
        orgContext,
        requireRole("admin"),
        requireFreshRole,
      ],
    },
    async (request, reply) => {
      if (!request.user || !request.orgId) {
        return reply
          .code(401)
          .send({ error: "authentication required", code: "auth_required" });
      }
      // Parse + reject stray fields here. ZodError flows through the
      // plugin-scoped error handler above as 400 invalid_input.
      const parsed = PATCH_INPUT_STRICT.parse(request.body);
      const result = await app.withOrgContext(
        request.orgId,
        (client) => setOrganizationMfaRequired(client, {
          orgId:    request.orgId!,
          userId:   request.user!.id,
          required: parsed.mfa_required,
        }),
      );
      return reply.code(200).send(result);
    },
  );
}

export default organizationSecurityRoutes;

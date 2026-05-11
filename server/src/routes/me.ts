/* GET /me — Phase 1 Step 3 §1.8.
 *
 * Returns the (user, organization, membership) triple for the current
 * authenticated session, scoped to request.user.orgId. Uses
 * `app.withOrgContext` so memberships RLS applies, and reaches users +
 * organizations through their org-scoped repository helpers — never
 * the unguarded SELECT * variants.
 *
 * preHandler: requireAuth populates request.user from the Bearer JWT.
 * orgContext is intentionally NOT applied here: /me derives orgId from
 * the JWT directly, so the middleware would be redundant.
 */
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../middleware/auth.js";
import * as memberships from "../repositories/memberships.js";
import * as organizations from "../repositories/organizations.js";
import * as users from "../repositories/users.js";

async function meRoutes(app: FastifyInstance) {
  app.get(
    "/me",
    { preHandler: requireAuth },
    async (request, reply) => {
      // requireAuth either populated request.user or already 401'd —
      // this guard is for TS narrowing.
      if (!request.user) {
        return reply
          .code(401)
          .send({ error: "authentication required", code: "auth_required" });
      }
      const { orgId, membershipId, id: userId } = request.user;

      // pg PoolClient cannot multiplex queries: keep these sequential.
      const result = await app.withOrgContext(orgId, async (client) => {
        const organization = await organizations.getCurrentOrg(client);
        const user = await users.getByIdInCurrentOrg(client, userId);
        const membership = await memberships.getById(client, membershipId);
        return { organization, user, membership };
      });

      // Any of these missing means the JWT outlived its row (membership
      // revoked, org deleted, etc). Surface as 401 — the access token
      // is no longer meaningful and the client should re-auth.
      if (!result.organization || !result.user || !result.membership) {
        return reply
          .code(401)
          .send({ error: "session no longer valid", code: "stale_session" });
      }

      return reply.code(200).send({
        user: {
          id:                result.user.id,
          email:             result.user.email,
          name:              result.user.name,
          avatar_url:        result.user.avatar_url,
          email_verified_at: result.user.email_verified_at,
        },
        organization: {
          id:   result.organization.id,
          name: result.organization.name,
          plan: result.organization.plan,
        },
        membership: {
          id:   result.membership.id,
          role: result.membership.role,
        },
      });
    },
  );
}

export default meRoutes;

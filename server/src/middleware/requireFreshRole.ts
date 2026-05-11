/* preHandler hook: verify the JWT's role still matches the DB.
 *
 * Phase 3 Step 4. Plan: docs/plan/phase-3/PHASE_3_STEP_4_TEAM_MEMBER_API.md §5.
 *
 * Applied to admin-only mutation endpoints so a freshly demoted admin
 * cannot keep acting with their still-valid access token. The middleware
 * re-reads the caller's membership row and compares:
 *
 *   - missing row / status != 'active' → 401 stale_session
 *   - row.role != JWT role             → 401 stale_role
 *
 * NEVER applied to read endpoints — those are cheap and re-running this
 * query per GET would just spend a round-trip with no security gain.
 * Master §2-14 / Step 4 plan §1-2.
 *
 * Chain order: requireAuth → orgContext → requireRole('admin') →
 * requireFreshRole. requireAuth populates request.user from the JWT,
 * orgContext mirrors the JWT's orgId to request.orgId, requireRole does
 * a cheap claim-only check, and requireFreshRole pays for the DB hit only
 * after the cheaper gates already passed.
 *
 * DB errors are intentionally NOT caught here — they bubble to Fastify's
 * default handler and surface as 500. A transient pg outage is a real
 * error, not a stale-role signal, and we want operators to see the 50x.
 */
import type { FastifyReply, FastifyRequest } from "fastify";

export async function requireFreshRole(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!request.user) {
    reply.code(401).send({
      error: "authentication required",
      code:  "auth_required",
    });
    return;
  }
  const { orgId, role: jwtRole, membershipId } = request.user;

  const current = await request.server.withOrgContext(orgId, async (client) => {
    const r = await client.query<{ role: string; status: string }>(
      `SELECT role, status FROM memberships WHERE id = $1`,
      [membershipId],
    );
    return r.rows[0] ?? null;
  });

  if (!current || current.status !== "active") {
    reply.code(401).send({
      error: "session no longer valid",
      code:  "stale_session",
    });
    return;
  }
  if (current.role !== jwtRole) {
    reply.code(401).send({
      error: "role changed — please re-login",
      code:  "stale_role",
    });
    return;
  }
}

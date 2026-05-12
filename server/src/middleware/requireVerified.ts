/* preHandler hook: require email-verified user in the current org.
 *
 * Phase 4 Step 3. Plan: docs/plan/phase-4/PHASE_4_STEP_3_ROUTES.md §4.2.
 *
 * Applied to mutation endpoints that should not be writable until the
 * caller has consumed their /auth/verify email. read endpoints stay
 * accessible so an unverified user can still see their dashboard /
 * calls list (the calls.html banner from Phase 3 nudges them to
 * verify).
 *
 * Chain order: requireAuth → orgContext → requireVerified → requireRole →
 * requireFreshRole. requireAuth populates request.user from the JWT,
 * orgContext mirrors the orgId to request.orgId, requireVerified pays
 * one DB hit to confirm the user + membership are still valid AND the
 * user is verified, then the cheaper role / fresh-role checks run.
 *
 * Membership / session validity overlaps with requireFreshRole. We
 * still answer those failure modes here so the route author cannot
 * accidentally apply requireVerified without requireFreshRole on a
 * write surface. The 401 / 403 split:
 *
 *   - no request.user             → 401 auth_required
 *   - membership missing/disabled → 401 stale_session
 *   - user.email_verified_at NULL → 403 email_not_verified
 *
 * users has no RLS, so the helper joins memberships (which IS RLS-
 * scoped through current_app_org_id()) inside withOrgContext to make
 * sure the membership belongs to the same org the JWT claims.
 */
import type { FastifyReply, FastifyRequest } from "fastify";

export async function requireVerified(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!request.user) {
    reply.code(401).send({
      error: "authentication required",
      code: "auth_required",
    });
    return;
  }
  const { orgId, id: userId, membershipId } = request.user;

  const row = await request.server.withOrgContext(orgId, async (client) => {
    const r = await client.query<{
      email_verified_at: Date | null;
      membership_status: string;
    }>(
      `SELECT u.email_verified_at        AS email_verified_at,
              m.status                   AS membership_status
         FROM users u
         JOIN memberships m ON m.user_id = u.id
        WHERE u.id = $1
          AND m.id = $2`,
      [userId, membershipId],
    );
    return r.rows[0] ?? null;
  });

  if (!row || row.membership_status !== "active") {
    reply.code(401).send({
      error: "session no longer valid",
      code: "stale_session",
    });
    return;
  }
  if (row.email_verified_at === null) {
    reply.code(403).send({
      error: "email_not_verified",
      code: "email_not_verified",
    });
    return;
  }
}

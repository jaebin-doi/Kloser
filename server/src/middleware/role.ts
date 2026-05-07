import type { FastifyReply, FastifyRequest } from "fastify";
import type { MembershipRole } from "../repositories/memberships.js";

export function requireRole(...roles: MembershipRole[]) {
  const allowed = new Set<MembershipRole>(roles);

  return async function roleGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (!request.user) {
      reply.code(401).send({ error: "authentication required" });
      return;
    }

    if (!allowed.has(request.user.role)) {
      reply.code(403).send({ error: "forbidden" });
    }
  };
}

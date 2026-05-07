/* preHandler hook: read and validate the org id for the current request.
 *
 * Step 2 contract (dev only): orgId arrives in the `X-Org-Id` request
 * header. Step 3 will replace this with the orgId decoded from the JWT.
 *
 * Validation runs at the edge so a bad value never reaches the RLS
 * helper, where `::uuid` casting would fail with a 5xx.
 *
 *   no header           → 401
 *   header but not UUID → 400
 *   valid UUID          → request.orgId is set
 */
import type { FastifyRequest, FastifyReply } from "fastify";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

declare module "fastify" {
  interface FastifyRequest {
    // Optional because not every route runs through this hook (health
    // checks, static asset serving, etc). Routes that do should treat
    // the absence as a programming error.
    orgId?: string;
  }
}

export async function orgContext(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const raw = request.headers["x-org-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) {
    reply.code(401).send({ error: "missing X-Org-Id" });
    return;
  }
  if (!UUID_RE.test(value)) {
    reply.code(400).send({ error: "X-Org-Id is not a valid UUID" });
    return;
  }
  request.orgId = value;
}

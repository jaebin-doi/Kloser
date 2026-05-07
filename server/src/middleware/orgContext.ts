/* preHandler hook: resolve the org id for the current request.
 *
 * Resolution order (Step 3):
 *   1. `request.user?.orgId` — set by `requireAuth` from the verified
 *      JWT. This is the only trusted source in production.
 *   2. `X-Org-Id` header — dev/test escape hatch so the Step 2 RLS
 *      isolation tests (which run without JWT) keep working. NEVER
 *      consulted when NODE_ENV=production.
 *
 * In production, an `X-Org-Id` header is treated as a hostile attempt
 * to override the JWT-derived org and rejected with 400. That keeps
 * client-controlled values out of the RLS context even if some future
 * code path forgets to attach `requireAuth` upstream.
 *
 * Validation runs at the edge so a bad value never reaches the RLS
 * helper, where `::uuid` casting would fail with a 5xx.
 *
 *   prod + X-Org-Id present → 400 (never accepted in prod)
 *   request.user.orgId       → request.orgId set, 200
 *   dev/test + valid header  → request.orgId set, 200
 *   missing                  → 401
 *   header but not UUID      → 400
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

// Read NODE_ENV at call time so tests can flip prod/dev around the
// individual test cases without re-importing this module.
function isProd(): boolean {
  return process.env.NODE_ENV === "production";
}

export async function orgContext(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const raw = request.headers["x-org-id"];
  const headerValue = Array.isArray(raw) ? raw[0] : raw;

  // Defense in depth: prod never trusts the header, even if there is
  // also a Bearer token. The presence of the header is itself the bug
  // we want to surface — fail loudly so the client gets fixed.
  if (isProd() && headerValue !== undefined) {
    reply.code(400).send({ error: "X-Org-Id is not accepted in production" });
    return;
  }

  // Authenticated path: requireAuth populated request.user with a
  // JWT-verified orgId. Trust it and ignore any header.
  if (request.user?.orgId) {
    request.orgId = request.user.orgId;
    return;
  }

  // Dev/test fallback: header is the only signal we have.
  if (!headerValue) {
    reply.code(401).send({ error: "missing X-Org-Id" });
    return;
  }
  if (!UUID_RE.test(headerValue)) {
    reply.code(400).send({ error: "X-Org-Id is not a valid UUID" });
    return;
  }
  request.orgId = headerValue;
}

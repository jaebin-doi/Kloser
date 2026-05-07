import type { FastifyReply, FastifyRequest } from "fastify";
import {
  AuthError,
  toAuthenticatedUser,
  validateAccessTokenPayload,
} from "../services/auth.js";

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    reply.code(401).send({ error: "missing bearer token" });
    return;
  }

  try {
    const decoded = await request.jwtVerify();
    const payload = validateAccessTokenPayload(decoded);
    request.user = toAuthenticatedUser(payload);
  } catch (err) {
    const message =
      err instanceof AuthError ? err.message : "invalid access token";
    reply.code(401).send({ error: message });
  }
}

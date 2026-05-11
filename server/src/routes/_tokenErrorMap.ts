/* Shared token-error → 410 generic mapping.
 *
 * Phase 3 Step 5. Plan: docs/plan/phase-3/PHASE_3_STEP_5_INVITATION_API.md §6.2.
 *
 * /auth/verify, /auth/password/reset, and /invitations/accept all collapse
 * every distinct token-failure reason into one generic 410. Internally the
 * service throws AuthError with a precise code (token_not_found /
 * token_already_used / token_invalidated / token_expired) so tests + logs
 * keep the granularity; the wire shape stays opaque to defeat
 * timing / enumeration. Step 2 §7 / Step 3 §3.2 / Step 5 §6.
 *
 * Anything that isn't one of the four token reason codes falls through to
 * sendAuthError so AuthError(409 'already_member') etc. surface as their
 * declared statusCode/code instead of being swallowed into 410.
 */
import type { FastifyReply } from "fastify";
import { AuthError } from "../services/auth.js";

const TOKEN_REASON_CODES = new Set([
  "token_not_found",
  "token_already_used",
  "token_invalidated",
  "token_expired",
]);

export function sendAuthError(reply: FastifyReply, err: unknown): FastifyReply {
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
  // Unknown errors: let fastify's default error handler log + 500.
  throw err;
}

export function sendTokenError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof AuthError && TOKEN_REASON_CODES.has(err.code)) {
    return reply.code(410).send({
      error: "token_invalid_or_expired",
      code:  "token_invalid_or_expired",
    });
  }
  return sendAuthError(reply, err);
}

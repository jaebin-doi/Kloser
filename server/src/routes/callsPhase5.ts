/* Phase 5 call-related routes (extends /calls/* + /call-* surface).
 *
 * Plan: docs/plan/phase-5/PHASE_5_STEP_3_ROUTES.md §2.3.
 *
 * Surface (10 endpoints):
 *   POST   /calls/:id/heartbeat
 *   POST   /calls/:id/link-customer
 *   POST   /calls/:id/unlink-customer
 *   POST   /calls/:id/summary/manual
 *   POST   /calls/:id/checklist/initialize
 *   GET    /calls/:id/checklist
 *   GET    /calls/:id/suggestions
 *   POST   /call-checklist-items/:id/status
 *   POST   /call-suggestions/:id/use
 *   POST   /call-suggestions/:id/dismiss
 *
 * Permission model:
 *   - GETs use read chain (any same-org user, RLS scopes).
 *   - Mutations use writer chain + service-layer assertCanMutateCall
 *     (admin / manager-team / employee-own / viewer-deny). The service
 *     resolves the parent call and throws PermissionError, mapped to
 *     403 in the local error handler.
 *
 * Errors:
 *   ZodError → 400 invalid_input
 *   PermissionError → 403 forbidden
 *   SuggestionStateError → 409 conflict_state
 *   pg 23503 → 400 invalid_reference
 *   pg 23505 → 409 conflict
 *   pg 23514 → 400 invalid_state_transition
 *   pg 42501 → 500 rls_violation
 *   service null (missing / cross-org / soft-deleted) → 404 not_found
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
import { SuggestionStateError } from "../services/callSuggestions.js";
import * as callHeartbeatService from "../services/callHeartbeat.js";
import * as customerLinkageService from "../services/customerLinkage.js";
import * as callSummaryService from "../services/callSummary.js";
import * as callChecklistService from "../services/callChecklist.js";
import * as callSuggestionsService from "../services/callSuggestions.js";
import { CallSummaryManualInput } from "../types/call.js";
import { CallChecklistItemStatusInput } from "../types/callChecklistItem.js";
import type { Actor } from "../services/callPermissions.js";
import type { FastifyRequest } from "fastify";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UuidParam = z.object({
  id: z.string().regex(UUID_RE, "invalid uuid"),
});
const UuidString = z.string().regex(UUID_RE, "invalid uuid");

const LinkCustomerInput = z.object({
  customer_id: UuidString,
});

const WRITER_ROLES = ["admin", "manager", "employee"] as const;

function actorFromRequest(request: FastifyRequest): Actor {
  // requireAuth + orgContext have already populated these.
  const user = request.user!;
  return { id: user.id, orgId: user.orgId, role: user.role };
}

async function callsPhase5Routes(app: FastifyInstance) {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply
        .code(400)
        .send({ error: "invalid_input", issues: err.flatten() });
    }
    if (err instanceof PermissionError) {
      return reply.code(403).send({ error: "forbidden" });
    }
    if (err instanceof SuggestionStateError) {
      return reply.code(409).send({ error: "conflict_state" });
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
    if (pgCode === "23503") {
      return reply.code(400).send({ error: "invalid_reference" });
    }
    if (pgCode === "23505") {
      return reply.code(409).send({ error: "conflict" });
    }
    if (pgCode === "23514") {
      return reply.code(400).send({ error: "invalid_state_transition" });
    }
    if (pgCode === "42501") {
      return reply.code(500).send({ error: "rls_violation" });
    }
    reply.send(err);
  });

  // -------------------------------------------------------------- //
  // POST /calls/:id/heartbeat
  //
  // WS heartbeat is the primary path (see ws/calls.ts), but a REST
  // endpoint is useful for fallbacks where the WebSocket is blocked.
  // -------------------------------------------------------------- //
  app.post(
    "/calls/:id/heartbeat",
    {
      preHandler: [
        requireAuth,
        orgContext,
        requireVerified,
        requireRole(...WRITER_ROLES),
        requireFreshRole,
      ],
    },
    async (request, reply) => {
      const { id } = UuidParam.parse(request.params);
      const updated = await callHeartbeatService.touchCallHeartbeat(
        app,
        request.orgId!,
        id,
      );
      if (!updated) {
        // Could be missing/cross-org/soft-deleted, or already ended/missed/dropped.
        return reply
          .code(404)
          .send({ error: "not_found", reason: "call_not_active" });
      }
      return reply.code(200).send({ call: updated });
    },
  );

  // -------------------------------------------------------------- //
  // POST /calls/:id/link-customer
  // -------------------------------------------------------------- //
  app.post(
    "/calls/:id/link-customer",
    {
      preHandler: [
        requireAuth,
        orgContext,
        requireVerified,
        requireRole(...WRITER_ROLES),
        requireFreshRole,
      ],
    },
    async (request, reply) => {
      const { id } = UuidParam.parse(request.params);
      const { customer_id } = LinkCustomerInput.parse(request.body);
      const actor = actorFromRequest(request);
      const updated = await customerLinkageService.linkCustomerToCall(
        app,
        actor,
        id,
        customer_id,
      );
      if (!updated) return reply.code(404).send({ error: "not_found" });
      return reply.code(200).send({ call: updated });
    },
  );

  // -------------------------------------------------------------- //
  // POST /calls/:id/unlink-customer
  // -------------------------------------------------------------- //
  app.post(
    "/calls/:id/unlink-customer",
    {
      preHandler: [
        requireAuth,
        orgContext,
        requireVerified,
        requireRole(...WRITER_ROLES),
        requireFreshRole,
      ],
    },
    async (request, reply) => {
      const { id } = UuidParam.parse(request.params);
      const actor = actorFromRequest(request);
      const updated = await customerLinkageService.unlinkCustomerFromCall(
        app,
        actor,
        id,
      );
      if (!updated) return reply.code(404).send({ error: "not_found" });
      return reply.code(200).send({ call: updated });
    },
  );

  // -------------------------------------------------------------- //
  // POST /calls/:id/summary/manual
  // -------------------------------------------------------------- //
  app.post(
    "/calls/:id/summary/manual",
    {
      preHandler: [
        requireAuth,
        orgContext,
        requireVerified,
        requireRole(...WRITER_ROLES),
        requireFreshRole,
      ],
    },
    async (request, reply) => {
      const { id } = UuidParam.parse(request.params);
      const input = CallSummaryManualInput.parse(request.body);
      const actor = actorFromRequest(request);
      const updated = await callSummaryService.applyManualSummary(
        app,
        actor,
        id,
        input,
      );
      if (!updated) return reply.code(404).send({ error: "not_found" });
      return reply.code(200).send({ call: updated });
    },
  );

  // -------------------------------------------------------------- //
  // POST /calls/:id/checklist/initialize  (writer chain — any same-org
  // writer can fill the snapshot from active templates).
  // -------------------------------------------------------------- //
  app.post(
    "/calls/:id/checklist/initialize",
    {
      preHandler: [
        requireAuth,
        orgContext,
        requireVerified,
        requireRole(...WRITER_ROLES),
        requireFreshRole,
      ],
    },
    async (request, reply) => {
      const { id } = UuidParam.parse(request.params);
      const actor = actorFromRequest(request);
      const items = await callChecklistService.initializeChecklistForCall(
        app,
        actor,
        id,
      );
      if (items === null) return reply.code(404).send({ error: "not_found" });
      return reply.code(200).send({ items });
    },
  );

  // -------------------------------------------------------------- //
  // GET /calls/:id/checklist
  // -------------------------------------------------------------- //
  app.get(
    "/calls/:id/checklist",
    { preHandler: [requireAuth, orgContext] },
    async (request, reply) => {
      const { id } = UuidParam.parse(request.params);
      const items = await callChecklistService.listChecklistForCall(
        app,
        request.orgId!,
        id,
      );
      if (items === null) return reply.code(404).send({ error: "not_found" });
      return reply.code(200).send({ items });
    },
  );

  // -------------------------------------------------------------- //
  // POST /call-checklist-items/:id/status
  // -------------------------------------------------------------- //
  app.post(
    "/call-checklist-items/:id/status",
    {
      preHandler: [
        requireAuth,
        orgContext,
        requireVerified,
        requireRole(...WRITER_ROLES),
        requireFreshRole,
      ],
    },
    async (request, reply) => {
      const { id } = UuidParam.parse(request.params);
      const { status } = CallChecklistItemStatusInput.parse(request.body);
      const actor = actorFromRequest(request);
      const updated = await callChecklistService.markChecklistItem(
        app,
        actor,
        id,
        status,
      );
      if (!updated) return reply.code(404).send({ error: "not_found" });
      return reply.code(200).send({ item: updated });
    },
  );

  // -------------------------------------------------------------- //
  // GET /calls/:id/suggestions
  // -------------------------------------------------------------- //
  app.get(
    "/calls/:id/suggestions",
    { preHandler: [requireAuth, orgContext] },
    async (request, reply) => {
      const { id } = UuidParam.parse(request.params);
      const items = await callSuggestionsService.listSuggestionsForCall(
        app,
        request.orgId!,
        id,
      );
      if (items === null) return reply.code(404).send({ error: "not_found" });
      return reply.code(200).send({ items });
    },
  );

  // -------------------------------------------------------------- //
  // POST /call-suggestions/:id/use
  // -------------------------------------------------------------- //
  app.post(
    "/call-suggestions/:id/use",
    {
      preHandler: [
        requireAuth,
        orgContext,
        requireVerified,
        requireRole(...WRITER_ROLES),
        requireFreshRole,
      ],
    },
    async (request, reply) => {
      const { id } = UuidParam.parse(request.params);
      const actor = actorFromRequest(request);
      const updated = await callSuggestionsService.useSuggestion(
        app,
        actor,
        id,
      );
      if (!updated) return reply.code(404).send({ error: "not_found" });
      return reply.code(200).send({ suggestion: updated });
    },
  );

  // -------------------------------------------------------------- //
  // POST /call-suggestions/:id/dismiss
  // -------------------------------------------------------------- //
  app.post(
    "/call-suggestions/:id/dismiss",
    {
      preHandler: [
        requireAuth,
        orgContext,
        requireVerified,
        requireRole(...WRITER_ROLES),
        requireFreshRole,
      ],
    },
    async (request, reply) => {
      const { id } = UuidParam.parse(request.params);
      const actor = actorFromRequest(request);
      const updated = await callSuggestionsService.dismissSuggestion(
        app,
        actor,
        id,
      );
      if (!updated) return reply.code(404).send({ error: "not_found" });
      return reply.code(200).send({ suggestion: updated });
    },
  );
}

export default callsPhase5Routes;

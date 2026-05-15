/* /calls/* + /call-action-items/:id/* routes — Phase 4 Step 3.
 *
 * Plan: docs/plan/phase-4/PHASE_4_STEP_3_ROUTES.md §3, §4, §5.
 *
 * Surface (11 endpoints):
 *
 *   GET    /calls                          — list + filter + pagination
 *   POST   /calls                          — create call row
 *   GET    /calls/:id                      — single call (call only)
 *   POST   /calls/:id/notes                — patch notes
 *   POST   /calls/:id/end                  — set status/ended_at + customer.last_contacted_at
 *   GET    /calls/:id/transcript           — list transcripts seq ASC
 *   POST   /calls/:id/transcript           — append transcript (server seq)
 *   GET    /calls/:id/action-items         — list action items
 *   POST   /calls/:id/action-items         — create action item
 *   POST   /call-action-items/:id/status   — change status (open/done/dropped)
 *   POST   /call-action-items/:id/assignee — change assignee
 *
 * preHandler matrix:
 *   read         → requireAuth + orgContext
 *   mutation     → requireAuth + orgContext + requireVerified
 *                  + requireRole("admin","manager","employee")
 *                  + requireFreshRole
 *
 * Employee-own-call enforcement (admin/manager pass through):
 *   - call-id mutations look up the call and 403 when
 *     `employee && call.agent_user_id !== request.user.id`.
 *   - action-item-id mutations look up the parent call via the
 *     callActionItems repo helper and apply the same rule.
 *
 * Error vocabulary (plan §5) is centralised in the plugin-scoped error
 * handler. Repository / service nulls → 404. ZodError → 400 invalid_input.
 * pg 23503 → 400 invalid_reference, 23514 → 400 invalid_state_transition,
 * 42501 → 500 rls_violation (defensive — should never reach a normal
 * client).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { orgContext } from "../middleware/orgContext.js";
import { requireRole } from "../middleware/role.js";
import { requireFreshRole } from "../middleware/requireFreshRole.js";
import { requireVerified } from "../middleware/requireVerified.js";
import { AuthError } from "../services/auth.js";
import {
  CallCreateInput,
  CallEndInput,
  CallListQuery,
  CallNotesInput,
} from "../types/call.js";
import { TranscriptAppendInput } from "../types/transcript.js";
import {
  ActionItemAssigneeInput,
  ActionItemCreateInput,
  ActionItemStatusInput,
} from "../types/actionItem.js";
import * as callsRepo from "../repositories/calls.js";
import * as transcriptsRepo from "../repositories/transcripts.js";
import * as actionItemsRepo from "../repositories/callActionItems.js";
import * as callsService from "../services/calls.js";
import * as callActionItemsService from "../services/callActionItems.js";
import {
  PermissionError,
  type Actor,
} from "../services/callPermissions.js";
import {
  recordActionItemAssigneeChanged,
  recordActionItemCreated,
  recordActionItemStatusChanged,
  recordCallNotesUpdated,
} from "../services/activityLog.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UuidParam = z.object({
  id: z.string().regex(UUID_RE, "invalid uuid"),
});

type WriterRole = "admin" | "manager" | "employee";
const WRITER_ROLES: WriterRole[] = ["admin", "manager", "employee"];

// Employee can mutate only when they are the call's agent. admin /
// manager pass for any call in the org. Returns the route's 4xx reply
// directly, or null when allowed.
function denyForEmployeeNonOwner(
  request: FastifyRequest,
  reply: FastifyReply,
  call: { agent_user_id: string | null },
): null | FastifyReply {
  const user = request.user;
  if (!user) return reply.code(401).send({ error: "auth_required" });
  if (user.role !== "employee") return null;
  if (call.agent_user_id !== null && call.agent_user_id === user.id) {
    return null;
  }
  return reply.code(403).send({ error: "forbidden" });
}

async function callsRoutes(app: FastifyInstance) {
  // ---------- plugin-scoped error vocabulary ---------- //
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply
        .code(400)
        .send({ error: "invalid_input", issues: err.flatten() });
    }
    // Phase 6 Step 3 — DELETE /call-action-items/:id introduces the
    // first assertCanMutateCall caller in this route file. The
    // checklist / suggestion routes already map PermissionError → 403
    // in callsPhase5.ts; keep the same code so the client error
    // taxonomy stays uniform across mutation routes.
    if (err instanceof PermissionError) {
      return reply.code(403).send({ error: "forbidden" });
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
    if (pgCode === "23514") {
      return reply.code(400).send({ error: "invalid_state_transition" });
    }
    if (pgCode === "42501") {
      return reply.code(500).send({ error: "rls_violation" });
    }
    reply.send(err);
  });

  // -------------------------------------------------------------- //
  // GET /calls — list
  // -------------------------------------------------------------- //
  app.get(
    "/calls",
    { preHandler: [requireAuth, orgContext] },
    async (request, reply) => {
      const opts = CallListQuery.parse(request.query);
      const result = await callsService.listCalls(app, request.orgId!, opts);
      return reply.code(200).send(result);
    },
  );

  // -------------------------------------------------------------- //
  // POST /calls — create
  // -------------------------------------------------------------- //
  app.post(
    "/calls",
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
      const input = CallCreateInput.parse(request.body);
      // Employee may only own calls. We force agent_user_id = self for
      // them so a non-owner cannot be invented through the body. Admin
      // / manager keep the body value (or null) intact.
      const normalised =
        request.user!.role === "employee"
          ? { ...input, agent_user_id: request.user!.id }
          : input;
      const call = await callsService.createCall(
        app,
        request.orgId!,
        request.user!.id,
        normalised,
      );
      return reply.code(201).send({ call });
    },
  );

  // -------------------------------------------------------------- //
  // GET /calls/:id — detail (call only; transcript/action-items via dedicated endpoints)
  // -------------------------------------------------------------- //
  app.get(
    "/calls/:id",
    { preHandler: [requireAuth, orgContext] },
    async (request, reply) => {
      const { id } = UuidParam.parse(request.params);
      const call = await callsService.getCallById(app, request.orgId!, id);
      if (!call) return reply.code(404).send({ error: "not_found" });
      return reply.code(200).send({ call });
    },
  );

  // -------------------------------------------------------------- //
  // POST /calls/:id/notes — patch notes
  // -------------------------------------------------------------- //
  app.post(
    "/calls/:id/notes",
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
      const { notes } = CallNotesInput.parse(request.body);

      const existing = await callsService.getCallById(
        app,
        request.orgId!,
        id,
      );
      if (!existing) return reply.code(404).send({ error: "not_found" });
      const denied = denyForEmployeeNonOwner(request, reply, existing);
      if (denied) return denied;

      const updated = await app.withOrgContext(request.orgId!, async (client) => {
        const row = await callsRepo.patchNotesByIdInCurrentOrg(client, id, notes);
        if (row) {
          // Phase 7 Step 3 — audit inside the same tx as the UPDATE.
          // Payload carries notes_length only — never the body, which
          // a salesperson may have typed sensitive customer details into.
          await recordCallNotesUpdated(client, {
            orgId:       request.orgId!,
            actorUserId: request.user!.id,
            callId:      row.id,
            notesLength: notes === null ? 0 : notes.length,
          });
        }
        return row;
      });
      if (!updated) return reply.code(404).send({ error: "not_found" });
      return reply.code(200).send({ call: updated });
    },
  );

  // -------------------------------------------------------------- //
  // POST /calls/:id/end — end + customers.last_contacted_at update
  // -------------------------------------------------------------- //
  app.post(
    "/calls/:id/end",
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
      const input = CallEndInput.parse(request.body ?? {});

      const existing = await callsService.getCallById(
        app,
        request.orgId!,
        id,
      );
      if (!existing) return reply.code(404).send({ error: "not_found" });
      const denied = denyForEmployeeNonOwner(request, reply, existing);
      if (denied) return denied;

      const ended = await callsService.endCall(
        app,
        request.orgId!,
        request.user!.id,
        id,
        {
          endedAt: input.ended_at,
          finalStatus: input.final_status,
        },
      );
      if (!ended) return reply.code(404).send({ error: "not_found" });
      return reply.code(200).send({ call: ended });
    },
  );

  // -------------------------------------------------------------- //
  // GET /calls/:id/transcript — list
  // -------------------------------------------------------------- //
  app.get(
    "/calls/:id/transcript",
    { preHandler: [requireAuth, orgContext] },
    async (request, reply) => {
      const { id } = UuidParam.parse(request.params);
      const items = await app.withOrgContext(request.orgId!, (client) =>
        transcriptsRepo.listByCallInCurrentOrg(client, id),
      );
      if (items === null) return reply.code(404).send({ error: "not_found" });
      return reply.code(200).send({ items });
    },
  );

  // -------------------------------------------------------------- //
  // POST /calls/:id/transcript — append
  // -------------------------------------------------------------- //
  app.post(
    "/calls/:id/transcript",
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
      const input = TranscriptAppendInput.parse(request.body);

      const existing = await callsService.getCallById(
        app,
        request.orgId!,
        id,
      );
      if (!existing) return reply.code(404).send({ error: "not_found" });
      const denied = denyForEmployeeNonOwner(request, reply, existing);
      if (denied) return denied;

      const transcript = await app.withOrgContext(request.orgId!, (client) =>
        transcriptsRepo.appendForCallInCurrentOrg(client, id, input),
      );
      if (!transcript) return reply.code(404).send({ error: "not_found" });
      return reply.code(201).send({ transcript });
    },
  );

  // -------------------------------------------------------------- //
  // GET /calls/:id/action-items — list
  // -------------------------------------------------------------- //
  app.get(
    "/calls/:id/action-items",
    { preHandler: [requireAuth, orgContext] },
    async (request, reply) => {
      const { id } = UuidParam.parse(request.params);
      const items = await app.withOrgContext(request.orgId!, (client) =>
        actionItemsRepo.listByCallInCurrentOrg(client, id),
      );
      if (items === null) return reply.code(404).send({ error: "not_found" });
      return reply.code(200).send({ items });
    },
  );

  // -------------------------------------------------------------- //
  // POST /calls/:id/action-items — create
  // -------------------------------------------------------------- //
  app.post(
    "/calls/:id/action-items",
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
      const input = ActionItemCreateInput.parse(request.body);

      const existing = await callsService.getCallById(
        app,
        request.orgId!,
        id,
      );
      if (!existing) return reply.code(404).send({ error: "not_found" });
      const denied = denyForEmployeeNonOwner(request, reply, existing);
      if (denied) return denied;

      const actionItem = await app.withOrgContext(request.orgId!, async (client) => {
        const created = await actionItemsRepo.createForCallInCurrentOrg(
          client,
          id,
          input,
        );
        if (created) {
          // Phase 7 Step 3 — audit inside the same tx as the INSERT.
          await recordActionItemCreated(client, {
            orgId:           request.orgId!,
            actorUserId:     request.user!.id,
            actionItemId:    created.id,
            callId:          created.call_id,
            assigneeUserId:  created.assignee_user_id,
          });
        }
        return created;
      });
      if (!actionItem) return reply.code(404).send({ error: "not_found" });
      return reply.code(201).send({ action_item: actionItem });
    },
  );

  // -------------------------------------------------------------- //
  // POST /call-action-items/:id/status — change status
  // -------------------------------------------------------------- //
  app.post(
    "/call-action-items/:id/status",
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
      const { status } = ActionItemStatusInput.parse(request.body);

      // Permission scope traces back to the parent call. RLS hides
      // both the action item and parent call across orgs, so a null
      // here is always a 404 from the caller's perspective.
      const parent = await app.withOrgContext(request.orgId!, (client) =>
        actionItemsRepo.getParentCallForActionItem(client, id),
      );
      if (!parent) return reply.code(404).send({ error: "not_found" });
      const denied = denyForEmployeeNonOwner(request, reply, {
        agent_user_id: parent.agent_user_id,
      });
      if (denied) return denied;

      const updated = await app.withOrgContext(request.orgId!, async (client) => {
        // Read the prior status in the same tx so the audit row can
        // record from→to. RLS scopes the SELECT; cross-org rows yield
        // no row and the route returns 404 below.
        const beforeRow = await client.query<{ status: "open" | "done" | "dropped" }>(
          `SELECT status FROM call_action_items WHERE id = $1`,
          [id],
        );
        const before = beforeRow.rows[0];
        const row = await actionItemsRepo.patchStatusInCurrentOrg(
          client,
          id,
          status,
        );
        if (row && before && before.status !== status) {
          await recordActionItemStatusChanged(client, {
            orgId:        request.orgId!,
            actorUserId:  request.user!.id,
            actionItemId: row.id,
            callId:       row.call_id,
            fromStatus:   before.status,
            toStatus:     status,
          });
        }
        return row;
      });
      if (!updated) return reply.code(404).send({ error: "not_found" });
      return reply.code(200).send({ action_item: updated });
    },
  );

  // -------------------------------------------------------------- //
  // POST /call-action-items/:id/assignee — change assignee
  // -------------------------------------------------------------- //
  app.post(
    "/call-action-items/:id/assignee",
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
      const { assignee_user_id } = ActionItemAssigneeInput.parse(request.body);

      const parent = await app.withOrgContext(request.orgId!, (client) =>
        actionItemsRepo.getParentCallForActionItem(client, id),
      );
      if (!parent) return reply.code(404).send({ error: "not_found" });
      const denied = denyForEmployeeNonOwner(request, reply, {
        agent_user_id: parent.agent_user_id,
      });
      if (denied) return denied;

      const updated = await app.withOrgContext(request.orgId!, async (client) => {
        const beforeRow = await client.query<{ assignee_user_id: string | null }>(
          `SELECT assignee_user_id FROM call_action_items WHERE id = $1`,
          [id],
        );
        const before = beforeRow.rows[0];
        const row = await actionItemsRepo.patchAssigneeInCurrentOrg(
          client,
          id,
          assignee_user_id,
        );
        if (row && before && before.assignee_user_id !== assignee_user_id) {
          await recordActionItemAssigneeChanged(client, {
            orgId:               request.orgId!,
            actorUserId:         request.user!.id,
            actionItemId:        row.id,
            callId:              row.call_id,
            fromAssigneeUserId:  before.assignee_user_id,
            toAssigneeUserId:    assignee_user_id,
          });
        }
        return row;
      });
      if (!updated) return reply.code(404).send({ error: "not_found" });
      return reply.code(200).send({ action_item: updated });
    },
  );

  // -------------------------------------------------------------- //
  // DELETE /call-action-items/:id — hard delete (Phase 6 Step 3)
  //
  // Uses the Phase 5 `assertCanMutateCall` policy (admin / manager
  // team-scope / employee-own / viewer-deny / manager-unassigned-deny).
  // Cross-org and soft-deleted parents collapse to 404 — never 403 —
  // so the response never leaks whether the action item exists
  // elsewhere.
  // -------------------------------------------------------------- //
  app.delete(
    "/call-action-items/:id",
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
      const user = request.user!;
      const actor: Actor = { id: user.id, orgId: user.orgId, role: user.role };
      const deleted = await callActionItemsService.deleteActionItem(
        app,
        actor,
        id,
      );
      if (!deleted) return reply.code(404).send({ error: "not_found" });
      return reply.code(204).send();
    },
  );
}

export default callsRoutes;

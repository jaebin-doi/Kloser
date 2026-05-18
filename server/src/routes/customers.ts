/* /customers/* routes — Phase 2 Step 4.
 *
 * Surface (6 endpoints):
 *   GET    /customers           — list + filter + pagination
 *   GET    /customers/stats     — 4 KPI counts
 *   GET    /customers/:id       — single row
 *   POST   /customers           — create (admin/manager/employee)
 *   PATCH  /customers/:id       — partial update (admin/manager/employee)
 *   DELETE /customers/:id       — soft delete (admin/manager/employee)
 *
 * preHandler:
 *   - Reads (list/stats/byId) → requireAuth + orgContext
 *   - Writes (POST/PATCH/DELETE) → requireAuth + orgContext + requireRole(non-viewer)
 *
 * Validation contract:
 *   - body / :id UUID → zod parse in route handler. Failure → ZodError →
 *     scoped errorHandler maps to 400 { error: "invalid_input", issues }.
 *   - GET /customers query → NOT pre-parsed in the route. service.normalizeListOptions
 *     is the single boundary parser, so invalid status/assignedUserId
 *     surface as InvalidListOptionError → 400 { error: "invalid_<field>", value }.
 *     Pre-parsing in the route would emit ZodError and break the response
 *     contract (Step 4 plan §2-7, §11; the original throwable trio
 *     included `plan`, removed in 1715000003000_drop_customers_plan.sql).
 *
 * RLS isolation: a Bearer JWT for org A that targets a row in org B
 * receives 404 (RLS USING evaluates org_id = NULL → 0 rows → service
 * returns null/false). The error never says "exists in another org".
 */
import type { FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { orgContext } from "../middleware/orgContext.js";
import { requireRole } from "../middleware/role.js";
import {
  CustomerCreateInput,
  CustomerPatch,
} from "../types/customers.js";
import {
  createCustomer,
  deleteCustomer,
  getCustomerById,
  getCustomerStats,
  InvalidListOptionError,
  listCustomers,
  updateCustomer,
} from "../services/customers.js";
import { PlanLimitExceededError } from "../services/billing.js";

// Permissive UUID regex matching Phase 1 (services/auth.ts) and the
// shared types module. zod 4.x .uuid() enforces RFC 4122 version/variant
// bits, which the deterministic seed UUIDs do not satisfy.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UuidParam = z.object({
  id: z.string().regex(UUID_RE, "invalid uuid"),
});

async function customersRoutes(app: FastifyInstance) {
  // Plugin-scoped error handler. Encapsulation keeps it from interfering
  // with authRoutes / meRoutes — those continue to use their own error
  // shaping (sendAuthError, default fastify handler).
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: "invalid_input",
        issues: err.flatten(),
      });
    }
    if (err instanceof InvalidListOptionError) {
      return reply.code(400).send({
        error: `invalid_${err.field}`,
        value: err.value,
      });
    }
    if (err instanceof PlanLimitExceededError) {
      // Phase 7 Step 9 — customers cap rejection. Structured 403 so the
      // frontend can render a single banner regardless of which mutation
      // tripped the cap.
      return reply.code(403).send({
        error: "plan_limit_exceeded",
        code: "plan_limit_exceeded",
        limit_key: err.limitKey,
        plan: err.plan,
        current: err.current,
        limit: err.limit,
        attempted: err.attempted,
      });
    }
    // Anything else: let fastify's default handler log + 500.
    reply.send(err);
  });

  // ---------- reads ---------- //

  app.get(
    "/customers",
    { preHandler: [requireAuth, orgContext] },
    async (request, reply) => {
      // Pass req.query through unchanged. service.normalizeListOptions is
      // the single boundary parser; pre-parsing here would re-route
      // status/assignedUserId failures to ZodError and break the
      // `invalid_<field> + value` contract.
      const result = await listCustomers(app, request.orgId!, request.query);
      return reply.code(200).send(result);
    },
  );

  app.get(
    "/customers/stats",
    { preHandler: [requireAuth, orgContext] },
    async (request, reply) => {
      const stats = await getCustomerStats(app, request.orgId!);
      return reply.code(200).send(stats);
    },
  );

  app.get(
    "/customers/:id",
    { preHandler: [requireAuth, orgContext] },
    async (request, reply) => {
      const { id } = UuidParam.parse(request.params);
      const customer = await getCustomerById(app, request.orgId!, id);
      if (!customer) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.code(200).send({ customer });
    },
  );

  // ---------- writes ---------- //

  app.post(
    "/customers",
    {
      preHandler: [
        requireAuth,
        orgContext,
        requireRole("admin", "manager", "employee"),
      ],
    },
    async (request, reply) => {
      const input = CustomerCreateInput.parse(request.body);
      const customer = await createCustomer(
        app,
        request.orgId!,
        request.user!.id,
        input,
      );
      return reply.code(201).send({ customer });
    },
  );

  app.patch(
    "/customers/:id",
    {
      preHandler: [
        requireAuth,
        orgContext,
        requireRole("admin", "manager", "employee"),
      ],
    },
    async (request, reply) => {
      const { id } = UuidParam.parse(request.params);
      const patch = CustomerPatch.parse(request.body);
      const customer = await updateCustomer(
        app,
        request.orgId!,
        request.user!.id,
        id,
        patch,
      );
      if (!customer) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.code(200).send({ customer });
    },
  );

  app.delete(
    "/customers/:id",
    {
      preHandler: [
        requireAuth,
        orgContext,
        requireRole("admin", "manager", "employee"),
      ],
    },
    async (request, reply) => {
      const { id } = UuidParam.parse(request.params);
      const ok = await deleteCustomer(
        app,
        request.orgId!,
        request.user!.id,
        id,
      );
      if (!ok) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.code(204).send();
    },
  );
}

export default customersRoutes;

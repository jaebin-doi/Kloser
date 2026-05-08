/* customers service.
 *
 * Sits between Step 4 routes and the customers repository. Responsibilities
 * are limited to:
 *   - opening withOrgContext for every call so RLS context is set
 *   - normalizing list query options (delegated to the CustomerListQuery
 *     zod schema from shared types — caller still passes raw input,
 *     this layer is the boundary parser)
 *   - passing actorOrgId to repo.insertInCurrentOrg so the new row's
 *     org_id matches the RLS context (defense in depth — RLS WITH CHECK
 *     blocks mismatches at the SQL layer too)
 *   - mapping deleteCustomer to the repository's soft-delete path
 *
 * Out of scope (handled elsewhere):
 *   - role checks: Step 4 route preHandler via requireRole()
 *   - validating POST/PATCH body shape: Step 4 route via shared zod
 *     schemas (CustomerCreateInput / CustomerPatch). Service receives
 *     already-typed input for those endpoints.
 *   - workflow/business rules and audit events: later phases
 */
import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import * as repo from "../repositories/customers.js";
import {
  CustomerListQuery,
  type Customer,
  type CustomerCreateInput,
  type CustomerListQuery as CustomerListQueryType,
  type CustomerPatch,
  type CustomerStats,
} from "../types/customers.js";

export class InvalidListOptionError extends Error {
  constructor(
    public readonly field: string,
    public readonly value: unknown,
    message?: string,
  ) {
    super(message ?? `invalid ${field}`);
    this.name = "InvalidListOptionError";
  }
}

// CustomerListQuery is constructed so that q/sort/dir/limit/offset never
// throw: preprocess + .catch + .default normalize them. Only status and
// assignedUserId can produce ZodIssues. If a ZodError surfaces with any
// other path[0], the schema invariant has been broken — better to crash
// loudly in dev than to silently swallow it.
//
// (`plan` was removed in 1715000003000_drop_customers_plan.sql.)
const THROWABLE_FIELDS = new Set(["status", "assignedUserId"]);

export function normalizeListOptions(raw: unknown): CustomerListQueryType {
  // Step 2 behavior: any non-plain-object raw input (string, number,
  // array, boolean, null, undefined) coerces to an empty record and
  // produces default list options. zod's z.object() rejects non-objects,
  // so we normalize first to preserve the contract.
  const input: Record<string, unknown> =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const result = CustomerListQuery.safeParse(input);
  if (result.success) return result.data;

  const issue = result.error.issues[0];
  const field = issue && issue.path.length > 0 ? String(issue.path[0]) : "(unknown)";
  if (!THROWABLE_FIELDS.has(field)) {
    // Schema invariant violation — q/sort/dir/limit/offset must never
    // reach this branch after the object normalization above. Re-throw
    // the raw ZodError so the developer sees the unexpected path.
    throw result.error;
  }
  throw new InvalidListOptionError(field, input[field]);
}

export interface CustomerListResult {
  items: Customer[];
  total: number;
}

export async function listCustomers(
  app: FastifyInstance,
  actorOrgId: string,
  rawOpts: unknown,
): Promise<CustomerListResult> {
  const opts = normalizeListOptions(rawOpts);
  return app.withOrgContext(actorOrgId, async (client) => {
    // Same client + same transaction: pg connections are single-shot, so
    // running list and count sequentially is the correct shape (Promise.all
    // would serialize anyway and confuse error handling).
    const items = await repo.listForCurrentOrg(client, opts);
    const total = await repo.countForCurrentOrg(client, opts);
    return { items, total };
  });
}

export async function getCustomerStats(
  app: FastifyInstance,
  actorOrgId: string,
): Promise<CustomerStats> {
  return app.withOrgContext(actorOrgId, (client) =>
    repo.statsForCurrentOrg(client),
  );
}

export async function getCustomerById(
  app: FastifyInstance,
  actorOrgId: string,
  id: string,
): Promise<Customer | null> {
  return app.withOrgContext(actorOrgId, (client) =>
    repo.getByIdInCurrentOrg(client, id),
  );
}

export async function createCustomer(
  app: FastifyInstance,
  actorOrgId: string,
  input: CustomerCreateInput,
): Promise<Customer> {
  return app.withOrgContext(actorOrgId, (client) =>
    repo.insertInCurrentOrg(client, actorOrgId, input),
  );
}

export async function updateCustomer(
  app: FastifyInstance,
  actorOrgId: string,
  id: string,
  patch: CustomerPatch,
): Promise<Customer | null> {
  return app.withOrgContext(actorOrgId, (client) =>
    repo.updateByIdInCurrentOrg(client, id, patch),
  );
}

export async function deleteCustomer(
  app: FastifyInstance,
  actorOrgId: string,
  id: string,
): Promise<boolean> {
  return app.withOrgContext(actorOrgId, (client) =>
    repo.softDeleteByIdInCurrentOrg(client, id),
  );
}

// Re-export so existing call sites (Step 4 route catch, tests) can import
// the ZodError type symbol from this module if needed. Keeping it close
// to InvalidListOptionError clarifies the boundary error vocabulary.
export { ZodError };

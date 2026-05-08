/* customers service.
 *
 * Sits between Step 4 routes and the customers repository. Responsibilities
 * are limited to:
 *   - opening withOrgContext for every call so RLS context is set
 *   - normalizing list query options (clamps for limit/offset, default
 *     fallbacks for sort/dir, throw on invalid status/plan/assignedUserId)
 *   - passing actorOrgId to repo.insertInCurrentOrg so the new row's
 *     org_id matches the RLS context (defense in depth — RLS WITH CHECK
 *     blocks mismatches at the SQL layer too)
 *   - mapping deleteCustomer to the repository's soft-delete path
 *
 * Out of scope (handled elsewhere):
 *   - role checks: Step 4 route preHandler via requireRole()
 *   - input shape validation: Step 3 zod schemas (this layer is ad-hoc TS)
 *   - workflow/business rules and audit events: later phases
 */
import type { FastifyInstance } from "fastify";
import * as repo from "../repositories/customers.js";
import type {
  Customer,
  CustomerCreateInput,
  CustomerListOptions,
  CustomerPatch,
  CustomerPlan,
  CustomerSortKey,
  CustomerStats,
  CustomerStatus,
  SortDirection,
} from "../repositories/customers.js";

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

const STATUS_SET = new Set<CustomerStatus>(["active", "review", "pending"]);
const PLAN_SET = new Set<CustomerPlan>(["Starter", "Pro", "Enterprise"]);
const SORT_SET = new Set<CustomerSortKey>([
  "name",
  "created_at",
  "last_contacted_at",
]);
const DIR_SET = new Set<SortDirection>(["asc", "desc"]);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const Q_MAX_LENGTH = 200;

function clampLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_LIMIT;
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number.parseInt(raw, 10)
        : Number.NaN;
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  if (n < 1) return 1;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return Math.floor(n);
}

function clampOffset(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return 0;
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number.parseInt(raw, 10)
        : Number.NaN;
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  return Math.floor(n);
}

function pickSort(raw: unknown): CustomerSortKey {
  if (typeof raw === "string" && SORT_SET.has(raw as CustomerSortKey)) {
    return raw as CustomerSortKey;
  }
  return "created_at";
}

function pickDir(raw: unknown): SortDirection {
  if (typeof raw === "string" && DIR_SET.has(raw as SortDirection)) {
    return raw as SortDirection;
  }
  return "desc";
}

function pickStatus(raw: unknown): CustomerStatus | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw === "string" && STATUS_SET.has(raw as CustomerStatus)) {
    return raw as CustomerStatus;
  }
  throw new InvalidListOptionError("status", raw);
}

function pickPlan(raw: unknown): CustomerPlan | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw === "string" && PLAN_SET.has(raw as CustomerPlan)) {
    return raw as CustomerPlan;
  }
  throw new InvalidListOptionError("plan", raw);
}

function pickAssignedUserId(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  // Explicit null = "unassigned" filter; "null" string travels through query
  // strings the same way and is treated as the same intent.
  if (raw === null || raw === "null") return null;
  if (typeof raw === "string") {
    if (raw === "") return undefined;
    if (UUID_RE.test(raw)) return raw;
  }
  throw new InvalidListOptionError("assignedUserId", raw);
}

function pickQ(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  return trimmed.slice(0, Q_MAX_LENGTH);
}

export function normalizeListOptions(raw: unknown): CustomerListOptions {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    q: pickQ(r.q),
    status: pickStatus(r.status),
    plan: pickPlan(r.plan),
    assignedUserId: pickAssignedUserId(r.assignedUserId),
    limit: clampLimit(r.limit),
    offset: clampOffset(r.offset),
    sort: pickSort(r.sort),
    dir: pickDir(r.dir),
  };
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

/* /activity-log routes — Phase 7 Step 3.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_3_PLAN.md §8.
 *
 * Surface (admin-only):
 *   GET /activity-log?limit&beforeCreatedAt&beforeId
 *                    &action&targetType&targetId&userId
 *                    &createdFrom&createdTo
 *     → { items: ActivityLog[], nextCursor: { beforeCreatedAt, beforeId } | null }
 *
 * preHandler chain:
 *   requireAuth → orgContext → requireRole("admin") → requireFreshRole
 *
 * Authorization (master plan §5 + Step 3 plan §8):
 *   - admin       : sees only own org's audit rows. RLS pins org_id;
 *                   no `WHERE org_id = ...` is added in the SQL.
 *   - manager/employee/viewer : 403 (requireRole gate).
 *   - stale admin JWT (DB demoted to employee) : 401 stale_role
 *                   (requireFreshRole gate).
 *
 * Cross-org isolation:
 *   - target_id / user_id filters belonging to another org return
 *     empty pages, NOT 403. The repository's listForCurrentOrg
 *     query runs under `withOrgContext`, and RLS drops every row
 *     whose org_id differs from current_app_org_id(). So a curious
 *     admin who tries to look up another org's user_id sees zero
 *     hits, with no signal as to whether the id exists elsewhere.
 *
 * Cursor pagination (the repository owns the actual SQL — this route
 * just translates the query string and packages the response):
 *   - The route asks the repo for `limit + 1` rows so it can detect a
 *     next page without an extra count round-trip.
 *   - If the result has `limit + 1` rows: trim to `limit`, build
 *     `nextCursor` from the last visible row's
 *     (created_at, id) pair.
 *   - Otherwise: nextCursor = null (this is the last page).
 *   - The browser sends the cursor back as
 *     `?beforeCreatedAt=<iso>&beforeId=<uuid>` for the next page.
 *
 * Limit:
 *   - Default 20 (good first-page size for an audit feed).
 *   - Hard cap 100, mirroring the repo's clamp.
 *   - Negative/non-integer/oversized values → 400 invalid_input.
 *
 * Date filters:
 *   - createdFrom / createdTo / beforeCreatedAt are ISO-8601 strings
 *     on the wire. `z.coerce.date()` parses them; an unparseable
 *     string surfaces as 400 invalid_input via the ZodError handler.
 */
import type { FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { orgContext } from "../middleware/orgContext.js";
import { requireRole } from "../middleware/role.js";
import { requireFreshRole } from "../middleware/requireFreshRole.js";
import { AuthError } from "../services/auth.js";
import {
  listForCurrentOrg,
  type ActivityAction,
  type ActivityLogRow,
  type ActivityTargetType,
} from "../repositories/activityLog.js";

// Allow-lists for the route layer. Re-declared here so a typo'd query
// (?action=foo) is rejected as 400 invalid_input BEFORE hitting the
// DB CHECK (which would surface as a 500). The literal union must
// stay in sync with `repositories/activityLog.ts` — TypeScript will
// fail the build if a new action lands in the repo but not here
// (because the .parse() call uses the ACTIVITY_ACTIONS array as the
// zod enum source).
const ACTIVITY_ACTIONS = [
  "auth.login",
  "auth.logout",
  "auth.refresh_mfa_required",
  "auth.password_reset_requested",
  "auth.password_reset_completed",
  "auth.email_verified",
  "auth.email_verification_resent",
  "mfa.login_challenge_issued",
  "mfa.login_verified",
  "mfa.setup_started",
  "mfa.enabled",
  "mfa.disabled",
  "mfa.failed_attempt",
  "mfa.locked",
  "organization.mfa_required_enabled",
  "organization.mfa_required_disabled",
  "membership.role_changed",
  "membership.status_changed",
  "membership.team_changed",
  "invitation.created",
  "invitation.resent",
  "invitation.cancelled",
  "invitation.accepted",
  "customer.created",
  "customer.updated",
  "customer.deleted",
  "call.created",
  "call.ended",
  "call.customer_linked",
  "call.customer_unlinked",
  "call.notes_updated",
  "call.manual_summary_updated",
  "call_action_item.created",
  "call_action_item.status_changed",
  "call_action_item.assignee_changed",
  "call_action_item.deleted",
  "knowledge_base.created",
  "knowledge_base.updated",
  "knowledge_base.deleted",
  "knowledge_chunk.replaced",
  "checklist_template.created",
  "checklist_template.updated",
  "checklist_template.deleted",
  "report.team_viewed",
  // Phase 7 Step 4 — retention worker aggregate events
  "retention.transcripts_deleted",
  "email_outbox.sending_recovered",
] as const satisfies readonly ActivityAction[];

const ACTIVITY_TARGET_TYPES = [
  "organization",
  "user",
  "membership",
  "invitation",
  "customer",
  "call",
  "call_action_item",
  "knowledge_base",
  "knowledge_chunk",
  "checklist_template",
  "auth_token",
  "session",
  "report",
] as const satisfies readonly ActivityTargetType[];

// Permissive 8-4-4-4-12 hex UUID (AGENTS.md backend conventions).
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// Empty string in a query param ("?action=") becomes undefined — this
// keeps the URL ?foo=&bar= idiom from 400'ing on optional filters.
const emptyToUndefined = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const ListQuery = z.object({
  limit: z.preprocess(
    emptyToUndefined,
    z.coerce
      .number()
      .int("limit must be an integer")
      .positive("limit must be positive")
      .max(MAX_LIMIT, `limit cannot exceed ${MAX_LIMIT}`)
      .optional(),
  ),
  beforeCreatedAt: z.preprocess(
    emptyToUndefined,
    z.coerce.date().optional(),
  ),
  beforeId: z.preprocess(
    emptyToUndefined,
    z.string().regex(UUID_RE, "invalid uuid").optional(),
  ),
  action: z.preprocess(
    emptyToUndefined,
    z.enum(ACTIVITY_ACTIONS).optional(),
  ),
  targetType: z.preprocess(
    emptyToUndefined,
    z.enum(ACTIVITY_TARGET_TYPES).optional(),
  ),
  targetId: z.preprocess(
    emptyToUndefined,
    z.string().regex(UUID_RE, "invalid uuid").optional(),
  ),
  userId: z.preprocess(
    emptyToUndefined,
    z.string().regex(UUID_RE, "invalid uuid").optional(),
  ),
  createdFrom: z.preprocess(
    emptyToUndefined,
    z.coerce.date().optional(),
  ),
  createdTo: z.preprocess(
    emptyToUndefined,
    z.coerce.date().optional(),
  ),
});

interface SerializedActivityLog {
  id: string;
  org_id: string;
  user_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

function serializeRow(row: ActivityLogRow): SerializedActivityLog {
  return {
    id: row.id,
    org_id: row.org_id,
    user_id: row.user_id,
    action: row.action,
    target_type: row.target_type,
    target_id: row.target_id,
    payload: row.payload,
    created_at: row.created_at.toISOString(),
  };
}

async function activityLogRoutes(app: FastifyInstance) {
  // Plugin-scoped error handler — mirrors routes/organizationSecurity.ts
  // pattern. ZodError → 400 invalid_input (covers UUID/date/limit/enum
  // failures). AuthError surfaces its declared statusCode/code. Anything
  // else falls through to Fastify's default handler so genuine 5xx
  // problems are still logged.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: "invalid_input",
        code: "invalid_input",
        issues: err.flatten(),
      });
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
    throw err;
  });

  app.get(
    "/activity-log",
    {
      // requireFreshRole is the last gate by convention (cheapest check
      // first). For a read endpoint we still want it because audit log
      // visibility is admin-only and a freshly demoted admin should not
      // be able to read pending audit rows with a still-valid token.
      preHandler: [
        requireAuth,
        orgContext,
        requireRole("admin"),
        requireFreshRole,
      ],
    },
    async (request, reply) => {
      if (!request.user || !request.orgId) {
        return reply
          .code(401)
          .send({ error: "authentication required", code: "auth_required" });
      }

      const q = ListQuery.parse(request.query ?? {});
      const limit = q.limit ?? DEFAULT_LIMIT;

      // Ask for limit + 1 rows so we can detect "is there another page?"
      // without a separate COUNT(*) round-trip. The repository hard-caps
      // list queries at 100, so the public max-limit page needs a tiny
      // second probe after the last visible row.
      const peekLimit = limit < MAX_LIMIT ? limit + 1 : MAX_LIMIT;
      const rows = await app.withOrgContext(
        request.orgId,
        (client) =>
          listForCurrentOrg(client, {
            limit: peekLimit,
            beforeCreatedAt: q.beforeCreatedAt,
            beforeId: q.beforeId,
            action: q.action,
            targetType: q.targetType,
            targetId: q.targetId,
            userId: q.userId,
            createdFrom: q.createdFrom,
            createdTo: q.createdTo,
          }),
      );

      // If the repo returned exactly `peekLimit` rows AND that peek was
      // strictly bigger than the caller's requested `limit`, there is
      // at least one more page. For limit=100, do a one-row probe from
      // the last visible row because the repo cap prevents limit+1.
      let hasMore = peekLimit > limit && rows.length === peekLimit;
      const visible = hasMore ? rows.slice(0, limit) : rows;
      const lastVisible = visible[visible.length - 1] ?? null;

      if (!hasMore && limit === MAX_LIMIT && rows.length === limit && lastVisible) {
        const probe = await app.withOrgContext(
          request.orgId,
          (client) =>
            listForCurrentOrg(client, {
              limit: 1,
              beforeCreatedAt: lastVisible.created_at,
              beforeId: lastVisible.id,
              action: q.action,
              targetType: q.targetType,
              targetId: q.targetId,
              userId: q.userId,
              createdFrom: q.createdFrom,
              createdTo: q.createdTo,
            }),
        );
        hasMore = probe.length > 0;
      }

      return reply.code(200).send({
        items: visible.map(serializeRow),
        nextCursor: hasMore && lastVisible
          ? {
              beforeCreatedAt: lastVisible.created_at.toISOString(),
              beforeId: lastVisible.id,
            }
          : null,
      });
    },
  );
}

export default activityLogRoutes;

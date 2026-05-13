# Phase 6 Step 4 Plan - Manager Team Reports

> Parent plan: `docs/plan/phase-6/PHASE_6_MASTER.md` section 4 Step 4.
> Previous step: Phase 6 Step 3 closeout (`4ae94e7 Add Phase 6 action item delete`).
> Scope: service -> route -> shared types -> frontend -> tests + findings.
> Schema changes: none.

---

## 0. Goal

Add a small report surface that lets a manager see call KPIs for their own team only.

The read restriction is enforced in the service layer. Existing RLS remains org-scoped; Step 4 does not change policies or migrations. The route must not leak whether a team exists in another organization.

This step is not a broad analytics project. Keep the report compact, deterministic, and testable:

- call counts
- completion / response metrics
- average duration
- recent team calls

---

## 1. Non-Goals

Do not include these in Step 4:

- database migration or RLS policy changes
- cost reporting for `llm_usage_log`
- Phase 6 Step 5 e2e closeout
- README / server README updates
- audit log / retention / export features
- package dependency changes
- real-time report updates

Employee and viewer report experiences are deliberately not expanded here. They should receive `403 forbidden` from this endpoint. If a future product decision needs employee-own reports or viewer org KPI reports, add a separate endpoint or a clearly scoped follow-up.

---

## 2. Endpoint Decision

Use a new reports route:

```http
GET /reports/team-summary?team_id=<uuid optional>
```

Why a new route instead of extending `/dashboard/summary`:

- `dashboard.html` already has a general org dashboard contract.
- Manager team reports have narrower authorization and a different response shape.
- A separate `reports.ts` route keeps Step 4 easy to test and avoids weakening the existing dashboard route.

Register the route in `server/src/server.ts` after the existing core routes.

---

## 3. Authorization Matrix

The endpoint is admin/manager only.

| Actor | `team_id` omitted | own team_id | other same-org team_id | cross-org team_id | no membership team |
|---|---|---|---|---|---|
| admin | 200 org-wide summary | 200 team summary | 200 team summary | 404 | n/a |
| manager | 200 own team summary | 200 own team summary | 403 | 404 | 403 |
| employee | 403 | 403 | 403 | 403 or 404 via prehandler/service | n/a |
| viewer | 403 | 403 | 403 | 403 or 404 via prehandler/service | n/a |

Notes:

- Cross-org `team_id` should resolve as `404 not_found` when the service checks the team under `app.withOrgContext`.
- Manager same-org other-team is `403 forbidden` because the row exists in the same org but the actor is not allowed to read it.
- Use `requireAuth`, `orgContext`, `requireVerified`, and `requireFreshRole`.
- Prefer `requireRole("admin", "manager")` at the route layer. If the service still accepts employee/viewer for explicit branch tests, the route tests must prove they cannot receive data.

---

## 4. Query Semantics

`team_id` is optional.

Admin:

- no `team_id`: org-wide report across all non-deleted calls
- with `team_id`: report for that same-org team

Manager:

- no `team_id`: manager's current membership team
- own `team_id`: same result as omitted
- other same-org `team_id`: 403

Team membership source:

- Use `memberships.team_id` for the current actor.
- If a manager has no `team_id`, return 403. Do not fall back to org-wide.

Call inclusion:

- `calls.deleted_at IS NULL`
- For team-scoped reports, include calls whose `agent_user_id` belongs to the selected team.
- Exclude unassigned calls from manager team summaries. Admin org-wide reports may include unassigned calls in total metrics, but recent-call rows should show `team_id: null` / `team_name: null` if included.

Time window:

- Use all-time metrics for Step 4.
- Reason: Step 4 is primarily a read-scope feature, and all-time metrics avoid adding date query parsing and timezone decisions. Daily/weekly filters can be Phase 7+.
- Include `generated_at` so the frontend can show when the report was loaded.

---

## 5. Response Shape

Create shared types:

- `server/src/types/teamReport.ts`
- `platform/types/teamReport.js`

Register one new sync entity in `test/sync_shared_types.mjs`:

```js
{
  name: "teamReport",
  server: "server/src/types/teamReport.ts",
  browser: "platform/types/teamReport.js",
  types: ["TeamReportSummary", "TeamReportRecentCall"],
}
```

Current sync registry count is 14. Step 4 should normally make it 15, not 16. The master plan's "14 -> 16" wording is stale unless implementation adds a second meaningful entity. Do not add a fake entity just to hit 16; update `PHASE_6_MASTER.md` and findings with the actual count.

Recommended zod shape:

```ts
export const TeamReportRecentCall = z.object({
  id: UuidString,
  customer_id: UuidString.nullable(),
  customer_name: z.string().nullable(),
  agent_user_id: UuidString.nullable(),
  agent_name: z.string().nullable(),
  team_id: UuidString.nullable(),
  team_name: z.string().nullable(),
  direction: z.enum(["inbound", "outbound", "meeting"]),
  status: z.enum(["in_progress", "ended", "missed", "dropped"]),
  started_at: z.date(),
  ended_at: z.date().nullable(),
  duration_seconds: z.number().int().nonnegative().nullable(),
  title: z.string().nullable(),
  sentiment: z.enum(["positive", "neutral", "cautious", "negative"]).nullable(),
});

export const TeamReportSummary = z.object({
  scope: z.enum(["org", "team"]),
  team_id: UuidString.nullable(),
  team_name: z.string().nullable(),
  generated_at: z.date(),
  total_calls: z.number().int().nonnegative(),
  ended_calls: z.number().int().nonnegative(),
  missed_calls: z.number().int().nonnegative(),
  dropped_calls: z.number().int().nonnegative(),
  active_calls: z.number().int().nonnegative(),
  response_rate: z.number().min(0).max(1).nullable(),
  avg_duration_seconds: z.number().nonnegative().nullable(),
  recent_calls: z.array(TeamReportRecentCall),
});
```

`response_rate = ended_calls / (ended_calls + missed_calls)`. Exclude `dropped` from the denominator for the same reason as `/dashboard/summary`: network drops are not a human response signal. Return `null` when the denominator is zero.

---

## 6. Backend Structure

### 6.1 Service

Create:

```text
server/src/services/teamReports.ts
```

Suggested exported function:

```ts
export interface TeamReportActor {
  userId: string;
  orgId: string;
  role: "admin" | "manager" | "employee" | "viewer";
}

export interface TeamReportOptions {
  teamId?: string;
}

export async function getTeamReportSummary(
  app: FastifyInstance,
  actor: TeamReportActor,
  opts: TeamReportOptions,
): Promise<TeamReportSummary>;
```

Rules:

1. Wrap all database reads in `app.withOrgContext(actor.orgId, actor.userId, async client => ...)`.
2. Resolve `opts.teamId` inside the transaction.
3. If `opts.teamId` is present but not visible in the current org, throw a not-found error that the route maps to 404.
4. If actor is manager and requested team differs from actor membership team, throw `PermissionError`.
5. If actor is manager and has no team, throw `PermissionError`.
6. If actor is employee/viewer, throw `PermissionError` for this endpoint.
7. Compute metrics and recent calls from the same resolved scope.

Use the existing `PermissionError` from `services/callPermissions.ts` if appropriate. If a not-found helper class is introduced, keep it local and simple.

### 6.2 Route

Create:

```text
server/src/routes/reports.ts
```

Route:

```ts
app.get(
  "/reports/team-summary",
  {
    preHandler: [
      requireAuth,
      orgContext,
      requireVerified,
      requireRole("admin", "manager"),
      requireFreshRole,
    ],
  },
  async (request, reply) => { ... },
);
```

Request query:

- `team_id?: uuid`

Responses:

- 200 `TeamReportSummary`
- 400 `invalid_input`
- 401/403 auth errors from middleware
- 403 `forbidden` for same-org unauthorized team access
- 404 `not_found` for cross-org or missing team_id
- 500 `rls_violation` for PostgreSQL `42501`

Use the repository's permissive UUID regex convention, not `z.string().uuid()`.

### 6.3 SQL Guidance

For team scope, a straightforward pattern is:

```sql
WHERE c.deleted_at IS NULL
  AND c.agent_user_id IN (
    SELECT m.user_id
      FROM memberships m
     WHERE m.team_id = $1
  )
```

For admin org scope, omit the team filter.

Recent calls:

- order by `started_at DESC, id DESC`
- limit 10
- left join `customers`, `users`, `memberships`, `teams`
- keep soft-deleted customers invisible with `customers.deleted_at IS NULL`

Do not trust a body-provided org id. There should be no request body.

---

## 7. Frontend Plan

Create a dedicated page:

```text
platform/reports.html
```

Update:

```text
platform/api.js
platform/_shared.js
```

API helper:

```js
async function getTeamReportSummary(params = {}) {
  const qs = new URLSearchParams();
  if (params.teamId) qs.set("team_id", params.teamId);
  return apiGet("/reports/team-summary" + (qs.toString() ? "?" + qs.toString() : ""));
}
```

Expose it on `window.kloserApi`.

Navigation:

- Add a sidebar nav item for `reports.html`.
- Use the existing dense SaaS dashboard styling. Do not create a marketing page.

UI content:

- KPI row: total, ended, response rate, average duration, active
- recent calls table/list
- simple scope label:
  - admin org-wide
  - admin selected team
  - manager own team

Team selector:

- Optional for Step 4. If implemented, admin can select teams using an existing team API.
- Manager does not need a selector. If a selector is present, manager must only see their own team.
- To reduce risk, the first implementation may omit the selector and rely on optional `team_id` only for backend tests.

API/demo boundary:

- Report metrics: API
- recent calls: API
- team/user/customer/call names: API
- no new demo data should be introduced

XSS gate:

- Prefer `textContent` and DOM construction.
- If `innerHTML` is used for rows/cards, every API-provided field must be escaped:
  - `customer_name`
  - `agent_name`
  - `team_name`
  - `title`
  - `status`
  - `direction`
  - dates if inserted as strings
- Findings must include a short interpolation classification table.

---

## 8. Tests

Create:

```text
server/test/phase6_team_reports.test.mjs
```

Minimum cases:

1. admin with no `team_id` gets 200 org-wide metrics.
2. admin with same-org `team_id` gets 200 team metrics.
3. admin with cross-org `team_id` gets 404.
4. manager with no `team_id` gets 200 for own team only.
5. manager with own `team_id` gets 200.
6. manager with other same-org `team_id` gets 403.
7. manager with cross-org `team_id` gets 404.
8. manager without `team_id` membership gets 403.
9. employee gets 403.
10. viewer gets 403.
11. invalid `team_id` gets 400 `invalid_input`.
12. deleted calls are excluded from metrics and recent calls.
13. unassigned calls are excluded from manager team scope.
14. response_rate is `null` when ended + missed denominator is zero.

Use existing fixture helpers where possible. Keep cleanup scoped and do not leave report test rows behind.

---

## 9. Validation

Run:

```powershell
npm --prefix server run typecheck
npm --prefix server test
node test/sync_shared_types.mjs
```

Also run a static frontend syntax check for:

- `platform/reports.html`
- `platform/api.js`
- `platform/_shared.js`

Live browser smoke is optional in Step 4 if the API/static servers are not already running. If skipped, record it in findings and leave browser path verification to Step 5 e2e.

---

## 10. Documentation Closeout

Create:

```text
docs/plan/phase-6/PHASE_6_STEP_4_FINDINGS.md
```

Update:

```text
docs/plan/phase-6/PHASE_6_MASTER.md
```

Only mark Step 4 complete when implementation and validation are done.

Update master items:

- Implementation Log Step 4 checkbox
- go/no-go: `Manager team-scope read 보고서 + 권한 매트릭스 검증`
- sync shared type count wording, using the actual count

Do not update README files in Step 4. README closeout belongs to Step 5.

---

## 11. Completion Checklist

- [ ] `PHASE_6_STEP_4_PLAN.md` checked in with final decisions.
- [ ] `server/src/services/teamReports.ts` added.
- [ ] `server/src/routes/reports.ts` added and registered.
- [ ] `server/src/types/teamReport.ts` added.
- [ ] `platform/types/teamReport.js` added.
- [ ] `test/sync_shared_types.mjs` registry updated.
- [ ] `platform/api.js` report helper added.
- [ ] `platform/_shared.js` reports nav added if `reports.html` is created.
- [ ] `platform/reports.html` added or an explicit dashboard integration decision documented.
- [ ] `server/test/phase6_team_reports.test.mjs` covers the authorization matrix and KPI edge cases.
- [ ] XSS gate classification documented.
- [ ] API/demo boundary documented.
- [ ] `npm --prefix server run typecheck` PASS.
- [ ] `npm --prefix server test` PASS.
- [ ] `node test/sync_shared_types.mjs` PASS with actual entity count documented.
- [ ] `PHASE_6_STEP_4_FINDINGS.md` written.
- [ ] `PHASE_6_MASTER.md` Step 4 and relevant go/no-go entries updated only after verification.

# Phase 7 Step 7 Plan — reports date window and agent drilldown

작성일: 2026-05-18

상위 문서: `PHASE_7_MASTER.md`

선행 완료:

- Step 1 — Resend email delivery + transactional `email_outbox`
- Step 2 — TOTP MFA / session hardening
- Step 3 — `activity_log` audit trail + admin query surface
- Step 4 — retention enforce cron
- Step 5 — `llm_usage_log.cost_usd_micros` price map
- Step 6 — role-based sidebar visibility

이번 step의 목적은 `reports.html`을 "전체 기간 단일 요약"에서 운영자가 실제로 비교할 수 있는 보고서로 올리는 것이다. 구체적으로 `GET /reports/team-summary`에 date window를 추가하고, 응답에 상담원별 KPI breakdown을 포함해 frontend에서 상담원 drilldown을 제공한다. 새 제품 영역을 넓히지 않고 기존 manager/admin report surface만 정교화한다.

---

## 1. Current State

### 1.1 이미 있는 것

- Backend route
  - `GET /reports/team-summary?team_id=<uuid optional>`
  - admin: org-wide 또는 same-org team.
  - manager: own team only.
  - employee/viewer: 403.
- Service
  - `server/src/services/teamReports.ts`
  - `aggregateMetrics(client, teamId)`
  - `recentCalls(client, teamId)`
  - `getTeamReportSummary(app, actor, opts)`
  - 모든 DB read는 `app.withOrgContext(actor.orgId, actor.userId, ...)` 안에서 수행.
- Shared types
  - `server/src/types/teamReport.ts`
  - `platform/types/teamReport.js`
  - `test/sync_shared_types.mjs`에 `TeamReportSummary`, `TeamReportRecentCall` 등록됨.
- Frontend
  - `platform/reports.html`
  - KPI 5개, status breakdown, recent calls table.
  - server fields는 `textContent` 또는 `escapeHtml` 후 `innerHTML`로 렌더.
- Audit
  - `recordReportTeamViewed(...)`
  - 현재 payload는 `{ scope, team_id }`만.
  - best-effort `tryRecordActivity`, response를 막지 않음.

### 1.2 현재 부족한 것

- date range query가 없다. 보고서가 전체 기간 누적만 보여 운영 분석에 부족하다.
- 상담원별 breakdown이 없다. manager/admin이 팀 내 누가 어떤 상태인지 비교할 수 없다.
- frontend에 기간 preset / custom date controls가 없다.
- report audit payload가 어떤 기간의 보고서를 열었는지 설명하지 못한다.

---

## 2. Scope

### 한다

1. **Date window**
   - `/reports/team-summary` query에 기간 필터 추가.
   - 권장 query:
     - `from=<YYYY-MM-DD>`
     - `to=<YYYY-MM-DD>`
   - 해석:
     - `from` inclusive, UTC day start.
     - `to` inclusive UI date이지만 SQL에서는 exclusive next UTC day.
     - 둘 다 없으면 기본 window는 최근 30일.

2. **Agent breakdown**
   - 응답에 상담원별 KPI 배열 추가.
   - 권장 이름: `agent_summaries`.
   - 각 row는 `agent_user_id`, `agent_name`, `team_id`, `team_name`, call counts, response rate, avg duration, latest call timestamp.
   - team scope에서는 해당 team 소속 active members의 call만.
   - org scope에서는 org 내 active members 기준. unassigned calls는 overall KPI에는 포함하되 agent breakdown에서는 `agent_user_id=null` bucket을 별도로 둘지 결정한다. 권장: `Unassigned` bucket을 포함해 전체 KPI와 breakdown total이 맞게 한다.

3. **Service/query refactor**
   - 기존 `aggregateMetrics` / `recentCalls`에 date window filter를 적용.
   - agent breakdown helper 추가.
   - SQL parameter building은 안전하게 작성한다. 문자열 interpolation으로 user query를 붙이지 않는다.

4. **Shared types**
   - `server/src/types/teamReport.ts`에 query/result 타입 확장.
   - `platform/types/teamReport.js` mirror 갱신.
   - `test/sync_shared_types.mjs` registry에 신규 타입이 필요하면 등록.
   - 권장 신규 타입:
     - `TeamReportQuery`
     - `TeamReportAgentSummary`

5. **Frontend**
   - `platform/api.js`의 `getTeamReportSummary(params)`가 `from`, `to`, `teamId`를 query로 보낸다.
   - `platform/reports.html`에 compact controls 추가:
     - preset segmented control: `7일`, `30일`, `90일`, `직접`
     - custom date inputs: `from`, `to`
     - reload/apply button
   - agent breakdown section 추가:
     - 상담원 table 또는 compact cards.
     - row click으로 최근 통화 table을 해당 agent로 좁혀 보여주는 client-side drilldown.
     - "전체"로 돌아가는 control.

6. **Audit payload**
   - `report.team_viewed` payload에 기간 filter를 추가한다.
   - 허용 키 후보: `scope`, `team_id`, `from`, `to`, `window_days`.
   - customer/agent/team names, recent call fields, call ids는 계속 금지.

7. **Docs**
   - 구현 후 `PHASE_7_STEP_7_FINDINGS.md` 작성.
   - `PHASE_7_MASTER.md` Step 7 상태 갱신.
   - README 현재 단계/로드맵 갱신.

### 안 한다

- 새 table/migration.
- billing/cost dashboard.
- CSV/PDF export.
- charts library 도입.
- per-agent detail route.
- calls page URL filter integration.
- role-based sidebar 변경. Step 6에서 닫힘.
- demo-to-real cleanup.

---

## 3. API Contract

### 3.1 Query

Endpoint:

```http
GET /reports/team-summary?team_id=<uuid optional>&from=2026-05-01&to=2026-05-18
```

Schema:

```ts
TeamReportQuery = {
  team_id?: string;
  from?: string; // YYYY-MM-DD
  to?: string;   // YYYY-MM-DD
}
```

Validation:

- `team_id`: existing permissive 8-4-4-4-12 hex regex.
- `from`, `to`: strict `YYYY-MM-DD`, parsed as UTC calendar dates.
- invalid date like `2026-02-31` must be rejected, not normalized by JS Date.
- `from > to` → 400 `invalid_input`.
- max window: 366 days. Larger range → 400 `invalid_input`.
- omitted both → default `from=todayUTC-29d`, `to=todayUTC` (30 calendar days inclusive).
- one-sided range:
  - 권장: reject one-sided input to keep UX/API clear.
  - Alternative: fill missing side to 30-day window. If implemented, document in findings.

### 3.2 Response

Extend `TeamReportSummary`:

```ts
{
  scope: "org" | "team",
  team_id: string | null,
  team_name: string | null,
  generated_at: Date,
  window: {
    from: string,       // YYYY-MM-DD
    to: string,         // YYYY-MM-DD
    from_inclusive: Date,
    to_exclusive: Date,
    days: number
  },
  total_calls: number,
  ended_calls: number,
  missed_calls: number,
  dropped_calls: number,
  active_calls: number,
  response_rate: number | null,
  avg_duration_seconds: number | null,
  recent_calls: TeamReportRecentCall[],
  agent_summaries: TeamReportAgentSummary[]
}
```

`TeamReportAgentSummary`:

```ts
{
  agent_user_id: string | null,
  agent_name: string | null,
  team_id: string | null,
  team_name: string | null,
  total_calls: number,
  ended_calls: number,
  missed_calls: number,
  dropped_calls: number,
  active_calls: number,
  response_rate: number | null,
  avg_duration_seconds: number | null,
  latest_call_at: Date | null
}
```

Unassigned bucket policy:

- org-wide report includes `agent_user_id=null` bucket if unassigned calls exist in the window.
- team-scoped report excludes unassigned calls, matching current manager scope contract.
- UI labels null agent as `미배정`.

### 3.3 Backward compatibility

- Existing callers without `from/to` still work and now receive 30-day default instead of all-time.
- This is an intentional behavior change. Document in findings/README.
- If all-time is needed later, add explicit preset `all` with a cap. Do not keep implicit all-time for operational reports.

---

## 4. Backend Plan

### 4.1 Route query parser

File: `server/src/routes/reports.ts`

Add `from` / `to` query fields near `TeamSummaryQuery`; put the actual date
parser in the service module so invalid date input can be classified into a
stable response `code`.

Requirements:

- Do not use loose `new Date("YYYY-MM-DD")` alone.
- Validate components round-trip:

```ts
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function parseUtcDateOnly(raw: string): Date {
  // split y/m/d, Date.UTC, verify UTC components equal input
}
```

`TeamSummaryQuery` should preprocess empty string to undefined for `from/to`,
same as `team_id`. It should not reject date strings by regex before the
service sees them; `resolveReportWindow` owns `invalid_date_format`,
`invalid_calendar_date`, `from_after_to`, `window_too_large`, and
`one_sided_window`.

Route passes normalized window to service:

```ts
const summary = await getTeamReportSummary(app, actor, {
  teamId: team_id ?? null,
  window: resolveReportWindow({ from, to }, new Date()),
});
```

Prefer putting `resolveReportWindow` in service module if route tests need direct reuse.

### 4.2 Service options

File: `server/src/services/teamReports.ts`

Add:

```ts
export interface TeamReportWindow {
  from: string;
  to: string;
  fromInclusive: Date;
  toExclusive: Date;
  days: number;
}

export interface TeamReportOptions {
  teamId?: string | null;
  window?: TeamReportWindow;
}
```

If route always resolves window, service can require it. To keep internal callers safe, service can default with `resolveDefaultReportWindow(now)`.

### 4.3 SQL date filter

Every metric query must include:

```sql
c.started_at >= $fromInclusive
AND c.started_at <  $toExclusive
```

Targets:

- `aggregateMetrics`
- `recentCalls`
- new `agentSummaries`

Use parameterized SQL only. Because current service has separate org/team branches, it is acceptable to keep separate SQL strings for readability.

### 4.4 Agent summaries query

Org scope:

```sql
SELECT
  c.agent_user_id,
  COALESCE(u.name, NULL) AS agent_name,
  am.team_id,
  t.name AS team_name,
  count(*)::int AS total_calls,
  ...
  max(c.started_at) AS latest_call_at
FROM calls c
LEFT JOIN users u ON u.id = c.agent_user_id
LEFT JOIN memberships am ON am.user_id = c.agent_user_id AND am.status='active'
LEFT JOIN teams t ON t.id = am.team_id
WHERE c.deleted_at IS NULL
  AND c.started_at >= $1
  AND c.started_at < $2
GROUP BY c.agent_user_id, u.name, am.team_id, t.name
ORDER BY total_calls DESC, latest_call_at DESC NULLS LAST, agent_name ASC NULLS LAST
```

Team scope adds:

```sql
AND c.agent_user_id IN (
  SELECT m.user_id FROM memberships m
  WHERE m.team_id = $teamId AND m.status='active'
)
```

Consider active-members-with-zero-calls:

- 권장 v1: only agents with at least one call in the window.
- 이유: response stays small and avoids needing a teams/members list contract.
- If UI needs "zero call" rows later, add separate members left join.

### 4.5 Audit payload

File: `server/src/services/activityLog.ts`

Extend `RecordReportTeamViewedInput`:

```ts
from: string;
to: string;
windowDays: number;
```

Payload:

```ts
{
  scope,
  team_id,
  from,
  to,
  window_days
}
```

Update `phase7_step3_report_audit_hooks.test.mjs`:

- payload keys now exactly `["from","scope","team_id","to","window_days"]`.
- Assert payload does not include agent/call/customer names, ids from result, or date objects.

Do not include:

- `team_name`
- `agent_name`
- `customer_name`
- `call_id`
- recent call rows
- raw query string

---

## 5. Shared Types Plan

Files:

- `server/src/types/teamReport.ts`
- `platform/types/teamReport.js`
- `test/sync_shared_types.mjs`

Add zod schemas:

```ts
export const TeamReportQuery = z.object({
  team_id: UuidString.optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export const TeamReportWindow = z.object({
  from: z.string(),
  to: z.string(),
  from_inclusive: z.date(),
  to_exclusive: z.date(),
  days: z.number().int().positive(),
});

export const TeamReportAgentSummary = z.object({ ... });
```

Update `TeamReportSummary` with `window` and `agent_summaries`.

Browser JSDoc mirror:

- Date fields serialized to string in browser typedefs.
- Add comments for default 30-day window.

Sync registry:

- Add `TeamReportQuery`, `TeamReportWindow`, `TeamReportAgentSummary` if the sync script requires explicit names.

---

## 6. Frontend Plan

Files:

- `platform/api.js`
- `platform/reports.html`

### 6.1 API helper

Update `getTeamReportSummary(params)`:

```js
if (p.teamId) qs.set('team_id', String(p.teamId));
if (p.from) qs.set('from', String(p.from));
if (p.to) qs.set('to', String(p.to));
```

No raw interpolation into URL; continue using `URLSearchParams`.

### 6.2 Reports UI controls

Add compact filter band under header or inside main before status banner:

- Preset segmented buttons:
  - `7일`
  - `30일` default
  - `90일`
  - `직접`
- Custom date inputs visible/enabled for direct custom mode.
- Apply/reload button.

Implementation notes:

- Use native `<input type="date">`.
- Store state in JS:

```js
let reportFilters = {
  preset: "30d",
  from: "",
  to: "",
  selectedAgentId: null,
};
```

- Default dates computed in browser local date? Backend interprets YYYY-MM-DD as UTC. To avoid timezone confusion, use UTC date formatting for presets.

### 6.3 Agent drilldown UI

Add section between KPI/status cards and recent calls:

- Header: `상담원별 성과`
- Table columns:
  - 상담원
  - 팀
  - 전체
  - 완료
  - 응답률
  - 평균 통화
  - 최근 통화
- Row click:
  - sets `selectedAgentId`
  - visually marks row active
  - filters `recent_calls` client-side to that agent.
- `전체 보기` small button clears selection.

Important:

- Drilldown in this step is response-local/client-side, not a new API route.
- `recent_calls` remains capped by service (currently 10). If row click filters to fewer calls than expected, UI label should say "최근 통화 중 선택 상담원만 표시".
- Later Step can add `agent_id` query if deeper pagination is needed.

### 6.4 Rendering and XSS

- `agent_name`, `team_name`, `customer_name`, `title` are server-returned fields.
- Prefer DOM APIs/textContent for new agent table.
- If using `innerHTML`, every server field must pass through `escapeHtml`.
- Do not add visible instructional prose explaining how to use controls. Labels are enough.

### 6.5 Role behavior

- employee/viewer direct access remains 403 banner.
- Step 6 sidebar already hides reports for employee/viewer.
- Step 7 should avoid making an extra `/reports/team-summary` call for employee/viewer if role is known from `/me` before fetch. This is optional; if implemented, be careful not to create duplicate `/me` auth logic. Existing 403 banner is acceptable.

---

## 7. Tests

### 7.1 Backend route/service tests

File: `server/test/phase6_team_reports.test.mjs`

Add cases:

1. default no date query returns window of 30 days and excludes calls older than 30 days.
2. `from/to` inclusive UI dates map to `started_at >= from` and `< to+1d`.
3. invalid date format → 400.
4. invalid calendar date → 400.
5. `from > to` → 400.
6. range > 366 days → 400.
7. admin org-wide `agent_summaries` includes team A, team B, and unassigned bucket when present.
8. manager team scope `agent_summaries` excludes other team and unassigned calls.
9. recent_calls respects date filter.
10. response_rate and avg_duration are computed within window only.

### 7.2 Audit tests

File: `server/test/phase7_step3_report_audit_hooks.test.mjs`

Update:

- existing payload exact keys.
- add custom date query and assert payload has `from`, `to`, `window_days`.
- payload hygiene remains: no names/titles/sentiment/recent call fields.

### 7.3 Shared types

```powershell
node test/sync_shared_types.mjs
```

### 7.4 Frontend smoke

Use Playwright/MCP after starting backend + static server:

1. admin opens `reports.html`.
2. default 30-day window controls render without overlap desktop/mobile.
3. preset click updates query/result.
4. custom invalid range is blocked client-side or server returns clean banner.
5. agent row click filters recent table and active row styling appears.
6. employee direct `reports.html` still shows 403 banner.

Screenshots are transient. Do not commit screenshots unless explicitly requested.

---

## 8. Validation Commands

Required:

```powershell
npm --prefix server run typecheck
node test/sync_shared_types.mjs
npx tsx --test --test-concurrency=1 test/phase6_team_reports.test.mjs
npx tsx --test --test-concurrency=1 test/phase7_step3_report_audit_hooks.test.mjs
npm --prefix server test
git diff --check
```

Frontend smoke:

```powershell
docker compose -f ops/docker-compose.yml up -d
npm --prefix server run dev
python -m http.server 8765
```

Then Playwright/MCP checks from §7.4.

---

## 9. Acceptance Criteria

- [ ] `GET /reports/team-summary` accepts valid `from/to` date-only query.
- [ ] omitted `from/to` defaults to a documented 30-day window.
- [ ] invalid date, one-sided date, reversed date, and too-large date range return 400.
- [ ] all top-level metrics and recent_calls respect the date window.
- [ ] response includes `window` metadata.
- [ ] response includes `agent_summaries`.
- [ ] admin org-wide report includes unassigned bucket when unassigned calls exist.
- [ ] manager report only includes own-team calls and own-team agent summaries.
- [ ] employee/viewer remain 403.
- [ ] audit payload includes only safe filter metadata: `scope`, `team_id`, `from`, `to`, `window_days`.
- [ ] shared zod/JSDoc types are synchronized.
- [ ] reports frontend renders date controls and agent drilldown without layout overlap on desktop/mobile.
- [ ] no new XSS gate for server-returned report fields.
- [ ] full server tests pass.

---

## 10. Risks

### 10.1 Timezone semantics

UI date-only values are easy to misread. This step uses UTC calendar days for backend filtering and response metadata. Frontend should format preset dates as UTC `YYYY-MM-DD` to match.

### 10.2 All-time behavior change

Existing endpoint implicitly returned all-time. Step 7 changes omitted dates to 30-day default. This is intentional for operational UX but must be documented in findings.

### 10.3 Breakdown totals vs recent_calls cap

`agent_summaries` aggregates the full window, while `recent_calls` is capped. Client-side drilldown filters only the capped recent list, not all calls for that agent. UI copy should avoid implying full paginated drilldown.

### 10.4 Audit payload expansion

Adding date fields to `report.team_viewed` is safe, but tests must keep payload exact so future fields do not accidentally leak report result data.

---

## 11. Handoff To Implementation Agent

Implementation order:

1. Extend shared zod types and browser mirror.
2. Add date window parser/resolver and service options.
3. Apply window filter to metrics/recent SQL.
4. Add agent summaries SQL + response mapping.
5. Extend audit helper payload and audit tests.
6. Extend route query schema.
7. Update `platform/api.js`.
8. Update `platform/reports.html` controls + agent drilldown.
9. Run targeted backend tests + sync_shared_types + typecheck.
10. Run browser smoke desktop/mobile.
11. Write `PHASE_7_STEP_7_FINDINGS.md`, update master + README.

Commit unit recommendation:

1. backend query/types/service/tests.
2. frontend reports UI/API helper.
3. docs closeout.

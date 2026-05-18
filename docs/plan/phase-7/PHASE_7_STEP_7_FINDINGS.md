# Phase 7 Step 7 Findings — reports date window + agent drilldown

작성일: 2026-05-18

상위 문서: `PHASE_7_MASTER.md` · 상세 계획: `PHASE_7_STEP_7_PLAN.md`.

---

## 1. 산출물

| 영역 | 위치 |
|---|---|
| Shared types | `server/src/types/teamReport.ts`, `platform/types/teamReport.js`, `test/sync_shared_types.mjs` — `TeamReportSummary`에 `window` / `agent_summaries` 추가, 신규 `TeamReportQuery` / `TeamReportWindow` / `TeamReportAgentSummary` 등록. |
| Date 윈도우 resolver | `server/src/services/teamReports.ts` — `parseUtcDateOnly` (component round-trip 검증), `resolveReportWindow({from, to}, now)`, `DEFAULT_REPORT_WINDOW_DAYS = 30`, `MAX_REPORT_WINDOW_DAYS = 366`. `ReportWindowError` + 코드 5종(`invalid_date_format`, `invalid_calendar_date`, `from_after_to`, `window_too_large`, `one_sided_window`). |
| SQL filter | 같은 파일 — `aggregateMetrics`, `recentCalls`, `agentSummaries` 모두 `started_at >= $fromInclusive AND started_at < $toExclusive`. 파라미터화 100%, user 입력 문자열 SQL에 직접 붙이지 않음. |
| Agent breakdown | 같은 파일 — org scope는 `agent_user_id IS NULL` unassigned 버킷 포함, team scope는 `JOIN memberships ... team_id = $3` (active members only)로 다른 팀/미배정 자동 제외. 윈도우 내 통화 ≥ 1건 있는 agent만 row. |
| Audit payload 확장 | `server/src/services/activityLog.ts` — `RecordReportTeamViewedInput`에 `from`, `to`, `windowDays` 추가, payload 정확 키셋이 `['scope','team_id','from','to','window_days']`. |
| Route 확장 | `server/src/routes/reports.ts` — `TeamSummaryQuery`에 `from`, `to` (preprocess empty→undef, 날짜 문자열은 `resolveReportWindow`로 전달해 형식/달력/범위 오류를 모두 `ReportWindowError → 400 invalid_input + code`로 통일). |
| Frontend API helper | `platform/api.js` — `getTeamReportSummary({teamId, from, to})`에 `from`/`to`를 `URLSearchParams.set`으로 합류. 문자열 보간 없음. |
| Frontend UI | `platform/reports.html` 전체 재작성 — 7/30/90/직접 preset segmented control + `<input type="date">` 2개 + 적용 버튼 / agent breakdown 테이블 (상담원/팀/전체/완료/응답률/평균/최근) + row-click drilldown으로 recent_calls 클라이언트 사이드 필터링 + `clearAgentBtn` (전체 보기) + 400 응답 코드별 한국어 banner. 새 `.innerHTML` interpolation은 100% `escapeHtml` 통과. |
| Fixture 확장 | `server/test/_phase5Fixture.mjs` — `insertCallRaw`가 `duration_seconds`, `ended_at` 필드 thread (이전엔 silently drop). 기존 14개 테스트는 영향 없음 (duration 값 단언 없음); Step 7 신규 테스트의 `avg_duration_seconds` 단언이 가능해짐. |
| Audit hook 테스트 갱신 | `server/test/phase7_step3_report_audit_hooks.test.mjs` — 기본 30일 윈도우 payload 검증 + custom from/to 윈도우 payload echo 검증 신규 1건. payload 정확 키셋 단언이 `['scope','team_id']` → `['from','scope','team_id','to','window_days']`로 갱신. |
| Team report 테스트 확장 | `server/test/phase6_team_reports.test.mjs` — Step 7 신규 케이스 10건 (cases 15-24). 기존 14건 + 신규 10건 = 24/24 PASS. |
| Docs | 이 파일 + `PHASE_7_MASTER.md` Step 5+ bundle 3번 완료 표시 + `README.md` 현재 단계·v1 roadmap 갱신. |

---

## 2. API 계약 (확정)

### 2.1 Request

```http
GET /reports/team-summary
  ?team_id=<uuid optional>
  &from=YYYY-MM-DD
  &to=YYYY-MM-DD
```

- `team_id`: 기존 그대로 (admin 옵션, manager 자기 팀, employee/viewer 403).
- `from`/`to`: 둘 다 옵션. 단 **한쪽만 보내면 400** (`one_sided_window`).
- 둘 다 미입력 시 서버가 최근 30일 (UTC, 오늘 포함)로 resolve.

### 2.2 400 응답 코드

| HTTP body `error` | `code` 필드 | 트리거 |
|---|---|---|
| `invalid_input` | `invalid_date_format` | `YYYY-MM-DD` 형식이 아님 (예: `2026/05/01`, `05-01-2026`). |
| `invalid_input` | `invalid_calendar_date` | 정규식은 통과하지만 실제 달력에 없는 날 (`2026-02-31`). |
| `invalid_input` | `from_after_to` | `from`이 `to`보다 늦음. |
| `invalid_input` | `window_too_large` | inclusive 일수 > 366. |
| `invalid_input` | `one_sided_window` | `from`이나 `to` 한쪽만 입력. |

frontend는 코드별로 한국어 banner를 매핑한다.

### 2.3 Response

```ts
TeamReportSummary {
  scope: "org" | "team",
  team_id: string | null,
  team_name: string | null,
  generated_at: Date,
  window: TeamReportWindow,
  total_calls, ended_calls, missed_calls, dropped_calls, active_calls: number,
  response_rate: number | null,
  avg_duration_seconds: number | null,
  recent_calls: TeamReportRecentCall[],   // 윈도우 내, 최대 10건
  agent_summaries: TeamReportAgentSummary[],
}

TeamReportWindow {
  from: string,           // "YYYY-MM-DD" (UTC, inclusive)
  to: string,             // "YYYY-MM-DD" (UTC, UI 기준 inclusive)
  from_inclusive: Date,   // SQL 기준 inclusive lower bound
  to_exclusive: Date,     // SQL 기준 exclusive upper bound (UI `to` + 1d)
  days: number,           // inclusive 일수 (to − from + 1)
}

TeamReportAgentSummary {
  agent_user_id: string | null,   // null = unassigned bucket (org scope only)
  agent_name: string | null,
  team_id: string | null,
  team_name: string | null,
  total_calls, ended_calls, missed_calls, dropped_calls, active_calls: number,
  response_rate: number | null,
  avg_duration_seconds: number | null,
  latest_call_at: Date | null,
}
```

### 2.4 Backward compatibility 변경 사항

기존에는 `from/to` 없으면 **전체 기간** 누적이 반환됐다. Step 7부터는 **최근 30일**로 좁혀진다. 운영 UX 결정으로 의도된 변경이며 README/roadmap에도 별도 표기.

`recent_calls` 캡 10건은 그대로. `agent_summaries`는 cap 없음 (윈도우 내 통화 1건 이상인 모든 agent).

---

## 3. SQL 필터 디자인

### 3.1 boundary 규칙

UI date는 inclusive, SQL은 `[fromInclusive, toExclusive)` 반열린 구간. 변환:

```
from_inclusive = parse(from, UTC midnight)
to_exclusive   = parse(to,   UTC midnight) + 1 day
```

테스트 16번이 이 boundary를 검증: `to = 2026-05-07` 일 때 `started_at = 2026-05-07 23:59:00`은 포함, `started_at = 2026-05-08 00:00:00`은 제외, `started_at = 2026-04-30 23:00:00`도 제외.

### 3.2 Agent summary 두 가지 형태

**Org scope** — `LEFT JOIN memberships am`. NULL agent도 row 생성:

```sql
SELECT c.agent_user_id, u.name AS agent_name, am.team_id, t.name AS team_name, ...
  FROM calls c
  LEFT JOIN users       u  ON u.id  = c.agent_user_id
  LEFT JOIN memberships am ON am.user_id = c.agent_user_id AND am.status = 'active'
  LEFT JOIN teams       t  ON t.id  = am.team_id
 WHERE c.deleted_at IS NULL
   AND c.started_at >= $1
   AND c.started_at <  $2
 GROUP BY c.agent_user_id, u.name, am.team_id, t.name
 ORDER BY total_calls DESC, latest_call_at DESC NULLS LAST, agent_name ASC NULLS LAST
```

**Team scope** — `JOIN memberships ... team_id = $3`. NULL agent 자동 제외 (NULL은 JOIN의 ON 조건과 매칭 안 됨):

```sql
 FROM calls c
 JOIN  memberships am ON am.user_id = c.agent_user_id
                      AND am.status = 'active'
                      AND am.team_id = $3
 LEFT JOIN users u ON u.id = c.agent_user_id
 LEFT JOIN teams t ON t.id = am.team_id
WHERE ...
```

테스트 22번이 org-wide의 unassigned bucket 존재를, 23번이 team scope의 unassigned/other-team 제외를 검증.

### 3.3 SQL injection

모든 user-controlled 값은 parameterized ($1, $2, $3). `from`/`to`는 service resolver의 형식 검증 + calendar round-trip 통과 후 `Date` 객체로 보내므로 string interpolation 가능성 0.

---

## 4. Audit payload 정책

`report.team_viewed` payload 정확 키셋은 이제:

```
{ scope, team_id, from, to, window_days }
```

테스트 `payload omits customer/agent/team names + call title + sentiment + ids`는 단언을 다음으로 갱신:

```js
assert.deepEqual(
  Object.keys(rows[0].payload).sort(),
  ["from", "scope", "team_id", "to", "window_days"],
);
```

신규 4번째 테스트가 `?from=2026-05-01&to=2026-05-07` payload를 단언:

- `payload.from === "2026-05-01"`
- `payload.to === "2026-05-07"`
- `payload.window_days === 7` (inclusive count)

result data (`team_name`, `agent_name`, `customer_name`, `call.title`, `recent_calls`, `agent_summaries` rows)는 **여전히 payload에 들어가지 않는다**. 감사 row는 "어떤 뷰가 / 어떤 기간으로 / 누가 / 언제 열렸는지"만 기록하고 안에 무엇이 보였는지는 동일 query 재실행으로만 재현 가능.

---

## 5. Frontend UX

### 5.1 Preset segmented control

`7일 / 30일 / 90일 / 직접` 4개. 30일이 default `active`. Preset 클릭 시:

1. `setActivePreset(preset)` — visual state.
2. `applyPresetWindow(preset)` — `today − (N−1)d ~ today` UTC 계산.
3. `loadReport()` — 새 윈도우로 즉시 fetch.

`직접` preset은 fetch를 트리거하지 않고 date input 두 개 + 적용 버튼만 노출. 사용자가 명시적으로 `적용`을 누르면 fetch.

### 5.2 Window 표시

응답이 오면 `windowLabel`에 `from ~ to (N일)`을 표시. **서버 응답의 `window` 필드를 그대로 사용** — 클라이언트가 계산한 dates보다 서버가 정규화한 값이 우선이라 audit row와 정확히 일치.

### 5.3 Agent drilldown (client-side only)

- agent table row 클릭 → `state.selectedAgentId = agent.agent_user_id` (string 또는 null).
- 같은 row 재클릭 → `selectedAgentId = undefined` (선택 해제).
- `clearAgentBtn` "전체 보기" → 동일 효과.
- `renderRecentTable`이 `selectedAgentId` 기준으로 `recent_calls` 클라이언트 사이드 필터링. 새 server fetch 없음.
- 필터 active 시 recent 헤더에 `선택 상담원: <이름>` 라벨 (textContent).
- `recent_calls`는 서버에서 10건 cap. drilldown 후 비면 "최근 통화 10건 중 선택 상담원의 통화가 없습니다." 안내.

이 캡 한계는 plan §10.3에서 미리 합의한 trade-off. 깊은 drilldown은 후속 step (별도 `?agent_id` query 또는 calls.html 필터 통합).

### 5.4 XSS

새로운 `.innerHTML` interpolation 4개 영역 (agent row, recent row, empty state placeholder, filter label) — 모두 `escapeHtml` 적용 또는 textContent. `agent_user_id`까지 escapeHtml 통과시킴 (uuid 정규식으로 이미 안전하지만 defense-in-depth).

---

## 6. 검증

### 6.1 정적

```powershell
git diff --check                                                          # PASS
npm --prefix server run typecheck                                          # PASS
node test/sync_shared_types.mjs                                            # PASS
```

### 6.2 단위/통합 테스트

```powershell
npx tsx --test --test-concurrency=1 test/phase7_step3_report_audit_hooks.test.mjs   # 9/9 PASS
npx tsx --test --test-concurrency=1 test/phase6_team_reports.test.mjs               # 24/24 PASS
npm --prefix server test                                                            # 738 total / 735 pass / 3 skipped / 0 fail
```

Step 7 신규 테스트 12건 (audit 1건 + team report 10건 + audit-defaults 갱신 1건의 새 단언) 모두 PASS.

### 6.3 알려진 flaky

`phase7_email_outbox_repo.test.mjs scrubSensitivePayload is idempotent` 1건이 첫 full run에서 실패 후 재실행에서 자동 PASS. Step 4/5 findings에 기록된 due-lease flaky와 동일 패턴 — Step 7 코드와 직접 연결 없음. 두 번째 full run에서 738/735/3/0으로 완전 PASS.

### 6.4 Browser smoke (Playwright MCP)

서버: `npm --prefix server run dev` (port 3001), static: `python -m http.server 8765`.

1. **admin login → reports.html (기본 30일)**: window label `2026-04-19 ~ 2026-05-18 (30일)`, preset 30 active, agent section + recent section 모두 visible. KPI/breakdown 모두 정상.
2. **preset 7일 클릭** → `2026-05-12 ~ 2026-05-18 (7일)` 갱신, 자동 fetch.
3. **preset 90일 클릭** → `2026-02-18 ~ 2026-05-18 (90일)` 갱신.
4. **직접 preset 클릭** → custom date inputs (`customFrom`, `customTo`) 노출, 현재 윈도우 값 pre-populate, fetch 트리거 안 함.
5. **invalid custom (`from > to`)** → 적용 시 backend 400 `from_after_to`, banner "시작일이 종료일보다 늦을 수 없습니다." 표시.
6. **invalid calendar `2026-02-31`** → `<input type="date">`가 client-side에서 invalid 값을 비워서 `one_sided_window`로 분기 → banner "시작일과 종료일을 모두 입력해주세요." (브라우저 native date input 동작. server는 calendar 검증을 별도로 가지고 있어 programmatic caller에는 `invalid_calendar_date` 코드로 응답.)
7. **valid custom `2026-05-01 ~ 2026-05-18`** 적용 → window label `2026-05-01 ~ 2026-05-18 (18일)` 갱신, 헤더 visible.
8. **agent row 클릭** → `.active` 추가, recent header에 `선택 상담원: 에이스 어드민` 라벨, `전체 보기` 버튼 표시.
9. **같은 row 재클릭** → 선택 해제, 라벨 사라짐.
10. **employee `emp@acme.test`로 reports.html 직접 진입** → 403 banner "이 페이지는 관리자와 매니저만 볼 수 있습니다." 유지. filter bar 숨김. sidebar `팀 보고서` nav도 Step 6 정책대로 숨김.
11. **모바일 viewport 375×812**: filter bar 85px 높이로 wrap, agent section 187px, main column 375px 정확히 fit, `documentElement.scrollWidth === clientWidth` — 가로 overflow 없음.

manager scope의 end-to-end smoke는 dev seed에 manager 계정이 없어 backend test #22-23 (agent_summaries org-wide unassigned 포함 / team scope unassigned·other-team 제외)로 단언을 마침.

---

## 7. 안 한 것

Plan §2 "안 한다" 그대로:

- 새 table / schema migration.
- billing / cost dashboard.
- CSV / PDF export.
- charts library 도입.
- per-agent detail route 또는 `/calls?agent=...` 통합.
- calls page URL filter integration.
- demo-to-real cleanup.
- role-based sidebar 변경 (Step 6에서 닫힘).

전체 기간 (`all`) preset도 의도적으로 만들지 않음. 운영 보고서는 윈도우가 명시되는 게 정상이라는 plan §3.3 결정.

---

## 8. Phase 7 Master 상태 갱신

`PHASE_7_MASTER.md §0`에서 Step 5+ bundle 3번째 항목 (reports date window + agent drilldown)이 완료됨. 남은 P1 follow-up:

4. demo-to-real frontend cleanup (dashboard / daily / newsletter 위젯).
5. billing / subscription caps.

---

## 9. 다음 작업 인계

Plan `PHASE_7_MASTER.md §3 Step 5+ bundle` 잔여:

1. demo-to-real frontend cleanup — newsletter / daily / dashboard 위젯의 demo 라벨 정리.
2. billing / subscription caps — Step 5 cost map과 결합해 plan limit enforcement.

billing은 Step 5의 `llm_usage_log.cost_usd_micros`와 Step 7의 `window_days` payload를 둘 다 input으로 받을 수 있다 (월별 비용 집계 + 윈도우 길이 cap). 이번 step 산출물은 그대로 활용 가능.

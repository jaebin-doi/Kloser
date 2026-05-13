# Phase 6 Step 4 Findings — Manager Team Reports

> 완료일: 2026-05-13
> 범위: `GET /reports/team-summary` 신규 endpoint + frontend `platform/reports.html` 신설.
> 기준 계획: `docs/plan/phase-6/PHASE_6_STEP_4_PLAN.md`.
> 선행 단계: Phase 6 Step 3 closeout (`4ae94e7 Add Phase 6 action item delete`).
> 현재 브랜치: `feature/phase-3-team-invitations`.
> Schema 변경: 없음.

---

## 1. 현재 상태

Step 4 완료. `PHASE_6_MASTER.md` §0 Implementation Log Step 4 체크박스 → `[x]`, §11 go/no-go "Manager team-scope read 보고서 + 권한 매트릭스 검증" 항목 → `[x]`, sync_shared_types entity count 문구를 실제 결과(15)에 맞춰 정정.

Phase 6 남은 단위: **Step 5 — 통합 e2e + 종합 closeout**. README / `docs/USER_GUIDE_PHASE_6.md` 갱신은 Step 5에서.

---

## 2. 변경 파일

신규 8개, 수정 5개.

### 신규
- `docs/plan/phase-6/PHASE_6_STEP_4_PLAN.md` — Codex 작성 Step 4 기준 계획.
- `server/src/types/teamReport.ts` — `TeamReportSummary` + `TeamReportRecentCall` zod schemas (top-level `z.object({…})` 규약 준수).
- `platform/types/teamReport.js` — JSDoc mirror.
- `server/src/services/teamReports.ts` — `getTeamReportSummary(app, actor, opts)` + `TeamReportNotFoundError`.
- `server/src/routes/reports.ts` — `GET /reports/team-summary?team_id=<uuid>` + 로컬 에러 핸들러 (`PermissionError → 403`, `TeamReportNotFoundError → 404`).
- `server/test/phase6_team_reports.test.mjs` — 14 케이스.
- `platform/reports.html` — Dense SaaS dashboard 스타일, 사이드바 등록.
- `docs/plan/phase-6/PHASE_6_STEP_4_FINDINGS.md` — 본 문서.

### 수정
- `server/src/server.ts` — `reportsRoutes` import + `app.register(reportsRoutes)` (dashboard route 뒤).
- `test/sync_shared_types.mjs` — `teamReport` entity 등록. count 14 → 15.
- `platform/api.js` — `getTeamReportSummary(params)` helper + `window.kloserApi` 노출.
- `platform/_shared.js` — 사이드바 "조직" 섹션에 `reports.html` nav item 추가 (data-page=`reports`).
- `docs/plan/phase-6/PHASE_6_MASTER.md` — Step 4 implementation log + go/no-go 항목 + sync count 갱신.

마이그레이션 0개. `.env*` 무수정. `package*.json` 무수정. 다른 frontend 페이지 무수정.

---

## 3. Endpoint / response shape

```
GET /reports/team-summary?team_id=<uuid optional>
```

요청:
- query: `team_id?` — UUID. 빈 문자열은 `undefined`로 정규화 (preprocess).
- body: 없음.
- headers: `Authorization: Bearer <access_token>`.

응답:
- **200** — `TeamReportSummary`:
  ```ts
  {
    scope: "org" | "team",
    team_id: string | null,
    team_name: string | null,
    generated_at: Date,
    total_calls: number,
    ended_calls: number,
    missed_calls: number,
    dropped_calls: number,
    active_calls: number,
    response_rate: number | null,   // ended / (ended + missed); null when denom = 0
    avg_duration_seconds: number | null,
    recent_calls: TeamReportRecentCall[],  // up to 10, started_at DESC
  }
  ```
- **400 invalid_input** — `team_id` UUID 형식 위반.
- **401 / 403** — middleware (`requireAuth` / `orgContext` / `requireVerified` / `requireRole` / `requireFreshRole`) 거부.
- **403 forbidden** — `PermissionError`: manager가 자기 팀이 아닌 same-org team을 요청 / manager가 팀 미배정 / employee · viewer가 서비스 호출에 다다른 경우.
- **404 not_found** — `TeamReportNotFoundError`: 요청한 `team_id`가 현재 org에서 보이지 않음 (cross-org 또는 미존재).
- **500 rls_violation** — PG `42501` (방어, 정상 경로에서 도달 불가).

`TeamReportRecentCall`은 `dashboard.recent_calls` 형태에 `team_id` + `team_name`을 추가한 shape. agent의 활성 멤버십을 LEFT JOIN해서 표시.

---

## 4. 권한 매트릭스 결과 (테스트로 검증)

| Actor | `team_id` 미지정 | 자기 team_id | 다른 same-org team_id | cross-org team_id | 팀 미배정 |
|---|---|---|---|---|---|
| **admin** | 200 org-wide (`scope='org'`) | 200 team summary | 200 team summary | **404 not_found** | n/a |
| **manager** | 200 own team summary | 200 (동일 결과) | **403 forbidden** | **404 not_found** | **403 forbidden** |
| **employee** | 403 (requireRole) | 403 | 403 | 403 / 404 | n/a |
| **viewer** | 403 (requireRole) | 403 | 403 | 403 / 404 | n/a |

`requireRole("admin", "manager")`이 employee/viewer를 route layer에서 차단. 서비스도 employee/viewer 진입을 PermissionError로 거부 (defense in depth).

manager가 cross-org `team_id`를 보낸 경우, 서비스가 먼저 own team과 일치하지 않는지 검사 → 다음 같은 org 내 가시성 검사 (`teamNameOrNull` 조회). RLS가 cross-org row를 가려 `null` → `TeamReportNotFoundError` → 404. 같은 org에서 보이지만 자기 팀이 아니면 `PermissionError` → 403. 이 분기 순서는 plan §3 "Notes"와 일치.

테스트 14건 모두 통과 (§7).

---

## 5. API / demo boundary

| 필드 | source |
|---|---|
| 상단 scope 배지 (`org` / `team`) | **API** (`summary.scope`) |
| 헤더 카드 제목 / 설명 / generated_at | **API** (`summary.team_name`, `summary.generated_at`) |
| 5개 KPI 카드 (total / ended / response_rate / avg / active) | **API** |
| status breakdown 4 카드 (ended / missed / dropped / active) | **API** |
| 최근 통화 표 (고객 / 담당 / 팀 / 상태 / duration / 시각) | **API** |
| 사이드바 user 블록, org 블록 | **API** (`/me`) |

본 페이지에는 demo 데이터가 0건. 기존 `dashboard.html`의 demo 위젯(시장 트렌드 / 추천 To-Do / 팀 활동) 같은 보조 카드는 의도적으로 추가하지 않았다. 사용자가 보고서 화면에서 시각/숫자가 항상 실제 데이터임을 신뢰할 수 있도록.

사이드바에는 admin/manager/employee/viewer 모두에게 동일하게 nav가 노출된다. 권한이 없는 사용자는 페이지 로드 시 403 응답을 받아 banner가 안내한다 — 별도 role-기반 nav 가시성 토글은 본 단위 범위 밖 (Phase 7+ ops UX).

---

## 6. XSS gate classification (AGENTS.md)

`platform/reports.html`의 interpolation 분류:

| 위치 | source | classification | 처리 |
|---|---|---|---|
| 상단 scope 배지 텍스트 | server enum (`org`/`team`) → 라벨 매핑 | server-returned (간접) | `scopeBadge.textContent` |
| `<span id="scopeTitle">` 텍스트 | server (`team_name`) + 상수 | server-returned | `titleEl.textContent` |
| `<span id="scopeDesc">` 텍스트 | 상수 | constant | `descEl.textContent` |
| `generatedAtLabel` 텍스트 | server (`generated_at`) → 포맷 | server-returned | `textContent` |
| KPI / breakdown 카드 숫자 (`kpiTotal` 등) | server number | server-returned | `textContent` (`String(...)` 변환) |
| 최근 통화 표 행 (innerHTML 구성) | server (`customer_name`, `agent_name`, `team_name`, `title`, `status`, `duration_seconds`, `started_at`) | server-returned | **모두 `escapeHtml(...)` 통과** |
| status banner 메시지 | 상수 | constant | `el.textContent` |
| 사이드바 (`_shared.js`) | server (`/me`) | server-returned | `_shared.js`의 `applySidebarProfile`이 이미 `textContent` 처리. 본 단위에서 추가한 nav item은 `<a href="reports.html"...>팀 보고서</a>` 상수 chunk라 새 interpolation 0건. |

innerHTML 사용 위치는 최근 통화 표 한 곳 — 모든 API 필드가 `escapeHtml`을 거친다. `formatDuration` / `formatHHMM` 출력은 server number/Date에서 파생되지만 추가로 `escapeHtml`을 거쳐 방어. XSS gate 위반 0건.

---

## 7. 추가/수정 테스트

`server/test/phase6_team_reports.test.mjs` (신규, 14 케이스):

| # | 케이스 | expected |
|---|---|---|
| 1 | admin no team_id | 200 org-wide, unassigned 통화 포함 |
| 2 | admin same-org team_id | 200 team summary, 다른 팀 통화 제외 |
| 3 | admin cross-org team_id | 404 not_found |
| 4 | manager no team_id | 200 own team |
| 5 | manager own team_id | 200 (4번과 동일 결과) |
| 6 | manager other same-org team_id | 403 forbidden |
| 7 | manager cross-org team_id | 404 not_found |
| 8 | manager without team | 403 forbidden |
| 9 | employee | 403 (requireRole) |
| 10 | viewer | 403 (requireRole) |
| 11 | invalid UUID team_id | 400 invalid_input |
| 12 | soft-deleted call excluded | recent + metrics 둘 다 |
| 13 | unassigned call excluded from manager scope | recent 비포함 |
| 14 | response_rate null when denom = 0 | beta org에 in_progress / dropped만 → null |

전 14건 PASS. 기존 `npm test` 회귀(370 → 384 total, 모두 PASS / 3 skip)도 깨지지 않음. skipped 3개는 Step 2 real-provider opt-in 그대로.

---

## 8. 검증 명령 결과

```powershell
git status --short --branch
```
- `## feature/phase-3-team-invitations...origin/feature/phase-3-team-invitations` (signed code changes only).

```powershell
npm --prefix server run typecheck
```
PASS.

```powershell
npm --prefix server test
```
PASS. **384 total / 381 pass / 3 skipped / 0 fail**. 이전 baseline 370 + 신규 14 = 384.

```powershell
node test/sync_shared_types.mjs
```
PASS. **15 entity** (14 + `teamReport`). master plan의 "Step 4 후 16 entity" 표현은 실제 결과 15에 맞춰 정정 — 가짜 entity를 만들어 16을 맞추지 않았다.

Static frontend syntax check (`node -e "new Function(...)"`):
- `platform/reports.html` inline scripts (2개) → OK.
- `platform/api.js` → OK.
- `platform/_shared.js` → OK.

Live browser smoke는 본 단위에서 자동 수행하지 않았다 (API:32173 + Static:8765 + DB 컨테이너 필요). Step 5 통합 e2e가 브라우저 경로를 일괄 검증 예정.

---

## 9. 중요 구현 결정

### 9.1 manager `team_id` 검증 순서

manager가 `team_id` 쿼리를 보냈을 때:

1. own team 비교 → 일치하면 그대로 진행.
2. 불일치 시 `teamNameOrNull(client, teamId)` 조회.
3. RLS가 가린 row(null) → `TeamReportNotFoundError` → 404.
4. 같은 org에서 보이는 row → `PermissionError` → 403.

이 순서가 가장 안전한 leak 모델 — cross-org team_id의 존재를 노출하지 않으면서 same-org 권한 위반은 명확하게 403으로 알린다. `PHASE_6_STEP_4_PLAN.md §3` Note와 일치.

### 9.2 admin org-wide vs team scope

admin이 `team_id`를 지정하지 않으면 `scope='org'`, 전체 통화 (unassigned 포함) 집계. `team_id`를 명시하면 `scope='team'`, 해당 팀에 소속된 agent의 통화만. plan §4 "Call inclusion" 룰에 따라 admin org-wide만 unassigned를 포함하며 team scope에서는 제외.

### 9.3 메트릭 시간 윈도우

본 단위는 **all-time** 메트릭. 일간/주간 필터는 Phase 7+로 미룬다 (plan §4 "Time window" 결정). `generated_at`은 응답에 포함되어 프런트가 "보고서 생성: …" 라벨을 보여줄 수 있다.

### 9.4 manager → 자기 본인이 agent인 통화

manager가 자기 통화도 자기 팀 안에 있을 때 — `agent_user_id`가 manager 본인이고 `memberships.team_id`가 manager 본인의 team을 가리키면 집계에 포함된다. SQL은 단순히 "이 team에 소속된 agent의 통화"를 모은다.

### 9.5 frontend role-기반 가시성

본 단위는 사이드바 nav 항목을 모든 사용자에게 노출한다. role에 따른 동적 nav 가시성은 Phase 7+ ops UX 단위로 미루고, 403 응답을 페이지가 명확히 안내하는 패턴(banner)을 우선 적용. employee / viewer가 페이지를 열어도 명료한 에러 메시지로 안내된다.

### 9.6 service / route 에러 매핑

기존 `services/callPermissions.PermissionError`를 그대로 재사용하고, "팀이 안 보임"용으로 **신규 `TeamReportNotFoundError`** 추가. 두 분기를 route 에러 핸들러에서 각각 403 / 404로 매핑. service null 반환 + route 404 패턴 대신 명시적 throw를 쓴 이유: 정상 경로의 200/관리자 ok 분기에서 fall-through 한 `null`이 다른 의미(예: 빈 결과)와 충돌하지 않도록.

### 9.7 사이드바 등록

`_shared.js`의 `SIDEBAR_HTML` 상수에 `reports.html` nav item을 추가. `data-page="reports"`로 `renderSidebar('reports')`가 active 상태를 표시한다. icon은 simple line chart svg — 기존 sidebar svg 톤과 일치.

---

## 10. 미수행 / 보류 항목

본 단위 범위 밖이라 의도적으로 미수행:

- **README / server/README 상태 블록 갱신** — Step 5 closeout에서 일괄.
- **`docs/USER_GUIDE_PHASE_6.md`** — Step 5에서 함께.
- **team selector UI** — admin이 dropdown으로 team 선택 — plan §7 "Team selector"에 따라 v1에서는 미구현. 백엔드는 `team_id` 쿼리 파라미터를 받으므로 추후 추가 가능.
- **role-기반 nav 가시성** — 사이드바에서 employee/viewer에게 보고서 항목 숨김 — Phase 7+.
- **데이트 윈도우 필터 (오늘 / 7일 / 30일)** — Phase 7+.
- **소속 멤버 리스트 / 개인별 KPI** — 본 단위는 통화 KPI만. agent 개별 성과 breakdown은 별 단위.
- **Live browser smoke / Playwright check** — 실 서버 + DB가 필요해 자동 수행 안 함. Step 5 통합 e2e가 검증.

여전히 보류 중인 다른 Phase 6 잔여:
- Step 2 cost-accuracy commit (`cost_usd_micros` model→price map). `PHASE_6_STEP_2_FINDINGS.md §6.1` 그대로.
- `npm audit` high 2건 (pre-existing). 별도 PR.

---

## 11. commit / push 미수행

본 단위는 코드/문서만 작성하고 commit / push는 수행하지 않았다. Codex가 변경 scope + 검증 결과를 검토한 뒤 commit/push를 처리한다.

---

## 12. Codex Review Focus

- `getTeamReportSummary` 진입 시 manager 분기가 own team 검증 → 가시성 검사 → 403/404 매핑 순서를 정확히 따르는지.
- 모든 read SQL이 `app.withOrgContext(actor.orgId, actor.userId, …)` 안에서 실행되어 RLS + `current_app_user_id()` GUC가 일관되게 적용되는지.
- response body가 신뢰할 수 없는 입력으로 만든 SQL에 의존하지 않는지 (request body 0건, `team_id`는 zod로 UUID 검증).
- `recent_calls`의 LEFT JOIN이 soft-deleted customer/agent를 안전하게 null로 채우는지.
- frontend가 모든 API 필드를 `escapeHtml` 또는 `textContent`로 처리하고, `innerHTML`은 최근 통화 표 한 곳에만 사용되는지.
- `sync_shared_types`가 14 → 15로 자연스럽게 증가했고 master 문구가 실제 count에 맞게 정정됐는지.
- `.env*` / `package*.json` / 마이그레이션 / 다른 frontend 페이지가 무수정인지.

# Phase 7 Step 8 Plan — demo-to-real frontend cleanup

작성일: 2026-05-18

상위 문서: `PHASE_7_MASTER.md`

선행 완료:

- Step 1 — Resend email delivery + transactional `email_outbox`
- Step 2 — TOTP MFA / session hardening
- Step 3 — `activity_log` audit trail + admin query surface
- Step 4 — retention enforce cron
- Step 5 — `llm_usage_log.cost_usd_micros` price map
- Step 6 — role-based sidebar visibility
- Step 7 — reports date window + agent drilldown

이번 step의 목적은 Phase 7 P1 잔여 항목인 **demo-to-real frontend cleanup**을 닫는 것이다. `dashboard.html`, `daily.html`, `newsletter.html`에 남아 있는 demo/static 영역을 API-backed 영역과 명확히 분리하고, 이미 존재하는 live API로 바꿀 수 있는 영역은 실제 데이터로 연결한다. 새 제품 도메인을 넓히거나 대형 backend schema를 만드는 작업은 아니다.

---

## 1. Current State

### 1.1 `dashboard.html`

이미 API-backed:

- `/me` — sidebar/profile/greeting name.
- `/dashboard/summary` — 오늘 통화 KPI와 최근 통화.

아직 demo:

- 시장 트렌드 알림.
- 오늘의 추천 To-Do.
- 팀 활동.
- 일부 정적 count / label.

현재 위험:

- 페이지가 API/demo 혼합 상태라 사용자가 어떤 값이 실제 값인지 바로 알기 어렵다.
- `recent_calls` 렌더링은 server-returned fields를 다루므로 XSS gate 확인이 필요하다.
- `kpiAvgDuration`이 `.innerHTML`을 사용한다. 값 자체는 숫자 formatting 결과라 낮은 위험이지만 Step 8에서 `textContent`로 바꾸는 게 더 낫다.

### 1.2 `daily.html`

대부분 demo:

- 관심사, 검색 트렌드, 추천 To-Do, 경쟁사 알림, export 기능이 모두 정적 product demo.
- Naver search API / daily job backend surface가 아직 없다.

현재 위험:

- "매일 06:00 자동 갱신", "네이버 검색 API" 문구가 실제 backend가 있는 것처럼 보일 수 있다.
- export 기능은 demo 데이터를 문서로 내보내므로 API-backed 문서가 아니다.
- 페이지 규모가 크고 DOM 생성 코드가 많아 XSS gate를 새로 건드릴 때 범위 폭발 위험이 있다.

### 1.3 `newsletter.html`

대부분 demo:

- 캠페인 목록, 통계, AI 이메일 작성, 템플릿/스타일 갤러리, 발송 modal은 정적/로컬 상태 기반.
- 실제 campaign schema/route/provider integration은 없다.

이미 관련 backend가 있는 영역:

- Phase 7 Step 1의 transactional `email_outbox`는 verify/reset/invite transactional email용이다.
- newsletter campaign product와는 다른 도메인이다. 이번 step에서 campaign 발송 backend로 오해해 연결하지 않는다.

현재 위험:

- "발송 완료", "전달률", "오픈율", "클릭률"이 실제 운영 지표처럼 보인다.
- `innerHTML` 사용 지점이 많다. 대부분 local constant/demo arrays지만, 앞으로 server fields가 섞이면 XSS 위험이 커진다.

---

## 2. Scope

### 한다

1. **API/demo inventory를 코드에 명확히 남긴다**
   - 대상 파일 상단 또는 주요 section 주석에 `(API)` / `(demo)` 출처를 명시.
   - 사용자에게 보이는 demo badge/label은 최소화하되, 실제처럼 오해될 값에는 명확한 demo 표시를 유지한다.

2. **`dashboard.html` 실제 데이터 경계 강화**
   - `/dashboard/summary` API-backed KPI와 recent calls는 유지.
   - server-returned fields는 `textContent` 또는 `escapeHtml` 경유로만 렌더.
   - `kpiAvgDuration` 등 단순 값도 가능하면 `textContent`로 통일.
   - API error / 401 / refresh fail 상태를 사용자에게 깨끗하게 처리.
   - demo-only sections는 별도 `data-source="demo"` 또는 section-level 주석/label로 분리.

3. **`daily.html` demo 정직성 정리**
   - 실제 API가 없는 자동 수집/네이버 API/06:00 갱신 표현을 "demo" 상태와 모순 없이 정리.
   - `/me` refresh/sidebar/profile 흐름이 다른 authenticated page와 같은지 확인하고 보강.
   - demo 데이터 렌더링을 건드릴 경우 constant/demo-only임을 주석으로 pin.
   - 이번 step에서 Naver API, daily jobs, todo generation backend를 만들지 않는다.

4. **`newsletter.html` demo 정직성 정리**
   - transactional email outbox와 newsletter campaign이 별개임을 코드/문서에서 명확히 한다.
   - 발송/통계 UI는 campaign demo로 유지하되 실제 provider 발송처럼 보이는 문구를 정리.
   - quick prompt / generated draft / modal 값은 user-typed 또는 local-generated 값이므로 `textContent` 경로를 유지.
   - server-backed campaign route가 없는 상태에서 `email_outbox`에 직접 연결하지 않는다.

5. **XSS gate audit**
   - 세 파일의 `.innerHTML`, `insertAdjacentHTML` 지점을 목록화.
   - server-returned field가 들어가는 interpolation은 `escapeHtml` 또는 DOM node + `textContent`로 고친다.
   - demo constant HTML은 "constant/demo-only"로 분류하고 findings에 남긴다.

6. **Docs**
   - 구현 후 `PHASE_7_STEP_8_FINDINGS.md` 작성.
   - `PHASE_7_MASTER.md` Step 5+ bundle에서 demo-to-real cleanup 완료 표시.
   - `README.md` 현재 단계 / 로드맵 한 줄 갱신.

### 안 한다

- 새 database migration.
- Naver Search API adapter / scheduler / queue.
- AI To-Do generation backend.
- newsletter campaign schema / route / real provider 발송.
- billing / subscription caps. 다음 step으로 분리.
- dashboard API contract 대형 변경.
- frontend bundler 도입.
- demo 페이지 전체 재설계.

---

## 3. File-by-File Plan

### 3.1 `platform/dashboard.html`

Data source 판정:

| 영역 | 현재 | Step 8 목표 |
|---|---|---|
| Greeting name | API `/me` | 유지, 실패 시 `—` 또는 redirect |
| KPI cards | API `/dashboard/summary` | 유지, `textContent` 렌더 통일 |
| Recent calls | API `/dashboard/summary.recent_calls` | server fields escape/textContent 확인 |
| Market trends | demo | demo label 유지, daily backend 없음 명시 |
| Recommended To-Do | demo | demo label 유지, local constants only |
| Team activity | demo | 가능하면 `activity_log` 직접 노출은 하지 않음. Admin-only audit log와 다르므로 demo 유지 |

Implementation notes:

- `escapeHtml(str)`가 없으면 local helper 추가.
- `renderRecentCalls(summary.recent_calls)`는 server fields (`customer_name`, `title`, `status`, `started_at`)를 escape 처리.
- empty state는 constant string만 사용.
- `kpiAvgDuration.innerHTML = ...`는 `textContent`로 교체.
- refresh flow:
  - access token 없으면 `refreshAccessToken()`.
  - refresh 실패는 `loginRedirect()`.
  - dashboard summary 401/403/500은 banner나 safe placeholder로 표시.

Acceptance:

- admin/employee/viewer 모두 dashboard 진입 가능.
- KPI와 recent calls가 API 값으로 표시됨.
- API 실패 시 demo 값으로 조용히 fallback하지 않음.
- demo sections는 API 값처럼 보이지 않음.

### 3.2 `platform/daily.html`

Data source 판정:

| 영역 | 현재 | Step 8 목표 |
|---|---|---|
| Sidebar/profile | shared `/me` path | 유지/확인 |
| 관심사 키워드 | demo/local | demo로 명시 |
| 트렌드 알림 | demo/local | demo로 명시 |
| 추천 To-Do | demo/local | demo로 명시 |
| Export | demo/local document export | "현재 화면 demo export" 성격으로 유지 |
| 갱신 버튼 | demo/local | 실제 API 호출처럼 보이지 않게 정리 |

Implementation notes:

- 페이지 상단 또는 주요 header copy에서 "자동 갱신 완료"가 실제 job 성공처럼 보이지 않도록 조정.
- refresh button이 실제 backend 호출을 하지 않는다면 toast/label도 demo preview로 맞춘다.
- demo arrays를 서버 데이터처럼 명명하지 않는다. 예: `trends`보다 `DEMO_TRENDS`.
- `innerHTML`가 demo arrays를 렌더링하는 경우 findings에 constant/demo-only로 분류.
- user-editable keyword input이 HTML로 재삽입되는 경로가 있으면 `escapeHtml` 또는 DOM API로 보강.

Acceptance:

- 로그인 후 접근 가능.
- 화면에서 API-backed 값과 demo 값의 경계가 문서/코드상 명확함.
- 기존 export buttons가 깨지지 않음.
- mobile 375px에서 header controls와 keyword chips가 overflow하지 않음.

### 3.3 `platform/newsletter.html`

Data source 판정:

| 영역 | 현재 | Step 8 목표 |
|---|---|---|
| Sidebar/profile | shared `/me` path | 유지/확인 |
| Campaign stats/list | demo/local | demo campaign으로 명시 |
| AI compose | local simulated generation | demo/local임을 명시 |
| Send modal/progress | local simulated sending | 실제 provider 발송 아님을 명시 |
| Templates/styles | demo/local | constant/demo-only |

Implementation notes:

- "발송" 버튼이 실제 email provider 호출처럼 오해되지 않도록 copy를 정리한다. 예: "데모 발송", "시뮬레이션".
- `sendPrompt(this.textContent)`는 inline handler를 유지하더라도 입력값을 DOM에 넣을 때 `textContent` 사용을 유지.
- `renderCampaignDetail`, campaign list, style/template gallery의 `innerHTML`는 local constant/demo arrays인지 확인.
- user-edited subject/body는 이미 `textContent` 경로가 많다. 새로 건드리는 곳도 동일하게 유지.
- `email_outbox` route/helper를 newsletter에 연결하지 않는다.

Acceptance:

- newsletter 페이지에서 실제 발송/실제 통계로 오해될 문구가 줄어듦.
- campaign list pagination / template modal / style modal / draft edit / send simulation이 기존처럼 동작.
- mobile에서 right pane/input area가 깨지지 않음.

---

## 4. XSS Gate Checklist

작업자는 변경 전후로 다음을 반드시 확인한다.

```powershell
rg -n "innerHTML|insertAdjacentHTML|outerHTML|onclick=" platform/dashboard.html platform/daily.html platform/newsletter.html
```

분류:

- **API server-returned**: `/me`, `/dashboard/summary`, future API fields. 반드시 `textContent` 또는 `escapeHtml`.
- **User-typed**: daily keyword input, newsletter prompt/body/subject edit. 반드시 `textContent` 또는 `escapeHtml`.
- **Local demo constants**: fixed arrays / fixed template HTML. 허용 가능하나 findings에 constant/demo-only로 기록.
- **Layout chrome**: fixed SVG/button/table shell. 허용 가능.

금지:

- server-returned `customer_name`, `call.title`, `agent_name`, `org.name`, `email`, user-entered prompt를 raw template literal에 직접 넣기.
- API 실패 시 stale demo 값을 실제 값처럼 표시하기.

---

## 5. Backend / API Rules

이번 step은 기본적으로 frontend cleanup이다.

Allowed backend touch:

- 없음이 기본.
- 필요한 경우 `platform/api.js`에 기존 endpoint wrapper를 추가하는 정도만 허용.

Not allowed backend touch:

- schema migration.
- `/daily/*`, `/newsletter/*`, `/campaigns/*` 신규 route.
- outbox를 newsletter campaign 발송으로 재사용.
- activity log admin endpoint를 일반 팀 활동 feed로 노출.

Reasoning:

- Daily/newsletter는 별도 product surface다. backend 없이 frontend만 "real"처럼 꾸미면 더 위험하다.
- Step 8의 목표는 demo 경계를 줄이고 정직하게 만드는 것이지, 새 subsystem을 시작하는 것이 아니다.

---

## 6. Tests / Verification

필수 정적 검증:

```powershell
git diff --check
npm --prefix server run typecheck
node test/sync_shared_types.mjs
```

권장 backend smoke:

```powershell
npm --prefix server test
```

Frontend Playwright smoke:

1. `admin@acme.test / acme-admin-1234`
   - `dashboard.html`: KPI API 값 표시, recent calls 렌더, demo sections label 확인.
   - `daily.html`: 페이지 로드, 관심사/트렌드/To-Do 표시, export menu open, settings modal open/close.
   - `newsletter.html`: campaign list, pagination, AI prompt, draft edit, send simulation modal.
2. `emp@acme.test / acme-emp-1234`
   - Step 6 sidebar policy 유지: employee는 reports hidden, newsletter visible.
   - dashboard/daily/newsletter 접근 가능.
3. `viewer` role if available or by test-token path
   - viewer는 newsletter hidden policy 유지. direct URL behavior는 기존 page policy를 깨지 않는지 확인.
4. Mobile `375x812`
   - 세 페이지 모두 `document.documentElement.scrollWidth === clientWidth`.
   - topbar buttons, tables/lists, newsletter right pane input이 겹치지 않음.

Console:

- 새 uncaught JS error 없음.
- expected 403/401 외 API error 없음.

---

## 7. Completion Criteria

- `dashboard.html`, `daily.html`, `newsletter.html`의 API/demo 경계가 코드와 UI에서 명확하다.
- 이미 API-backed인 dashboard 값은 demo fallback 없이 실제 endpoint 결과로 표시된다.
- server-returned/user-entered values의 XSS gate가 닫혀 있다.
- Daily/newsletter는 backend 부재를 숨기지 않고 demo surface로 정리되어 있다.
- Step 6 sidebar visibility 정책이 회귀하지 않는다.
- Step 7 reports page가 변경되지 않거나 smoke로 회귀 없음이 확인된다.
- `PHASE_7_STEP_8_FINDINGS.md`, `PHASE_7_MASTER.md`, `README.md`가 구현 결과와 일치한다.

---

## 8. Suggested Commit Shape

한 커밋으로 닫아도 된다. 범위가 커지면 다음처럼 나눈다.

1. dashboard API/demo cleanup + XSS fixes.
2. daily/newsletter demo boundary cleanup.
3. docs: findings + master + README.

---

## 9. Handoff Instruction for Implementer

구현자는 먼저 세 파일의 모든 사용자 표시값을 `(API)` 또는 `(demo)`로 분류한 뒤 작업한다. 실제 backend가 없는 영역은 새 API가 있는 것처럼 꾸미지 말고 demo임을 명확히 한다. `dashboard.html`의 `/dashboard/summary`와 `/me` 경로는 실제 값으로 유지하고, server-returned 값은 raw `.innerHTML`에 넣지 않는다. 완료 후 findings에는 변경한 `innerHTML` 지점별 XSS 분류와 Playwright smoke 결과를 반드시 남긴다.

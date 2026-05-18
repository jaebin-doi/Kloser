# Phase 7 Step 6 Plan — role-based sidebar visibility

작성일: 2026-05-18

상위 문서: `PHASE_7_MASTER.md`

선행 완료:

- Step 1 — Resend email delivery + transactional `email_outbox`
- Step 2 — TOTP MFA / session hardening
- Step 3 — `activity_log` audit trail + admin query surface
- Step 4 — retention enforce cron
- Step 5 — `llm_usage_log.cost_usd_micros` price map

이번 step의 목적은 backend 권한 정책과 frontend sidebar 표시를 맞추는 것이다. 이미 서버는 권한 없는 접근을 401/403/404로 막고 있지만, employee/viewer에게 접근 불가능한 메뉴가 계속 보이면 운영 UX가 거칠다. Step 6은 보안 정책을 새로 만들지 않고, `/me`의 membership role을 이용해 공통 sidebar navigation을 역할별로 정리한다.

---

## 1. Current State

### 1.1 이미 있는 것

- 공통 sidebar renderer
  - `platform/_shared.js`
  - `renderSidebar(activePage)`가 각 authenticated page의 `#sidebarSlot`에 `SIDEBAR_HTML`을 주입한다.
  - `loadSidebarProfile()`가 access token refresh pre-flight 후 `GET /me`를 호출한다.
  - `applySidebarProfile(me)`가 user/org/role label을 `textContent`로 채운다.
- 공통 sidebar 스타일
  - `platform/_shared.css`
  - `.nav-item`, mobile sidebar, overlay 스타일이 공통화되어 있다.
- 역할 source-of-truth
  - `/me` response의 `membership.role`
  - role enum: `admin | manager | employee | viewer`
- backend 권한 계약
  - `/reports/team-summary`: `requireRole("admin", "manager")`. employee/viewer는 403.
  - `/team/members`: employee도 read 가능. mutation은 admin-only.
  - `settings.html`의 조직 MFA / audit log / guide mutation 등 admin-only block은 페이지 내부에서 role gate + server 403으로 처리 중.

### 1.2 현재 UX 문제

- `platform/_shared.js`의 sidebar는 모든 역할에게 같은 nav를 보여준다.
- employee/viewer에게 `팀 보고서`가 노출되지만 실제 `reports.html` 로드 시 403 banner가 뜬다.
- settings user popover의 `설정` 링크는 모든 역할에게 보인다. 이 자체는 문제 아님: `settings.html`에는 개인 MFA 등록/해제 같은 user-level 설정이 있다.
- `team.html`도 모든 역할에게 보인다. 이 자체도 문제 아님: 현재 backend가 employee read를 허용하고 page 내부에서 admin-only invite/mutation을 숨긴다.

---

## 2. Scope

### 한다

1. **Sidebar nav visibility helper**
   - `platform/_shared.js`에 role 기반 nav visibility helper를 추가한다.
   - `/me` 로드 성공 후 `applySidebarProfile(me)`에서 role label 채우기와 함께 nav visibility를 적용한다.
   - `renderSidebar(activePage)` 직후에는 기본적으로 민감 메뉴를 숨긴 상태로 시작하고, `/me` 성공 후 허용 role이면 다시 보인다.

2. **Reports menu gate**
   - `팀 보고서` nav item은 admin/manager에게만 표시한다.
   - employee/viewer는 sidebar에서 숨긴다.
   - 직접 URL 접근은 그대로 허용하지 않는다. `reports.html`이 backend 403 banner를 계속 보여주는 현재 계약을 유지한다.

3. **Active page fallback**
   - employee/viewer가 직접 `reports.html`을 열면 sidebar에서 active reports item은 숨겨진다.
   - page body는 기존 403 banner를 보여준다.
   - 숨겨진 nav item 때문에 sidebar layout이 깨지거나 section header만 남는 일이 없도록 한다.

4. **Test / smoke verification**
   - DOM-level 또는 browser-level로 admin/manager/employee/viewer role별 sidebar 표시를 확인한다.
   - desktop + mobile width에서 reports nav item이 hide/show 되는지 확인한다.

5. **Docs**
   - 구현 후 `PHASE_7_STEP_6_FINDINGS.md` 작성.
   - `PHASE_7_MASTER.md` Step 5+ 상태 갱신.
   - `README.md` 현재 단계/로드맵 갱신.

### 안 한다

- backend role policy 변경.
- `/reports/team-summary` route 변경.
- `reports.html` date window / agent drilldown 추가. 이것은 Step 7.
- `settings.html` 내부 admin panel 재설계.
- `team.html` 전체를 admin-only로 변경.
- billing/subscription cap.
- demo-to-real cleanup.
- 새 bundler나 frontend framework 도입.

---

## 3. Visibility Policy

Step 6의 nav visibility source-of-truth:

| Sidebar item | Current data | Visible roles | 이유 |
|---|---|---|---|
| 대시보드 | API | admin, manager, employee, viewer | `/dashboard/summary`는 viewer 포함 same-org read. |
| 실시간 통화 | API + WS | admin, manager, employee | viewer는 mutation/WS start path가 제한적. Step 6에서 숨길지 여부는 구현 전 확인 후 결정한다. 기본 계획은 viewer 숨김, writer roles 표시. |
| 통화 기록 | API | admin, manager, employee, viewer | read surface. mutation은 page/backend가 막는다. |
| 오늘의 일 | demo | admin, manager, employee, viewer | demo page. 이번 step의 권한 대상 아님. |
| 고객 | API | admin, manager, employee, viewer | read surface. writes는 viewer 403. |
| 뉴스레터 | demo | admin, manager, employee | viewer는 campaign 작성 UX가 중심이라 숨김 후보. 단 backend가 아직 demo이므로 구현 시 product decision을 findings에 명시. |
| 팀 & 계정 | API | admin, manager, employee, viewer | read 가능. admin-only controls는 page 내부에서 숨김. |
| 팀 보고서 | API | admin, manager | backend와 일치. employee/viewer에게 숨김. |
| 설정 | API + demo | admin, manager, employee, viewer | 개인 MFA 설정이 있어 모든 역할에게 필요. admin-only blocks는 page 내부 gate 유지. |

최소 완료 기준은 `팀 보고서`를 admin/manager 전용으로 숨기는 것이다. `실시간 통화`와 `뉴스레터`의 viewer 표시 여부는 구현자가 실제 page behavior를 확인해 함께 정리할 수 있지만, scope creep를 피하기 위해 findings에 명시하고 작은 diff로 유지한다.

권장 1차 정책:

```js
const SIDEBAR_NAV_VISIBILITY = {
  dashboard:  ['admin', 'manager', 'employee', 'viewer'],
  live:       ['admin', 'manager', 'employee'],
  calls:      ['admin', 'manager', 'employee', 'viewer'],
  daily:      ['admin', 'manager', 'employee', 'viewer'],
  customers:  ['admin', 'manager', 'employee', 'viewer'],
  newsletter: ['admin', 'manager', 'employee'],
  team:       ['admin', 'manager', 'employee', 'viewer'],
  reports:    ['admin', 'manager'],
  settings:   ['admin', 'manager', 'employee', 'viewer'],
};
```

이 정책을 채택하면 viewer는 read-only 중심 메뉴만 보게 된다. 단 `daily/newsletter`는 demo 경계가 있으므로 구현 중 실제 UX가 어색하면 `newsletter`는 후속 demo cleanup으로 넘기고 Step 6에서는 reports만 숨긴다.

---

## 4. Implementation Plan

### 4.1 Mark nav items with stable metadata

파일: `platform/_shared.js`

현재 nav item은 이미 `data-page`를 가진다.

```html
<a href="reports.html" data-page="reports" class="nav-item">...</a>
```

추가 후보:

- `data-nav-section="main|org"`를 section label wrapper에 붙이거나,
- section label을 포함하는 wrapper element를 추가한다.

권장 구조:

```html
<div class="sidebar-section" data-sidebar-section="main">
  <div class="...">메인</div>
  ...
</div>
<div class="sidebar-section" data-sidebar-section="org">
  <div class="...">조직</div>
  ...
</div>
```

이렇게 하면 section 내 visible item이 0개일 때 header도 숨길 수 있다. 현재 org section은 team/reports/settings 중 최소 settings가 남으므로 header가 남아도 큰 문제는 없지만, 구조화해두면 후속 billing/admin menu에서 안전하다.

### 4.2 Default hidden before `/me`

민감 nav가 `/me` 응답 전 짧게 보였다가 사라지는 flicker를 막는다.

방식:

1. `renderSidebar(activePage)`가 `applySidebarNavVisibility(null)`을 먼저 호출.
2. unknown role 상태에서는 sensitive item을 숨긴다.
3. `applySidebarProfile(me)`가 role을 확인한 뒤 `applySidebarNavVisibility(role)` 호출.

Unknown role policy:

```js
const SIDEBAR_NAV_VISIBLE_BEFORE_ROLE = new Set([
  'dashboard', 'calls', 'customers', 'daily', 'settings'
]);
```

또는 더 단순하게 reports/live/newsletter만 pre-hide한다.

### 4.3 Role helper

파일: `platform/_shared.js`

예상 helper:

```js
const SIDEBAR_ALL_ROLES = ['admin', 'manager', 'employee', 'viewer'];

const SIDEBAR_NAV_VISIBILITY = {
  dashboard: SIDEBAR_ALL_ROLES,
  live: ['admin', 'manager', 'employee'],
  calls: SIDEBAR_ALL_ROLES,
  daily: SIDEBAR_ALL_ROLES,
  customers: SIDEBAR_ALL_ROLES,
  newsletter: ['admin', 'manager', 'employee'],
  team: SIDEBAR_ALL_ROLES,
  reports: ['admin', 'manager'],
  settings: SIDEBAR_ALL_ROLES,
};

function canShowSidebarPage(page, role) {
  const allowed = SIDEBAR_NAV_VISIBILITY[page];
  if (!allowed) return true;
  if (!role) return false;
  return allowed.includes(role);
}

function applySidebarNavVisibility(role) {
  document.querySelectorAll('.nav-item[data-page]').forEach((el) => {
    const page = el.getAttribute('data-page');
    const show = canShowSidebarPage(page, role);
    el.hidden = !show;
    el.setAttribute('aria-hidden', show ? 'false' : 'true');
    if (!show) el.classList.remove('active');
  });
  updateSidebarSectionVisibility();
}
```

주의:

- `hidden` attribute 사용. CSS class churn보다 명확하고 접근성에도 낫다.
- 숨긴 item은 `.active` 제거.
- role이 이상한 값이면 unknown으로 처리하고 민감 메뉴를 숨긴다.
- 서버 값을 DOM에 넣지 않으므로 XSS surface는 거의 없다. role label은 기존처럼 `textContent`.

### 4.4 Section visibility

후속 확장을 위해 section wrapper를 도입한다면:

```js
function updateSidebarSectionVisibility() {
  document.querySelectorAll('[data-sidebar-section]').forEach((section) => {
    const visibleItems = section.querySelectorAll('.nav-item[data-page]:not([hidden])');
    section.hidden = visibleItems.length === 0;
  });
}
```

wrapper를 도입하지 않는 최소 diff라면 이 함수는 생략 가능하다.

### 4.5 Expose small test hook

browser/manual 검증 외에 deterministic test를 쉽게 하려면 helper를 window에 노출한다.

```js
window.__kloserSidebar = {
  applySidebarNavVisibility,
  canShowSidebarPage,
};
```

노출은 dev/test convenience다. production에서 민감 정보는 없다. 그래도 전역 오염을 싫어하면 `window.KLOSER_TEST_HOOKS === true`일 때만 노출한다. 권장: helper 함수 자체는 순수하게 두고, 테스트는 browser DOM에서 직접 `applySidebarProfile(mockMe)`를 호출한다. `applySidebarProfile`은 이미 global function이므로 추가 hook이 없어도 된다.

---

## 5. Page-Specific Notes

### 5.1 `reports.html`

- 직접 접근 시 현재 403 banner를 유지한다.
- Step 6에서 route/page logic을 바꾸지 않는다.
- Playwright smoke:
  - employee/viewer login 후 sidebar에는 `팀 보고서` 없음.
  - 직접 `/platform/reports.html` 접근 시 403 banner 문구는 표시됨.

### 5.2 `settings.html`

- Sidebar의 `설정`은 모든 역할에게 표시한다.
- 이유: 개인 MFA 등록/해제, 로그아웃, 계정 보안은 user-level 기능이다.
- 기존 admin-only blocks:
  - organization MFA required
  - audit log panel
  - guide/checklist mutation controls
- 이 blocks는 이미 `/me` role gate와 server 403 fallback이 있으므로 Step 6에서 대규모 변경하지 않는다.

### 5.3 `team.html`

- Sidebar의 `팀 & 계정`은 모든 역할에게 표시한다.
- 이유: `/team/members` read는 employee도 허용되고, page 내부에서 admin-only invite/mutation을 숨긴다.
- 단 viewer의 read 가능 여부는 구현자가 실제 route test/페이지 결과로 확인한다. viewer가 route 403이라면 visibility를 admin/manager/employee로 좁히고 findings에 근거를 남긴다.

### 5.4 `live.html`

- viewer는 실시간 통화 mutation이 제한되어 있다.
- 기존 code는 viewer role일 때 일부 mutation을 skip하는 guard가 있다.
- Step 6에서 viewer에게 `실시간 통화`를 숨기는 것을 권장한다. 단 이 변경이 product expectation과 충돌하면 reports-only로 축소한다.

### 5.5 `newsletter.html`

- 현재 demo-heavy page다.
- viewer에게 campaign authoring/demo surface를 보이는 것이 애매하다.
- 권장: viewer 숨김. 그러나 backend route 계약이 없는 demo page라 Step 6 findings에서 "demo page visibility policy"로 명확히 적는다.

---

## 6. Testing Plan

### 6.1 Static checks

```powershell
git diff --check
```

### 6.2 Backend regression

Step 6는 frontend-only가 목표지만, shared type and backend smoke는 유지한다.

```powershell
npm --prefix server run typecheck
node test/sync_shared_types.mjs
```

Full server test는 backend untouched면 필수는 아니지만 closeout에서 한 번 돌리는 것을 권장한다.

```powershell
npm --prefix server test
```

### 6.3 Browser smoke

서버:

```powershell
docker compose -f ops/docker-compose.yml up -d
npm --prefix server run dev
python -m http.server 8765
```

Playwright/MCP 시나리오:

1. admin login
   - sidebar에 `팀 보고서` 표시.
   - `설정` 표시.
   - `팀 & 계정` 표시.
2. manager login
   - sidebar에 `팀 보고서` 표시.
   - reports page 접근 가능.
3. employee login
   - sidebar에 `팀 보고서` 미표시.
   - 직접 reports URL 접근 시 403 banner 표시.
   - settings link는 표시되고 개인 MFA block 접근 가능.
4. viewer login
   - sidebar에 `팀 보고서` 미표시.
   - viewer 정책에 따라 `실시간 통화`/`뉴스레터` 표시 여부 확인.
   - 직접 reports URL 접근 시 403 banner 표시.
5. mobile viewport
   - sidebar open 후 같은 visibility 유지.
   - hidden item 때문에 spacing/section header가 어색하지 않음.

검증 시 캡처는 transient artifact로 남기지 않는다. 필요 시 findings에 "시각 확인 완료, screenshot not committed"만 기록한다.

### 6.4 XSS gate

이번 step에서 `.innerHTML`을 새로 추가하지 않는다.

- `SIDEBAR_HTML`은 기존 constant markup이다.
- role/org/user 값은 기존처럼 `textContent`.
- 새 helper는 `hidden`, `aria-hidden`, class 조작만 한다.

만약 section wrapper 도입으로 `SIDEBAR_HTML` constant를 수정한다면 interpolation 없는 constant markup으로 유지한다.

---

## 7. Acceptance Criteria

- [ ] `/me.membership.role='admin'`이면 sidebar에 `팀 보고서`가 보인다.
- [ ] `/me.membership.role='manager'`이면 sidebar에 `팀 보고서`가 보인다.
- [ ] `/me.membership.role='employee'`이면 sidebar에 `팀 보고서`가 보이지 않는다.
- [ ] `/me.membership.role='viewer'`이면 sidebar에 `팀 보고서`가 보이지 않는다.
- [ ] `/me` 응답 전 민감 메뉴가 잠깐 노출되지 않는다.
- [ ] 직접 `reports.html` 접근 시 backend 403 banner 계약은 유지된다.
- [ ] `설정`은 모든 역할에게 유지된다.
- [ ] `team.html` visibility 정책이 backend read contract와 일치한다.
- [ ] desktop/mobile sidebar layout이 깨지지 않는다.
- [ ] 새 `.innerHTML` XSS gate가 추가되지 않는다.
- [ ] `PHASE_7_STEP_6_FINDINGS.md`, `PHASE_7_MASTER.md`, `README.md`가 갱신된다.

---

## 8. Risks

### 8.1 Frontend-only visibility is not security

sidebar hide는 UX다. 직접 URL 접근과 API 호출은 반드시 server policy가 막아야 한다. Step 6는 backend policy를 약화하지 않는다.

### 8.2 Settings is mixed-scope

`settings.html`에는 개인 설정과 admin 설정이 섞여 있다. sidebar에서 통째로 숨기면 employee/viewer가 MFA 같은 개인 보안 설정에 접근하지 못한다. 그래서 settings nav는 유지하고 내부 admin block gate를 믿는다.

### 8.3 Demo pages have no backend policy

`daily.html` / `newsletter.html`은 demo-heavy라 role policy가 product policy와 섞여 있다. Step 6는 `reports` 같은 backend-backed mismatch를 먼저 닫고, demo page visibility는 최소로 건드린다.

### 8.4 Flicker

`/me`가 늦게 오면 민감 메뉴가 처음에 보였다가 사라질 수 있다. `renderSidebar()` 직후 unknown role policy를 적용해 이 flicker를 막는다.

---

## 9. Handoff To Implementation Agent

구현 순서:

1. `platform/_shared.js`의 `SIDEBAR_HTML` nav section 구조를 필요한 만큼 정리한다.
2. `SIDEBAR_NAV_VISIBILITY`, `canShowSidebarPage`, `applySidebarNavVisibility`를 추가한다.
3. `renderSidebar(activePage)`에서 unknown-role 기본 visibility를 적용한다.
4. `applySidebarProfile(me)`에서 `me.membership.role` 기준 visibility를 적용한다.
5. employee/viewer 직접 reports 접근 403 banner가 유지되는지 확인한다.
6. admin/manager/employee/viewer sidebar smoke를 desktop/mobile에서 확인한다.
7. `PHASE_7_STEP_6_FINDINGS.md`, `PHASE_7_MASTER.md`, `README.md`를 갱신한다.

커밋 단위 추천:

1. shared sidebar role visibility helper.
2. browser smoke/test evidence + docs closeout.


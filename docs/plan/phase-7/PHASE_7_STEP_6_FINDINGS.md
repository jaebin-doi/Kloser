# Phase 7 Step 6 Findings — role-based sidebar visibility

작성일: 2026-05-18

상위 문서: `PHASE_7_MASTER.md` · 상세 계획: `PHASE_7_STEP_6_PLAN.md`.

---

## 1. 산출물

| 영역 | 위치 |
|---|---|
| 가시성 헬퍼 | `platform/_shared.js` — `SIDEBAR_NAV_VISIBILITY`, `SIDEBAR_ALL_ROLES`, `canShowSidebarPage(page, role)`, `applySidebarNavVisibility(role)`, `_sidebarActivePage` 모듈 변수. helper 2개는 `window`에 노출되어 console / smoke test에서 직접 호출 가능. |
| renderSidebar 통합 | 같은 파일 — `renderSidebar(activePage)`가 sidebar HTML 주입 직후 `_sidebarActivePage`를 갱신하고 `applySidebarNavVisibility(null)`을 1회 호출 (pre-/me 기본). 이후 `wireSidebarUserMenu()` + `loadSidebarProfile()` 순. 기존 `if (activePage) ... classList.add('active')` 블록은 제거 — active 적용은 이제 가시성 헬퍼가 일원화. |
| applySidebarProfile 통합 | 같은 파일 — `me.user / .organization / .membership` null guard 통과 후 기존 textContent 채움 마지막에 `applySidebarNavVisibility(me.membership.role)` 호출. |
| CSS hidden 우선순위 | `platform/_shared.css` — `.nav-item[hidden] { display: none; }` 추가. `.nav-item { display: flex; }`와 동일한 specificity의 author rule이지만 더 뒤에 선언되어 cascade에서 이긴다. |
| Docs | 이 파일 + `PHASE_7_MASTER.md` Step 5+ bundle 첫 항목 완료 표시 + `README.md` 현재 단계·v1 roadmap 한 줄 갱신. |

`platform/*.html` 9개 페이지에는 변경 없음. `SIDEBAR_HTML` constant markup도 변경 없음. 새 `innerHTML` interpolation 0건.

---

## 2. 가시성 정책 (확정)

```js
const SIDEBAR_ALL_ROLES = ['admin', 'manager', 'employee', 'viewer'];
const SIDEBAR_NAV_VISIBILITY = {
  dashboard:  SIDEBAR_ALL_ROLES,
  live:       ['admin', 'manager', 'employee'],
  calls:      SIDEBAR_ALL_ROLES,
  daily:      SIDEBAR_ALL_ROLES,
  customers:  SIDEBAR_ALL_ROLES,
  newsletter: ['admin', 'manager', 'employee'],
  team:       SIDEBAR_ALL_ROLES,
  reports:    ['admin', 'manager'],
  settings:   SIDEBAR_ALL_ROLES,
};
```

Plan §3 "권장 1차 정책"을 그대로 채택. 핵심 결정 3가지:

- **reports**: backend `/reports/team-summary`가 `requireRole('admin','manager')`로 employee/viewer 403. sidebar도 동일하게 닫는다. **이 step의 최소 완료 기준.**
- **live, newsletter**: viewer 숨김. live의 WS start, newsletter의 작성 surface가 viewer 정책과 어긋난다. Backend write-path는 이미 viewer를 거른다 — Step 6는 menu만 정렬.
- **settings**: 모든 역할에게 유지. 개인 MFA enroll/disable이 settings.html 내부에 있어서 viewer까지 접근해야 한다. Admin-only 블록(조직 MFA 강제 / audit log 패널 / guide mutation)은 페이지 내부 gate + backend 403 fallback이 이미 처리.
- **team**: 모든 역할에게 유지. `/team/members` read가 employee 허용, page 내부에서 admin-only invite/mutation을 숨긴다. viewer read 가능 여부는 별도 확인하지 않음 (backend가 read 가능하면 그대로 유지, 막히면 후속 step에서 좁힌다).

---

## 3. canShowSidebarPage — null-role 처리

```js
function canShowSidebarPage(page, role) {
  const allowed = SIDEBAR_NAV_VISIBILITY[page];
  if (!allowed) return true;          // 정책 없는 nav는 통과 (확장 안전망)
  if (!role) return SIDEBAR_ALL_ROLES.every(r => allowed.indexOf(r) !== -1);  // pre-/me: 공통 nav만 표시
  return allowed.indexOf(role) !== -1;
}
```

Plan §4.2의 권장 1차 정책(공통 nav만 pre-show, 민감 nav는 pre-hide)을 적용. 결과:

| 상태 | 표시되는 nav |
|---|---|
| 페이지 진입 직후 (`role=null`, /me 응답 전) | dashboard, calls, daily, customers, team, settings |
| `/me.membership.role='admin'` 또는 `'manager'` | 9개 모두 |
| `/me.membership.role='employee'` | reports 숨김, 나머지 8개 |
| `/me.membership.role='viewer'` | reports / live / newsletter 숨김, 나머지 6개 |
| 알 수 없는 role (e.g. truthy garbage) | 모두 숨김 (fail-closed) |

**Flicker 정책**: reports/live/newsletter 같은 민감 nav는 `/me` 응답이 오기 전까지 절대 보이지 않는다. 반대로 공통 nav는 잠깐 보였다가 사라지는 일이 없도록 처음부터 표시. 두 가지 모두 user-perceived 깜빡임이 없는 상태.

---

## 4. applySidebarNavVisibility — active class 처리

```js
function applySidebarNavVisibility(role) {
  const items = document.querySelectorAll('.nav-item[data-page]');
  for (const el of items) {
    const page = el.getAttribute('data-page');
    const show = canShowSidebarPage(page, role);
    el.hidden = !show;
    el.setAttribute('aria-hidden', show ? 'false' : 'true');
    if (show) {
      if (page === _sidebarActivePage) el.classList.add('active');
    } else {
      el.classList.remove('active');
    }
  }
}
```

- 표시할 때: `_sidebarActivePage`와 일치하면 `.active` (재)부착. 첫 패스(null role)에서 reports 같은 페이지가 숨겨지면서 `.active`가 떨어졌더라도, 두 번째 패스에서 admin/manager로 복귀하면 `.active`가 다시 살아난다. 이래서 active page 추적을 모듈 변수로 둠 — `renderSidebar`에서 단발 적용하면 두 번째 패스에서 누락.
- 숨길 때: `.active` 제거. employee/viewer가 직접 `reports.html` URL을 열면 sidebar에서 active 흔적 없음.
- `aria-hidden`: `hidden`과 같은 방향으로 동기화. `hidden` 자체가 a11y tree에서 제거하므로 중복이지만, AT/스크립트 가시성 쿼리에 명시적 신호를 남기는 흔한 패턴.

---

## 5. CSS hidden override

```css
/* `.nav-item` sets display: flex; this rule (same-class specificity, later
   author rule) lets the HTML `hidden` attribute win for role-gated items. */
.nav-item[hidden] { display: none; }
```

User-agent의 `[hidden] { display: none }`은 author level `.nav-item { display: flex }`에 진다 (specificity 동률, author > user-agent). `.nav-item[hidden]`은 specificity 2 — 같은 specificity에서 cascade 순서로 이긴다.

검증: 모바일/데스크톱 모두 hidden 항목의 `offsetHeight === 0`, `getComputedStyle(el).display === 'none'` 확인 (§7).

---

## 6. 안 한 것

- backend role policy 변경. `/reports/team-summary` 라우터 / page-level 403 banner 로직은 그대로.
- `reports.html` date window / agent drilldown — Step 7.
- `settings.html` admin-only block 재배치.
- `team.html` viewer read 가능 여부 별도 확인.
- demo-to-real cleanup (newsletter / daily / dashboard 위젯).
- billing / subscription cap.
- 새 frontend bundler / framework 도입.

---

## 7. 검증

### 7.1 정적 검증

```powershell
git diff --check                                                # PASS (whitespace 깨짐 0)
npm --prefix server run typecheck                                # PASS (`tsc --noEmit` 0 error)
node test/sync_shared_types.mjs                                  # PASS (shared types 변경 없음)
npx tsx --test --test-concurrency=1 test/dashboard_routes.test.mjs # PASS (8/8)
npm --prefix server test                                          # PASS (727 total / 724 pass / 3 skipped / 0 fail)
```

Codex 검증 중 첫 full run에서 dev DB의 수동 smoke 잔재 call 1건(title NULL, Acme employee agent, today row)이 dashboard 집계를 깨뜨려 `dashboard_routes` 4건이 실패했다. Step 6 코드와 무관한 데이터 잔재라 해당 단일 call id만 정리한 뒤 `dashboard_routes` 단독과 full server test를 재실행했고 모두 PASS.

### 7.2 Browser smoke (Playwright MCP)

서버: `npm --prefix server run dev` (port 3001), static: `python -m http.server 8765`. 시나리오:

1. **admin login (admin@acme.test) → live.html 진입**: sidebar 9 nav 모두 `hidden=false`, `live`에 `.active`. `aria-hidden="false"` 동기화.
2. **헬퍼 직접 호출 매트릭스** (`window.applySidebarNavVisibility(role)` × 6):

   | role | dashboard | live | calls | daily | customers | newsletter | team | reports | settings |
   |---|---|---|---|---|---|---|---|---|---|
   | `null` (pre-/me) | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ | ✅ |
   | `admin` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
   | `manager` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
   | `employee` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
   | `viewer` | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ | ✅ |
   | `bogus` (garbage) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

3. **employee login (emp@acme.test) → live.html**: sidebar role label "직원", reports `hidden=true`, 나머지 8 표시, `live` active. 정상 wiring 확인.
4. **employee가 직접 `reports.html` URL 접근**: page 로드되지만 본문에 기존 메시지 "이 페이지는 관리자와 매니저만 볼 수 있습니다. 매니저의 경우 팀에 배정되어 있어야 합니다." 노출. sidebar `팀 보고서` nav는 `hidden=true`. 콘솔에 `GET /reports/team-summary 403` 1개 — 이는 reports.html 자체가 mount 시점에 API 호출을 시도하고 403을 받아 banner를 렌더하는 기존 contract. Step 6에서 추가된 오류 아님.
5. **모바일 viewport 375×812**: 사이드바 토글 후 hidden nav는 `offsetHeight=0` / `rectHeight=0`, 나머지 nav는 38px 단일 높이로 정상 렌더. section header(메인/조직) 빈 채로 남는 일 없음.

viewer role 시나리오는 seeded 계정이 없어서 헬퍼 매트릭스로만 확인 (위 §7.2 2번 표 viewer 행). dev DB에 임시 viewer 계정을 만들면 end-to-end 확인 가능하지만, 가시성 로직은 헬퍼에 집중되어 있어 매트릭스 검증으로 충분하다고 판단.

### 7.3 XSS gate

새 `.innerHTML` interpolation **0건**. 헬퍼는 `hidden`, `aria-hidden`, `classList`만 조작. role label은 기존처럼 `textContent` (§ `applySidebarProfile` `set()`).

---

## 8. 알려진 경계

### 8.1 backend가 frontend hide의 근거가 아님

Sidebar hide는 UX 정리. 직접 URL 접근, API 호출, browser devtools에서 `applySidebarNavVisibility('admin')` 강제 호출 모두 backend가 막아야 한다. Step 6는 backend policy를 약화하지 않음 — `/reports/team-summary requireRole('admin','manager')` 그대로.

### 8.2 reports.html 자체 콘솔 403

employee가 직접 `reports.html`을 열면 page mount 시 `GET /reports/team-summary`를 호출, 403을 받아 banner를 렌더한다. 이는 페이지의 기존 contract — Step 6가 신규 도입한 console error가 아님. 정리하려면 reports.html이 mount 전에 role을 확인해 fetch를 skip하는 별도 변경 필요. 현재 step에선 다루지 않음.

### 8.3 `live`/`newsletter` viewer 숨김의 product 근거

`live`는 viewer가 mutation/WS start path가 좁다는 기존 코드 guard, `newsletter`는 demo-heavy authoring surface — viewer에게 보이는 것이 의미 없음. 둘 다 backend route 계약이 명확하지 않으므로 product 결정이 바뀌면 `SIDEBAR_NAV_VISIBILITY` 한 곳만 고치면 된다.

---

## 9. Phase 7 Master 상태 갱신

`PHASE_7_MASTER.md §3 Step 5+ bundle`에서 두 번째 항목 "role-based sidebar nav visibility"가 완료됨. 남은 P1 follow-up은 보고서 drilldown / demo-to-real cleanup / billing.

---

## 10. 다음 작업 인계

Plan `PHASE_7_MASTER.md §3 Step 5+ bundle` 잔여:

1. reports date window + agent drilldown.
2. demo-to-real frontend cleanup (dashboard / daily / newsletter 위젯).
3. billing / subscription caps.

`PHASE_7_STEP_7_PLAN.md` 작성 시 Step 6에서 의도적으로 미룬 항목 두 가지를 같이 다루면 자연스럽다: (a) reports.html이 role을 보고 fetch를 skip하도록 페이지 자체 정리, (b) team.html viewer read 정책 확인.

# Phase 7 Step 8 Findings — demo-to-real frontend cleanup

작성일: 2026-05-18

상위 문서: `PHASE_7_MASTER.md` · 상세 계획: `PHASE_7_STEP_8_PLAN.md`.

---

## 1. 산출물

| 영역 | 위치 |
|---|---|
| dashboard API/demo 경계 | `platform/dashboard.html` — `kpiAvgDuration`을 `innerHTML` → `textContent`(value/unit 두 span)로 전환, `loadDashboard`에 `resetDashboardUi`/`showDashboardError` 추가, 데모 sub-section 3곳에 `data-source="demo"` + `todos` → `DEMO_TODOS` 리네이밍. greeting/recent_calls escape는 유지. |
| daily demo 정직성 | `platform/daily.html` + `platform/_daily.js` 재작성 — "매일 06:00 자동 갱신" / "네이버 검색 API로 자동 수집" / "갱신 완료" 라벨을 "데모 데이터 (자동 갱신 backend 미연결)" / "데모 데이터" / "데모 새로고침"으로 교체, `refreshDailyDemo` toast 도입, `trends` → `DEMO_TRENDS`, `todos` → `DEMO_TODOS` 리네이밍, 모든 user-typed 키워드/경쟁사 보간에 `escapeHtml` 통과, HTML/PDF/Word/Excel/PPT export 출력에 "데모" 헤더 + escape 적용. |
| newsletter demo 정직성 + XSS | `platform/newsletter.html` — `appendUser`의 `${text}` innerHTML 보간을 `.user-msg-body` textContent로 교체 (chat XSS 닫힘), `renderTemplates`의 user-typed 템플릿 필드(title/desc/icon/badgeLabel)에 `escapeHtml`, 발송 modal·step2·step3 카피를 "발송" → "시뮬레이션" 전반 교체 ("이메일 발송 (시뮬레이션)", "시뮬레이션 실행 중", "시뮬레이션 완료", "예시 발신: ..."), 상단 통계 카드에 `(예시)` 라벨 + `data-source="demo"`, AI 패널 헤더에 `(demo)` + 부제 갱신, toast 기본 메시지 "발송 완료" → "시뮬레이션 완료". 캠페인 배열 상단에 constant/demo-only 정책 주석. |
| Fixture (Step 7 잔재) | `server/test/_phase5Fixture.mjs`는 Step 7에서 `duration_seconds`/`ended_at` thread를 이미 추가 — Step 8에서 변경 없음. |
| Docs | 이 파일 + `PHASE_7_MASTER.md` Step 5+ bundle 4번 완료 표시 + `README.md` 현재 단계·v1 roadmap 갱신. |

backend (`server/`) 코드 변경 0건. schema/route/types 무변경. Step 7 reports surface 회귀 없음.

---

## 2. API vs Demo 분류

세 페이지 전체를 인벤토리한 결과:

### 2.1 `platform/dashboard.html`

| 영역 | 분류 | 출처 |
|---|---|---|
| Sidebar / org card / user button | API | 공통 `_shared.js`의 `/me` |
| 헤더 미인증 배너 | API | `/me.user.email_verified_at` (별도 모듈) |
| Greeting name | API | `/me.user.name` 또는 email local part |
| KPI 4종 (today / response_rate / avg / active) | API | `/dashboard/summary` |
| Recent calls table | API | `/dashboard/summary.recent_calls` |
| 시장 트렌드 알림 (5건) | demo | 정적 HTML, daily.html과 통합 예정 |
| 오늘의 추천 To-Do | demo | `DEMO_TODOS` 로컬 상수 |
| 팀 활동 (5건) | demo | 정적 HTML. **`activity_log` admin endpoint(Step 3)를 일반 feed로 노출하지 않음** |
| 미인증 배너 | API | `/auth/verify/resend` (배너 자체는 `_shared.js`) |

### 2.2 `platform/daily.html` + `platform/_daily.js`

| 영역 | 분류 | 출처 |
|---|---|---|
| Sidebar / profile | API | `/me` |
| Today date | computed | `new Date()` |
| KPI 4종 (신규 키워드 / 상승 트렌드 / 추천 To-Do / 긴급 알림) | demo | 정적 숫자 |
| 관심사 키워드 chips | demo (user-typed) | 페이지 로컬 `keywords[]` |
| 시장 트렌드 알림 | demo | `DEMO_TRENDS` 로컬 상수 |
| 추천 To-Do | demo | `DEMO_TODOS` 로컬 상수 |
| 경쟁사 동향 (4건) | demo | 정적 HTML |
| 최근 7일 트렌드 표 | demo | 정적 HTML |
| 설정 modal (키워드 / 경쟁사 / 시간 / 언어) | demo (user-typed) | 브라우저 메모리 only |
| Export HTML/PDF/DOC/XLSX/PPT | demo serialise | 현재 화면 데이터를 그대로 직렬화 |
| "데모 새로고침" 버튼 | demo placeholder | toast만 표시 |

### 2.3 `platform/newsletter.html`

| 영역 | 분류 | 출처 |
|---|---|---|
| Sidebar / profile | API | `/me` |
| 상단 통계 4종 (발송 완료 / 전달률 / 오픈율 / 클릭률) | demo | 정적 숫자, 모두 `(예시)` 라벨 |
| 캠페인 목록 (32건) + pagination | demo | `campaigns` 로컬 상수 |
| 캠페인 detail modal (`renderCampaignDetail`) | demo | 같은 `campaigns` row |
| AI 이메일 작성 chat | demo (user-typed) | `generateDraft`가 키워드로 로컬 템플릿 선택 |
| 빠른 시작 prompts | demo | 정적 버튼 4개 |
| 발송 modal step1/2/3 | demo simulation | progress bar는 시각 효과만 |
| 템플릿 갤러리 / 사용자 생성 템플릿 | demo (user-typed) | `templates` + `submitNewTemplate` |
| 스타일 갤러리 / 미리보기 | demo constant | `styles` 로컬 상수 + `renderStyleHTML` static template |
| 초안 편집 modal | demo (user-typed) | 편집은 textContent 경로 유지 |

**transactional `email_outbox` (Step 1)**과 newsletter campaign 발송은 **별개 도메인**. Step 8에서 outbox를 newsletter에 연결하지 않음. 캠페인 발송 backend가 도입되기 전까지 시뮬레이션이라는 사실을 UI 카피로 명시.

---

## 3. innerHTML / insertAdjacentHTML 분류

`rg "innerHTML|insertAdjacentHTML|outerHTML" platform/dashboard.html platform/daily.html platform/_daily.js platform/newsletter.html` 기준 인벤토리.

| 파일 | 라인 | 변수/필드 | 분류 | 처리 |
|---|---|---|---|---|
| dashboard.html | `todoListEl.innerHTML = ''` | empty reset | layout chrome | 그대로 |
| dashboard.html | `li.innerHTML = \`...\`` (renderTodos) | `t.text`, `t.tags` | DEMO_TODOS 상수 | 그대로, 주석으로 server-supplied로 교체 시 `escapeHtml` 필요 표기 |
| dashboard.html | `el.innerHTML = ''` (renderRecentCalls reset) | layout chrome | constant | 그대로 |
| dashboard.html | `el.innerHTML = '<tr>...빈 상태</tr>'` | 상수 문자열 | constant | 그대로 |
| dashboard.html | `tr.innerHTML = '<td>...' + escapeHtml(...)` (recent row) | server fields | API server-returned | 이미 모두 `escapeHtml` 통과 |
| dashboard.html (이전) | `kpiAvgDuration.innerHTML = formatAvgDurationLabel(...)` | API number → HTML | API server-returned | **제거**. textContent 2 span으로 교체 |
| _daily.js | `list.innerHTML = html` (renderKeywords) | `keywords[i]` | user-typed | **`escapeHtml` 추가** |
| _daily.js | `listModal.innerHTML = html` | 같은 chunk | user-typed | 같은 escape 경로 |
| _daily.js | `cpList.innerHTML = ...` (renderCompetitors) | `c.name`, `c.domain` | user-typed | **`escapeHtml` 추가** |
| _daily.js | `trendsList.innerHTML = html` (renderTrends) | `t.kw`, `t.desc` | DEMO_TRENDS 상수 | 그대로, 주석 |
| _daily.js | `list.innerHTML = DEMO_TODOS.map(...)` | `t.text`, `t.tag`, `t.source` | DEMO_TODOS 상수 | 그대로, 주석 |
| _daily.js | dlHtml/dlWord export template | `keywords[]` | user-typed | **`escapeHtml` 추가** (HTML/DOC 출력) |
| newsletter.html | `wrapper.innerHTML = ...` (appendUser) | `text` | user-typed (chat) | **chrome만 innerHTML, body는 textContent** |
| newsletter.html | `w.innerHTML = ...` (appendTyping) | constant SVG/text | constant | 그대로 |
| newsletter.html | `w.innerHTML = ...` (appendAi) | caller-provided HTML | constant or escaped | 호출부에서 사전 처리 |
| newsletter.html | `w.innerHTML = ...` (appendDraft) | static template + `.draft-subject/.draft-body` textContent | constant chrome + user input via textContent | 그대로 (이미 안전) |
| newsletter.html | `campListEl.innerHTML = slice.map(...)` (renderCampaigns) | `c.title`, `c.preview`, `c.recipients`, `c.status`/`c.schedule`/`c.date` | constant demo array (no create flow) | 그대로, 주석 |
| newsletter.html | `paginationEl.innerHTML = ...` | constant chrome | layout chrome | 그대로 |
| newsletter.html | `campaignModalContent.innerHTML = renderCampaignDetail(c)` | constant demo array. body/subject 이미 escape | constant demo | 그대로 |
| newsletter.html | `styleGrid.innerHTML = slice.map(...)` (renderStyles) | `styles[]` 상수 | constant | 그대로 |
| newsletter.html | `stylePaginationEl.innerHTML = ...` | layout chrome | constant | 그대로 |
| newsletter.html | `stylePreviewBox.innerHTML = renderStyleHTML(s.id, true)` | static template | constant | 그대로 |
| newsletter.html | `tplGrid.innerHTML = list.map(...)` (renderTemplates) | `t.title`, `t.desc`, `t.icon`, `t.badgeLabel`, `t.iconBg/iconBorder/badge` | **custom 템플릿이 user-typed** | **`escapeHtml` 추가** (`t.title`, `t.desc`, `t.icon`, `t.badgeLabel` 필드) |
| newsletter.html | `appendAi(\`<div ...>${t.title}...\`)` (template click) | `t.title` user-typed | user-typed | **`escapeHtml` 추가** |
| newsletter.html | `tplIconPicker.innerHTML = ICON_OPTIONS.map(...)` | constant emoji list | constant | 그대로 |

**확인된 XSS hole 3개 모두 닫힘**:

1. `daily.html` 키워드 chip — user-typed input이 raw HTML interpolation.
2. `daily.html` 경쟁사 chip — 같은 패턴.
3. `newsletter.html` chat user message — chat textarea가 raw HTML interpolation.
4. (보너스) `newsletter.html` custom 템플릿 카드/AI 응답 — `submitNewTemplate`로 들어온 user-typed 제목/설명.

브라우저 smoke에서 `<img src=x onerror=...>` payload를 daily 키워드 입력과 newsletter chat 입력 양쪽에 주입했고, 두 경우 모두 **execution 0**, 텍스트로만 표시되어 escape가 정상 작동함을 end-to-end 확인.

---

## 4. UI 카피 변경 요약

### 4.1 dashboard.html

- 데모 sub-section 3곳 (트렌드, To-Do, 팀 활동)에 `data-source="demo"` + 헤더 "(demo)" 라벨 유지.
- 팀 활동 섹션 주석에 "**activity_log admin endpoint를 일반 feed로 노출하지 않는다**" 명시 (Step 3 정책).
- `kpiAvgDuration` 카드: HTML이 `<span id=Value>3m 04</span><span id=Unit>s</span>` 구조로 변경. 시각적 결과는 동일.

### 4.2 daily.html

| 위치 | 이전 | 이후 |
|---|---|---|
| 페이지 헤더 부제 | "매일 06:00 자동 갱신" | "데모 데이터 (자동 갱신 backend 미연결)" (amber 색) |
| Top KPI 옆 badge | "갱신 완료 06:00" (emerald) | "데모 데이터 예시 06:00" (amber) |
| "지금 갱신" 버튼 | primary blue | "데모 새로고침" secondary, 클릭 시 toast |
| "모니터링 관심사" 부제 | "매일 06:00 네이버 검색 API로 자동 수집" | "실 운영 시 매일 06:00 시장 검색으로 자동 수집 (현재는 demo)" + 헤더 "(demo)" |
| "시장 트렌드 알림" 헤더 | (구분 없음) | "(demo)" + "예시 데이터" 부제 |
| "오늘의 추천 To-Do" 헤더 | (구분 없음) | "(demo)" + "현재는 예시" 부제 |
| "경쟁사 동향" 헤더 | (구분 없음) | "(demo)" + "예시 데이터" 부제 |
| "최근 7일 트렌드 변화" 헤더 | (구분 없음) | "(demo)" |
| 설정 modal 헤더 | "관심사 설정" + "매일 자동 수집할 키워드와 경쟁사를 관리합니다." | "관심사 설정 (demo)" + "현재는 브라우저에만 저장됩니다." |
| 설정 modal 저장 버튼 | "저장하고 다시 분석" | "데모 저장" |
| 저장 toast | "✓ 관심사가 저장되었습니다 · 잠시 후 갱신됩니다" | "✓ 데모 설정이 저장되었습니다 (브라우저 메모리)" |
| Export 파일 헤더/푸터 | "자동 생성된 회의 자료" | "demo export · 실 backend 미연결 참고용" + 페이지 상단 yellow demo-note |

### 4.3 newsletter.html

| 위치 | 이전 | 이후 |
|---|---|---|
| 상단 통계 4종 라벨 | "발송 완료 / 전달률 / 오픈율 / 클릭률" | 동일 라벨 + 각각 `(예시)` 부착 + section `data-source="demo"` |
| 캠페인 목록 헤더 | "캠페인 목록" | "캠페인 목록 (demo)" |
| AI 패널 헤더 | "AI 이메일 작성 · 대화로 메일을 즉시 생성합니다" | "AI 이메일 작성 (demo) · 키워드 기반 로컬 데모 초안 생성" |
| Send modal 헤더 | "이메일 발송 · 발송 전 수신자와 일정을 확인해 주세요" | "이메일 발송 (시뮬레이션) · 실제 발송은 이뤄지지 않습니다 (캠페인 backend 미연결)" |
| "지금 발송" 라디오 부제 | "버튼을 누르면 즉시 발송돼요" | "시뮬레이션 진행률 표시 (실제 발송 없음)" |
| "예약 발송" 라디오 부제 | "원하는 시간에 자동 발송" | "예약 시각을 toast로만 안내 (실제 발송 없음)" |
| Send modal footer | "From: noreply@kloser.com" / "2,486명에게 발송" | "예시 발신: noreply@kloser.com (시뮬레이션)" / "2,486명에게 시뮬레이션 실행" |
| Step 2 텍스트 | "발송 중입니다" | "시뮬레이션 실행 중" |
| Step 3 텍스트 | "발송 완료" / "정상 발송되었습니다" | "시뮬레이션 완료" / "발송 시뮬레이션이 끝났습니다 (실제 발송은 없었습니다)" |
| Toast 기본 | "발송 완료" | "시뮬레이션 완료" |

`renderCampaignDetail` 안의 modal 내부 통계 ("발송 결과", "전달", "오픈", "클릭")는 demo campaign row의 정적 숫자 그대로 — modal 상위 헤더와 상단 카드들의 `(예시)` 표기로 demo 성격이 이미 전달되므로 추가 라벨 부착은 보류 (modal 디자인 압축 유지).

---

## 5. 검증

### 5.1 정적 검증

```powershell
git diff --check                                                # PASS (whitespace 깨짐 0)
npm --prefix server run typecheck                                # PASS (`tsc --noEmit` 0 error)
node test/sync_shared_types.mjs                                  # PASS (shared types 변경 없음)
```

### 5.2 Backend 단위/통합 테스트

```powershell
npm --prefix server test                                         # 첫 실행: dashboard_routes 4건 fail
```

원인: 개발 DB에 Step 7 browser smoke 잔재 1건(call id `a267a39a-…`, status=ended, agent=ACME_EMP, title=null)이 남아 dashboard `today_calls`/`recent_calls` 단언을 어긋나게 만들었다. **Step 8 코드와 무관**. 이 단일 row를 dev DB에서 삭제(직접 SQL DELETE) 후 재실행:

```powershell
npm --prefix server test                                         # PASS — 738 total / 735 pass / 3 skipped / 0 fail
```

이 잔재는 Step 7 closeout findings에 동일 패턴이 기록되어 있고(`dashboard_routes` test의 cleanup이 `title IS NULL AND agent_user_id = ACME_ADMIN`만 잡음) Step 8에서 새로 도입한 문제가 아님. 후속 정리에서 dashboard test의 `beforeEach` cleanup을 더 넓힐지 또는 fixture 자체에 보호망을 추가할지 판단.

### 5.3 Browser smoke (Playwright MCP)

서버: `npm --prefix server run dev` (port 3001), static: `python -m http.server 8765`.

1. **admin `admin@acme.test` → dashboard.html (desktop 1280×900)**
   - KPI 4종 모두 API 값으로 채워짐: today=1, rate=100%, avg=0m 05s, active=0.
   - greeting "에이스 어드민님".
   - `data-source="demo"` 마커 4개 (트렌드, To-Do, 팀 활동, 부모 grid).
   - 콘솔 error 0건.
2. **admin → daily.html**
   - keyword chip 7개, todo row 8개, trend row 7개.
   - **XSS test**: `<img src=x onerror="window.__xssfired=1">` 키워드로 추가 시 chip 안에 텍스트로만 렌더, `window.__xssfired === false`.
3. **admin → newsletter.html**
   - 캠페인 8개 + pagination 5개 버튼.
   - **XSS test**: 같은 페이로드를 채팅 textarea로 전송 → user message 본문에 텍스트로만 표시, `window.__nlxss === false`.
   - 본문에 "(demo)"/"데모"/"시뮬레이션"/"예시" 라벨 모두 노출.
4. **employee `emp@acme.test`로 로그인 후 dashboard.html**
   - Step 6 sidebar 정책 유지: `reports` `hidden=true`, 나머지 8 visible.
   - greeting "에이스 직원님", KPI today=2 (직원 시점에서도 API 정상 응답).
5. **employee → daily.html**
   - role "직원", keyword chip 7개, todo row 8개, 데모 라벨 노출.
6. **모바일 viewport 375×812 (employee 세션)**
   - `dashboard.html`: `documentElement.scrollWidth === clientWidth` (가로 overflow 없음). KPI=2 정상 표시.
   - `daily.html`: 가로 overflow 없음. 키워드 chip 7개 wrap.
   - `newsletter.html`: 가로 overflow 없음. 캠페인 8개 list.
   - 콘솔 error 0건.

viewer는 dev seed에 없어 end-to-end는 생략. Step 6의 sidebar visibility 매트릭스(viewer는 reports/live/newsletter 숨김)는 Step 6 findings에서 단위 helper로 이미 검증됨.

---

## 6. 안 한 것

Plan §2 "안 한다" 그대로 + 추가:

- 새 database migration.
- Naver Search API adapter / scheduler / queue.
- AI To-Do generation backend.
- newsletter campaign schema / route / 실 provider 발송.
- transactional `email_outbox`(Step 1)을 newsletter에 연결.
- `activity_log` admin endpoint(Step 3)를 dashboard 팀 활동 feed로 노출.
- billing / subscription caps.
- dashboard API contract 대형 변경.
- frontend bundler 도입.
- demo 페이지 전체 재설계.
- `renderCampaignDetail` 내부 통계/지표 카드별 라벨 (modal 상위 헤더의 (시뮬레이션) 표기로 의도 전달).

dashboard `beforeEach` cleanup 범위 확대 작업도 Step 8 범위 밖. dev DB 잔재 정리는 별도 PR 또는 후속 step에서.

---

## 7. Phase 7 Master 상태 갱신

`PHASE_7_MASTER.md §0`에서 Step 5+ bundle 4번째 항목(demo-to-real cleanup)이 완료됨. 남은 P1 follow-up:

5. billing / subscription caps.

Step 9가 billing 단독으로 진행되거나 enterprise prep 항목들과 묶일 수 있다 — `PHASE_7_STEP_9_PLAN.md`가 작성되는 시점에 결정.

---

## 8. 다음 작업 인계

billing/subscription caps가 마지막 P1 항목. Step 5의 `llm_usage_log.cost_usd_micros`와 Step 7의 `window_days` payload는 둘 다 입력으로 활용 가능 (월간 비용 집계 + 윈도우 길이 cap). Step 8에서 정리한 demo 경계는 그대로 유지되며, billing이 들어와도 dashboard/daily/newsletter의 demo surface는 변경할 필요 없음 (billing은 별도 페이지/sidebar 항목으로 추가될 가능성이 높음).

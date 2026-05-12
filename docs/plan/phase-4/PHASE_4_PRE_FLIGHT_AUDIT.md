# Phase 4 Pre-flight Audit

> Phase 3가 닫힌 시점(2026-05-12)에 Phase 4 (calls / transcripts 영속화 + dashboard 실 KPI 전환)로 진입하기 전, 현재 제품·문서·보안·데모 상태를 한 번 훑고 "Before Phase 4에 반드시 처리"와 "Phase 4 도중 흡수"를 분리한다. 본 문서는 audit만 다룬다 — 코드/마이그레이션/프론트엔드/시드/캡처 변경은 0건.

---

## 0. Repo 상태 (2026-05-12, audit 시작 시점)

| 항목 | 값 |
|---|---|
| Branch | `feature/phase-3-team-invitations` |
| Sync | origin과 일치 (ahead 0 / behind 0) |
| Working tree | 이 audit 문서 1건만 untracked |
| HEAD | `6b734a8 Document Codex validation responsibility` |
| 최근 5 commit | `6b734a8 Document Codex validation responsibility` / `c881135 Clarify Codex-owned git operations` / `196d787 Update AGENTS commit push policy` / `1d40404 Add real Phase 3 screenshots to product guide` / `e08b7e2 Document sidebar profile wiring as a Phase 3 feature` |

---

## 1. Audit 결과 표

> 위험도 척도: **Blocker** (Phase 4 진입 자체 불가) / **High** (사용자가 헷갈리거나 보안·권한 문제) / **Medium** (정확한 메시지 전달이 약함) / **Low** (톤·캡션·문서 미세 정합).
> 처리 시점: **Before Phase 4** / **Phase 4 (도중 흡수)** / **Phase 5** / **Phase 6+**.

### 1.1 Logged-in 공통 UX

| # | 항목 | 현재 상태 | 위험도 | 처리 시점 | 권장 조치 |
|---|---|---|---|---|---|
| L-01 | 사이드바 프로필 `/me` 실데이터 반영 | `platform/_shared.js`의 `loadSidebarProfile()`가 `renderSidebar()`에서 자동 호출. 모든 logged-in 페이지에서 상단 카드(조직·플랜) + 하단 버튼(이름·역할) 채워짐. `dashboard/calls/newsletter/daily.html`에는 직전 commit에서 `api.js`도 같이 wire | OK | — | 없음 |
| L-02 | logout 메뉴 (popover) | 프로필 버튼 클릭 → "설정 / 로그아웃" 위로 뜸. 외부 클릭·Esc로 닫힘. 서버 logout 실패해도 `/platform/login.html`로 항상 이동 | OK | — | 없음 |
| L-03 | 미인증 배너 wire 범위 | 현재 `live.html` + `team.html` 두 페이지만 부팅 코드에서 `renderUnverifiedBanner(meBody.user)` 호출. `dashboard.html` / `calls.html` / `customers.html` / `daily.html` / `newsletter.html` / `settings.html` 6 페이지는 미연결. 미인증 사용자가 이 페이지로 직접 진입하면 자기 상태를 모름 | Medium | Phase 4 (Step 4 frontend wiring에 흡수) | 각 페이지 부팅 코드에 `/me` 응답 → `window.renderUnverifiedBanner(meBody.user)` 한 줄씩 추가 (Phase 3 Step 7 findings §154 인계 항목). API 호출은 사이드바 프로필 로드가 이미 `/me`를 부르고 있으니 응답 캐시 공유 가능 |
| L-04 | seed 계정 `email_verified_at = NULL` | 시드 4계정(`admin@acme`, `emp@acme`, `admin@beta`, `emp@beta`) 전부 `email_verified_at = NULL`. 그래서 `admin@acme.test`로 로그인하면 사이드바엔 실 /me 데이터가 보이는데 **노란 미인증 배너도 동시에 뜸**. 본 audit 작업 직전 `sidebar-loggedin.png` 캡처에 그대로 노출 (배너 + Acme Sales Inc. + 에이스 어드민). 평가자/데모 시청자가 "이거 진짜 인증된 거 맞나"로 헷갈림 | **High** | **Before Phase 4** | `server/seeds/0001_demo.sql`의 시드 user 4행 INSERT 문에 `email_verified_at` 컬럼 + `now()` 값 추가. 본질적으로 1-line 시드 SQL 변경. 영향 범위: dev DB만. 마이그레이션 무관 |

### 1.2 Auth / Self-service 흐름

| # | 항목 | 현재 상태 | 위험도 | 처리 시점 | 권장 조치 |
|---|---|---|---|---|---|
| A-01 | signup | `platform/signup.html` 정상. 가입 시 starter 플랜 조직 + admin user + 24h 인증 토큰 outbox 발송. Phase 3 e2e s1에서 회귀 PASS | OK | — | 없음 |
| A-02 | verify | `platform/verify.html` 정상. 진입 즉시 `history.replaceState`로 token 제거. 1회 소비 후 410. Phase 3 e2e s1 회귀 PASS | OK | — | 없음 |
| A-03 | forgot / reset | `platform/forgot-password.html` + `reset-password.html` 정상. enumeration 차단 (응답 항상 200). reset 시 모든 활성 refresh session revoke. Phase 3 e2e s2 회귀 PASS | OK | — | 없음 |
| A-04 | accept invitation | `platform/accept-invitation.html` 정상. 익명 진입, 신규/기존 user 둘 다 200/201 처리. multi-org membership 추가 흐름 e2e s3/s4 회귀 PASS | OK | — | 없음 |
| A-05 | multi-org login UX | `login.html`은 (a) 기본 폼 + (b) "조직 ID 직접 입력 (멀티-org 사용자)" 접힘 토글로 manual UUID 입력 허용 + (c) 400 + `availableOrgs` 응답 시 org 선택 리스트 자동 렌더. 실 사용자가 본인 org UUID를 외우고 있을 리 없어 (b) 경로는 사실상 dead UX이고 (c)는 한 번 실패해야 등장. 평가자가 처음 시도 시 매번 한 번 실패함 | Medium | Phase 4 (UX polish — manager 보고서·Phase 5와 묶어도 무방) | (b) 토글 기본 숨김 강화, (c) 진입을 1차 흐름으로. 또는 email 입력 직후 `/auth/login/orgs?email=...` 같은 lookup endpoint로 multi-org 여부 선조회. 본 audit 범위는 의사결정만 — 구현은 후속 |

### 1.3 Mock vs Real boundary (페이지별)

| # | 페이지 | 현재 상태 | 위험도 | 처리 시점 | 권장 조치 |
|---|---|---|---|---|---|
| M-01 | `platform/live.html` | 인증 게이트(`/me`) + WebSocket 연결 + 사이드바 프로필 = **(API)**. transcript / suggestions / sentiment = **(WS API, 컨텐츠는 Phase 0.5 fixture)**. 고객 카드(`김민수 · Kloser Inc. · CTO`) / 통화 meta / 5항목 체크리스트 / 빠른 응대 멘트 / 음소거·대기·종료 버튼 = **(demo)**. AI suggestion innerHTML은 DOMPurify로 sanitize | High (Phase 4의 가장 큰 deliverable) | Phase 4 (Step 4) | calls/transcripts 영속화 시 customer 카드는 `/customers/:id`, 통화 meta는 calls 행에서, 종료 버튼은 `/calls/:id/end` 호출. 체크리스트·빠른 멘트는 Phase 5 범위 — 본 phase에서 demo로 명시 라벨 |
| M-02 | `platform/dashboard.html` | 100% **(demo)** — 인사 / KPI 4장 / 시장 트렌드 / 추천 To-Do 6건 / 최근 통화 5건 / 팀 활동 5건 / 알림 모두 hardcode 또는 in-page array. 진짜 정보는 `new Date()` 오늘 날짜 표시뿐 | High | Phase 4 (Step 3/4) | `GET /dashboard/summary` 신설 (today_calls / response_rate / avg_duration / new_conversions / recent_calls 5건). 인사·To-Do·트렌드·팀 활동은 Phase 5/6 영역 — demo 라벨 코멘트 유지 |
| M-03 | `platform/calls.html` | 100% **(demo)** — in-page 8건 `calls` array + 필터·검색·detail panel 모두 그 array 기준. detail panel은 `dActions` / `dTranscript` 등 `innerHTML`에 array 값 직접 보간 — 현재 데이터가 hardcode라 XSS 노출 0이지만 API 전환 시 escape 필수 | High (Phase 4 핵심) | Phase 4 (Step 4) | array 제거 → `GET /calls?...`. detail panel은 `GET /calls/:id` + `/calls/:id/transcript`. URL 동기화는 Phase 2 customers.html 패턴 따름. 모든 server 값 보간은 `escapeHtml` 경유 |
| M-04 | `platform/customers.html` | 전체 **(API)** — Phase 2 완성. CRUD + 검색·필터·정렬 + URL 동기화 + KPI 4장. `escapeHtml` 헬퍼 로컬 정의 + 모든 server 값 보간에 적용 | OK | — | 없음 |
| M-05 | `platform/team.html` | 전체 **(API)** — Phase 3 완성. members / invitations / role 변경 / status 변경 / 다시 보내기 / 취소 모두 실 API. 로컬 `escapeHtml` 적용. 단, "팀 생성·수정·삭제 UI"는 미구현 (`GET /teams` 만 invite 모달 드롭다운 채우기 용도) — Phase 4+ | OK (단 팀 CRUD UI는 Phase 4+ 후순위) | — | 팀 CRUD UI 도입 시점에 별도 step |
| M-06 | `platform/newsletter.html` | 전체 **(demo)** — Phase 5/6 영역 | Low (현재 평가 흐름에 노출 적음) | Phase 5/6 | 본 phase 범위 외 |
| M-07 | `platform/daily.html` | 전체 **(demo)** — Phase 5/6 영역 | Low | Phase 5/6 | 본 phase 범위 외 |
| M-08 | `platform/settings.html` | 거의 **(demo)** — 단, "로그아웃" 행은 `api.js` 로드 + 핸들러 wire 돼 있어 (Phase 3 popover 작업에서) 실 logout 동작 | Low | Phase 4+ (per-section 단위로 점진 전환) | 본 phase 범위 외 |

### 1.4 docs/product 가이드 정합성

| # | 항목 | 현재 상태 | 위험도 | 처리 시점 | 권장 조치 |
|---|---|---|---|---|---|
| D-01 | PHASE_3_FOUNDATIONS.html — 실 캡처 vs mock 도식 구분 | 8개 figure 모두 `.shot` wrapper로 캡처임을 시각적으로 구분. mock 도식(URL strip / 배너 mock / 4단계 invite 카드 / 토큰 라이프사이클 6단계)은 흐름 설명용으로 보존. 각 캡처에 alt + caption | OK | — | 없음 |
| D-02 | `team.png` (Phase 3 시각 가이드 안) | Phase 3 와이어링 *이전* 캡처 — 사이드바에 `김민수 · Kloser Inc.` 정적 표시. caption이 그 사실을 명시하고 바로 위 `sidebar-loggedin.png`가 현재 모습을 보여줌 | Low | Phase 6+ (marketing polish) | admin@acme 시드 인증 후 team.html 재캡처해 `team.png` 교체. caption 단서 문구 삭제. 본 audit 범위에서는 미조치 |
| D-03 | `USER_GUIDE.html` Phase 3 stale 문구 | 본문 여러 곳이 Phase 3 항목을 "예정"으로 기록: 라인 239 "회원가입 UI (Phase 3, 이메일 인증과 함께)", 240 "비밀번호 재설정 / 마법 링크 (Phase 3)", 242 "조직 picker UI ... (Phase 3+ 회원가입과 함께 도입 예정)", 449 "팀 단위 권한 분기 ... Phase 3", 490 "실제 메일 발송 인프라 — Phase 3 (SMTP / SES)", 520-530 초대 모달·메일·토큰 4건 Phase 3 예정, 569 "2단계 인증 (TOTP) — Phase 3" 등. 실제로는 Phase 3에서 이미 들어왔거나 (signup/verify/forgot/reset/invite/accept), Phase 6+로 미뤘거나 (SMTP/MFA), 단순화로 진입하지 않은 (team-scope 권한) 상태. 가이드 독자가 Phase 3 결과와 가이드의 "예정" 표기를 비교하면 모순. 본 페이지 하단에는 별도 violet callout으로 Phase 3 대표 캡처 2장 + PHASE_3_FOUNDATIONS 링크는 추가돼 있음 | Medium | **Before Phase 4** (한 줄짜리 sweep) | 위 라인들을 (a) 실제로 도입된 항목은 "✓ Phase 3에서 완료" 또는 평서문으로 변경 (b) Phase 6+로 미뤄진 항목은 "Phase 6+" 명시 (c) 단순화된 항목(team-scope 권한)은 Phase 4+ 명시. mock 도식 자체는 손대지 않음 |
| D-04 | PHASE_2_FOUNDATIONS.html — Phase 4 인계 항목 | 표 내 "행 클릭 상세 패널 (통화 이력 결합) — Phase 4" 등의 promise가 Phase 4 master plan §1과 일치 | OK | — | 없음 |
| D-05 | PHASE_1_FOUNDATIONS.html — Phase 3 인계 항목 | 상단 nav + 푸터에 Phase 3 cross-link 있음. 본문 stale 표현 검출 안 됨 | OK | — | 없음 |

### 1.5 Security basics

| # | 항목 | 현재 상태 | 위험도 | 처리 시점 | 권장 조치 |
|---|---|---|---|---|---|
| S-01 | innerHTML XSS gate (AGENTS.md) | `customers.html` / `team.html`은 로컬 `escapeHtml` 정의 + server 값 보간에 적용. `live.html`은 AI suggestion innerHTML을 DOMPurify로 sanitize. `calls.html` / `dashboard.html` / `newsletter.html` / `daily.html`은 미감사 — 단 현재 데이터가 모두 in-page hardcode라 실효적 XSS 노출 0. `dashboard.html` 3건 / `calls.html` 6건 / `newsletter.html` 14건 / `daily.html` (별도 카운트 필요)이 grep으로 잡힘 | High (Phase 4에서 calls/dashboard wire 시 즉시 노출) | Phase 4 (Step 4) | calls/dashboard 와이어링 시 escapeHtml 헬퍼 도입 + 모든 server 값 보간에 적용. AGENTS.md §"innerHTML XSS gate" 룰을 review checklist로. newsletter/daily는 Phase 5/6 와이어링 시점에 같이 |
| S-02 | Token URL replaceState 적용 | `accept-invitation.html` + `reset-password.html` + `verify.html` 3 페이지 모두 진입 즉시 `history.replaceState(null,'',location.pathname)` 호출 + `<meta name="referrer" content="no-referrer">` 동봉. `customers.html`도 replaceState 호출하지만 이는 URL 필터 동기화용 (다른 use case, 토큰 누출과 무관) | OK | — | 없음 |
| S-03 | 미인증 사용자 cross-user write 차단 (`requireVerified` 미들웨어) | **서버 enforcement 미적용**. 현재는 사이드바 위 노란 띠로 안내만 — 미인증 admin이 `POST /invitations`를 호출해도 통과됨. Phase 3 Step 7 findings §155 + USER_GUIDE_PHASE_3.md §201 인계 항목 | **High** (cross-user 작업이 인증 없이도 허용됨) | Phase 4 (Step 3 — 새 미들웨어로 calls 라우트와 같이 도입) | `server/src/middleware/requireVerified.ts` 신설. `users.email_verified_at IS NOT NULL` 강제. invitation create / customer write / call mutation 등 cross-user 영향 endpoint에 적용. 익명 흐름 (verify / reset / accept-invitation 등)에는 미적용 |
| S-04 | `requireFreshRole` 적용 endpoint 매트릭스 | Phase 3 §134/§2-14 결정에 따라 (a) memberships role/status PATCH, (b) team CRUD, (c) invitation 생성·재발송·취소에 적용. password forgot/reset / invitation accept는 익명이라 제외. Phase 3 server unit test로 stale role 케이스 검증. Phase 4의 새 mutation들 (calls notes / end / soft delete)도 같은 패턴 따라야 — 누락 위험 | Medium | Phase 4 (Step 3) | 라우트 작성 시 `requireFreshRole` 적용 여부를 결정 매트릭스에 명시: calls write가 본인 통화 한정인지(employee), admin/manager 전체인지에 따라 차등 |
| S-05 | RLS FORCE + 4 정책 일관성 | 시드 schema + Phase 2 customers + Phase 3 신규 4 테이블 모두 `FORCE ROW LEVEL SECURITY` + SELECT/INSERT WITH CHECK/UPDATE/DELETE 4 정책 패턴 일관. Phase 4 신규 3 테이블 (calls / transcripts / call_action_items)도 동일 패턴 적용해야 — PHASE_4_STEP_1_SCHEMA.md §2.1~2.6에 명시됨 | OK (의도된 패턴이 plan에 박혀 있음) | Phase 4 (Step 1) | plan 그대로 따라가면 됨 |
| S-06 | `kloser_service` (BYPASSRLS) 표 범위 | 현재 SELECT/INSERT/UPDATE만 grant — DELETE 없음. anonymous 흐름(verify / reset / accept)에만 사용. Phase 4의 calls 흐름은 인증된 사용자라 service role 안 씀 → grant 추가 불필요. cleanup 도구가 app role + admin migration role로 분기되는 패턴 유지 (Phase 3 Step 7 findings §38~52) | OK | — | 없음 |

### 1.6 Email

| # | 항목 | 현재 상태 | 위험도 | 처리 시점 | 권장 조치 |
|---|---|---|---|---|---|
| E-01 | 실제 SMTP / Resend provider | 도입 안 됨 — dev outbox 테이블만 사용. 모든 메일이 `email_outbox` row로 보존되어 e2e가 SQL로 토큰 추출 가능 | OK (의도된 상태) | **Phase 6+ 유지** | Phase 4에 끌어오지 말 것. provider 어댑터 도입은 운영 진입 단계 |
| E-02 | email 발송 rate-limit | 미적용 (enumeration shield만 존재) | Low | Phase 6+ | provider 채택 시점에 같이 도입 |
| E-03 | email_outbox retention | 미적용 — row가 무기한 누적. 평가용으로 무해, 운영에선 archive/purge 필요 | Low | Phase 6+ | provider 전환 시 outbox 자체를 archive-only로 변경 또는 제거 |

---

## 2. Before Phase 4 — 반드시 처리할 것

Phase 4 schema migration (Step 1)에 손대기 전에 짧게 정리해야 demo/audit 정합성이 무너지지 않는 항목.

1. **L-04 — seed 4 user `email_verified_at = now()`**
   - 파일: `server/seeds/0001_demo.sql`
   - 영향: dev DB 시드 4행에 컬럼·값 추가
   - 효과: `admin@acme.test` 등으로 로그인 시 노란 띠 사라짐 → 사이드바/UI 스크린샷이 모두 verified 상태로 일관
   - 위험 0건: 마이그레이션 무관, 운영 데이터 무관, 다른 phase e2e 시나리오와 충돌 없음 (Phase 3 e2e는 seed pw를 손대지 않는 약속을 유지하지만 verified 상태는 별개)
   - 1-2분 작업

2. **D-03 — `USER_GUIDE.html` stale Phase 3 mention sweep**
   - 파일: `docs/product/USER_GUIDE.html`
   - 영향: 본문 8~10개 라인의 "Phase 3 예정" 표현을 "✓ Phase 3에서 완료" 또는 평서문으로, Phase 6+ 미뤄진 항목은 "Phase 6+"로, 단순화된 항목은 "Phase 4+"로 정정
   - 효과: Phase 3 결과와 가이드 문구 모순 제거
   - 본문 텍스트 외 layout/CSS/캡처는 손대지 않음
   - 10-15분 작업

**둘 다 코드 로직 변경이 아니라 데이터·문구 변경**이고, Phase 4 Step 1 schema 작업과 conflict 가능성 0이므로 안심하고 Before Phase 4 슬롯에 넣는다.

---

## 3. Phase 4 도중 흡수할 것 (참고용 정리)

> 본 audit이 발견한 항목 중 Phase 4 step plan에 이미 박혀 있거나, Phase 4 Step 3/4 작업 흐름과 자연스럽게 묶이는 것들. 별도 pre-flight 작업으로 분리하지 않는다.

- **L-03** — 미인증 배너를 나머지 6 logged-in 페이지에 wire → Step 4 frontend wiring에 1줄씩 추가
- **M-01 / M-02 / M-03** — live / dashboard / calls mock → real → Step 3/4의 핵심 deliverable
- **S-01** — innerHTML XSS gate를 calls/dashboard 와이어링 시점에 적용 → Step 4 review checklist
- **S-03** — `requireVerified` 미들웨어 도입 → Step 3 (calls route와 같이) + invitation route에도 backport
- **S-04** — `requireFreshRole` 매트릭스에 Phase 4 신규 mutation 차등 적용 결정 → Step 3 route plan에서
- **A-05** — multi-org login UX polish → Phase 4 Step 4 또는 Phase 5 별도 step

---

## 4. Phase 6+로 미루는 항목 (재확인)

- **E-01 / E-02 / E-03** — 실 SMTP/Resend, rate-limit, outbox retention
- **D-02** — `team.png` 재캡처 (marketing polish)
- 시드 seed 운영 관련 정리 (`kloser_service` DELETE grant 등)

---

## 5. 결론

> Phase 4 schema migration 들어가기 전에 **2건 (seed verified-at + USER_GUIDE.html stale 문구 sweep)** 만 별도로 처리하면 demo·문서 정합성이 깨끗하다. 나머지 audit 항목은 모두 Phase 4 step plan 내부에 자연스럽게 흡수되거나 Phase 5/6+로 의도적으로 미뤄진 상태이며, Phase 4 진입 자체를 차단하는 Blocker는 없다.

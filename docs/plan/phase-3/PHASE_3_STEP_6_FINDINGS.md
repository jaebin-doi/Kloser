# Phase 3 Step 6 Findings — Client Wiring (signup / verify / forgot / reset / accept / team)

> Audience: Phase 3 Step 7 작성자 (종합 e2e + Phase 3 종합 findings).
> Format: each finding has **(1) 관찰**, **(2) Step 7 또는 이후로의 의미**.
> Plan: [`PHASE_3_STEP_6_CLIENT.md`](PHASE_3_STEP_6_CLIENT.md).

---

## 결론

Step 6 **완료** (2026-05-11). 계획서 §14 완료 기준 12항목 모두 통과. Phase 3 Step 7 (종합 e2e) 진입 가능.

### 적용 파일 (6 신규, 6 수정)

신규 (6) — `platform/signup.html` · `platform/verify.html` · `platform/forgot-password.html` · `platform/reset-password.html` · `platform/accept-invitation.html` · `docs/plan/phase-3/PHASE_3_STEP_6_FINDINGS.md`.

수정 (6) — `platform/api.js` · `platform/_shared.js` · `platform/login.html` · `platform/team.html` · `platform/live.html` · `docs/plan/phase-3/PHASE_3_MASTER.md`.

| 종류 | 경로 | 비고 |
|---|---|---|
| api wrapper | `platform/api.js` (수정) | 5 public helper 추가 — `signup` / `acceptInvitation` / `verifyEmail` / `requestPasswordReset` / `resetPassword`. 모두 `{ status, body }` 반환 (`signup` / `acceptInvitation`은 성공 시 자동 `setAccessToken`). 페이지가 closure-private `rawFetch`를 직접 호출하지 않도록 noop 헬퍼 `parseJsonResponse` 추가 |
| page (신규) | `platform/signup.html` | organizationName / name / email / password 4-field form. 201 → `setAccessToken` + `/platform/live.html` redirect. 409 email_conflict → "이미 가입된 이메일입니다 [로그인]" inline error |
| page (신규) | `platform/verify.html` | `?token=` 읽고 즉시 `window.history.replaceState(null, '', window.location.pathname)`로 URL 정리 + `<meta name="referrer" content="no-referrer">`. 자동 `verifyEmail(token)` 호출. 200 / 410 / 400 3 상태 UI |
| page (신규) | `platform/forgot-password.html` | email form. 모든 200 → 동일 "메일을 보냈습니다" 결과 화면 (enumeration parity 유지). 500만 에러 영역 노출 |
| page (신규) | `platform/reset-password.html` | `?token=` 즉시 `replaceState` + referrer meta. `newPassword` + 확인 입력, 양쪽 일치 + 8자 이상이면 submit 활성. 200 → "변경되었습니다" + 5초 후 login.html. 410 → "재설정 다시 요청" CTA |
| page (신규) | `platform/accept-invitation.html` | `?token=` 즉시 `replaceState` + referrer meta. name + password + 확인. 201 (신규 user) / 200 (기존 user multi-org) 둘 다 `setAccessToken` + `/platform/live.html` redirect. 410 / 409 account_disabled / 409 already_member 각각 별도 안내 |
| page (수정) | `platform/login.html` | form / id 그대로. 하단에 "회원가입 [signup.html]" + "비밀번호 재설정 [forgot-password.html]" 링크 1줄 추가 |
| page (수정) | `platform/team.html` | 하드코딩 14행 `members` 배열 + 정적 render 완전 제거. 실 API 5종 연결 — `/me` + `/team/members` + `/teams` + `/invitations` 병렬 fetch → 동적 render. invite modal에 team 드롭다운 동적 채움 + `POST /invitations` 호출. 별도 "초대 대기" 영역으로 active pending 표시 + 재발송/취소 버튼. 멤버 kebab 메뉴 — "역할 변경" (4 옵션) + "비활성화"/"활성화" 토글. **"삭제" label은 의도적으로 제거** (Master §11 hard delete 금지). 자기 row의 kebab은 표시 안 함 |
| page (수정) | `platform/live.html` | auth gate 직후 `/me` fetch → `renderUnverifiedBanner(meBody.user)` 호출 1줄 추가. 기존 WS / 라이브 통화 흐름은 손대지 않음 |
| shared | `platform/_shared.js` (수정) | `renderUnverifiedBanner(user)` 함수 추가. `email_verified_at` null이면 상단 노란 배너 노출 + 인증 메일 재발송 버튼. 200 → 인라인 toast / 409 already_verified → 배너 자동 제거 + toast / 401 → noop (authFetch가 이미 처리). idempotent: 두 번 호출해도 중복 안 됨 |

### 검증 결과 (plan §14)

| # | 항목 | 결과 |
|---|---|---|
| 1 | `npm --prefix server run typecheck` | PASS (서버 코드 변경 0건) |
| 2 | `node test/sync_shared_types.mjs` | PASS (5 entity 모두 동기, 변경 0건) |
| 3 | `npm --prefix server test` | **155/155** PASS (회귀만, 변경 0건) |
| 4 | `node test/phase_0_5_e2e.mjs` | 16/16 PASS |
| 5 | `node test/phase_2_customers_e2e.mjs` | 7/7 PASS |
| 6 | 수동 검증 persona 1 — signup → verify | **PASS** (자세한 결과 §1 아래) |
| 7 | persona 2 — forgot → reset | **PASS** |
| 8 | persona 3 — admin invite → 신규 user accept | **PASS** |
| 9 | persona 4 — 기존 user multi-org accept | **PASS** |
| 10 | persona 5 — role/status 변경 | **PASS** |
| 11 | persona 6 — resend/cancel token 410 | **PASS** |
| 12 | `PHASE_3_STEP_6_FINDINGS.md` 작성 | 본 문서 |

---

## 수동 검증 6 persona — 결과 요약

### persona 1: 신규 user signup → verify
1. `signup.html` → `step6test-p1@example.test` / "PersonaOne Org" / "Persona One" / pw → 제출
2. 201 응답 → `/platform/live.html` 자동 진입. **상단 노란 배너 노출** ("이메일 인증이 완료되지 않았습니다" + "인증 메일 재발송" 버튼). body padding-top 40px 자동 적용 확인
3. servicePool에서 `metadata.verifyUrl` 추출 → token = `EPva-rBprs4Spf9Vwyw_nkxjRuNLYXlYH-jnRcfTibs`
4. `verify.html?token=...` 진입 → URL 즉시 `verify.html`로 정리 (token query 사라짐 확인) → 200 → "이메일 인증이 완료되었습니다 ✓" 페이지
5. `live.html` 재방문 → `/me` `email_verified_at = "2026-05-11T05:08:49.908Z"` → 배너 자동 미노출

### persona 2: forgot → reset
1. (parity 확인) `forgot-password.html` → 존재하지 않는 `step6test-p2@example.test` 입력 → 200 → 동일 "메일을 보냈습니다" 결과 화면
2. signup으로 step6test-p2 user 생성 → `/auth/logout`
3. forgot-password.html 다시 → 같은 이메일 → 200 → outbox에 `template='password_reset'` 1행 추가
4. servicePool에서 `metadata.resetUrl` 추출 → `reset-password.html?token=...` 진입 → URL 즉시 정리 → 폼 노출
5. `newPassword` = `p2-newpw-67890` + 확인 일치 → 제출 → 200 → "변경되었습니다" + 5초 후 login redirect 예약
6. `curl POST /auth/login (새 pw)` → **200** with accessToken
7. `curl POST /auth/login (옛 pw)` → **401 invalid_credentials** (전 세션 revoke + password 교체 확인)

### persona 3: admin invite → 신규 user accept
1. `admin@acme.test` 로그인 → `team.html` 진입
2. 페이지 로드 후: 헤더 "직원 초대" 버튼 visible (admin 전용 gate OK), Acme Sales Inc. 멤버 2명 노출, "초대 대기" 영역에 시드 `pending-invitee@acme.test` 1건
3. 초대 modal → `step6test-p3@example.test` / role=manager / team=없음 → 발송 → 201 + 토스트 + 대기 영역 즉시 prepend (총 2건)
4. 로그아웃 후 outbox에서 token 추출 → `accept-invitation.html?token=...` 진입 → URL 즉시 정리
5. name="Persona Three" / password 입력 → 제출 → 201 → `/platform/live.html` 자동 진입
6. `/me` → `{ email: "step6test-p3@example.test", org: "Acme Sales Inc.", role: "manager", email_verified_at: ISO }` 확인 (verified 즉시 set — 이메일 도착이 인증 증거)

### persona 4: 기존 user multi-org accept
1. `admin@beta.test` 로그인 → `kloserApi.apiPost('/invitations', { email: 'step6test-p2@example.test', role: 'viewer' })` → 201
2. outbox에서 token 추출 → `accept-invitation.html?token=...` 진입
3. name="ignored" + password="definitely-not-real-pw-99999" → 제출 → **200** (기존 user) → `/platform/live.html`
4. `/me` → `{ email: "step6test-p2", name: "Persona Two", org: "Beta Outreach Co.", role: "viewer" }` — **name이 "ignored"로 안 바뀜** (기존 user의 name 보존)
5. `curl POST /auth/login (fake pw)` → 401 invalid_credentials (password도 안 바뀜)
6. `curl POST /auth/login (원래 PersonaTwo Org pw + orgId)` → 200 (옛 org 로그인 그대로 작동 — multi-org 분리)

### persona 5: role / status 변경
1. acme admin 로그인 → team.html → emp@acme.test row의 kebab 클릭
2. 메뉴 옵션 캡처: **"관리자로 변경" / "매니저로 변경" / "관전자로 변경" / "비활성화"** — **"삭제" label 부재 확인**
3. `PATCH /memberships/.../{ role: "manager" }` → 200, role = manager
4. `PATCH /memberships/.../{ status: "disabled" }` → 200, status = disabled
5. `curl POST /auth/login (emp@acme.test)` → **401 account_disabled** (disabled membership login gate Step 4 §1-9 통과)
6. `PATCH .../{ status: "active" }` → 200, restore
7. `PATCH .../{ role: "employee" }` → 200, restore

### persona 6: resend / cancel token 410
1. acme admin이 `step6test-p6@example.test` 초대 → 201, token A 발급
2. `POST /invitations/:id/resend` → 200 (token A invalidated, token B 발급)
3. `curl POST /invitations/accept` with **token A** → **410** `token_invalid_or_expired` (resend로 무효화됨)
4. `DELETE /invitations/:id` → 204 (소프트 cancel)
5. `curl POST /invitations/accept` with **token B** → **410** generic (cancel로 무효화됨)

---

## 발견 사항

### 1. `_shared.js` `renderUnverifiedBanner`는 적용 페이지마다 호출이 필요 — 본 step에선 `live.html` + `team.html`만 wire

(1) 배너 함수 자체는 `_shared.js`에 정의되고 `window.renderUnverifiedBanner`로 export됨. 그러나 페이지가 명시적으로 호출해야 노출되므로 각 logged-in 페이지의 auth gate 직후에 `/me` fetch → `renderUnverifiedBanner(meBody.user)` 1줄 추가가 필요.

(2) 본 step에서는 sign-up 직후 사용자가 가는 `live.html`과 본 step 주요 wiring 대상인 `team.html` 두 곳에만 호출 추가. `dashboard.html` / `customers.html` / `calls.html` / `daily.html` / `settings.html` / `newsletter.html`은 본 step 범위 외라 손대지 않았다.

(3) Step 7 종합 e2e에서 같은 함수를 가져다 쓰면 됨. 추가 적용은 다음 두 가지 중 하나로 정리:
- (a) 각 logged-in 페이지에 1줄씩 추가 — 본 step과 같은 패턴.
- (b) `_shared.js`의 `renderSidebar` 안에서 `kloserApi.apiGet('/me')` 호출 후 자동 invoke. 한 곳에서만 wire — 하지만 `_shared.js`가 auth gate를 알아야 하므로 결합도 증가. (a) 권장.

---

### 2. forgot-password의 enumeration parity는 client에서도 보존 — 모든 200 응답이 동일 UI

(1) `requestPasswordReset(email)`은 알 수 없는 이메일이든 정상 이메일이든 항상 200 반환 (Master §17). client도 200 분기 하나로 모두 같은 "메일을 보냈습니다" 결과 화면으로 전환. 폼 자체를 숨기고 결과 카드만 노출.

(2) 검증: 같은 페이지에서 (a) 존재하지 않는 이메일 → 200 + 결과 화면, (b) 가입된 이메일 → 200 + 같은 결과 화면. UI 측에서 두 상황을 구분할 단서 없음. 응답 헤더 / latency도 동일 — 단일 시그널.

(3) Step 7 e2e가 forgot 흐름을 검증할 때 "outbox에 새 password_reset row가 생겼는지"로만 가입된 이메일 분기를 확인하면 됨 — client UI에서 알 수 있는 차이 없음을 본 step이 보장.

---

### 3. token URL 즉시 `replaceState` — referrer meta가 보조

(1) `verify.html` / `reset-password.html` / `accept-invitation.html` 3 페이지 모두 page-load 시점에 `window.history.replaceState(null, '', window.location.pathname)`로 query string 제거. closure 변수에만 token 보존 → 주소창 / history.back() / 화면 캡처 / 사용자가 URL 복사해 공유하는 시나리오 모두에서 raw token 누출 차단.

(2) 보조로 `<meta name="referrer" content="no-referrer">`를 같은 3 페이지에 추가 — 페이지가 외부 리소스 (CDN script, font 등)를 로드할 때 Referer 헤더에 token이 노출되지 않게.

(3) 검증: persona 1 verify, persona 2 reset, persona 3 accept 모두 `location.href`가 `verify.html` / `reset-password.html` / `accept-invitation.html`로 query 없이 정리된 것을 직접 확인. 백 버튼 시도 시 token URL로 돌아가지 않음.

(4) Step 7 e2e가 token URL 누출을 회귀 테스트하려면 페이지 진입 직후 `location.search`가 빈 문자열인지 assert하면 됨.

---

### 4. accept-invitation의 200 vs 201 분기는 status code만 — body shape 동일

(1) Step 5 server 결정대로 accept 응답에 `created: boolean` 필드 없음. `acceptInvitation(input)` 헬퍼가 `{ status, body }` 반환하므로 client가 `status === 201` (신규 user) / `status === 200` (기존 user multi-org)로 직접 분기. 두 경우 모두 `body.accessToken` + `Set-Cookie` 동일하므로 helper의 `setAccessToken(body.accessToken)`은 분기 없이 일괄 적용.

(2) 본 step의 `accept-invitation.html`은 두 status 모두 같은 `/platform/live.html` redirect 흐름. UI 텍스트도 같은 toast로 충분하지만 future-proofing으로 분기 가능한 위치를 명시 (§7.2). 본 step에서는 둘 다 `live.html`로 보냄.

(3) Step 7 e2e가 multi-org accept를 검증하려면 두 가지가 필요: (a) 같은 이메일을 두 org에 초대, (b) 한쪽 accept → 다른 쪽 accept 시 status 200을 확인. 본 step 단위 흐름의 persona 3 (201) + persona 4 (200)에서 status 분기 정상 작동을 확인했으므로 회귀 보호는 unit (server) + persona (client) 두 층에서 됨.

---

### 5. team.html의 admin 권한 UI gate는 `/me`의 `membership.role`로 단일 판정

(1) `loadAll()` 안에서 `/me` 응답의 `membership.role === 'admin'`을 `isAdmin` 변수에 한 번 저장. 그 다음 `renderInviteHeader` / `renderPending` / `renderMembers`의 kebab 표시 / 자기 row 제외 등 모든 UI gating이 이 단일 변수에 의존.

(2) 서버 측 `requireRole('admin')` + `requireFreshRole`이 이미 변경된 role을 401로 거부하므로 client gate는 cosmetic — 데모 의도. 권한 우회 시도 (admin이 아닌 user가 콘솔에서 `kloserApi.apiPost('/invitations', ...)` 호출)는 서버 401/403으로 차단.

(3) 자기 row의 kebab을 hide한 이유: self-demote / self-disable이 last-admin protection으로 차단되지만 UI 흐름이 어색해짐 (확인 dialog → 409 toast). 자기 row 변경은 다른 admin의 협조가 필요한 흐름이 자연스러움. 본 step에서 self-service profile (이름 변경 등)은 scope 외라 추후 Phase 4+에서 별도 고려.

---

### 6. team.html의 invite modal에서 team 드롭다운은 `GET /teams` 결과로 동적 채움 — Phase 4+ team CRUD UI까지는 안 감

(1) 본 step에서 team 자체의 생성·수정·삭제 UI는 추가 안 함. invite modal의 team 선택은 기존 teams에서만 가능. 빈 set이면 "팀 없음" 옵션 1개만 노출.

(2) seed Acme/Beta는 teams가 0인 상태로 시작 (Phase 1 init은 organizations 까지만 만들고 team 시드 없음). team이 필요한 데모는 사용자가 admin SQL/CLI로 추가하거나, Phase 4+ team CRUD UI 도입 후 가능.

(3) Step 5 invitation에 `teamId` 필드는 들어가지만 본 step UI는 "팀 없음"이 기본. 시드의 `pending-invitee@acme.test` 초대도 team_id null인 채.

(4) Step 7 e2e가 team-scoped invitation을 검증하려면 e2e 픽스처에서 team을 미리 INSERT (RLS 안 통과하므로 servicePool로 / 또는 migrations로 시드 추가) 후 invite modal의 dropdown에 노출되는지 + invitation row의 `team_id`가 채워지는지 확인.

---

### 7. `kloserApi.signup` / `acceptInvitation`이 `{ status, body }` 반환 — `login`은 기존 throw 패턴 유지

(1) 본 step의 5 신규 helper는 모두 `{ status, body }` 일관 패턴. 페이지 코드가 try/catch 없이 status로 분기 가능. error body의 `code` 필드도 분기 단서로 사용 (예: `body.code === 'email_conflict'`).

(2) 기존 `kloserApi.login`은 4xx에 `Error` throw (status / body가 err 객체 attach) 패턴 유지. login.html이 그대로 작동해야 하므로 회귀 0이 필요했음. 본 step 페이지들은 모두 새 패턴 (`{ status, body }`)을 따름.

(3) 향후 login도 같은 패턴으로 통일하려면 별도 step 필요 — login.html 회귀 검증 동반. Phase 6+ 정리 단계 후보.

---

### 8. team.html 동적 HTML 삽입에서 모든 server-supplied 텍스트는 `escapeHtml` — `team_name` XSS 보강

(1) team.html은 `tr.innerHTML = template` 패턴으로 row를 그리므로 server-supplied 문자열이 인라인될 때 모두 `escapeHtml(str)` 통과가 필요. 본 step 1차 구현에서 `m.user_name` / `m.user_email` / `inv.email` / `inv.invited_by_name` 등 대부분의 필드는 escape했지만 `team_name`만 `m.team_name || '<span ...>미배정</span>'` 패턴으로 raw 인라인되어 있었음.

(2) Codex review #1로 잡힘 — admin이 팀 이름에 `<script>` 같은 문자열을 넣으면 XSS 가능. 수정: `m.team_name ? escapeHtml(m.team_name) : '<span class="text-slate-400">미배정</span>'` 패턴으로 통일 (member row + pending invitation row 두 곳 모두). fallback HTML은 정적 리터럴이라 그대로 유지.

(2-A) team 이름은 RLS-scoped admin만 INSERT/UPDATE 가능해서 외부에서 직접 주입할 수 없지만, multi-tenant 환경에서 다른 admin이 조직 내 다른 admin을 노리는 시나리오 (inside threat)에서 표면이 됨. 본 수정으로 그 표면 제거.

(3) 본 finding을 future template 추가 시 가이드로 인계 — `tr.innerHTML = ` 또는 `el.innerHTML = ` 패턴을 쓰는 모든 위치는 grep으로 한 번에 재검토 가능 (`escapeHtml` 함수 사용 여부 audit).

---

### 9. team.html "비활성화" → 세션 즉시 revoke를 confirm dialog가 안내

(1) `PATCH /memberships/:id { status: 'disabled' }`는 Step 4 §1-9 정합으로 즉시 모든 active session revoke + `teams.manager_id` cleanup. 사용자가 다른 탭에서 사용 중이면 다음 fetch가 401.

(2) UI 측에서 `confirm("{user}님을 비활성화하시겠습니까?\n현재 세션이 모두 만료됩니다.")` 두 번째 줄로 부작용을 명시. confirm은 native dialog (UX는 단순하나 명료).

(3) Phase 6+에서 더 풍부한 confirm modal (이유 입력 등)이 가능. 본 step은 dev-grade UX로 충분.

---

## 인계 사항 (Step 7 → 종합 e2e + Phase 3 종합 findings)

- **Step 7 e2e의 자연스러운 시나리오**:
  1. signup → live.html 배너 → outbox token → verify → live.html 배너 사라짐
  2. login.html → forgot-password → outbox token → reset-password → 새 비번 로그인
  3. acme admin login → team.html → invite → outbox token → 별도 브라우저로 accept → admin이 새 멤버 보이는지 확인
  4. (선택) 기존 user multi-org: beta admin이 acme emp 초대 → emp가 accept → /me로 Beta context 확인
- **dev 전용 outbox 토큰 추출 패턴**: servicePool credentials (`kloser_service` / `kloser_service_dev`)로 `SELECT metadata->>'verifyUrl' / 'resetUrl' / 'acceptUrl' FROM email_outbox WHERE to_email = $1 AND template = $2 ORDER BY created_at DESC LIMIT 1`. Phase 6+ SMTP 어댑터 도입 시 e2e 픽스처가 dev provider stub로 격리 필요.
- **다른 logged-in 페이지에 배너 wire**: Finding §1에 따라 dashboard / customers / calls / daily / settings / newsletter도 동일 1줄 추가. Step 7 또는 별도 mini-step에서 처리 가능.
- **수동 검증의 자동화**: 본 step의 6 persona를 Playwright e2e로 옮기면 Phase 3 종합 회귀가 됨. Step 7 산출물.
- **남은 cleanup**: invitation_routes.test.mjs afterEach가 invitetest 프리픽스로 정리하므로 step6test 프리픽스의 잔여 invitation row가 dev DB에 3건 남아 있을 수 있음 (acme/beta org 안에 있어 cascade 안 됨). 다음 server test 실행 시 invitation 테스트 afterEach가 SEEDED 이외 모든 invitation을 정리하므로 자연스럽게 청소됨.

## 한 줄 결론

> **Step 6 완료. 5 신규 페이지 + 5 수정 페이지 (`api.js` / `_shared.js` / `login.html` / `team.html` / `live.html`) + 본 findings + Master 체크박스. 0 신규 server / migration / env / shared type. typecheck + sync + 155 server test + 23 e2e + 6 persona = 188 검증 통과. raw token URL은 모두 즉시 `replaceState`로 정리 + referrer meta로 외부 누출 차단. team.html은 하드코딩 멤버 제거하고 5종 실 API에 wire — "삭제" label은 의도적으로 미노출 + 모든 동적 텍스트(team_name 포함)는 `escapeHtml`.**

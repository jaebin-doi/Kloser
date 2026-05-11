# Phase 3 Step 6 — Client Wiring (signup / verify / forgot / reset / accept / team)

> **상위 계획**: `docs/plan/phase-3/PHASE_3_MASTER.md` §3 Step 6.
> **선행**: Step 5 완료 — `PHASE_3_STEP_5_FINDINGS.md`. 5 endpoint (`POST /auth/signup`, `POST /auth/verify`, `POST /auth/password/forgot`, `POST /auth/password/reset`, `POST /invitations/accept`) + 4 admin endpoint (`GET /team/members`, `GET/POST/DELETE /invitations`, `POST /invitations/:id/resend`) + 4 team / membership endpoint이 모두 서버에 깔린 상태.
> **기간**: 1.5일.

---

## 진행 상태

- [ ] 1. lock-ins 사전 결정 (본 plan §1)
- [ ] 2. `platform/api.js` (수정) — 5 public helper 추가 (`signup` / `acceptInvitation` / `verifyEmail` / `requestPasswordReset` / `resetPassword`), 모두 `{ status, body }` 반환. closure-private `rawFetch` 직접 호출 금지 — page들은 이 helper만 사용
- [ ] 3. `platform/signup.html` (신규) — 회원가입 form + 동작
- [ ] 4. `platform/verify.html` (신규) — `?token=`만 읽어 자동 verify + 결과 페이지
- [ ] 5. `platform/forgot-password.html` (신규) — email form + "메일을 보냈습니다" 결과 (enumeration parity 유지)
- [ ] 6. `platform/reset-password.html` (신규) — token + newPassword form + 결과
- [ ] 7. `platform/accept-invitation.html` (신규) — token + name + password form + AuthResult 처리 → live.html 진입
- [ ] 8. `platform/login.html` (수정) — 회원가입 / forgot 링크 추가
- [ ] 9. `platform/team.html` (수정) — 하드코딩 members 제거 + 5가지 실 API 연결 (members / teams / invitations CRUD + resend/cancel + role/status 변경)
- [ ] 10. `platform/_shared.js` 또는 inline (수정) — 미인증 user 배너 (`email_verified_at IS NULL` 시 `/me` 응답으로 감지 + verify resend 버튼)
- [ ] 11. 수동 검증 (§10) — 6 흐름 전부 직접 사용
- [ ] 12. `node test/phase_0_5_e2e.mjs` 16/16 회귀 PASS
- [ ] 13. `node test/phase_2_customers_e2e.mjs` 7/7 회귀 PASS
- [ ] 14. `PHASE_3_STEP_6_FINDINGS.md` 작성

---

## 0. 목적

Master §1 산출물 5 "직원 가입·로그인·비번 재설정·초대 수락 UI 완성"의 client 코드. 본 step이 끝나면:

- 새 user가 `platform/signup.html`에서 organization+계정 생성 → 자동 로그인 + 이메일 인증 메일 수신
- `platform/verify.html?token=...` 링크 클릭 → `email_verified_at` set + 결과 페이지
- `platform/forgot-password.html` → email 입력 → 항상 동일 응답 (enumeration parity)
- `platform/reset-password.html?token=...` → 새 비번 입력 → 모든 세션 revoke + 로그인 페이지로
- `platform/accept-invitation.html?token=...` → name+password → AuthResult로 즉시 로그인 → live.html
- `platform/team.html`에서 실 멤버 목록 + 초대/재발송/취소 + 권한·상태 변경 모두 실 API
- 미인증 user는 자기 데이터는 보지만, 상단 배너로 "인증 메일 재발송" 안내

**서버 코드 0 라인 추가**. 모든 endpoint는 Step 2~5에서 이미 끝났다.

---

## 1. 사전 결정 lock-ins

| 항목 | 결정 | 근거 |
|---|---|---|
| 1. 5 신규 페이지 파일명 | `signup.html` / `verify.html` / `forgot-password.html` / `reset-password.html` / `accept-invitation.html` (모두 `platform/` 하위) | Step 2~5의 `buildVerifyUrl` / `buildResetUrl` / `buildAcceptInvitationUrl`이 이미 이 경로를 outbox에 박는다 — 파일명 변경은 서버 변경을 동반하므로 그대로 둠 |
| 2. 5 페이지의 auth gate 동작 | **anonymous로 진입**. `kloserApi.refreshAccessToken()` 자동 호출 안 함, 401에 redirect 안 함. 자체 form만 가지는 정적 페이지 + 자체 fetch 1개 | 이 페이지들은 "로그인 안 된 사용자가 들어오는" 자연 경로 — login redirect로 튕기면 무한 루프 |
| 3. `platform/team.html`은 기존 auth gate 패턴 그대로 | `kloserApi.refreshAccessToken()` 호출 → 실패 시 `loginRedirect()`. 이후 `apiGet` 등으로 진입 | Phase 2 `customers.html`과 동일 |
| 4. signup 응답 처리 | 201 → access token + Set-Cookie refresh 받음 → `kloserApi.setAccessToken` 호출 → live.html로 redirect. 응답 shape은 login과 동일 (`accessToken` + `user` + `organization` + `membership`) | Step 2 signup이 login과 동일 shape 반환 |
| 4-A. signup 409 `email_conflict` | "이미 가입된 이메일입니다. 로그인을 시도하세요." + login 페이지 link | Master §16 enumeration trade-off — signup에서 이메일 중복은 노출됨 (signup 흐름 상 불가피) |
| 5. verify 응답 처리 | 200 → "이메일 인증이 완료되었습니다" 페이지 + login.html / live.html 진입 버튼. 410 `token_invalid_or_expired` → "이 링크는 만료되었거나 이미 사용되었습니다. 로그인 후 [이메일 인증 재발송]을 눌러 새 메일을 요청하세요." | 4 fail 코드 collapse — 사용자에게 구체 사유 노출 안 함 |
| 6. forgot 응답 처리 | 200 (항상) → 동일 "메시지를 받으셨다면 이메일을 확인해주세요" 결과. 알 수 없는 이메일이든 정상 이메일이든 같은 UX | Master §17 enumeration 방지 — 서버 응답이 항상 200이므로 client도 그에 맞춰야 enumeration parity 유지 |
| 7. reset 응답 처리 | 200 → "비밀번호가 변경되었습니다. 새 비밀번호로 로그인해주세요." + login 페이지로 redirect. 410 → verify와 동일 안내 (다시 forgot 요청 유도) | Step 3 reset 후 모든 세션 revoke된다는 사실을 안내 |
| 8. accept 응답 처리 | 201 (신규 user) 또는 200 (기존 user, multi-org) 둘 다 `AuthResult` shape → `setAccessToken` + 쿠키 자동 → live.html. **`created` 필드는 응답에 없음 — status code만으로 구분.** UI 측: 201이면 "환영합니다", 200이면 "{org} 팀에 참여했습니다" | Step 5 acceptInvitation 응답 상수 |
| 8-A. accept 409 `account_disabled` | "비활성화된 계정입니다. 관리자에게 문의하세요." 안내. 재시도 버튼 노출 안 함 | 토큰은 unburned지만 사용자 행동으로 풀 수 없음 |
| 8-B. accept 409 `already_member` | "이미 {organization} 멤버입니다. 로그인을 시도하세요." + login.html 링크 | 토큰은 unburned지만 정상 흐름은 로그인 |
| 8-C. accept 410 | verify/reset과 동일 안내 — "초대 링크가 만료/취소됐습니다. 초대자에게 새 메일 요청하세요." | 4 token 코드 collapse |
| 9. open-redirect 가드 | signup/accept 후 redirect target은 항상 `/platform/live.html` 고정 (returnUrl 안 받음). login.html은 기존 `getReturnUrl()`로 같은 origin path-only allow-list 유지 | signup/accept은 새 user 진입점이라 redirect 외부 노출 불필요. login은 protected 페이지 재진입 위해 returnUrl 필요 |
| 10. error mapping 정책 | 본 plan §11 표가 단일 source of truth. 각 페이지의 `mapError(code, status)` 헬퍼가 해당 표를 inline으로 들고 있음 (페이지별 독립, 공용 모듈 안 만듦 — 페이지마다 다른 코드 set이라 공용화의 ROI가 낮음) | 페이지 5개 + team.html 1개 모두 같은 패턴 |
| 11. team.html 멤버 표 재구성 | 하드코딩 14행 → `GET /team/members` 결과 동적 렌더. 행마다 kebab 메뉴 → "역할 변경" submenu (admin / manager / employee / viewer) + status가 active면 "비활성화" / disabled면 "활성화". **"삭제" label은 절대 노출하지 않음** — Master §11 hard delete 금지 + 서버에 membership DELETE endpoint 자체가 없음 | Master §11 + Step 4 §1-9 — status disable이 영구 보관 정책의 표현이므로 UI도 "삭제"라는 단어 자체를 쓰지 않음 |
| 12. team.html "초대 대기" 영역 | 별도 영역 (멤버 표 위 또는 아래)로 분리. `GET /invitations` 결과 렌더. 행마다 "재발송" / "취소" 버튼 | 멤버 표와 같은 표에 섞으면 status='pending' 합성 모델이 필요 — 분리가 더 단순 |
| 13. team.html 초대 modal | 기존 modal 재사용. teamId 드롭다운은 `GET /teams` 결과로 채움. 제출 시 `POST /invitations`. 응답 201이면 modal close + "초대 대기" 영역에 prepend | 기존 UI 손상 최소화 |
| 14. team.html 권한 매트릭스 (UI) | admin이 아니면 "초대" 버튼 / kebab 메뉴 / "재발송·취소" 버튼 hidden. employee/viewer는 멤버 목록 read만 | Master §13 + Phase 2 customers.html과 일관 |
| 15. team.html 팀(team) 관리 UI | Step 6에서는 `GET /teams` 만 사용 (초대 modal의 teamId 드롭다운용). 팀 CRUD UI (생성·수정·삭제)는 Phase 4+로 연기 — 본 step의 surface가 이미 6개라 추가 안 함 | scope 좁힘 — Step 6 risk 줄이기 |
| 16. team.html role 변경 흐름 | kebab → "역할 변경" → 4 옵션 (admin/manager/employee/viewer). 선택 시 `PATCH /memberships/:id { role }`. 응답 409 `last_admin_protected` → toast "마지막 admin은 demote할 수 없습니다." | Step 4 last-admin protection wire 그대로 사용 |
| 17. team.html status 변경 흐름 | kebab → "비활성화" / "활성화" 토글. `PATCH /memberships/:id { status }`. disable 시 confirm dialog ("세션이 모두 만료됩니다"). 응답 409 → 같은 안내 | Step 4 §1-9 |
| 18. team.html 자기 자신 mutation | 자기 row의 kebab은 표시하되 "역할 변경" / "비활성화" 옵션은 disabled — UI 자체 차단. 서버는 last-admin 보호로 받아주지만 UX는 자기 self-disable / self-demote를 막는 게 안전 | UX. Phase 4+에서 self-service 흐름 (e.g. profile delete) 별도 검토 |
| 19. 미인증 user 배너 | logged-in 페이지 (live / customers / team / 기타) 상단에 `email_verified_at IS NULL`이면 노란 띠 + "인증 메일 재발송" 버튼. 버튼 클릭 시 `POST /auth/verify/resend`. 응답 200 → toast "메일을 다시 보냈습니다." 응답 409 → 배너 자체 숨김 (인증 완료된 상태) | Master §305 plan: "verified 미달 user cross-user write 차단"의 시각화. 본 step에서는 cross-user 차단까지는 가지 않고 안내만. 차단은 Phase 4+ 별도 |
| 20. 배너 통합 지점 | `platform/_shared.js`에 `renderUnverifiedBanner(user)` 함수 추가 → 각 페이지 `auth gate` 직후 호출. 페이지마다 별도 DOM 슬롯 불필요 — body 상단에 fixed inject | code dup 회피 + 새 페이지가 추가돼도 자동 적용 |
| 21. 단위 테스트 추가 여부 | **본 step에서는 client 단위 테스트 추가 안 함**. 수동 검증 6 흐름 + Phase 0.5 / Phase 2 e2e 회귀로 충분. Phase 3 종합 e2e (signup → invite → accept → team)는 Step 7에서 별도 e2e 스크립트 작성 | scope 좁힘. 본 step의 결합력은 e2e가 가장 잘 보호 |
| 22. shared types | Step 2~5에서 등록한 `SignupInput` / `VerifyEmailInput` / `ForgotPasswordInput` / `ResetPasswordInput` / `InvitationCreateInput` / `InvitationAcceptInput` 그대로 사용. zod runtime 검증은 서버가 하므로 client는 JSDoc 인텔리센스 정도 | Step 2~5 §8들 정합 |
| 23. 신규 server 코드 / migration / env | **0건**. 본 step은 순수 client wiring | scope |

---

## 2. `platform/api.js` 헬퍼 추가

`rawFetch`는 closure-private이고 `window.kloserApi`에 export되지 않는다 (`platform/api.js:104`). 신규 페이지가 직접 호출할 수 없으므로 **public helper 5개를 모두 명시적으로 노출**한다. 다음 5개를 `window.kloserApi`에 추가:

### 2.1 `kloserApi.signup(input) → { status, body }`

```js
async function signup(input) {
  const res = await rawFetch('/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input || {}),
  });
  const text = await res.text();
  let body = null;
  if (text.length > 0) {
    try { body = JSON.parse(text); } catch (_) { /* leave null */ }
  }
  if (res.ok && body && typeof body.accessToken === 'string') {
    setAccessToken(body.accessToken);
  }
  return { status: res.status, body };
}
```

성공 시 자동으로 `setAccessToken`. 호출자는 `status === 201` + `body.user` 등을 확인. 실패 (4xx/5xx)도 `{ status, body }` 형태로 반환 (login 패턴과 비슷하나 throw 대신 `status` 노출 — 페이지에서 분기 처리하기 쉽도록).

### 2.2 `kloserApi.acceptInvitation(input) → { status, body }`

```js
async function acceptInvitation(input) {
  const res = await rawFetch('/invitations/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input || {}),
  });
  const text = await res.text();
  let body = null;
  if (text.length > 0) {
    try { body = JSON.parse(text); } catch (_) { /* leave null */ }
  }
  if (res.ok && body && typeof body.accessToken === 'string') {
    setAccessToken(body.accessToken);
  }
  return { status: res.status, body };
}
```

**`{ status, body }` 형태가 핵심** — accept 응답이 201 (신규 user) / 200 (기존 user multi-org) 둘 다 OK 분기인데, 그 구분이 status code에만 있고 body shape에는 `created` 같은 필드가 없다 (Step 5 결정). 호출자가 `res.status === 201`인지로 환영 메시지를 분기하므로 status를 반드시 노출.

### 2.3 `kloserApi.verifyEmail(token) → { status, body }`

```js
async function verifyEmail(token) {
  const res = await rawFetch('/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const text = await res.text();
  let body = null;
  if (text.length > 0) {
    try { body = JSON.parse(text); } catch (_) { /* leave null */ }
  }
  return { status: res.status, body };
}
```

토큰 검사만 — access token 발급 없음. `setAccessToken` 호출 안 함.

### 2.4 `kloserApi.requestPasswordReset(email) → { status, body }`

```js
async function requestPasswordReset(email) {
  const res = await rawFetch('/auth/password/forgot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const text = await res.text();
  let body = null;
  if (text.length > 0) {
    try { body = JSON.parse(text); } catch (_) { /* leave null */ }
  }
  return { status: res.status, body };
}
```

### 2.5 `kloserApi.resetPassword(token, newPassword) → { status, body }`

```js
async function resetPassword(token, newPassword) {
  const res = await rawFetch('/auth/password/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, newPassword }),
  });
  const text = await res.text();
  let body = null;
  if (text.length > 0) {
    try { body = JSON.parse(text); } catch (_) { /* leave null */ }
  }
  return { status: res.status, body };
}
```

토큰 검사 + 모든 세션 revoke. `setAccessToken` 호출 안 함 — 호출 직후 사용자는 새 비번으로 다시 로그인.

### 2.6 export 표

`window.kloserApi`에 다음 5개 신규 추가:
```js
window.kloserApi.signup                 = signup;
window.kloserApi.acceptInvitation       = acceptInvitation;
window.kloserApi.verifyEmail            = verifyEmail;
window.kloserApi.requestPasswordReset   = requestPasswordReset;
window.kloserApi.resetPassword          = resetPassword;
```

**기존 `login()`은 throw 패턴 유지** (Phase 1 step 4 호환). 본 step의 5 helper는 모두 `{ status, body }` 일관 패턴 — 새 페이지가 page-level error mapping 표 (§11)를 status로 직접 분기. login만 다른 패턴이지만 기존 페이지 (login.html) 외에는 안 쓰므로 회귀 0.

---

## 3. `platform/signup.html`

### 3.1 surface
- form 필드: `organizationName` / `name` / `email` / `password` 4개. 모두 required, password min 8 (HTML5 attr + zod 서버 검증).
- 제출 → `kloserApi.signup({...})` → `{ status, body }` 반환 → status로 분기.
- 미인증 배너는 live.html에서 자동 표출되므로 signup.html에는 안내 안 함.

### 3.2 응답 처리
- `status === 201` → helper가 이미 `setAccessToken` 함 → `/platform/live.html`로 redirect.
- `status === 400` (`body.code === 'invalid_input'`) → "입력값을 확인해주세요." (zod issues는 안 노출, 일반 안내)
- `status === 409` (`body.code === 'email_conflict'`) → "이미 가입된 이메일입니다. [로그인]" link
- `status >= 500` → "일시적인 오류입니다. 잠시 후 다시 시도해주세요."

### 3.3 links
- 하단 "이미 계정이 있나요? [로그인]" → login.html

---

## 4. `platform/verify.html`

### 4.1 surface
- 진입 시 `URLSearchParams`로 `token` 읽음. 없으면 "유효하지 않은 링크" 페이지.
- **token 읽은 직후 `window.history.replaceState(null, '', window.location.pathname)`로 URL에서 token query 제거.** 성공/실패와 무관하게 raw token이 history / referrer / 주소창에 남지 않도록 page-load 시점에 즉시 정리. 변수에 저장한 token은 closure로 보존.
- 자동으로 `kloserApi.verifyEmail(token)` 1회 호출.
- 진행 중 spinner, 결과는 success / failure 두 상태.

### 4.2 응답 처리
`kloserApi.verifyEmail(token)` 호출 → `{ status, body }`.
- `status === 200` → "이메일 인증이 완료되었습니다 ✓" + [대시보드로 이동] (logged-in이면) / [로그인하기] (logged-out이면). 로그인 상태 감지: `kloserApi.getAccessToken()` 또는 refresh 시도.
- `status === 410` → "이 인증 링크는 만료되었거나 이미 사용되었습니다. 로그인 후 [이메일 인증 재발송]을 눌러주세요." + [로그인하기]
- `status === 400` → "유효하지 않은 링크입니다."

### 4.3 race
- 더블 클릭으로 두 번 호출되면 첫 호출 200, 두 번째 410 (token_already_used). 화면은 결과의 latest를 그리는 게 자연스러우므로 두 번째 410을 그대로 표출해도 무방. 다만 single-flight 패턴 (boolean inflight)으로 호출 1회만 보장.

---

## 5. `platform/forgot-password.html`

### 5.1 surface
- form 필드: `email`. submit → `kloserApi.requestPasswordReset(email)` → `{ status, body }`.
- enumeration parity: 응답이 항상 200이므로 UI도 항상 같은 화면 ("이메일 도착 안내 페이지")로 전환.

### 5.2 응답 처리
- `status === 200` (모든 expected branch) → "비밀번호 재설정 안내를 보냈습니다 (계정이 존재한다면). 메일을 확인해주세요. 1시간 내 사용 가능합니다."
- `status >= 500` (예상치 못한 server failure) → "일시적인 오류입니다." + 재시도 버튼

### 5.3 links
- "로그인으로 돌아가기" → login.html

---

## 6. `platform/reset-password.html`

### 6.1 surface
- 진입 시 `?token=...` 읽음. 없으면 "유효하지 않은 링크" 페이지.
- **token 읽은 직후 `window.history.replaceState(null, '', window.location.pathname)`로 URL에서 token query 제거.** raw token을 closure에 보존하되 주소창/history에서 제거.
- form: `newPassword` + `newPasswordConfirm` (client-side 일치 검증). submit → `kloserApi.resetPassword(token, newPassword)`.

### 6.2 응답 처리
`kloserApi.resetPassword(token, newPassword)` 호출 → `{ status, body }`.
- `status === 200` → "비밀번호가 변경되었습니다. 새 비밀번호로 다시 로그인해주세요. 다른 세션은 모두 로그아웃됩니다." + [로그인하기]. 자동 redirect 5초 후.
- `status === 410` → verify의 410 안내와 동일. "[비밀번호 재설정 다시 요청]" → forgot-password.html
- `status === 400` (`body.code === 'invalid_input'`, password 길이) → "비밀번호는 8자 이상이어야 합니다."

### 6.3 client 검증
- 두 password input이 같지 않으면 submit 비활성. min 8 enforce.

---

## 7. `platform/accept-invitation.html`

### 7.1 surface
- 진입 시 `?token=...` 읽음. 없으면 "유효하지 않은 링크" 페이지.
- **token 읽은 직후 `window.history.replaceState(null, '', window.location.pathname)`로 URL에서 token query 제거.** raw token을 closure에 보존. 성공 후 redirect target은 live.html (별도 history rewrite 불필요 — 이미 replace 됐음).
- form: `name` + `password` + `passwordConfirm` (client-side 일치). submit → `kloserApi.acceptInvitation({ token, name, password })`.

### 7.2 응답 처리
호출 결과는 `{ status, body }` (§2.2). status로 직접 분기:
- `status === 201` (신규 user) → "{body.organization.name}의 일원이 되신 걸 환영합니다!" + 자동 로그인 (helper가 이미 `setAccessToken` 함) → `/platform/live.html` 진입
- `status === 200` (기존 user, multi-org) → "{body.organization.name} 팀에 추가되었습니다." + 자동 로그인 → `/platform/live.html` 진입
  - signup과의 차이는 status code뿐. 둘 다 같은 AuthResult body shape, 같은 Set-Cookie refresh, 같은 redirect.
- 409 account_disabled → "이 계정은 비활성화되어 있습니다. 관리자에게 문의하세요." (재시도 button 없음)
- 409 already_member → "이미 {organization} 멤버입니다. [로그인하기]" — 어느 org에 이미 멤버인지는 응답에 없음. 사용자가 본인이 안다고 가정.
- 410 → "초대 링크가 만료되었거나 취소되었습니다. 초대자에게 새 메일을 요청해주세요." (재시도 button 없음)
- 400 → "입력값을 확인해주세요."

### 7.3 organization 이름 노출
- `acceptInvitation` 응답 body에 `organization.name`이 있으므로 success 페이지에서 직접 표시 가능. 실패 응답에는 없으므로 "조직" 같은 일반어로 fallback.

---

## 8. `platform/login.html` 보강

### 8.1 추가할 두 링크
form 하단에:
```
"아직 계정이 없으신가요? [회원가입]" → signup.html
"비밀번호를 잊으셨나요? [비밀번호 재설정]" → forgot-password.html
```

### 8.2 dev-fixture 영역은 그대로 유지
seeded 자격증명 hint는 localhost 전용으로 유지 (Phase 1 step 4 그대로).

### 8.3 returnUrl pass-through
회원가입 / forgot 링크에 현재 페이지의 returnUrl을 query로 전달하지 않음 — 회원가입 / 재설정 후 항상 live.html로 보내는 게 단순.

---

## 9. `platform/team.html` 실 API 연결

### 9.1 auth gate (Phase 2 customers.html 패턴)
```js
if (!window.kloserApi.getAccessToken()) {
  try { await window.kloserApi.refreshAccessToken(); }
  catch (_) { window.kloserApi.loginRedirect(); return; }
}
await loadAll();
```

### 9.2 loadAll
```js
const [meRes, membersRes, teamsRes, invitationsRes] = await Promise.all([
  window.kloserApi.apiGet('/me'),
  window.kloserApi.apiGet('/team/members'),
  window.kloserApi.apiGet('/teams'),
  window.kloserApi.apiGet('/invitations'),  // employee는 403 → 빈 set으로 fallback
]);
```

`/me`는 본인 membership / org 확인 (kebab 자기 row 비활성화 + admin gate UI 제어용). `/invitations`는 admin 전용이라 employee/viewer는 403 — silent fallback `invitations = []` + UI 자체 hide.

### 9.3 멤버 표 렌더
- 각 row: avatar (이니셜) + `user_name` + `user_email` + `team_name` (또는 "미배정") + role pill + status badge (active="활성" / disabled="비활성") + kebab (admin only).
- 하드코딩 `members` 배열 완전 제거.
- `user_email_verified_at` null이면 이메일 옆에 작은 노란 dot ("미인증" tooltip).

### 9.4 "초대 대기" 영역 (멤버 표 위 또는 별도 카드)
- `GET /invitations` 결과 N rows.
- 각 row: email + role + team_name + invited_by_name + `last_sent_at` (한국어 상대 시간) + `token_expires_at` 남은 시간 + [재발송] [취소] 버튼.
- 빈 set이면 영역 자체 hide.

### 9.5 초대 modal (`openInvite()`)
- 기존 modal 재사용. team 드롭다운은 `GET /teams` 결과로 동적 채움 ("팀 없음" 옵션 + N teams).
- submit (`sendInvite()`):
  ```js
  const res = await window.kloserApi.apiPost('/invitations', {
    email: email.value.trim().toLowerCase(),
    role: role.value,
    teamId: team.value || null,
  });
  if (res.status === 201) {
    const { invitation } = await res.json();
    // "초대 대기" 영역에 prepend, modal close, toast "초대 메일 발송됨"
  } else {
    const body = await res.json();
    // 409 invitation_already_pending / 409 already_member / 400 invalid_team / 400 invalid_input
  }
  ```

### 9.6 재발송 / 취소
- 재발송: `apiPost('/invitations/' + id + '/resend', {})` → 200 → toast "재발송됨". 409 → toast "이미 처리된 초대입니다." + 영역 reload.
- 취소: confirm dialog → `apiDelete('/invitations/' + id)` → 204 → 영역에서 row 제거.

### 9.7 권한·상태 변경 (kebab)
kebab 메뉴 옵션은 **"역할 변경" + "비활성화"(또는 "활성화") 두 종류뿐**. **"삭제" label 절대 노출 안 함** — 서버에 membership DELETE endpoint가 없고 Master §11이 hard delete를 금지 (status disable이 그 대체).

- 자기 row → kebab 자체를 hide (자기 self-demote/disable 차단).
- 역할 변경: 4 옵션 (admin / manager / employee / viewer) → `apiPatch('/memberships/' + id, { role: newRole })`.
  - 200 → row의 role pill 갱신.
  - 401 stale_role → "권한이 변경됐습니다. 다시 로그인하세요." + 5초 후 loginRedirect.
  - 409 last_admin_protected → toast "마지막 admin은 demote할 수 없습니다."
- 활성화 ↔ 비활성화 토글: confirm dialog → `apiPatch('/memberships/' + id, { status: newStatus })`. status가 active면 메뉴에 "비활성화"만, disabled면 "활성화"만 — 토글 형태.
  - 200 → row의 status badge 갱신.
  - 401 stale_role / stale_session → 위와 동일.
  - 409 last_admin_protected → toast.

### 9.8 employee/viewer UI
- 초대 버튼 hide.
- 초대 대기 영역 hide.
- kebab 메뉴 hide.
- 멤버 표 read-only (avatar / 이름 / 팀 / role / status 노출).

### 9.9 sidebar count
`_shared.js`의 sidebar HTML이 이미 `id="sidebarCustomersCount"`를 갖고 있음. 본 step에서 team 멤버 수를 sidebar에 노출하지는 않음 (필요 시 Phase 4+).

---

## 10. 미인증 user 배너 (`_shared.js`)

```js
function renderUnverifiedBanner(meBody) {
  if (!meBody || !meBody.user) return;
  if (meBody.user.email_verified_at) return;  // 이미 인증됨
  const banner = document.createElement('div');
  banner.id = 'unverified-banner';
  banner.className = 'fixed top-0 inset-x-0 z-[300] bg-amber-50 border-b border-amber-200 text-amber-900 text-[.8rem] px-4 py-2 flex items-center justify-between gap-3';
  banner.innerHTML = `
    <span><b>이메일 인증이 완료되지 않았습니다.</b> 메일함을 확인해주세요.</span>
    <button id="resend-verify-btn" class="px-3 py-1 rounded-md bg-white border border-amber-300 text-amber-800 text-[.74rem] font-semibold hover:bg-amber-100">
      인증 메일 재발송
    </button>
  `;
  document.body.prepend(banner);
  document.getElementById('resend-verify-btn').addEventListener('click', async () => {
    const res = await window.kloserApi.apiPost('/auth/verify/resend', {});
    if (res.status === 200) showToast('인증 메일을 다시 보냈습니다.');
    else if (res.status === 409) {
      banner.remove();  // already_verified — race로 인증 완료된 상태
      showToast('이미 인증된 계정입니다.');
    } else {
      showToast('재발송에 실패했습니다. 잠시 후 다시 시도해주세요.');
    }
  });
}
```

각 페이지의 auth gate 직후 `renderUnverifiedBanner(meBody)` 호출. `/me`를 한 번 fetch하면 응답 body가 곧 인자.

---

## 11. Error code → 사용자 메시지 매핑 (단일 표)

| endpoint | 상태 | code | 메시지 | 추가 액션 |
|---|---|---|---|---|
| signup | 400 | invalid_input | "입력값을 확인해주세요." | form retry |
| signup | 409 | email_conflict | "이미 가입된 이메일입니다." | [로그인하기] link |
| signup | 500 | * | "일시적인 오류입니다." | 재시도 |
| verify | 200 | — | "이메일 인증이 완료되었습니다." | [대시보드] 또는 [로그인] |
| verify | 410 | token_invalid_or_expired | "링크가 만료되었거나 이미 사용되었습니다." | [로그인 후 재발송] |
| verify | 400 | invalid_input | "유효하지 않은 링크입니다." | — |
| forgot | 200 | — | "메일을 보냈습니다 (계정이 존재한다면)." | — |
| forgot | 500 | * | "일시적인 오류입니다." | 재시도 |
| reset | 200 | — | "비밀번호가 변경되었습니다." | [로그인] (5s redirect) |
| reset | 410 | token_invalid_or_expired | 위 verify와 동일 | [재설정 재요청] |
| reset | 400 | invalid_input | "비밀번호는 8자 이상이어야 합니다." | form retry |
| accept | 201/200 | — | "환영합니다 / {org}에 참여했습니다." | live.html 진입 |
| accept | 409 | account_disabled | "비활성화된 계정입니다." | — |
| accept | 409 | already_member | "이미 {organization} 멤버입니다." | [로그인] |
| accept | 410 | token_invalid_or_expired | "초대 링크가 만료/취소됐습니다." | — |
| accept | 400 | invalid_input | "입력값을 확인해주세요." | form retry |
| team `POST /invitations` | 201 | — | "초대 메일을 보냈습니다." | 대기 영역 prepend |
| team `POST /invitations` | 409 | invitation_already_pending | "이 이메일로 이미 초대 메일을 보냈습니다." | — |
| team `POST /invitations` | 409 | already_member | "이미 멤버인 이메일입니다." | — |
| team `POST /invitations` | 400 | invalid_team | "유효하지 않은 팀입니다." | — |
| team `POST /invitations` | 401 | stale_role | "권한이 변경됐습니다. 다시 로그인하세요." | 5s loginRedirect |
| team `POST /invitations/:id/resend` | 200 | — | "재발송했습니다." | row touch |
| team `POST /invitations/:id/resend` | 409 | invitation_already_finalized | "이미 처리된 초대입니다." | 영역 reload |
| team `DELETE /invitations/:id` | 204 | — | row 제거 | — |
| team `PATCH /memberships/:id` | 200 | — | row 갱신 | — |
| team `PATCH /memberships/:id` | 409 | last_admin_protected | "마지막 admin은 변경할 수 없습니다." | — |
| team `PATCH /memberships/:id` | 401 | stale_role | "권한이 변경됐습니다." | 5s loginRedirect |
| team `PATCH /memberships/:id` | 401 | stale_session | "세션이 만료됐습니다." | 즉시 loginRedirect |
| verify/resend (banner) | 200 | — | toast "인증 메일을 다시 보냈습니다." | — |
| verify/resend (banner) | 409 | already_verified | toast "이미 인증된 계정입니다." | 배너 hide |
| verify/resend (banner) | 401 | * | — | loginRedirect |

---

## 12. 수동 검증

본 step 완료 후 5명의 user persona로 직접 흐름 확인. 모든 검증은 dev 환경 (`http://localhost:8765` + `http://localhost:3001`)에서 진행. raw token은 `email_outbox.body_text` / `metadata`에서 추출 (servicePool 또는 psql).

### persona 1: 신규 user signup
1. signup.html → "Acme Test" / "테스트 유저" / "test@example.test" / 8자 pw → 제출
2. 201 응답 → live.html 도착
3. 상단 노란 배너 노출 — "이메일 인증이 완료되지 않았습니다"
4. psql / outbox에서 raw token 추출 → verify.html?token=XXX
5. "이메일 인증이 완료되었습니다" 화면
6. 다시 live.html 진입 → 배너 사라짐

### persona 2: forgot → reset
1. login.html에서 "비밀번호를 잊으셨나요?" → forgot-password.html
2. "admin@acme.test" 입력 → 200 → 동일 안내 화면
3. outbox에서 raw token → reset-password.html?token=XXX
4. 새 비번 + 확인 → 200 → "비밀번호가 변경되었습니다" + 5s 후 login.html
5. 새 비번으로 로그인 → 200 → 대시보드
6. (기존 로그인 세션이 있었다면) 그 탭의 다음 fetch는 401 → loginRedirect

### persona 3: admin이 초대 / 새 user accept
1. acme admin 로그인 → team.html
2. "직원 초대" 모달 → "new-emp@example.test" / employee / 팀 선택 → 발송
3. "초대 대기" 영역에 row 추가
4. outbox token → accept-invitation.html?token=XXX (logged-out 상태로 다른 브라우저)
5. name + password → 201 → "환영합니다" → live.html
6. 다시 team.html → "초대 대기"에서 사라짐, 멤버 표에 새 row

### persona 4: 기존 user multi-org accept
1. beta admin이 emp@acme.test를 invite
2. outbox token → accept-invitation.html?token=XXX
3. name + password → 200 (created=false 의미) → "Beta 팀에 참여했습니다" → live.html (Beta org context로 로그인)
4. 옛 acme 비번으로 다시 로그인 → 200 (acme로 진입)
5. 두 세션이 독립적으로 작동

### persona 5: admin이 role/status 변경
1. acme admin이 team.html에서 emp@acme.test의 kebab → "역할 변경" → manager → 200
2. 같은 row의 kebab → "비활성화" → confirm → 200 → status badge "비활성"
3. emp@acme.test가 다른 탭에서 fetch → 401 + 즉시 로그인 페이지로
4. emp@acme.test가 로그인 시도 → 401 account_disabled
5. admin이 다시 "활성화" → 200
6. emp@acme.test 로그인 → 200, role = manager

### persona 6 (선택): 초대 만료 / 취소 / 재발송
1. acme admin invite → outbox token 1 추출
2. team.html "재발송" → outbox token 2 추출
3. 다른 브라우저로 token 1로 accept → 410 generic
4. 다른 브라우저로 token 2로 accept → 201
5. admin이 다른 invite 발송 후 "취소" → 204
6. 옛 raw로 accept → 410 generic

---

## 13. 위험·미정

| 항목 | 처리 |
|---|---|
| signup의 email 중복 노출 (409 email_conflict) | enumeration trade-off로 의도. login 흐름은 enumeration parity 유지 (Step 3 §1-10) — signup만 다른 정책. UI에서 "[로그인하기]" 동선이 자연스럽게 받아주므로 OK |
| signup 직후 `/me`가 unverified → 배너가 첫 페이지에서 깜빡임 | live.html이 background load 후 배너 표출. 처음 200ms 정도는 배너 없이 보일 수 있음 — 회피하려면 signup 후 redirect 전에 ?signup=1 같은 query로 표시. Step 6 안에서는 안 함 (UX 영향 미미) |
| `kloserApi.signup` / `acceptInvitation`이 access token 발급에 대한 single-flight 직렬화 없음 | rawFetch 직접 호출이라 더블 클릭 race 발생 가능. 페이지마다 submit 버튼 disable로 client-side 보호. 서버는 race-safe (signup의 23505 email_conflict / accept의 token consume 직렬화) |
| forgot-password에서 사용자가 자기 이메일을 모르고 enter 키 누름 | enumeration parity 정책상 빈 입력도 200 응답 — 서버는 zod에서 min 3으로 거른다. client에서도 HTML5 required + min 3으로 즉시 거절 |
| accept 페이지에서 password를 입력했는데 already_member 응답 | password는 서버에 절대 갈리지 않음 (accept 흐름은 기존 user의 password를 손대지 않음). UI 안내 "비밀번호는 사용되지 않습니다 — 기존 비밀번호로 로그인하세요" |
| reset-password.html에서 두 password 일치 검증을 client-side에서만 함 | 서버는 한쪽 password만 받음 — 일치는 client 책임. client validation을 우회한 잘못된 입력은 user 자신에게 손해, 보안 위협은 아님 |
| team.html의 role 변경이 admin 본인에게 적용될 때 self-demote 차단 (UI) vs 서버 last-admin protection | UI는 자기 row의 kebab을 hide. 서버는 last-admin protection으로 받아주지만 UX 일관성 (다른 admin이 demote할 때만 가능) |
| /me 응답에 `email_verified_at`이 없으면 배너 표시 안 됨 | /me는 PublicAuthUser shape으로 `email_verified_at` 포함. Phase 1 정합 |
| 사용자가 accept-invitation 페이지를 새로고침 후 같은 password 다시 입력 | 두 번째 호출은 `token_already_used` → 410. UI 안내 "이미 사용된 링크입니다 — 새 비번 분실 시 [비밀번호 재설정]" |
| raw token이 history / 주소창 / referrer에 남는 위험 | **verify / reset / accept 3 페이지 모두 token 읽은 직후 (page-load 시점) `window.history.replaceState(null, '', window.location.pathname)`**로 query string 제거 (§4.1 / §6.1 / §7.1). raw token은 page closure 변수에만 존재. accept는 그 위에 성공 후 redirect까지 가므로 history는 깨끗. 보조: `<meta name="referrer" content="no-referrer">` 3 페이지에 추가해 다른 사이트로 referrer 전파 차단 |
| Phase 0.5 / Phase 2 e2e가 새 페이지를 깨뜨릴 가능성 | 새 페이지는 기존 URL 영향 없음 (모두 신규 path). login.html 보강은 form id 변경 없이 link 2개 추가만 — 기존 e2e 회귀 0 |
| `_shared.js`에 배너 함수 추가가 live.html / dashboard.html / customers.html에 부작용 | 함수 호출은 페이지 auth gate 직후로 한 번. body DOM prepend 1회. 기존 layout 영향 없음 — 모든 페이지가 body 상단 60px header를 가지므로 fixed top banner가 header와 겹치는 부분만 z-index 또는 padding-top 조정 |

---

## 14. 완료 기준 (Step 6 — go/no-go)

- [ ] `platform/api.js` (수정) — `signup` + `acceptInvitation` 헬퍼 추가
- [ ] `platform/signup.html` (신규)
- [ ] `platform/verify.html` (신규)
- [ ] `platform/forgot-password.html` (신규)
- [ ] `platform/reset-password.html` (신규)
- [ ] `platform/accept-invitation.html` (신규)
- [ ] `platform/login.html` (수정) — 회원가입 / forgot 링크 추가
- [ ] `platform/team.html` (수정) — 하드코딩 14행 제거 + 실 API 5종 연결
- [ ] `platform/_shared.js` (수정) — `renderUnverifiedBanner` 함수 + 페이지별 auth gate에서 호출
- [ ] 수동 검증 6 persona 모두 의도대로 동작 (§12)
- [ ] `node test/phase_0_5_e2e.mjs` 16/16 회귀 PASS
- [ ] `node test/phase_2_customers_e2e.mjs` 7/7 회귀 PASS
- [ ] `npm --prefix server test` 155/155 회귀 PASS (서버 코드 변경 0건 → 자명)
- [ ] `PHASE_3_STEP_6_FINDINGS.md` 작성

---

## 15. 한 줄 요약

> **1.5일 동안 5 신규 페이지 (`signup` / `verify` / `forgot-password` / `reset-password` / `accept-invitation`) + `team.html` 실 API 연결 + 미인증 user 배너. `platform/api.js`에 5 public helper 추가 (`signup` / `acceptInvitation` / `verifyEmail` / `requestPasswordReset` / `resetPassword`) — 모두 `{ status, body }` 일관 반환 (accept의 201 vs 200 분기를 위해 status 노출 필수). 서버 코드 / migration / env / shared types 0건 추가. 모든 error mapping은 plan §11 단일 표. verify / reset / accept 3 페이지는 token 읽은 직후 `history.replaceState`로 URL 정리. team kebab은 "역할 변경" + "비활성화/활성화" 토글만 — "삭제" label 안 씀 (Master §11 hard delete 금지). 자동 테스트는 회귀만 — 새 client 흐름은 Step 7 e2e가 통합 시나리오로 검증.**

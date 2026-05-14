# Phase 7 Step 2 Plan — MFA / session hardening

> 작성일: 2026-05-14  
> 상위 문서: `PHASE_7_MASTER.md`  
> 선행 완료: `PHASE_7_STEP_1_FINDINGS.md`  
> 현재 선행 커밋: `0d00d4e Add Phase 7 MFA schema`

범위는 TOTP-first MFA와 MFA required 조직 설정이다. WebAuthn, recovery
code 발급/보관, device trust, SSO 연동은 이번 step에서 구현하지 않는다.

---

## 1. Current State

현재 인증 흐름은 password success 후 즉시 refresh session과 access JWT를
발급한다.

- `POST /auth/login`은 `services/auth.login()` 결과를 `sendAuthResult()`로
  변환해 access token과 refresh cookie를 내려준다.
- `POST /auth/refresh`는 refresh token family rotation만 검증하고 MFA
  상태를 보지 않는다.
- `sessions` repository 타입은 아직 `mfa_verified_at` / `mfa_method`를
  반환하지 않는다.
- `auth_tokens` service의 `TokenPurpose` union은 아직
  `mfa_challenge`를 포함하지 않는다.
- `users` repository에는 MFA secret 조회/저장 helper가 없다.
- 조직 설정 route는 별도로 없고, `/me`만 현재 org 정보를 읽는다.

이미 들어간 schema commit은 다음 DB 표면을 추가했다.

- `users.mfa_secret_ciphertext`, `mfa_secret_iv`, `mfa_secret_tag`,
  `mfa_secret_key_version`
- `users.mfa_enabled_at`, `mfa_failed_attempt_count`, `mfa_locked_until`
- `organizations.mfa_required`
- `sessions.mfa_verified_at`, `sessions.mfa_method`
- `auth_tokens.purpose = 'mfa_challenge'`

이 migration은 runtime behavior를 바꾸지 않는다. 따라서 다음 구현은
AGENTS.md Phase Workflow상 **repo + unit tests**부터 시작한다.

---

## 2. Decisions

### 2.1 MFA factor

**결정**: Step 2는 TOTP만 구현한다.

- TOTP: RFC 6238, 30초 step, 6자리 code, SHA-1, 허용 drift는 현재 step
  기준 `-1, 0, +1`.
- secret: 20 random bytes를 base32로 사용자에게 표시하고, DB에는
  AES-256-GCM encrypted payload로 저장한다.
- QR 이미지는 서버가 생성하지 않는다. 서버는 `otpauth://` URI와 manual
  setup secret을 반환한다. 프런트 QR 렌더링이 필요하면 브라우저 쪽에서
  별도 단계로 붙인다.
- 새 npm dependency는 기본적으로 추가하지 않는다. Node `crypto`로 TOTP와
  AES-GCM을 구현하고, dependency가 꼭 필요하면 plan/finding에 이유를
  남긴다.

### 2.2 Login challenge model

**결정**: password success 후 MFA가 필요하면 access JWT와 refresh cookie를
발급하지 않는다.

MFA가 필요한 조건:

- 현재 조직의 `organizations.mfa_required = true`
- 또는 사용자 `users.mfa_enabled_at IS NOT NULL`

Login service는 org까지 확정한 뒤 위 조건을 평가한다.

- MFA 불필요: 기존과 동일하게 session + access token 발급.
- MFA 필요 + user MFA enabled: `mfa_challenge` auth token을 mint하고
  route는 `202`와 challenge response를 반환한다.
- MFA 필요 + org required + user MFA not enabled: password-only session은
  여전히 발급하지 않는다. route는 setup-required challenge를 반환한다.

Challenge response에는 refresh cookie가 없어야 한다. access token도 없어야
한다. challenge raw token은 bearer credential이므로 response body에만 담고,
DB에는 기존 `auth_tokens.token_hash` sha256만 저장한다.

### 2.3 Challenge token lifecycle

**결정**: `auth_tokens`의 `mfa_challenge` purpose를 사용한다.

- TTL: 5분.
- mint 전 같은 user의 active `mfa_challenge`는 invalidate한다.
- token row는 `org_id`와 `user_id`를 가진다. `invitation_id`는 null이다.
- code 검증 실패는 challenge token을 즉시 consume하지 않는다. 같은 5분
  challenge 안에서 제한된 횟수만 재시도할 수 있게 한다.
- 성공 시에만 token을 consumed 처리하고 session을 만든다.

`consumeToken()`은 조회와 consume이 붙어 있으므로 MFA verify에는 그대로 쓰지
않는다. 기존 split helper인 `findTokenByRaw()` +
`lockAndValidateTokenById()` + `markTokenConsumed()` 패턴을 확장해서 쓴다.

### 2.4 Secret encryption

**결정**: email outbox encryption helper와 같은 AES-256-GCM 형태를 쓰되,
MFA 전용 env와 helper를 둔다.

Env:

```text
MFA_SECRET_ENCRYPTION_KEY=base64-32-byte-key
```

Policy:

- MFA setup/verify/disable 경로가 key 없이 secret을 다뤄야 하면 fail-fast.
- key/ciphertext/plaintext는 에러 메시지와 로그에 포함하지 않는다.
- 잘못된 key 또는 auth tag mismatch는 인증 실패처럼 삼키지 않는다. 운영
  misconfig 또는 데이터 손상으로 보아 500 계열로 surface한다.
- `EMAIL_OUTBOX_ENCRYPTION_KEY`와 공유하지 않는다.

### 2.5 Session semantics

**결정**: MFA를 통과한 session에는 `mfa_verified_at`과 `mfa_method='totp'`를
저장한다.

- MFA 불필요 session은 두 필드가 null이어도 된다.
- refresh rotation은 기존 session의 MFA fields를 replacement session으로
  복사한다.
- 조직이 MFA required로 바뀐 뒤 기존 non-MFA access JWT는 JWT TTL 동안
  남을 수 있다. 이번 step은 login/refresh에서 password-only access issuance를
  차단하는 것을 완료 기준으로 삼는다.
- refresh 시 org/user가 MFA를 요구하지만 기존 session에
  `mfa_verified_at IS NULL`이면 refresh는 access token을 발급하지 않고
  `mfa_required` 계열 401/403 응답으로 끝낸다. 이때 refresh family revoke
  여부는 구현 계획에서 명시해야 한다. 기본값은 revoke하지 않고 재-login을
  요구한다.

### 2.6 Org required toggle

**결정**: org-level MFA required는 admin-only 설정이다.

Route는 새 org security surface로 둔다.

```text
GET   /organization/security
PATCH /organization/security
```

`PATCH`는 `requireAuth -> orgContext -> requireVerified -> requireFreshRole`
뒤 admin만 허용한다.

Guard:

- `mfa_required: true`로 켤 때 요청한 admin 본인이 MFA enabled 상태여야 한다.
- org 내 active user 중 MFA 미등록 사용자가 있더라도 toggle 자체는 허용한다.
  이후 그 사용자는 다음 login에서 setup-required challenge를 받는다.
- `mfa_required: false`는 admin만 가능하다.

### 2.7 Enrollment and disable

Authenticated user enrollment:

```text
POST   /auth/mfa/totp/setup
POST   /auth/mfa/totp/confirm
DELETE /auth/mfa/totp
```

Login challenge enrollment for org-required users without MFA:

```text
POST /auth/mfa/totp/setup-challenge
POST /auth/mfa/totp/confirm-challenge
```

Rules:

- authenticated setup/disable requires current password.
- disable also requires a valid current TOTP code when MFA is enabled.
- disable is rejected with 409 if the current org requires MFA.
- setup stores an encrypted pending secret with `mfa_enabled_at = NULL`.
- confirm verifies the pending secret and sets `mfa_enabled_at = now()`.
- confirm on the current authenticated session also marks that session MFA
  verified.

The exact route names may be adjusted during implementation, but the security
properties above are not optional.

---

## 3. Repo + Unit Test Plan

This is the next implementation unit after the committed schema migration.

### 3.1 `auth_tokens`

Update `server/src/services/auth-tokens.ts`.

- Extend `TokenPurpose` with `"mfa_challenge"`.
- Add `TTL_MFA_CHALLENGE_MS = 5 * 60 * 1000`.
- Ensure `invalidateActiveTokens()` works for `mfa_challenge`.
- Add tests that mint/lock/mark-consumed works for `mfa_challenge`.

### 3.2 `sessions`

Update `server/src/repositories/sessions.ts`.

- Extend `AuthSession` with `mfa_verified_at: Date | null` and
  `mfa_method: "totp" | "webauthn" | "recovery_code" | null`.
- Extend `SESSION_COLUMNS`.
- Add optional `mfaVerifiedAt` / `mfaMethod` inputs to `createSession()`.
- Add helper to mark a session MFA verified:

```ts
markMfaVerified(client, { sessionId, method: "totp" })
```

- Add helper or create-session option to copy MFA fields during refresh
  rotation.

Tests:

- create session with null MFA fields.
- create session with `totp` verified fields.
- mark existing session verified.
- refresh replacement preserves MFA fields.

### 3.3 `users` MFA repository

Add `server/src/repositories/mfaUsers.ts` or extend the existing auth-user
repository if that better fits local style.

Required helpers:

- get user MFA state by id, including encrypted secret fields and lockout
  counters.
- store pending encrypted TOTP secret (`mfa_enabled_at = NULL`).
- enable pending secret (`mfa_enabled_at = now()`).
- clear MFA secret and counters.
- increment/reset `mfa_failed_attempt_count`.
- set/clear `mfa_locked_until`.

Because `users` is not RLS-scoped today, every helper must take an explicit
`userId`; org authorization belongs in service code through membership/org
checks.

Tests:

- all-or-none secret constraints hold.
- enabled requires secret.
- failed count cannot go negative.
- pending secret can exist before enabled.

### 3.4 Organizations security repository

Extend `server/src/repositories/organizations.ts` or add a small
`organizationSecurity` repository.

Required helpers:

- read current org `mfa_required`.
- update current org `mfa_required`.
- count/list active members without MFA for admin diagnostics if route chooses
  to return it.

Use `current_app_org_id()` or `app.withOrgContext` patterns where user-facing
org state is read. Do not trust request body for `org_id`.

Tests:

- same-org admin can read/update.
- cross-org read/update is not possible through current org context.
- no unscoped organization update by arbitrary org id.

---

## 4. Service Plan

### 4.1 TOTP service

Add `server/src/services/totp.ts`.

Responsibilities:

- generate base32 secret from 20 random bytes.
- build `otpauth://totp/Kloser:<email>?secret=...&issuer=Kloser&digits=6&period=30`.
- verify 6-digit code against drift window `[-1, 0, +1]`.
- compare codes with timing-safe comparison where practical.

Tests:

- known RFC-style timestamp/code fixture.
- accepts current and adjacent step.
- rejects old/future outside drift.
- rejects malformed/non-6-digit input.

### 4.2 MFA secret encryption

Add `server/src/services/mfaSecretEncryption.ts`.

Mirror the safety policy of `emailSensitivePayload.ts`, but use
`MFA_SECRET_ENCRYPTION_KEY`.

Tests:

- round trip.
- missing/malformed env.
- wrong key/tag failure without echoing sensitive bytes.

### 4.3 Auth login service

Change `services/auth.login()` return type from only `AuthResult` to a
discriminated result:

```ts
type LoginResult =
  | { kind: "authenticated"; auth: AuthResult }
  | { kind: "mfa_required"; challengeToken: string; method: "totp"; expiresAt: Date }
  | { kind: "mfa_setup_required"; challengeToken: string; expiresAt: Date };
```

The route layer decides status and response shape.

Required behavior:

- invalid email/password remains identical `401 invalid_credentials`.
- multi-org login without orgId remains existing `400 org_id_required`.
- only after org is resolved and password is valid can MFA challenge be issued.
- challenge mint happens in the same transaction as login decision.
- no session row is created for challenge-only login.

### 4.4 MFA verify service

Add service methods:

- `verifyLoginMfa({ challengeToken, code, userAgent, ip })`
- `startAuthenticatedTotpSetup({ userId, orgId, currentPassword })`
- `confirmAuthenticatedTotp({ userId, orgId, sessionId, code })`
- `startChallengeTotpSetup({ challengeToken })`
- `confirmChallengeTotp({ challengeToken, code, userAgent, ip })`
- `disableTotp({ userId, orgId, currentPassword, code })`

Lock order:

1. challenge token row, when present
2. user MFA row
3. session row, when marking verified

Failure policy:

- wrong TOTP increments `mfa_failed_attempt_count`.
- after 5 wrong attempts, set `mfa_locked_until = now() + 10 minutes`.
- locked users get a stable `423 mfa_locked` or `429 mfa_locked` response.
- wrong code never reveals the secret state beyond expected MFA/setup-required
  branches.

---

## 5. Route / Shared Type Plan

### 5.1 Auth routes

Update `server/src/routes/auth.ts`.

Login responses:

- `200`: existing authenticated response.
- `202`: MFA challenge response, no cookie.

New route schemas:

```text
POST   /auth/mfa/totp/verify-login
POST   /auth/mfa/totp/setup
POST   /auth/mfa/totp/confirm
POST   /auth/mfa/totp/setup-challenge
POST   /auth/mfa/totp/confirm-challenge
DELETE /auth/mfa/totp
```

All request fields that carry TOTP code must be strings with tight length
limits. Do not accept numbers; leading zeroes are valid TOTP digits.

### 5.2 Organization security routes

Add `server/src/routes/organizationSecurity.ts` and register it in
`server/src/server.ts`.

```text
GET   /organization/security
PATCH /organization/security
```

Response includes `(API)` values only:

- `mfa_required`
- current user's MFA enabled state
- optional `members_without_mfa_count` for admin view

### 5.3 Shared types

Add zod source types under `server/src/types/` and JSDoc mirrors under
`platform/types/`.

Expected entities:

- `authMfa`
- `organizationSecurity`

Update `test/sync_shared_types.mjs` registry. Entity count is currently 15;
do not fake extra entities just to hit a number.

---

## 6. Frontend Plan

Frontend starts only after repo, service, route, and shared type tests pass.

Pages affected:

- `platform/login.html`
- `platform/settings.html`
- `platform/api.js`
- maybe `platform/_shared.js` if settings nav labels need security status

Data boundary:

- login challenge state is `(API)`.
- organization MFA required setting is `(API)`.
- current user's MFA enabled status is `(API)`.
- any QR rendering helper state is local UI state, not demo data.

XSS gate:

- `otpauth_uri`, manual secret, org name, user email, and all server-returned
  errors are server-returned fields. Use `textContent` or `escapeHtml`.
- Do not inject QR markup through raw `.innerHTML` with server values.

UX requirements:

- login page shows second-step TOTP input after `202`.
- org-required users without MFA can complete setup without receiving an access
  token first.
- settings page allows enabling/disabling user TOTP.
- admin settings allow toggling org required MFA.
- no marketing/hero layout. Keep dense SaaS dashboard styling.

---

## 7. Tests / Validation

Required command baseline:

```powershell
npm --prefix server run typecheck
npm --prefix server test
node test/sync_shared_types.mjs
node test/phase_3_e2e.mjs
```

Additional route tests:

- password-only login in MFA required org returns `202` and no cookie/access.
- TOTP verify with valid challenge returns access token and refresh cookie.
- wrong TOTP increments counter and eventually locks.
- expired/invalid challenge is rejected without creating session.
- refresh for non-MFA session after org required toggle does not issue access.
- authenticated setup/confirm enables MFA and marks current session verified.
- disable fails while org requires MFA.
- org security toggle is admin-only.
- cross-org attempts do not expose whether another org has MFA required.

Relevant e2e:

- Phase 3 e2e must still pass: signup, verify, reset, invite flows cannot be
  broken by the new `auth_tokens` purpose or login response union.
- Add a focused Phase 7 MFA e2e only after route tests are stable. It should
  force deterministic TOTP secrets via test-only helper or DB fixture, not wall
  clock sleeps.

---

## 8. Documentation / Ops

Implementation/finding closeout should update:

- `docs/plan/phase-7/PHASE_7_MASTER.md`
- `docs/plan/phase-7/PHASE_7_STEP_2_FINDINGS.md`
- `server/README.md`
- root `README.md`
- `server/.env.example`

Ops notes to include:

- `MFA_SECRET_ENCRYPTION_KEY` generation command.
- existing sessions issued before org MFA required may retain access until JWT
  expiry; refresh is blocked.
- WebAuthn and recovery codes are intentionally deferred.
- Support/reset procedure for a user who loses TOTP is not self-service in this
  step; admin recovery is a later security design item unless explicitly added.

---

## 9. Completion Criteria

Step 2 is complete when:

- [x] schema migration exists for MFA user/org/session/token fields.
- [ ] repo + unit tests cover MFA user state, sessions MFA fields,
      `mfa_challenge` token behavior, and org security reads/writes.
- [ ] TOTP and MFA secret encryption helpers are tested.
- [ ] password-only login in MFA-required org issues no access token and no
      refresh cookie.
- [ ] valid TOTP challenge creates an MFA-verified session.
- [ ] refresh does not issue access for a non-MFA session once org MFA is
      required.
- [ ] authenticated user can setup/confirm/disable TOTP under documented rules.
- [ ] admin can read/update org MFA required setting.
- [ ] shared types are synced.
- [ ] frontend login/settings flows are wired without XSS gates.
- [ ] `npm --prefix server run typecheck` PASS.
- [ ] `npm --prefix server test` PASS.
- [ ] `node test/sync_shared_types.mjs` PASS.
- [ ] `node test/phase_3_e2e.mjs` PASS.
- [ ] Phase 7 MFA focused e2e PASS if added.
- [ ] findings document written by implementer and Codex validation recorded.

---

## 10. Next Implementation Order

1. Review the committed MFA schema against this plan. If schema changes are
   needed, add a forward migration rather than rewriting the committed one.
2. Update `auth_tokens`, `sessions`, user MFA repository, and organization
   security repository with unit tests.
3. Add TOTP + MFA secret encryption helpers with unit tests.
4. Change auth service login result to support MFA challenge without sessions.
5. Add MFA verify/setup/disable services and route tests.
6. Add organization security routes and shared types.
7. Run backend checks and Phase 3 e2e.
8. Wire `login.html` and `settings.html`.
9. Run full required validation.
10. Implementer writes `PHASE_7_STEP_2_FINDINGS.md`; Codex reviews, validates,
    and handles scoped commit/push if approved.

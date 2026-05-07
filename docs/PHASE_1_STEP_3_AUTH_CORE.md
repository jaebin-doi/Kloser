# Phase 1 Step 3 — Auth 코어

> **상위 계획**: `docs/PHASE_1_MASTER.md` §3 Step 3.
> **선행**: Step 2 완료 — `docs/PHASE_1_STEP_2_RLS_CONTEXT.md`, `docs/PHASE_1_STEP_2_FINDINGS.md`.
> **기간**: 3~4일.

---

## 진행 상태

- [ ] 1. Step 2 baseline 재검증 (`npm --prefix server test`, typecheck)
- [ ] 2. 인증 의존성 추가 (`@fastify/jwt`, `@fastify/cookie`, Argon2id 구현용 패키지)
- [ ] 3. env 계약 추가 (`JWT_SECRET`, `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL`, cookie 설정)
- [ ] 4. sessions 스키마 보강 migration (refresh rotation family/reuse detection)
- [ ] 5. seed password를 Argon2id hash로 갱신
- [ ] 6. auth repository/service 작성
- [ ] 7. auth plugin/middleware 작성 (`request.user`, `requireAuth`, `requireRole`)
- [ ] 8. routes 작성 (`/auth/signup`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `/me`)
- [ ] 9. `orgContext`를 JWT 우선으로 전환하고 prod에서 `X-Org-Id` 차단
- [ ] 10. auth 테스트 작성 (login/refresh/logout/me/role/RLS)
- [ ] 11. Phase 0.5 e2e 회귀 영향 정리
- [ ] 12. `docs/PHASE_1_STEP_3_FINDINGS.md` 작성

---

## 0. 목적

Step 3는 "로그인한 사용자가 어느 조직에서 어떤 권한으로 요청하는가"를 서버가 신뢰할 수 있게 만드는 단계다.

완료 후 서버는 다음을 보장해야 한다.

1. password는 Argon2id로만 검증한다.
2. access token은 짧게 살고, refresh token은 DB session row와 묶여 회전한다.
3. 모든 org-scoped 요청은 JWT에서 검증된 `orgId`로 `withOrgContext`에 들어간다.
4. prod에서는 클라이언트가 보낸 `X-Org-Id`를 신뢰하지 않는다.
5. role guard는 `memberships.role` 기준으로 동작한다.

---

## 1. Step 3 사전 결정 6건

| 항목 | 결정 | 근거 |
|---|---|---|
| 액세스 토큰 전달 | **Authorization Bearer**. access token은 응답 body로 내려주고 클라이언트 메모리에 둔다. | Step 4의 WebSocket handshake에서 같은 토큰을 `auth.token`으로 넘기기 쉽다. HttpOnly access cookie는 WS와 desktop 확장 시 경계가 흐려진다. |
| refresh token 저장·회전 | **DB `sessions` 저장 + 매 refresh마다 rotation + family reuse detection**. refresh token 원문은 한 번만 발급하고 DB에는 hash만 저장한다. | sessions 테이블이 이미 refresh rotation 용도로 존재한다. 탈취된 구 refresh token 재사용 시 같은 family를 전부 revoke할 수 있어야 한다. |
| 만료 시간 | **access 15분 / refresh 30일**. env로 override 가능. | 운영에서 흔한 기본값. access 탈취 blast radius를 줄이고, refresh는 UX를 유지한다. |
| signup 모델 | **self-service signup = 새 organization 생성 + 가입자를 admin으로 membership 생성**. invitation 기반 가입은 Phase 3. | 아직 email/invitation 발송 인프라가 없다. Phase 1은 auth core와 live flow unblock이 목적이다. |
| role guard 범위 | **org role 한정** (`admin`, `manager`, `employee`, `viewer`). global admin은 도입하지 않는다. | 현재 schema에 global role이 없고, multi-tenant 격리 모델은 memberships 기준이다. 운영자/슈퍼어드민은 별도 admin plane 설계가 필요하다. |
| WS 인증 포함 여부 | **Step 3에서는 토큰 발급/검증 함수까지만 준비, WS handshake 적용은 Step 4**. | Step 4가 client wiring 범위다. Step 3에서 WS까지 묶으면 live.html, `platform/api.js`, e2e 수정이 같이 끌려와 경계가 커진다. |

---

## 2. 범위

### 한다

- Argon2id password hashing/verify 도입
- JWT access token 발급/검증
- refresh token opaque random value 발급, hash 저장, rotation
- refresh token family reuse detection
- session repository/service
- signup/login/refresh/logout/me routes
- role guard middleware
- `orgContext`의 JWT 우선 전환
- prod 환경에서 `X-Org-Id` fallback 차단
- auth 테스트와 기존 RLS 테스트 회귀

### 안 한다

- WebSocket handshake에 token 적용 (Step 4)
- `platform/api.js`와 `live.html` 통합 (Step 4)
- invitations/email verification/password reset (Phase 3)
- global admin/admin console
- OAuth/SSO/SAML
- CSRF 토큰 미들웨어 전체 도입
- **기존 라우트(`/health`, `/calls` WS namespace 등)에 auth 부착 — Step 3는 신규 `/auth/*` + `/me`만 추가**. Phase 0.5 e2e가 Step 3 동안 그대로 통과해야 한다. WS handshake 인증은 Step 4에서 일괄 적용.

---

## 3. 토큰/세션 설계

### Access JWT

Payload:

```ts
{
  sub: string;          // user id
  orgId: string;        // active org id
  membershipId: string;
  role: "admin" | "manager" | "employee" | "viewer";
  sid: string;          // current refresh session id
}
```

검증 규칙:

- `JWT_SECRET` 없으면 server boot fail-fast.
- `sub`, `orgId`, `membershipId`, `sid`는 UUID 형식 재검증.
- `role`은 membership role enum 재검증.
- access token만으로 DB session active 여부를 매 요청 조회하지 않는다. 짧은 TTL로 처리한다.
- 민감한 write endpoint가 생기면 필요 시 `sid` active check를 opt-in으로 추가한다.

### Refresh Token

- 원문: `crypto.randomBytes(32).toString("base64url")`
- 저장: `sha256(refreshToken)` hex
- 전달: browser는 HttpOnly cookie 사용. 테스트/desktop 확장 여지를 위해 service 내부는 원문 문자열을 반환하되 route가 cookie에 싣는다.
- cookie 기본값: `HttpOnly`, `SameSite=Lax`, prod에서 `Secure`, path는 `/auth/refresh`와 `/auth/logout` 중심으로 제한 검토.

### Rotation

로그인:

1. user/password 검증
2. active membership 선택
3. session row 생성 (`token_family_id = gen_random_uuid()`)
4. access token + refresh cookie 발급

refresh (한 트랜잭션 안에서, 동일 row를 두 요청이 동시에 처리하지 못하도록 row-level lock 사용):

1. `BEGIN`
2. `SELECT ... FROM sessions WHERE refresh_token_hash = $1 FOR UPDATE`
3. row가 없으면 `ROLLBACK` + 401
4. row가 revoked 상태면 같은 `token_family_id` 전체 revoke + `COMMIT` + 401 (reuse detection)
5. row가 만료됐으면 `ROLLBACK` + 401
6. old row revoke + new row 생성 (same family) + `COMMIT`
7. 새 access token + 새 refresh cookie 발급

`FOR UPDATE` 잠금이 없으면 두 탭이 동시에 같은 refresh token으로 `/auth/refresh`를 치는 race에서 둘 다 step 4의 reuse-detection 분기로 빠져 false-positive family revoke가 발생한다. 잠금으로 두 번째 요청을 첫 번째 트랜잭션 commit 이후에 평가시키면 두 번째는 step 4(이미 revoked)로 떨어져서 의도된 reuse detection으로 처리된다 — 이 경우는 실제 탈취 시도와 동일하게 family revoke되는 것이 맞다. 추가로 access token TTL이 15분이라 refresh 호출 빈도 자체가 낮다.

logout:

1. refresh cookie가 있으면 해당 session revoke
2. cookie clear
3. 이미 만료/누락이어도 idempotent 204

---

## 4. 스키마 보강

현재 `sessions`는 `refresh_token_hash`, `expires_at`, `revoked_at`까지 있다. reuse detection과 rotation history를 위해 migration을 추가한다.

```sql
ALTER TABLE sessions
  ADD COLUMN token_family_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN replaced_by_session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  ADD COLUMN last_used_at timestamptz,
  ADD COLUMN revoked_reason text;

CREATE INDEX sessions_token_family_id_idx ON sessions(token_family_id);
CREATE INDEX sessions_active_user_idx ON sessions(user_id, expires_at)
  WHERE revoked_at IS NULL;
```

주의:

- migration/seed는 계속 `MIGRATE_DATABASE_URL`만 사용한다.
- `sessions`는 아직 RLS가 없다. auth repository는 user/session guard를 직접 건다.
- refresh token hash unique index는 유지한다.

---

## 5. 파일 변화

```text
server/
├── package.json                         # dependencies/scripts 갱신
├── .env.example                         # JWT/cookie TTL 계약 추가
├── migrations/
│   └── 1715000001000_auth_sessions.sql  # sessions 보강
├── seeds/
│   └── 0001_demo.sql                    # Argon2id password_hash로 갱신
├── src/
│   ├── plugins/
│   │   └── auth.ts                      # @fastify/jwt + request.user
│   ├── middleware/
│   │   ├── auth.ts                      # requireAuth
│   │   ├── orgContext.ts                # JWT 우선, prod X-Org-Id 차단
│   │   └── role.ts                      # requireRole
│   ├── repositories/
│   │   ├── authUsers.ts                 # password_hash 포함 auth-only query
│   │   ├── memberships.ts               # getActiveByUserAndOrg 등 추가
│   │   └── sessions.ts                  # refresh/session repository
│   ├── routes/
│   │   ├── auth.ts                      # signup/login/refresh/logout
│   │   └── me.ts                        # GET /me
│   ├── services/
│   │   └── auth.ts                      # password/JWT/session orchestration
│   └── server.ts                        # auth/routes 등록
└── test/
    └── auth.test.mjs                    # auth core tests
```

---

## 6. Route 계약

### `POST /auth/signup`

Request:

```json
{
  "organizationName": "Acme Sales Inc.",
  "name": "Ada Admin",
  "email": "ada@example.com",
  "password": "..."
}
```

Response `201`:

```json
{
  "accessToken": "...",
  "user": { "id": "...", "email": "...", "name": "Ada Admin" },
  "organization": { "id": "...", "name": "Acme Sales Inc.", "plan": "starter" },
  "membership": { "id": "...", "role": "admin" }
}
```

Implementation note:

- `organizations`/`users`는 RLS 없음.
- `memberships` insert는 새 org id로 `set_config('app.org_id', $1, true)`를 세팅한 같은 transaction 안에서 실행한다.
- email 중복은 409.

### `POST /auth/login`

Request:

```json
{
  "email": "admin@acme.test",
  "password": "...",
  "orgId": "11111111-1111-1111-1111-111111111111"
}
```

Response `200`: signup과 같은 shape.

Rules:

- `orgId`는 **선택적**. 동작:
  - `orgId` 미지정 + 활성 membership 1개: 그 org로 자동 선택, 200.
  - `orgId` 미지정 + 활성 membership 2개 이상: **400** + body에 `{ error: "orgId required", availableOrgs: [{ id, name, role }, ...] }`. 클라이언트가 같은 자격증명으로 재요청 시 `orgId` 포함.
  - `orgId` 명시 + 해당 membership 존재: 200.
  - `orgId` 명시 + 해당 membership 없음: 401.
  - `orgId` 미지정 + 활성 membership 0개: 401.
- password 실패, disabled user, inactive membership은 401.
- org membership 없음은 401 또는 403 중 하나로 통일한다. 외부 관찰 가능성을 줄이려면 401 우선.
- multi-org user의 org picker UI 자체는 Step 4+. Step 3는 위 자동 선택 + 400 응답으로 dev/test 흐름이 막히지 않게 한다.

### `POST /auth/refresh`

Request body 없음. refresh cookie 사용.

Response `200`:

```json
{ "accessToken": "..." }
```

Rules:

- refresh cookie 없음: 401.
- revoked token 재사용: 같은 family revoke 후 401.

### `POST /auth/logout`

Request body 없음. refresh cookie가 있으면 revoke.

Response: `204`.

### `GET /me`

Authorization Bearer 필요.

Response `200`:

```json
{
  "user": { "id": "...", "email": "...", "name": "...", "avatar_url": null },
  "organization": { "id": "...", "name": "...", "plan": "pro" },
  "membership": { "id": "...", "role": "admin" }
}
```

Implementation note:

- `request.user.orgId`로 `withOrgContext`에 들어간다.
- `users.getByIdInCurrentOrg`, `organizations.getCurrentOrg`, `memberships.getById` 조합으로 조회한다.

---

## 7. Middleware 경계

### `requireAuth`

- `Authorization: Bearer <token>` 파싱
- JWT 검증
- payload shape validation
- `request.user = { id, orgId, membershipId, role, sessionId }`

### `orgContext`

Step 3에서 기존 `X-Org-Id` 동작을 바꾼다.

- `request.user?.orgId`가 있으면 그 값을 `request.orgId`로 사용
- prod에서 `X-Org-Id`가 오면 reject
- dev/test에서만 `X-Org-Id` fallback 허용
- fallback으로 받은 값도 UUID 검증

### `requireRole(...roles)`

- `request.user.role` 기준
- role hierarchy를 암묵 적용하지 않는다. 필요한 role set을 route가 명시한다.
- 예: `requireRole("admin", "manager")`

---

## 8. 테스트 계획

`server/test/auth.test.mjs`:

- signup creates org/user/admin membership and returns access token
- login rejects wrong password
- login accepts seeded Argon2id password
- `/me` rejects missing Bearer
- `/me` returns scoped user/org/membership with valid Bearer
- refresh rotates token and old token reuse revokes family
- logout revokes refresh session and clears cookie
- prod orgContext rejects `X-Org-Id` fallback
- dev orgContext still accepts `X-Org-Id` fallback for Step 2 tests
- role guard rejects viewer for admin-only handler

Regression:

- `npm --prefix server test` includes Step 2 tests + auth tests
- `npm --prefix server run typecheck`
- `node test/phase_0_5_e2e.mjs` may remain unauthenticated until Step 4. Step 3 findings must record whether it still passes or is expected to be replaced.

---

## 9. 위험·미정

| 항목 | 처리 |
|---|---|
| Argon2id native dependency on Windows | 우선 `argon2` 패키지를 검토. 설치/빌드가 막히면 `@node-rs/argon2`로 전환한다. |
| refresh cookie + CORS | 현재 Fastify CORS `credentials: true`. Step 3 route에서 cookie 속성은 env 기반으로 분기한다. |
| CSRF | access token은 Bearer라 일반 API는 CSRF 표면이 작다. refresh/logout은 cookie 기반이므로 SameSite=Lax와 origin 제한으로 Step 3 방어, 전용 CSRF token은 Step 4+에서 필요 시 추가. |
| sessions RLS 없음 | auth repository가 hash/user/session id로 직접 guard. org-scoped 데이터 접근은 `withOrgContext`로만 수행. |
| multi-org user의 org 선택 | Step 3은 login request의 `orgId`를 받는다. org picker UI는 Step 4+. |
| seed password | Step 3에서 반드시 Argon2id로 갱신. placeholder hash 상태로 login test를 쓰지 않는다. |
| `X-Org-Id` dev fallback | prod 차단 테스트를 먼저 넣는다. Step 4 이후 fallback 제거 여부 재검토. |

---

## 10. 완료 기준

- [ ] `npm --prefix server run typecheck` PASS
- [ ] `npm --prefix server test` PASS (Step 2 10개 + auth tests)
- [ ] `npm --prefix server run db:migrate:up` PASS
- [ ] `npm --prefix server run db:seed` PASS, seed users가 Argon2id password로 login 가능
- [ ] signup/login/refresh/logout/me route가 Fastify inject 테스트로 검증됨
- [ ] refresh rotation에서 구 token 재사용 시 family revoke 검증됨
- [ ] prod 환경에서 `X-Org-Id` fallback 차단 검증됨
- [ ] role guard 403 검증됨
- [ ] `docs/PHASE_1_STEP_3_FINDINGS.md` 작성

---

## 11. 한 줄 요약

> Step 3는 Argon2id + Bearer access JWT + HttpOnly refresh cookie/session rotation을 깔고, Step 2의 dev-only org header를 JWT 기반 org context로 교체해서 실제 인증 경계를 만든다.

# Phase 3 Step 3 — 비밀번호 재설정 service / route

> **상위 계획**: `docs/plan/phase-3/PHASE_3_MASTER.md` §3 Step 3 + §2-6·17.
> **선행**: Step 2 완료 — `PHASE_3_STEP_2_FINDINGS.md`. service credential / `consumeToken(client,...)` / `EmailProvider.sendPasswordResetEmail` / `mintToken` / `invalidateActiveTokens` / `GRANT UPDATE ON sessions` 인프라 모두 깔린 상태.
> **기간**: 0.5일 (Step 2 인프라 재사용으로 작업량 적음).

---

## 진행 상태

- [ ] 1. forgot/reset 두 endpoint의 pool / 응답 / org 선택 정책 사전 결정 (본 plan §1)
- [ ] 2. `services/auth.ts` 확장 — `requestPasswordReset({email})` (app pool) + `resetPassword({rawToken, newPassword})` (servicePool wrapper)
- [ ] 3. `services/auth.ts` 보조 — `revokeAllActiveSessionsForUser(client, userId, reason)` 헬퍼 (또는 inline SQL)
- [ ] 4. `POST /auth/password/forgot` route — anonymous, 항상 200
- [ ] 5. `POST /auth/password/reset` route — anonymous, 410 generic 매핑 재사용
- [ ] 6. shared types — `password-reset` entity 등록 (`ForgotPasswordInput` + `ResetPasswordInput`)
- [ ] 7. 단위 테스트 ~9 cases — enumeration / outbox / session revoke / token reuse / expired / new password 로그인
- [ ] 8. `npm --prefix server run typecheck` PASS
- [ ] 9. `npm --prefix server test` PASS — 신규 ~9 + 회귀 87 = ~96
- [ ] 10. `node test/sync_shared_types.mjs` PASS — `password-reset` entity 추가 후
- [ ] 11. Phase 0.5 / Phase 2 e2e 회귀 PASS
- [ ] 12. 수동 검증 — forgot → outbox에서 token 추출 → reset → 옛 refresh 401 → 새 password로 login 200
- [ ] 13. `PHASE_3_STEP_3_FINDINGS.md` 작성

---

## 0. 목적

Master §1 "분실 비밀번호 자가 복구"의 두 endpoint를 깐다. Step 2의 패턴 (`consumeToken(client, ...)` + wrapper-owned transaction + `EmailProvider` + servicePool)을 재사용해 신규 인프라 추가는 없다. Step 3가 끝나면:

- 사용자가 `POST /auth/password/forgot {email}` 호출 시 (a) 존재하는 user면 sha256 hash가 박힌 1h TTL 토큰을 mint하고 outbox에 메일 발송, (b) 존재하지 않는 email이면 outbox 변화 없이 같은 응답 → enumeration 차단
- `POST /auth/password/reset {token, newPassword}` 호출 시 token 소비 + password_hash 갱신 + 해당 user의 모든 활성 세션 revoke를 **단일 servicePool 트랜잭션** 안에서 처리 → partial state 0건
- 외부 응답: token 실패 사유는 모두 `410 token_invalid_or_expired`로 통합 (Step 2 §7 정책 그대로)

Step 4 (`/team/members` + `requireFreshRole`) / Step 5 (invitations)와 무관 — Step 3는 외부 자체 완결적.

---

## 1. 사전 결정 lock-ins

| 항목 | 결정 | 근거 |
|---|---|---|
| 1. `/auth/password/forgot` pool | **app pool** (`withTransaction` 재사용) | server-side에서 email → user → membership.org_id 조회 가능하므로 GUC + RLS 패턴이 자연. BYPASSRLS 표면 확장 없음. Step 2 plan §1 Pool 사용 규칙 표와 정합 |
| 2. `/auth/password/reset` pool | **servicePool** | anonymous, raw token이 유일한 server-side identity. Step 2 `verifyEmail` wrapper와 동일 패턴 — servicePool tx 1개가 consume + 도메인 변경을 묶음 |
| 3. forgot이 user 못 찾았을 때 | **outbox 변화 없이 200 `{ ok: true }`** 반환. throw 없음 | Master §17 enumeration 차단. 응답 status / body / 응답 시간이 user 존재 여부에 의존하지 않도록 한다 (시간 측면은 Phase 6+에서 정밀 rate-limit과 함께) |
| 4. forgot이 disabled user (`users.disabled_at IS NOT NULL`) 또는 활성 membership 0건이면 | **token mint / outbox 발송 모두 skip → 200 `{ ok: true }`** | enumeration 차단 + disabled 계정 복구 불가 (recovery는 비즈니스 정책. 운영자가 disabled를 해제하면 자연스럽게 복구 가능). Master §11 disabled 정책 정합 |
| 5. forgot 시 org 선택 (user가 multi-org일 때) | **활성 membership 중 `created_at` ASC 첫 번째 org_id를 사용**. token의 org_id로 박힘 | reset 흐름은 org-scoped 데이터를 건드리지 않으므로 어느 org를 박아도 기능적 영향 없음. 하지만 RLS WITH CHECK / 향후 admin 콘솔 audit 등에서 org가 명확해야 함. created_at ASC = "처음 가입한 org" 의미라 사용자 직관과 일치 |
| 6. forgot 시 기존 활성 password_reset 토큰 처리 | **`invalidateActiveTokens({client, userId, purpose:'password_reset'})` 후 새 토큰 mint** | UNIQUE partial 인덱스 `auth_tokens_user_purpose_active_idx` 제약. resend semantics — 사용자가 두 번 클릭해도 마지막 클릭이 유효 |
| 7. password_reset 토큰 TTL | **1시간** (Master §2-6) | 분실 흐름은 즉시 진행 가정. 본 plan에서 Step 2의 `TTL_PASSWORD_RESET_MS` 상수 그대로 사용 |
| 8. reset 시 newPassword 검증 | **최소 8자, 최대 1024자** (signup 입력 검증과 동일) | shared types에서 zod로 검증. signup과 같은 정책이라 보안 정책 분기 없음 |
| 9. reset 성공 시 세션 처리 | **해당 user의 모든 `revoked_at IS NULL` 세션을 `revoked_at = now(), revoked_reason = 'password_reset'`** 한꺼번에 UPDATE | refresh token이 유출됐다는 전제로 reset이 호출됨. 옛 refresh / 옛 session 전부 무효화. 단일 트랜잭션 안에서 token consume + password update + session revoke 묶음 |
| 10. access token (JWT) 무효화 | **별도 조치 없음** — 자연 만료 (`ACCESS_TOKEN_TTL=15m`) | JWT는 서버가 능동 폐기 못 함 (DB lookup 없는 stateless 검증). 옛 refresh가 즉시 막히므로 access 만료 후 재로그인 강제됨. 본 trade-off는 Phase 1의 access-token 모델과 동일하며 본 plan에서 추가 변경 없음. 운영 차원 강한 무효화는 Phase 6+ session-id 기반 검증 도입 시 |
| 11. reset 응답 | **200 `{ ok: true }`**. 새 access token / refresh cookie 발급 안 함 | reset은 비밀번호 복구만 처리. 사용자가 reset 페이지에서 그대로 `/auth/login`을 새 비밀번호로 호출하는 것이 자연스러운 UX. cookie 발급은 호출자 (Step 6 client wiring) 책임 |
| 12. 외부 token 실패 응답 | **`410 token_invalid_or_expired` generic**. token_not_found / token_already_used / token_invalidated / token_expired 4 코드 모두 통합 | Step 2 §7 정책 그대로. route handler `sendVerifyError` 헬퍼를 password reset에도 그대로 사용 가능 (이름은 변경 검토) |
| 13. forgot의 email 검증 | **zod에서 `z.string().min(3).max(320)`** — RFC 5321 식 strict 검증 없음 | signup과 동일 정책. server-side 강한 검증은 Phase 6+. 본 endpoint는 enumeration 회피가 우선이라 잘못된 형식의 email도 200 응답 가능 |
| 14. forgot rate-limit | **본 step에서 미적용**. Phase 6+ | Master §17. 본 step은 응답 형태 통일까지만. 실제 IP / email 단위 throttle은 운영 진입 단계 |
| 15. forgot이 미인증 user (`email_verified_at IS NULL`)에 대해 동작하는지 | **동작함** — verified 여부와 무관 | 복구 흐름은 verified gate에 막히면 안 됨. 이메일이 처음부터 정상 도달 안 했을 수도 있어서 reset → 새 비밀번호 → 재로그인 → resend verify 흐름도 합리적 |

---

## 2. `/auth/password/forgot` — service + route

### 2.1 service: `requestPasswordReset(input: { email: string }): Promise<void>`

(`services/auth.ts`에 추가)

**중요 — `memberships`는 RLS 대상**: GUC 없이 `SELECT FROM memberships`는 0 rows. login 흐름이 이미 같은 문제를 풀고 있다 (`listActiveMembershipsAcrossOrgs`가 organizations를 순회하며 org별 GUC 설정 후 membership 조회). 본 step에서 그 함수를 `services/auth.ts` 내부에서 **export**하여 재사용한다 (Step 5 invitation accept에서도 같은 패턴이 다시 필요해질 가능성 高).

```ts
// services/auth.ts 본 step에서 추가하는 export
export { listActiveMembershipsAcrossOrgs };  // 기존 file-private을 공개

// services/auth.ts requestPasswordReset 본체
export async function requestPasswordReset(input: { email: string }): Promise<void> {
  await withTransaction(async (client) => {
    // 1) email → user. users는 RLS 비적용이므로 GUC 없이 lookup OK.
    const user = await getByEmailWithPasswordHash(client, input.email);
    if (!user)         return;   // unknown email — enumeration 차단
    if (user.disabled_at) return; // 전역 disabled — 복구 거부

    // 2) org 순회로 활성 membership 조회 (RLS 우회 위해 setOrgContext 필요).
    //    organizations.created_at ASC 정렬은 listActiveMembershipsAcrossOrgs
    //    내부에 이미 박혀 있어 사용자 가입 순서대로 첫 org를 자연 선택.
    const memberships = await listActiveMembershipsAcrossOrgs(client, user.id);
    if (memberships.length === 0) return;  // 활성 membership 0건 — 복구 거부

    const { organization } = memberships[0]!;
    const orgId = organization.id;

    // listActiveMembershipsAcrossOrgs가 마지막에 set한 GUC가 그대로 살아 있을
    // 수 있지만 명시적으로 한 번 더 호출해 의도를 분명히 한다.
    await setOrgContext(client, orgId);

    // 3) 기존 활성 password_reset 토큰 invalidate (UNIQUE partial 충돌 회피)
    await invalidateActiveTokens({
      client,
      userId:  user.id,
      purpose: "password_reset",
    });

    // 4) 새 토큰 mint (TTL 1h — Master §2-6)
    const fresh = await mintToken({
      client,
      orgId,
      userId:  user.id,
      purpose: "password_reset",
      ttlMs:   TTL_PASSWORD_RESET_MS,
    });

    // 5) outbox 행 INSERT (같은 트랜잭션). EmailProvider가 client 받아
    //    같은 tx 안에서 INSERT — signup의 verification 메일과 동일 패턴.
    await emailProvider.sendPasswordResetEmail({
      client,
      orgId,
      toEmail:  user.email,
      toName:   user.name,
      resetUrl: buildResetUrl(fresh.rawToken),
      rawToken: fresh.rawToken,
    });
  });
}
```

**서비스의 throw 정책 (Codex review §3 반영)**:

| 케이스 | 처리 |
|---|---|
| user not found | `return` (no-op) — enumeration 차단 |
| user.disabled_at not null | `return` (no-op) — 복구 거부 |
| 활성 membership 0건 | `return` (no-op) — 복구 거부 |
| DB transient error / argon2 throw / EmailProvider throw | **`throw`** — route가 catch 안 하고 Fastify default handler가 500 |

즉 **expected no-op은 silent return, unexpected error는 그대로 throw**. enumeration 차단은 분기 4개에 한정되고, 운영 장애는 정상적으로 500으로 노출된다.

### 2.2 route: `POST /auth/password/forgot`

```ts
const FORGOT_BODY = {
  type: "object",
  required: ["email"],
  properties: { email: { type: "string", minLength: 3, maxLength: 320 } },
} as const;

app.post<{ Body: { email: string } }>(
  "/auth/password/forgot",
  { schema: { body: FORGOT_BODY } },
  async (request, reply) => {
    await requestPasswordReset({
      email: request.body.email.trim().toLowerCase(),
    });
    return reply.code(200).send({ ok: true });
  },
);
```

**`try/catch` 없음**: 서비스가 expected no-op은 silent return으로 처리하므로 unknown/disabled/no-active-membership 모두 정상 resolve → 200. DB transient / argon2 / EmailProvider 등 unexpected error는 throw 그대로 → Fastify default error handler가 500. 운영자는 50x 메트릭과 log stack으로 장애를 즉시 인지할 수 있고, 클라이언트는 500을 보고 재시도 / 사용자 안내 결정 가능.

enumeration 표면은 §2.1의 4 분기에만 한정됨 — 동일 표면 통과 후 (200 응답) timing-side enumeration은 Phase 6+ rate-limit / fixed-delay에서 다룬다.

---

## 3. `/auth/password/reset` — service + route

### 3.1 service: `resetPassword(input: { rawToken: string; newPassword: string }): Promise<void>`

(`services/auth.ts`에 추가, `verifyEmail` 바로 아래 위치)

```ts
export async function resetPassword(input: {
  rawToken: string;
  newPassword: string;
}): Promise<void> {
  const passwordHash = await hashPassword(input.newPassword);
  // hash는 트랜잭션 밖에서 미리 계산 — argon2가 무겁고 DB tx 안에서 돌면
  // connection을 비효율적으로 점유. token consume 시점 race는 hash 사용 직전
  // tx 안에서 잡힘.

  const client = await getServicePool().connect();
  try {
    await client.query("BEGIN");
    const consumed = await consumeToken(client, input.rawToken, "password_reset");
    if (!consumed.userId) {
      throw new AuthError(500, "reset_internal_inconsistency",
        "password_reset token missing user_id");
    }
    await client.query(
      `UPDATE users SET password_hash = $1 WHERE id = $2`,
      [passwordHash, consumed.userId],
    );
    await client.query(
      `UPDATE sessions
          SET revoked_at = COALESCE(revoked_at, now()),
              revoked_reason = COALESCE(revoked_reason, 'password_reset')
        WHERE user_id = $1
          AND revoked_at IS NULL`,
      [consumed.userId],
    );
    await client.query("COMMIT");
  } catch (err) {
    try { await client.query("ROLLBACK"); }
    catch (e) { client.release(e as Error); throw err; }
    client.release();
    throw err;
  }
  client.release();
}
```

**불변식**: token consume + password update + session revoke가 **단일 servicePool 트랜잭션**. 어느 단계에서든 fail 시 모두 rollback. argon2 hash는 트랜잭션 밖에서 미리 계산해 트랜잭션 길이 최소화.

### 3.2 route: `POST /auth/password/reset`

```ts
const RESET_BODY = {
  type: "object",
  required: ["token", "newPassword"],
  properties: {
    token:       { type: "string", minLength: 1, maxLength: 512 },
    newPassword: { type: "string", minLength: 8, maxLength: 1024 },
  },
} as const;

app.post<{ Body: { token: string; newPassword: string } }>(
  "/auth/password/reset",
  { schema: { body: RESET_BODY } },
  async (request, reply) => {
    try {
      await resetPassword({
        rawToken:    request.body.token,
        newPassword: request.body.newPassword,
      });
      return reply.code(200).send({ ok: true });
    } catch (err) {
      return sendVerifyError(reply, err);
    }
  },
);
```

`sendVerifyError`는 Step 2에서 정의된 헬퍼. 4 token 코드를 generic 410으로 매핑. **이름이 verify에 묶여 있어 다소 misleading** — 본 step에서 `sendTokenError`로 rename 권장 (별도 mini-change in 본 step commit).

---

## 4. Session revocation semantics

(1) `UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()), revoked_reason = COALESCE(revoked_reason, 'password_reset') WHERE user_id = $1 AND revoked_at IS NULL` — `COALESCE` 패턴은 Phase 1 `revokeSession` 함수와 정합 (이미 revoked된 row의 reason / timestamp를 덮어쓰지 않음).

(2) `revoked_reason = 'password_reset'` 상수는 운영 audit / debugging 시 의미 있음. 다른 revoke reason ('user_logout', 'token_reuse', 'admin_disabled' 등)과 구별 가능.

(3) 접근 토큰 (JWT) 무효화 trade-off:
- 본 plan §1-10 결정. JWT는 stateless라 능동 무효화 불가
- 옛 refresh 즉시 401 → 사용자는 다음 refresh 시도에서 막힘 → access TTL (15m) 만료 후 강제 재로그인
- Phase 6+에 session-id를 access verify 시점에 cross-check하는 옵션 검토 (보안 강화 vs request overhead). Phase 3 범위 외

(4) 세션 표가 RLS 비적용이라 servicePool로 직접 UPDATE 가능. migration 0008의 `GRANT SELECT, INSERT, UPDATE ON sessions TO kloser_service`가 이를 지원.

---

## 5. Enumeration / timing 회피 정책

### 본 step에서 처리

| 측면 | 처리 |
|---|---|
| HTTP status — expected 경로 | user 존재 여부 / disabled / no-active-membership 무관 모두 200. 분기 자체가 enumeration 표면 통일 |
| HTTP status — unexpected 경로 | DB / argon2 / EmailProvider throw 시 Fastify default 500. user-existence와 무관한 에러라 enumeration 표면 추가 없음 |
| Response body (200) | `{ ok: true }` 단일 — expected 분기 모두 동일 |
| Service의 expected no-op (unknown email / disabled / no-active-membership) | service가 silent `return` → route가 정상 200 응답. enumeration 표면 통일 |
| Service의 unexpected error (DB / argon2 / EmailProvider 등) | service throw → route가 catch 안 함 → Fastify default error handler가 **500**. 운영자가 50x 메트릭으로 즉시 인지. 사용자 enumeration 표면에는 노출 안 됨 (500은 정상 에러 응답일 뿐 user 존재 여부 정보 없음) |
| Token mint은 동기 | 결과적으로 응답이 약간 늦지만 분기 자체는 동일 코드 경로 |

### 본 step에서 처리 안 함 (Phase 6+)

| 측면 | 메모 |
|---|---|
| 응답 timing | user 존재 시 argon2 미실행 (forgot에서는 password hash 안 함, 단 mint+outbox 시간 있음). user 미존재 시 0 DB write로 빠름. 시간차로 enumeration 가능 — Phase 6+에서 fixed delay 또는 항상 dummy work 도입 |
| Rate limit | IP / email 단위 throttle 없음. 같은 사용자가 100번 호출 가능. Phase 6+ |
| CAPTCHA / proof-of-work | 도입 안 함. Phase 6+ |

본 step의 enumeration 차단은 **응답 패턴 통일까지만** — Master §17 정합. timing-based attack 방어는 별도 단계.

---

## 6. Shared types — `password-reset` entity 등록

`server/src/types/password-reset.ts` 신규:

```ts
import { z } from "zod";

export const ForgotPasswordInput = z.object({
  email: z.string().min(3).max(320),
});

export const ResetPasswordInput = z.object({
  token:       z.string().min(1).max(512),
  newPassword: z.string().min(8).max(1024),
});

export type ForgotPasswordInput = z.infer<typeof ForgotPasswordInput>;
export type ResetPasswordInput  = z.infer<typeof ResetPasswordInput>;
```

`platform/types/password-reset.js` 신규 (JSDoc 사본).

`test/sync_shared_types.mjs` ENTITY_REGISTRY 1 entry 추가:
```js
{
    name: "password-reset",
    server: "server/src/types/password-reset.ts",
    browser: "platform/types/password-reset.js",
    types: ["ForgotPasswordInput", "ResetPasswordInput"],
},
```

---

## 7. 단위 테스트 — `server/test/password_reset_routes.test.mjs`

새 파일 1개, ~9 cases. 새 user를 매 테스트마다 생성 (`pwresettest-` prefix) + afterEach가 prefix sweep — verify_routes.test.mjs 패턴 그대로 재사용.

### Forgot

1. `/auth/password/forgot {email: unknown@example.test}` → 200 `{ok:true}` + `email_outbox` 변화 없음 (count by template='password_reset' unchanged)
2. `/auth/password/forgot {email: known}` → 200 `{ok:true}` + `email_outbox` 1행 추가 (template='password_reset', body_text에 `token=` 포함)
3. 같은 user로 forgot 두 번 호출 → 옛 토큰 `invalidated_at` set + 새 토큰 활성 + outbox 2행
4. disabled user (`users.disabled_at` set) → 200 `{ok:true}` + `email_outbox` 변화 없음
5. response shape이 user 존재 여부와 무관하게 같음 — `JSON.stringify(unknown.json()) === JSON.stringify(known.json())` assert

### Reset

6. signup → forgot → outbox에서 token 추출 → `/auth/password/reset {token, newPassword}` → 200 + 같은 user의 옛 모든 sessions `revoked_at`+`revoked_reason='password_reset'` set
7. reset 성공 후 옛 refresh cookie로 `/auth/refresh` → 401 (refresh token이 revoked session을 참조)
8. reset 성공 후 새 password로 `/auth/login` → 200
9. **access token 무효화 trade-off 명시**: reset 직후 옛 access token으로 `/me` 호출 → **200** (JWT가 stateless라 본 step의 의도). 단위 테스트에서 이 동작을 assert하고 주석에 §1-10 trade-off를 참조. 운영 차원 강한 무효화는 Phase 6+
10. 같은 token으로 `/auth/password/reset` 두 번째 → 410 `token_invalid_or_expired`
11. 만료된 토큰 (`auth_tokens.expires_at` 과거로 hack) → 410 generic
12. 알 수 없는 token → 410 generic
13. newPassword 7자 → 400 schema 검증
14. token 누락 → 400 schema 검증

`afterEach`는 `DELETE FROM organizations WHERE name LIKE 'pwresettest-org-%'` + `DELETE FROM users WHERE email LIKE 'pwresettest-%@example.test'` — Step 2 verify_routes 패턴.

---

## 8. 위험·미정

| 항목 | 처리 |
|---|---|
| forgot 응답 timing이 user 존재 여부에 의존 | 본 plan §5 — Phase 6+ fixed delay. 본 step에서 응답 status / body만 통일 |
| forgot의 unexpected error (DB / argon2 / EmailProvider) 노출 정책 | route는 try/catch 없음. unexpected throw는 Fastify default가 500으로 응답. 운영자가 50x 메트릭으로 즉시 인지하고, 사용자는 정상 에러 응답을 받음. expected no-op (unknown/disabled/no-active-membership)만 service 안에서 silent return → 200. §5 정책 표 정합 |
| reset의 argon2 hash가 tx 안에서 돌면 connection 점유 | `hashPassword` 호출을 `connect()` 이전으로 빼서 회피. consume 시점에 race가 일어나면 throw로 잡힘 — hash 시간 손실은 있지만 정확성에는 영향 없음 |
| reset이 invalid token에도 argon2 비용 (수십~수백 ms) 발생 — DoS / probing 표면 | hashPassword가 consume 이전에 실행되는 구조라 token 검증 전에 hash 비용을 무조건 지불. token format 사전 검증 (zod min 1) 외 추가 차단 없음. **Phase 6+ rate-limit 도입 시점에 token 형식·존재 사전검증 후 hash 실행 같은 fast-path 검토**. 본 step에서는 정확성·단순성 우선이라 trade-off 수용 |
| reset 직후 옛 access token이 15m까지 유효 — Master plan 완료 기준과 정합 필요 | 본 plan §1-10, §4-(3), 단위 테스트 §7 #9에서 명시. **본 step plan과 함께 `PHASE_3_MASTER.md` Step 3 완료 기준 문구도 동시 갱신 완료** (옛 refresh 401, 옛 access는 자연 만료). Phase 6+ session-id cross-check 도입 시 강화 |
| 활성 membership 0건인 user (disabled per-org)는 복구 불가 | 의도된 정책 (§1-4). 운영자가 disabled 해제하면 다음 forgot에서 동작 |
| forgot이 multi-org user의 org_id 선택을 created_at ASC로 잡음 — 운영 정책 변경 시 | 본 plan에 결정 명시. token의 org_id는 audit 용도라 변경해도 reset 기능 자체 영향 없음 |
| `sendVerifyError` 함수명이 verify에 묶여 있어 password reset에서 호출 시 misleading | 본 step commit에서 `sendVerifyError` → `sendTokenError`로 rename. 호출처 (verify, reset 2개) 모두 갱신 |
| forgot tx가 outbox INSERT까지 한 트랜잭션 — Phase 6+ 외부 SMTP 어댑터로 전환 시 비전사적 | Step 2 finding §3과 동일. transactional outbox pattern (commit 후 별도 워커가 발송)으로 전환 시 EmailProvider 인터페이스 미세 조정 |
| 같은 user의 forgot을 연달아 호출 시 마지막만 유효 | 의도된 정책 (UNIQUE partial이 강제). 단위 테스트 §7 #3이 검증 |
| email 입력의 trim/lowercase 일관성 | route가 `email.trim().toLowerCase()` 적용. citext 컬럼이지만 lookup 시 case-insensitive 보장 위해 명시 |

---

## 9. 완료 기준 (Step 3 — go/no-go)

- [ ] `services/auth.ts`에 `requestPasswordReset` + `resetPassword` 함수 추가
- [ ] `routes/auth.ts`에 `/auth/password/forgot` + `/auth/password/reset` 라우트 추가
- [ ] `sendVerifyError` → `sendTokenError` rename (호출처 2곳 갱신)
- [ ] `server/src/types/password-reset.ts` + `platform/types/password-reset.js` + sync registry 추가
- [ ] `npm --prefix server run typecheck` PASS
- [ ] `npm --prefix server test` — 신규 ~9 cases PASS + Step 1·2 회귀 87 PASS = ~96 total
- [ ] `node test/sync_shared_types.mjs` PASS (`customers`, `signup`, `password-reset`)
- [ ] `node test/phase_0_5_e2e.mjs` 16/16 회귀 PASS
- [ ] `node test/phase_2_customers_e2e.mjs` 7/7 회귀 PASS
- [ ] 수동 검증: signup → forgot → outbox token 추출 → reset → 옛 refresh로 `/auth/refresh` 401 → 새 password로 `/auth/login` 200
- [ ] `docs/plan/phase-3/PHASE_3_STEP_3_FINDINGS.md` 작성

---

## 10. 한 줄 요약

> **0.5일 동안 `/auth/password/forgot` (app pool, enumeration-safe 항상 200) + `/auth/password/reset` (servicePool wrapper로 consume + password update + sessions revoke 단일 tx)을 깐다. Step 2 인프라 (consumeToken / mintToken / EmailProvider / servicePool / GRANT UPDATE sessions) 전부 그대로 재사용 — 신규 DB / pool / 풀 분리 변경 없음.**

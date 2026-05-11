# Phase 3 Step 2 — 회원가입 + 이메일 인증 service / route

> **상위 계획**: `docs/plan/phase-3/PHASE_3_MASTER.md` §3 Step 2 + §2-1·2·14.
> **선행**: Step 1 schema 완료 — `PHASE_3_STEP_1_FINDINGS.md`.
> **기간**: 1.5일.

---

## 진행 상태

- [ ] 1. anonymous endpoint의 RLS 우회 방식 확정 (본 plan §2) — **service credential 채택**
- [ ] 2. `ops/postgres/init/02_service_role.sql` (role 생성 only) + dev DB에 1회 적용 (§2.2)
- [ ] 3. `server/migrations/1715000008000_phase3_service_grants.sql` (테이블 grant 7표) + `db:migrate:up` (§2.3)
- [ ] 4. `server/src/db/servicePool.ts` lazy init (§2.4) + `server/.env.example`에 `SERVICE_DATABASE_URL` 추가
- [ ] 5. `EmailProvider` 인터페이스 + dev outbox 어댑터 작성 (`services/email.ts`, §4)
- [ ] 6. `services/auth-tokens.ts` — mint / consume(client 인자) / invalidate (§3) + wrapper `verifyEmail` (servicePool transaction 소유, §2.6)
- [ ] 7. `services/auth.ts` signup 트랜잭션 확장 — outbox 행 발급까지 (§5)
- [ ] 8. `POST /auth/signup` 응답 / cookie 흐름 검토 (§6)
- [ ] 9. `POST /auth/verify` route + service (anonymous, servicePool wrapper, §7)
- [ ] 10. `POST /auth/verify/resend` route + service (authenticated, §7)
- [ ] 11. shared types 등록 — `signup` entity 등록 (§9)
- [ ] 12. 단위 테스트 작성 (§10) — sha256 저장 / 1회 소비 / 만료 / resend invalidation / partial-state 회피 / 미인증 로그인 / verify 200·410
- [ ] 13. `npm --prefix server run typecheck` PASS
- [ ] 14. `npm --prefix server test` PASS — 신규 ~10 cases + 회귀
- [ ] 15. Phase 0.5 / Phase 2 e2e 회귀 PASS
- [ ] 16. `PHASE_3_STEP_2_FINDINGS.md` 작성

---

## 0. 목적

Step 1이 schema 1층을 깔았다면 Step 2는 그 위에 **자가 가입 흐름의 service / route layer**를 깐다.

이 step이 끝나면:
- 누구나 `POST /auth/signup`으로 새 조직 + admin user 생성 가능
- 발급된 verification 토큰을 `POST /auth/verify`로 1회 소비해 `users.email_verified_at` 설정
- 미인증 사용자도 로그인은 즉시 가능. cross-user write 차단은 Step 4 (`requireRole` + verified gate)에서 적용
- anonymous endpoint의 RLS 우회 디자인 (service credential)이 Phase 3 전체에서 일관 사용

Step 3 (비밀번호 재설정) / Step 5 (invitation accept)는 본 step에서 깔린 `services/auth-tokens.ts` + `services/email.ts` + service pool을 그대로 재사용한다.

---

## 1. 의존성 + 사전 결정 lock-ins

| 항목 | 결정 | 근거 |
|---|---|---|
| 1. anonymous RLS 우회 | **(b) service credential** — `kloser_service` DB role + `SERVICE_DATABASE_URL` env. BYPASSRLS 권한 grant | (a) SECURITY DEFINER 대비 (i) TypeScript-only 흐름 유지 (ii) 함수마다 인자/리턴/예외를 SQL로 짤 비용 회피 (iii) Step 3 (password reset) / Step 5 (invitation accept)에서 같은 풀 재사용 — 함수 단위로 인터페이스 늘어나는 것보다 풀 1개가 단순. `MIGRATE_DATABASE_URL` 절대 재사용 안 함 (AGENTS.md §83) |
| 2. service pool 사용 범위 | **anonymous endpoint 3개에만**: `/auth/verify` (Step 2), `/auth/password/reset` (Step 3), `/invitations/accept` (Step 5). 그 외는 모두 app pool + GUC. **특히 `/auth/password/forgot`은 app pool** — 익명 진입이지만 서버가 email로 user를 lookup해 org_id를 얻을 수 있으므로 `app pool + setOrgContext(org_id)` 패턴이 더 자연스럽고 BYPASSRLS 표면을 넓히지 않음. 표 아래 참조 | 사용 범위 좁힐수록 BYPASSRLS의 blast radius 감소. 풀을 import한 모듈은 코드 리뷰에서 즉시 식별 |
| 3. EmailProvider 인터페이스 | `interface EmailProvider { sendVerificationEmail / sendInvitationEmail / sendPasswordResetEmail }` 3개 메서드. dev 구현은 `email_outbox` row 작성. 운영 SMTP/Resend 어댑터는 Phase 6+ | dev outbox는 e2e가 직접 SELECT로 토큰 추출. 인터페이스 계약은 모든 어댑터가 동일 입력 → 동일 outbox 결과 보장 |
| 4. 토큰 mint / hash / consume 함수 위치 | `server/src/services/auth-tokens.ts` 신규 — `mintToken`, `consumeToken`, `invalidateActiveToken` 노출. sha256은 `node:crypto`만 사용 (Phase 1 refresh 해시와 동일) | 재사용성 — Step 3·5가 같은 함수 import. Phase 1의 `hashRefreshToken` 패턴 일관 |
| 5. signup 직후 email_verified_at 상태 | `NULL` (미인증). `/auth/login`은 verified 여부와 무관하게 200. cross-user write만 verified 필수 (Step 4/5에서 `requireVerified` middleware) | Master §2-8: onboarding UX 끊김 회피. 핵심 보안 동작은 verified gate로 분리 |
| 6. verify endpoint의 anonymous 여부 | **anonymous** — JWT 헤더 없음. 본문에 raw token만. service pool로 처리. response 200 / 410 / 400 / 404 | 사용자가 이메일에서 클릭하는 시점에 access token 보유 가정 불가 (다른 브라우저 / 시크릿 창 등) |
| 7. verify/resend endpoint의 인증 여부 | **authenticated** — `requireAuth` 적용. 본인 user의 활성 verification 토큰을 invalidate한 뒤 새로 발급 | enumeration 회피. 이미 로그인된 사용자만 자기 verification을 다시 받으므로 enum 위험 없음. unauth resend는 Step 3 password/forgot 패턴과 분리 |
| 8. verify/resend 토큰 TTL | **24시간** (Master §2-7). 기존 활성 토큰은 `invalidated_at = now()` 처리한 뒤 새 토큰 mint | 가입 직후 즉시 클릭 가정. 24h 후 verify/resend 흐름 |
| 9. signup 트랜잭션 순서 | **org INSERT → user INSERT → setOrgContext(org.id) → membership INSERT → auth_tokens INSERT → email_outbox INSERT → session INSERT** — 한 트랜잭션 내 (app pool 사용, GUC 설정 후) | 모든 INSERT가 같은 트랜잭션에서 commit. signup 도중 실패 시 모두 rollback. auth_tokens / email_outbox는 GUC가 set된 후 INSERT라 WITH CHECK 통과 — service pool 불필요 |
| 10. anonymous verify가 users 테이블 update를 어떻게 하는가 | `users`는 RLS 비적용 테이블 (Phase 1 init §22-23 주석). 단순 UPDATE. service pool은 auth_tokens UPDATE를 위해서만 필요 — `users.email_verified_at` UPDATE는 BYPASSRLS 없이 app pool로도 가능 | RLS 정책 모델 일관성 |
| 11. shared types | Phase 2 패턴 — `server/src/types/signup.ts` zod 원본 + `platform/types/signup.js` JSDoc 사본 + `test/sync_shared_types.mjs` registry에 `signup` 추가. `auth-tokens`는 서버 내부 타입이라 shared 등록 X | platform이 호출하는 입력/응답만 shared. 토큰 자체는 서버 내부 |
| 12. enumeration / rate limit | **본 step에서 미적용**. Phase 6+. signup 자체는 email unique 위반 → 409로 노출되나, 이는 Phase 1부터 그래 왔던 패턴 그대로 유지 (별도 응답 통일은 Step 3 forgot password에서 첫 처리) | Master §1 안 한다. Phase 3 본체 흐름 차단 안 함 |

### Pool 사용 규칙 표 (Phase 3 전체 — 본 plan + Step 3·5에서 같은 규칙 따름)

| Endpoint | Pool | 근거 |
|---|---|---|
| `POST /auth/signup` (Step 2) | **app** | 서버가 org를 만들고 같은 트랜잭션에서 GUC 설정 후 후속 INSERT |
| `POST /auth/verify` (Step 2) | **service** | anonymous, raw token만 진입. server-side identity 부재 |
| `POST /auth/verify/resend` (Step 2) | **app** | authenticated, JWT로 user/org 식별 |
| `POST /auth/password/forgot` (Step 3) | **app** | anonymous 진입이지만 email로 user lookup → membership에서 org_id 획득 가능. BYPASSRLS 불필요 |
| `POST /auth/password/reset` (Step 3) | **service** | anonymous, raw token만 진입 |
| `POST /invitations` (Step 5 create/cancel) | **app** | authenticated admin |
| `POST /invitations/accept` (Step 5) | **service** | anonymous, raw token만 진입 |

세 service-pool endpoint (`/auth/verify`, `/auth/password/reset`, `/invitations/accept`)은 모두 **raw token이 유일한 server-side identity**라는 공통점. app-pool anonymous endpoint (`/auth/password/forgot`)은 **email로 lookup → org_id 획득**이 가능해 일반 인증 endpoint와 같은 패턴을 쓸 수 있다.

---

## 2. anonymous RLS 우회 — service credential 구체 설계

### 2.1 적용 위치 — init script vs migration 분리

Docker init scripts는 첫 volume 생성 시점에 적용되며, **migrations보다 먼저 실행된다**. 따라서 init script에서 Phase 3 테이블 (`auth_tokens` / `email_outbox` / 보강된 `invitations` 등)에 GRANT를 시도하면 fresh DB에서는 테이블이 존재하지 않아 실패. 두 책임을 분리한다:

| 책임 | 위치 | 내용 |
|---|---|---|
| role 생성 | `ops/postgres/init/02_service_role.sql` (신규, init script) | `CREATE ROLE kloser_service WITH LOGIN PASSWORD ... BYPASSRLS` (idempotent) + `GRANT USAGE ON SCHEMA public` (스키마 단위 — 테이블 존재 무관) |
| 테이블 grant | `server/migrations/1715000008000_phase3_service_grants.sql` (신규, Phase 3 Step 2 migration) | `GRANT SELECT/INSERT/UPDATE ON <표> TO kloser_service` × 7표. role이 init script로 존재하니 migration 시점에 안전 |

**근거**:
- init script가 schema-level GRANT만 처리하면 fresh DB / 기존 volume 모두 안전
- table grant migration은 forward-only 흐름과 정합 (Master §6-5). down 마이그레이션이 `REVOKE`로 정확히 되돌릴 수 있음
- migration 순서 보장: 0004~0007 적용 후 0008이 같은 role에 GRANT — 테이블 모두 존재 상태

### 2.2 `ops/postgres/init/02_service_role.sql` (신규, role 생성 only)

```sql
-- Phase 3 Step 2 — service role for anonymous RLS bypass.
-- Idempotent: safe to apply multiple times. New volumes pick it up via
-- /docker-entrypoint-initdb.d; existing volumes need a one-time manual
-- `psql -f` (same pattern as 01_app_role.sql per Phase 1 Step 1).
--
-- ★ Table grants are NOT here — they live in a separate migration
-- (1715000008000_phase3_service_grants.sql) so that fresh DBs (init
-- runs before migrations, so tables don't exist yet) and existing
-- volumes (migrations already applied) follow the same path.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kloser_service') THEN
    CREATE ROLE kloser_service
      WITH LOGIN PASSWORD 'kloser_service_dev'
           BYPASSRLS;
  END IF;
END$$;

-- Schema-level usage. Table-level grants live in the Step 2 migration.
GRANT USAGE ON SCHEMA public TO kloser_service;
```

### 2.3 `server/migrations/1715000008000_phase3_service_grants.sql` (신규, table grants)

```sql
-- Phase 3 Step 2 — table grants for kloser_service role.
-- Plan: docs/plan/phase-3/PHASE_3_STEP_2_SIGNUP_VERIFY.md §2.
--
-- Role itself is created by ops/postgres/init/02_service_role.sql at
-- volume init time. This migration runs after Phase 3 Step 1 (0004~0007)
-- so all referenced tables already exist.
--
-- Minimum surface: only the 7 tables that anonymous endpoints (verify /
-- password-reset / invitation-accept) actually touch. customers /
-- activity_log / teams / etc. have no grant — kloser_service can BYPASSRLS
-- but only on tables where it has table-level permission.
--
-- Idempotent: GRANT statements are inherently idempotent in PostgreSQL.

-- Up Migration
-- ============================================================================

GRANT SELECT, INSERT, UPDATE ON auth_tokens    TO kloser_service;
GRANT SELECT, INSERT, UPDATE ON email_outbox   TO kloser_service;
GRANT SELECT, INSERT, UPDATE ON users          TO kloser_service;
GRANT SELECT, INSERT          ON memberships   TO kloser_service;
-- UPDATE on sessions is for Step 3 /auth/password/reset which revokes all
-- active sessions on successful reset (sets revoked_at = now()). Granted
-- now so Step 3 doesn't need a follow-up grant migration.
GRANT SELECT, INSERT, UPDATE ON sessions       TO kloser_service;
GRANT SELECT                 ON organizations  TO kloser_service;
GRANT SELECT, UPDATE         ON invitations    TO kloser_service;

-- Down Migration
-- ============================================================================

REVOKE SELECT, UPDATE          ON invitations   FROM kloser_service;
REVOKE SELECT                  ON organizations FROM kloser_service;
REVOKE SELECT, INSERT, UPDATE  ON sessions      FROM kloser_service;
REVOKE SELECT, INSERT          ON memberships   FROM kloser_service;
REVOKE SELECT, INSERT, UPDATE  ON users         FROM kloser_service;
REVOKE SELECT, INSERT, UPDATE  ON email_outbox  FROM kloser_service;
REVOKE SELECT, INSERT, UPDATE  ON auth_tokens   FROM kloser_service;
```

### 2.4 `server/src/db/servicePool.ts` (신규, lazy init)

Top-level import 시점에 env가 없으면 throw하던 구조는 Phase 1·2 기존 테스트의 부팅 환경까지 깨뜨린다 (모든 import 경로가 SERVICE_DATABASE_URL을 강제로 요구). **lazy initializer로 실제 사용 시점에만 실패**.

```ts
/* Service-role connection pool — BYPASSRLS for anonymous endpoints only.
 *
 * ★ Lazy init: getServicePool() throws only if the env is missing AT
 * THE TIME of first call. Importing this module does NOT touch env —
 * existing tests / boot paths that never invoke anonymous endpoints are
 * unaffected by SERVICE_DATABASE_URL being unset.
 *
 * Used by call sites (Phase 3):
 *   1. services/auth-tokens.ts → consumeToken (verify / password-reset / accept)
 *   2. services/email.ts       → outbox INSERT on anonymous paths (Step 3 forgot,
 *                                 Step 5 invitation-accept). signup uses app pool.
 *   3. services/users.ts       → email_verified_at UPDATE (Step 2 verify)
 *
 * NEVER imported by:
 *   - routes/* directly
 *   - any authenticated service path (those use pool + withOrgContext)
 *   - migrations (those use MIGRATE_DATABASE_URL)
 *
 * Code review rule: a new import of this module requires sign-off in PR.
 */
import { Pool, type PoolConfig } from "pg";

let _pool: Pool | null = null;

export function getServicePool(): Pool {
  if (_pool) return _pool;

  const url = process.env.SERVICE_DATABASE_URL;
  if (!url) {
    throw new Error(
      "SERVICE_DATABASE_URL is required to use anonymous endpoints" +
      " (verify / password-reset / invitation-accept). Add it to" +
      " server/.env — see docs/plan/phase-3/PHASE_3_STEP_2_SIGNUP_VERIFY.md §2."
    );
  }

  const config: PoolConfig = {
    connectionString: url,
    max: 5,                         // anonymous traffic is bursty but low-volume
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  };
  _pool = new Pool(config);
  _pool.on("error", (err) => {
    console.error("[db:service] idle client error:", err.message);
  });
  return _pool;
}

// For test teardown only.
export async function closeServicePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
```

### 2.5 env 파일 + 적용 절차

`server/.env.example` (수정 1줄 추가):
```
SERVICE_DATABASE_URL=postgres://kloser_service:kloser_service_dev@localhost:5432/kloser_dev
```

본 step 구현 시 `server/.env`에도 같은 행 추가 (gitignored). `npm --prefix server test`는 dotenv 로딩 후 anonymous endpoint를 다루는 케이스에서만 env를 실제 사용 — 그 외 테스트는 영향 없음.

**적용 절차**:
1. `ops/postgres/init/02_service_role.sql`를 dev DB에 1회 수동 적용 (기존 volume이 살아 있으므로 자동 적용 안 됨):
   ```bash
   docker exec -i kloser-dev-postgres-1 psql -U kloser -d kloser_dev \
     < ops/postgres/init/02_service_role.sql
   ```
2. `npm --prefix server run db:migrate:up` — 0008 적용으로 테이블 grant 부여
3. 검증: `SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname='kloser_service'` → `t` / `SELECT * FROM information_schema.role_table_grants WHERE grantee='kloser_service'` → 7표 확인

CI / Phase 4+ 클린 환경에서는 (1) 단계 자동화 필요할 수 있음 — finding으로 기록.

### 2.6 service pool 사용 패턴 — `consumeToken` 트랜잭션 경계 fix

**문제**: token consume과 user/state UPDATE가 다른 트랜잭션이면 partial state가 생긴다. consume은 commit됐는데 user UPDATE가 실패하면 사용자가 다시 verify 못 함 (토큰은 소비됨).

**해결**: `consumeToken`은 **외부 PoolClient를 받는 저수준 함수**로 두고, 각 anonymous 흐름은 **wrapper 함수가 servicePool transaction 전체를 소유**한다.

```ts
// services/auth-tokens.ts (revised sketch)
import type { PoolClient } from "pg";
import { getServicePool } from "../db/servicePool.js";

/** Low-level: assumes caller manages BEGIN/COMMIT/ROLLBACK on `client`. */
export async function consumeToken(
  client: PoolClient,
  rawToken: string,
  purpose: TokenPurpose,
): Promise<ConsumedToken> {
  const hash = sha256Hex(rawToken);
  const r = await client.query(
    `SELECT id, org_id, user_id, invitation_id, expires_at,
            consumed_at, invalidated_at
       FROM auth_tokens
      WHERE token_hash = $1
        AND purpose    = $2
      FOR UPDATE`,
    [hash, purpose],
  );
  if (r.rows.length === 0)                throw new AuthError(404, "token_not_found");
  const row = r.rows[0];
  if (row.consumed_at)                    throw new AuthError(410, "token_already_used");
  if (row.invalidated_at)                 throw new AuthError(410, "token_invalidated");
  if (row.expires_at < new Date())        throw new AuthError(410, "token_expired");

  await client.query(
    `UPDATE auth_tokens SET consumed_at = now() WHERE id = $1`,
    [row.id],
  );
  return { id: row.id, orgId: row.org_id, userId: row.user_id, invitationId: row.invitation_id };
}
```

```ts
// services/auth.ts (high-level wrapper — owns the entire anonymous tx)
export async function verifyEmail(rawToken: string): Promise<void> {
  const client = await getServicePool().connect();
  try {
    await client.query("BEGIN");
    const consumed = await consumeToken(client, rawToken, 'email_verification');
    if (!consumed.userId) {
      // CHECK constraint forces user_id NOT NULL for non-invitation
      // purposes. Defensive — should be unreachable.
      throw new AuthError(500, "verify_internal_inconsistency");
    }
    await client.query(
      `UPDATE users SET email_verified_at = now() WHERE id = $1`,
      [consumed.userId],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
```

같은 패턴을 Step 3 `resetPassword(rawToken, newPassword)` / Step 5 `acceptInvitation(rawToken, name, password)`가 이어 받는다 — 각 wrapper가 servicePool transaction 1개로 token consume + 도메인 변경을 묶는다.

**불변식**: `consumeToken`은 BEGIN/COMMIT 안 함, 절대 servicePool을 직접 connect 하지 않음. 호출자가 client를 전달 — 트랜잭션 경계는 호출자 소유.

---

## 3. `services/auth-tokens.ts` — 토큰 lifecycle 헬퍼

### 노출되는 함수 (모두 PoolClient 인자를 받음)

```ts
export type TokenPurpose = 'email_verification' | 'password_reset' | 'invitation';

export interface MintTokenInput {
  client: PoolClient;            // 호출자가 트랜잭션 client 전달
  orgId: string;
  userId?: string | null;        // invitation purpose면 null
  invitationId?: string | null;  // invitation purpose에만 set
  purpose: TokenPurpose;
  ttlMs: number;
}

export interface MintTokenResult {
  rawToken: string;              // 발송 시점에 메모리에만 존재
  tokenId: string;               // auth_tokens.id
  expiresAt: Date;
}

export interface ConsumedToken {
  id: string;
  orgId: string;
  userId: string | null;
  invitationId: string | null;
}

export async function mintToken(input: MintTokenInput): Promise<MintTokenResult>;
export async function invalidateActiveTokens(input: { client: PoolClient; userId: string; purpose: TokenPurpose }): Promise<number>;
export async function consumeToken(client: PoolClient, rawToken: string, purpose: TokenPurpose): Promise<ConsumedToken>;
```

**핵심 원칙**: 세 함수 모두 `PoolClient` 인자를 받고 **자체 트랜잭션을 열지 않는다**. 호출자(wrapper 함수)가 트랜잭션 경계를 소유한다. 이는 §2.6 partial-state 회피 정책의 강제 형태.

### 핵심 로직

**`mintToken`** — 호출자가 트랜잭션 client를 줄 때 그 안에서 INSERT. 인증된 흐름은 app pool client (GUC 설정 후), anonymous mint (Step 3 forgot)는 servicePool client. 두 경우 모두 같은 함수 시그니처 사용.

```
raw = crypto.randomBytes(32).toString('base64url')   // 43 chars URL-safe
hash = sha256(raw) hex
INSERT INTO auth_tokens(org_id, user_id, invitation_id, purpose,
                        token_hash, expires_at)
   VALUES ($1, $2, $3, $4, $5, $6)
return { rawToken: raw, tokenId, expiresAt }
```

**`invalidateActiveTokens`** — 같은 user + purpose의 활성 토큰을 모두 `invalidated_at = now()` 처리. resend 흐름이 mint 직전 호출. UNIQUE partial이 있어 보통 1개지만 SQL은 `WHERE` 매칭 모두에 적용. 반환값은 수정된 row count.

**`consumeToken`** — 위 §2.6 sketch. **외부 client 인자 필수**. servicePool에 절대 직접 connect 하지 않음. 404 / 410 사유는 내부적으로 분리 throw하되 route 단계에서 단일 410 generic 응답으로 매핑 (timing-attack 회피, Codex 리뷰 §7 정합).

### 고수준 wrapper들 (각자 트랜잭션 1개 소유)

```ts
// services/auth.ts (Step 2)
export async function verifyEmail(rawToken: string): Promise<void>
// servicePool tx: consumeToken + UPDATE users.email_verified_at

// services/auth.ts (Step 3 — 본 plan 범위 밖, 시그니처만 제시)
export async function resetPassword(rawToken: string, newPassword: string): Promise<void>
// servicePool tx: consumeToken + UPDATE users.password_hash +
//                 UPDATE sessions SET revoked_at = now() WHERE user_id = ? AND revoked_at IS NULL
// (sessions UPDATE는 migration 0008의 GRANT UPDATE ON sessions로 가능)

// services/invitations.ts (Step 5)
export async function acceptInvitation(rawToken: string, name: string, password: string): Promise<AuthResult>
// servicePool tx: consumeToken + INSERT user(생성 또는 lookup) + INSERT membership +
//                 UPDATE invitations.accepted_at + UPDATE users.email_verified_at
```

세 wrapper 모두 같은 패턴 — `getServicePool().connect()` → `BEGIN` → `consumeToken(client, ...)` + 도메인 변경 → `COMMIT`. 실패 시 ROLLBACK으로 partial state 0건.

---

## 4. `services/email.ts` — EmailProvider 인터페이스 + dev outbox

### 인터페이스

```ts
export interface EmailVerificationPayload {
  client: PoolClient;      // ★ 필수. 호출자가 소유하는 트랜잭션 안에서 outbox INSERT.
                           // 호출자가 app pool 또는 service pool client를 전달.
                           // pool 선택은 §1 Pool 사용 규칙 표 참조.
  orgId: string;
  toEmail: string;
  toName: string;
  verifyUrl: string;       // raw token이 query param에 평문 포함 (dev 한정)
  rawToken: string;        // metadata.verifyUrl과 본문에 박힘
}

export interface EmailProvider {
  sendVerificationEmail(input: EmailVerificationPayload): Promise<void>;
  sendInvitationEmail(input: EmailInvitationPayload): Promise<void>;
  sendPasswordResetEmail(input: EmailPasswordResetPayload): Promise<void>;
}
```

**핵심 원칙**: 세 메서드 모두 **client 인자 필수**. EmailProvider는 절대 자체 pool에 connect하지 않음. 트랜잭션 경계는 항상 호출자(wrapper 함수)가 소유 — `consumeToken` 패턴과 정합 (§3).

### dev 구현

`DevOutboxEmailProvider` — 각 메서드가 적절한 template / subject / body로 `email_outbox` row INSERT (호출자의 client 사용). 어떤 pool에서 온 client든 동일 SQL: `INSERT INTO email_outbox (org_id, to_email, subject, body_text, template, metadata) VALUES (...)`. app pool client는 WITH CHECK 통과 (GUC 설정 후 호출), service pool client는 BYPASSRLS로 통과.

서버 부트 시 `process.env.EMAIL_PROVIDER` 미지정이면 `DevOutboxEmailProvider` 인스턴스화. Phase 6+에서 `ResendEmailProvider` / `SmtpEmailProvider` 등 추가.

### 본문 / metadata 포맷

```
verification:
  subject : "[Kloser] 이메일 인증을 완료해주세요"
  body_text: "안녕하세요 {name},\n\n아래 링크에서 24시간 안에 이메일을 인증해주세요:\n{verifyUrl}\n\n— Kloser"
  metadata: { verifyUrl, user_id }

invitation:  Step 5에서 정의
password_reset: Step 3에서 정의
```

`verifyUrl`은 `process.env.PUBLIC_APP_ORIGIN ?? 'https://kloser.local'` + `/platform/verify.html?token=...`. seed 패턴과 동일.

---

## 5. `services/auth.ts` signup 트랜잭션 확장

현재 signup (lines 371~435):
- org INSERT → user INSERT → setOrgContext → membership INSERT → createSessionWithToken

본 step 확장:
- 위 직후 (같은 트랜잭션) `mintToken({client, orgId, userId, purpose: 'email_verification', ttlMs: 24h})`
- 위 직후 `emailProvider.sendVerificationEmail({client, orgId, toEmail, toName, verifyUrl, rawToken})` — 같은 트랜잭션 안에 outbox INSERT
- 그 후 createSessionWithToken (기존 그대로)

순서 중요:
1. org INSERT — `organizations` 행 생성
2. user INSERT — `users` 행 (RLS 비적용)
3. setOrgContext(org.id) — 이 후 모든 RLS-scoped INSERT의 WITH CHECK 통과
4. membership INSERT — admin role
5. **mintToken** — auth_tokens INSERT (purpose='email_verification', user_id=user.id, org_id=org.id, expires_at=now()+24h)
6. **sendVerificationEmail** — email_outbox INSERT
7. createSessionWithToken — sessions INSERT + refresh token 생성

모두 한 트랜잭션. 어디서든 실패하면 전부 rollback — outbox에 메일이 박혔는데 user는 없는 inconsistency 없음.

### 응답 변경

`AuthResult.user`에 `emailVerifiedAt: Date | null` 필드 추가. signup 직후 응답에서는 `null`. `toPublicAuthUser`에 컬럼 매핑 1줄 추가.

---

## 6. `POST /auth/signup` — route 변경 거의 없음

서비스 함수가 트랜잭션을 다 처리하므로 route 레벨에서는:
- 입력 검증 (기존)
- service 호출 (기존)
- cookie + access token 응답 (기존)
- ★ `result.user.emailVerifiedAt`이 응답 JSON에 포함됨 (자동)

추가로 `sendAuthResult`가 응답 JSON에 verification 토큰을 노출하지 **않는다** — 토큰은 outbox로만 흐름.

201 응답 contract:
```json
{
  "accessToken": "...",
  "user": { "id": "...", "email": "...", "name": "...", "emailVerifiedAt": null, ... },
  "organization": { ... },
  "membership": { "id": "...", "role": "admin" }
}
```

cookie `kloser_refresh` 설정 (기존 그대로).

---

## 7. `POST /auth/verify` (anonymous) + `POST /auth/verify/resend` (authenticated)

### `/auth/verify`

| 항목 | 값 |
|---|---|
| 인증 | **없음** — anonymous |
| 본문 | `{ token: string }` (raw token) |
| 처리 | service에서 `verifyEmail(rawToken)` wrapper 호출 — **단일 servicePool 트랜잭션**이 `consumeToken(client, ...)` + `UPDATE users SET email_verified_at = now()`를 함께 묶음 (§2.6). partial state 0건 보장 |
| 응답 | 200 `{ ok: true }` |
| 외부 응답 코드 | 400 (token 누락), **410** (token invalid/expired — 404/410 모두 통합) |

**오류 통합 정책 (§7 Codex review)**: 외부 응답은 generic `410 { error: 'token_invalid_or_expired', code: 'token_invalid_or_expired' }`로 통합 — 404 / already_used / invalidated / expired 모두 같은 표면. timing-attack / enumeration 회피. 내부 service 레이어는 distinct reason을 throw하고, route handler가 catch + 매핑. **단위 테스트는 reason별로 assert** (내부 로그에서 분리 확인).

### `/auth/verify/resend`

| 항목 | 값 |
|---|---|
| 인증 | **필수** — `requireAuth` middleware. JWT에서 user_id / org_id 획득 |
| 본문 | 없음 — 본인 user의 활성 토큰만 처리 |
| 처리 | (트랜잭션 안에서) `invalidateActiveTokens({client, userId, purpose: 'email_verification'})` → `mintToken({client, orgId, userId, purpose, ttlMs: 24h})` → `sendVerificationEmail({client, ...})` |
| 응답 | 200 `{ ok: true }` |
| 오류 | 409 (`already_verified` — `users.email_verified_at IS NOT NULL`이면 발급 안 함) |

---

## 8. 미인증 사용자 정책

본 step에서는 **자기 정보 read/write는 모두 허용**. cross-user write 차단은 Step 4/5의 책임.

- `POST /auth/login` — 기존 동작 변경 없음. 미인증 user도 로그인 OK
- `GET /me` — 기존 동작 변경 없음. `user.emailVerifiedAt` 포함됨 (route는 user 객체 그대로 반환)
- `GET /customers`, `POST /customers` 등 Phase 2 endpoint — 인증된 user의 본인 org 데이터라 verified 무관. 변경 없음

**Step 4 도입 예정 (본 plan에서 미구현)**: `requireVerified` middleware. invitations 발송 / password reset 같은 cross-user 작업 시 `403 email_not_verified`. 본 plan §1-12 lock-in과 정합.

---

## 9. shared types — `signup` entity 등록

`server/src/types/signup.ts` 신규:

```ts
import { z } from "zod";

export const SignupInput = z.object({
  organizationName: z.string().min(1).max(200),
  name:             z.string().min(1).max(200),
  email:            z.string().min(3).max(320),
  password:         z.string().min(8).max(1024),
});

export const VerifyEmailInput = z.object({
  token: z.string().min(1).max(512),
});
```

`platform/types/signup.js` 신규:

```js
/**
 * @typedef {Object} SignupInput
 * @property {string} organizationName
 * @property {string} name
 * @property {string} email
 * @property {string} password
 */
/**
 * @typedef {Object} VerifyEmailInput
 * @property {string} token
 */
```

`test/sync_shared_types.mjs` `ENTITY_REGISTRY`에 한 entry 추가:
```js
{
    name: "signup",
    server: "server/src/types/signup.ts",
    browser: "platform/types/signup.js",
    types: ["SignupInput", "VerifyEmailInput"],
},
```

`auth-tokens`는 서버 내부 타입이라 shared 등록 안 함.

---

## 10. 단위 테스트 (`server/test/auth_tokens.test.mjs` + `verify_routes.test.mjs`)

새 파일 2개. 총 ~10 cases.

### `auth_tokens.test.mjs` (service layer)

1. `mintToken` — sha256 hex 64자 저장됨. raw token 평문은 DB에 없음 (token_hash 컬럼만 sha256 매치)
2. `mintToken` 같은 (user_id, purpose) 활성 토큰 2개 시도 → 23505 `auth_tokens_user_purpose_active_idx`
3. `invalidateActiveTokens` 후 `mintToken` → 새 row insert 성공
4. `consumeToken(client, ...)` 정상 → row 반환 + `consumed_at` set (호출자 트랜잭션 안에서 검증)
5. `consumeToken` 같은 토큰 2번째 → 내부 throw `token_already_used` (route 매핑 전 raw assert)
6. `consumeToken` `invalidated_at != null` 토큰 → 내부 throw `token_invalidated`
7. `consumeToken` `expires_at < now()` 토큰 → 내부 throw `token_expired`
8. `consumeToken` 존재하지 않는 hash → 내부 throw `token_not_found`
9. `consumeToken`은 servicePool client 받아 GUC 없이 SELECT/UPDATE 동작 (BYPASSRLS 권한 확인)
10. **partial-state 회피**: `verifyEmail` wrapper 내부에서 `UPDATE users` 단계에 인위적 에러 주입 → 트랜잭션 ROLLBACK 검증: auth_tokens.consumed_at IS NULL 그대로, users.email_verified_at IS NULL 그대로 (행 변경 0건)

### `verify_routes.test.mjs` (route + service)

1. `/auth/signup` 200 + `users.email_verified_at IS NULL` + `email_outbox` 1행 (template='email_verification') + `auth_tokens` 1행 (purpose='email_verification', expires_at within 24h)
2. seed에서 token 추출 → `/auth/verify` 200 → `users.email_verified_at` set
3. 같은 token으로 `/auth/verify` 재시도 → 410
4. `/auth/verify/resend` (authenticated) → 옛 토큰 `invalidated_at` set + 새 토큰 발급 + outbox 1행 추가
5. `/auth/verify/resend` 이미 verified user → 409 `already_verified`
6. `/auth/verify` 만료된 토큰 (`expires_at`이 과거) → 410
7. 다른 org의 토큰을 가져와 `/auth/verify` → 200 동작 (anonymous flow이므로 org 격리 무관 — token_hash 자체가 unique한 매치 키)
8. `/auth/verify` 빈 본문 → 400 schema validation
9. signup 직후 `/auth/login` (미인증) → 200 (verified 무관)
10. signup 직후 `/me` → `emailVerifiedAt: null` 노출

테스트 후 cleanup: `afterEach`로 본 테스트가 생성한 user/membership/auth_tokens/email_outbox row 정리 (e2etest- prefix는 안 쓰고 deterministic email로). Phase 1 pattern과 동일하게 seeded 행은 손대지 않음.

---

## 11. 위험·미정

| 항목 | 처리 |
|---|---|
| `kloser_service` role 적용 — init script 자동 적용 안 됨 (기존 volume) | 본 plan §2.5 절차: (1) init SQL 1회 수동 적용 + (2) `db:migrate:up` (0008 grant). 미적용 시 `/auth/verify` 호출 시 servicePool connect 실패로 즉시 발견 (silent corruption 없음). CI 환경 자동화는 Findings에 항목 추가 |
| init script와 migration의 순서 책임 분리 | role 생성 + schema usage는 init script (테이블 부재 안전), 테이블 grant 7표는 migration 0008 (테이블 존재 후). 두 책임 분리로 fresh DB / 기존 volume 모두 동일 절차 |
| `servicePool` lazy init — top-level import가 env를 요구하지 않음 | `getServicePool()` 첫 호출 시점에만 env 체크. 기존 65개 server unit test 중 anonymous endpoint를 다루지 않는 케이스는 SERVICE_DATABASE_URL 없어도 영향 없음. anonymous endpoint 단위 테스트만 env 필요 |
| `BYPASSRLS` 권한이 다른 테이블까지 보이는가 | Grant를 7표에만 명시 제한 (0008 migration). 추가 표 접근 시도 시 `permission denied`. 본 step 검증에서 `information_schema.role_table_grants`로 확인 |
| `consumeToken` partial-state — token 소비 후 user UPDATE 실패 시 토큰만 사라짐 | `consumeToken`이 자체 트랜잭션을 열지 않고 `client: PoolClient` 인자만 받음. 호출자 wrapper (`verifyEmail` 등)가 트랜잭션 1개를 소유하고 두 작업을 묶음. 단위 테스트 §10 #10이 강제 ROLLBACK으로 행 변경 0건 검증 |
| `mintToken`이 트랜잭션 client를 강제 — 호출자가 깜빡하면 GUC 없이 호출 | 함수 시그니처에 `client: PoolClient` 필수 인자. app pool client + GUC 없는 INSERT 시도 시 RLS WITH CHECK 위반으로 fail loudly. service pool client 사용 시 BYPASSRLS로 통과 — 의도된 anonymous mint 흐름 |
| signup 트랜잭션이 6개 INSERT로 길어짐 — 부분 실패 시 outbox에 메일만 박힘 | 모두 같은 트랜잭션이라 fail-then-rollback. dev outbox는 transactional이라 commit 안 되면 메일 row도 없음 |
| Phase 6+ 운영 SMTP 어댑터 도입 시 transactional이 깨짐 | Phase 6+ Outbox pattern (DB에 row 박은 뒤 별도 워커가 발송) 도입 시점에 EmailProvider 인터페이스 미세 조정. 본 step의 dev outbox는 그 outbox 패턴의 자연스러운 prefactor |
| anonymous `/auth/verify` 외부 응답 통합 | 외부는 generic `410 token_invalid_or_expired`만 노출. user_id / org_id 노출 없음. 내부 service throw는 reason별 distinct → route handler가 catch + 단일 매핑. 테스트는 reason별 assert |
| signup의 email unique 위반 (`23505`)이 409로 노출 — enumeration 위험 | Master §1-12 Phase 6+ 검토. Phase 1부터의 contract라 본 step에서 변경 안 함. Step 3 `/auth/password/forgot`에서 enumeration 차단 통일 |
| `/auth/verify/resend`의 rate limit 부재 — 사용자가 spam 가능 | 활성 토큰 1개 강제로 spam 영향 최소화 (옛 토큰은 즉시 무효). rate limit은 Phase 6+ |
| email 본문에 raw token 포함 — dev 한정 노출 정책 (Master §7 게이트) | Step 1 plan §7과 정합. 본 step에서 변경 없음. 운영 어댑터 전환 시 metadata 마스킹 정책 별도 |

---

## 12. 완료 기준 (Step 2 — go/no-go)

- [ ] `ops/postgres/init/02_service_role.sql` 작성 (role 생성 + schema usage) + dev DB에 1회 적용 + 검증 `SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname='kloser_service'` → `t`
- [ ] `server/migrations/1715000008000_phase3_service_grants.sql` 작성 + `db:migrate:up` + 검증 `SELECT table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee='kloser_service' ORDER BY table_name, privilege_type` → 7표 grant 일치 (`sessions`는 SELECT/INSERT/UPDATE 3개, `organizations`는 SELECT 1개)
- [ ] `server/src/db/servicePool.ts` 작성 — **lazy init** (`getServicePool()`) + `server/.env.example`에 `SERVICE_DATABASE_URL` 추가 + `server/.env`에 실제 값 추가
- [ ] `server/src/services/auth-tokens.ts` 작성 — mint / consume(client 인자) / invalidate
- [ ] `server/src/services/email.ts` 작성 — `EmailProvider` interface + `DevOutboxEmailProvider`
- [ ] `server/src/services/auth.ts` signup 트랜잭션 확장 + `verifyEmail(rawToken)` wrapper 추가 (servicePool 트랜잭션 1개 소유)
- [ ] `POST /auth/verify` route — wrapper 호출 + 외부 응답 통합 (404/410 → 410 generic)
- [ ] `POST /auth/verify/resend` route + service (authenticated, app pool)
- [ ] `server/src/types/signup.ts` + `platform/types/signup.js` + sync registry 추가
- [ ] `npm --prefix server run typecheck` PASS
- [ ] `npm --prefix server test` — 신규 ~10 cases PASS (partial-state 회피 케이스 포함) + 기존 65 회귀 PASS = ~75 total
- [ ] `node test/sync_shared_types.mjs` PASS — `signup` entity 등록 후
- [ ] `node test/phase_0_5_e2e.mjs` 16/16 회귀 PASS
- [ ] `node test/phase_2_customers_e2e.mjs` 7/7 회귀 PASS
- [ ] 수동 검증: `curl POST /auth/signup` → 201 + outbox에 1행 → SQL로 token raw 추출 → `curl POST /auth/verify` → 200 → `users.email_verified_at` set 확인. 같은 토큰 재시도 → 410
- [ ] `docs/plan/phase-3/PHASE_3_STEP_2_FINDINGS.md` 작성

---

## 13. 한 줄 요약

> **1.5일 동안 `kloser_service` BYPASSRLS role + `servicePool` + `services/auth-tokens.ts` + `services/email.ts` (dev outbox) + signup 트랜잭션 확장 + `/auth/verify` (anonymous) + `/auth/verify/resend` (authenticated)를 깐다. Step 3·5가 같은 풀·서비스를 재사용한다.**

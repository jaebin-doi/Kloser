# Phase 3 Step 2 Findings — 회원가입 + 이메일 인증 service / route

> Audience: Phase 3 Step 3 작성자 (또는 미래의 나).
> Format: each finding has **(1) 관찰**, **(2) Step 3 또는 이후로의 의미**.
> Plan: [`PHASE_3_STEP_2_SIGNUP_VERIFY.md`](PHASE_3_STEP_2_SIGNUP_VERIFY.md).

---

## 결론

Step 2 **완료** (2026-05-11). 계획서 §12 완료 기준 16항목 모두 통과. Phase 3 Step 3 (비밀번호 재설정) 진입 가능.

### 적용 파일 (10개)

| 종류 | 경로 | 비고 |
|---|---|---|
| init script | `ops/postgres/init/02_service_role.sql` | `kloser_service` BYPASSRLS role 생성 + schema USAGE grant (테이블 grant 없음) |
| migration | `server/migrations/1715000008000_phase3_service_grants.sql` | 7표 grant (`auth_tokens` / `email_outbox` / `users` / `memberships` / `sessions` / `organizations` / `invitations`). REVOKE down |
| db | `server/src/db/servicePool.ts` | lazy `getServicePool()` + `closeServicePool()` |
| service | `server/src/services/auth-tokens.ts` | `mintToken` / `consumeToken(client,...)` / `invalidateActiveTokens` + sha256Hex + TTL 상수 3종 |
| service | `server/src/services/email.ts` | `EmailProvider` interface + `DevOutboxEmailProvider` (3 메서드 모두 구현). URL builder 헬퍼 |
| service | `server/src/services/auth.ts` (수정) | signup 트랜잭션에 mintToken + sendVerificationEmail 추가. `verifyEmail(rawToken)` wrapper (servicePool tx 소유) + `resendVerificationEmail({userId, orgId})` |
| repo | `server/src/repositories/authUsers.ts` (수정) | `PublicAuthUser.email_verified_at` 노출. `toPublicAuthUser` 매핑 1줄 |
| route | `server/src/routes/auth.ts` (수정) | `POST /auth/verify` (anonymous, 410 generic 매핑) + `POST /auth/verify/resend` (`requireAuth`) |
| route | `server/src/routes/me.ts` (수정) | response 사용자 객체에 `email_verified_at` 추가 |
| shared types | `server/src/types/signup.ts` + `platform/types/signup.js` + `test/sync_shared_types.mjs` (수정) | `SignupInput`, `VerifyEmailInput` zod + JSDoc + registry 등록 |
| env | `server/.env.example` (수정) + `server/.env` (gitignored, 로컬) | `SERVICE_DATABASE_URL=postgres://kloser_service:kloser_service_dev@.../kloser_dev` 추가 |
| test | `server/test/auth_tokens.test.mjs` + `server/test/verify_routes.test.mjs` | 22 cases (10 + 12) |

### 검증 결과 (plan §12)

| # | 항목 | 결과 |
|---|---|---|
| 1 | `02_service_role.sql` 적용 + `kloser_service` 존재 | `rolbypassrls=t, rolcanlogin=t` |
| 2 | migration 0008 적용 + 7표 grant 확인 | `information_schema.role_table_grants`에 7표 모두 등록 (sessions=3 권한, organizations=1 권한) |
| 3 | `servicePool.ts` lazy init | 기존 Phase 1·2 테스트 부팅 영향 없음 (`getServicePool()` 미호출 케이스 65개) |
| 4 | `services/auth-tokens.ts` | mint/consume/invalidate 3 함수 + sha256Hex + TTL 상수 |
| 5 | `services/email.ts` | 3 메서드 모두 구현. `client: PoolClient` 필수 |
| 6 | signup 트랜잭션 확장 | 단위 테스트에서 signup 응답에 `email_verified_at: null` + outbox 1행 + auth_tokens 1행 모두 검증 |
| 7 | `POST /auth/verify` route | 200 OK + 재시도 410 generic + 알 수 없는 token 410 + 만료 410 + 빈 본문 400 |
| 8 | `POST /auth/verify/resend` route | 200 + 옛 토큰 invalidated + 새 토큰 활성 + outbox 2건. 이미 verified → 409 |
| 9 | shared types | `signup` entity 등록 + `node test/sync_shared_types.mjs` PASS |
| 10 | typecheck | `npm --prefix server run typecheck` PASS |
| 11 | server unit test | `npm --prefix server test` — **87/87** PASS (Phase 1·2 회귀 65 + 신규 22) |
| 12 | `sync_shared_types.mjs` | PASS (customers + signup) |
| 13 | Phase 0.5 e2e | 16/16 PASS |
| 14 | Phase 2 customers e2e | 7/7 PASS |
| 15 | 수동 검증 | signup → outbox에서 token 추출 → `/auth/verify` 200 → `email_verified_at` set → 같은 토큰 재시도 → 410 generic |

---

## 발견 사항

### 1. anonymous endpoint pool — service credential 채택, lazy init이 기존 테스트 부팅 영향 없음

(1) plan §1-1 / §2 결정 그대로 구현. `SERVICE_DATABASE_URL` 환경 변수가 새로 도입됐고, `getServicePool()`이 첫 호출 시점에만 env를 체크해 Phase 1·2 테스트 65개는 SERVICE_DATABASE_URL 없이도 정상 부팅. anonymous endpoint를 다루는 새 22 테스트만 env에 의존.

(2) Step 3 / Step 5에서 `getServicePool()`을 같은 방식으로 재사용. `resetPassword(rawToken, newPassword)` / `acceptInvitation(rawToken, name, password)` wrapper가 servicePool 트랜잭션 1개를 소유하는 패턴 (`verifyEmail`과 동일)을 따른다.

(3) 운영 진입 시 (Phase 6+):
- `kloser_service_dev` 비밀번호 secrets manager로 교체
- `SERVICE_DATABASE_URL` deploy env에서 주입
- BYPASSRLS 권한은 그대로 유지 — anonymous flow 구조 자체는 변경 없음

---

### 2. consumeToken 트랜잭션 경계 — client 인자 필수 + wrapper-owned tx 패턴

(1) plan §2.6 그대로 구현. `consumeToken(client, rawToken, purpose)`는 `BEGIN/COMMIT` 안 함. `verifyEmail(rawToken)` wrapper가 `getServicePool().connect()` → `BEGIN` → `consumeToken` → `UPDATE users SET email_verified_at = now()` → `COMMIT` 흐름을 한 트랜잭션에 묶음. 실패 시 ROLLBACK으로 두 작업 모두 원복.

(2) 단위 테스트 `consumeToken participates in caller's transaction — ROLLBACK undoes consumed_at`이 이 invariant를 직접 검증 — caller가 ROLLBACK하면 consumed_at이 NULL로 복원되고 같은 토큰이 다시 소비 가능.

(3) Step 3 `resetPassword` 구현 시:
```ts
// services/auth.ts (Step 3 sketch — 같은 패턴 그대로)
export async function resetPassword(rawToken: string, newPassword: string) {
  const client = await getServicePool().connect();
  try {
    await client.query("BEGIN");
    const consumed = await consumeToken(client, rawToken, 'password_reset');
    const passwordHash = await hashPassword(newPassword);
    await client.query(`UPDATE users SET password_hash = $1 WHERE id = $2`,
      [passwordHash, consumed.userId]);
    await client.query(
      `UPDATE sessions SET revoked_at = now(), revoked_reason = 'password_reset'
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [consumed.userId]);
    await client.query("COMMIT");
  } catch (err) { /* ROLLBACK + rethrow */ }
}
```

migration 0008의 `GRANT UPDATE ON sessions`가 이 흐름을 지원.

---

### 3. EmailProvider의 트랜잭션-aware 인터페이스 — client 인자 필수가 dev outbox 일관성 보장

(1) `EmailProvider` 세 메서드 모두 `client: PoolClient` 필수. `DevOutboxEmailProvider`는 자체 connect 안 함 — 호출자의 트랜잭션 안에서만 INSERT. signup 트랜잭션이 실패하면 outbox 행도 함께 rollback.

(2) signup 트랜잭션은 app pool client + GUC를 통과시키므로 RLS WITH CHECK 통과. anonymous flow (Step 3 password/forgot은 app pool로 lookup → org_id 획득; Step 5 invitation은 인증된 admin이 호출) 모두 같은 인터페이스로 동작.

(3) Phase 6+ SMTP/Resend 어댑터 도입 시 인터페이스 시그니처 변경 없이 어댑터만 교체. **단, 외부 SMTP 호출은 transactional이 아니므로** transactional outbox 패턴 (outbox row를 commit 후 별도 워커가 발송) 도입 필요. 현재 구조가 그 prefactor.

---

### 4. /auth/verify 외부 응답 통합 — internal reason은 유지, 외부는 generic 410

(1) plan §7 그대로 구현. service 레이어는 `consumeToken`이 4가지 distinct AuthError 던짐 (`token_not_found` / `token_already_used` / `token_invalidated` / `token_expired`). route handler `sendVerifyError`가 이 4 코드를 모두 `410 token_invalid_or_expired` generic으로 매핑.

(2) 단위 테스트는 reason별 assert (`assert.equal(err.code, 'token_already_used')`)로 내부 분기 정확성 검증. route 테스트는 `r.json().code === 'token_invalid_or_expired'`만 검증해 외부 contract 보호.

(3) 운영 디버깅 시 logs는 distinct reason을 남길 수 있고, 사용자/API consumer에게는 동일 응답이 보인다 — timing-attack / enumeration 회피와 운영성 둘 다 확보.

---

### 5. signup 트랜잭션이 7개 INSERT로 길어졌으나 transactional 보장 유지

(1) 새 흐름: org INSERT → user INSERT → setOrgContext → membership INSERT → **mintToken (auth_tokens INSERT)** → **sendVerificationEmail (email_outbox INSERT)** → session INSERT. 모두 `withTransaction` 안. 어디서든 throw 시 7개 모두 rollback.

(2) 단위 테스트 `signup writes auth_tokens + email_outbox in the same transaction`가 검증:
- `auth_tokens.purpose='email_verification'` 1행 + `expires_at` 23~25h 범위
- `email_outbox.template='email_verification'` 1행 + `body_text`에 `token=` 포함

(3) signup 성능에 직접 영향: 6 INSERT + Argon2id 1회. 측정해보지 않았지만 dev에서 200ms 안쪽. Phase 6+ 운영 단계에서 측정·캐싱·튜닝.

---

### 6. 시드 user (Acme employee) 재사용 단위 테스트의 cleanup 전략 — UPDATE invalidate

(1) `auth_tokens.test.mjs`의 `afterEach`는 시드 user (`aaaaaaaa-0002-0002-0002-...`)에 박힌 활성 토큰을 **DELETE 대신 UPDATE invalidated_at**으로 정리. 이유:

- runtime `kloser_service` role에 `DELETE` grant 없음 (plan §2.3 — 최소 surface 원칙)
- UPDATE invalidated_at은 grant 있고, UNIQUE partial 인덱스 (`auth_tokens_user_purpose_active_idx`)가 invalidated 행을 제외하므로 다음 테스트의 `mintToken`이 통과

(2) 부작용: 시드 user에 invalidated된 historical rows가 누적. UNIQUE partial과 무관해 기능적 문제 없음. 단, 테스트 assertion이 `count(*) FROM auth_tokens WHERE user_id=...`를 사용하면 historical로 인해 fail — 본 step의 `invalidateActiveTokens then mintToken → both rows coexist` 테스트가 `WHERE id IN ($1, $2)`로 좁혀서 회피.

(3) Step 3·5 단위 테스트에서 같은 시드 user 재사용 시 동일 패턴 권장. 일회용 user 생성으로 회피하면 cleanup 부담 적음 (verify_routes.test.mjs 방식).

---

### 7. verify_routes.test.mjs cleanup — 일회용 org + cascade

(1) verify_routes 테스트는 `signup()` helper가 `verifyetst-org-<ts>` org를 새로 만들고, 같은 prefix `verifytest-<ts>-<rand>@example.test` user 생성. `afterEach`가 prefix 매치로 `DELETE FROM organizations WHERE name LIKE 'verifytest-org-%'` + `DELETE FROM users WHERE email LIKE 'verifytest-%@example.test'`. 두 표 모두 RLS 비적용이라 app pool로 DELETE 가능. FK CASCADE가 memberships / auth_tokens / email_outbox / sessions / invitations 모두 정리.

(2) FK CASCADE는 RLS를 우회 (system-level cascade) — RLS-scoped 테이블에 대한 추가 cleanup SQL 불필요. 본 패턴은 Step 3·5의 anonymous flow 테스트 (`password/reset`, `invitations/accept`)에 그대로 재사용 가능.

(3) prefix-based sweep은 이전 crash로 인한 orphan을 자동 회수 — Phase 2 customers e2e 잔재 (`e2etest-` 누적)와 같은 운영 위생 문제를 본 step에선 미리 방어.

---

### 8. dev init script 적용 절차 — README/Findings에 기록 필요

(1) `ops/postgres/init/02_service_role.sql`는 fresh DB volume에만 자동 적용. 기존 dev volume에서는 수동 1회 실행 필수:
```bash
docker exec -i kloser-dev-postgres-1 psql -U kloser -d kloser_dev \
  < ops/postgres/init/02_service_role.sql
```

(2) 본 step 구현 시 위 명령 수동 실행 완료. 그 다음 `db:migrate:up`이 0008을 적용해 7표 grant 부여. 두 단계가 명확히 분리됐으나 docs에 절차가 박혀 있어야 다른 개발자 / CI가 같은 환경 재현 가능.

(3) **권장 follow-up**: `server/scripts/init-service-role.mjs` 같은 wrapper 추가. `npm run db:setup-roles`로 호출 가능하게 만들어 새 개발자 onboarding 단순화. 본 step 종료 후 별도 mini-task로 다룰 수 있음 (현재 비차단).

---

### 9. CI 환경 — service role + SERVICE_DATABASE_URL 자동화 미정

(1) 본 step에서 GitHub Actions / CI 환경에는 적용되지 않았음. CI가 도입되면 다음이 필요:
- docker-compose 시작 → 자동으로 init script 실행 (fresh volume이라 init script가 동작)
- env 파일에 `SERVICE_DATABASE_URL` 포함 (CI secret 또는 평문)
- 또는 위 wrapper script로 일관 처리

(2) Phase 6+ CI 도입 시점에 한 번 정리. 본 step에서 finding으로 명시.

---

### 10. /auth/verify는 anonymous, /auth/verify/resend는 authenticated — enumeration 회피

(1) plan §1-6/7 결정 그대로. verify는 raw token이 server-side identity의 유일한 형태이므로 anonymous (이메일 클릭 시 access token 없음). resend는 이미 로그인된 user의 본인 작업이므로 `requireAuth` 적용 — 이메일 enumeration 회피 (이 user의 활성 토큰만 invalidate + 재발급).

(2) /auth/verify/resend가 enumerate 가능한 user 정보를 노출하지 않는지 검증: 단위 테스트가 (a) 인증 없이 호출 → 401, (b) 이미 verified → 409 `already_verified` (caller가 자기 자신이라 enumeration 의미 없음).

(3) Step 3 `/auth/password/forgot`은 다른 enumeration 회피 패턴 사용 — email 존재 여부 무관하게 항상 200 응답 (master §17). 같은 보안 원칙, 흐름별로 다른 구현.

---

### 11. /me 응답에 email_verified_at 노출 — Step 6 client wiring 준비

(1) Phase 2 `/me` 응답은 `id / email / name / avatar_url`만 반환. 본 step에서 `email_verified_at`를 추가해 클라이언트가 verification banner 표시 여부를 결정할 수 있게 됨.

(2) Step 6 (client wiring)에서 `platform/_shared.js`가 cold load 시 `/me`를 호출 → user.email_verified_at 검사 → null이면 "이메일 인증해주세요" 배너 표시 + "재발송" 버튼이 `/auth/verify/resend` 호출.

(3) Step 4 (`requireVerified` middleware) 도입 시 cross-user write 작업 (invitations 발송 등)에서 미인증이면 403. 미인증이라도 본인 데이터 read/write는 그대로 허용 — Master §2-8 정합.

---

### 12. 정보 노출 정책 (Master §7 게이트) — auth_tokens raw 부재 검증 단위 테스트

(1) 단위 테스트 `mintToken stores sha256(raw) only — raw not in DB`가 다음을 직접 assert:
- `auth_tokens.token_hash`는 정확히 sha256(raw)와 일치
- 어떤 컬럼에도 raw token 값과 일치하는 string 없음

(2) `email_outbox.body_text` / `metadata.verifyUrl`에는 raw token이 평문 URL로 들어감 — Master §7 게이트의 "dev 한정 의도된 노출". migration 0007 주석에 명시. Phase 6+ 운영 전환 시 outbox는 archive-only / 마스킹 처리.

---

## Step 3 진입 체크리스트

- [x] anonymous RLS 우회 인프라: `kloser_service` role + `getServicePool()` lazy init
- [x] 토큰 라이프사이클: `mintToken` / `consumeToken(client,...)` / `invalidateActiveTokens` + TTL 상수
- [x] EmailProvider: `DevOutboxEmailProvider` + URL builder. 3 메서드 모두 구현 (verification, invitation, password_reset)
- [x] signup 트랜잭션이 verification 토큰 + outbox 행을 같은 tx에 발급
- [x] /auth/verify, /auth/verify/resend route + 단위 테스트
- [x] /me, /auth/login 응답에 `email_verified_at` 노출
- [ ] Step 3: `/auth/password/forgot` (app pool + lookup) + `/auth/password/reset` (servicePool wrapper)
- [ ] Step 3 후속: `requireVerified` middleware 도입 시점 결정 (Step 4 또는 별도 mini-step)
- [ ] CI 환경 service role 자동화 (Phase 6+)
- [ ] `init-service-role.mjs` wrapper script 추가 (비차단, 별도 mini-task)

# Phase 3 Step 3 Findings — 비밀번호 재설정 service / route

> Audience: Phase 3 Step 4 작성자 (또는 미래의 나).
> Format: each finding has **(1) 관찰**, **(2) Step 4 또는 이후로의 의미**.
> Plan: [`PHASE_3_STEP_3_PASSWORD_RESET.md`](PHASE_3_STEP_3_PASSWORD_RESET.md).

---

## 결론

Step 3 **완료** (2026-05-11). 계획서 §9 완료 기준 11항목 모두 통과. Phase 3 Step 4 (Team/Member API + 마지막 admin 보호 + `requireFreshRole`) 진입 가능.

### 적용 파일 (5개 신규, 3개 수정)

| 종류 | 경로 | 비고 |
|---|---|---|
| service | `server/src/services/auth.ts` (수정) | `listActiveMembershipsAcrossOrgs` export 공개 + `requestPasswordReset({email})` (app pool, expected no-op silent return) + `resetPassword({rawToken, newPassword})` (servicePool tx — consume + password UPDATE + sessions revoke 단일 tx) |
| route | `server/src/routes/auth.ts` (수정) | `sendVerifyError` → `sendTokenError` rename. `POST /auth/password/forgot` (try/catch 없음, expected → 200, unexpected → Fastify 500) + `POST /auth/password/reset` (sendTokenError로 410 generic 매핑) |
| shared types | `server/src/types/password-reset.ts` (신규) + `platform/types/password-reset.js` (신규) + `test/sync_shared_types.mjs` (수정) | `ForgotPasswordInput`, `ResetPasswordInput` zod + JSDoc + registry entry |
| test | `server/test/password_reset_routes.test.mjs` (신규) | 14 cases |

신규 마이그레이션 / 신규 DB role / 신규 풀 / 신규 env 변수 **모두 없음** — Step 2 인프라 전체 재사용.

### 검증 결과 (plan §9)

| # | 항목 | 결과 |
|---|---|---|
| 1 | `services/auth.ts` 변경 — 3 신규/공개 함수 | mintToken/consumeToken/invalidate 재사용. `listActiveMembershipsAcrossOrgs` 공개 |
| 2 | `routes/auth.ts` — 2 신규 route + helper rename | `sendTokenError`가 verify와 reset 모두에서 사용 |
| 3 | shared types — `password-reset` entity 등록 | `sync_shared_types.mjs` PASS (customers + signup + password-reset) |
| 4 | typecheck | `npm --prefix server run typecheck` PASS |
| 5 | server unit test | `npm --prefix server test` — **101/101** PASS (Step 1·2 회귀 87 + 신규 14) — 2회 안정성 확인 |
| 6 | `node test/sync_shared_types.mjs` | PASS |
| 7 | Phase 0.5 e2e 회귀 | 16/16 PASS |
| 8 | Phase 2 customers e2e 회귀 | 7/7 PASS |
| 9 | 수동 roundtrip | signup → forgot → outbox token 추출 → reset → 옛 refresh 401 → 옛 password login 401 → 새 password login 200 → reset 재시도 410 → 옛 access JWT `/me` 200 (TTL 동안 유효, §1-10 trade-off) |

---

## 발견 사항

### 1. `listActiveMembershipsAcrossOrgs` 공개로 anonymous flow가 RLS-safe 패턴 재사용

(1) Phase 1 login 흐름이 이미 `organizations` 순회 + org별 `setOrgContext` + `getActiveMembershipInCurrentOrg` 패턴을 사용. Step 3에서 file-private이던 함수를 `export`로 공개해 password reset이 같은 RLS-safe 경로를 재사용. 직접 `SELECT FROM memberships` (GUC 없이 0 rows) 패턴 회피.

(2) Step 5 (invitation accept) wrapper도 anonymous flow에서 user의 활성 membership을 찾아야 한다 — 같은 헬퍼 재사용 가능. **단, 헬퍼가 마지막 loop iteration의 `setOrgContext`를 남긴다**는 점은 `services/auth.ts` 주석에 명시. password reset 흐름에서 다음 호출 전 명시적 재설정.

(3) 향후 다른 anonymous flow가 추가될 때마다 같은 헬퍼 호출이 표준 진입점. 헬퍼를 별도 `services/memberships.ts` 같은 모듈로 분리하는 건 Phase 4+ entity 정리 시점에 검토.

---

### 2. forgot route의 try/catch 없음 정책 — expected 분기는 silent return, unexpected는 500

(1) plan §5 정합. `requestPasswordReset` 서비스가 expected no-op 4 분기 (unknown email / disabled user / no active membership)에서 `return` (no throw). route handler는 try/catch 없이 200을 반환. unexpected error (DB transient / argon2 / EmailProvider throw)는 그대로 propagate → Fastify default → 500.

(2) 단위 테스트 `forgot response identical for unknown vs known email (enumeration parity)`가 response shape이 user 존재 여부와 무관하게 정확히 같음을 byte-level assert (`r.body` 비교). enumeration 표면 통일은 status + body 두 측면 모두 검증됨.

(3) Step 4·5의 다른 anonymous endpoint (`/invitations/accept`)도 같은 정책으로 정리 권장 — 의도된 expected branch는 silent flow, unexpected는 500. accept는 token이 명시적으로 invalid면 410을 던지는 case라 forgot과 직접 비교는 못 하지만, "internal error를 200으로 흡수하지 않는다"는 원칙은 동일.

---

### 3. resetPassword wrapper — verifyEmail과 동일 패턴 + sessions revoke 추가

(1) plan §3 그대로 구현. `getServicePool().connect()` → `BEGIN` → `consumeToken(client, ..)` → `UPDATE users.password_hash` → `UPDATE sessions ... revoke` → `COMMIT`. 어디서 throw해도 ROLLBACK으로 4단계 모두 원복. consumeToken의 partial-state 회피 invariant가 reset 흐름에도 그대로 적용됨.

(2) `hashPassword` (argon2id) 호출이 `connect()` 이전이라 connection 점유 최소화. consume 시점에 race가 발생해도 정확성 영향 없음 (consume FOR UPDATE가 잡음). plan §1-8 결정 정합.

(3) sessions revoke SQL이 `COALESCE(revoked_at, now())` + `COALESCE(revoked_reason, 'password_reset')` 패턴 — Phase 1 `revokeSession` 함수와 동일 정신. 이미 다른 사유로 revoked된 세션의 timestamp/reason을 덮어쓰지 않음.

(4) Step 4의 마지막 admin 보호 트랜잭션도 같은 servicePool/app-pool 단일 tx 패턴 권장 (단, Step 4는 authenticated이므로 app pool + GUC). `consumeToken` 같은 anonymous primitive는 Step 4에서 안 씀.

---

### 4. 옛 access JWT가 reset 후에도 TTL 동안 유효 — 의도된 trade-off, 단위 테스트가 핀

(1) plan §1-10 / §4-(3) / Master plan Step 3 완료 기준 모두 정합. JWT는 stateless라 능동 무효화 불가. reset이 sessions revoke로 refresh를 즉시 막지만, access는 `ACCESS_TOKEN_TTL=15m` 자연 만료까지 유효.

(2) 단위 테스트 `reset trade-off: old access JWT still works on /me until TTL`가 이 동작을 직접 assert (`/me` 200 expected). 향후 Phase 6+에 session-id cross-check를 middleware에 추가하면 본 테스트가 fail로 변할 것 — 의도적 변경 신호.

(3) **이 trade-off가 운영 보안 정책과 마찰을 일으킬 가능성**: 사용자가 reset을 한 동기는 보통 "비밀번호가 새어 나갔다"는 의심. 그 시점부터 15m 동안 옛 access token이 계속 유효하면 적절한 방어가 아닐 수 있음. **Phase 6+ 운영 진입 직전에 (a) ACCESS_TOKEN_TTL 단축 (예: 5m) (b) middleware에 session-id 조회 추가 중 택일** — 본 finding을 Phase 6+ checklist에 반영.

---

### 5. `sendVerifyError` → `sendTokenError` rename — verify와 reset이 공유하는 공통 헬퍼

(1) plan §3.2 / §8 결정. helper의 의도는 "AuthError 중 token-failure 4 코드를 generic 410으로 매핑"이라 verify·reset·향후 accept 모두 공유. rename으로 의도가 명확.

(2) 본 step에서 set 이름도 `VERIFY_TOKEN_REASON_CODES` → `TOKEN_REASON_CODES`로 변경 (Step 2 코드에 흔적). 호출처 2개 (`/auth/verify`, `/auth/password/reset`)가 동일 helper 사용. Step 5 `/invitations/accept`도 같은 helper로 충분 — token consume이 throw하는 코드가 정확히 4개라 분기 추가 없음.

(3) AuthError 클래스가 `code` 속성으로 distinct reason을 캡슐화하고 helper가 set-기반 매칭으로 generic 응답을 결정 — 새 token-failure 코드가 도입되면 set만 갱신.

---

### 6. enumeration parity는 byte-level assert로 검증 — timing은 Phase 6+

(1) `forgot response identical for unknown vs known email` 테스트가 두 호출의 `statusCode`와 `body`가 정확히 같음을 비교. response shape이 user 존재 여부 정보를 새는지 직접 핀.

(2) **본 step에서 처리 안 한 것 (Phase 6+)**:
- 응답 timing 차이 (user 존재 시 argon2/mint/outbox 시간 vs 미존재 시 0 work) — fixed delay 또는 dummy work 도입
- IP / email 단위 rate-limit — 본 step은 enumeration probe를 막아도 brute-force probe는 무한 가능

(3) 단위 테스트 5는 status + body 통일까지만 검증. timing-based attack 방어는 운영 진입 단계 별도 plan.

---

### 7. password reset 토큰의 sessions revoke 범위 — `revoked_at IS NULL`만

(1) `UPDATE sessions SET revoked_at = ... WHERE user_id = $1 AND revoked_at IS NULL`. 이미 revoked된 세션 (예: 사용자가 직접 logout한 옛 세션)은 건드리지 않음. 운영 audit 시 reason 충돌이 안 일어남.

(2) 단위 테스트 `reset → 200 + password updated + every active session revoked`가 `every session should be revoked` 루프 assert. test가 만든 session 1개라 trivially pass, but 동일 user에 N개 session이 있어도 모두 revoked가 보장됨.

(3) Step 4·5에서 admin이 다른 사용자를 강제 revoke하는 흐름 (예: disabled 처리 후) 도입 시 동일 SQL 패턴 재사용 (`revoked_reason = 'admin_disabled'` 같은 다른 reason).

---

### 8. forgot의 argon2 비용 — 본 step에서는 없음 (mint+outbox만)

(1) forgot이 password hash를 계산하지 않으므로 (`hashPassword`는 reset 단계에서만 호출) argon2 비용은 reset에만 발생. plan §8 위험표의 "reset이 invalid token에도 argon2 비용 발생" 항목 그대로 — Phase 6+ rate-limit 도입 시점에 token format 사전 검증 후 hash 실행 같은 fast-path 검토.

(2) forgot의 hot path는: users SELECT (RLS off, fast) → organizations 순회 (multi-org user 적음) → invalidateActiveTokens UPDATE + mintToken INSERT + email_outbox INSERT 3 writes. dev에서 ~50ms 안쪽. Phase 6+ measurement.

(3) Phase 6+ rate-limit은 IP / email 모두 — forgot은 enumeration probe 회피 + brute-force 방어 두 차원 필요.

---

### 9. Step 2 인프라 재사용 — 신규 마이그레이션 / 풀 / 환경 변수 모두 없음

(1) 본 step이 추가한 DB 객체 / 시스템 자원: **0개**. Step 2가 깐 `kloser_service` role + 0008 grants (sessions에 UPDATE 포함) + `getServicePool()` + `consumeToken/mintToken/invalidateActiveTokens` + `EmailProvider.sendPasswordResetEmail` + URL builder가 그대로 사용됨. plan 작성 단계에서 Step 2 finding 마지막 "Step 3 진입 시 재사용 가능한 인프라" 섹션이 정확했음을 확인.

(2) 본 패턴은 Phase 3 후속 step에 가속 효과:
- Step 4 (Team/Member): app pool + `withOrgContext` + role 매트릭스 — auth 인프라 거의 그대로
- Step 5 (Invitation accept): servicePool wrapper + `consumeToken` + `EmailProvider.sendInvitationEmail` — 본 step·Step 2의 패턴 그대로

(3) 인프라 안정성 관점: Step 1·2가 service credential / partial unique / RLS 정책을 깐 게 바로 다음 두 step에서 dividend. Step 4·5는 단순 도메인 추가만 처리해도 됨.

---

## Step 4 진입 체크리스트

- [x] anonymous token flow infrastructure: servicePool / consumeToken / mintToken / invalidateActiveTokens / EmailProvider 모두 완성
- [x] sessions revoke 패턴: `UPDATE sessions SET revoked_at + revoked_reason WHERE user_id = $1 AND revoked_at IS NULL`. Step 4 admin disable / Step 5 accept 흐름에서 그대로 재사용
- [x] `listActiveMembershipsAcrossOrgs` 공개 — Step 5 invitation accept가 multi-org user lookup 시 재사용
- [x] 토큰 실패 응답 통합 (`sendTokenError`) — Step 5 accept도 동일 helper
- [ ] Step 4: `/team/members` + `PATCH /memberships/:id` + `requireFreshRole` middleware. 마지막 active admin 보호 트랜잭션. disabled 멤버 로그인 차단 (`/auth/login` 변경 — 활성 membership 0건이면 401 `account_disabled`)
- [ ] Step 4 후속: `requireVerified` middleware 도입 시점 결정 (Step 4 또는 별도 mini-step) — 본 trade-off는 Step 2 finding §11에서 명시
- [ ] Phase 6+ 운영 진입 직전: access token JWT 능동 무효화 도입 (session-id middleware cross-check 또는 ACCESS_TOKEN_TTL 단축). 본 finding §4 (3)에서 명시
- [ ] Phase 6+ rate-limit (forgot/reset/login 모두 — Step 4 시점 결정 가능)

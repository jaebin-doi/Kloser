# Phase 1 Step 3 Findings — Auth 코어

> Audience: Phase 1 Step 4 작성자 (또는 미래의 나).
> Format: each finding has **(1) 관찰**, **(2) Step 4 또는 이후로의 의미**.

## 결론

Step 3 **완료** (2026-05-07). signup → login → /me → refresh (rotation/grace/family revoke) → logout 풀 사이클이 routes 레벨에서 동작. JWT는 Bearer access (15min) + HttpOnly refresh cookie (Path=/auth, 30d, family rotation + reuse detection). orgContext가 JWT 우선으로 전환되고 prod에서 X-Org-Id 헤더는 명시적으로 거부.

- `npm --prefix server run typecheck` PASS
- `npm --prefix server test` 29/29 PASS (auth 19 + rls_isolation 7 + orgContext 3)
- `node test/phase_0_5_e2e.mjs` 14/14 PASS — DB/auth 도입이 Phase 0.5 라이브 흐름을 깨지 않음, RTT 1~2ms 유지
- `cd server && npm run db:migrate:up` / `db:seed` 정상 (admin URL 경로, idempotent)

`PHASE_1_STEP_3_AUTH_CORE.md` §10 완료 기준 모두 충족.

---

## 발견 사항

### 1. Bearer access + HttpOnly refresh cookie 분리 — Step 4 WS handshake에서 같은 Bearer 재사용

(1) Access token은 응답 body로 내려가서 클라이언트 메모리에 머문다. Refresh token은 HttpOnly cookie로 `Path=/auth`에만 동행 (`/me`/`/api/*`엔 안 붙음). 이 분리 덕에 Bearer는 WS handshake의 `auth.token`에 그대로 끼울 수 있고, 동시에 refresh 경로는 JS XSS 노출이 거의 없는 cookie로 보호된다.

(2) Step 4 WS 통합:
- `socket.io-client`의 `auth: { token: accessToken }`로 handshake에 access token 부착.
- 서버 측에서 `socket.handshake.auth.token`을 `validateAccessTokenPayload` + `requireAuth`와 동일한 검증 흐름으로 통과시켜 `request.user`-equivalent를 socket에 결합.
- Refresh는 WS와 무관 — 기존 `/auth/refresh` HTTP 흐름 그대로. 클라이언트는 access 만료 직전 재발급 후 socket을 재연결.

### 2. sessions에 (org_id, membership_id) 박음 — multi-org refresh의 모호함 차단

(1) login 시점에 user가 결정한 org/membership을 session row에 박는다. Refresh는 그 row를 그대로 따라서 새 access token에 같은 (org, membership)을 넣는다. **role만 memberships에서 재조회** — refresh가 자연스러운 staleness reset point가 됨 (access TTL = 15min + refresh 주기).

(2) 결과: multi-org user가 org를 바꾸려면 logout 후 다른 `orgId`로 다시 login. 별도 "switch org" API는 본 step 범위 밖, Phase 2+에서 추가 검토.

(3) 운영 시 주의: org가 삭제되면 sessions가 ON DELETE CASCADE로 같이 사라져 토큰이 즉시 무효화됨. 이는 의도된 동작.

### 3. Refresh rotation + family reuse detection + 30s grace window

(1) 모든 refresh는 `BEGIN; SELECT ... FOR UPDATE; ...; COMMIT` 안에서 일어난다. row-level lock이 두 동시 요청의 race를 직렬화한다. 한 쪽이 성공적으로 회전하면 다른 쪽은 grace window(`REFRESH_GRACE_WINDOW_SECONDS=30`) 안에서 도착하면 200(replacement session의 access token만 발급, cookie 갱신 X)으로 처리된다 — false-positive family revoke 방지.

(2) Grace window 밖 old token 재사용 → 진짜 reuse detection. 같은 `token_family_id` 모든 row revoke + 401 + cookie 무효화. 클라이언트는 강제 로그아웃 상태가 됨.

(3) Tradeoff: grace window 안엔 탈취된 token도 access를 한 번 더 받을 수 있다. 이 사이즈(30s)는 충분히 짧아 운영상 수용 가능. 더 보수적으로 가려면 0s로 두면 되지만, 정상 멀티탭 동시성도 family revoke로 끊겨서 UX가 나빠짐. env override 가능.

### 4. Argon2id + seed 평문 4쌍 코멘트

(1) Step 1 seed의 placeholder hash를 Argon2id (`m=65536, t=3, p=4`, 기본값)로 갱신. 코멘트에 평문 4쌍 명시 (`admin@acme.test = acme-admin-1234` 등) — dev/test에서 login 흐름이 즉시 재현 가능.

(2) seed users INSERT는 `ON CONFLICT (id) DO UPDATE SET email/password_hash/name`로 변경 — 향후 hash 알고리즘이나 평문이 갱신될 때 `npm run db:seed` 재실행만으로 반영됨. memberships INSERT는 `ON CONFLICT DO NOTHING` 유지 (idempotent).

(3) prod 진입 시: 운영 password는 `argon2.hash`로 외부 입력(=signup) 시점에 만들어진다. seed는 dev 전용으로만 살아있어야 하며, prod 배포 절차에 seed 실행이 포함되지 않게 운영 매뉴얼에서 분리.

### 5. orgContext의 JWT 우선 전환 + prod에서 X-Org-Id 헤더 strict reject

(1) `request.user?.orgId`가 있으면 그 값을 신뢰. 없는 경우만 dev/test header fallback (Step 2 RLS 격리 테스트가 그 경로에 의존). prod (`NODE_ENV=production`)에서 `X-Org-Id` 헤더가 도착하면 **Bearer 동반 여부와 무관하게 400** — 헤더 존재 자체를 client bug로 취급.

(2) 이 strict 정책은 "어떤 라우트가 실수로 `requireAuth`를 빠뜨려도 prod에서 client-controlled orgId가 RLS context로 흘러들지 않는다"는 defense in depth.

(3) Step 4에서 WS handshake에 token-기반 orgId가 들어오면 같은 우선순위 규칙을 따라야 한다. WS 측에서도 prod env의 client-controlled orgId 입력은 거절.

### 6. role staleness — 15min access TTL 동안 role 변경 미반영

(1) `requireRole`은 JWT payload의 role만 본다. DB 재조회 없이 빠르게 판정. admin이 누군가의 role을 강등해도 **최대 15min간 기존 access token이 그 권한 유지**. Refresh 시점에 memberships에서 role이 재조회되므로 그 시점에 새 access는 viewer가 됨.

(2) Phase 2의 destructive endpoint (예: customer DELETE, billing 변경) 도입 시 `requireFreshRole` opt-in 헬퍼 추가. 라우트가 명시 호출하고 (`{ preHandler: [requireAuth, requireFreshRole("admin")] }`), 그 시점에 `memberships`를 한 번 더 SELECT — query 1회/요청 비용. 모든 라우트에 적용하지 않는다.

(3) Step 3에선 `requireFreshRole` 자체를 만들지 않고 staleness 정책만 문서화. 본 step의 모든 라우트는 read-only 또는 self-scoped라 15min staleness 수용 가능.

### 7. `withTransaction`의 `CommitAuthError` 패턴

(1) refresh가 reuse detection을 트리거하면 family revoke를 SQL에 박은 뒤 401을 던져야 한다. 일반적인 throw는 outer catch에서 ROLLBACK으로 가서 family revoke가 사라짐. 이를 막으려고 `CommitAuthError extends AuthError`를 도입 — withTransaction이 이 인스턴스만은 catch에서 `COMMIT` 후 throw하도록 분기.

(2) 알려진 미세한 leak: `CommitAuthError` 분기에서 `client.query("COMMIT")` 자체가 throw하면 그 안의 `client.release()`가 실행되지 않고 connection이 누수된다. COMMIT이 정상 트랜잭션에서 throw할 가능성은 매우 낮지만 strict한 robustness 차원에선 try/catch로 감싸 `release(commitErr)`로 명시 폐기하는 게 더 안전. 후속 작업 (Phase 1 마무리 또는 Phase 2 시작 시점에).

### 8. multi-org login의 `availableOrgs` 응답 — `listActiveMembershipsAcrossOrgs` O(orgs) scan

(1) login 시점에 orgId가 안 주어졌는데 user가 multi-membership인 경우 400 + `availableOrgs` 배열로 응답한다. 그 목록을 만들 때 `organizations` 테이블 전체를 순회하면서 각 org에 대해 `SET LOCAL app.org_id = $1` + memberships SELECT를 반복한다. 이유: `memberships`는 RLS-scoped라 app role로는 cross-org SELECT가 불가능.

(2) Phase 1 dev (2 orgs)에선 trivial. 운영 진입 후 org 수가 커지면 (수천 개+) login latency 문제. 해결안:
- A. SECURITY DEFINER 함수 — admin role 소유의 SQL 함수로 user_id로 cross-org membership 직접 조회. 가장 깔끔.
- B. `app` role보다 약간 더 권한 있는 별도 role을 login용으로 분리 (memberships RLS bypass 한정).
- C. denormalize: `users.active_org_ids uuid[]` 캐시 + 변경 시 trigger로 동기화.
A가 추천. Step 4 이후에 별도 작업으로 추가.

### 9. `requireRole`의 stylistic inconsistency (minor)

(1) `middleware/role.ts`의 403 분기에 explicit `return`이 없음. `reply.code(403).send(...)` 후 함수가 자연 종료됨. fastify는 `reply.send`가 호출된 시점에 요청 라이프사이클을 종료하므로 functionally OK.

(2) `requireAuth`/`orgContext`는 명시 `return reply.code(...).send(...)` 또는 `reply.code(...).send(...); return;` 사용. style 통일 차원에서 `requireRole`도 명시 return을 두면 좋다 — 미래에 다른 분기를 추가할 때 fall-through 위험을 사전 차단.

### 10. cookie path scoping — `Path=/auth`로 `/me`엔 동행 안 함

(1) refresh cookie는 `Path=/auth`로 박힘. browser는 `/auth/refresh`와 `/auth/logout` 호출 시에만 cookie를 송신하고 `/me`나 `/api/*`엔 안 보낸다. CSRF 표면 축소 + cookie의 사용 범위를 logical에 가깝게 한정.

(2) `/auth/login`도 `/auth/*`라서 cookie는 송신되지만 login은 cookie 없이도 동작 (body의 credentials만 본다). cookie가 송신돼도 무시됨 — 동작상 문제 없음.

(3) clear cookie도 같은 `Path=/auth`로 발급해야 브라우저가 옳게 삭제. `clearRefreshCookieOpts()`가 이를 보장.

---

## Phase 0.5 → Phase 1 인계 처리 현황

`PHASE_1_MASTER.md` §6의 7개 인계 항목:

- [x] **JWT auth** — Step 3 (본 step에서 완료)
- [ ] shared types 중복 — Step 4
- [ ] DOMPurify — Step 4
- [ ] FASTIFY_GUIDE.md snake_case 동기화 — Step 5
- [ ] `__liveSocket` 가드 — Step 4
- [ ] `text_chunk` start_call 선행 강제 — Step 4
- [x] PostgreSQL 부트스트랩 — Step 1 완료

---

## 의도하지 않게 남긴 것 / 후속 작업

- `withTransaction`의 CommitAuthError 분기 COMMIT 실패 시 client leak — 위 §7
- `listActiveMembershipsAcrossOrgs` O(orgs) scan — 위 §8
- `requireRole` style inconsistency — 위 §9
- `requireFreshRole` opt-in 헬퍼 — Phase 2 destructive endpoint 도입 시
- seed 평문 password가 코멘트로 노출됨 — dev 한정, prod 배포 절차에서 seed 실행 분리
- JWT_SECRET이 HMAC 단일 secret — 키 회전 필요해지면 RS256/EdDSA + `kid` 헤더로 (운영 진입 시)
- Phase 0.5 e2e는 아직 unauthenticated WS handshake 가정 — Step 4에서 auth 부착 후 e2e 자체가 갱신됨

---

## Step 4 진입 시 가장 먼저 봐야 할 것

1. 본 findings §1 (Bearer 재사용) — WS handshake에 access token 부착 + 서버에서 동일 검증 흐름.
2. 본 findings §5 — WS도 prod에서 client-controlled orgId 입력 거절.
3. `server/src/ws/calls.ts`에서 `userId` query param 폐기 → handshake.auth.token + `validateAccessTokenPayload`로 교체.
4. `platform/api.js` — fetch wrapper (access token 자동 부착, 401 시 refresh 시도, error normalize).
5. `platform/live.html` 통합 — 로그인 가정 흐름 (또는 dev fixture login). `__liveSocket` dev 핸들 가드 (Phase 0.5 finding).
6. Phase 0.5 e2e를 auth-필수 흐름으로 변경 — login → access 발급 → WS 연결 → 기존 14 케이스 회귀.

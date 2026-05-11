# Phase 3 Step 5 Findings — Invitation API (생성·목록·재발송·취소·익명 수락)

> Audience: Phase 3 Step 6 작성자 (client wiring) + Step 7 종합 e2e.
> Format: each finding has **(1) 관찰**, **(2) Step 6/7 또는 이후로의 의미**.
> Plan: [`PHASE_3_STEP_5_INVITATION_API.md`](PHASE_3_STEP_5_INVITATION_API.md).

---

## 결론

Step 5 **완료** (2026-05-11). 계획서 §12 완료 기준 14항목 모두 통과. Phase 3 Step 6 (client wiring) 진입 가능.

### 적용 파일 (6 신규, 5 수정)

| 종류 | 경로 | 비고 |
|---|---|---|
| route helper | `server/src/routes/_tokenErrorMap.ts` (신규) | `sendAuthError` + `sendTokenError` 공용화. /auth/verify · /auth/password/reset · /invitations/accept 셋이 같이 사용. 4 코드 (`token_not_found` / `token_already_used` / `token_invalidated` / `token_expired`)를 `410 token_invalid_or_expired` generic으로 매핑 |
| service helper | `server/src/services/auth-tokens.ts` (수정) | `findTokenByRaw` (no-lock SELECT) + `lockAndValidateTokenById` (FOR UPDATE + 4 fail 코드 검사) + `markTokenConsumed` (UPDATE only) 3개 추가. 기존 `consumeToken`은 그대로 — verify/reset에서 계속 사용. 본 split은 accept tx의 lock 순서를 `invitations → auth_tokens`로 유지하면서 happy-path 끝에서만 consume mark가 commit되도록 분리 |
| repo | `server/src/repositories/invitations.ts` (신규) | `findPendingByOrgEmailForUpdate` / `findActiveTokenByInvitationForUpdate` / `createInvitationRow` / `cancelInvitationRow` / `markAcceptedRow` / `touchLastSentAt` / `getByIdForUpdate` / `getListItemById` / `listActivePendingForCurrentOrg`. invitations 테이블에 `updated_at` 없는 점 (Phase 1 schema + Phase 3 §2-4 enrich 모두) 반영해 `accepted_at` / `canceled_at` 마커만 갱신 |
| service | `server/src/services/invitations.ts` (신규) | 5 함수. `createInvitation` (already_member 사전 가드 + 만료 자동 재발급 + 23505 partial-unique race → 409 invitation_already_pending). `resendInvitation` (FOR UPDATE → 옛 토큰 invalidate → mint → touch last_sent_at → outbox). `cancelInvitation` (soft cancel + 옛 토큰 invalidate). `acceptInvitation` (servicePool tx — lock 순서 `invitations → auth_tokens`, disabled_at 가드, already_member 가드, users.email 23505 ON CONFLICT 흡수, memberships 23505 → 409 already_member, consume mark는 happy-path 끝부분) |
| service | `server/src/services/auth.ts` (수정) | `buildAccessPayload` + `createSessionWithToken`을 module-private → `export`. invitations 서비스가 같은 session shape 발급에 재사용 |
| route | `server/src/routes/invitations.ts` (신규) | 5 endpoint. mutation 3개에 `requireAuth → orgContext → requireRole('admin') → requireFreshRole` 체인. accept는 anonymous (`sendTokenError` 매핑). plugin-scoped error handler가 ZodError + AuthError 매핑 |
| route | `server/src/routes/auth.ts` (수정) | file-local `sendAuthError` + `sendTokenError` 삭제. `_tokenErrorMap`에서 import |
| server | `server/src/server.ts` (수정) | `invitationsRoutes` register |
| shared types | `server/src/types/invitation.ts` (신규) + `platform/types/invitation.js` (신규) + `test/sync_shared_types.mjs` (수정) | `Invitation`, `InvitationCreateInput`, `InvitationAcceptInput` |
| test | `server/test/invitation_routes.test.mjs` (신규) | 30 cases (plan §9 26 + race·cleanup 4) |
| docs | `docs/plan/phase-3/PHASE_3_MASTER.md` (수정 — plan 통과 단계에 이미 commit) | §2-14 / §3-302 / "전사 적용" 단락 모두 invitation `requireFreshRole` 범위를 "생성·재발송·취소"로 갱신 + accept 명시 제외 |

### 검증 결과 (plan §12)

| # | 항목 | 결과 |
|---|---|---|
| 1 | typecheck (`npm --prefix server run typecheck`) | PASS |
| 2 | server unit test (`npm --prefix server test`) | **155/155** PASS (Step 1·2·3·4 회귀 125 + 신규 30) |
| 3 | `sync_shared_types.mjs` | PASS (customers + signup + password-reset + team + invitation) |
| 4 | Phase 0.5 e2e (`node test/phase_0_5_e2e.mjs`) | 16/16 PASS |
| 5 | Phase 2 customers e2e (`node test/phase_2_customers_e2e.mjs`) | 7/7 PASS |
| 6 | 수동 검증 | (자동 테스트 30종이 매뉴얼 시나리오를 모두 포함 — admin 초대 발송 → outbox raw token 추출 → accept (신규 user) → /me로 새 org 확인 → resend가 옛 token 무효화 → cancel이 토큰 무효화 → disabled user 차단 → already_member 차단 → 동시 multi-org accept 양쪽 성공) |

---

## 발견 사항

### 1. servicePool에 DELETE 권한 없음 — 테스트 cleanup은 app pool + RLS 컨텍스트로

(1) Migration 0008 service_grants는 `SELECT, INSERT, UPDATE`만 `kloser_service`에 부여한다. 본 step 첫 테스트 실행에서 afterEach가 `svc().query("DELETE FROM auth_tokens ...")` 호출하자마자 `42501 permission denied for table auth_tokens`. invitations / email_outbox도 같은 grant 표를 따르므로 같이 막혔다.

(2) 두 가지 선택지:
| 옵션 | 결정 |
|---|---|
| migration 추가해 `DELETE` 부여 | **No.** Step 5 plan lock-in #17 "신규 grant 없음" 위배 |
| app pool + `withOrgContext`로 RLS 스코프 안에서 DELETE | **Yes.** app pool은 NOBYPASSRLS이지만 일반 postgres user는 DELETE 권한 있음. RLS 정책이 `USING (org_id = current_app_org_id())`라 GUC 안의 DELETE는 통과 |

(3) Step 6+ 클라이언트 / e2e가 임의 데이터를 정리해야 하는 경우 같은 패턴: 운영 코드가 servicePool에서 DELETE를 요구하면 grant 표가 부족하다는 신호 → 코드를 app pool로 옮기거나 별도 admin 흐름으로 분리. 운영 시나리오상 anonymous 흐름이 DELETE할 곳이 없으므로 grant 표는 그대로 유지.

(4) `users` / `organizations`는 RLS 없음 — app pool 직접 DELETE OK. 본 테스트 afterEach도 그렇게 분리: 비-RLS 테이블 → 직접 / RLS 테이블 → `withOrgContext` 안에서.

---

### 2. invitations 테이블에 `updated_at` 없음 — Phase 1 schema의 의도된 단순화

(1) Phase 1 init.sql의 invitations는 `created_at` 1개만. Phase 3 Step 1 enrich migration이 `team_id` / `invited_by_user_id` / `canceled_at` / `last_sent_at` 4개를 추가했지만 `updated_at`은 일부러 두지 않았다. 라이프사이클이 (a) created → (b) maybe last_sent_at touched → (c) accepted_at | canceled_at 중 하나 set → 종료. 각 marker가 timestamptz라 별도 `updated_at` 트리거가 잉여.

(2) 본 step 첫 구현에서 plan §6.1 예시 코드가 `UPDATE invitations SET accepted_at = now(), updated_at = now()` 으로 적어 있었다. 그대로 베끼면 `column "updated_at" of relation "invitations" does not exist` 42703 발생. Fix: repo의 cancel/markAccepted/touchLastSent 모두 `updated_at` 제거.

(3) Step 6 client는 "마지막 변경 시각"을 `last_sent_at` 또는 `accepted_at` / `canceled_at` 중 가장 최근 값으로 계산해야 함. invitations에는 단일 `updated_at`이 없다.

(4) memberships도 Phase 1 schema에 `updated_at`이 있지만 trigger는 customers 전용이라 Phase 3 Step 4가 `updateRoleStatus`에서 명시적으로 `SET updated_at = now()` 한다. 본 step의 invitations는 같은 트리거 부재를 다르게 흡수 — 컬럼 자체를 두지 않음. Phase 3 안에서 "변경 timestamp" 정책이 테이블별로 갈리므로 Step 6 UI 코드에서 한 가지 컬럼 가정 금지.

---

### 3. accept 흐름의 lock 순서 통일 — `invitations → auth_tokens`

(1) Step 5 plan 3차 Codex review #1이 지적한 deadlock 위험을 막기 위해 모든 invitation tx (createInvitation 만료 재발급 / resendInvitation / cancelInvitation / acceptInvitation)가 `invitations FOR UPDATE`를 먼저 잡고, 짝 `auth_tokens` 행을 그 다음에 잡는다.

(2) acceptInvitation은 raw token으로 시작하므로 token row를 먼저 알아내야 하는 자연스러운 순서를 깨야 했다. 해결: 새 헬퍼 `findTokenByRaw`로 **no-lock SELECT**만 해서 `token_id` + `invitation_id`를 회수 → `invitations FOR UPDATE` → `lockAndValidateTokenById`로 token row를 그 다음에 잡음. 두 SELECT 사이에 cancel/resend가 끼어들면 `lockAndValidateTokenById`의 `invalidated_at IS NOT NULL` 분기에서 410이 나옴.

(3) `consumeToken`은 그대로 — verify/reset에는 post-consume 409 분기가 없어 single-step (FOR UPDATE + UPDATE) 헬퍼가 더 단순. 두 헬퍼 셋이 공존: Step 2의 `consumeToken` (verify/reset 전용) + Step 5의 `findTokenByRaw` / `lockAndValidateTokenById` / `markTokenConsumed` (accept 전용).

(4) Step 6 client는 본 lock 순서를 의식할 필요 없음 — wire shape만 본다. Step 7 e2e가 race를 확인하려면 두 동시 cancel 요청 / accept ↔ cancel 동시 등을 부하 테스트 형태로 검증 가능 (본 step 단위 테스트에는 accept-vs-cancel race를 driving 안 함, race 흡수는 코드와 plan §6.1로만 보장).

---

### 4. accept 409의 rollback semantics — token consumed_at 보존 정책

(1) `account_disabled` / `already_member` 두 분기는 `acceptInvitation` tx의 step 4·5에서 throw → catch에서 ROLLBACK. `markTokenConsumed`는 step 10 (happy-path 마지막)에 있어 ROLLBACK이 그 호출 이전을 되돌릴 게 없음. 결과: 토큰의 `consumed_at`은 **NULL인 상태로 commit된 적이 없음**. 다음 요청도 같은 token으로 같은 row 검사 통과 → 같은 409.

(2) 본 정책의 의미:
| 시나리오 | 결과 |
|---|---|
| admin이 disabled user를 활성화 후 user가 같은 link 클릭 | 통과 — 같은 token이 활성으로 살아 있음 (TTL 안이라면) |
| admin이 race-add membership을 의도적으로 제거하고 user가 재시도 | 통과 |
| 시간이 만료될 때까지 disabled / member 상태 유지 | 토큰이 자연 만료되고 410 generic으로 전환 |

(3) 두 테스트 (`disabled user → 409 + retry 409 + token NOT consumed`, `already-member race → 409 + retry 409 + token NOT consumed`)가 `auth_tokens.consumed_at IS NULL`을 명시적으로 assert. 본 invariant를 회귀 보장.

(4) Step 6 client UI는 "이미 가입된 계정입니다 — 관리자에게 문의하세요" / "비활성화된 계정입니다" 안내를 409 코드로 분기. 같은 안내가 반복적으로 노출되어도 token이 unburned라 데이터 손실 없음.

---

### 5. users.email UNIQUE race 흡수 — ON CONFLICT DO NOTHING + 재조회

(1) Codex review #4에서 지적된 동시 multi-org accept 시 새 user INSERT 23505. Fix: `INSERT INTO users (...) ON CONFLICT (email) DO NOTHING RETURNING id` + 결과 비면 같은 email로 SELECT 재조회 + disabled_at / already_member 재검사 후 multi-org membership 경로.

(2) 테스트 `concurrent multi-org same new email → both succeed`가 같은 새 email로 Acme + Beta 양쪽 초대 발송 후 `Promise.all`로 동시 accept. 응답 상태 코드는 `[200, 201]`의 어느 순열도 통과 (둘 다 200이거나 둘 다 201이면 안 됨 — 한 쪽은 user 신규 생성자, 다른 쪽은 multi-org 추가). DB는 users 1행 + memberships 2행 (org당 1개) 확인.

(3) `users` 테이블에 INSERT는 application pool / service pool 양쪽 다 통과 (users는 RLS 없음, kloser_service grant 표 INSERT 포함). 본 ON CONFLICT 패턴이 단순 race 흡수 외에도 "같은 email user가 이미 있으면 멤버 추가 모드" 메타-동작을 한 SQL로 표현해 코드가 짧음.

(4) Step 6 client 응답 처리: `created: true` (201) → "환영합니다, 회원가입 완료". `created: false` (200) → "기존 계정으로 새 조직에 참여했습니다". 둘 다 access token + Set-Cookie 동일하므로 즉시 로그인 상태.

---

### 6. POST /invitations route response shape — `Invitation` 정합

(1) Plan §2.2가 `response 201: { invitation }`만 적어두었지만 실제 응답 shape은 `Invitation` zod (id / org_id / email / role / team_id / team_name / invited_by_user_id / invited_by_name / last_sent_at / token_expires_at / created_at)와 정합해야 GET /invitations 와 wire 균일. 구현은 service의 INSERT 직후 `getListItemById` repo 호출로 같은 JOIN (teams + users + auth_tokens) 결과를 한 번 더 SELECT → 응답 body.

(2) `getListItemById`가 active pending 필터 (`accepted_at IS NULL AND canceled_at IS NULL`)를 그대로 적용하므로 막 만든 row가 그 조건을 만족하는 한 항상 hit. 만약 dev tooling이 outbox 발송 중 에러로 invalidate를 일으켰다면 null return → service가 500 throw. 본 시나리오는 일반 경로에서 발생 안 함.

(3) Step 6 client는 POST /invitations 201 응답을 GET /invitations 목록에 동일 shape으로 prepend 가능 — 추가 fetch 없이 즉시 row 추가 가능.

---

### 7. 평균 30 invitation 테스트 + 회귀 125 = 155 total, e2e 변화 없음

(1) 본 step의 surface는 5개의 새 endpoint + 1개 helper module 분리 + 1개 shared type entity. 기존 endpoint / shared type의 wire shape에는 변경이 없으므로 e2e는 회귀만 측정. Phase 0.5 e2e (16/16 PASS) + Phase 2 customers e2e (7/7 PASS) 그대로.

(2) Phase 3 종합 e2e (Step 7)에서 본 step의 흐름을 통합 시나리오로 검증 예정: admin login → invite → outbox token 추출 → accept (신규 user) → /me / /team/members 확인 → resend → cancel.

(3) 단위 테스트 30종은 plan §9가 제시한 ~25 + race·cleanup·body validation 추가 분 4. 모두 `invitetest-` prefix 또는 seeded Acme/Beta scope이라 afterEach가 결정적 cleanup. 본 패턴은 Step 6 client e2e가 같은 prefix-기반 isolation을 그대로 차용할 수 있음.

---

## 인계 사항 (Step 6 → client wiring)

- Step 6 wire shape: 본 step의 `Invitation`, `InvitationCreateInput`, `InvitationAcceptInput` zod 그대로. platform JSDoc mirror (`platform/types/invitation.js`)도 동일.
- `POST /invitations/accept` 응답은 `/auth/signup` / `/auth/login`과 같은 AuthResult shape — 클라이언트는 같은 핸들러 재사용 가능. `created: boolean` 필드는 추가되지 않음 (`status` 201/200으로만 구분).
- 응답 상태 코드 매트릭스 client 분기:
  | endpoint | 코드 | 의미 |
  |---|---|---|
  | POST /invitations | 201 | created |
  | POST /invitations | 400 invalid_team / 400 invalid_input | 입력 오류 |
  | POST /invitations | 409 already_member | 이미 같은 org member |
  | POST /invitations | 409 invitation_already_pending | live pending 중복 |
  | POST /:id/resend  | 200 ok=true | 재발송 성공 |
  | POST /:id/resend  | 409 invitation_already_finalized | 이미 accepted/canceled |
  | DELETE /:id       | 204 | 취소 성공 |
  | POST /accept      | 201/200 + AuthResult | 신규/기존 user 수락 |
  | POST /accept      | 410 token_invalid_or_expired | 4 코드 collapsed |
  | POST /accept      | 409 account_disabled | global disabled user |
  | POST /accept      | 409 already_member | (race 회복) |
  | POST /accept      | 400 invalid_input | password short / 누락 |
- raw token은 dev 환경에서 `email_outbox.metadata.acceptUrl` 또는 `body_text`의 `?token=` query string으로 직접 추출 가능 (운영 SMTP/Resend 어댑터는 Phase 6+에서 raw를 mask). Step 6 e2e가 같은 outbox 추출 패턴을 그대로 차용.

## 한 줄 결론

> **Step 5 완료. 5 endpoint × 30 단위 테스트 + 회귀 125 + e2e 23 = 178개 검증 통과. 신규 마이그레이션 / pool / grant / env 0개. Phase 3 server 코드 완성도 ~95% (남은 건 Step 7의 통합 e2e 시나리오 정도).**

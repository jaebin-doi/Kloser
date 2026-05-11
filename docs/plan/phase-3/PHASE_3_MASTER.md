# Phase 3 — 회원가입 / 이메일 / 팀 초대 마스터 플랜

> **상위 계획**: `docs/plan/roadmap/BACKEND_PLAN.md` v0.4 §8 Phase 3.
> **선행 단계**: Phase 2 완료 — `docs/plan/phase-2/PHASE_2_MASTER.md`.
> **기간**: 1.5~2주 (sub-step 단위로 분해).
> **단계별로 진행**한다. 한 sub-step이 끝나야 다음으로 간다.

---

## 진행 상태 (Implementation Log)

> 이 섹션은 sub-step 진행 시 갱신된다. 본 plan은 master로, 각 sub-step은 별도 `PHASE_3_STEP_X_*.md` 문서에서 상세 설계.

- [x] **Step 1** — Schema 보강(auth_tokens, email_outbox, invitations 보강, memberships.status) + RLS + 시드 → `PHASE_3_STEP_1_SCHEMA.md` + `PHASE_3_STEP_1_FINDINGS.md` (2026-05-11)
- [x] **Step 2** — 회원가입 + 이메일 인증 service/route + 단위 테스트 → `PHASE_3_STEP_2_SIGNUP_VERIFY.md` + `PHASE_3_STEP_2_FINDINGS.md` (2026-05-11)
- [ ] **Step 3** — 비밀번호 재설정 service/route + 단위 테스트 → `PHASE_3_STEP_3_PASSWORD_RESET.md`
- [ ] **Step 4** — Team / Member API + 마지막 admin 보호 + 권한 단위 테스트 → `PHASE_3_STEP_4_TEAM_MEMBER.md`
- [ ] **Step 5** — Invitation API (생성/재발송/취소/수락) + route 테스트 → `PHASE_3_STEP_5_INVITATIONS.md`
- [ ] **Step 6** — 클라이언트 wiring (signup / forgot / reset / accept / team.html 실 API) → `PHASE_3_STEP_6_CLIENT.md`
- [ ] **Step 7** — Phase 3 e2e + Phase 3 종합 findings → `PHASE_3_STEP_7_E2E.md`, `PHASE_3_STEP_7_FINDINGS.md`

---

## 0. 왜 Phase 3인가

Phase 1·2가 인증·격리·권한·세션·첫 비즈니스 entity까지 갖춰뒀지만, **사용자가 자기 조직을 새로 만들거나 동료를 초대할 길은 아직 없다.** 평가자가 사전 발급된 시드 계정만 쓰는 단계에서 멈춰 있고, 초대 메일·비밀번호 분실 흐름은 mock으로만 존재한다. Phase 3은 그 길을 연다.

핵심 산출물:

1. **자가 회원가입 + 이메일 인증** — 사전 발급 계정 없이도 새 조직·관리자 계정 생성 가능
2. **비밀번호 재설정** — 분실 시 자가 복구
3. **Team / Member API** — 조직 안 멤버 관리 (role 변경, 비활성화)
4. **직원 초대** — 생성·재발송·취소·수락 흐름 완성. 기존 `invitations` 테이블 활용
5. **`platform/team.html` mock 제거** — 실 API 연결, 평가자가 실제 멤버 운영 가능
6. **이메일 dev outbox** — 실제 SMTP/Resend 없이 dev 환경에서 이메일 흐름 검증 (Phase 6+에서 운영 provider 연결)

이걸 다 끝내고 나면 Phase 4 (calls / transcripts 영속 + 대시보드 실 KPI)로 넘어간다.

---

## 1. 범위 (Scope)

### 한다

**스키마**
- `auth_tokens` 신규 — 이메일 인증 / 비밀번호 재설정 / 초대 토큰 통합 테이블 (purpose enum)
- `email_outbox` 신규 — dev 환경에서 발송 메일 보관·표시 (Phase 6+에서 실 provider 연결 시 어댑터 교체)
- `invitations` 보강 — `team_id`, `invited_by_user_id`, `canceled_at`, `last_sent_at` 추가
- `memberships.status` 보강 — `'active' | 'disabled'` (이미 존재 시 재사용)
- 모든 신규 테이블 RLS FORCE ENABLE (Phase 1 패턴)
- seed: 1개 active invitation + 1개 expired invitation + 1개 dev outbox 샘플 (선택)

**서버 — 회원가입 / 이메일 인증**
- `POST /auth/signup` — 새 조직 + 새 admin 사용자 + 활성 membership 생성 (단일 트랜잭션)
- `POST /auth/verify` — 이메일 인증 토큰 소비 → `users.email_verified_at` 설정
- `POST /auth/verify/resend` — 새 토큰 재발급 (이전 토큰 invalidate)

**서버 — 비밀번호 재설정**
- `POST /auth/password/forgot` — 이메일로 reset 토큰 발송 (존재 여부 무관 200 응답 — enumeration 차단)
- `POST /auth/password/reset` — 토큰 검증 + 새 password 적용 + 모든 활성 sessions revoke

**서버 — Team / Member**
- `GET /team/members` — 조직 멤버 목록 (role / team / status)
- `PATCH /memberships/:id` — role 변경 / status 변경 (admin only, 마지막 admin 보호)
- `GET /teams` — 조직 내 팀 목록
- `POST /teams` — 새 팀 (admin only)
- `PATCH /teams/:id` — 팀 정보 수정 (admin only)
- `DELETE /teams/:id` — 팀 삭제 (members.team_id → NULL, admin only)

**서버 — Invitations**
- `POST /invitations` — 새 초대 (admin only). 같은 (org, email)에 활성 pending 1개 제한 — 만료된 pending은 트랜잭션 안에서 자동 cancel 후 새 초대 발급, 미만료 pending이 있으면 409 `invitation_already_pending` (§2-9 참조)
- `GET /invitations` — 조직 내 active 초대 목록 (admin only)
- `POST /invitations/:id/resend` — 새 토큰 발급 + email_outbox 기록 (이전 토큰 invalidate)
- `DELETE /invitations/:id` — `canceled_at` 설정 (soft cancel, admin only)
- `POST /invitations/accept` — 토큰 + name + password로 user 생성 + 활성 membership 추가

**클라이언트**
- `platform/signup.html` 신규 — 회원가입 폼 + 이메일 인증 안내
- `platform/verify.html` 신규 — `?token=` 쿼리 파싱 → `POST /auth/verify` 자동 호출
- `platform/forgot-password.html` 신규 — 이메일 입력 폼
- `platform/reset-password.html` 신규 — `?token=` 파싱 + 새 비밀번호 입력
- `platform/accept-invitation.html` 신규 — `?token=` 파싱 + name + password 입력
- `platform/login.html` 갱신 — "비밀번호 분실?" 링크 추가, 이메일 미인증 사용자 안내
- `platform/team.html` mock 제거 → `kloserApi.apiGet/apiPost/apiPatch/apiDelete` 실 호출. 멤버 목록 + 초대 보내기 모달 + 활성 초대 목록 + 재발송/취소
- `platform/_shared.js` — sidebar에 팀 멤버 수 / 활성 초대 수 표시

**검증**
- 서버 단위 테스트 — auth_tokens repo / signup·verify / password reset / team·member / invitation routes (총 +30~40 cases 목표)
- viewer/employee/manager 권한 차단 단위 테스트 (admin-only mutations)
- 마지막 active admin 강등/비활성화 차단 단위 테스트
- token sha256 저장 검증 — **`auth_tokens.token_hash`는 sha256만 저장, raw token 부재**. (참고: `email_outbox.body_text` / `metadata.acceptUrl`에는 dev 환경 한정으로 raw token이 발송 본문 안에 평문으로 들어 있음 — e2e가 직접 SELECT로 추출하기 위한 의도된 dev-only 노출. 운영 provider 전환 시 outbox는 제거 또는 archive-only로 변경)
- e2e: 회원가입 → 이메일 인증 (dev outbox 토큰 추출) → 로그인 → 초대 발송 → 다른 사용자 초대 수락 → 멤버 목록에 등장
- Phase 0.5 e2e 16/16 + Phase 2 customers e2e 7/7 회귀

### 안 한다 (Phase 4+로 미룸)

**실제 SMTP / Resend 연동** — Phase 3에서는 dev outbox table만. 운영 환경 provider 채택은 Phase 6+ (운영 진입 단계).

**SSO / SAML / Keycloak** — Enterprise 단계. Phase 6+ 검토.

**팀 단위 권한 분기 (manager/employee 차등)** — manager가 자기 팀만 수정, employee가 자기 담당만 수정 같은 정책. Phase 3은 **admin-only mutation으로 단순화**. team-scope write는 Phase 4 (calls / 대시보드와 묶어서) 또는 별도 step.

**Bulk invitation (CSV / 대량 초대)** — Phase 6+ enterprise.

**강제 password rotation / 정책** — 정기 변경, 복잡도 강제, 재사용 차단. 별도 보안 강화 step.

**MFA / 2FA / WebAuthn** — Phase 6+ 운영 진입 단계.

**`requireFreshRole` 전사 적용** — Phase 3에서는 high-risk write (role 변경, status 변경, invitation 생성/취소)에만 opt-in 도입. 전 endpoint 적용은 Phase 6+ 검토. password reset 흐름은 익명 토큰 기반이라 본 미들웨어 적용 대상에서 제외 (§2-14 참조).

**초대 만료 자동 정리 cron** — `expired_at` 지난 invitation은 SELECT에서 자동 제외 + 새 초대 POST 시 같은 (org,email)에 만료된 pending 행이 있으면 서비스가 트랜잭션 안에서 즉시 `canceled_at` 설정 후 새 행 생성 (지연 cleanup). 별도 cron / 일괄 삭제 / 아카이브는 Phase 6+ 운영 위생.

**Notifications 시스템 / 알림 센터** — 상위 로드맵 `BACKEND_PLAN.md` Phase 3의 "notifications 기본" 항목은 본 master 범위 외. Phase 3에서는 outbound email (email_outbox) 흐름까지만 다룬다. in-app 알림 / 알림 read state / 사이드바 알림 카운터는 Phase 4+ (calls / 대시보드와 묶어서) 재이월.

**organization 메타 수정** (이름·로고·플랜 변경) — `organizations.plan`은 Kloser 자체 구독으로 관리자 콘솔에서 다룰 영역. Phase 3 범위 외.

---

## 2. 사전 결정 (Phase 3 시작 전 확정)

| 항목 | 결정 | 근거 |
|---|---|---|
| 1. 이메일 provider | **dev outbox 테이블 + 어댑터 패턴**. Step 1에서 `email_outbox` 테이블 + `EmailProvider` 인터페이스 정의. dev 구현은 DB insert만 / 운영 구현은 Phase 6+에서 SMTP·Resend 어댑터로 교체 | 실 provider 연동을 Phase 3에 끼우면 외부 의존·비용·디버깅 부담. dev outbox는 e2e가 토큰을 직접 SELECT로 추출 가능 |
| 2. 토큰 저장 | **sha256 hash만 DB 저장.** 원문은 발송 시점에만 메모리에 존재 → 이메일 본문에 박힌 후 폐기. 검증 시 `sha256(input) === stored_hash` 비교 | 원문 저장 시 DB 유출 = 즉시 토큰 도용. Phase 1 refresh token 방식과 동일 |
| 3. auth token 테이블 구조 | **단일 `auth_tokens` 테이블 + `purpose` enum** (`email_verification` / `password_reset` / `invitation`). 분리 테이블 (옵션 B)도 검토했지만 동일 라이프사이클(생성 → 발송 → 1회 소비 → expires_at)이라 통합이 단순. 옵션 C(invitations에 통합)는 invitation은 user 가입 전 상태라 user_id NULL 케이스가 모호 → 거부 | 도메인 라이프사이클 동일성. 통합 표 + purpose 인덱스로 충분. invitations 자체는 `accepted_at`까지 가는 상위 레코드, token은 그 안의 1회용 자식 |
| 4. invitations 테이블 보강 | `team_id uuid REFERENCES teams(id) ON DELETE SET NULL` (NULL 허용 — 팀 미배정 초대), `invited_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL`, `canceled_at timestamptz`, `last_sent_at timestamptz NOT NULL DEFAULT now()`. 토큰은 별도 `auth_tokens.invitation_id` 외래 키로 분리 | 초대 메타와 토큰 라이프사이클 분리. 재발송 시 invitations 행 유지 + 새 auth_tokens 행 추가, 옛 토큰은 `consumed_at` 또는 새 `invalidated_at` 설정 |
| 5. invitation token TTL | 7일 | B2B 초대 표준. 너무 짧으면 휴가/주말 차단, 너무 길면 보안 약화 |
| 6. password reset TTL | 1시간 | 분실 흐름은 즉시 진행 가정. 1h가 표준 |
| 7. email verification TTL | 24시간 | 가입 직후 즉시 클릭 가정. 24h 후 만료되면 verify/resend 흐름으로 재발급 |
| 8. 회원가입 후 로그인 정책 | **즉시 로그인 가능 + `users.email_verified_at` flag.** 미인증 상태도 본인 데이터 조회는 가능하나, 초대 발송·비밀번호 재설정 같은 cross-user 작업은 verified 필수 | 가입 직후 onboarding UX 끊김 회피. 핵심 보안 동작은 verified gate로 분리 |
| 9. 같은 이메일 재초대 처리 | **(org_id, email) 파셜 유니크 — `WHERE canceled_at IS NULL AND accepted_at IS NULL`**. 활성 초대 1개만 허용. 새 초대 POST 시 서비스 트랜잭션이 (a) 기존 pending 중 `expires_at < now()`인 행은 자동으로 `canceled_at = now()` 처리 후 새 행 생성 (만료 재초대 허용), (b) 만료되지 않은 pending이 있으면 409 `invitation_already_pending` + "기존 초대 취소 후 재시도" 안내 | 한 번에 둘 보내고 어느 토큰을 쓸지 모호한 상황 차단 + 만료된 초대 때문에 재초대가 영구 차단되는 dead-lock 회피 (cron 없이 지연 cleanup). 파셜 유니크에 `expires_at`을 포함시키면 partial index의 `now()` 의존성 문제가 생기므로 서비스 레이어에서 처리 |
| 10. 초대 수락 흐름 | **anonymous accept** — `POST /invitations/accept`에 token + name + password. 신규 user 생성 + 활성 membership + email_verified_at 자동 설정 (이메일 도착 자체가 인증 증거). 이미 같은 이메일의 user가 다른 org에 존재하면 → 새 user는 만들지 않고 해당 user에 새 membership만 추가 | login required로 만들면 미가입 사용자가 막힘. multi-org membership은 Phase 1에서 이미 지원 |
| 11. membership 비활성화 정책 | **hard delete 금지 — `status = 'disabled'`로 전환.** 활성 사용자만 SELECT (RLS or partial index). disabled 사용자는 로그인 시 401 / 활성 membership 없음 안내 | 활동 이력·고객 담당자 등 참조 무결성 보존. 운영자는 재활성화 가능 |
| 12. 마지막 active admin 보호 | **PATCH /memberships/:id에서 role/status 변경 시 트랜잭션 안에서 `SELECT count(*) FROM memberships WHERE org_id = ? AND role = 'admin' AND status = 'active' FOR UPDATE`로 검증.** 변경 후 활성 admin이 0이 되면 409 + `last_admin_protected` 응답 | UI 우회로 admin 0 상황 방지. FOR UPDATE로 race condition 차단 |
| 13. role/team/member mutation 권한 | **1차 admin-only.** manager/employee/viewer는 read-only. team-scope write (manager가 자기 팀만)는 Phase 4+ | Phase 3은 흐름 완성에 집중. 권한 다층화는 Phase 4+ |
| 14. `requireFreshRole` opt-in | **role 변경 / status 변경 / invitation 생성·취소 endpoint에 한정 도입.** access token 발급 시점의 role이 stale이라 막 demote된 admin이 act하는 케이스 차단. 미들웨어가 DB에서 현재 role 재조회 후 비교. **`POST /auth/password/forgot` / `POST /auth/password/reset`은 제외** — forgot/reset 흐름은 익명 토큰 기반이며 JWT가 첨부되지 않거나 안 쓰이므로 role-stale 검사 자체가 성립하지 않음. password reset의 신뢰 근거는 1회용 sha256 토큰 + 1h TTL + 성공 후 전 세션 revoke로 충분 | Phase 1 finding §6 / Phase 2 master §7-2 deferred 항목. Phase 3 high-risk write에 들어맞는 시점. password reset 흐름은 별도 토큰 인증이므로 본 미들웨어 대상 외 |
| 15. shared types 패턴 | **Phase 2 동일 — `server/src/types/<entity>.ts` zod 원본 + `platform/types/<entity>.js` JSDoc 사본 + `test/sync_shared_types.mjs` registry 1줄 추가**. 본 phase에서 `signup`, `invitations`, `team` entity 등록 | Phase 2에서 정립된 패턴 일관 적용 |
| 16. `plan` 단어 재사용 금지 | **enforce.** `organizations.plan`은 Kloser 자체 구독 단계. 본 phase 신규 컬럼·필드명에 `plan` 절대 재사용 안 함. invitation의 "역할"은 `role`, 초대 사유는 `note` 등 | Phase 2 도메인 정리 인계 |
| 17. 이메일 enumeration 차단 | `POST /auth/password/forgot`은 입력 이메일 존재 여부 무관 항상 200 응답. 실제 발송은 backend에서 비동기 처리. 같은 IP 분당 N회 rate-limit (Phase 6+ 정식 적용, Phase 3은 응답 패턴만 통일) | 가입 이메일 enumeration 차단 |
| 18. seed 정책 | dev seed에 1개 active invitation + 1개 expired invitation + 1개 dev outbox 샘플. e2e 시작 전제로 사용 | UI 진입 직후 시각 검증 가능 |

---

## 3. Sub-step 분해 (실행 순서)

### Step 1 — Schema + auth_tokens + email_outbox + invitations 보강 (1.5일)

**목표**: Phase 3에 필요한 4개 스키마 변경(`auth_tokens` 신규 / `email_outbox` 신규 / `invitations` 보강 / `memberships.status` 검증)이 깨끗이 깔린다.

**산출물**:
- `server/migrations/<ts>_phase3_auth_tokens.sql` — `auth_tokens` 테이블 + RLS + 인덱스
- `server/migrations/<ts>_phase3_email_outbox.sql` — `email_outbox` 테이블 + RLS
- `server/migrations/<ts>_phase3_invitations_enrich.sql` — `invitations` 컬럼 추가 + 파셜 유니크
- `server/seeds/0003_phase3_demo.sql` — 활성 초대 1 / 만료 초대 1 / outbox 샘플 1
- `PHASE_3_STEP_1_SCHEMA.md` — 컬럼·정책·인덱스 사전 결정
- `PHASE_3_STEP_1_FINDINGS.md` — 결과 인계

**완료 기준**:
- `npm run db:migrate:up` PASS
- `npm run db:seed` PASS
- raw SQL로 (admin URL) 4 테이블 RLS FORCE 확인
- app role + GUC 컨텍스트로 SELECT → 본 org 데이터만 노출

### Step 2 — 회원가입 + 이메일 인증 (1.5일)

**목표**: 새 조직 + admin user를 자가 생성하고, 이메일 인증 흐름이 동작.

**산출물**:
- `server/src/services/signup.ts` — 새 org + user + admin membership 트랜잭션 생성
- `server/src/services/auth-tokens.ts` — token 발급 / sha256 저장 / 검증 / 1회 소비
- `server/src/services/email.ts` — `EmailProvider` 인터페이스 + dev 구현 (`email_outbox` insert)
- `server/src/routes/auth.ts` 보강 — `signup`, `verify`, `verify/resend`
- 단위 테스트 — signup 트랜잭션 / 이메일 인증 / 토큰 sha256 저장 검증 / 토큰 1회 소비 / 만료 토큰 거부

**완료 기준**:
- `POST /auth/signup` → 200 + access token + email_outbox에 verification 메일 1건
- `POST /auth/verify` (outbox에서 토큰 추출) → 200 + `users.email_verified_at` set
- `POST /auth/verify` 재시도 → 410 (이미 소비)
- 만료 토큰 → 410
- `npm --prefix server test` 신규 ~10 cases PASS

### Step 3 — 비밀번호 재설정 (0.5일)

**목표**: 비밀번호 분실 → 이메일 발송 → 새 비밀번호 적용 + 활성 sessions revoke.

**산출물**:
- `server/src/routes/auth.ts` 보강 — `password/forgot`, `password/reset`
- `server/src/services/auth.ts` 보강 — reset 시 모든 활성 sessions revoke
- 단위 테스트 — forgot 이메일 enumeration 차단 / reset 토큰 1회 소비 / sessions revoke 후 옛 access token으로 / me 401 / 만료 토큰 거부

**완료 기준**:
- `POST /auth/password/forgot {email: 'unknown@x.test'}` → 200 (응답 동일, outbox 미발송)
- `POST /auth/password/forgot {email: 'admin@acme.test'}` → 200 + outbox 1건
- `POST /auth/password/reset {token, newPassword}` → 200 + 같은 user의 모든 활성 sessions `revoked_at` set
- 옛 access token으로 `/me` → 401 (refresh도 실패)
- `npm --prefix server test` 신규 ~6 cases PASS

### Step 4 — Team / Member API + 마지막 admin 보호 (1일)

**목표**: 멤버·팀 관리 API 6개 + 마지막 admin 보호 + 권한 차등.

**산출물**:
- `server/src/routes/team.ts` — `GET /team/members`, `PATCH /memberships/:id`, `GET/POST/PATCH/DELETE /teams`
- `server/src/services/memberships.ts` — role/status 변경 + 마지막 admin 트랜잭션 검증
- `server/src/middleware/requireFreshRole.ts` — DB에서 현재 role 재조회 + access token claim과 비교 + 다르면 401 (re-login required)
- `server/src/types/team.ts` zod 원본 + `platform/types/team.js` JSDoc 사본 + sync registry 등록
- 단위 테스트 — admin/manager/employee/viewer 권한 매트릭스 / 마지막 admin 강등 차단 / 마지막 admin 비활성화 차단 / `requireFreshRole` stale 케이스 / disabled 멤버 로그인 차단

**완료 기준**:
- 6 endpoints 200/4xx 정확히
- 마지막 active admin role 변경 → 409 `last_admin_protected`
- 마지막 active admin status disabled → 409 `last_admin_protected`
- viewer / employee / manager가 admin-only mutation 호출 → 403
- DB에서 admin → manager로 demote 후 옛 access token으로 mutation → 401 (`requireFreshRole`)
- disabled 멤버로 `POST /auth/login` → 401 `account_disabled`
- `npm --prefix server test` 신규 ~12 cases PASS

### Step 5 — Invitation API (생성 / 재발송 / 취소 / 수락) (1.5일)

**목표**: 초대 흐름 완성. 익명 accept로 새 user + 활성 membership 추가.

**산출물**:
- `server/src/routes/invitations.ts` — `POST /invitations`, `GET /invitations`, `POST /invitations/:id/resend`, `DELETE /invitations/:id`, `POST /invitations/accept`
- `server/src/services/invitations.ts` — token 발급/검증, accept 트랜잭션 (user 생성 또는 lookup + membership 추가), 같은 (org, email) 활성 초대 충돌 검출, 만료/취소 토큰 거부
- `server/src/types/invitations.ts` zod 원본 + JSDoc 사본 + sync registry
- 단위 테스트 — 같은 (org,email) **미만료** pending 2개 시도 → 409 `invitation_already_pending` / 같은 (org,email) **만료** pending 존재 시 새 초대 → 201 + 옛 행 `canceled_at` set + 새 행 1개 / 자기 조직 admin이 employee 초대 / employee가 초대 시도 → 403 / accept로 신규 user 생성 / accept로 기존 user에 새 membership 추가 (multi-org) / 만료 토큰 → 410 / 취소된 초대 토큰 → 410 / 재발송 후 옛 토큰 → 410

**완료 기준**:
- `POST /invitations` → 201 + email_outbox 1건 (token 포함된 accept URL)
- `POST /invitations/accept` → 201 + user 행 + 활성 membership 행 + `users.email_verified_at` set
- 같은 이메일 **미만료** pending 존재 → 409 `invitation_already_pending`
- 같은 이메일 **만료** pending 존재 → 201 + 옛 행 자동 cancel + 새 행 1개
- 만료/취소/재발송된 옛 토큰 → 410
- `npm --prefix server test` 신규 ~12 cases PASS

### Step 6 — 클라이언트 wiring (1.5일)

**목표**: 회원가입 / 인증 / 비밀번호 분실 / 초대 수락 / 팀 관리 5개 화면이 실 API로 동작.

**산출물**:
- `platform/signup.html` 신규 + `_shared.js` 등록
- `platform/verify.html` 신규 (자동 호출 + 결과 표시)
- `platform/forgot-password.html` 신규
- `platform/reset-password.html` 신규
- `platform/accept-invitation.html` 신규 (token + name + password)
- `platform/team.html` 갱신 — mock 제거, 멤버 목록·초대 목록·초대 모달·재발송/취소·role 변경·status 변경 모두 실 API
- `platform/login.html` 갱신 — "비밀번호 분실?" 링크
- `platform/api.js` 보강 — 새 endpoint helper 필요 시
- `platform/_shared.js` — sidebar에 팀 멤버 수 / 활성 초대 수 표시
- 4 KPI / chip 필터 / 검색 등 패턴은 Phase 2 customers.html에서 가져와 일관 적용

**완료 기준**:
- 브라우저 시각 검증:
  1. signup → outbox에서 토큰 추출 → verify → 로그인 가능
  2. login → forgot password → outbox에서 reset 토큰 → 새 비밀번호 적용 → 로그인 가능
  3. admin 로그인 → team.html에서 초대 보내기 → outbox에서 토큰 → accept → 로그인 → 새 멤버가 team.html 목록에 등장
  4. admin이 다른 멤버 role 변경 → team.html 목록 즉시 반영
  5. admin이 자기 자신을 manager로 강등 시도 (마지막 admin) → UI 에러 표시
- `node test/sync_shared_types.mjs` PASS — invitations / team entity 등록 후

### Step 7 — Phase 3 e2e + 종합 findings (0.5일)

**목표**: 자동 회귀 + Phase 3 종료 인계.

**산출물**:
- `test/phase_3_team_e2e.mjs` — 6~8 시나리오:
  1. signup → email_outbox 토큰 추출 (직접 DB SELECT) → verify → login
  2. forgot password → reset → 새 비밀번호 로그인 + 옛 access token 401
  3. admin 로그인 → 초대 발송 → outbox에서 token → accept → 새 user 생성 + membership
  4. admin이 새 멤버 role 변경 → GET /team/members 반영
  5. admin이 자기 자신을 employee로 강등 시도 (마지막 admin) → 409
  6. admin이 다른 멤버 비활성화 → 그 멤버 로그인 시도 → 401
  7. cleanup sweep — 본 e2e가 만든 user / membership / invitation / outbox 행 잔재 0
- `PHASE_3_STEP_7_E2E.md` (실행 절차)
- `PHASE_3_STEP_7_FINDINGS.md` (Phase 3 종합 인계)
- 마스터 plan / step plan 체크박스 동기화
- 루트 `README.md` + `server/README.md` 상태 블록 갱신

**완료 기준**:
- 새 e2e PASS
- Phase 0.5 e2e 16/16 회귀 PASS
- Phase 2 customers e2e 7/7 회귀 PASS
- master plan §7 게이트 모두 충족
- branch가 develop에 머지 가능한 상태

---

## 4. 권한 정책 초안

### Role × Action 매트릭스 (Phase 3 시점)

| Role | 본인 정보 read/edit | 같은 org 멤버 read | 같은 org 고객 R/W | 멤버 role/status 변경 | 초대 발송/취소 | 팀 생성/수정/삭제 | 본인 비밀번호 reset |
|---|---|---|---|---|---|---|---|
| **admin** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **manager** | ✓ | ✓ (read) | ✓ (Phase 2 정책) | ✗ (Phase 4+) | ✗ (Phase 4+) | ✗ (Phase 4+) | ✓ |
| **employee** | ✓ | ✓ (read) | ✓ (Phase 2 정책) | ✗ | ✗ | ✗ | ✓ |
| **viewer** | ✓ | ✓ (read) | ✓ (read only) | ✗ | ✗ | ✗ | ✓ |

### 추가 보호 규칙

1. **마지막 active admin 보호** — role 변경 / status disable 시 트랜잭션 안에서 검증. 위반 시 `409 last_admin_protected`
2. **`requireFreshRole`** — role 변경 / status 변경 / invitation 생성·취소에 한정 적용. JWT의 role과 DB의 현재 role 불일치 시 `401 stale_role` (재로그인 안내). **password forgot/reset 흐름은 제외** — 익명 토큰 기반이라 본 미들웨어 적용 대상이 아님 (§2-14 참조)
3. **이메일 미인증 사용자 cross-user write 차단** — 자기 데이터는 OK, 초대 발송 같은 cross-user 작업은 `403 email_not_verified`
4. **disabled 멤버 로그인 차단** — `POST /auth/login`에서 `memberships.status = 'active'`인 행 없으면 `401 account_disabled`. 기존 활성 sessions은 refresh 시 무효화
5. **초대 수락은 인증 불필요** — 익명 accept (token + name + password). 멀티 org 사용자도 token만 있으면 추가 membership

### Phase 4+에서 도입 예정

- **manager team-scope write** — 자기 팀 customer R/W, 자기 팀 멤버 status disable
- **employee self-scope write** — 자기 담당 customer만 R/W
- **MFA / 2FA** — 운영 진입 단계
- **bulk invitation** — CSV 업로드

---

## 5. 데이터 모델 후보

> **사전 결정**: 본 섹션은 Step 1에서 SCHEMA plan으로 옮겨 정밀화. 본 master는 골격만 제시하며, 컬럼·인덱스·정책의 최종 확정은 Step 1 plan + findings에서.

### 5.1 신규 — `auth_tokens` (이메일 인증 / 비밀번호 재설정 / 초대 토큰 통합)

```sql
CREATE TABLE auth_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid REFERENCES users(id) ON DELETE CASCADE, -- invitation은 가입 전이라 NULL 가능
  org_id          uuid REFERENCES organizations(id) ON DELETE CASCADE, -- email_verification은 signup 흐름 완료 후라 NOT NULL
  invitation_id   uuid REFERENCES invitations(id) ON DELETE CASCADE, -- purpose=invitation에만 set
  purpose         text NOT NULL CHECK (purpose IN ('email_verification','password_reset','invitation')),
  token_hash      text NOT NULL UNIQUE, -- sha256 hex
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE auth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_tokens FORCE ROW LEVEL SECURITY;

-- RLS: org_id 기반 격리 + invitation purpose는 익명 accept도 허용해야 하므로 별도 SECURITY DEFINER service 함수로 검증
-- (Step 1에서 RLS 정책 4개 + service-role 검증 함수 분리 설계)

CREATE INDEX auth_tokens_user_purpose_active_idx
  ON auth_tokens (user_id, purpose) WHERE consumed_at IS NULL;
CREATE INDEX auth_tokens_token_hash_idx ON auth_tokens (token_hash);
CREATE INDEX auth_tokens_invitation_active_idx
  ON auth_tokens (invitation_id) WHERE consumed_at IS NULL;
```

### 5.2 신규 — `email_outbox` (dev provider)

```sql
CREATE TABLE email_outbox (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid REFERENCES organizations(id) ON DELETE CASCADE, -- signup 직전이면 NULL
  to_email      text NOT NULL,
  subject       text NOT NULL,
  body_text     text NOT NULL,
  body_html     text,
  template      text NOT NULL, -- 'email_verification' | 'password_reset' | 'invitation'
  metadata      jsonb,         -- acceptUrl / verifyUrl / resetUrl + invitation_id 등. dev 한정 raw token이 URL 안에 평문 포함 (e2e 추출용, §1 검증·§7 게이트 참조)
  delivered_at  timestamptz,   -- dev에서는 즉시 set 또는 NULL → manual mark
  failed_at     timestamptz,
  error_message text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE email_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_outbox FORCE ROW LEVEL SECURITY;
-- RLS: org_id 기반 격리 (org_id NULL은 admin role만 SELECT)
CREATE INDEX email_outbox_org_created_idx
  ON email_outbox (org_id, created_at DESC);
```

### 5.3 보강 — `invitations`

```sql
ALTER TABLE invitations ADD COLUMN team_id              uuid REFERENCES teams(id) ON DELETE SET NULL;
ALTER TABLE invitations ADD COLUMN invited_by_user_id   uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE invitations ADD COLUMN canceled_at          timestamptz;
ALTER TABLE invitations ADD COLUMN last_sent_at         timestamptz NOT NULL DEFAULT now();

-- 활성 초대 (org, email) 1개만
CREATE UNIQUE INDEX invitations_active_org_email_idx
  ON invitations (org_id, lower(email))
  WHERE accepted_at IS NULL AND canceled_at IS NULL;

-- 기존 token 컬럼은 제거하고 auth_tokens.invitation_id로 정규화 (Step 1 결정 시점에 마이그레이션 전환 비용 검토)
-- 또는 기존 token_hash 컬럼 유지 + auth_tokens는 email_verification / password_reset만 → Step 1에서 최종 결정
```

### 5.4 보강(검증) — `memberships.status`

이미 `'active'/'invited'/'disabled'` 등 status 컬럼 존재 여부 확인. 부재 시:

```sql
ALTER TABLE memberships ADD COLUMN status text NOT NULL DEFAULT 'active'
  CHECK (status IN ('active','disabled'));
```

존재 시 enum 값 검토 (현 Phase 1 init schema와 정합 확인 — Step 1에서 검증).

### 5.5 인덱스·RLS 정책 설계 (Step 1로 위임)

- `auth_tokens` RLS: org_id 기반 + invitation purpose는 익명 accept 시 service-role 검증
- `email_outbox` RLS: admin role만 자기 org의 outbox SELECT (개발자 검증용)
- `invitations` 활성 1개 파셜 유니크
- `memberships` status 인덱스 (활성 사용자 빠른 lookup)

---

## 6. Phase 2 인계 항목 반영

Phase 2 findings에서 Phase 3 진입 시 처리하기로 한 항목:

1. **`requireFreshRole` opt-in 도입** (Phase 1 finding §6 / Phase 2 master §7-2 deferred) — **본 plan §2-14 결정으로 채택.** Step 4의 high-risk write에 적용.
2. **`activity_log` audit hook** (Phase 2 master §5 deferred) — **Phase 3 범위에 포함시키지 않음.** Phase 4 (calls 영속과 묶어서)로 재이월. 단, role 변경 / membership 비활성화 / invitation 발송 같은 high-risk 이벤트는 향후 hook 부착 시 우선 대상이라는 점만 본 plan에 명시.
3. **shared types 패턴 follow** (Phase 2 STEP_3 패턴) — 본 plan §2-15 결정으로 일관 적용. 신규 entity (`signup`, `team`, `invitations`) 모두 동일 절차 (zod + JSDoc + sync registry).
4. **`customers.plan` 단어 재사용 금지** (Phase 2 도메인 정리) — 본 plan §2-16 결정으로 enforce. invitation의 "역할"은 `role`, "초대 사유"는 `note` 등으로 표기.
5. **마이그레이션 forward-only** (Phase 2 Step 5 패턴) — 본 phase의 모든 스키마 변경은 새 timestamp 마이그레이션으로 추가. 기존 마이그레이션 amend 금지.
6. **e2e cleanup 약속** (Phase 2 Step 6 패턴) — 본 phase e2e도 prefix 약속 (`phase3test-` 또는 `e2etest-`) + finally fresh login + sweep 시나리오로 구성. cleanup helper는 Phase 2 e2e 패턴에서 가져와 재사용.
7. **viewer JWT staleness 회피** — DB role demote 후 새 토큰 필요 패턴 (Phase 2 finding 인계). `requireFreshRole` 도입으로 자동 해결.
8. **`customers.status` 의미 재정의** (Phase 2 deferred) — 본 phase 범위 외. Phase 4 영업 워크플로 도입 시 재고.

---

## 7. 완료 기준 (Phase 3 전체 — go/no-go gate)

다음을 모두 만족하면 Phase 3 종료, Phase 4 (calls / transcripts 영속 + 대시보드 실 KPI) 착수.

- [ ] `npm --prefix server run typecheck` PASS (신규 `crypto`, 어쩌면 `node:crypto` import 포함)
- [ ] `npm --prefix server test` PASS — **95~110/95~110** (Phase 2의 65 + 신규 ~30~45)
- [ ] `node test/phase_0_5_e2e.mjs` 16/16 회귀 PASS
- [ ] `node test/phase_2_customers_e2e.mjs` 7/7 회귀 PASS
- [ ] `node test/phase_3_team_e2e.mjs` 6~8 시나리오 + cleanup sweep PASS
- [ ] `node test/sync_shared_types.mjs` PASS (`team`, `invitations` entity 등록)
- [ ] 4 신규/보강 마이그레이션 적용 + raw SQL로 RLS FORCE 검증
- [ ] `auth_tokens` / `email_outbox` / 보강된 `invitations` / `memberships.status` 모두 동작
- [ ] 신규 endpoints 모두 200/4xx 정확히 — `/auth/signup`, `/auth/verify`, `/auth/verify/resend`, `/auth/password/forgot`, `/auth/password/reset`, `/team/members`, `/memberships/:id`, `/teams` (4 ops), `/invitations` (4 ops + accept)
- [ ] **마지막 active admin 강등/비활성화 → 409 `last_admin_protected`**
- [ ] **viewer/employee/manager가 admin-only mutation 호출 → 403**
- [ ] **disabled 멤버 로그인 시도 → 401 `account_disabled`**
- [ ] **`requireFreshRole` 적용 endpoint에서 stale role JWT → 401 `stale_role`**
- [ ] **`auth_tokens.token_hash`는 sha256 hash만 저장** — `auth_tokens` 어디에도 raw token 평문 없음, 단위 테스트로 검증. (`email_outbox.body_text` / `metadata.acceptUrl`에는 dev 환경 한정으로 raw token이 발송 본문 안에 평문으로 들어있음 — e2e가 직접 SELECT로 추출하기 위한 의도된 dev-only 노출이며 운영 provider 전환 시 outbox는 제거 또는 archive-only로 변경)
- [ ] **이메일 enumeration 차단 동작** — `password/forgot`은 입력 무관 항상 200
- [ ] **dev outbox에 발송 메일 보관** — e2e가 직접 SELECT로 토큰 추출 가능
- [ ] **`platform/team.html` mock 제거** — 실 API만 호출
- [ ] **신규 client 화면 5개 동작** — signup / verify / forgot / reset / accept-invitation
- [ ] `docs/plan/phase-3/PHASE_3_STEP_1~7_FINDINGS.md` 모두 작성됨
- [ ] 루트 `README.md` + `server/README.md` 상태 블록 Phase 3 완료로 갱신

하나라도 실패하면 해당 step에 머문다.

---

## 8. 한 줄 요약 + 바로 다음 작업

> **1.5~2주 동안 7개 sub-step으로 회원가입·이메일 인증·비밀번호 재설정·팀/멤버 API·초대 흐름·클라이언트 wiring·e2e를 차례로 깔아서, 평가자가 자가 가입과 동료 초대까지 끝낼 수 있는 첫 self-service 흐름을 완성한다.**

### 바로 다음 작업

1. **본 master plan 사용자 리뷰** — 사전 결정 18개 / step 분해 7개 / 종료 게이트가 모두 사용자 의도와 일치하는지 확인
2. **Step 1 plan 작성** — `docs/plan/phase-3/PHASE_3_STEP_1_SCHEMA.md`. `auth_tokens` 컬럼·인덱스·RLS 정책 4개 / `email_outbox` 정책 / `invitations` 보강 시 token 컬럼 처리 방식(폐기 vs 유지) / `memberships.status` 현 상태 확인. 본 master §5의 "Step 1로 위임" 항목 모두 정밀화.
3. Step 1 plan 검토 통과 후 Step 1 구현 진입 — 마이그레이션 + 시드 + raw SQL 검증.

### 본 master plan 작성 후 후속 (코드/마이그레이션/테스트는 아직 작성 안 함)

- 본 master plan 사용자 리뷰 통과 → Step 1 plan 작성 단계로 이동
- master plan 변경 요청 들어오면 본 문서 직접 갱신 → 다시 리뷰

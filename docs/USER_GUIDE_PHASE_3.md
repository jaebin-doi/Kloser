# Kloser Phase 3 사용자 가이드

> Phase 3은 Phase 1·2가 만든 인증·조직·고객 데이터 기반 위에 **사용자가 스스로 조직을 만들고 동료를 초대할 수 있는 self-service 흐름**을 올린 단계입니다. 평가자가 사전 발급된 시드 계정이 아닌 **자기 계정**으로 가입·인증·로그인·초대까지 끝까지 진행할 수 있습니다.

---

## 1. Phase 3의 목적

Phase 1·2는 안전한 기반과 첫 비즈니스 entity(고객)를 올렸지만, 평가자는 여전히 "사전 발급된 시드 계정"으로만 들어올 수 있었습니다. Phase 3은 그 벽을 다음 다섯 가지 약속과 함께 무너뜨립니다.

1. **누구나 새 조직을 만들고 자기 계정으로 가입할 수 있다.**
2. **가입 직후 이메일 인증이 즉시 가능하고, 인증되지 않은 상태는 화면 상단 배너로 명시된다.**
3. **비밀번호를 분실해도 자기 자신이 복구할 수 있다.**
4. **관리자는 동료를 이메일로 초대할 수 있고, 받은 사람은 익명 상태에서 토큰 하나로 가입을 끝낸다.**
5. **팀·멤버 운영(역할 변경·비활성화)은 가능하지만, 조직이 admin 0명이 되는 사고는 시스템 차원에서 차단된다.**

Phase 3이 끝나면, 평가자는 **자기 손으로** 만든 조직과 멤버 위에서 Kloser를 평가할 수 있게 됩니다.

---

## 2. Phase 3에서 가능해진 것

평가 또는 검토 시점에 다음을 직접 확인할 수 있습니다.

- **자가 회원가입** — 이메일·이름·비밀번호·조직명을 입력하면 새 조직 + admin 계정이 한 트랜잭션에서 만들어지고 바로 로그인됩니다.
- **이메일 인증** — 가입 직후 발송된 메일의 링크로 인증. 현재 미인증 상태는 화면 상단 배너로 표시만 되고, 동료 초대 같은 cross-user 작업의 **서버 차단은 아직 적용 전 — Phase 4에서 enforcement 도입 예정**.
- **인증 안 됨 배너** — 인증되지 않은 상태에서 보호된 페이지에 들어가면 화면 상단에 "이메일 인증이 완료되지 않았습니다" 배너 + "재발송" 버튼이 표시됩니다.
- **비밀번호 분실 복구** — 로그인 화면 "비밀번호 분실?" → 이메일 입력 → 메일에서 토큰 링크 → 새 비밀번호 적용. 적용 즉시 **기존 모든 활성 세션의 refresh는 무효화**됩니다.
- **동료 초대 발송 / 수락 / 재발송 / 취소** — admin이 이메일·이름·역할·팀을 지정해 초대. 받은 사람은 익명 상태에서 token + 이름 + 비밀번호로 즉시 가입.
- **팀·멤버 운영** — admin이 멤버의 역할 변경 / 비활성화 / 재활성화 가능. 비활성화된 사용자는 로그인 자체가 차단됩니다.
- **마지막 admin 보호** — 조직에 활성 admin이 1명만 남았을 때, 그 사람을 강등하거나 비활성화하면 **트랜잭션이 즉시 거절**됩니다 (admin 0명 상태 진입 차단).
- **로그아웃 메뉴** — 사이드바 하단 프로필을 클릭하면 위로 뜨는 작은 메뉴에서 "설정" / "로그아웃" 진입.

---

## 3. 자가 회원가입과 이메일 인증

### 회원가입

가입 화면에서 이름·이메일·비밀번호·조직명을 입력하면 다음이 **한 트랜잭션**에서 처리됩니다.

1. 새 조직 row 생성 (Starter 플랜 기본값).
2. 새 사용자 row 생성 — 비밀번호는 Phase 1과 동일하게 Argon2id 단방향 해싱.
3. 활성 admin membership 생성 (가입자가 그 조직의 첫 admin).
4. 24시간 유효한 이메일 인증 토큰 발급 + dev 환경에서는 이메일 outbox에 한 줄 기록.

가입이 성공하면 **즉시 로그인된 상태**로 메인 화면(통화 화면)으로 이동합니다. 이메일 인증 여부는 **별개**입니다 — 인증 안 된 상태는 화면 상단 배너로 표시되지만, 현재는 표시만 되고 동료 초대 같은 cross-user 작업의 **서버 enforcement는 Phase 4+에서 도입 예정**입니다.

### 이메일 인증

가입 후 받은 메일의 링크는 `https://<host>/platform/verify.html?token=<원문 토큰>` 형태입니다. 페이지가 열리면 다음이 자동으로 일어납니다.

1. URL의 `?token=` 파라미터를 즉시 읽고 `history.replaceState`로 **URL에서 토큰 부분을 제거** — 주소창·북마크·referer로 누출되지 않게 함.
2. 서버에 토큰 검증 요청. 1회만 소비 가능.
3. 검증 성공 → `users.email_verified_at`이 설정되고 상단 배너가 자동으로 사라집니다.
4. 이미 인증된 계정이거나 토큰이 만료/소비된 경우는 명확한 에러 메시지로 분기 안내.

### 인증 메일 재발송

배너 안의 "인증 메일 재발송" 버튼을 누르면 새 토큰이 발급되고 옛 토큰은 즉시 무효화됩니다. 이미 인증된 계정이면 "이미 인증된 계정입니다" 안내 토스트가 뜨고 배너가 자동으로 사라집니다 (다른 탭에서 클릭한 케이스).

---

## 4. 비밀번호 재설정

### 분실 흐름

로그인 화면의 "비밀번호 분실?" → 이메일 입력 → 결과 화면.

이 결과 화면은 **입력한 이메일이 존재하든 안 하든 동일합니다.** 응답·화면·소요 시간 모두 같은 패턴이라, 외부에서 "이 이메일이 가입돼 있나" 추측할 수 없습니다(enumeration 차단).

존재하는 이메일이면 1시간짜리 reset 토큰이 발급되고 메일로 발송됩니다. 메일의 링크는 `reset-password.html?token=<원문>` 형태이며, verify와 같은 패턴으로 URL에서 토큰이 즉시 제거됩니다.

### 새 비밀번호 적용

reset 페이지에서 새 비밀번호 입력 → 서버에서 토큰 검증 + 비밀번호 변경 + **같은 사용자의 모든 활성 세션(refresh token)을 즉시 무효화**합니다. 다른 기기·다른 탭의 로그인은 다음 refresh 시도에서 401로 거절되고 다시 로그인이 요구됩니다.

옛 access token(15분 TTL)은 자연 만료까지는 살아 있습니다 — JWT 자체는 stateless이므로 즉시 무효화하지 않습니다. 만료 후 다음 refresh 시도부터 401이 떨어지면서 효력이 완전히 사라집니다. 즉시 차단이 필요한 운영 단계에서는 token blocklist를 Phase 6+에 도입할 수 있습니다.

---

## 5. 동료 초대 — 발송·수락·재발송·취소

### 발송

admin이 팀 화면의 "+초대" 모달에서 이메일·이름(선택)·역할(employee/manager/admin)·팀(선택)을 입력하면 7일짜리 invitation 토큰이 발급되고 메일이 outbox에 들어갑니다. 화면 우측 "활성 초대" 목록에 즉시 등장합니다.

같은 (조직, 이메일) 쌍에 **활성 초대는 최대 1개**입니다. 두 번 보내려고 하면 409 `invitation_already_pending` + "기존 초대 취소 후 재시도" 안내. 단, 기존 초대가 **만료된 상태**라면 새 초대 발송 시 트랜잭션 안에서 옛 초대를 자동으로 cancel 처리하고 새 행을 만듭니다 — 만료 때문에 영구히 재초대가 막히는 dead-lock을 피하기 위해 cron 없이 지연 cleanup으로 처리합니다.

### 수락 (익명 흐름)

받은 사람은 메일 링크 `accept-invitation.html?token=<원문>`을 엽니다.

- **로그인 불필요.** 이 페이지는 익명 진입을 가정합니다 — 받은 사람이 이미 다른 조직에 계정이 있더라도 그 계정으로 로그인할 필요가 없습니다.
- URL의 토큰은 verify와 같은 패턴으로 진입 즉시 제거됩니다.
- 이름·비밀번호를 입력하면 다음이 처리됩니다.
  - 같은 이메일의 user가 **이미 있으면** → 새 user를 만들지 않고 그 user에 이 조직의 새 active membership 추가 (multi-org membership).
  - 같은 이메일의 user가 **없으면** → 새 user 생성 + 새 active membership 생성.
- 이메일 인증 처리는 두 경우가 다릅니다 — **신규 user**는 생성 시점에 `email_verified_at = now()`로 자동 인증되지만(이메일이 실제 도착했고 토큰을 통과한 것이 소유 증거), **기존 user**는 기존 `email_verified_at` 값(NULL이면 NULL, 이미 인증돼 있으면 그대로)을 유지합니다.
- 수락 직후 새 사용자는 자동 로그인되어 메인 화면으로 이동합니다.

### 재발송·취소

활성 초대 목록의 각 행에는 "재발송" / "취소" 버튼이 있습니다.

- **재발송** — 새 토큰이 발급되고 옛 토큰은 즉시 무효화됩니다. `last_sent_at`이 갱신됩니다.
- **취소** — `canceled_at`이 설정되고 토큰은 즉시 무효화. 행은 목록에서 사라집니다 (soft cancel — 시스템 내부 보존).

만료·취소·재발송으로 무효화된 옛 토큰이 사용되면 모두 `410 Gone`으로 거절됩니다.

---

## 6. 팀·멤버 운영

### 멤버 관리

팀 화면의 멤버 목록은 조직 안 **모든 멤버(active + disabled 포함)**를 보여줍니다 (역할·소속 팀·상태). 비활성화된 멤버는 별도 배지로 구분되며, admin이 같은 화면에서 다시 활성화할 수 있습니다.

admin은 다음을 수정할 수 있습니다.

- **역할 변경** — admin / manager / employee / viewer 중 하나로.
- **비활성화 (status = 'disabled')** — hard delete가 아닙니다. 비활성화된 사용자는 로그인 시 `401 account_disabled`를 받고 기존 활성 세션도 refresh 시 무효화됩니다. 운영 차원에서 재활성화 가능.

### 마지막 admin 보호

조직 안 active admin이 정확히 1명일 때, 그 사람의 역할을 다른 것으로 바꾸거나 비활성화하려는 시도는 **트랜잭션이 시작 단계에서 거절**합니다.

- 응답: `409 last_admin_protected`
- 메커니즘: `SELECT id FROM memberships WHERE org_id = ? AND role = 'admin' AND status = 'active' ORDER BY id FOR UPDATE`로 active admin 집합을 row-level lock + 변경 시뮬레이션. 변경 결과 admin이 0이 되면 commit 거부. `ORDER BY id`로 동시 mutator 간 deadlock도 차단.

이 보호 덕분에 UI 우회로도 "admin이 0명인 조직"이 만들어지지 않습니다.

### 권한 부주의 차단 — `requireFreshRole`

admin이 admin-only mutation(역할 변경 / 상태 변경 / 팀 CRUD / 초대 발송·재발송·취소)을 호출할 때, 미들웨어가 **DB의 현재 역할을 다시 읽어** access token에 박힌 역할과 비교합니다. 다르면 `401 stale_role`이 떨어져 재로그인을 요구합니다.

이 검사는 "방금 admin 권한이 해제된 사용자가 옛 토큰으로 변경 요청을 보내는" 경우를 차단합니다. password reset / 초대 accept 같은 익명 흐름은 JWT 자체가 없으므로 제외됩니다.

---

## 7. 토큰 보안 — 평문 저장 없음

이메일 인증·비밀번호 재설정·초대는 모두 같은 `auth_tokens` 테이블을 씁니다(`purpose` 컬럼으로 구분). 토큰 저장 정책은 한 줄로 요약됩니다.

> **DB에는 sha256 해시만 저장됩니다. 원문 토큰은 발급 시점에 메모리에서 메일 본문으로 한 번 들어간 뒤 즉시 폐기됩니다.**

검증 시점에는 사용자가 가져온 입력 값을 sha256으로 변환해 저장된 해시와 비교합니다. DB가 통째로 유출되어도 토큰이 즉시 도용되지 않습니다 (rainbow 공격은 가능성이 있지만 토큰 자체가 cryptographically random 32바이트라 사실상 무효).

각 purpose별 TTL은 다음과 같습니다.

| Purpose | TTL | 근거 |
|---|---|---|
| 이메일 인증 (`email_verification`) | 24시간 | 가입 직후 즉시 클릭 가정 |
| 비밀번호 재설정 (`password_reset`) | 1시간 | 분실 흐름은 즉시 진행 가정 |
| 초대 (`invitation`) | 7일 | B2B 휴가·주말 고려 표준 |

각 토큰은 **1회만 소비** 가능합니다 (`consumed_at` 설정). 옛 토큰이 다시 쓰이면 410으로 거절됩니다.

### dev 환경의 이메일 outbox

실제 SMTP·Resend 같은 외부 provider는 Phase 6+로 미뤘습니다. 그 사이 Phase 3은 **`email_outbox` 테이블**에 발송 메일을 그대로 저장합니다 — 이메일 흐름의 정합성을 외부 의존 없이 e2e가 검증할 수 있습니다(테스트가 outbox에서 토큰을 직접 추출).

운영 provider로 전환되는 시점에는 `EmailProvider` 인터페이스의 dev 구현이 SMTP/Resend 구현으로 교체되고, outbox는 제거되거나 archive-only로 바뀝니다.

---

## 8. 입력 검증과 안전한 응답

### 화면 + 서버 + DB의 3중 안전선 (Phase 2와 동일 패턴)

| 단계 | 막는 것 |
|---|---|
| 화면 | 빈 입력 / 형식 어긋난 이메일 → 저장 버튼 비활성 또는 입력 직후 표시 |
| 서버 | zod 스키마로 단일 진입점 검증 → `400 invalid_input` + 항목 단위 사유 |
| DB | 파셜 유니크 / CHECK 제약 / RLS — 직접 SQL을 우회해도 마지막 안전선 |

### 명시적으로 거부되는 시나리오

- 같은 이메일로 두 번 가입 → `409 email_conflict` (의도된 노출, UX trade-off)
- 같은 이메일에 활성 초대 2개 시도 → `409 invitation_already_pending`
- 만료 / 취소 / 소비된 토큰 → `410 Gone`
- 다른 조직 멤버를 PATCH 시도 → `404 not_found` (존재 자체를 노출하지 않음)
- viewer / employee / manager가 admin-only mutation → `403 forbidden`
- 비활성화된 멤버 로그인 → `401 account_disabled`
- 역할이 DB에서 변경됐는데 옛 JWT 사용 → `401 stale_role` (재로그인)

### enumeration 차단

비밀번호 분실 요청(`POST /auth/password/forgot`)은 입력 이메일이 시스템에 존재하든 안 하든 **항상 200**으로 응답합니다. 그 다음 동작은 응답 이후에 비동기로 갈라집니다(존재하면 발송, 없으면 무시). 결과 화면도 동일하므로 외부에서 가입 여부 추측이 불가능합니다.

회원가입의 경우 UX 우선 결정으로 `409 email_conflict`를 노출합니다(사용자가 즉시 로그인으로 분기하도록). 이는 의도된 trade-off로 master 결정 §17에서 기록됨.

---

## 9. 사용자가 알아야 할 제한사항

Phase 3은 self-service 흐름을 연 단계입니다. 다음은 다음 Phase로 미뤄져 있습니다.

- **실제 이메일 발송 (SMTP / Resend)** — 현재는 dev outbox 테이블에만 기록. 운영 provider 채택은 Phase 6+.
- **이메일 발송 rate-limit (분당 N회 등)** — 현재 enumeration shield 외 추가 보호 없음. Phase 6+.
- **미인증 user의 cross-user write 차단 (`requireVerified` 미들웨어)** — 인증 상태는 표시되지만 서버 enforcement는 Phase 4+.
- **Team CRUD UI (팀 생성·수정·삭제 화면)** — API는 모두 있지만 UI는 invite 모달의 팀 드롭다운(`GET /teams`)만. Phase 4+.
- **manager/employee 권한 다층화** — "매니저는 자기 팀만, 직원은 자기 담당만" 정책. 현재 admin-only mutation. Phase 4+.
- **MFA / 2FA / WebAuthn** — Phase 6+ 운영 진입.
- **bulk invitation (CSV 일괄)** — Phase 6+ enterprise.
- **사이드바 사용자 정보의 실제 데이터화** — 현재 김민수·Kloser Inc. 같은 표시는 정적. `/me` wiring은 Phase 4 진입 시 처리 예정.
- **미인증 배너 — 모든 보호 페이지** — 현재 live.html / team.html에만 wired. dashboard / customers / calls / daily / settings / newsletter는 1줄 추가 작업이 Phase 4+에 남음.

---

## 10. 다음 Phase에서 추가될 것

| 다음 단계 | 추가될 기능 (요약) |
|---|---|
| **Phase 4** | 통화 기록 영속화, 통화 상세 패널, 매니저용 보고서, `requireVerified` 전사 적용 |
| **Phase 5** | 실제 음성 인식, 회사 가이드 기반 AI 응대 추천, 통화 후 자동 메모 |
| **Phase 6+** | 운영 도메인 배포, 실 SMTP/Resend, MFA, bulk invitation, 결제·구독, 외부 시스템 연동 |

Phase 3이 만든 약속(자가 가입·인증·재설정·초대·팀 운영·마지막 admin 보호·토큰 해싱·enumeration 차단)은 다음 Phase의 새 entity와 새 흐름에서도 그대로 적용됩니다.

---

## 11. 자동 회귀 — 다음 변경이 이전 약속을 깨지 않도록

Phase 3의 모든 약속은 자동 검사로 매번 검증됩니다.

- **서버 단위 테스트 155개** — 인증·토큰·signup·verify·reset·team·invitation·격리·권한 합산. Phase 2 종료 시점(65)에서 +90 추가.
- **Phase 3 e2e 6 시나리오 × 33 assertion** — signup → verify → login / forgot → reset → 옛 refresh 401 / 초대 발송 → outbox token 추출 → accept → 멤버 등장 / 역할 변경 / 마지막 admin 보호 / 비활성화 + 로그인 차단 + 복원. 마지막 시나리오는 자동 cleanup 검사.
- **Phase 0.5 e2e 16/16** — 통화 흐름 회귀 (Phase 1 약속이 깨지지 않았는지).
- **Phase 2 customers e2e 7/7** — 고객 CRUD 회귀.
- **양쪽 형식 동기화** — `customers`, `signup`, `password-reset`, `team`, `invitation` 5개 entity의 서버 zod 정의와 화면 JSDoc 정의가 일치하는지 검증.

이 다섯 가지가 모두 통과해야만 Phase 3이 합격으로 인정됩니다.

---

## 12. 기술 요약 (참고)

이 섹션은 보안·아키텍처에 관심 있는 평가자가 핵심 결정 사항을 한눈에 보기 위한 짧은 요약입니다. 본 문서의 다른 섹션은 이 용어를 몰라도 이해할 수 있도록 작성했습니다.

- **신규 스키마 5 migration** — `auth_tokens` (purpose enum 통합) + `email_outbox` (dev provider) + `invitations` enrich (`team_id`, `invited_by_user_id`, `canceled_at`, `last_sent_at`) + `memberships.status` CHECK + 부속 grant 보강. 모두 forward-only.
- **토큰 보관 정책** — `auth_tokens.token_hash`는 sha256(hex)만. 원문은 mint 시점 caller에게 1회 반환 후 폐기. `email_outbox.body_text` / `metadata.acceptUrl`에는 dev 환경 한정으로 raw 포함 (e2e 추출용, 운영 전환 시 outbox 제거).
- **익명 흐름의 BYPASSRLS service role** — `verifyEmail` / `resetPassword` / `acceptInvitation` 3 endpoint가 `kloser_service` (BYPASSRLS, SELECT/INSERT/UPDATE만, DELETE 없음) servicePool 사용. 일상 흐름의 `app` role과 분리.
- **lock 순서** — `invitations → auth_tokens`로 통일. accept 트랜잭션은 `findTokenByRaw` (no-lock SELECT) → `invitations FOR UPDATE` → `lockAndValidateTokenById` (auth_tokens FOR UPDATE) → ... → `markTokenConsumed` (happy-path 끝부분만). 409 ROLLBACK 시 토큰 `consumed_at`은 NULL 보존 → retry 시 같은 409.
- **마지막 admin 보호** — `lockActiveAdminIds(client)`로 active admin 집합 row-level lock + 변경 시뮬레이션. `ORDER BY id`로 lock 순서 결정적 (동시 mutator deadlock 방지).
- **`requireFreshRole` 미들웨어** — admin-only mutation 4종(역할 / 상태 / 팀 CRUD / 초대 생성·재발송·취소)에 적용. DB에서 현재 role 재조회 + JWT claim 비교 + 불일치 시 `401 stale_role`. 익명 흐름(password forgot/reset, accept-invitation)은 제외.
- **client 토큰 URL 누출 차단** — verify / reset / accept 3 page 진입 즉시 `history.replaceState(null, '', location.pathname)` + `<meta name="referrer" content="no-referrer">`.
- **enumeration parity** — `POST /auth/password/forgot`은 unknown/disabled/no-membership 모두 200 동일 응답. signup은 `409 email_conflict` 노출 (의도된 UX trade-off).
- **hard delete 금지** — membership / invitation 모두 soft. `status='disabled'` / `canceled_at` 으로 표현. 참조 무결성·이력 보존.
- **password reset의 session revoke 범위** — 모든 활성 refresh session `revoked_at` set. 옛 access token (JWT)는 자연 만료(15분 TTL)까지 유효 — 즉시 차단은 Phase 6+ token blocklist 도입 시.
- **자동 회귀** — `npm --prefix server test` 155/155 + `node test/sync_shared_types.mjs` (5 entity) + `node test/phase_0_5_e2e.mjs` 16/16 + `node test/phase_2_customers_e2e.mjs` 7/7 + `node test/phase_3_e2e.mjs` 6 시나리오 / 33 assertion.

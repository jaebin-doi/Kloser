# Phase 3 Step 7 Findings — 통합 e2e + Phase 3 종합 결산

> Audience: Phase 4+ 작성자, 차후 회귀 디버거.
> Plan: [`PHASE_3_STEP_7_E2E.md`](PHASE_3_STEP_7_E2E.md).

---

## 결론

Step 7 **완료** (2026-05-11). 계획서 §4 완료 기준 6항목 중 5번째 (Codex 리뷰 통과)를 제외한 모두 통과 — Codex 리뷰 후 commit/push 예정. **Phase 3 7/7 step 모두 [x]**.

### 적용 파일 (3 신규, 2 수정)

| 종류 | 경로 | 비고 |
|---|---|---|
| plan | `docs/plan/phase-3/PHASE_3_STEP_7_E2E.md` (신규) | 본 step plan — 6 시나리오 + lock-ins + 위험 |
| e2e | `test/phase_3_e2e.mjs` (신규) | Playwright + docker exec psql. 6 시나리오 sequential, ~33 PASS assertion. screenshot 1장 (gitignored) |
| ignore | `.gitignore` (수정) | `test/phase_3_e2e.png` 추가 |
| findings | `docs/plan/phase-3/PHASE_3_STEP_7_FINDINGS.md` (신규) | 본 문서 |
| master | `docs/plan/phase-3/PHASE_3_MASTER.md` (수정) | Step 7 체크박스 [x] |

### 검증 결과 (plan §4)

| # | 항목 | 결과 |
|---|---|---|
| 1 | `test/phase_3_e2e.mjs` 6 시나리오 | **33/33** PASS (assertion 단위, console errors 0) |
| 2 | `.gitignore` 보강 | `phase_3_e2e.png` 추가, 본 e2e 산출 png는 untracked |
| 3 | `npm --prefix server run typecheck` | PASS |
| 4 | `node test/sync_shared_types.mjs` | PASS (5 entity: customers / signup / password-reset / team / invitation) |
| 5 | `npm --prefix server test` | **155/155** PASS 회귀 |
| 6 | `node test/phase_0_5_e2e.mjs` | **16/16** PASS 회귀 |
| 7 | `node test/phase_2_customers_e2e.mjs` | **7/7** PASS 회귀 |

---

## 발견 사항

### 1. `kloser_service` 권한 표는 SELECT/INSERT/UPDATE만 — cleanup이 app 역할로 분기

(1) e2e의 cleanupTestData는 phase3test- prefix users + 그들이 소유한 org들을 제거하고 emp@acme.test 시드를 강제 복원해야 함. 1차 구현에서 모든 정리 query를 `kloser_service` 한 역할로 처리하려 했으나 다음 5개 query가 다음 이유로 분기됨:

| query | 필요한 권한 | 사용 역할 |
|---|---|---|
| `SELECT m.org_id FROM memberships WHERE u.email LIKE '...'` | SELECT + BYPASSRLS (memberships RLS-scoped) | kloser_service |
| `DELETE FROM organizations WHERE id = ?` | DELETE 권한 — organizations는 RLS off | app (service에 DELETE 없음) |
| `DELETE FROM users WHERE email LIKE '...'` | DELETE 권한 — users는 RLS off | app |
| `UPDATE invitations SET canceled_at = ...` | UPDATE — service 표 grant 있음 | kloser_service |
| `UPDATE memberships SET role='employee'...` | UPDATE — service 표 grant **없음** (migration 0008은 INSERT만 GRANT) | app + GUC (`SET LOCAL app.org_id`) |

(2) Phase 4+ 운영 도구 작성 시 같은 패턴이 반복될 가능성 — Master §6-5 forward-only migration 원칙상 grant 표는 추가 migration이 필요. 본 step에서는 마이그레이션 추가 0건 정책으로 e2e 코드 안의 역할 분기로 흡수.

(3) 본 finding이 시사하는 운영 위생: `kloser_service`는 anonymous 흐름 (verify / reset / accept) 전용 — 권한 표가 의도적으로 좁음. cleanup / 운영 도구는 app 역할 또는 admin migration role을 사용해야 함.

---

### 2. anonymous form은 server-set HttpOnly refresh cookie 의존 — Playwright context 분리는 `clearCookies`로 충분

(1) Step 6 anonymous 페이지들 (signup / accept-invitation)은 성공 시 server가 Set-Cookie로 refresh를 박는다. Playwright headless에서 새 browser context로 분리하지 않고 같은 page를 재사용하면 이전 시나리오의 cookie + accessToken이 새 사용자 진입을 오염시킬 수 있음.

(2) 본 e2e의 해법:
- scenario 3 / 4 accept 진입 전 `ctx.clearCookies()` + `kloserApi.logout()` 두 가지 모두 호출. cookie는 server 측에서 server-side revoke (logout) + browser 측 제거 (clearCookies) 양면 정리.
- accessToken은 closure 변수라 page reload 시 휘발됨 — 명시 정리 불요.

(3) Phase 4+ e2e가 같은 페이지 인스턴스를 계속 재사용하려면 본 패턴 유지. 두 user를 격리하려면 `browser.newContext()`로 완전 새 컨텍스트 (cookies + storage 분리) 권장.

---

### 3. multi-org 사용자의 login 시 401 vs 400 분기 — e2e가 둘 다 흡수

(1) scenario 4의 phase3test-p1은 (a) Acme signup으로 PersonaOne Org 1개를 admin으로 가입한 뒤 (b) Beta admin이 그를 viewer로 초대해 accept. 그 결과 같은 user가 두 org 모두에 active membership.

(2) 옛 PersonaOne Org pw로 `/auth/login` (orgId 미지정) → **400 org_id_required** + `availableOrgs` 응답. 이는 Step 4 §1-8 `resolveMembershipForLogin`의 multi-membership 분기. orgId가 명시되면 200.

(3) e2e가 이 분기를 `if (200) ok; else if (400 + availableOrgs.length >= 1) ok` 두 분기 모두 PASS 처리. PR 시 의도된 동작이라 어느 쪽이든 회귀 OK.

(4) Step 6 client 측 login.html은 400 응답을 받으면 `org-list-items`를 그려 사용자가 org을 골라 다시 로그인하도록 UX 제공. 본 e2e는 client UI를 거치지 않고 raw fetch로 분기만 assert.

---

### 4. dev outbox에서 token 추출은 `docker exec psql` 직접 호출이 가장 단순

(1) e2e 스크립트는 root에서 실행되는데 `pg` / `dotenv` 모듈은 `server/node_modules`에만 있음. root 레벨에 pg 의존 추가는 의도적으로 회피 (Phase 0.5 / Phase 2 e2e가 fetch + playwright만으로 작동).

(2) 대안: `child_process.execFileSync("docker", ["exec", ..., "psql", ..., "-c", sql])`로 컨테이너 안의 psql을 호출. dev compose가 항상 켜져 있는 전제 (server / static / postgres 모두). 인자는 array로 넘겨 shell injection 없음.

(3) Phase 6+ SMTP 어댑터 도입 시 본 e2e는 동작 안 함 — outbox에 raw token이 더 이상 노출되지 않으므로. 대체 패턴 후보: (a) dev provider stub fixture 명시 (b) provider 인터페이스에 "마지막 발송 token 조회" debug method 추가 (c) `mailpit` 같은 SMTP catch-all 컨테이너 띄우고 그 API 호출.

---

### 5. seeded user password를 e2e가 손대지 않는 정책 — Phase 2 / Phase 0.5 회귀 안전

(1) scenario 2 (forgot/reset)는 새 user phase3test-p2를 signup으로 만들고 그 user에 대해서만 forgot → reset 흐름. seeded `admin@acme.test` / `emp@acme.test` / `admin@beta.test`의 password는 어떤 시나리오도 변경하지 않음.

(2) 같은 dev DB에서 Phase 0.5 / Phase 2 e2e가 seeded pw를 그대로 가정. 본 정책으로 회귀 0.

(3) 향후 e2e가 seeded user의 reset 흐름을 다루려면 (a) 시작 시 pw를 변경 (b) 종료 시 admin SQL로 원래 hash로 복원 — 두 단계 모두 필요. 본 step은 그 부담을 회피.

---

### 6. screenshot artifact는 결과 디버깅 용이라 `.gitignore` 패턴 추가만 함

(1) `page.screenshot({ path: test/phase_3_e2e.png })` 1장. PR / commit에 포함되면 binary diff 노이즈. Phase 0.5 / Phase 2와 같은 패턴.

(2) `.gitignore`에 `test/phase_3_e2e.png` 한 줄 추가. CI 환경에서는 artifact upload 대상이 될 수 있음 — repo에 commit은 안 함.

---

## Phase 3 종합 결산 (1 ~ 7 step)

### 7 step 완료 표

| Step | 산출물 | 통과일 |
|---|---|---|
| 1 | Schema 보강 (auth_tokens / email_outbox / invitations enrich / memberships.status CHECK) + RLS + 시드 | 2026-05-11 |
| 2 | 회원가입 + 이메일 인증 service/route + 단위 테스트 | 2026-05-11 |
| 3 | 비밀번호 재설정 service/route + 단위 테스트 | 2026-05-11 |
| 4 | Team / Member API + 마지막 admin 보호 + `requireFreshRole` | 2026-05-11 |
| 5 | Invitation API (5 endpoint) + accept lock 순서 정합 + token consume 분리 | 2026-05-11 |
| 6 | 클라이언트 wiring (5 신규 페이지 + team.html 실 API + 미인증 배너) | 2026-05-11 |
| 7 | 통합 e2e + 종합 findings | 2026-05-11 |

### 핵심 아키텍처 결정 — Phase 4+에 인계되는 형상

| 영역 | 결정 / 위치 |
|---|---|
| Auth 토큰 모델 | `auth_tokens` 단일 표 — purpose = email_verification / password_reset / invitation. sha256 hex 저장, raw는 mint 시점에만 caller에게 반환 |
| 익명 endpoint pool | `kloser_service` (BYPASSRLS) servicePool — `verifyEmail` / `resetPassword` / `acceptInvitation` 셋이 사용. Step 2 §6 grant 표 7 테이블 (SELECT/INSERT/UPDATE만) |
| accept 트랜잭션 lock 순서 | `invitations → auth_tokens`로 통일. `findTokenByRaw` (no-lock SELECT) → `invitations FOR UPDATE` → `lockAndValidateTokenById` (auth_tokens FOR UPDATE + validity) → ... → `markTokenConsumed` (happy-path 끝부분만). 409 ROLLBACK 시 token consumed_at NULL 보존 → retry 시 같은 409 |
| 마지막 admin 보호 | `lockActiveAdminIds(client)` — `SELECT id ... WHERE role='admin' AND status='active' ORDER BY id FOR UPDATE`. 두 동시 mutator 직렬화 + 0-admin commit 금지 |
| `requireFreshRole` 미들웨어 | admin-only mutation 4종 (role / status / team CRUD / invitation 생성·재발송·취소). password forgot/reset + invitation accept는 익명 흐름이라 제외 |
| client 토큰 URL 누출 차단 | verify / reset / accept 3 page 진입 즉시 `history.replaceState(null, '', location.pathname)` + `<meta name="referrer" content="no-referrer">` |
| client error mapping | 각 페이지의 inline `mapError`로 status / body.code 분기. 공용화는 ROI 낮아 미실행 |
| 미인증 user 배너 | `platform/_shared.js` `renderUnverifiedBanner(user)` — 페이지가 auth gate 직후 `/me` fetch → 호출. live.html + team.html 두 곳에 wire. 나머지 logged-in 페이지는 1줄 추가만 하면 됨 (Phase 4+) |
| enumeration parity | forgot은 항상 200 응답 (unknown / disabled / no-membership 동일). signup은 409 email_conflict 노출 (UX trade-off) |
| hard delete 금지 | membership / invitation 모두. status='disabled' / canceled_at으로 soft. team.html UI도 "삭제" label 절대 미노출 |
| forward-only migrations | Phase 3 신규 마이그레이션 5개 (0004 ~ 0008). 어떤 amend도 없음. Phase 4+에서 grant 추가 시 새 timestamp migration 권장 |

### 검증 surface 요약

| 종류 | 개수 | 위치 |
|---|---|---|
| migrations (신규) | 5 | `server/migrations/1715000004000` ~ `1715000008000` |
| server unit tests | **155** (Phase 1 시점 ~30 → Phase 3 종료 155) | `server/test/*.test.mjs` |
| shared types entities | **5** (customers + signup + password-reset + team + invitation) | `server/src/types/*` + `platform/types/*` + `test/sync_shared_types.mjs` |
| e2e scripts | **3** (Phase 0.5, Phase 2 customers, Phase 3) | `test/phase_*_e2e.mjs` |
| 신규 platform 페이지 | **5** (signup / verify / forgot-password / reset-password / accept-invitation) | `platform/*.html` |
| 신규 server route 파일 | **3** (auth/me 기존 + customers/team/invitations 신규) | `server/src/routes/*.ts` |

### 알려진 미해결 / Phase 4+ 인계

| 항목 | 상태 |
|---|---|
| 미인증 user 배너 — 나머지 logged-in 페이지 적용 (dashboard / customers / calls / daily / settings / newsletter) | Phase 4+ — 1줄씩 추가. 본 step은 live.html + team.html만 |
| 이메일 미인증 user의 cross-user write 차단 (`requireVerified` 미들웨어) | Master §304 — Phase 4+ |
| Team CRUD UI (team.html 안에 팀 생성·수정·삭제) | Phase 4+ — invite modal의 team 드롭다운은 `GET /teams`만 사용 |
| manager team-scope write / employee self-scope write 권한 다층화 | Master §13 — Phase 4+ |
| 이메일 발송 rate-limit (forgot / verify / invite 모두) | Phase 6+ — 현재 enumeration shield 외 추가 보호 없음 |
| SMTP / Resend 어댑터 (DevOutboxEmailProvider 대체) | Phase 6+ — 본 e2e는 raw token 추출 가능하다는 dev 정책에 의존 |
| MFA / WebAuthn | Phase 6+ |
| Bulk invitation (CSV) | Phase 6+ |
| `kloser_service` DELETE grant 부재 — 운영 cleanup 도구가 app 역할로 분기 필요 | Phase 4+ — grant migration 추가 검토 |
| forgot/reset access JWT 잔존 — old access token이 TTL까지 유효 | Step 3 §1-10 — 의도된 trade-off (refresh만 revoke). 강제 즉시 만료는 token blocklist 도입 시 가능 |

---

## 한 줄 결론

> **Phase 3 종료. Step 1~7 모두 [x]. server 155 unit tests + client 6 persona × 33 e2e PASS + 회귀 23. 신규 schema 5 migration / route 3 surface / shared type 5 entity / platform page 5. forward-only / hard delete 금지 / lock 순서 invitations→auth_tokens / token URL 즉시 replaceState / enumeration parity 의 5대 원칙으로 정리. Codex 리뷰 후 본 단계 commit/push.**

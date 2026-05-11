# Phase 3 Step 7 — 통합 e2e + Phase 3 종합 findings

> **상위 계획**: `docs/plan/phase-3/PHASE_3_MASTER.md` §3 Step 7.
> **선행**: Step 6 완료 — `PHASE_3_STEP_6_FINDINGS.md`. server 5 endpoint × 30 unit tests + client 6 persona × 수동 검증 통과.
> **기간**: 0.5일.

---

## 진행 상태

- [ ] 1. lock-ins 사전 결정 (§1)
- [ ] 2. `test/phase_3_e2e.mjs` (신규) — 6 시나리오 + cleanup
- [ ] 3. `.gitignore` 보강 — `test/phase_3_e2e.png` (screenshot artifact) 추가
- [ ] 4. 6 시나리오 모두 PASS
- [ ] 5. `npm --prefix server run typecheck` PASS
- [ ] 6. `node test/sync_shared_types.mjs` PASS
- [ ] 7. `npm --prefix server test` 155/155 PASS 회귀
- [ ] 8. `node test/phase_0_5_e2e.mjs` 16/16 PASS 회귀
- [ ] 9. `node test/phase_2_customers_e2e.mjs` 7/7 PASS 회귀
- [ ] 10. `PHASE_3_STEP_7_FINDINGS.md` 작성
- [ ] 11. `PHASE_3_MASTER.md` Step 7 체크박스 [x] — 위 9·10 완료 후에만

---

## 0. 목적

Master §1 산출물 6 "Phase 3 종합 e2e + 결산". 본 step이 끝나면:

- Phase 3 5 endpoint × client 6 persona 흐름을 단일 Playwright 스크립트로 직렬 실행 → 회귀 한 번에 보호
- Phase 3 종합 결산을 `PHASE_3_STEP_7_FINDINGS.md`에 기록
- Phase 3 전체 ([x] 7/7) 종료

서버 / 마이그레이션 / shared types / 신규 페이지 추가 **0건**. 본 step은 순수 자동화 검증.

---

## 1. 사전 결정 lock-ins

| 항목 | 결정 | 근거 |
|---|---|---|
| 1. 스크립트 위치 / 이름 | `test/phase_3_e2e.mjs` (단일 파일) | Phase 0.5 / Phase 2 e2e와 같은 패턴 |
| 2. 실행 방식 | Playwright `chromium.launch({ headless: true })` + 직접 fetch 헬퍼. 시나리오는 `for` 루프 아닌 sequential `await` (Phase 2와 같은 형태) | 결과 가독성 — PASS/FAIL 1행씩 |
| 3. 시나리오 범위 | 6개 — signup→verify / forgot→reset / admin invite→신규 user accept / 기존 user multi-org accept / role+status 변경 / resend·cancel 410. Phase 3 Step 6 §12 6 persona를 그대로 자동화 | Step 6 수동 검증과 1:1 매핑 |
| 4. token 추출 방식 | `pg` 모듈로 servicePool credentials 직접 connect → `SELECT metadata->>'verifyUrl'/'resetUrl'/'acceptUrl' FROM email_outbox WHERE to_email = $1 AND template = $2 ORDER BY created_at DESC LIMIT 1` | dev outbox provider 그대로. raw token이 metadata에 노출되는 dev 정책 (Phase 3 Step 1 §7) 활용 |
| 5. DB connect string 출처 | `process.env.SERVICE_DATABASE_URL` (`server/.env` 같은 값). `dotenv/config` import로 `server/.env` 자동 로딩 — Phase 2 e2e가 같은 패턴 | 환경별 분리 |
| 6. 테스트 데이터 식별자 | email은 `phase3test-<scenario>-<timestamp>@example.test`. afterAll에서 prefix sweep | invitation_routes.test와 같은 prefix isolation |
| 7. 시드 의존 | Acme `admin@acme.test` + `emp@acme.test` + Beta `admin@beta.test` 3개 seeded account 사용. password도 seed default 그대로 | Phase 0.5 / Phase 2와 동일. Phase 3 종합 시점에 seed reset 가정 |
| 8. cleanup contract | (a) finally 블록에서 phase3test- prefix users 직접 DELETE (app pool — users는 RLS off) (b) acme/beta org 안의 phase3test- 초대 모두 `cancel` 처리 또는 invitation_routes.test.afterEach가 다음 server test 실행 시 sweep (c) acme `emp@acme.test` membership을 원상 (role='employee', status='active') 복원 | persona 5에서 만든 role/status 변경을 같은 spec 내에서 되돌림 |
| 9. seeded user password 손상 방지 | 어떤 시나리오도 `admin@acme.test` / `emp@acme.test` / `admin@beta.test`의 password를 변경하지 않음. forgot/reset 시나리오는 새 user (`phase3test-p2`)에 대해서만 진행 | Phase 0.5 / Phase 2 회귀가 같은 seed 사용 |
| 10. multi-org accept 시나리오 user | 새 user 1명을 signup으로 만들고 (`phase3test-multiorg`), 그 user를 Beta admin이 invite → multi-org 검증. seeded `emp@acme.test`는 손대지 않음 | password 비파괴 |
| 11. screenshot artifact | `test/phase_3_e2e.png` 1장만 page.screenshot로 저장. **`.gitignore`에 추가** | Phase 0.5 / Phase 2 패턴과 일치 — 결과물은 dev 디버깅 용 |
| 12. console error fail | Phase 2와 동일하게 `page.on('console')` + `page.on('pageerror')` 수집 후 finally에서 0건 assert. dialog (confirm) 는 자동 accept | 회귀 안전망 |
| 13. caddy single-origin mode | `KLOSER_E2E_BASE_URL`이 set이면 single-origin (https://localhost). 미설정 시 split-origin (8765 + 3001) — Phase 0.5 / Phase 2 패턴 | 옵션 |
| 14. plan/migration/server 추가 | **0건**. 본 step은 순수 자동화 검증 — 서버 / 클라이언트 코드 손대지 않음 | scope 좁힘 |
| 15. Phase 3 종합 findings | `PHASE_3_STEP_7_FINDINGS.md` — 본 step의 e2e 결과 + Phase 3 전체 1~7 step에서 발견된 핵심 architectural 결정 / 미해결 / Phase 4+ 인계 항목 요약 | Phase 4+ 작성자가 read-once로 Phase 3을 파악 가능 |

---

## 2. `test/phase_3_e2e.mjs` 시나리오 세부

### Scenario 1 — signup → verify
1. `uiSignup(page, { email: phase3test-p1, ... })`. `live.html` 도착 후 unverified-banner DOM 존재 확인.
2. `pgPool.query(...)` 로 `verifyUrl` 추출. token URL → `verify.html?token=...`.
3. Page 진입 후 `location.search === ''` 확인 (replaceState OK). state-success 노출 확인.
4. `live.html` 재진입 → unverified-banner 부재 확인.

### Scenario 2 — forgot → reset
1. (parity) unknown email로 forgot → 200 결과 화면 확인. (간단 fetch + DOM 분기)
2. 새 user signup (`phase3test-p2`) → logout → forgot 호출.
3. outbox에서 `resetUrl` 추출 → `reset-password.html?token=...`.
4. 새 password 입력 → 200 + success state.
5. 직접 fetch `POST /auth/login` 새 pw → 200, 옛 pw → 401.

### Scenario 3 — admin invite → 신규 user accept
1. acme admin (api) login → `POST /invitations { email: phase3test-p3, role: 'manager' }` → 201.
2. outbox `acceptUrl` 추출 → 새 browser context (또는 같은 context로 logout 후) → `accept-invitation.html?token=...`.
3. 이름 + password 입력 → 201 → `live.html` 도달.
4. fetch `GET /me` → 응답이 `{ email: phase3test-p3, org: 'Acme Sales Inc.', role: 'manager', email_verified_at: ISO }` 확인.

### Scenario 4 — 기존 user multi-org accept
1. Scenario 1에서 만든 `phase3test-p1` user 재사용 (Acme 멤버는 아니지만 PersonaOne Org 어드민). beta admin (api) login.
2. `POST /invitations { email: phase3test-p1, role: 'viewer' }` → 201 (Beta org에 새 초대).
3. outbox token → logout → `accept-invitation.html` → 적당한 name + 가짜 password → 200 (status 200 명시 분기).
4. `live.html` 도달 → `/me`에서 org=Beta + role=viewer 확인.
5. 가짜 password로 login 시도 → 401 (password 변경 안 됨).

### Scenario 5 — role / status 변경
1. acme admin api login → emp@acme.test membership id 알아냄 (직접 fetch GET /team/members).
2. PATCH role=manager → 200, 응답 membership.role === 'manager'.
3. PATCH status=disabled → 200.
4. emp@acme.test 로그인 시도 → 401 account_disabled.
5. PATCH status=active, role=employee 순으로 restore.
6. emp@acme.test 로그인 → 200 (cleanup 정상 확인).

### Scenario 6 — invitation resend / cancel → 410
1. acme admin api login → `POST /invitations { email: phase3test-p6 }` → 201, token A.
2. `POST /invitations/:id/resend` → 200, token B 발급 + A invalidated.
3. raw token A로 `POST /invitations/accept` → 410.
4. `DELETE /invitations/:id` → 204.
5. raw token B로 accept → 410.

### Cleanup (finally)
- `phase3test-` prefix users 직접 DELETE (cascade org/membership).
- emp@acme.test 강제 복원 (전제: scenario 5 정상 종료해도 안전망).
- console errors 0건 assert.
- `page.screenshot` 1장 (gitignored).

---

## 3. 위험·미정

| 항목 | 처리 |
|---|---|
| Phase 2 e2e가 admin@acme.test password를 의존 — Step 7이 그걸 손상시키면 회귀 fail | scenario 2의 forgot/reset은 **새 user**에 대해서만. seeded admin은 password 안 건드림 |
| persona 6 cancel 후 token B가 invalidate된 상태로 남으면 다음 실행 충돌 | persona 6의 invitation은 phase3test-p6 prefix — afterEach가 다음 실행에서 sweep. 본 step의 cleanup은 더 폭넓게 (생성한 모든 phase3test-*) users 직접 DELETE로 보완 |
| servicePool credential을 e2e가 직접 사용 — dev 외 환경 진입 차단 | `process.env.SERVICE_DATABASE_URL`이 production set인 환경에선 실행 금지. e2e doc에 dev-only 명시 |
| Headless chromium이 cookie 동작 차이로 logout 안 됨 | `kloserApi.logout()` 직접 호출 후 새 context 생성하면 안전. scenario 3 / 4에서 새 context로 분리 |
| seeded `emp@acme.test`를 scenario 5 도중 disable 상태로 남기면 Phase 2 e2e 회귀 다음 실행 시 깨질 가능성 | scenario 5의 마지막 steps + finally의 무조건 restore로 두 번 보장 |
| 본 step 실행 시 dev DB의 phase3test- 잔여 데이터로 두 번째 실행이 23505 conflict | scenario 시작 시 phase3test- prefix users sweep (pre-clean) |
| caddy single-origin variant 미지원 시나리오 | Phase 0.5 / Phase 2와 같이 `KLOSER_E2E_BASE_URL` env로 분기. CI가 split-origin만 검증해도 무관 |

---

## 4. 완료 기준

- [ ] `test/phase_3_e2e.mjs` 6 시나리오 PASS
- [ ] `.gitignore` 보강
- [ ] 회귀 5종 (typecheck / sync / server test / phase 0.5 e2e / phase 2 e2e) PASS
- [ ] `PHASE_3_STEP_7_FINDINGS.md` 작성
- [ ] `PHASE_3_MASTER.md` Step 7 체크박스 [x]
- [ ] Codex 리뷰 통과 (커밋 / push는 그 후)

---

## 5. 한 줄 요약

> **0.5일 동안 `test/phase_3_e2e.mjs` 단일 파일에 6 시나리오 sequential 자동화. servicePool credential로 outbox metadata에서 token 추출. seeded user password는 건드리지 않음 — forgot/reset은 새 user 전용. phase3test- prefix isolation + 강제 restore cleanup. 0 서버 / migration / page 추가. 검증 통과 후 `PHASE_3_STEP_7_FINDINGS.md` + Master 체크박스 [x]. Codex 리뷰 후에만 commit/push.**

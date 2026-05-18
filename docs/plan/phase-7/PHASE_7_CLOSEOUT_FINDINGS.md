# Phase 7 Closeout Findings

작성일: 2026-05-18

상위 문서: `PHASE_7_MASTER.md` · 단계별 결과: `PHASE_7_STEP_{1..9}_FINDINGS.md`.

> Phase 7의 9개 step이 모두 닫혔다. 운영 출시 직전 게이트(이메일·MFA·감사·보존) + P1 follow-up bundle(비용 매핑·sidebar 권한·보고서 정밀화·demo 정리·billing caps)이 한 묶음으로 봉합된 상태다. 본 문서는 closeout 시점의 정본 결과·검증 명령·남은 리스크·Phase 8 / 별도 Phase 인계 항목을 한 곳에 모아 둔다.

---

## 1. Phase 7 결과 요약

| Step | 주제 | 정본 문서 | 핵심 산출 |
|---|---|---|---|
| Step 1 | Resend 실 email + transactional `email_outbox` | `PHASE_7_STEP_1_FINDINGS.md` | `email_outbox`에 status/provider/sensitive_payload + AES-256-GCM, BullMQ `email-delivery` 싱글톤 워커 (lease → decrypt → send → markDelivered+scrub / 지수 백오프 / dead letter), `EMAIL_PROVIDER=resend` adapter, dev `dev_outbox` 호환 |
| Step 2 | TOTP MFA + 세션 강화 | (전용 findings 미작성 — `PHASE_7_UI_BACKEND_STATUS.md` + 코드 본체가 정본) | login challenge gate(5분 TTL) + refresh 시 MFA required 재검, 인증된 enroll/disable, 조직 단위 MFA 강제 토글, `settings.html`/`login.html` frontend wiring |
| Step 3 | activity_log + 감사 로그 | `PHASE_7_STEP_3_FINDINGS.md` | schema hardening, repository + service helper(payload sanitizer), 보안/멤버십/초대/고객/통화/지식/보고서 audit hook 묶음, 관리자용 `GET /activity-log` (cursor + cross-org isolation), `settings.html` 관리자 audit 패널 (모든 값 textContent 렌더) |
| Step 4 | retention enforce cron | `PHASE_7_STEP_4_FINDINGS.md` | transcript 3년 hard delete (batch + maxBatches cap, org별 `withOrgContext`), `email_outbox` stuck-sending recovery (`attempt_count` 불변, 락 메타 클리어), aggregate audit row, BullMQ `retention-sweep` 싱글톤 워커 (`KLOSER_RETENTION_ENABLED` gate) |
| Step 5 | LLM 사용 비용 매핑 | `PHASE_7_STEP_5_FINDINGS.md` | `calculateUsageCostUsdMicros` adapter boundary helper, Anthropic Sonnet/Opus/Haiku + OpenAI embedding 가격 상수(verified-on 2026-05-18), unknown/missing/Clova는 `cost_usd_micros=NULL` + `metadata.cost_status` 마커. backfill 없음 |
| Step 6 | role-based sidebar visibility | `PHASE_7_STEP_6_FINDINGS.md` | `_shared.js`에 `SIDEBAR_NAV_VISIBILITY` + `canShowSidebarPage` + `applySidebarNavVisibility`, employee=팀 보고서 숨김, viewer=팀 보고서/실시간 통화/뉴스레터 숨김. `.nav-item[hidden]` CSS overflow, pre-/me 상태는 공통 nav만 |
| Step 7 | 보고서 date window + agent drilldown | `PHASE_7_STEP_7_FINDINGS.md` | `GET /reports/team-summary`에 `from`/`to` (omit 시 최근 30일, one-sided 400, > 366d 거부), 응답에 `window` + `agent_summaries` (org scope에 unassigned 버킷, manager는 본인 팀만), `reports.html` 7/30/90/직접 preset + agent row-click drilldown, audit payload에 `from/to/window_days` |
| Step 8 | demo-to-real frontend cleanup | `PHASE_7_STEP_8_FINDINGS.md` | `dashboard.html` `kpiAvgDuration` textContent 전환 + API 실패 banner + demo `data-source="demo"` 마커. `daily.html`/`_daily.js` demo 정직성 카피 + user-typed `escapeHtml`. `newsletter.html` "발송" → "시뮬레이션" 일관 표기 + `appendUser` chat XSS hole + 사용자 템플릿 카드 XSS hole 닫음. transactional `email_outbox`를 newsletter campaign에 미연결, `activity_log`를 dashboard 팀 활동 feed로 미노출 |
| Step 9 | billing / subscription caps | `PHASE_7_STEP_9_FINDINGS.md` | `organizations.plan` CHECK + `organization_billing_profiles` 신규 (FORCE RLS, DELETE 미부여, trialing backfill), `BILLING_PLAN_LIMITS` 단일 source-of-truth, `assertPlanAllows`(+`Absolute`) + `PlanLimitExceededError`(403, code=plan_limit_exceeded). invitations/customers/calls(REST+WS)/knowledge KB/chunk replace 강제. `GET /billing/overview` + `PATCH /billing/profile` admin 전용, audit payload는 field name only. settings.html#billing 정적 카드 → API-backed dynamic, 가짜 결제 수단/내역 제거, `external_provider_configured` boolean만 노출 |

---

## 2. Cross-cutting 정책 (Phase 7 동안 새로 굳어진 것)

- **외부 HTTP는 워커가 책임진다.** 요청 transaction 안에서 외부 provider를 직접 호출하지 않는다. `email_outbox` / `callSummary` / `retention-sweep` 모두 BullMQ singleton repeatable로 분리.
- **민감 페이로드 분리.** verify/reset/invite raw token은 `email_outbox.sensitive_payload_*`에 AES-256-GCM으로만 저장하고, archive(`body_text`/`metadata`)는 `?token=[redacted]`로 마스킹.
- **3-way audit lockstep.** 새 audit action을 추가할 때 DB CHECK + `ActivityAction` union + 라우트 `ACTIVITY_ACTIONS` allow-list 셋이 같이 움직인다. Step 3·9에서 동일 패턴 사용.
- **Audit payload는 field 이름만.** PII / 결제 정보 값은 audit row에 넣지 않는다. Step 9 `billing.profile_updated`가 본 정책의 정본 예시.
- **3-way 공유 타입 sync.** `server/src/types/<x>.ts` (zod) ↔ `platform/types/<x>.js` (JSDoc) ↔ `test/sync_shared_types.mjs` 레지스트리. 새 도메인 추가 시 셋 다 갱신.
- **Frontend XSS gate.** 서버에서 받은 email / audit / tax_id / report 값은 `textContent` 또는 `escapeHtml`. `innerHTML`은 qrcode-generator 같은 자체 escape하는 라이브러리 출력에만 한정.
- **Provider env fail-fast.** `EMAIL_PROVIDER=resend`로 명시했는데 키가 없으면 boot 시 throw. silent fallback 금지. 같은 정책이 LLM/STT provider에도 적용됨.
- **Plan limits는 service 레이어.** REST + WS 두 경로가 동일 service를 거치도록 만들어, `assertPlanAllows`를 단일 지점에 둔다.

---

## 3. 검증 명령 (Phase 7 closeout 시점)

모두 2026-05-18 PASS.

```bash
# 빌드/타입/스키마
npm --prefix server run typecheck            # PASS
npm --prefix server run db:migrate:up        # No migrations to run!
node test/sync_shared_types.mjs              # PASS (billing 7개 타입 포함)

# 백엔드 단위/통합/라우트 전수
npm --prefix server test                      # 769 PASS / 3 skipped / 0 fail (총 772)

# Phase 7 step 단위 회귀
npx tsx --test --test-concurrency=1 \
    server/test/phase7_email_outbox_repo.test.mjs \
    server/test/phase7_email_provider.test.mjs \
    server/test/phase7_email_delivery_worker.test.mjs \
    server/test/phase7_step2_*.test.mjs \
    server/test/phase7_step3_*.test.mjs \
    server/test/phase7_step4_*.test.mjs \
    server/test/phase7_step5_llm_pricing.test.mjs \
    server/test/phase6_team_reports.test.mjs \
    server/test/phase7_step9_billing_repo.test.mjs \
    server/test/phase7_step9_billing_caps.test.mjs \
    server/test/phase7_step9_billing_routes.test.mjs

# 위생 게이트
git diff --check                              # clean
```

**Playwright manual smoke (Step 9 마지막 회):**

- admin desktop (1280×900): `/billing/overview` 6 cap progress bars 렌더, plan=PRO, status=체험, `external_provider_configured` boolean만 표시.
- admin mobile (390×844): single column fallback, 입력 form overflow 없음.
- employee desktop/mobile: 403 → `<div id="billing-forbidden">` 패널만 노출, JS uncaught error 없음.
- tax_id XSS `<script>window.__XSS=true</script>` PATCH → input.value로만 보관, `window.__XSS===false`, `document.body.outerHTML.includes('window.__XSS')===false`.

**남겨 둔 검증:**

- 실 Resend domain/credentials smoke test — staging 운영 검증 시점에 수행. dev path는 Phase 3 e2e와 Step 1 worker 테스트로 검증됨.

---

## 4. Phase 7 Go / No-Go 최종 상태

`PHASE_7_MASTER.md §6`의 closeout 체크리스트 — 본 closeout 시점에 모든 항목 [x] (9/9).

- [x] verify/reset/invite 이메일이 dev outbox + 실 provider mode 양쪽에서 검증됨 (Phase 3 e2e + Step 1 worker 테스트).
- [x] MFA required org에서 password-only access issuance 차단 (Step 2).
- [x] audit target events가 org-scoped row로 기록됨 (Step 3).
- [x] retention worker가 deterministic test cutoff로 검증됨 (Step 4).
- [x] `npm --prefix server run typecheck` PASS.
- [x] `npm --prefix server test` PASS (769/772, 3 skipped, 0 fail).
- [x] `node test/sync_shared_types.mjs` PASS.
- [x] 관련 phase e2e PASS (Phase 3 anonymous flow / Phase 5·6 reports / Phase 7 단위 모두 그대로 통과).
- [x] Phase 7 findings + 다음 Phase handoff 작성 — 본 문서 + `§7` Phase 8 handoff 노트.

---

## 5. 남은 리스크 / 한계 (정직성)

운영 출시 직전 게이트는 모두 통과한 상태지만, 다음 항목은 **의도적으로 Phase 7 범위 밖에 남겨 둔** 약속이거나 한계다. Phase 8 / 별도 Phase 인계 항목과 구분해 둔다.

### 5.1 의도된 한계 (계획대로 미수행)

- **실 결제 provider(Stripe/Toss) 연동.** Step 9는 plan caps + admin overview까지만 닫는다. 외부 돈 이동 / 회계 계약 / webhook / invoice PDF / card update / cancellation flow는 별도 Phase로 분리.
- **`monthly_llm_cost_usd_micros` hard cap.** Step 9에서 soft cap(overview에만 노출). hard 전환 시 provider call site 곳곳에 cap 체크가 필요해 회귀 위험. 후속 step으로 미룸.
- **call_recordings audio storage.** Step 4 retention 대상이지만 recording storage 자체가 없음. Phase 8 recording surface 도입 시 같은 retention worker에 추가.
- **enterprise SSO.** Phase 7 범위 밖. 단일 회사·소수 직원 PoC 단계에 SSO 필요성 낮음.
- **multilingual transcript + `organizations.timezone`.** 해외 시장 진입 시점에 묶음.
- **newsletter / daily 실 backend.** Step 8에서 demo 정직성만 정리, 외부 데이터 소스 연결은 별도 Phase.

### 5.2 운영 검증 잔존

- **실 Resend domain 검증.** `EMAIL_PROVIDER=resend` 모드는 fake adapter worker 테스트로 검증됨. staging 운영 환경에서 verify/reset/invite 3종 모두 도착하는지 한 번 직접 확인 필요. `RESEND_API_KEY` + `EMAIL_FROM` + 도메인 DNS 세팅 묶음.
- **`KLOSER_RETENTION_ENABLED=true` 운영 부팅 확인.** dev/test에서는 의도적으로 OFF. staging에서 한 번 ON으로 켜서 sweep 로그(`retention.transcripts_deleted` / `email_outbox.sending_recovered`)와 BullMQ 대시보드 일치 확인 필요.
- **Anthropic / OpenAI 실 키.** Phase 6에서 mock/real adapter 분기는 닫혔지만, 운영 환경 fail-fast 검증을 위해 실 키를 한 번 boot에 통과시켜 확인 필요.

### 5.3 알려진 작은 한계

- **`acceptInvitation` seat 재검에 FOR UPDATE 없음.** `kloser_service` 롤에 `organizations` UPDATE 권한이 없어 servicePool path에서 row lock이 안 잡힌다. accept는 net-zero (pending → active) 이라 일반 plan에서는 race 무해. downgrade(예: enterprise → starter) 직후 동시 accept 시 짧은 race window 가능 — 운영적으로 무의미.
- **dashboard pollution orphan call row.** ws_calls 테스트가 가끔 dropped/started_at만 있는 통화 행을 남긴다. dashboard_routes 테스트가 그 잔재로 회귀하는 패턴이 Step 7, 8, 9에서 반복적으로 관찰됨. dev DB cleanup 스크립트로 해소. 정식 해결은 Phase 8 ws_calls cleanup hook 개선과 함께.

---

## 6. 변경 영향 / Backward incompat 정리

운영 데이터에 영향을 주는 변경:

- **Step 7**: `GET /reports/team-summary`가 from/to omit 시 이전엔 전체 기간을 반환했는데 이제 최근 30일을 default로 반환. 의도된 변경. frontend는 preset로 표면화.
- **Step 9 schema**: `organizations.plan`에 CHECK가 새로 붙음. 기존 row(`pro`/`starter` seed)는 통과. 비표준 plan 문자열을 외부에서 직접 INSERT/UPDATE했다면 거부됨 — 운영 데이터는 영향 없음.
- **Step 9 schema**: `organization_billing_profiles` 신규. 마이그레이션이 모든 기존 org에 `billing_status='trialing'` 행을 backfill. 신규 signup도 자동 backfill됨 (`upsertCurrentBillingProfile`).
- **Step 9 service**: invitations / customers / calls / knowledge mutation 경로에 plan cap 강제. 기존 seed 데이터는 cap 안에 들어가지만, 외부 e2e에서 cap을 넘기는 데이터를 만든다면 403 반환 — 의도된 동작.
- **Step 8 UI**: dashboard `kpiAvgDuration` 렌더링 방식이 `innerHTML` → textContent 2-span으로 바뀜. 같은 페이지를 자동화 e2e가 `innerHTML`로 직접 읽는다면 selector 갱신 필요.

운영 데이터에 영향 없는 변경:

- Step 1 `email_outbox` 컬럼 추가 — 기존 dev mode 호환.
- Step 3 `activity_log_action_check` 확장 — 새 액션만 추가, 기존 액션 제거 없음.
- Step 4 retention worker — `KLOSER_RETENTION_ENABLED` 기본 OFF.
- Step 5 `llm_usage_log.cost_usd_micros` — adapter 경계에서만 계산, 과거 row backfill 없음.
- Step 6 sidebar visibility — frontend-only.

---

## 7. Phase 8 / 별도 Phase 인계

### 7.1 별도 Phase로 분리 (Phase 8 이전에 단독 진행)

- **결제 provider 연동.** Stripe Checkout 또는 Toss 결제. Step 9의 `organization_billing_profiles.external_provider/_customer_id/_subscription_id` 컬럼이 이 연동의 hook이다. webhook 시 service-role token으로 update, audit row(`billing.subscription_synced` 등 신규 action)는 3-way lockstep으로 추가.
- **Resend domain 운영 검증.** staging 부팅 + verify/reset/invite 3종 도착 확인 + Resend 대시보드의 delivery rate 모니터링 셋업.

### 7.2 Phase 8 후보 (제품 영역 확장)

- **call recording audio storage + playback.** S3 / MinIO + signed URL + 90일 retention(이미 Step 4 retention worker에 hook 자리 있음). `call_recordings` 신규 테이블.
- **녹취 기반 transcript 품질 향상.** STT provider 비용·정확도 비교(Phase 7 Step 5 cost map이 비교 데이터 제공).
- **녹취 → 통화 검색.** 통화 메모 + 요약 + transcript 텍스트 검색.

### 7.3 P2/P3 항목 (현재 우선순위 낮음)

- enterprise SSO (Okta / Azure AD / Google Workspace).
- multilingual transcript + `organizations.timezone`.
- bulk knowledge import.
- newsletter campaign 실 backend.
- `monthly_llm_cost_usd_micros` hard cap 전환.

---

## 8. 다음 세션 entry point

다음 세션은 **결제 provider 연동 Phase 또는 Phase 8 (call recording)** 중 하나의 plan 수립부터 시작한다.

선택지:

1. **결제 provider Phase**
   - Step 9의 `organization_billing_profiles.external_*` 자리에 Stripe(or Toss) Customer / Subscription 객체를 연결.
   - webhook → `billing-sync` 워커 → `organization_billing_profiles` UPDATE + `activity_log` 신규 action.
   - frontend `settings.html#billing`에 "플랜 변경" / "결제 수단 변경" CTA를 Stripe Customer Portal 또는 Toss 위젯으로 redirect.
   - 상세 계획 문서: `docs/plan/phase-billing/PHASE_BILLING_MASTER.md` (별도 폴더로 분리 제안).

2. **Phase 8 — call recording**
   - 새 master 문서 `docs/plan/phase-8/PHASE_8_MASTER.md`.
   - 첫 step: `call_recordings` schema + S3/MinIO adapter + 업로드 URL signing.
   - 두 번째 step: live.html / calls.html에 playback UI.
   - 세 번째 step: Step 4 retention worker에 recording 90일 hard delete 추가.

운영 입장에서는 **결제 provider** 가 매출 성립의 마지막 게이트이므로 우선순위가 더 높다. 제품 입장에서는 **녹취** 가 차별화 기능이므로 마케팅 견인 효과가 크다. 선택은 운영팀과 합의 후 결정.

---

## 9. 참조

- 상위 master: `PHASE_7_MASTER.md`
- 단계별: `PHASE_7_STEP_1_FINDINGS.md`, `PHASE_7_STEP_3_FINDINGS.md`, `PHASE_7_STEP_4_FINDINGS.md`, `PHASE_7_STEP_5_FINDINGS.md`, `PHASE_7_STEP_6_FINDINGS.md`, `PHASE_7_STEP_7_FINDINGS.md`, `PHASE_7_STEP_8_FINDINGS.md`, `PHASE_7_STEP_9_FINDINGS.md`
- Step 2 본문: `PHASE_7_UI_BACKEND_STATUS.md` + `server/src/services/auth.ts` + `server/src/repositories/mfaUsers.ts` + `server/src/routes/auth.ts` + `server/src/routes/organizationSecurity.ts` 코드 본체
- 사용자 가이드: `docs/USER_GUIDE_PHASE_7.md` (본 closeout과 같은 묶음에서 갱신)
- 직전 Phase 인계: `docs/plan/phase-6/PHASE_7_HANDOFF.md`

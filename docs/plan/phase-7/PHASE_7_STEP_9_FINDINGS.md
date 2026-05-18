# Phase 7 Step 9 Findings — billing / subscription caps

작성일: 2026-05-18

상위 문서: `PHASE_7_MASTER.md` · 상세 계획: `PHASE_7_STEP_9_PLAN.md`.

---

## 1. 산출물

| 영역 | 위치 |
|---|---|
| Schema | `server/migrations/1715000027000_phase7_billing_caps.sql` — `organizations.plan` CHECK (`starter`/`pro`/`enterprise`), `organization_billing_profiles` 신규 (`org_id PK FK ON DELETE CASCADE` + RLS FORCE + `app` 롤 SELECT/INSERT/UPDATE 권한 + `billing_status` enum CHECK + trialing 기본값 backfill), `activity_log_action_check`에 `billing.profile_updated` 추가. DELETE 권한은 의도적으로 부여하지 않음. |
| Shared types | `server/src/types/billing.ts` (BillingPlan/BillingStatus/BillingOrganization/BillingProfile/BillingEntitlements/BillingUsage/BillingLimitState/BillingLimitEnforcement/BillingOverviewResponse/BillingProfilePatchInput) + `platform/types/billing.js` JSDoc 미러 + `test/sync_shared_types.mjs`에 `billing` 레지스트리 추가. |
| Repository | `server/src/repositories/billing.ts` — `getCurrentOrganization`/`lockCurrentOrganization` (FOR UPDATE), `getCurrentBillingProfile`/`upsertCurrentBillingProfile`/`patchCurrentBillingProfile`, `getCurrentBillingUsage` (seats CTE + customers/KB/chunk count + UTC-month 반열림 window + llm-cost known/unknown split). UTC 월 helper 노출 (`startOfUtcMonth`/`startOfNextUtcMonth`/`utcMonthLabel`). |
| Service | `server/src/services/billing.ts` — `BILLING_PLAN_LIMITS` 단일 source-of-truth, `BILLING_LIMIT_ENFORCEMENT` (cost만 soft), `PlanLimitExceededError`(code=`plan_limit_exceeded`, statusCode=403), `BillingNotFoundError`(404), `getBillingOverview`/`buildOverviewInTransaction`, `patchBillingProfile`(audit payload = `{ fields: [...] }` *names only*), `assertPlanAllows` + `assertPlanAllowsAbsolute` + derived absolute total 계산 전용 `lockCurrentOrgForPlanLimit`. enterprise=null=unlimited fast-path. |
| Audit lockstep | `server/src/repositories/activityLog.ts` ActivityAction union에 `billing.profile_updated` 추가, `server/src/routes/activityLog.ts` `ACTIVITY_ACTIONS` allow-list에 동일 추가. DB CHECK + 코드 union + 라우트 allow-list 3-way 일치. |
| Routes | `server/src/routes/billing.ts` (`GET /billing/overview`, `PATCH /billing/profile`; 두 라우트 모두 `requireAuth + orgContext + requireVerified + requireRole("admin") + requireFreshRole`; `PlanLimitExceededError`→403 structured, `BillingNotFoundError`→404, ZodError→400, 42501→500 rls_violation, AuthError→AuthError-mapped). `server/src/server.ts` 등록. |
| Cap 통합 | `server/src/services/invitations.ts` — `createInvitation`에 `assertPlanAllows(seats, +1)`; 단, same-email live pending은 먼저 `invitation_already_pending`을 반환하고 expired pending은 먼저 cancel 후 cap을 재검해 net-zero replacement가 cap에서 막히지 않게 함. `acceptInvitation`(servicePool tx)에 seats 재검 (FOR UPDATE 없음 — kloser_service에 organizations UPDATE 권한 없음 / accept는 net-zero라 race 무해). `server/src/routes/invitations.ts` PATCH/POST 두 경로 모두 `PlanLimitExceededError` 403 매핑. `server/src/services/customers.ts` `createCustomer` cap. `server/src/services/calls.ts` `createCall` cap — REST POST `/calls` + WS `start_call` 두 경로가 같은 service를 거치므로 단일 guard. `server/src/services/knowledge.ts` `createKnowledgeBase` + `replaceKnowledgeChunks`(absolute target). chunk replace는 org row lock을 먼저 잡고 total을 계산해 서로 다른 KB 동시 replace가 stale count로 cap을 초과하지 못하게 함. `server/src/ws/calls.ts` start_call catch에서 structured `{error, code, limit_key, plan, current, limit, attempted}` ack. |
| Backend tests | `server/test/phase7_step9_billing_repo.test.mjs` (12 cases), `phase7_step9_billing_caps.test.mjs` (11 cases), `phase7_step9_billing_routes.test.mjs` (11 cases). 34 new cases. 기존 invitations 테스트 (`server/test/invitation_routes.test.mjs`)는 Beta seed가 starter(seats=2)인 채로 3번째 invite를 만드는 등 cap 시나리오가 아니므로 `before`에서 Acme/Beta를 enterprise로 잠시 승격 후 `after`에서 원복. |
| Frontend | `platform/api.js` — `getBillingOverview` / `patchBillingProfile` 추가. `platform/settings.html#billing` 정적 카드 전체 교체: 결제 수단/결제 내역 (가짜) 제거, plan badge + status badge + org name + usage_month + entitlements vs usage 6 cards (progress bar + soft 라벨), 청구 정보 form(`tax_id` maxlength=64 + `billing_email` email input) + 저장 버튼. 비관리자에게는 "플랜 정보는 관리자만 확인할 수 있습니다." 패널만 노출, JS 예외 없음. 모든 서버 값은 `textContent`/input.value로 주입 (XSS 차단). |
| Docs | 본 문서 + `PHASE_7_MASTER.md` Step 5+ bundle #5 완료 표시 + `README.md` 현재 단계 갱신. |

---

## 2. Plan limits 표

| key | starter | pro | enterprise | enforcement |
|---|---|---|---|---|
| seats | 2 | 10 | null | hard |
| customers | 100 | 1,000 | null | hard |
| knowledge_bases | 3 | 50 | null | hard |
| knowledge_chunks | 500 | 10,000 | null | hard |
| monthly_calls | 100 | 5,000 | null | hard |
| monthly_llm_cost_usd_micros | 5,000,000 (= $5) | 100,000,000 (= $100) | null | **soft** (overview에만 노출) |

`null` = 무제한. enterprise는 `assertPlanAllows`가 fast-exit (count 쿼리 생략).

soft cap은 `assertPlanAllows`도 fast-exit. 즉, llm 비용 한도는 admin이 사용량을 *보기* 위한 신호일 뿐 mutation을 막지 않는다. Step 9에서 LLM 비용을 hard로 만들면 provider call site 곳곳에 cap 체크가 필요해 회귀 위험이 커서 후속 step으로 미룬다.

---

## 3. API contract

### 3.1 `GET /billing/overview`

- Auth: `requireAuth + orgContext + requireVerified + requireRole("admin") + requireFreshRole`
- 200 응답:

```json
{
  "organization": { "id": "...", "name": "Acme Sales Inc.", "plan": "pro" },
  "profile": {
    "billing_status": "trialing",
    "billing_email": null,
    "tax_id": null,
    "current_period_start": null,
    "current_period_end": null,
    "trial_ends_at": null,
    "external_provider_configured": false
  },
  "entitlements": { "seats": 10, "customers": 1000, ... },
  "usage": {
    "seats": 2, "active_members": 2, "pending_invitations": 0,
    "customers": 24, "knowledge_bases": 0, "knowledge_chunks": 0,
    "monthly_calls": 0, "monthly_llm_cost_usd_micros": null,
    "usage_month": "2026-05"
  },
  "limits": [
    { "key": "seats", "current": 2, "limit": 10, "percent": 20, "exceeded": false, "enforcement": "hard" },
    ...
  ]
}
```

- 403 (admin 아님 / stale_role), 404 (조직이 사라진 직후 GUC race), 401(미인증).

### 3.2 `PATCH /billing/profile`

- Body: `{ billing_email?: string|null, tax_id?: string|null }`. 둘 다 optional, 빈 객체는 400.
- 빈 문자열 → null로 정규화 후 zod 통과. tax_id maxlength=64.
- 200 → `{ "profile": BillingProfile }` (overview의 profile 부분과 동일 shape).
- Audit row: `action='billing.profile_updated'`, `payload={ fields: [...] }`. **value 미포함** (PII 보호).
- 401/403/400(invalid_input, empty_patch, ZodError).

### 3.3 Cap error 응답

```json
{
  "error": "plan_limit_exceeded",
  "code": "plan_limit_exceeded",
  "limit_key": "seats",
  "plan": "starter",
  "current": 2,
  "limit": 2,
  "attempted": 3
}
```

- REST: 403.
- WS `start_call`: 같은 구조를 ack payload로 emit.

---

## 4. 외부 provider id 노출 정책

- DB 저장: `external_provider` / `external_customer_id` / `external_subscription_id` (모두 nullable) + `metadata jsonb`.
- 응답: **노출 안 함**. 대신 `external_provider_configured` boolean 하나만 노출.
- `PATCH /billing/profile`에서는 두 필드 모두 **수정 불가** (zod 스키마에 없음). 향후 Stripe webhook 등에서만 update.
- routes 테스트 case 9: 내부 컬럼을 직접 채워두고 GET 응답에 plain text가 새지 않는지 `body.includes(...)` 확인.

---

## 5. Cap 적용 지점

| limit_key | service | comment |
|---|---|---|
| `seats` | `invitations.createInvitation` (POST), `invitations.acceptInvitation` (servicePool path; net-zero이라 일반적으로 통과, downgrade 후 재가입 시만 trip) | `createInvitation`은 same-email pending 처리 후 `assertPlanAllows(+1)` |
| `customers` | `customers.createCustomer` | `assertPlanAllows(+1)` |
| `knowledge_bases` | `knowledge.createKnowledgeBase` | `assertPlanAllows(+1)` |
| `knowledge_chunks` | `knowledge.replaceKnowledgeChunks` | org row lock → post-replace total 계산 → `assertPlanAllowsAbsolute(targetTotal)` — replace이라 increment 시맨틱 부적합 |
| `monthly_calls` | `calls.createCall` | REST `POST /calls` + WS `start_call`이 동일 service를 거침 |
| `monthly_llm_cost_usd_micros` | (적용 안 함) | soft cap. overview에만 노출 |

모든 cap 체크는 `app.withOrgContext` 내부에서 `lockCurrentOrganization` (org row FOR UPDATE) 직후 카운트를 읽어 race를 직렬화한다. 단, chunk replace처럼 post-write absolute total을 service가 직접 계산해야 하는 경로는 `lockCurrentOrgForPlanLimit`로 먼저 같은 org row를 잠근 뒤 total을 계산한다.

---

## 6. UI / settings.html#billing

### 6.1 구성

- 헤더 카드: 플랜 badge + 결제 상태 badge + 조직명 + usage_month + 결제 연동 상태.
- 사용량 카드 6장: 각 cap에 대해 현재/한도 + progress bar (한도 없을 땐 회색 0%, 80% 이상 amber, exceeded는 rose). soft cap엔 `(참고용)` 라벨.
- 청구 정보 form: tax_id (maxlength=64) + billing_email (type=email). 저장 시 PATCH.
- 결제 연동 안내: "결제 연동은 아직 준비 중입니다. … 운영팀(support@kloser.com)으로 문의…". 가짜 결제 수단 / 영수증 PDF 버튼 제거.

### 6.2 정적 안전성

- 모든 서버 값은 `textContent` 또는 input.value setter로만 주입. `innerHTML` 미사용.
- tax_id에 `<script>alert(1)</script>`를 PATCH로 보내고 다시 GET해도 input 표시값으로만 들어가고 body HTML에 raw script가 나타나지 않음. Playwright smoke로 확인.
- 비관리자(employee) 응답 403 → `<div id="billing-forbidden">` 노출, JS 예외 없음. Chrome devtools network 패널의 "Failed to load resource: 403"은 브라우저 기본 로그이며 코드에서 발생하는 uncaught error 아님.

### 6.3 mobile

- `grid sm:grid-cols-2` 단일 컬럼으로 자연 fallback. 390x844 viewport에서 form input/limit card 모두 viewport에 맞춰 단일 컬럼 정렬 (Playwright snapshot).

---

## 7. Validation gate 결과

| 항목 | 결과 |
|---|---|
| `npm --prefix server run db:migrate:up` | "No migrations to run!" (이미 적용 완료) |
| `npm --prefix server run typecheck` | PASS |
| `node test/sync_shared_types.mjs` | PASS (billing 7 types 인식) |
| Step 9 targeted: billing_repo.test | 12/12 PASS |
| Step 9 targeted: billing_caps.test | 11/11 PASS |
| Step 9 targeted: billing_routes.test | 11/11 PASS |
| `npm --prefix server test` | 769/772 PASS, 3 skipped, 0 fail (invitation 테스트는 enterprise 승격으로 회귀 해결, dashboard 잔류 orphan row 1건은 cleanup 후 재현 없음) |
| `git diff --check` | clean (CRLF/LF 경고 2건은 기존 audit hook 파일의 lineending 차이) |
| Playwright admin desktop (1280x900) | overview 6 limit cards 렌더, plan="PRO", status="체험", limits 정상 |
| Playwright admin mobile (390x844) | section visible, single column, no overflow |
| Playwright employee 403 desktop | "플랜 정보는 관리자만 확인할 수 있습니다." 패널, content/error/loading 모두 hidden, JS 예외 없음 |
| Playwright employee 403 mobile | 같음 |
| Playwright tax_id XSS (`<script>window.__XSS=true</script>`) | PATCH 200 + 저장 메시지, `window.__XSS===false`, `document.body.outerHTML.includes('window.__XSS')===false` |
| 외부 id 미노출 | profile 응답에 `external_customer_id`/`external_subscription_id`/`metadata` 키 자체가 없음 (`'in'` 연산자로 확인) |

---

## 8. 의도적으로 안 한 것

- 실 결제 provider(Stripe/Toss) 연동. webhook, invoice PDF, card update flow는 외부 돈 이동/회계 계약 동반이라 별도 Phase.
- `customers.plan` 재도입.
- LLM cost hard cap. provider call site마다 cap 체크가 필요해 회귀 위험. soft cap 신호만 노출.
- 결제 내역 / 영수증 PDF — 결제 provider 연동 후에만 생기는 데이터.
- `external_provider` / `external_customer_id` / `external_subscription_id`의 PATCH 노출 — webhook 전용 필드.

---

## 9. 후속 작업

- (별도 Phase) Stripe / Toss Checkout 연동 + invoice / receipt PDF + cancellation flow.
- (별도 step) `monthly_llm_cost_usd_micros` hard cap 검토 — adapter 호출 직전 누적합 ≥ limit이면 차단할지, 월 시작 시점에 plan 한도 초과 메일을 보낼지 결정 필요.
- `acceptInvitation`에서 seat 재검을 servicePool로 두는 한계 — admin pool로 옮기려면 service-role 자격 관리 정책 변경 필요. 현재 net-zero라 일반 plan에서는 trip하지 않음.

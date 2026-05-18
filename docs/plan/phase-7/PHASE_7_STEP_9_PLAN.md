# Phase 7 Step 9 Plan — billing / subscription caps

작성일: 2026-05-18

상위 문서: `PHASE_7_MASTER.md`

선행 완료:

- Step 1 — Resend email delivery + transactional `email_outbox`
- Step 2 — TOTP MFA / session hardening
- Step 3 — `activity_log` audit trail + admin query surface
- Step 4 — retention enforce cron
- Step 5 — `llm_usage_log.cost_usd_micros` price map
- Step 6 — role-based sidebar visibility
- Step 7 — reports date window + agent drilldown
- Step 8 — demo-to-real frontend cleanup

이번 step의 목적은 Phase 7 P1의 마지막 항목인 **billing / subscription caps**를 닫는 것이다. `organizations.plan`을 tenant subscription tier의 source-of-truth로 유지하면서, plan별 사용 한도를 backend에서 계산하고 mutation 경로에서 강제한다. `settings.html`의 정적 "플랜 & 결제" 섹션은 실제 API-backed overview로 바꾼다.

중요: Step 9는 **실 결제 provider 연동 단계가 아니다**. Stripe/Toss Checkout, webhook, invoice PDF, card update flow는 외부 돈 이동과 회계 계약을 수반하므로 별도 Phase로 분리한다. Step 9는 유료 전환 직전 필요한 내부 권한/한도 모델, API, UI 정직성을 먼저 만든다.

---

## 1. Current State

### 1.1 이미 있는 것

- `organizations.plan`
  - 초기 schema부터 존재.
  - seed:
    - Acme: `pro`
    - Beta: `starter`
  - `/me` 응답과 sidebar org card에서 표시됨.
- `settings.html` `#billing`
  - 정적 PRO 카드, 결제 수단, 청구 정보, 결제 내역 HTML.
  - 실제 backend route 없음.
  - 결제 수단/영수증 버튼은 실제 동작 없음.
- 사용량 산출에 필요한 데이터
  - seats: `memberships` + `invitations`
  - customers: `customers`
  - calls: `calls`
  - knowledge: `knowledge_bases`, `knowledge_chunks`
  - LLM cost: `llm_usage_log.cost_usd_micros` (Step 5)

### 1.2 현재 부족한 것

- `organizations.plan`에 DB CHECK가 없어 임의 문자열이 들어갈 수 있다.
- plan별 entitlements/caps가 코드로 고정되어 있지 않다.
- seat/customer/knowledge/call 한도 초과를 mutation path에서 막지 않는다.
- admin이 현재 plan, cap, 사용량을 API로 볼 수 없다.
- billing 섹션이 실제 결제 수단/결제 내역처럼 보이지만 전부 demo다.
- cap 초과 에러 vocabulary가 없다.

---

## 2. Scope

### 한다

1. **Plan enum hardening**
   - `organizations.plan` 값을 `starter | pro | enterprise`로 고정.
   - existing seed와 signup 기본값(`starter`) 호환.
   - `customers.plan`은 재도입하지 않는다.

2. **Billing profile schema**
   - org별 billing metadata를 별도 table로 둔다.
   - plan 자체는 계속 `organizations.plan`에 둔다. 중복 source-of-truth를 만들지 않는다.
   - tax id / billing email / billing status / period metadata 정도만 저장한다.

3. **Entitlement map**
   - TypeScript 상수로 plan별 caps를 정의한다.
   - `null`은 unlimited.
   - 숫자는 돈/가격이 아니라 제품 사용량 제한이다.

4. **Usage overview API**
   - admin 전용 `GET /billing/overview`.
   - 현재 org의 plan, billing profile, entitlements, usage, over-limit 상태를 반환.
   - usage query는 `app.withOrgContext` 안에서 RLS를 탄다.

5. **Billing profile update API**
   - admin 전용 `PATCH /billing/profile`.
   - `billing_email`, `tax_id` 같은 운영 metadata만 수정.
   - plan 변경 endpoint는 만들지 않는다. provider/webhook 없는 수동 plan 변경 API는 운영 오해가 크다.

6. **Cap enforcement**
   - mutation service에서 한도 초과를 막는다.
   - 우선 hard cap:
     - seats: invitation create, invitation accept
     - customers: customer create
     - knowledge bases: knowledge base create
     - knowledge chunks: chunk replace
     - monthly calls: call create (REST + WebSocket start path가 같은 service를 타므로 service에서 enforcement)
   - 우선 soft/report-only:
     - monthly LLM cost. Step 5 cost map으로 표시하되 provider call 차단은 Step 9에서 하지 않는다.

7. **Frontend**
   - `settings.html #billing`을 API-backed로 전환.
   - 실제 결제 provider가 없는 항목은 demo/미연결로 명시하거나 숨긴다.
   - server-returned billing fields는 `textContent` 경로로 렌더.

8. **Docs / tests**
   - `PHASE_7_STEP_9_FINDINGS.md` 작성.
   - `PHASE_7_MASTER.md`, `README.md` 갱신.
   - schema/repository/service/route/frontend 검증.

### 안 한다

- Stripe/Toss SDK 설치.
- Checkout session 생성.
- 결제 카드 저장/변경.
- 결제 provider webhook.
- invoice PDF 다운로드.
- real payment ledger / tax invoice 발행.
- plan 변경 self-serve flow.
- 사용량 backfill worker.
- daily/newsletter 실제 유료 기능 전환.
- `customers.plan` 재도입.

---

## 3. Entitlement Model

### 3.1 Plan keys

```ts
type BillingPlan = "starter" | "pro" | "enterprise";
```

DB:

```sql
ALTER TABLE organizations
  ADD CONSTRAINT organizations_plan_check
  CHECK (plan IN ('starter', 'pro', 'enterprise'));
```

### 3.2 Caps

초기 caps는 "운영 안전장치" 목적이다. 실제 가격표가 아니라 backend enforcement contract다.

| cap key | starter | pro | enterprise | enforcement |
|---|---:|---:|---:|---|
| `seats` | 2 | 10 | unlimited | hard |
| `customers` | 100 | 1000 | unlimited | hard |
| `knowledge_bases` | 3 | 50 | unlimited | hard |
| `knowledge_chunks` | 500 | 10000 | unlimited | hard |
| `monthly_calls` | 100 | 5000 | unlimited | hard |
| `monthly_llm_cost_usd_micros` | 5000000 | 100000000 | unlimited | soft/report-only |

해석:

- seats = active memberships + active pending invitations.
- customers = `customers.deleted_at IS NULL`.
- knowledge bases = `knowledge_bases.deleted_at IS NULL`.
- knowledge chunks = active KB에 속한 chunk rows.
- monthly calls = current UTC calendar month, `calls.deleted_at IS NULL`.
- monthly LLM cost = current UTC calendar month, `llm_usage_log.cost_usd_micros IS NOT NULL`.

Time zone:

- Step 9는 조직 timezone이 없으므로 UTC month를 사용한다.
- `organizations.timezone` 도입 시 billing month window는 별도 migration/plan에서 재정의한다.

---

## 4. Schema Plan

### 4.1 Migration file

신규 migration:

```text
server/migrations/1715000027000_phase7_billing_caps.sql
```

### 4.2 `organizations.plan` hardening

- 값 정규화는 기존 seed/signup이 이미 lowercase라 데이터 rewrite 필요 없음.
- 먼저 invalid row 방지용 sanity query를 migration 주석에 남긴다.
- CHECK constraint 추가.
- `organizations.plan`은 계속 not null.

### 4.3 `organization_billing_profiles`

신규 table:

```sql
CREATE TABLE organization_billing_profiles (
    org_id                uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    billing_status        text NOT NULL DEFAULT 'trialing'
        CHECK (billing_status IN ('trialing', 'active', 'past_due', 'canceled')),
    billing_email         citext,
    tax_id                text,
    current_period_start  timestamptz,
    current_period_end    timestamptz,
    trial_ends_at         timestamptz,
    external_provider     text,
    external_customer_id  text,
    external_subscription_id text,
    metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);
```

정책:

- `external_*`는 미래 provider integration을 위한 nullable metadata다. Step 9에서 채우지 않는다.
- `tax_id`는 민감 정보에 가깝다. audit payload에 값을 넣지 않는다.
- `billing_email`은 PII라 audit payload에 값 대신 `fields`만 남긴다.

### 4.4 RLS / grants

`organization_billing_profiles`는 org-scoped table이다.

- ENABLE + FORCE RLS.
- policies:
  - SELECT: `org_id = current_app_org_id()`
  - INSERT: `org_id = current_app_org_id()`
  - UPDATE: `org_id = current_app_org_id()`
  - DELETE: 만들지 않는다.
- app role grants:
  - SELECT, INSERT, UPDATE only.
  - DELETE 없음.

### 4.5 Backfill

기존 org에 profile row 생성:

```sql
INSERT INTO organization_billing_profiles (org_id, billing_status, billing_email)
SELECT id, 'trialing', NULL
FROM organizations
ON CONFLICT (org_id) DO NOTHING;
```

---

## 5. Backend Implementation Plan

### 5.1 Types

신규:

```text
server/src/types/billing.ts
platform/types/billing.js
```

권장 zod/source-of-truth:

```ts
BillingPlan
BillingStatus
BillingEntitlements
BillingUsage
BillingLimitState
BillingOverviewResponse
BillingProfilePatchInput
```

`test/sync_shared_types.mjs` registry에 등록한다.

### 5.2 Repository

신규:

```text
server/src/repositories/billing.ts
```

함수 후보:

- `getCurrentBillingProfile(client)`
- `upsertCurrentBillingProfile(client, orgId)`
- `patchCurrentBillingProfile(client, patch)`
- `getCurrentBillingUsage(client, now)`

Usage SQL은 모두 current-org context 안에서 실행한다.

주의:

- organizations는 RLS table이 아니므로 `WHERE id = current_app_org_id()` 패턴을 유지한다.
- `billing_email`/`tax_id` 값을 audit payload로 반환하지 않는다.
- count query는 soft-delete 조건을 맞춘다.

### 5.3 Entitlement service

신규:

```text
server/src/services/billing.ts
```

상수:

```ts
export const BILLING_PLAN_LIMITS = {
  starter: { ... },
  pro: { ... },
  enterprise: { ... },
} as const;
```

에러:

```ts
class PlanLimitExceededError extends Error {
  code = "plan_limit_exceeded";
  statusCode = 403;
  limitKey: BillingLimitKey;
  plan: BillingPlan;
  current: number;
  limit: number;
  attempted: number;
}
```

서비스 함수:

- `getBillingOverview(app, actorOrgId, now?)`
- `patchBillingProfile(app, actorOrgId, actorUserId, patch)`
- `assertPlanAllows(appOrClient, orgId/context, limitKey, increment, now?)`
- `buildLimitStates(entitlements, usage)`

`assertPlanAllows`는 같은 transaction 안에서 count하고 write해야 한다. race를 피하기 위해 hard cap이 걸리는 service에서는 다음 중 하나를 택한다.

권장:

- transaction 안에서 current org row를 `SELECT ... FROM organizations WHERE id = current_app_org_id() FOR UPDATE`로 잠근다.
- usage count.
- 초과 검사.
- insert/update.

이 lock은 org 단위 cap enforcement에만 쓰므로 초기 규모에서 충분히 단순하고 안전하다.

### 5.4 Route

신규:

```text
server/src/routes/billing.ts
```

서버 등록:

```text
server/src/server.ts
```

Endpoints:

```http
GET /billing/overview
PATCH /billing/profile
```

Authorization:

- `requireAuth`
- `orgContext`
- `requireRole("admin")`
- `requireFreshRole`

`GET`도 fresh role을 요구한다. billing profile과 usage/caps는 운영 민감 정보고, stale demoted admin이 보지 못하게 한다.

Error mapping:

- zod → 400 `invalid_input`
- stale/demoted role → existing middleware behavior
- plan cap exceeded → 403 `{ code: "plan_limit_exceeded", limit_key, plan, current, limit, attempted }`
- missing current org/profile → 404 `not_found`

### 5.5 Service integration points

Hard cap을 실제 mutation service에 넣는다.

| Surface | File | Cap |
|---|---|---|
| `POST /invitations` | `server/src/services/invitations.ts` | `seats` |
| `POST /invitations/accept` | `server/src/services/invitations.ts` | `seats` |
| `POST /customers` | `server/src/services/customers.ts` | `customers` |
| `POST /knowledge-bases` | `server/src/services/knowledge.ts` | `knowledge_bases` |
| `POST /knowledge-bases/:id/chunks/replace` | `server/src/services/knowledge.ts` | `knowledge_chunks` |
| `POST /calls` + WS start | `server/src/services/calls.ts` | `monthly_calls` |

중요:

- Route handler가 아니라 service layer에서 막는다. REST와 WS가 같은 `createCall`을 타기 때문이다.
- invitation accept는 anonymous route지만 token이 org를 결정한다. membership insert 직전 같은 transaction에서 cap 검사.
- customers/knowledge/calls는 기존 audit insert와 같은 transaction 안에서 cap 검사 → write → audit 순서를 유지한다.
- cap 초과는 audit row를 남기지 않는다. 실패한 시도까지 audit flood로 쌓는 것은 별도 정책이 필요하다.

### 5.6 Activity log

Step 9에서 새 audit action은 최소화한다.

추가 권장:

- `billing.profile_updated`

DB CHECK / repository union / route allow-list 3-way lockstep:

- migration `activity_log_action_check`
- `server/src/repositories/activityLog.ts` `ActivityAction`
- `server/src/routes/activityLog.ts` `ACTIVITY_ACTIONS`

Payload 허용:

```json
{
  "fields": ["billing_email", "tax_id"]
}
```

금지:

- billing email value
- tax id value
- external customer/subscription ids

---

## 6. Frontend Plan

### 6.1 `platform/api.js`

추가:

```js
getBillingOverview()
patchBillingProfile(input)
```

### 6.2 `platform/settings.html`

`#billing` 섹션을 API-backed로 바꾼다.

표시:

- 현재 plan label.
- billing status.
- current period / trial end가 있으면 표시.
- usage/cap bars:
  - seats
  - customers
  - monthly calls
  - knowledge bases
  - knowledge chunks
  - monthly LLM cost (soft)
- billing email / tax id edit form.

숨기거나 demo로 명시:

- 카드 번호 `**** 4242`
- PDF receipt
- "연간 결제 (-20%)"
- "플랜 변경"

권장 UI 정책:

- provider integration이 없으므로 card/receipt 영역은 표시하지 않는다.
- 대신 "결제 provider 미연결 — 현재는 내부 plan/cap 관리만 제공" 문구를 작게 표시한다.
- plan 변경 버튼은 disabled 또는 제거.

XSS:

- server-returned `billing_email`, `tax_id`, plan/status labels는 `textContent`.
- usage/cap 숫자는 `Number()` formatting 후 `textContent`.
- `innerHTML`이 필요하면 label whitelist만 보간한다.

Role:

- Step 6에서 settings nav는 모든 role에게 보인다.
- billing block fetch는 admin만 성공한다.
- non-admin은 billing block에 "관리자만 확인 가능" safe state를 보여주고 403을 콘솔 에러로 방치하지 않는다.

---

## 7. API Contract

### 7.1 GET `/billing/overview`

Response:

```ts
{
  organization: {
    id: string;
    name: string;
    plan: "starter" | "pro" | "enterprise";
  };
  profile: {
    billing_status: "trialing" | "active" | "past_due" | "canceled";
    billing_email: string | null;
    tax_id: string | null;
    current_period_start: string | null;
    current_period_end: string | null;
    trial_ends_at: string | null;
    external_provider_configured: boolean;
  };
  entitlements: {
    seats: number | null;
    customers: number | null;
    knowledge_bases: number | null;
    knowledge_chunks: number | null;
    monthly_calls: number | null;
    monthly_llm_cost_usd_micros: number | null;
  };
  usage: {
    seats: number;
    active_members: number;
    pending_invitations: number;
    customers: number;
    knowledge_bases: number;
    knowledge_chunks: number;
    monthly_calls: number;
    monthly_llm_cost_usd_micros: number | null;
    usage_month: string; // YYYY-MM in UTC
  };
  limits: Array<{
    key: string;
    current: number | null;
    limit: number | null;
    percent: number | null;
    exceeded: boolean;
    enforcement: "hard" | "soft" | "none";
  }>;
}
```

`external_provider_configured`만 노출한다. provider customer id/subscription id는 응답에 싣지 않는다.

### 7.2 PATCH `/billing/profile`

Input:

```ts
{
  billing_email?: string | null;
  tax_id?: string | null;
}
```

Validation:

- `billing_email`: valid email or null.
- `tax_id`: trimmed string max 64 or null. Format validation은 국가별 차이가 있어 Step 9에서 강제하지 않는다.
- empty object → 400.

Response:

```ts
{
  profile: BillingProfile;
}
```

---

## 8. Test Plan

### 8.1 Migration / repository

신규 테스트 후보:

```text
server/test/phase7_step9_billing_repo.test.mjs
```

Scenarios:

1. existing org profiles are backfilled.
2. `organizations.plan` rejects invalid plan.
3. current org can read its billing profile.
4. cross-org profile read returns null/empty under RLS.
5. patch updates only current org profile.
6. DELETE is not granted / no repository delete helper exists.
7. usage counts active members + pending invitations correctly.
8. usage excludes soft-deleted customers/knowledge bases/calls.
9. monthly usage uses UTC month window.
10. LLM cost sums non-null `cost_usd_micros` and returns null/0 policy consistently.

### 8.2 Service / cap enforcement

신규 테스트 후보:

```text
server/test/phase7_step9_billing_caps.test.mjs
```

Scenarios:

1. starter org at seat cap rejects new invitation.
2. invitation accept rejects when another pending/active seat filled the cap after invite creation.
3. pro org below cap can invite.
4. customer create rejects at customer cap.
5. knowledge base create rejects at KB cap.
6. chunk replace rejects when replacement would exceed chunk cap.
7. call create rejects after monthly call cap.
8. enterprise `null` cap never rejects.
9. cap rejection rolls back domain write and audit row.
10. cap rejection response body does not leak cross-org counts.

### 8.3 Route

신규 테스트 후보:

```text
server/test/phase7_step9_billing_routes.test.mjs
```

Scenarios:

1. admin can GET overview.
2. employee/manager/viewer cannot GET overview.
3. stale admin role is rejected.
4. admin can PATCH profile.
5. PATCH invalid email → 400.
6. PATCH empty object → 400.
7. cross-org isolation: Acme admin never sees Beta profile/usage.
8. response does not include `external_customer_id` / `external_subscription_id`.

### 8.4 Frontend smoke

Playwright:

1. admin opens `settings.html#billing`; API values render.
2. admin edits billing email/tax id; reload preserves.
3. employee opens `settings.html#billing`; admin-only state appears without console error.
4. mobile 375x812: usage bars/cards do not overflow.
5. XSS payload in billing email is impossible by email validation; tax_id payload renders as text if saved.

### 8.5 Regression

Required:

```powershell
npm --prefix server run db:migrate:up
npm --prefix server run typecheck
node test/sync_shared_types.mjs
npm --prefix server test
git diff --check
```

If frontend changed:

- admin/employee browser smoke.
- `settings.html#billing` desktop + mobile screenshot/snapshot.

---

## 9. Failure / Edge Cases

| Case | Expected |
|---|---|
| signup creates new org | org plan `starter`; billing profile row exists after migration/backfill path. If signup does not insert profile, GET overview upserts profile in current org transaction. |
| profile row missing | `GET /billing/overview` creates or returns default profile for current org only. |
| invalid plan in DB | migration should fail before adding CHECK. Do not silently map unknown values. |
| starter at seat cap with pending invite | new invite returns 403 `plan_limit_exceeded`. |
| pending invite created below cap, then org reaches cap before accept | accept returns generic 403 with `plan_limit_exceeded`; token remains unaccepted. |
| chunk replace lower than current count | allowed if replacement count <= cap. |
| chunk replace higher than cap | rejected before delete/insert so existing chunks remain. |
| monthly LLM cost unknown rows | unknown/null cost rows do not count toward cost sum; overview can expose `monthly_llm_cost_usd_micros=null` only if all rows are unknown. Prefer numeric sum + separate unknown count if implemented. |
| non-admin settings billing fetch | UI shows permission state; no uncaught console error. |

---

## 10. Implementation Order

Do not skip ahead. This step has schema changes, so follow the repository workflow.

1. **Migration**
   - Add plan CHECK.
   - Add `organization_billing_profiles`.
   - Add RLS/grants/backfill.
   - Add activity action `billing.profile_updated` if mutation audit is included.
   - Run migration.

2. **Repository + service + tests**
   - Add billing repository.
   - Add entitlement service and `PlanLimitExceededError`.
   - Add usage/count queries.
   - Add cap tests before route wiring.

3. **Route + shared types + route tests**
   - Add zod types and JSDoc mirror.
   - Register shared type sync.
   - Add `GET /billing/overview`, `PATCH /billing/profile`.
   - Register route in `server.ts`.
   - Add route tests.

4. **Cap integration**
   - Wire hard caps into invitations/customers/knowledge/calls services.
   - Ensure REST and WS call creation both hit the same service-level guard.
   - Add/extend tests at each boundary.

5. **Frontend**
   - Add `platform/api.js` helpers.
   - Replace `settings.html#billing` static card/table with API-backed state.
   - Handle non-admin 403 cleanly.
   - Mark provider-dependent payment features as not connected or remove them.

6. **Docs / verification**
   - Write `PHASE_7_STEP_9_FINDINGS.md`.
   - Update `PHASE_7_MASTER.md` Step 5+ bundle.
   - Update `README.md` current stage / roadmap.
   - Run full validation.

---

## 11. Handoff Prompt For Implementation Agent

Implement Phase 7 Step 9 from `docs/plan/phase-7/PHASE_7_STEP_9_PLAN.md`.

Constraints:

- Do not integrate Stripe/Toss or any real payment provider.
- Keep `organizations.plan` as the only plan source-of-truth.
- Do not reintroduce `customers.plan`.
- Use schema-first workflow: migration → repo/service tests → routes/shared types/tests → cap integration → frontend.
- Enforce hard caps in service layer, not only route handlers.
- Billing profile values are sensitive enough that audit payload must include changed field names only, not field values.
- All org-scoped DB work must run under `app.withOrgContext`.
- `settings.html#billing` server-returned fields must render via `textContent` or escaped whitelist.

Expected closeout:

- New Step 9 findings document.
- `npm --prefix server run db:migrate:up` PASS.
- `npm --prefix server run typecheck` PASS.
- `node test/sync_shared_types.mjs` PASS.
- targeted Step 9 tests PASS.
- `npm --prefix server test` PASS.
- Playwright smoke for admin + employee settings billing on desktop/mobile.

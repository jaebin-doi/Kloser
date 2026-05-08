# Phase 2 Step 4 — REST routes + role middleware + route 테스트

> **상위 계획**: `docs/plan/phase-2/PHASE_2_MASTER.md` §3 Step 4 + §1 (6 endpoint 표).
> **선행**: Step 3 완료 — `PHASE_2_STEP_3_SHARED_TYPES.md`, `PHASE_2_STEP_3_FINDINGS.md`.
> **기간**: 1.5일.
>
> ⚠️ **invalid query 400 매핑 표·테스트의 `plan` 필드는 Step 5에서 제거됐다.** 본 plan은 도입 시점 (status/plan/assignedUserId 3종 throwable) 기준이고, 최종은 status/assignedUserId 2종이다. Step 5 findings 참조.

---

## 진행 상태

- [ ] 1. ZodError → 400 매핑 패턴 사전 결정 (본 plan §3) 검증
- [ ] 2. 6개 엔드포인트 정의 사전 결정 (본 plan §4) 검증
- [ ] 3. preHandler 조합 사전 결정 (본 plan §5) 검증
- [ ] 4. service 호출 + 에러 매핑 사전 결정 (본 plan §6) 검증
- [ ] 5. response 형식 + JSON serialization 사전 결정 (본 plan §7~§8) 검증
- [ ] 6. 테스트 케이스 (~14 cases) 사전 결정 (본 plan §9) 검증
- [ ] 7. `server/src/routes/customers.ts` 작성
- [ ] 8. `server/src/server.ts`에 `customersRoutes` register 1줄 추가
- [ ] 9. `server/test/customers_routes.test.mjs` 작성 (~14 cases)
- [ ] 10. `npm --prefix server run typecheck` PASS
- [ ] 11. `npm --prefix server test` 신규 합산 PASS (49 + 신규 → 본 plan §12 카운트)
- [ ] 12. `node test/sync_shared_types.mjs` PASS (회귀)
- [ ] 13. `node test/phase_0_5_e2e.mjs` 16/16 회귀 PASS
- [ ] 14. `curl` 수동 검증 — 6개 endpoint 모두 200/4xx 정확
- [ ] 15. viewer JWT로 POST/PATCH/DELETE 호출 → 403 시각 확인
- [ ] 16. `docs/plan/phase-2/PHASE_2_STEP_4_FINDINGS.md` 작성 (구현 + 검증 후 별도 커밋)

---

## 0. 목적

Step 1~3에서 깔린 schema·repository·service·shared types 위에 **HTTP 표면**을 얹는다. Step 5의 client (`platform/customers.html` 실 API 연결) 진입 전에 6개 endpoint가 200/4xx 정확히 응답하는지 + viewer 차단 + multi-org 격리가 단위 테스트로 고정되어야 함.

이 step이 끝나면:
- `routes/customers.ts`가 6개 endpoint 모두 등록
- ZodError + InvalidListOptionError → 400 매핑이 일관 helper로 처리
- viewer write 차단 (`requireRole`) + multi-org 격리 (RLS via `withOrgContext`) 모두 테스트로 검증
- Phase 1 회귀 + Step 2 unit 회귀 모두 zero

Step 5 (`platform/customers.html` 실 API 연결) 진입 가능.

---

## 1. 디렉토리 변화

```text
server/
└── src/
    ├── routes/
    │   ├── auth.ts                  # 변경 없음
    │   ├── me.ts                    # 변경 없음
    │   └── customers.ts             # 🆕 6 endpoint + scoped error handler
    └── server.ts                    # ⬆ customersRoutes register 1줄 추가

server/test/
└── customers_routes.test.mjs        # 🆕 ~14 cases
```

route plugin 패턴: Phase 1 `authRoutes` / `meRoutes`와 동일하게 `async function customersRoutes(app: FastifyInstance) { ... }` + default export. server.ts에서 `await app.register(customersRoutes)` 1줄 추가.

---

## 2. 사전 결정 (요약 표)

| 항목 | 결정 | 근거 |
|---|---|---|
| 1. URL prefix | **`/customers`** (no `/api` prefix) | Phase 1 `/auth`, `/me`와 같은 root-level path. Phase 6+ API versioning 도입 시 일괄 prefix 변경 |
| 2. ZodError → 400 매핑 | **route-scoped `setErrorHandler`** (옵션 B from Step 3 finding §5) | 6 endpoint 공통 처리 일관 + try/catch 6번 복제 회피. 다른 plugin scope (auth) 영향 없음 |
| 3. `InvalidListOptionError` 매핑 | 같은 errorHandler에서 `instanceof` 분기 → `400 { error: "invalid_<field>", value }` | service 방어선이 발동해도 매핑 통일. Step 3 finding §5 권장 형태 |
| 4. preHandler 조합 (read) | `[requireAuth, orgContext]` | viewer도 read 허용 (마스터 §2-2). orgContext가 JWT의 orgId를 `request.orgId`에 박음 |
| 5. preHandler 조합 (write) | `[requireAuth, orgContext, requireRole("admin", "manager", "employee")]` | viewer write 차단 (Phase 1 패턴). 가변 인자 |
| 6. body validation | route 안에서 `CustomerCreateInput.parse(req.body)` / `CustomerPatch.parse(req.body)` | 빈 patch는 `CustomerPatch.refine`이 거부 → 400 |
| 7. query validation (GET /customers) | route는 `req.query`를 **그대로** `listCustomers(app, orgId, req.query)`에 전달. zod parse는 service의 `normalizeListOptions`가 단독 수행. errorHandler가 받는 throw는 `InvalidListOptionError`만 — `ZodError`는 발생 안 함 | **계약 일관성 핵심**: route가 먼저 `CustomerListQuery.parse(...)` 하면 invalid status/plan/assignedUserId가 `ZodError`로 떨어져 `400 invalid_input`이 됨. 그러나 endpoint 표·테스트는 `400 invalid_<field> + value` 계약. service 단일 parse + `InvalidListOptionError`로 wrap하면 한 매핑 경로만 발동하므로 응답 형식 통일됨. 중복 parse 비용도 0 |
| 8. params validation (id UUID) | `z.string().uuid().parse(req.params.id)` 또는 작은 helper | UUID 위반 → ZodError → 400 (잘못된 id 형식). 존재하지 않는 (잘 형식된) UUID → service 결과 null/false → 404 |
| 9. POST 응답 status | **201 Created** + `{ customer: Customer }` (단일 row) | 마스터 §2-11. RESTful 표준 |
| 10. PATCH 응답 status | **200 OK** + `{ customer: Customer }` (갱신 row) | 클라가 추가 GET 없이 캐시 갱신 가능 |
| 11. DELETE 응답 status | **204 No Content** body 없음 | soft delete 성공 — 클라는 list 재조회로 갱신 |
| 12. 404 응답 형식 | `{ error: "not_found" }` | Phase 1 패턴 단순 + Step 3 finding §5 권장 |
| 13. 403 응답 형식 | `{ error: "forbidden" }` (`requireRole` 기본) | Phase 1 `requireRole` 그대로 재사용 — 별도 코드 식별자 안 만듦 |
| 14. JSON serialization (Date → ISO) | fastify 기본 `JSON.stringify(date)` → ISO 8601 (자동) | service `Customer.last_contacted_at: Date` → 응답 JSON `string`. browser JSDoc 사본도 wire format `string` (Step 3 plan §5) |
| 15. list 응답 형식 | `{ items: Customer[], total: number }` (service `CustomerListResult` 그대로) | total로 페이지네이션 metadata. 마스터 §2-3 |
| 16. stats 응답 형식 | `{ total, active, review, pending }` (4 KPI) | 마스터 §2-13. list 응답에 안 끼움 |
| 17. server.ts 등록 위치 | `authPlugin` + `dbPlugin` + `authRoutes` + `meRoutes` 다음에 `customersRoutes` register | Phase 1 순서 그대로. plugin 의존성 (auth, db)이 먼저 |
| 18. test runner | 기존 `tsx --test --test-concurrency=1 test/*.test.mjs`에 자동 흡수 | 파일명 `customers_routes.test.mjs`만 추가, npm script 변경 0 |
| 19. test cleanup | `afterEach`로 본 step에서 INSERT한 customers row hard delete (admin URL via `app.pg.query` 또는 `withOrgContext`+DELETE). seed row UPDATE한 경우 복원 | Step 2 finding §5 패턴 그대로. repository hard delete 함수 추가 금지 |
| 20. test JWT 발급 | Step 2/Phase 1 auth.test.mjs 패턴 — 실제 `/auth/login` 또는 `signAccessToken` 직접 호출 후 Bearer header | 기존 helper 재사용 (`server/test/auth.test.mjs`의 login flow) — 별도 mock JWT 안 만듦 |

---

## 3. ZodError → 400 매핑 (옵션 B 채택)

### Plugin scope `setErrorHandler`

```ts
import { ZodError } from "zod";
import { InvalidListOptionError } from "../services/customers.js";

async function customersRoutes(app: FastifyInstance) {
  // Scoped error handler: applies to every route registered in this
  // plugin. Other plugins (authRoutes, meRoutes) keep their own
  // handlers / default behavior.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: "invalid_input",
        issues: err.flatten(),
      });
    }
    if (err instanceof InvalidListOptionError) {
      return reply.code(400).send({
        error: `invalid_${err.field}`,
        value: err.value,
      });
    }
    // Unknown errors: fastify's default handler (logs + 500).
    reply.send(err);
  });

  // ... route registrations
}
```

### 적용 효과

- 모든 6 endpoint 본문에서 `try/catch` 불필요
- route handler가 `CustomerCreateInput.parse(...)` throw → errorHandler 자동 catch → 400
- service의 `InvalidListOptionError` throw → 같은 처리
- 외 에러 (예상치 못한 throw, DB connection error) → fastify 기본 500

### 옵션 B를 채택한 이유 (Step 3 finding §5에서 옵션 A/B/C 후보)

- 옵션 A (라우트별 try/catch): 6번 복제 — 일관 깨질 위험. 회피
- 옵션 C (helper `parseBody/parseQuery`): 한 줄 더 짧긴 한데 두 종류 helper 필요 (body/query/params 별로). 응답 매핑은 결국 errorHandler 또는 try/catch 필요 — 한쪽으로 쏠려야 깔끔
- 옵션 B (errorHandler): handler 자체가 1곳, 에러 표면화 단일 — 채택

### 회귀 안전망

route-scoped handler는 plugin encapsulation이 보장. 잘못 leak되어 auth routes의 `AuthError` 처리를 망가뜨리지 않음. test에서:
- `customers_routes.test.mjs` 안에서 invalid body POST → 400 응답 확인
- 기존 `auth.test.mjs` 49 cases 모두 무회귀 확인 (Phase 1 sendAuthError 동작 유지)

---

## 4. 6개 엔드포인트 정의

| Method | Path | preHandler | Body | Query / Params | 응답 (성공) | 응답 (실패) |
|---|---|---|---|---|---|---|
| GET | `/customers` | auth + orgCtx | — | (raw passthrough — service parses) | `200 { items: Customer[], total: number }` | `400 invalid_<field>` + `value` (status/plan/assignedUserId; service `InvalidListOptionError`) |
| GET | `/customers/stats` | auth + orgCtx | — | — | `200 CustomerStats` | (4xx 없음 — read-only, no input) |
| GET | `/customers/:id` | auth + orgCtx | — | `:id` UUID | `200 { customer: Customer }` | `400 invalid_input` (id 형식), `404 not_found` |
| POST | `/customers` | auth + orgCtx + requireRole(non-viewer) | `CustomerCreateInput` | — | `201 { customer: Customer }` | `400 invalid_input` (body), `403 forbidden` (viewer) |
| PATCH | `/customers/:id` | auth + orgCtx + requireRole(non-viewer) | `CustomerPatch` | `:id` UUID | `200 { customer: Customer }` | `400 invalid_input` (id/body), `404 not_found`, `403 forbidden` |
| DELETE | `/customers/:id` | auth + orgCtx + requireRole(non-viewer) | — | `:id` UUID | `204 (no body)` | `400 invalid_input` (id), `404 not_found`, `403 forbidden` |

### Handler shape (sketch)

```ts
const UuidParam = z.object({ id: z.string().uuid() });

app.get("/customers", { preHandler: [requireAuth, orgContext] }, async (req, reply) => {
  // No route-level CustomerListQuery.parse here — service.normalizeListOptions
  // is the boundary parser and emits InvalidListOptionError for the three
  // throwable fields. Pre-parsing in the route would surface a ZodError
  // instead and break the `invalid_<field> + value` response contract.
  const result = await listCustomers(app, req.orgId!, req.query);
  return reply.code(200).send(result);
});

app.get("/customers/stats", { preHandler: [requireAuth, orgContext] }, async (req, reply) => {
  const stats = await getCustomerStats(app, req.orgId!);
  return reply.code(200).send(stats);
});

app.get("/customers/:id", { preHandler: [requireAuth, orgContext] }, async (req, reply) => {
  const { id } = UuidParam.parse(req.params);
  const customer = await getCustomerById(app, req.orgId!, id);
  if (!customer) return reply.code(404).send({ error: "not_found" });
  return reply.code(200).send({ customer });
});

app.post("/customers", {
  preHandler: [requireAuth, orgContext, requireRole("admin", "manager", "employee")],
}, async (req, reply) => {
  const input = CustomerCreateInput.parse(req.body);
  const customer = await createCustomer(app, req.orgId!, input);
  return reply.code(201).send({ customer });
});

app.patch("/customers/:id", {
  preHandler: [requireAuth, orgContext, requireRole("admin", "manager", "employee")],
}, async (req, reply) => {
  const { id } = UuidParam.parse(req.params);
  const patch = CustomerPatch.parse(req.body);
  const customer = await updateCustomer(app, req.orgId!, id, patch);
  if (!customer) return reply.code(404).send({ error: "not_found" });
  return reply.code(200).send({ customer });
});

app.delete("/customers/:id", {
  preHandler: [requireAuth, orgContext, requireRole("admin", "manager", "employee")],
}, async (req, reply) => {
  const { id } = UuidParam.parse(req.params);
  const ok = await deleteCustomer(app, req.orgId!, id);
  if (!ok) return reply.code(404).send({ error: "not_found" });
  return reply.code(204).send();
});
```

`req.orgId!` non-null assert — orgContext가 401/400을 먼저 응답하면 handler까지 안 옴. TS narrowing을 위한 안전 assert.

---

## 5. preHandler 조합

| Endpoint | preHandler 순서 | 이유 |
|---|---|---|
| GET (list/stats/byId) | `requireAuth` → `orgContext` | orgContext가 `request.user.orgId` 읽어 `request.orgId` 박음 |
| POST/PATCH/DELETE | `requireAuth` → `orgContext` → `requireRole(...)` | role 검증은 user 확정 후. orgContext 순서는 무관하지만 일관성 위해 같은 위치 |

`requireRole`는 viewer 차단 — 가변 인자로 `("admin", "manager", "employee")` 전달. Phase 3+ team-scope 도입 시 manager/employee를 자기 팀으로 좁힐 때는 service에 분기 추가 (Step 1 plan §4 결정 그대로).

---

## 6. service 호출 + 에러 매핑

### service 계약 그대로

Step 3 refactor 후:
- `listCustomers(app, actorOrgId, rawOpts)` — **rawOpts는 raw `req.query`를 그대로 전달**. service의 `normalizeListOptions`가 단독 boundary parser. route는 zod parse를 하지 않음 (사전 결정 §2-7)
- `getCustomerStats(app, actorOrgId)`
- `getCustomerById(app, actorOrgId, id)` — `id`는 route에서 `UuidParam.parse`로 검증 후 전달
- `createCustomer(app, actorOrgId, input: CustomerCreateInput)` — `input`은 route에서 `CustomerCreateInput.parse(req.body)` 후 전달
- `updateCustomer(app, actorOrgId, id, patch: CustomerPatch)` → null = 404. 두 인자 모두 route zod parse 후
- `deleteCustomer(app, actorOrgId, id)` → false = 404. `id`는 route zod parse 후

### 에러 처리 흐름

```
route handler throw
    ├─ ZodError                  (body/params parse 실패 — route에서 직접 throw)
    ├─ InvalidListOptionError    (list query — service.normalizeListOptions에서 throw)
    └─ 그 외                     (DB error 등)

scoped errorHandler catch
    ├─ ZodError                  → 400 invalid_input + flatten()
    │                              (POST body, PATCH body, :id UUID 위반)
    ├─ InvalidListOptionError    → 400 invalid_<field> + value
    │                              (GET /customers의 status/plan/assignedUserId만)
    └─ 기본 fastify handler       → 500
```

### 안 함

- service 호출 결과 null/false에 대한 별도 catch — `if (!result) return 404` 명시 분기. errorHandler는 절대 발동 안 함
- viewer 403 별도 처리 — `requireRole`가 이미 응답 보냄. handler까지 안 옴
- 401 별도 처리 — `requireAuth`/`orgContext`가 이미 응답. handler까지 안 옴

---

## 7. Response 형식

### Single resource

POST/PATCH/GET-by-id: `{ customer: Customer }` 봉투 형태. 단일 row를 객체로 한 번 더 감싸 — 향후 응답에 metadata (예: `{ customer, warnings: [...] }`) 추가 시 호환.

### List

`{ items: Customer[], total: number }` — service `CustomerListResult` 그대로. `total`은 pagination metadata 용 (filtered 결과의 전체 count, limit/offset 적용 전).

### Stats

`{ total, active, review, pending }` — 4 필드 그대로 (service `CustomerStats`). 봉투 안 씀 (작고 stable).

### Errors

| 상황 | body |
|---|---|
| ZodError | `{ error: "invalid_input", issues: <flatten> }` |
| InvalidListOptionError | `{ error: "invalid_<field>", value: <raw> }` |
| 404 | `{ error: "not_found" }` |
| 403 | `{ error: "forbidden" }` (`requireRole` 기본) |
| 401 | `{ error: <message> }` (`requireAuth` 기본) |
| 500 | fastify 기본 |

---

## 8. JSON Serialization (Date → ISO 8601)

### 자동 변환

`Customer.last_contacted_at: Date | null`, `created_at: Date`, `updated_at: Date` — fastify가 `reply.send({...})` 시 `JSON.stringify`를 사용하고, JS `Date.prototype.toJSON()`이 ISO 8601을 반환 — **자동 ISO 변환**. 별도 transformer 불필요.

### 검증 (테스트에서)

route 응답 body를 parse해서 `created_at`이 string인지 + ISO 형식 (regex `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/`)인지 1 case로 박음. 이걸로:
- Date → string 자동 변환 작동 확인
- browser JSDoc 사본 (wire format `string`)과 정합 확인 (Step 3 plan §5)

---

## 9. 테스트 케이스 (~14 cases)

`server/test/customers_routes.test.mjs` — Phase 1 `auth.test.mjs` 패턴 (Fastify boot + plugins + routes register + `app.inject`). 기존 `auth.test.mjs`의 login helper로 4 user (Acme admin/employee, Beta admin/employee) JWT 발급, viewer 분기는 `requireRole` 차단 검증을 위해 임시 viewer로 demote.

### Setup

```js
before(async () => {
  app = Fastify({ logger: false });
  await app.register(authPlugin);
  await app.register(dbPlugin);
  await app.register(authRoutes);
  await app.register(customersRoutes);
});
```

테스트 fixtures:
- `ACME_ID = "11111111-..."`, `BETA_ID = "22222222-..."`
- seed customer ids: `ACME_KIM = "eeeeeeee-1111-0001-..."`, `BETA_JUNG = "ffffffff-2222-0001-..."`

### Cases

```
1. GET /customers (auth: acme admin) → 200, items.length=12, total=12
   — happy path list, RLS 격리 자동 확인 (Acme JWT만 acme rows)

2. GET /customers (auth: beta admin) → 200, items.length=12 (다른 12명)
   — multi-org 격리 시각

3. GET /customers?status=active (acme admin) → 200, items 모두 status='active'
   — query filter

4. GET /customers?status=bogus → 400, error="invalid_status", value="bogus"
   — invalid enum

5. GET /customers?limit=9999 → 200, items.length<=100 (clamp)
   — silent clamp

6. GET /customers/stats → 200, { total:12, active:7, review:3, pending:2 }
   — Step 2 case 12 동등

7. GET /customers/:acme_kim_id (acme admin) → 200, customer.id matches,
   응답에 created_at/updated_at가 ISO string 형식
   — happy path get + Date→ISO 자동 변환 확인

8. GET /customers/:beta_jung_id (acme admin) → 404 not_found
   — RLS 격리 (다른 org row → null → 404)

9. GET /customers/not-a-uuid → 400 invalid_input
   — params UUID 검증

10. POST /customers (acme admin) with valid body → 201, customer.id 반환,
    이어서 GET /customers list에서 13번째로 보임
    — happy path create + visibility round-trip
    — afterEach에서 hard delete

11. POST /customers with empty body → 400 invalid_input
    — required field name 누락

12. PATCH /customers/:id (acme admin) → 200 customer.name 갱신
    — happy path update
    — afterEach: 원복 또는 hard delete (insert 후 mutation이면 hard delete 한 번에)

13. PATCH /customers/:non_existent_uuid → 404 not_found
    — service의 null 결과

14. PATCH /customers/:id with empty body {} → 400 invalid_input
    — CustomerPatch.refine 동작

15. DELETE /customers/:id (acme admin) → 204, 이후 GET /customers list count -1
    — happy path soft delete
    — afterEach: deleted_at = NULL 복원 또는 hard delete

16. POST /customers with viewer JWT → 403 forbidden
    — viewer write 차단 (preHandler `requireRole` test)
    — **반드시 절차** (token staleness 회피, §11 위험표 viewer 항목 그대로):
      a. UPDATE memberships SET role='viewer' WHERE id=$ACME_EMP_MEMBERSHIP
      b. POST /auth/login (또는 app.signAccessToken)으로 viewer-role 토큰 새로 발급
         — 기존 employee 토큰 재사용 금지 (JWT 안 role이 stale → false negative)
      c. 새 토큰으로 POST /customers → 403 forbidden
      d. afterEach: UPDATE memberships SET role='employee' 복원
    — 같은 새 토큰으로 PATCH/DELETE 1번씩 추가 시도해도 됨 (선택 — case 분리하면 17~18까지 늘어남)

17. (선택) cookie-less GET /customers → 401
    — `requireAuth` 동작 표면 확인 (Phase 1 me.test가 같은 패턴이라 중복일 수 있음 — 1 case로 충분)
```

총 **14~17 cases** (선택 케이스 포함). 본 plan은 14 minimum, 실제 작성 시 round-trip 케이스 분리로 ~16~17 가능.

### Test cleanup 원칙 (Step 2 finding §4 그대로)

- INSERT한 customer row → `afterEach`에서 hard delete (test-only helper, repository에 추가 금지)
- soft-deleted seed row → `deleted_at = NULL` 복원
- viewer demote한 membership → `role = 'employee'` 복원
- 기존 49 cases 무회귀

### 기대 결과

`npm --prefix server test`:
- 이전: 49 (auth 19 + customers_repo 12 + orgContext 3 + rls 7 + ws_auth 8)
- Step 4 후: **63~66** (49 + customers_routes 14~17) PASS

---

## 10. server.ts 등록

```ts
// server/src/server.ts (변경: 1줄 추가)
import customersRoutes from "./routes/customers.js";

await app.register(authPlugin);
await app.register(dbPlugin);

await app.register(authRoutes);
await app.register(meRoutes);
await app.register(customersRoutes);   // ⬅ 추가

app.get("/health", ...);
```

순서: `authPlugin`/`dbPlugin` 먼저 (route handler가 `app.signAccessToken`/`app.withOrgContext`/`app.pg`를 사용). `authRoutes`/`meRoutes` 다음에 `customersRoutes` — 같은 root path 충돌 없음 (auth는 `/auth/*`, me는 `/me`, customers는 `/customers/*`).

---

## 11. 위험·미정

| 항목 | 처리 |
|---|---|
| `setErrorHandler`가 plugin scope에 한정되는지 회귀 검증 | test에서 `auth.test.mjs` 49 cases 무회귀 확인이 직접 검증 — `AuthError`가 customers의 errorHandler에 잡혀 잘못된 응답이 나가면 즉시 fail |
| GET /customers query를 route에서 pre-parse하면 응답 계약 깨짐 | route는 `req.query`를 그대로 전달, service의 `normalizeListOptions`가 단독 boundary parser. invalid status/plan/assignedUserId는 `InvalidListOptionError`로 통일되어 `400 invalid_<field> + value` 형식 보장 (사전 결정 §2-7) |
| Date → ISO 자동 변환이 timezone에 의존 | `Date.toJSON()`은 항상 UTC ISO (Z 표시). server timezone 무관 |
| viewer JWT 발급 절차 (token staleness 회피) | `requireRole`은 DB 재조회 없이 **JWT 안의 `request.user.role`만** 검사. employee 토큰을 먼저 발급한 뒤 DB만 viewer로 demote하면 토큰은 여전히 employee — 403 검증이 false negative. **반드시 다음 순서**: (1) `UPDATE memberships SET role='viewer' WHERE id=$emp_membership` (2) viewer 상태에서 **새 로그인** (`/auth/login`) 또는 `app.signAccessToken({...payload, role:'viewer'})`로 새 토큰 발급 (3) 새 토큰으로 POST/PATCH/DELETE → 403 검증 (4) `afterEach`에서 role 'employee'로 복원. **기존 employee 토큰 재사용 금지** — staleness로 false positive |
| PATCH가 `last_contacted_at` 빈 문자열 받았을 때 | `CustomerPatch` schema의 `LastContactedAt` preprocess가 `""`를 보존 → `z.date().nullable()`이 reject → ZodError → 400. Step 3 plan §4 정책 그대로 |
| empty PATCH body `{}` vs 누락된 body | `req.body === undefined`도 `CustomerPatch.parse(undefined)` 시 ZodError. fastify가 Content-Type 없는 요청은 body를 undefined로 둠 — 둘 다 400으로 매핑 |
| route 등록 순서 | server.ts 한 줄 추가 위치 — 본 plan §10에 명시 |
| `POST /customers` 응답에 `customer.id`가 client에 노출 | 의도. 클라가 즉시 PATCH/DELETE 호출 가능 |
| 다른 org JWT로 PATCH/DELETE 시도 | RLS USING + `WHERE deleted_at IS NULL`이 0 rows로 차단 → service null/false → 404. 403 아닌 404로 통일 (RLS 격리는 응답에서 "존재 자체"를 숨김) |
| `requireRole` order vs requireAuth | `requireAuth`가 먼저 `request.user`를 박지 않으면 `requireRole`이 401 — Phase 1 같음. 본 plan §5 순서 준수 |

---

## 12. 완료 기준 (Step 4 — go/no-go)

- [ ] `server/src/routes/customers.ts` 작성 — 6 endpoint 모두 등록 + scoped `setErrorHandler` (ZodError + InvalidListOptionError → 400)
- [ ] `server/src/server.ts`에 `customersRoutes` register 추가
- [ ] `server/test/customers_routes.test.mjs` 작성 — **최소 14 cases PASS**
- [ ] `npm --prefix server run typecheck` PASS
- [ ] `npm --prefix server test` **63~66 cases PASS** (49 + 14~17). 기존 49 cases 무회귀
- [ ] `node test/sync_shared_types.mjs` PASS (무회귀)
- [ ] `node test/phase_0_5_e2e.mjs` 16/16 회귀 PASS
- [ ] **viewer 차단** — POST/PATCH/DELETE 중 1+ case가 viewer JWT로 403 응답 검증. JWT 발급은 **DB demote → 새 로그인/`signAccessToken`** 순서로 stale 토큰 재사용 금지 (§9 case 16 + §11 viewer 항목)
- [ ] **multi-org 격리** — Acme JWT로 Beta customer GET → 404 검증 (테스트 통과)
- [ ] **Date → ISO 자동 변환** — GET 응답 body의 `created_at`이 ISO string 형식인 1 case 검증
- [ ] **400 매핑 검증** — invalid status/plan/assignedUserId 각 1 case 또는 통합으로 400 응답 검증
- [ ] **PATCH 빈 body 거부** — `CustomerPatch.refine` 동작 1 case
- [ ] `curl` 수동 검증 — 6 endpoint 모두 200/4xx 정확 (login → access token → 6 호출)
- [ ] viewer JWT로 POST/PATCH/DELETE 호출 → 403 시각 확인 (수동)
- [ ] `docs/plan/phase-2/PHASE_2_STEP_4_FINDINGS.md` 작성 (구현 + 검증 후 별도 커밋)

---

## 13. 한 줄 요약

> **1.5일 동안 6개 customer endpoint (`GET list/stats/byId`, `POST`, `PATCH`, `DELETE`)를 작성하고, route-scoped errorHandler로 ZodError + InvalidListOptionError → 400 매핑을 일관 처리해, viewer write 차단·multi-org 격리·Date→ISO 자동 변환을 ~14 route 테스트로 고정한다.**

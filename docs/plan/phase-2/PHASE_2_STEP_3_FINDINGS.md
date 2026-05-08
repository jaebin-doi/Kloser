# Phase 2 Step 3 Findings — Shared types + zod validation

> Audience: Phase 2 Step 4 작성자 (또는 미래의 나).
> Format: each finding has **(1) 관찰**, **(2) Step 4 또는 이후로의 의미**.
>
> ⚠️ **`CustomerPlan` enum + schema/JSDoc 사본의 `plan` 필드는 Step 5에서 제거됐다.** 도입 시점 schema는 본 finding 그대로지만 최종 형태는 Step 5 findings 참조.

## 결론

Step 3 **완료** (2026-05-08). 계획서 (`PHASE_2_STEP_3_SHARED_TYPES.md`) §11 완료 기준 모두 통과:

- `server/package.json`에 `zod ^4.4.3` 추가, `package-lock.json` 갱신
- `server/src/types/customers.ts` 작성 — `CustomerStatus`, `CustomerPlan`, `CustomerSortKey`, `SortDirection`, `Customer`, `CustomerCreateInput`, `CustomerPatchBase`, `CustomerPatch`, `CustomerListQuery`, `CustomerStats` zod schema + `z.infer` types 모두 export
- **sync 검증 대상 4개** (`Customer`, `CustomerCreateInput`, `CustomerListQuery`, `CustomerStats`) 모두 §6 컨벤션 (top-level `export const X = z.object({ ... })` literal) 준수
- `platform/types/customers.js` 작성 — JSDoc-only typedef 사본 (wire format 기준 — timestamp는 `string`)
- `test/sync_shared_types.mjs` 작성 + `ENTITY_REGISTRY`에 customers 등록 (regex 파서, plain `node` 실행)
- `server/src/repositories/customers.ts` ad-hoc TS interface 제거 → `../types/customers.js`에서 type-only import
- `server/src/services/customers.ts` ad-hoc 상수/함수 제거, `normalizeListOptions` 내부를 `CustomerListQuery.safeParse`로 교체. `InvalidListOptionError` + 시그니처 유지
- `npm --prefix server run typecheck` PASS
- `npm --prefix server test` **49/49 PASS** (37 + customers 12, refactor 후 무회귀)
- `node test/sync_shared_types.mjs` PASS — `customers OK (Customer, CustomerCreateInput, CustomerListQuery, CustomerStats)`
- `node test/phase_0_5_e2e.mjs` **16/16 PASS** (split-origin)

Step 4 (REST routes + role middleware + route 테스트) 진입 가능.

---

## 발견 사항

### 1. zod source-of-truth 도입 결과 — Phase 0.5 인계 항목 정리

(1) `zod ^4.4.3` (현재 zod major v4) runtime dep 추가. v4는 `z.string().email()` / `z.string().uuid()` 같은 v3 호환 syntax도 typecheck 통과 — schema 본문은 plan §4 sketch 그대로 작성. `z.preprocess`, `z.union`, `.optional`, `.nullable`, `.default`, `.catch`, `.refine`, `.partial` 모두 v4에서 그대로 동작. zero-runtime-dep 라이브러리라 다른 dep과 충돌 없음.

(2) Phase 0.5 인계 (BACKEND_PLAN §8 Phase 2 / Phase 1 Step 4 §10 deferred) 마지막 항목이 본 step에서 정착됨. Phase 3+ 새 entity는 같은 3-파일 패턴 (server `.ts` + browser `.js` + sync 테스트 entry 1줄)으로 흡수. 본 step의 정착 비용은 1회 — 후속 entity 추가는 mechanical.

### 2. browser JSDoc mirror + sync_shared_types 검증 결과 — drift 회귀 차단 정착

(1) `platform/types/customers.js`는 IIFE/export 없는 JSDoc-only 파일. 브라우저 런타임에 로드되지 않음. wire format 기준으로 작성 — server `Customer.last_contacted_at: Date` ↔ browser `string` (route JSON 직렬화 후 형태). 이 split은 의도된 design.

(2) `test/sync_shared_types.mjs`가 regex로 양쪽 파일을 텍스트 파싱:
- 서버: `^export const <Name> = z.object({` ~ `^});` 사이 `^\s*<field>\s*:` 매칭
- 브라우저: `/** ... @typedef {Object} <Name> ... */` 블록 내 `@property {<type>} [name] | name` 매칭

regex 파서이므로 §6 컨벤션 (top-level z.object literal, `.extend`/`.merge`/`.partial`/`satisfies` 금지) 준수가 필수 — 위반 시 "type not found"로 즉시 fail. drift 없으면 `customers OK (Customer, CustomerCreateInput, CustomerListQuery, CustomerStats)` 한 줄 출력. 운영 가치는 PR 머지 전 차단 — 사람 리뷰가 잊어도 sync 테스트가 잡음.

(3) Step 4 route 작성 시 `CustomerCreateInput` 등 schema에 새 필드 추가 → `platform/types/customers.js`에도 동시 추가 → sync 테스트가 PASS 확인. 한쪽만 갱신하면 fail로 즉시 표면화.

### 3. `normalizeListOptions(non-object)` 회귀 발견 → 수정

(1) Step 3 첫 구현은 `CustomerListQuery.safeParse(raw ?? {})` — zod의 `z.object()`는 non-object input을 reject하므로 raw가 `"x"`, `123`, `[]`, `true`이면 root-level `ZodError`를 throw. **Step 2의 `(raw ?? {}) as Record<string, unknown>`는 비-객체도 `{}`처럼 흘려보내 default options를 반환했음** — refactor가 그 동작을 깨뜨린 회귀.

(2) 리뷰에서 직접 probe로 발견 (`string`/`number`/`array`/`boolean` 모두 `THREW ZodError []`). 수정:
```ts
const input: Record<string, unknown> =
  raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
const result = CustomerListQuery.safeParse(input);
```
`rawValue` 읽기도 `input[field]` 기준으로 단순화. probe 재실행으로 회귀 없음 확인.

(3) 교훈: **layer 책임 이동이 아닌 "구현 교체"여도 boundary 케이스 동작이 바뀔 수 있다.** zod schema의 root validation은 ad-hoc TS cast보다 strict함. 향후 zod 도입 refactor에서 이 패턴이 반복될 수 있으니 **non-object input coercion + default**가 필요한 boundary는 `safeParse` 호출 직전 정규화 필수. 본 step에서 명시 코드로 박혀 있음.

### 4. `CustomerListQuery` 불변조건 검증 결과 — 4개 모두 충족

(1) plan §8의 4개 불변조건:
- `safeParse`는 status, plan, assignedUserId 외 필드로 실패하지 않는다
- q, sort, dir, limit, offset은 어떤 input이 와도 valid 결과로 정규화된다
- status, plan, assignedUserId는 invalid 시 zod가 reject (issues 발생)
- `normalizeListOptions`는 `error.issues[0].path[0]`으로 field 판별 → 그 field만 `InvalidListOptionError`로 wrap. 그 외 path는 ZodError 그대로 re-throw (개발 시 회귀 안전망)

(2) probe 실행 결과로 4개 모두 확인:
```
string  → OK { defaults }      // 비-객체 → {} 정규화
number  → OK { defaults }
array   → OK { defaults }
boolean → OK { defaults }
null    → OK { defaults }
empty obj → OK { defaults }
valid status → OK { status:"active", defaults }
invalid status → THREW InvalidListOptionError invalid status
limit 9999 → clamp 100
limit "abc" → default 20
```
sort/dir/limit/offset/q는 어떤 입력에서도 throw 안 함, status/plan/assignedUserId만 invalid 시 throw → wrap. 불변조건이 schema와 service 양쪽에 박혀 있음.

(3) Step 4 route가 `CustomerListQuery.parse(req.query)`를 직접 호출하는 시나리오에서도 **같은 불변조건 보장**. zod parse 결과는 항상 status/plan/assignedUserId 외 필드는 정규화된 값 — route는 그 셋만 400 매핑 신경쓰면 됨.

### 5. 검증 결과 일괄 — typecheck / 49 unit / sync / 16 e2e PASS

(1) 본 step refactor 직후 회귀 검증 4종 모두 통과:
- `npm --prefix server run typecheck` — Step 2 repo/service의 ad-hoc 타입을 shared types로 교체 후에도 컴파일 오류 0
- `npm --prefix server test` — **49/49 PASS** (auth 19 + customers 12 + orgContext 3 + rls 7 + ws_auth 8). Step 2 customers cases 12개도 service signature/InvalidListOptionError 유지 덕분에 모두 무변경 PASS
- `node test/sync_shared_types.mjs` — `customers OK (Customer, CustomerCreateInput, CustomerListQuery, CustomerStats)` / `PASS`
- `node test/phase_0_5_e2e.mjs` — **16/16 PASS** (split-origin)

(2) Step 4 진입 시점 회귀 baseline은 **49 unit + 16 e2e + sync PASS**. 본 step에서 Step 4 route가 추가될 때 unit 테스트 카운트가 늘어나도 (37+12+신규 ~10) 위 4종은 모두 PASS 유지가 약속.

---

## Step 4 진입 시 가장 먼저 봐야 할 것

Step 4 routes 작성자가 본 step의 결과 위에서 즉시 결정해야 할 사항 5개. 모두 plan §9 (Step 4에 미치는 영향) 또는 본 finding §3·§4의 직접 인계.

### 1. **Fastify는 ZodError를 자동으로 400으로 매핑하지 않는다**

기본 Fastify error handler는 throw된 `ZodError`를 catch해도 default 500으로 응답함. 현재 코드에 ZodError 전용 핸들러 없음. **Step 4에서 다음 중 하나를 반드시 추가**:

- 옵션 A: 라우트별 try/catch — `instanceof ZodError` 시 `reply.code(400).send({ error, details: err.flatten() })`
- 옵션 B: `app.setErrorHandler(...)` 전역 등록 — `ZodError` instance면 400으로 매핑
- 옵션 C: 작은 helper (`parseBody(schema, req)` / `parseQuery(schema, req)`) — parse + 실패 시 400 throw 변환

권장: **옵션 C** — boilerplate 줄이고 라우트별 try/catch 복제 회피. 6개 endpoint 모두 같은 helper 통과. Step 4 plan에서 옵션 확정.

### 2. **service는 아직 raw query를 받아 zod parse를 한 번 더 한다**

`listCustomers(app, actorOrgId, rawOpts: unknown)` 시그니처 그대로 — 내부에서 `CustomerListQuery.safeParse`. 따라서 Step 4 route가 `CustomerListQuery.parse(req.query)`를 먼저 해도 service에서 한 번 더 parse됨.

- **중복 parse 비용은 ms 미만 (object literal parse) — 무시 가능**
- service 방어선이 의도. route → service 직접 호출 외 경로 (테스트 등)에서도 안전
- Step 4 route가 zod parse를 일찍 해서 400 매핑을 boundary에서 처리하면 service의 `InvalidListOptionError` throw는 사실상 발동 안 함. 그래도 service 방어선은 유지 (deletion은 Step 4 plan에서 별도 검토)

### 3. **viewer write 차단은 Step 4 route preHandler 책임**

Step 2 service는 role-blind. Step 1 plan §2-2 / Step 2 plan §8의 결정 그대로 — `customers_select` 정책은 viewer도 통과 (org-wide read), POST/PATCH/DELETE는 application layer에서 차단. Phase 1 `requireRole(...)` 미들웨어 (`server/src/middleware/role.ts`)를 그대로 재사용:

```ts
app.post("/customers", {
  preHandler: [requireAuth, orgContext, requireRole("admin", "manager", "employee")],
}, ...);
```

가변 인자 패턴. viewer는 자동 403 응답 (`{ error: "forbidden" }`).

### 4. **POST/PATCH body validation은 `CustomerCreateInput` / `CustomerPatch`**

- POST `/customers` body → `CustomerCreateInput.parse(req.body)`. 빈 body / 필수 필드 누락 → ZodError → 400
- PATCH `/customers/:id` body → `CustomerPatch.parse(req.body)`. 빈 patch (`Object.keys.length === 0`) → `.refine` 거부 → 400
- 두 schema 모두 `last_contacted_at`은 ISO string OR Date OR null만 허용 — 빈 문자열·숫자는 reject (Step 3 plan §4 `LastContactedAt` preprocess)
- email/UUID 등 format도 schema가 검증 — 추가 if 분기 불필요

### 5. **list query의 invalid status/plan/assignedUserId만 400 매핑 필요**

`GET /customers?...` query parsing 정책:

- `q`, `sort`, `dir`, `limit`, `offset` — 어떤 값이 와도 정규화 (silent fallback) → 400 발생 안 함
- `status`, `plan`, `assignedUserId` — invalid 시 throw → **400으로 매핑 필요**
- service 호출 시 `InvalidListOptionError` 또는 `ZodError` 둘 중 하나 catch — 둘 다 400으로 매핑

권장 매핑 형태:
```ts
catch (err) {
  if (err instanceof InvalidListOptionError) {
    return reply.code(400).send({
      error: `invalid_${err.field}`,
      value: err.value,
    });
  }
  throw err;  // 다른 에러는 default 500
}
```
또는 옵션 C helper에 흡수.

---

## 의도하지 않게 남긴 것 / 후속 작업

- **service의 raw input zod re-parse 제거 vs 유지** — Step 4 route가 boundary parse를 안정적으로 도입한 후 (route 테스트로 보장 검증) 시점에 service의 `normalizeListOptions`를 typed 시그니처로 옮길지 결정. 본 step에서는 Step 4 도착 전 boundary 부재 회피로 유지.
- **`zod 4.x → 5.x` major bump 대응** — caret range로 lock된 상태. 4.x → 5.x 전환은 phase 종료 시점에 일괄 검토. `z.preprocess` API 변화 가능.
- **`CustomerPatchBase` 외부 사용 시 refine 우회 위험** — `*Base` naming + 본 finding 명시로 신호. Step 4 route는 항상 `CustomerPatch` 사용. 잘못된 import는 PR 리뷰 검출.
- **sync 테스트 컨벤션 위반 시 명확한 에러** — 현재는 "type not found"로 fail. Phase 3+ entity 추가 시 컨벤션 (`top-level z.object literal`, `.extend`/`.merge`/`.partial`/`satisfies` 금지) 위반 메시지를 더 풍부하게 만드는 것은 후속 작업. 현재 메시지로도 회귀 차단은 충분.
- **`Customer` zod schema의 `last_contacted_at: z.date()` 와 wire JSON serialization** — service 내부는 Date, route 응답은 ISO string. fastify의 `JSON.stringify(date)` → ISO string 자동 변환에 의존. 명시적 transformer는 없음. Phase 4+ 응답 schema validation 도입 시 이 변환을 schema에서 표현 (예: `z.date().transform(d => d.toISOString())`).
- **JSDoc 사본의 default/refine 표기 누락** — JSDoc은 `.default(20)` / `.refine(...)` 표현이 어려워 sync는 field name만 비교. 운영 페이지가 default 동작을 잘못 가정하지 않도록 fetch 호출부에서 응답 처리 시 주의 — Step 5 (customers.html 실 API 연결) 작성 시 검토.
- **Phase 3+ 새 entity의 `ENTITY_REGISTRY` 추가 누락 회귀** — 새 entity 만들 때 `test/sync_shared_types.mjs` `ENTITY_REGISTRY` 배열에 1줄 추가가 필수. 잊으면 sync 테스트는 PASS지만 새 entity는 검증 자체가 안 됨. PR template 또는 entity 추가 가이드 작성 (Phase 6+ infra).

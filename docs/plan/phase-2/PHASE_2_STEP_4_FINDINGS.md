# Phase 2 Step 4 Findings — REST routes + role middleware + route 테스트

> Audience: Phase 2 Step 5 작성자 (또는 미래의 나).
> Format: each finding has **(1) 관찰**, **(2) Step 5 또는 이후로의 의미**.
>
> ⚠️ **invalid query throwable 필드는 Step 5에서 status/assignedUserId 2종으로 축소됐다** (`plan` 컬럼 제거 동반). 본 finding의 `invalid_plan + value` 사례는 도입 시점 기준. 최종은 Step 5 findings 참조.

## 결론

Step 4 **완료** (2026-05-08). 계획서 (`PHASE_2_STEP_4_ROUTES.md`) §12 완료 기준 모두 통과:

- `server/src/routes/customers.ts` 작성 — 6 endpoint (`GET list/stats/byId`, `POST`, `PATCH`, `DELETE`) + plugin-scoped `setErrorHandler`
- `server/src/server.ts`에 `customersRoutes` import + register 1줄씩 추가
- `server/test/customers_routes.test.mjs` 작성 — **16 cases PASS**
- `npm --prefix server run typecheck` PASS
- `npm --prefix server test` **65/65 PASS** (49 + customers_routes 16). Phase 1 + Step 2 회귀 zero
- `node test/sync_shared_types.mjs` PASS (회귀 무회귀)
- `node test/phase_0_5_e2e.mjs` **16/16 PASS** (split-origin)
- viewer 차단 — `requireRole`로 viewer JWT가 POST `/customers` → `403 forbidden` (테스트 통과)
- multi-org 격리 — Acme JWT로 Beta `:id` GET → `404 not_found` (RLS USING 0 rows → service null → 404, 테스트 통과)
- Date → ISO 자동 변환 — GET 응답 `created_at`/`updated_at`이 `^\d{4}-\d{2}-\d{2}T...` 매치
- 400 매핑 — `status=bogus`/`plan=Trial`/`assignedUserId=not-a-uuid` 모두 `400 invalid_<field> + value` (table-driven 1 case)
- PATCH 빈 body `{}` → `400 invalid_input` (`CustomerPatch.refine` 동작)

Step 5 (`platform/customers.html` 실 API 연결) 진입 가능.

---

## 발견 사항

### 1. zod 4.x `.uuid()`는 RFC 4122 strict — seed deterministic UUID와 충돌

(1) Step 4 첫 구현은 `UuidParam = z.object({ id: z.string().uuid() })` + types module의 `z.string().uuid()`. 그런데 GET `/customers/:id` (`eeeeeeee-1111-0001-0001-eeeeeeeeeeee`) 등 **모든 `:id` 요청이 400** 반환. 원인: zod 4.x의 `.uuid()`는 RFC 4122 version/variant 비트를 enforce. seed UUID는 deterministic 패턴 (`eeeeeeee-1111-0001-...`)이라 version=0/variant=0 — RFC 위반 → reject.

(2) 해결: Phase 1 `services/auth.ts`의 `UUID_RE` (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`)와 정합. 본 step에서:
- `server/src/types/customers.ts`: `UuidString = z.string().regex(UUID_RE, "invalid uuid")` 정의 후 `Customer.id`/`org_id`/`assigned_user_id`, `CustomerCreateInput.assigned_user_id`, `AssignedUserId` preprocess의 inner schema 모두 `UuidString`으로 교체
- `server/src/routes/customers.ts`: `UuidParam`도 같은 regex 패턴

zod 4.x → 5.x 또는 다른 entity 추가 시 같은 함정 — **`.uuid()` 직접 사용 금지, `UuidString` 재사용**. Phase 3+ 진짜 RFC UUID로 seed를 갈아엎는 결정 (마이그레이션 + 테스트 fixture 갱신)을 내릴 수도 있지만 본 phase 범위 밖.

(3) 운영적으로 이 regex는 더 permissive (어떤 32 hex with 8-4-4-4-12 dashes도 허용). 클라가 RFC 위반 UUID를 보내도 통과 — 단, DB의 `uuid` 컬럼 자체는 PG가 cast 단계에서 hex 형식만 검증 (RFC 비트 검사 없음)이므로 application 레이어와 DB 레이어가 동일 정책.

### 2. query parsing 경로 — service가 단일 boundary parser

(1) Step 4 plan §2-7에서 결정한 대로 GET `/customers`의 `req.query`는 **route에서 zod parse 안 함**. service의 `normalizeListOptions`가 단독 boundary parser. 이유: route가 먼저 `CustomerListQuery.parse(req.query)`를 하면 invalid status/plan/assignedUserId가 `ZodError`로 떨어져 응답이 `400 invalid_input + flatten()`이 됨. 그러나 endpoint 표·테스트 계약은 `400 invalid_<field> + value` — InvalidListOptionError 매핑 형태. 두 매핑 경로가 충돌하면 응답이 일관되지 않음.

(2) 결과적으로 routes/customers.ts의 GET handler는:
```ts
const result = await listCustomers(app, req.orgId!, req.query);   // raw passthrough
```
한 줄. service의 `normalizeListOptions(raw)`가 항상 호출되어 `InvalidListOptionError(field, value)` throw → plugin-scoped `setErrorHandler`가 `400 invalid_<field> + value`로 매핑. body/`:id` UUID는 route에서 직접 zod parse — `ZodError → 400 invalid_input + flatten()`. **두 매핑 경로가 서로 다른 endpoint에 한정**되어 계약이 일관됨.

(3) Step 5 (`customers.html`) 클라이언트가 query string 만들 때:
- invalid status/plan 보내면 `{ error: "invalid_<field>", value }` 형태 응답 — UI는 `error` field 기반 분기
- invalid body 보내면 (POST/PATCH) `{ error: "invalid_input", issues: <flatten> }` 형태 — UI는 `issues` 기반 field-level 메시지 가능
- 두 형식 분기를 client에 인지시키는 helper (Step 5 진입 시 `kloserApi.apiPost` 응답 핸들링 검토)

### 3. viewer JWT 발급은 DB demote → 새 로그인 순서 강제 (token staleness)

(1) plan §11 viewer 항목 명시 — `requireRole`은 DB 재조회 없이 JWT 안 `request.user.role`만 검사. 본 step의 viewer 차단 테스트는 절차를 정확히 지킴:
```js
await app.withOrgContext(ACME_ID, async (client) => {
  await client.query("UPDATE memberships SET role='viewer' WHERE id=$1", [ACME_EMP_MEMBERSHIP]);
});
const viewerToken = await loginToken("emp@acme.test", "acme-emp-1234");   // 새 로그인 → role=viewer
const r = await authedInject(viewerToken, { method: "POST", url: "/customers", ... });
assert.equal(r.statusCode, 403);
// afterEach가 role='employee' 복원
```
**기존 employee 토큰 재사용 안 함** — JWT 안 role이 stale인 상태로 POST하면 `requireRole`이 employee로 보고 통과시켜 201 반환 — viewer 차단 테스트가 실패.

(2) 본 패턴은 Phase 1의 access token TTL (default 15분) 내에서 role staleness가 어떻게 동작하는지 직접 보여줌:
- Phase 1 finding §6의 `requireFreshRole` opt-in helper 도입은 본 phase에서도 deferred (Phase 2 master plan §7-2 결정). DELETE customer는 soft-delete + 즉시 복구 가능이라 staleness 위험 미미
- Phase 3 (회원가입/팀 초대/role 변경 잦아짐) 시점에 본격 도입 검토 — DELETE/critical write에서 fresh role check

### 4. Test cleanup 범위 — 옵트인 추적으로 전역 mutation 회피

(1) afterEach 첫 구현은 `UPDATE customers SET deleted_at = NULL WHERE deleted_at IS NOT NULL` — 모든 soft-deleted row를 무차별 복원. 이건 테스트가 건드리지 않은 row (예: 다른 테스트가 의도적으로 soft-delete 해둔 fixture, 또는 운영 시드의 의도적 deleted row)까지 살릴 수 있어 **부작용 누적의 잠재 원인**.

(2) 수정: `softDeletedSeedIdsByOrg = Map<orgId, Set<id>>` 자료구조 도입. 테스트가 seed row를 soft-delete하면 해당 id를 push. afterEach가 이 Set의 id에만 `UPDATE deleted_at = NULL` 실행. 현재 본 step 테스트는 `routetest-` 접두사 row만 INSERT 후 hard delete로 마무리 — Set push 경로는 미사용 (no-op). Phase 3+ 새 테스트 케이스에서 seed row를 직접 soft-delete할 때 명시적으로 Set push하면 자연스럽게 cleanup 흡수.

(3) 일반화: **테스트 cleanup의 표준은 "테스트가 만든 변화만 unwind"**. 무차별 SELECT/UPDATE/DELETE는 테스트 격리를 깨고 후속 디버깅을 어렵게 만듦. 특히 RLS 환경에서는 `withOrgContext` + 한정 WHERE로 깔끔하게 처리 가능. Phase 4+ 새 테스트 작성 시 같은 옵트인 패턴 follow.

### 5. plugin-scoped `setErrorHandler` — auth routes 영향 zero

(1) `customersRoutes` plugin 안에서 `app.setErrorHandler(...)` 등록. fastify의 plugin encapsulation 덕분에 이 핸들러는 `customersRoutes` 안에서 등록된 6 endpoint에만 적용. `authRoutes`/`meRoutes`는 자체 error 처리 (`sendAuthError`, default fastify handler) 그대로 유지.

(2) 검증: 기존 `auth.test.mjs` 19 cases + `me`/`orgContext`/`rls` 테스트 모두 무회귀 PASS — 만약 errorHandler가 leak되어 `AuthError`가 잘못 catch되었다면 즉시 fail했을 것. 65/65 PASS가 직접 회귀 안전망.

(3) Step 5 client가 `/auth/login` 호출 시 응답 형식 (`{ error, code }`)과 `/customers/*` 응답 형식 (`{ error, issues | value }`)이 다름 — 클라이언트 응답 처리는 endpoint group별로 분기. Phase 6+ API 표준화 시점에 통합 검토.

### 6. Date → ISO 8601 자동 변환은 fastify 기본 `JSON.stringify` 동작

(1) `Customer.last_contacted_at`, `created_at`, `updated_at`은 service 내부에서 JS `Date`. `reply.send({...})`가 `JSON.stringify`를 호출하고, JS `Date.prototype.toJSON()`이 ISO 8601 (UTC, `Z` suffix)을 반환 — **별도 transformer 불필요**. server timezone 무관.

(2) 검증: GET `/customers/:id` 응답 body의 `created_at`이 `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}` 매치 1 case. 본 step에서 직접 확인.

(3) Step 5 client (`platform/customers.html`)는 응답을 `Date` 객체로 다시 parse하지 않고 string 그대로 표시 (relative-time formatting은 Phase 4+ live 통화 결합 시점에 통합 검토). browser JSDoc 사본 (`platform/types/customers.js`)도 wire format `string`으로 표기 — Step 3 plan §5 그대로.

### 7. RLS isolation을 application layer에서 확인 — 404 통일

(1) Acme JWT로 Beta customer `:id` GET → `404 not_found`. RLS USING이 SELECT를 0 rows로 차단 → service `getByIdInCurrentOrg(client, id)` null 반환 → route가 404로 매핑. **403 (forbidden)이 아닌 404로 통일** — RLS 격리는 응답에서 "다른 org에 존재한다"는 사실 자체를 숨김.

(2) PATCH/DELETE도 동일 — RLS USING이 UPDATE 0 rows로 차단 → service null/false → 404. 클라이언트는 "내 org에 그 id가 없다"로만 인식. enumeration 공격 (다른 org id 추측) 방지에도 유효.

(3) 본 step에서 GET 1 case로 검증 (case 8). PATCH/DELETE의 cross-org 시나리오는 Step 2 unit 테스트 (case 5/6)에서 service 레벨로 검증되었으므로 route 레벨에서는 GET 1 case로 충분 — 같은 메커니즘.

---

## Step 5 진입 시 가장 먼저 봐야 할 것

Step 5 client (`platform/customers.html` 실 API 연결) 작성자가 본 step의 결과 위에서 즉시 봐야 할 사항.

### 1. **응답 error shape 두 종류 분기**

```
/customers (query invalid):  { error: "invalid_<field>", value: "<raw>" }
/customers (body/params):    { error: "invalid_input", issues: <flatten> }
404:                         { error: "not_found" }
403:                         { error: "forbidden" }
401 (auth):                  { error: "<msg>" }
```
client가 `apiGet/apiPost/apiPatch` wrapper 안에서 분기. UI 메시지는 두 형식 모두 처리.

### 2. **Date 컬럼은 ISO string — 별도 parse 안 해도 표시 가능**

`customer.last_contacted_at`이 `"2026-05-08T14:23:11.123Z"` 형태. `new Date(s)`로 parse 가능, 또는 그대로 string 표시. mock UI의 "2시간 전" 같은 relative time formatting은 client 자체 helper (Step 5에서 작성).

### 3. **UUID seed regex permissive — RFC 4122 위반 UUID도 통과**

POST/PATCH/DELETE의 `:id`, body의 `assigned_user_id`는 `UUID_RE` (8-4-4-4-12 hex with dashes)로 검증. RFC 4122 strict가 아니므로 deterministic seed UUID도 통과. Phase 3+ 진짜 random UUID 도입 시점에 패턴 좁히는 것은 별도 결정.

### 4. **GET /customers 응답은 `{ items, total }` 봉투 — 페이지네이션 metadata 자동**

Step 5 무한 스크롤·페이지 갈음 UI는 `total`로 마지막 페이지 판정. limit clamp 100 — UI는 limit 직접 noticed 안 해도 됨.

### 5. **POST /customers는 201 + `{ customer }`** — 클라가 즉시 row 캐시

새 row 전체가 응답에 들어옴. UI는 추가 GET 없이 list state에 prepend/append. 4 KPI는 별도 `/customers/stats` 호출로 갱신 (마스터 §2-13 분리 결정).

### 6. **Step 5 결정점 — Date ISO formatting 위치**

서버는 ISO string만 보냄. client에서 "2시간 전" 표시는:
- 옵션 A: Step 5에서 `customers.html` 안에 inline helper (간단)
- 옵션 B: `platform/_shared.js` 등에 공유 helper로 분리 (Phase 3+ 다른 entity도 같은 helper 사용)

Phase 4+ live 통화·transcript 시간 표시도 같은 함수가 필요할 가능성 높음 → 옵션 B 권장. Step 5 plan에서 결정.

---

## 의도하지 않게 남긴 것 / 후속 작업

- **`requireFreshRole` opt-in 도입 시점** — Phase 1 finding §6 / Phase 2 master plan §7-2의 deferred 항목. Phase 3 (role 변경 잦아짐) 시점에 DELETE/critical write 한정 도입 검토. 본 step의 viewer 테스트가 절차의 안전성을 직접 보여줌
- **Step 5의 client error shape 분기 helper** — 본 finding §1. 두 응답 형식이 병존하므로 wrapper 필요
- **Phase 6+ error code 표준화** — `invalid_input`/`invalid_<field>`/`not_found`/`forbidden`/`<msg>` 5종이 endpoint group별로 다름. 통일된 error code catalog (`AUTH_INVALID_CREDENTIALS` 등) 도입은 Phase 6+ API 안정화 시점
- **POST/PATCH 응답에 `warnings` metadata 추가** — Step 1 plan §2-9 (email/phone 중복 검출 warning) 후크는 Phase 4+. 본 step 응답은 `{ customer }`만 — 봉투 형태가 미래 필드 추가 호환
- **`activity_log` audit hook** — Phase 2 master plan §1 / Step 2 finding §6 그대로 본 phase에서 안 함. POST/PATCH/DELETE 시점에 service 레이어 hook 추가는 Phase 4+
- **Cookie-less 401 path 직접 검증 case 추가 검토** — 본 step에서 `requireAuth`/`requireRole`의 401 path는 Phase 1 `auth.test.mjs`/`me.test.mjs`가 이미 광범위하게 cover. 본 step은 viewer 403만 추가. Step 5 e2e에서 통합 시나리오로 한 번 더 확인

# Phase 2 Step 2 Findings — Customers repository + service + RLS isolation tests

> Audience: Phase 2 Step 3 작성자 (또는 미래의 나).
> Format: each finding has **(1) 관찰**, **(2) Step 3 또는 이후로의 의미**.

## 결론

Step 2 **완료** (2026-05-08). 계획서 (`PHASE_2_STEP_2_REPO.md`) §10 완료 기준 모두 통과:

- `server/src/repositories/customers.ts` — 7 함수 (`listForCurrentOrg`, `countForCurrentOrg`, `statsForCurrentOrg`, `getByIdInCurrentOrg`, `insertInCurrentOrg`, `updateByIdInCurrentOrg`, `softDeleteByIdInCurrentOrg`), 모두 `client: PoolClient` 첫 인자, `WHERE deleted_at IS NULL` 강제
- `server/src/services/customers.ts` — 6 함수 (`listCustomers`, `getCustomerStats`, `getCustomerById`, `createCustomer`, `updateCustomer`, `deleteCustomer`), 모두 `withOrgContext` 경유, role-blind, `normalizeListOptions` + `InvalidListOptionError`
- `server/test/customers_repo.test.mjs` — **12/12 PASS** (RLS 6 + CRUD 6)
- `npm --prefix server run typecheck` PASS
- `npm --prefix server test` **49/49 PASS** (37 + 12)
- `node test/phase_0_5_e2e.mjs` **16/16 PASS** (split-origin)
- 격리 case 4 (orgId 인자 변조 INSERT → SQLSTATE `42501`) ✓
- 격리 case 5/6 (cross-org UPDATE/soft-delete → null/false) ✓
- CRUD case 8 (PATCH 후 `updated_at > created_at` trigger 동작) ✓
- CRUD case 9/10 (soft-delete invisible + idempotency false) ✓
- mutation cleanup: 모든 case가 `try/finally`로 자체 unwind, INSERT row는 테스트 전용 hard DELETE helper(repo 외부)로 제거. 누적 mutation 0

Step 3 (Shared Types + zod) 진입 가능.

---

## 발견 사항

### 1. 같은 transaction 안에서는 `now()`가 고정 — trigger 검증은 별도 `withOrgContext`가 강제됨

(1) Postgres `now()` = `transaction_timestamp()`. 한 transaction 안의 모든 query가 같은 값을 본다. test case 8이 `created_at != updated_at`을 검증해야 하는데, 만약 같은 `withOrgContext` 안에서 INSERT 후 UPDATE를 묶으면 `customers_touch_updated_at` trigger가 fire해도 `NEW.updated_at = now()`가 INSERT 시점 `created_at`과 동일 — assertion이 **vacuous하게 통과**. 의미 있는 trigger 검증이 안 됨.

(2) 따라서 case 8의 INSERT와 UPDATE는 **반드시 두 개의 별도 `withOrgContext` 호출**로 분리. 코드와 테스트 코멘트에 이유 명시. Step 4 route 테스트에서 동일 시나리오 (POST → PATCH → updated_at 검증)를 다시 작성할 때도 같은 패턴 유지 필요. 일반화하면: **시간 진행을 검증하는 테스트는 transaction을 넘겨야 한다**.

### 2. `updateByIdInCurrentOrg`의 빈 patch fallback — 문법 오류 + trigger 헛 fire 동시에 회피

(1) `Partial<CustomerCreateInput>` 모든 키가 `undefined`인 경우 `sets.length === 0`. 그대로 SQL을 만들면 `UPDATE customers SET WHERE id = $1` — Postgres syntax error. 또한 의미 없는 UPDATE는 `touch_updated_at` trigger를 트리거하므로 `updated_at`만 갱신되는 부작용. 두 문제를 한 번에 막기 위해 **`getByIdInCurrentOrg(client, id)`로 fallback**. service 시그니처 (`Customer | null`)와 자연 일치.

(2) Step 4 `PATCH /customers/:id` route는 빈 body 또는 모든 필드 누락된 body가 들어왔을 때:
- 옵션 A: route 레이어에서 zod schema가 "최소 1개 필드 필수"로 거부 → 400
- 옵션 B: service까지 흘려보내고 fallback path 발동 → 200 + 변경 없는 row

Step 3에서 zod schema 작성 시 결정. 권장은 **A** — silent no-op은 운영 디버깅을 어렵게. 다만 fallback path 자체는 race(누가 먼저 PATCH가 빈 patch로 도달) 안전장치 역할도 하니 service 레벨에서는 유지.

### 3. `assignedUserId` 필터의 null/UUID dual mode — `IS NULL` vs `= $N`

(1) `CustomerListFilters.assignedUserId`는 의도된 **세 가지 상태** 표현:
- `undefined`  → 필터 자체 없음 (모든 row)
- `null`       → "unassigned 명시 필터" (`assigned_user_id IS NULL`)
- `string`     → 특정 사용자에 배정된 row만 (`assigned_user_id = $N`)

repository는 `null`이면 `IS NULL` 절을, 문자열이면 parameterized `= $N`을 emit. service `pickAssignedUserId`는 query string의 `null` 문자열과 빈 문자열도 정규화 (`null`/`""` → undefined/null로 매핑).

(2) Step 3 zod schema 작성 시 이 세 상태를 전부 표현해야 함. 권장 형태:
```ts
assignedUserId: z.union([z.string().uuid(), z.literal("null"), z.literal("")]).optional()
```
service의 정규화 로직은 그대로 유지하되 zod가 1차 차단. Phase 3 team-scope 도입 시 `assignedTeamId` 도입도 같은 dual mode로.

### 4. 테스트 전용 hard DELETE helper — repository에 절대 추가하지 않음

(1) plan §10 명시 사항대로 `customers_repo.test.mjs`의 `hardDelete(orgId, id)`는 **테스트 파일 안에만** 정의 (`server/test/customers_repo.test.mjs:62`). repository에 `hardDeleteByIdInCurrentOrg` 함수 추가하지 않음. 이유: 운영 코드 경로에 hard-delete가 노출되면 RLS DELETE 정책이 일상 mutation에서 발동, soft-delete 의미가 약해짐.

(2) Phase 4+에서 GDPR/admin console로 진짜 hard-delete가 필요해지는 시점이 오면 그 step의 plan에서:
- 별도 함수 (`hardDeleteByIdInCurrentOrg`) repository에 추가 + 명시적 권한 분기 (admin role + audit log)
- 또는 admin URL 전용 SQL helper로 분리

테스트 helper와 운영 함수를 한 이름으로 합치지 말 것 (의도가 섞임). 본 step의 helper는 mutation cleanup 전용 — 절대 export하지 않음.

### 5. `restoreSoftDeleted` helper는 작성만 하고 사용 안 함 — 의도된 보존

(1) test file에 `restoreSoftDeleted(orgId, id)` 정의 후 `void restoreSoftDeleted` 처리. 12 cases 모두 fresh insert + hard delete 패턴이라 사용 경로가 없음. seed row를 직접 mutate하는 미래 case (예: case 11/12 변형) 작성 시 즉시 사용할 수 있게 남김.

(2) Step 3 zod schema 검증 테스트나 Step 4 route 테스트에서 seed row를 변형 후 복원해야 할 때 — 이 helper는 `customers_repo.test.mjs` 내부에 정의되어 있고 export되지 않으므로 import 대상이 아님. 같은 패턴이 필요하면 **각 테스트 파일에 복사**하거나, 두 곳 이상에서 쓰이게 되는 시점에 `server/test/helpers/customers_cleanup.mjs` 같은 별도 test helper module로 추출. 본 step 시점에 미리 module을 만들지는 않음 (사용처 1곳 = YAGNI). unused-symbol lint 경고가 잡히면 명시적 `void` 처리 패턴 그대로.

### 6. service의 `InvalidListOptionError` — Step 4 route에서 catch 매핑 필요

(1) 잘못된 `status`/`plan`/`assignedUserId` 값은 service에서 **throw**. `sort`/`dir`/`limit`/`offset`은 silent fallback (plan §6 invalid input 정책 표 그대로). Error class가 `field`/`value` 두 public 속성을 노출하므로 route는 400 응답 body에 `{ error: "invalid_<field>", value: ... }` 형태로 매핑 가능.

(2) Step 4 route 작성 시:
```ts
try {
  const result = await listCustomers(app, actorOrgId, request.query);
  return result;
} catch (err) {
  if (err instanceof InvalidListOptionError) {
    return reply.code(400).send({ error: `invalid_${err.field}`, value: err.value });
  }
  throw err;
}
```
Step 3 zod 도입 후에는 zod parse error가 1차 거름망이지만, service의 `InvalidListOptionError`는 zod를 우회한 호출 (예: 단위 테스트 직접 호출, 또는 비-route 호출자)에 대한 마지막 방어선으로 유지.

### 7. `q='kloser'` 매치는 OR 3-필드 vs 결과 1행 — SQL row-level OR

(1) test case 11: `lower(name) LIKE $1 OR lower(email::text) LIKE $1 OR lower(company) LIKE $1`. 김민수 row는 `email='kim@kloser.com'` AND `company='Kloser Inc.'` 둘 다 매치. SQL의 OR은 row 단위라 같은 row가 두 번 등장하지 않음 — 결과 정확히 1.

(2) Step 4 route 테스트에서 q 검증 케이스 추가 시 **결과가 N건으로 나올 거라는 가정은 신중하게**. 동일 row 안에서 여러 필드가 매치되는 경우와 서로 다른 row가 각자 한 필드씩 매치되는 경우는 명확히 구분된 fixture로 분리해서 검증. Phase 5+ pg_trgm 전환 시 substring 매치 동작은 유지되지만 인덱스 활용 경로가 바뀜 — 그 step에서 같은 fixture 재검증.

### 8. `e2e` 회귀 후 `test/phase_0_5_e2e.png` 매 실행마다 modified — 커밋 분리 위생 필요

(1) `node test/phase_0_5_e2e.mjs` 실행 시 screenshot이 매번 갱신 (timestamp/렌더링 미세차이). git status에 항상 modified로 잡힘. Step 2 커밋 시 `git add server/...` 명시로 의도적으로 제외했지만, 실수로 `git add -A`나 `git add .`을 쓰면 의도치 않게 PR에 들어감.

(2) 후속 step부터 실수 방지 옵션:
- e2e 스크립트를 deterministic하게 (같은 viewport + 같은 wait gate → byte-identical) 만들어 git diff가 안 잡히게
- `.gitattributes`에 binary diff 무시
- `.gitignore`에 추가 (단 첫 commit이 이미 tracked이므로 `git rm --cached` 필요)

권장: **e2e 결과 screenshot은 의도적 artifact**라 ignore가 적합. Phase 3 진입 시점에 `.gitignore` 추가 + `git rm --cached test/phase_0_5_e2e.png` 한 번 수행. 단 PR 검증용으로 보존하고 싶다면 그대로 유지하되 staging 가이드 (각 단계 commit 메시지에 "지정 파일만" 박기)를 PR template에 명시.

### 9. list + count는 같은 transaction sequential — Promise.all은 의미 없음

(1) `listCustomers`에서 `repo.listForCurrentOrg` 후 `repo.countForCurrentOrg`를 **순차** 실행. plan §5 결정 그대로. pg connection은 단일 query 처리 모델이라 같은 client에서 두 query를 `Promise.all`로 묶어도 PG 측은 순차 처리. await 시 두 번째 query가 첫 query 응답을 기다림 = 동일 wall-clock. 추가 이득 없고 에러 처리만 모호해짐 (어느 쪽 throw인지 stack trace에서 분리 어려움).

(2) Phase 4+에서 데이터 양이 늘어 list+count가 의미 있는 비용 (수십 ms+)이 되면:
```sql
SELECT *, count(*) OVER() AS total_count FROM customers WHERE ... LIMIT N OFFSET M
```
window function으로 한 query 안에 합치는 옵션. 단 partial index 활용 패턴이 바뀌므로 그 시점에 EXPLAIN ANALYZE로 재검증.

### 10. `existsByIdInCurrentOrg` 미도입 — RETURNING null/false가 충분

(1) plan §2 결정 그대로. `updateByIdInCurrentOrg`의 `RETURNING ... → row | null`, `softDeleteByIdInCurrentOrg`의 `rowCount > 0 → boolean`이 곧 "존재 + 권한" 판정. precheck endpoint가 별도면 GET → PATCH 사이에 race가 생길 뿐 이득 없음.

(2) Step 4 route에서 PATCH/DELETE 응답 매핑:
- service 반환 `null` / `false` → `reply.code(404).send({ error: "not_found" })`
- service throw → 500 또는 다른 분기

route 테스트는 "다른 org id로 PATCH → 404" 케이스를 반드시 추가해서 RLS USING이 cross-org write를 0 rows로 차단함을 application 레이어에서도 확인.

### 11. `citext` email + `lower(email::text)` LIKE — partial index 활용 조건

(1) email 컬럼은 `citext` (Phase 1 init.sql §148 인근). citext는 비교에서 case-insensitive지만 LIKE 패턴 매칭 시 `lower()` 명시 하면 partial index `customers_org_lower_email_idx (lower(email::text))` 가 prefix 매치에서 활용됨. substring 매치 (`%kloser%`)는 인덱스 무효, seq scan.

(2) Step 5+ `pg_trgm` 도입 시 `gin_trgm_ops` 인덱스가 substring 매치도 인덱스 경로로 처리. 그 시점에 LIKE 패턴 자체는 그대로 유지하면서 **인덱스만 교체**해도 동작. SQL 본문은 `lower(email::text)` 표기 유지가 안전 (citext + 대소문자 정규화 의미 합쳐서 표현 일관성).

---

## Step 3 진입 시 가장 먼저 봐야 할 것

1. **`server/src/types/customers.ts` 도입 — Step 2 ad-hoc TS interface를 `z.infer<>`로 mechanical 교체** — repository와 service의 타입 import 경로만 바뀌고 동작 그대로. 49 unit + 16 e2e 회귀가 통과하는지 매 commit 검증.
2. **`InvalidListOptionError` vs zod parse error 통합 결정** — zod schema가 status/plan/assignedUserId 거름망이 되면 service throw 경로는 dead code 또는 마지막 방어선. Step 3 plan에서 명시. 본 finding §6 참고.
3. **`updateByIdInCurrentOrg`의 빈 patch fallback과 PATCH route의 zod min-1-field rule 정합** — 본 finding §2 참고. zod에서 `.refine(obj => Object.keys(obj).length > 0)` 패턴 vs service fallback 유지 둘 중 하나만.
4. **`assignedUserId`의 dual mode (null vs UUID) zod 표현** — 본 finding §3 참고. `z.union` + literal 패턴.
5. **Step 4 route 테스트가 `42501` SQLSTATE를 직접 보지 않는다** — Step 2 case 4가 SQL 레벨 차단을 검증. Step 4 route 테스트는 application 레이어 응답 (401/403/404)만 검증. 두 단계 검증을 합치지 말 것.

---

## 의도하지 않게 남긴 것 / 후속 작업

- **`test/phase_0_5_e2e.png` ignore 정책** — 본 finding §8. Phase 3 진입 시점에 결정.
- **list + count → window OVER() 합치기** — 본 finding §9. 데이터 양 증가 시점 (Phase 4+).
- **Phase 4 hard-delete repository 함수 도입 시점 + 테스트 helper와의 분리** — 본 finding §4. GDPR/admin 도입 step plan에서 다룸.
- **PATCH 빈 body 정책 (route 400 vs service 200)** — 본 finding §2. Step 3 zod 도입 시 결정.
- **Phase 5+ pg_trgm + gin_trgm_ops** — 본 finding §11. 운영 진입 후 EXPLAIN ANALYZE로 비용 측정 후.
- **`restoreSoftDeleted` helper 활용 시점** — 본 finding §5. seed row를 직접 mutate하는 case가 추가될 때.
- **Phase 4+ activity_log INSERT — service의 audit hook** — Step 2 service는 명시적으로 audit 안 함 (plan §3). entity별 mutation 발생 시점에 audit row 삽입은 별도 미들웨어/서비스 hook으로.

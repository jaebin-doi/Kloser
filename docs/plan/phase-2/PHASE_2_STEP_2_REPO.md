# Phase 2 Step 2 — Repository + service + RLS 격리 단위 테스트

> **상위 계획**: `docs/plan/phase-2/PHASE_2_MASTER.md` §3 Step 2.
> **선행**: Step 1 완료 — `docs/plan/phase-2/PHASE_2_STEP_1_SCHEMA.md`, `docs/plan/phase-2/PHASE_2_STEP_1_FINDINGS.md`.
> **기간**: 1일.

---

## 진행 상태

- [ ] 1. Repository API 사전 결정 (본 plan §2) 검증
- [ ] 2. Service 책임 범위 사전 결정 (본 plan §3) 검증
- [ ] 3. `deleted_at IS NULL` 강제 패턴 (본 plan §4) 검증
- [ ] 4. `withOrgContext` 사용 contract (본 plan §5) 검증
- [ ] 5. SQL injection 방지 패턴 (본 plan §6) 검증
- [ ] 6. RLS 격리 테스트 6 케이스 + CRUD 테스트 6 케이스 = **12 cases** (본 plan §7) 검증
- [ ] 7. `server/src/repositories/customers.ts` 작성
- [ ] 8. `server/src/services/customers.ts` 작성
- [ ] 9. `server/test/customers_repo.test.mjs` 작성 (12 cases)
- [ ] 10. `npm --prefix server test` → 49/49 (37 + 12) PASS
- [ ] 11. `npm --prefix server run typecheck` PASS
- [ ] 12. e2e 16/16 (split-origin) 회귀 PASS
- [ ] 13. `docs/plan/phase-2/PHASE_2_STEP_2_FINDINGS.md` 작성 (구현 검증 후 별도 커밋)

---

## 0. 목적

Step 1이 schema + RLS의 **데이터베이스 단** 보장을 깔았다. Step 2는 그 위에 **애플리케이션 레이어 access patterns**를 정착시킨다 — repository (RLS-aware SQL), service (도메인 로직 + 정책 후보 결정 지점), 단위 테스트 (격리 + CRUD smoke).

이 step이 끝나면:
- `customers.ts` repository가 `client: PoolClient`를 받는 **순수 함수 모음**으로 존재 (Phase 1 패턴)
- `customers.ts` service가 도메인 입출력 정규화 + soft-delete semantics 캡슐화
- 모든 read/write 함수가 `WHERE deleted_at IS NULL` 강제로 partial 인덱스 활용 + soft-deleted row 노출 차단
- RLS 격리 6 cases + CRUD 6 cases가 SQL 레벨에서 검증

Step 3 (Shared Types + zod) 진입 가능.

---

## 1. 디렉토리 변화

```text
server/
├── src/
│   ├── repositories/
│   │   └── customers.ts                # 🆕 RLS-aware queries, no business logic
│   └── services/
│       └── customers.ts                # 🆕 service layer, role-blind, returns typed objects
└── test/
    └── customers_repo.test.mjs         # 🆕 12 cases (RLS 6 + CRUD 6)
```

서버 부팅 흐름 (`server.ts`)에는 변경 없음. 본 step은 module 추가만, route 등록은 Step 4.

---

## 2. Repository API (사전 결정)

`server/src/repositories/customers.ts`는 Phase 1 `memberships.ts` 패턴 그대로 — 모든 함수가 첫 인자로 `client: PoolClient`를 받고, 호출자는 그 client를 `withOrgContext` 안에서 얻어 RLS context가 자동 적용된다. Repository는 `withOrgContext`를 직접 호출하지 않는다.

### 타입

```ts
export type CustomerStatus = "active" | "review" | "pending";
export type CustomerPlan   = "Starter" | "Pro" | "Enterprise";

export interface Customer {
  id:                  string;
  org_id:              string;
  name:                string;
  company:             string | null;
  email:               string | null;
  phone:               string | null;
  status:              CustomerStatus;
  plan:                CustomerPlan | null;
  assigned_user_id:    string | null;
  last_contacted_at:   Date | null;
  created_at:          Date;
  updated_at:          Date;
  // deleted_at은 repository가 외부로 노출하지 않음 — 내부 필터로만 사용
}

export interface CustomerListOptions {
  q?:       string;          // 검색어 — name/email/company ILIKE
  status?:  CustomerStatus;
  plan?:    CustomerPlan;
  assignedUserId?: string | null;  // null = unassigned 명시 필터
  limit:    number;          // 1..100, service가 정규화
  offset:   number;          // 0..N
  sort:     CustomerSortKey; // 'name' | 'created_at' | 'last_contacted_at'
  dir:      "asc" | "desc";
}

export type CustomerSortKey = "name" | "created_at" | "last_contacted_at";

export interface CustomerCreateInput {
  name:               string;
  company?:           string | null;
  email?:             string | null;
  phone?:             string | null;
  status?:            CustomerStatus;     // default 'pending' from DB
  plan?:              CustomerPlan | null;
  assigned_user_id?:  string | null;
  last_contacted_at?: Date | null;
}

export type CustomerPatch = Partial<CustomerCreateInput>;

export interface CustomerStats {
  total:   number;
  active:  number;
  review:  number;
  pending: number;
}
```

이 타입들은 Step 3 (shared types + zod)에서 `server/src/types/customers.ts`로 승격되며 service/route가 import. Step 2는 ad-hoc 정의로 시작 (master plan §3 Step 3 의도된 흐름).

### 함수 (7개)

| 함수 | 시그니처 | 책임 |
|---|---|---|
| `listForCurrentOrg` | `(client, opts: CustomerListOptions) => Promise<Customer[]>` | 검색·필터·정렬·페이지네이션. 모든 분기에서 `WHERE deleted_at IS NULL` |
| `countForCurrentOrg` | `(client, filters: Pick<CustomerListOptions, "q"\|"status"\|"plan"\|"assignedUserId">) => Promise<number>` | list와 동일 필터에서 total count. pagination metadata용 |
| `statsForCurrentOrg` | `(client) => Promise<CustomerStats>` | 4 KPI — total + status별 grouping. 단일 query (`COUNT(*) FILTER (WHERE status = 'active')` 등) |
| `getByIdInCurrentOrg` | `(client, id: string) => Promise<Customer \| null>` | RLS가 cross-org를 0 rows로 차단 + `WHERE deleted_at IS NULL` |
| `insertInCurrentOrg` | `(client, orgId: string, input: CustomerCreateInput) => Promise<Customer>` | `orgId`를 별도 인자로 받아 INSERT의 `org_id` column에 박음. service는 `actorOrgId`를 넘김. test case 4가 RLS WITH CHECK 우회 시도를 검증할 수 있는 형태 |
| `updateByIdInCurrentOrg` | `(client, id, patch: CustomerPatch) => Promise<Customer \| null>` | `WHERE id = $1 AND deleted_at IS NULL`. 반환 row가 null이면 호출자가 404 |
| `softDeleteByIdInCurrentOrg` | `(client, id) => Promise<boolean>` | `UPDATE customers SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`. boolean = `rowCount > 0` |

`withOrgContext`로 들어온 `PoolClient`라면 RLS가 자동으로 cross-org를 0 rows로 차단한다. Repository 함수는 `org_id` 필터를 SQL에 명시하지 **않는다** (SELECT/UPDATE/DELETE) — 정책에 위임. INSERT만 예외로 `orgId`를 받아 column 값에 박음 — RLS WITH CHECK가 검증.

> **`existsByIdInCurrentOrg`는 본 step에서 도입하지 않는다.** PATCH는 `updateByIdInCurrentOrg`의 `RETURNING * → null`로 404 판정, DELETE는 `softDeleteByIdInCurrentOrg`의 `boolean false`로 동일 판정. precheck endpoint를 따로 두면 시점차 race가 생길 뿐 이득이 없음. Step 4 route에서 정말 필요해지는 시점에 추가 검토.

---

## 3. Service 책임 범위 (사전 결정)

`server/src/services/customers.ts`는 **role-blind** — viewer 차단 같은 권한 분기는 **하지 않는다** (다음 §8 결정 참고). 책임은 다음에 한정:

### 한다

- **org 결합**: route가 넘긴 `actorOrgId`를 `withOrgContext(actorOrgId, ...)`로 transactional context 열고, 그 안에서 repository 호출.
- **INSERT의 `org_id` 결정**: service가 `repo.insertInCurrentOrg(client, actorOrgId, input)`로 `actorOrgId`를 두 번째 인자로 명시 전달. `CustomerCreateInput` 타입에는 `org_id`가 없어서 입력 측 오염이 타입 레벨에서 차단됨. RLS WITH CHECK가 한 번 더 막지만 — defense in depth.
- **list 옵션 정규화**: route가 query string으로 받은 raw 값을 `CustomerListOptions`로 정규화 (limit clamp `Math.min(100, max(1, n))`, default sort = `created_at`, default dir = `desc`, 잘못된 enum은 reject).
- **Soft delete semantics**: `deleteCustomer(id)`는 `UPDATE deleted_at = now()` 내부 호출. DELETE SQL은 한 번도 실행하지 않음.
- **반환 객체 매핑**: pg `Date`를 그대로 전달 (route layer에서 ISO string 변환). 도메인 객체로 wrapping은 하지 않음 — TS interface가 곧 도메인.

### 안 한다

- **권한 검사** — viewer 403은 Step 4 routes의 `requireRole(...)` 미들웨어에서 처리 (Phase 1 auth.ts와 동일 분리 — service는 도메인, middleware는 정책).
- **input validation 본격** — Step 3 (shared types + zod)에서 본격 schema validation 도입. Step 2 service는 ad-hoc TS interface로 받고 zod 도입 후 dispatch만 교체.
- **업무 규칙** — "PATCH로 status를 active → archived 못 바꿈" 같은 도메인 규칙은 본 step에 없음. Phase 4+ 워크플로 도입 시점에.
- **이벤트 발행** — activity_log INSERT는 본 step에서 안 함. Phase 4 audit hook에서.

### 함수 (6개, route가 직접 호출)

| 함수 | 시그니처 (요약) | 호출 흐름 |
|---|---|---|
| `listCustomers` | `(app, actorOrgId, rawOpts) => { items, total }` | `withOrgContext` → `list` + `count` 병렬 |
| `getCustomerStats` | `(app, actorOrgId) => CustomerStats` | `withOrgContext` → `stats` |
| `getCustomerById` | `(app, actorOrgId, id) => Customer \| null` | `withOrgContext` → `getById` |
| `createCustomer` | `(app, actorOrgId, input) => Customer` | `withOrgContext` → `insert` |
| `updateCustomer` | `(app, actorOrgId, id, patch) => Customer \| null` | `withOrgContext` → `update`. null = 404 |
| `deleteCustomer` | `(app, actorOrgId, id) => boolean` | `withOrgContext` → `softDelete`. false = 404 |

---

## 4. `deleted_at IS NULL` 강제 패턴 (사전 결정)

soft delete가 **모든 일상 read/write에서 보이지 않게** 하기 위한 강제 규칙:

| 함수 | `deleted_at` 절 | 비고 |
|---|---|---|
| `listForCurrentOrg` | `WHERE deleted_at IS NULL` (필수 첫 절) | partial 인덱스 6개 모두 같은 조건 — 누락 시 인덱스 미사용 + 삭제된 row 노출 |
| `countForCurrentOrg` | 동일 | list와 동일 필터 |
| `statsForCurrentOrg` | 동일 | partial 인덱스 활용 |
| `getByIdInCurrentOrg` | `WHERE id = $1 AND deleted_at IS NULL` | 삭제된 row를 PATCH/DELETE로도 못 다시 쓰게 |
| `updateByIdInCurrentOrg` | `WHERE id = $1 AND deleted_at IS NULL` | 삭제된 row UPDATE 시도 → 0 rows affected → 404 |
| `softDeleteByIdInCurrentOrg` | `WHERE id = $1 AND deleted_at IS NULL` | **idempotency 보장** — 이미 삭제된 row 다시 삭제 시도 → false |
| `insertInCurrentOrg` | (해당 없음 — INSERT) | INSERT는 deleted_at default NULL이라 절 불필요 |

이 패턴이 Step 2 단위 테스트의 핵심 검증 포인트 중 하나 (§7 case 9, 10).

---

## 5. `withOrgContext` 사용 방식 (사전 결정)

Phase 1 `withOrgContext`(`server/src/plugins/db.ts:37`)는 다음을 자동화:
- `BEGIN`
- `SELECT set_config('app.org_id', $1, true)` (parameterized)
- `fn(client)` 실행
- `COMMIT` (예외 시 `ROLLBACK` + 적절한 release)

### Step 2 service에서의 사용 contract

```ts
// service 패턴 — repository를 직접 호출하지 않고 항상 withOrgContext 경유.
// 같은 client에서 list와 count를 순차로 실행: pg connection은 한 번에 한 query만
// 처리하므로 Promise.all로 묶으면 두 번째 query가 첫 query 응답을 기다리게 되어
// 병렬 이득이 없고, 에러 처리/순서가 모호해진다.
export async function listCustomers(
  app: FastifyInstance,
  actorOrgId: string,
  rawOpts: unknown,
): Promise<{ items: Customer[]; total: number }> {
  const opts = normalizeListOptions(rawOpts);
  return await app.withOrgContext(actorOrgId, async (client) => {
    const items = await repo.listForCurrentOrg(client, opts);
    const total = await repo.countForCurrentOrg(client, opts);
    return { items, total };
  });
}
```

### 결정 사항

1. **모든 service 함수가 `withOrgContext`를 한 번 연다.** repository는 직접 호출 금지 (Phase 1 동일 규칙).
2. **list + count는 같은 transaction 안에서 순차 실행.** 같은 `PoolClient`를 두 query가 공유하는데 pg connection은 동시 query를 지원하지 않으므로 `Promise.all`은 진짜 병렬이 아니고 에러 처리만 모호해진다. 단일 transaction 안에서 두 query 사이의 mutation이 없으므로 정합은 자동 보장. (Phase 4+ 데이터 양이 늘어 의미 있는 비용이 되면 한 SQL의 `OVER()` window count로 합치는 옵션 검토.)
3. **INSERT/UPDATE/DELETE는 단일 transaction 안에서 single query.** RLS WITH CHECK 위반 시 BEGIN 안에서 throw → ROLLBACK이 자동 처리.
4. **테스트도 같은 contract 사용** — `app.withOrgContext(orgId, async (client) => repo.fn(client, ...))`로 직접 호출. service를 우회해서 repository를 단독 검증할 때도 같은 wrapper.

### 안 함

- **`withOrgContext` 중첩** — service 안에서 또 다른 service를 호출하는 패턴은 본 step에서 발생하지 않음. 발생할 경우 (Phase 3+) 한 transaction 재사용 vs 새 transaction 분리는 그 시점에 결정.
- **bare pool query** — `app.pg.query(...)`처럼 RLS context 없이 쓰는 경로는 service에서 0회. 테스트는 RLS isolation 검증 (case 1)에서만 의도적으로 사용.

---

## 6. SQL Injection 방지 (사전 결정)

repository 함수가 raw SQL을 다루므로 모든 user input이 안전하게 들어가야 한다.

### 값 (변수 데이터)

**모두 parameterized (`$1, $2, ...`) — 예외 없음.** pg.Client는 parameterized query를 prepared statement로 처리하므로 string concatenation 시 발생할 SQL injection이 원천 차단.

```ts
// 안전 — 검색어가 그대로 escape됨
client.query(
  "WHERE deleted_at IS NULL AND lower(name) LIKE $1",
  ["%" + q.toLowerCase() + "%"],
);

// 금지 — string concat은 절대 사용하지 않음
client.query(`WHERE name LIKE '%${q}%'`);
```

ILIKE의 `%` wildcard는 **JS 측에서 값에 prepend/append**한다. SQL 본문에는 `LIKE $1`만 적힘. pg가 escape를 책임진다.

### Invalid input 정책 — 카테고리별 일관 처리

오타난 필터값이 조용히 전체 조회를 만드는 일을 막기 위해 카테고리별로 동작을 명시:

| 카테고리 | 잘못된 값 | 동작 |
|---|---|---|
| `sort` (whitelist 밖) | `sort=email` 같은 미지원 컬럼 | **default fallback** = `created_at` |
| `dir` (whitelist 밖) | `dir=upward` | **default fallback** = `desc` |
| `limit` parse 불가 / 범위 밖 | `limit=abc`, `limit=9999`, `limit=0` | **default 또는 clamp** — `parseInt` 실패 시 default(20), 1 미만은 1로 clamp, 100 초과는 100으로 clamp |
| `offset` parse 불가 / 음수 | `offset=abc`, `offset=-5` | **default 또는 clamp** — parse 실패 시 default(0), 음수는 0으로 clamp |
| `status` (whitelist 밖) | `status=closed` (정의 안 된 enum) | **throw `InvalidListOptionError`** — service에서 throw, route는 400 응답 |
| `plan` (whitelist 밖) | `plan=Trial` | **throw `InvalidListOptionError`** — 동일 |
| `assignedUserId` (UUID 형식 위반) | `assignedUserId=foo` | **throw `InvalidListOptionError`** — UUID parse 시도, 실패 시 throw |
| `q` | 임의 문자열 (제한 없음) | **그대로 사용** — `lower()`만 적용, 길이 cap 200 |

**근거**: sort/limit/offset 같은 페이지네이션 메타는 잘못 와도 default가 합리적이지만, status/plan 같은 도메인 enum은 잘못 와도 silent fallback이 위험 — "관심 고객만 보기" 의도가 "전체 조회"로 둔갑하는 사고. throw로 즉시 표면화.

### 컬럼명 / 정렬 키 (구조적 데이터 — 위 표의 sort/dir 구현)

```ts
const SORT_COLS: Record<CustomerSortKey, string> = {
  name:               "lower(name)",
  created_at:         "created_at",
  last_contacted_at:  "last_contacted_at NULLS LAST",
};
const SORT_DIRS = new Set(["asc", "desc"]);

function buildOrderBy(sort: CustomerSortKey, dir: "asc" | "desc"): string {
  const col = SORT_COLS[sort] ?? SORT_COLS.created_at;
  const d   = SORT_DIRS.has(dir) ? dir : "desc";
  return `ORDER BY ${col} ${d.toUpperCase()}`;
}
```

`normalizeListOptions`가 sort/dir/limit/offset은 default fallback, status/plan/assignedUserId는 throw `InvalidListOptionError`로 통일.

### 결과 — 정리

- 값 (q, ID, name 등): `$N` parameterized — escape 자동
- sort, dir: whitelist + default fallback (silent)
- limit, offset: parse + clamp (silent)
- status, plan, assignedUserId: whitelist + **throw** (loud)
- raw SQL string concat: 0건

---

## 7. 테스트 케이스 (12개 = RLS 6 + CRUD 6)

`server/test/customers_repo.test.mjs` — Phase 1 `rls_isolation.test.mjs` 패턴 그대로 (Fastify boot + dbPlugin register + `tsx --test --test-concurrency=1`).

### RLS 격리 (6 cases)

```
1. bare pool (no withOrgContext, no GUC): SELECT customers → 0 rows
   — RLS forced + helper가 NULLIF로 missing GUC 안전 처리

2. withOrgContext(Acme): listForCurrentOrg → 12 rows
   — seed의 Acme customer 12명만

3. withOrgContext(Beta): listForCurrentOrg → 12 rows
   — seed의 Beta customer 12명만, 이름 set이 case 2와 disjoint

4. withOrgContext(Acme) 안에서 insertInCurrentOrg(client, ORG_BETA, input)
   → throws (RLS WITH CHECK 위반)
   — repository의 orgId 인자를 악의적으로 다른 org로 넘겼을 때
     RLS WITH CHECK가 SQL 레벨에서 차단하는지 확인
   — defense in depth 검증

5. withOrgContext(Acme) + updateByIdInCurrentOrg(beta_customer_id, {name:'X'})
   → returns null (RLS USING이 0 rows로 차단)
   — id는 글로벌 unique지만 다른 org이라 안 보임

6. withOrgContext(Acme) + softDeleteByIdInCurrentOrg(beta_customer_id)
   → returns false (UPDATE rowCount = 0)
   — 같은 메커니즘
```

### CRUD + 인덱스·trigger·soft-delete 행위 (6 cases)

```
7. insertInCurrentOrg + listForCurrentOrg: 새 row 13번째로 보임, name 일치
   — happy-path round-trip

8. updateByIdInCurrentOrg(id, {name:'NEW'}): 반환된 Customer.name === 'NEW'
   AND updated_at > created_at (trigger 동작 확인)
   — touch_updated_at trigger 실증

9. softDeleteByIdInCurrentOrg(id) → true,
   다시 listForCurrentOrg: row 안 보임 (count = 12)
   — deleted_at IS NULL 필터 검증

10. softDeleteByIdInCurrentOrg(id) idempotency:
    같은 id 다시 호출 → false (이미 deleted_at SET)
    — Step 2 plan §4 명시 동작

11. listForCurrentOrg with q='kloser': 1 row 반환 (김민수)
    — Acme seed에서 'kloser' 매치는 김민수 한 명. email 'kim@kloser.com' AND
    company 'Kloser Inc.' 둘 다 ILIKE로 매치되지만 같은 row이므로 결과 1건.
    ASCII 값으로 채택 — 한글 seed (이름 컬럼)와 회귀 안정성 분리.

12. statsForCurrentOrg: { total: 12, active: N, review: M, pending: K }
    — 24 customer seed의 Acme 12명에서 status별 분포 검증.
    seed에 active=7 / review=3 / pending=2 (mock UI 그대로)이므로 hardcoded 기대값.
```

### Test infrastructure

- `before`: Fastify boot, dbPlugin register
- `before` 별도 hook: 시드 강제 재적용 (test 사이 mutation 격리). 또는 각 case가 자체 cleanup 책임 — Phase 1 `auth.test.mjs` 동일 분기 결정 검토.

**결정**: Phase 1 `rls_isolation.test.mjs`는 read-only라 cleanup 불필요. `customers_repo.test.mjs`는 INSERT/UPDATE/DELETE를 하므로 **각 mutation 직후 자체 cleanup** (insert한 row는 hard delete, soft-delete한 row는 deleted_at = NULL로 복원). 또는 테스트 시작 시점에 `seed/0002_customers.sql`을 다시 실행하는 helper. **단순함 우선 — 각 case가 자기 mutation을 unwind**.

### 기대 결과

`npm --prefix server test`:
- 이전: 37 (auth 19 + rls 7 + orgContext 3 + ws_auth 8)
- Step 2 후: **49** (37 + customers 12) PASS

---

## 8. 결정점 — Viewer write 차단은 Step 2 service인가, Step 4 routes인가

| 옵션 | 변경 범위 |
|---|---|
| **A. Step 4 routes의 `requireRole` 미들웨어** | service는 role-blind. Phase 1 auth.ts와 같은 분리 — service = 도메인, middleware = 정책 |
| B. Step 2 service가 `actor: { role }` 파라미터를 받고 viewer면 throw | service에 role 분기 들어감. Phase 1 패턴과 일관성 깨짐 |

**결정: A**. 근거:

1. **Phase 1 일관성** — `auth.ts` service는 role을 안 본다. `requireRole` 미들웨어가 route preHandler로 차단. customers도 같은 분리 유지가 자연스러움.
2. **테스트 단순함** — Step 2 단위 테스트가 service를 직접 호출할 때 role을 인자로 안 넘겨도 됨. 12 cases가 깔끔.
3. **Phase 3+ team-scope 확장 시점** — manager/employee의 write가 자기 팀으로 좁아질 때, **service에 자연스럽게 추가됨** (e.g., `actor.teamId` 비교). 그때까지 viewer 차단만 분리해두는 건 일관성 있는 진화 경로.
4. **defense-in-depth는 RLS가 담당** — viewer가 어떤 경로로든 service에 도달해도 RLS의 read 정책은 통과 (org-wide read), write는 application layer가 거부. 서로 보완.

### 부수 결정

- Step 4의 `requireRole` 사용 형태: `requireRole('admin', 'manager', 'employee')` (= NOT viewer). Phase 1 `requireRole`는 가변 인자 패턴 (`server/src/middleware/role.ts`).
- viewer가 write endpoint 호출 시 응답: **`reply.code(403).send({ error: "forbidden" })`** — Phase 1 `requireRole` 구현 (`server/src/middleware/role.ts:17`)을 그대로 재사용. 별도 코드 식별자 (`INSUFFICIENT_ROLE` 등) 도입 안 함. Phase 4+에서 에러 카탈로그 표준화 시 일괄 변경.
- Step 2 단위 테스트는 viewer 차단을 검증 **안 함** — Step 4 route 테스트의 책임. 본 plan §7의 12 cases는 RLS + CRUD만.

---

## 9. 위험·미정

| 항목 | 처리 |
|---|---|
| 단위 테스트가 mutation을 누적해서 다음 case 결과를 오염시킬 위험 | 각 mutation case가 자기 cleanup (`afterEach` 또는 try/finally). seed 재적용 helper도 옵션. 본 step §7 case 작성 시 결정 |
| RLS isolation case 4 (`insertInCurrentOrg(client, ORG_BETA, input)` — repository orgId 인자 변조)가 service 우회 시나리오 | 의도적 — repository를 service를 통하지 않고 직접 부르면서 orgId 인자를 다른 org로 넘겨도 RLS WITH CHECK가 SQL 레벨에서 차단되는 것이 핵심 검증. Step 4 route는 service만 호출 |
| `last_contacted_at NULLS LAST` 정렬 시 인덱스 활용도 | 본 partial 인덱스 (`customers_org_assigned_idx` 등)는 `last_contacted_at`을 인덱스 키에 안 두므로 정렬은 sequential (12명 기준 무관). 운영 진입 시점에 정렬 인덱스 별도 검토 |
| Service가 `app: FastifyInstance` 받는 시그니처 | Phase 1 auth.ts와 동일. test에서 `app` mock이 필요할 텐데 Phase 1은 실제 fastify instance 부팅으로 처리 — 본 step도 동일 |
| ON CONFLICT seed 재실행이 단위 테스트 cleanup으로 적합한가 | 너무 무거움 (24 row INSERT). 더 가벼운 cleanup (mutation 1개당 SQL 1~2 line) 권장 |
| Step 2 ad-hoc 타입과 Step 3 zod schema가 어긋날 위험 | Step 3 plan에서 customers.ts repository 타입을 mechanically `z.infer`로 교체하는 게 명시 작업. Step 2 ad-hoc 타입은 임시 |

---

## 10. 완료 기준 (Step 2 — go/no-go)

- [ ] `server/src/repositories/customers.ts` 작성 — 7 함수, 모두 `client: PoolClient` 첫 인자
- [ ] `server/src/services/customers.ts` 작성 — 6 함수, 모두 `withOrgContext` 경유
- [ ] `server/test/customers_repo.test.mjs` — **12 cases 모두 PASS**
- [ ] `npm --prefix server run typecheck` PASS (새 module 포함)
- [ ] `npm --prefix server test` 49/49 PASS (37 + 12)
- [ ] `node test/phase_0_5_e2e.mjs` 16/16 회귀 PASS (split-origin)
- [ ] **격리 case 4** (orgId 인자에 다른 org를 넘겨 INSERT → throws) 통과 — RLS WITH CHECK가 repository 인자 변조까지 차단함을 SQL 레벨 검증
- [ ] **격리 case 5/6** (다른 org row UPDATE/soft-delete → null/false) 통과 — RLS USING이 cross-org write 차단
- [ ] **CRUD case 8** (PATCH 후 `updated_at > created_at`) 통과 — touch_updated_at trigger 동작 확인
- [ ] **CRUD case 9/10** (soft-delete 후 invisible + idempotency false) 통과 — `deleted_at IS NULL` 강제 패턴 검증
- [ ] **mutation cleanup**: 각 mutation case가 `try/finally`로 자체 unwind. INSERT한 row는 admin URL 또는 별도 `withOrgContext` + 테스트 전용 hard DELETE SQL helper로 제거 (repository에는 hard delete 함수 추가 금지), soft-delete한 row는 `deleted_at = NULL` 복원. 다음 case로 이어지는 누적 mutation 없음
- [ ] `docs/plan/phase-2/PHASE_2_STEP_2_FINDINGS.md` 작성 (구현 + 검증 후 별도 커밋)

---

## 11. 한 줄 요약

> **하루 동안 customers repository (7 함수) + service (6 함수, role-blind) + 단위 테스트 12 cases (RLS 6 + CRUD 6)를 작성해, RLS 격리·partial 인덱스 활용·soft-delete 행위·trigger 동작이 모두 SQL 레벨에서 검증되는 access layer를 정착시킨다.**

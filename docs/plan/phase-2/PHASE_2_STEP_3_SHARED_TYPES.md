# Phase 2 Step 3 — Shared Types + zod validation 패턴

> **상위 계획**: `docs/plan/phase-2/PHASE_2_MASTER.md` §3 Step 3 + §2-9/10 사전 결정.
> **선행**: Step 2 완료 — `docs/plan/phase-2/PHASE_2_STEP_2_REPO.md`, `docs/plan/phase-2/PHASE_2_STEP_2_FINDINGS.md`.
> **기간**: 0.5일.
>
> ⚠️ **본 plan에 명시된 `CustomerPlan` enum 및 schema의 `plan` 필드는 Step 5에서 제거됐다** (도메인 경계 충돌). 최종 schema는 `server/src/types/customers.ts` + master plan / Step 5 findings 참조. sync 검증 대상 4종은 그대로 유지된다.

---

## 진행 상태

- [ ] 1. zod 의존성 추가 정책 검증 (본 plan §3)
- [ ] 2. Server source-of-truth 모듈 형태 사전 결정 검증 (본 plan §4)
- [ ] 3. Browser JSDoc 사본 형태 사전 결정 검증 (본 plan §5)
- [ ] 4. Sync 검증 테스트 알고리즘 사전 결정 검증 (본 plan §6)
- [ ] 5. Step 2 repo/service 리팩터링 범위 사전 결정 검증 (본 plan §7)
- [ ] 6. Invalid input 정책 정합 (`InvalidListOptionError`/시그니처 유지, `normalizeListOptions` 내부만 zod 교체) 사전 결정 검증 (본 plan §8)
- [ ] 7. `npm install zod --save --prefix server` 실행 + lock 파일 갱신
- [ ] 8. `server/src/types/customers.ts` 작성 (zod schema + `z.infer` TS types)
- [ ] 9. `platform/types/customers.js` 작성 (JSDoc typedef 사본)
- [ ] 10. `test/sync_shared_types.mjs` 작성 (양쪽 필드명 diff)
- [ ] 11. Step 2 repo/service 리팩터링 — ad-hoc TS interface → shared types import
- [ ] 12. `npm --prefix server run typecheck` PASS
- [ ] 13. `npm --prefix server test` 49/49 회귀 PASS (refactor 후에도)
- [ ] 14. `node test/sync_shared_types.mjs` PASS — customers 양쪽 필드 동일
- [ ] 15. `node test/phase_0_5_e2e.mjs` 16/16 회귀 PASS
- [ ] 16. `docs/plan/phase-2/PHASE_2_STEP_3_FINDINGS.md` 작성 (구현 + 검증 후 별도 커밋)

---

## 0. 목적

Phase 0.5 인계 마지막 deferred 항목인 **shared types 패턴**을 customers entity로 정착시킨다. Step 2의 ad-hoc TS interface는 임시 — 이번 step에서 zod schema로 일원화하고 브라우저 JSDoc 사본 + sync 테스트까지 깐다. Step 4의 REST routes가 이 zod schema를 그대로 import해서 body/query validation에 사용하므로 routes보다 먼저 깔린다.

이 step이 끝나면:
- `server/src/types/customers.ts`가 customers entity의 **단일 진실원** (zod schema + `z.infer` TS types)
- `platform/types/customers.js`가 브라우저용 JSDoc-only 사본 (build step 없음)
- `test/sync_shared_types.mjs`가 두 파일의 필드명 diff를 회귀 차단
- Step 2 repository/service가 shared types를 import (ad-hoc 정의 제거)
- Phase 3+ 새 entity (calls, transcripts 등)도 같은 3-파일 패턴 follow

Step 4 (REST routes) 진입 가능.

---

## 1. 디렉토리 변화

```text
server/
├── package.json                    # ⬆ zod runtime dep 추가
├── package-lock.json               # ⬆ lock 갱신
└── src/
    ├── repositories/
    │   └── customers.ts            # ⬆ ad-hoc 타입 제거 → ../types/customers.js import
    ├── services/
    │   └── customers.ts            # ⬆ ad-hoc 타입 제거 → import. normalizeListOptions 내부를 zod parse로 교체 (시그니처·InvalidListOptionError 유지)
    └── types/
        └── customers.ts            # 🆕 server source-of-truth (zod + z.infer)

platform/
└── types/
    └── customers.js                # 🆕 JSDoc typedef-only 브라우저 사본

test/
└── sync_shared_types.mjs           # 🆕 server vs browser 필드명 diff
```

서버 부팅 흐름·test runner·기존 라우트는 변경 없음. Step 4 (routes) 진입 시 routes가 `server/src/types/customers.js`에서 schema import.

---

## 2. 사전 결정 (요약 표)

| 항목 | 결정 | 근거 |
|---|---|---|
| 1. validation 라이브러리 | **zod** runtime dep 추가 | 마스터 §2-9. ad-hoc `if` 분기 양식 길어짐. zod는 entity 늘수록 가성비 |
| 2. shared types 패턴 | **Option B** — server `.ts` source-of-truth + browser `.js` JSDoc 사본 + node sync 테스트 | 마스터 §2-10. 정적 페이지에 bundler 도입은 부담. JSDoc은 enforcement 없지만 sync 테스트가 회귀 차단 |
| 3. server 모듈 위치 | `server/src/types/<entity>.ts` (단수 entity 파일 1개) | 마스터 Step 3 의도. entity별 1파일이 import path 일관 |
| 4. browser 모듈 위치 | `platform/types/<entity>.js` (대응 1:1) | 마스터 Step 3 의도. `platform/api.js` 등과 같은 root flat 구조 유지 |
| 5. sync 테스트 위치 | repo root `test/sync_shared_types.mjs` (`node test/sync_shared_types.mjs`로 직접 실행) | 마스터 §6 완료 기준 그대로. 서버 test runner 의존 안 함 → 단순 `node` 실행 |
| 6. zod schema vs TS types 일원화 | 모든 entity 형태 (input + output + query + stats)를 zod로 정의 + `z.infer<typeof X>`로 TS types 유추 | 마스터 Step 3 의도. 단일 정의·이중 산출 |
| 7. DB 출력 row 검증 | zod **`parse()`는 입력 측에만** — 라우트 body/query에서. DB row → `Customer` 타입은 `z.infer`로 TS만 받고 runtime parse 안 함 | DB는 신뢰 경계 안. 매 row를 zod parse하면 CPU 낭비 |
| 8. timestamp 컬럼의 server vs wire 분기 | server `Customer.last_contacted_at` = `Date \| null` (서비스 내부), wire JSON = `string \| null` (ISO 8601). JSDoc 사본은 wire 기준이라 `string` | 라우트가 JSON 직렬화 시 Date → ISO string. 클라가 보는 것은 항상 string |
| 9. `CustomerPatch` 이름 | Step 2의 `CustomerPatch` 유지 (master plan §3은 'CustomerUpdateInput' 표기지만 PATCH semantics에 더 부합) | Step 2와 호환. master plan은 사례 표기, 본 step에서 정합 표 갱신 |
| 10. `CustomerPatch` 빈 patch 거부 | zod `.refine(obj => Object.keys(obj).length > 0)` — Step 4 route가 400으로 응답 | Step 2 finding §2의 옵션 A 채택. silent no-op 회피 |
| 11. `assignedUserId` dual mode | preprocess로 `""` → `undefined`, `"null"`/`null` → `null` 정규화 후 inner schema `z.union([z.string().uuid(), z.null()]).optional()`. (구체 코드는 §4 sketch `AssignedUserId` 참고) | Step 2 finding §3 그대로 + service `pickAssignedUserId` 동작 유지 |
| 12. service 시그니처 / 방어선 | service 시그니처는 Step 2 그대로 (`listCustomers(app, actorOrgId, rawOpts: unknown)`). `normalizeListOptions`는 **유지**하되 내부 구현을 zod schema parse로 교체. `InvalidListOptionError`도 **유지** — zod parse error를 catch해서 동일 error로 wrap. Step 4 route는 `CustomerListQuery.parse(req.query)`를 먼저 하든 service에 raw로 넘기든 둘 다 안전. **중복 parse 비용은 무시 가능**, service 방어선이 Step 4 도착 전까지 유일한 boundary | Step 4 routes가 본 step 종료 시점엔 아직 없으므로 service에서 normalization을 빼면 boundary parser 부재. Step 2 finding §6 결정 유지. zod 도입은 **구현 교체**일 뿐 layer 책임 이동 아님 |
| 13. 의존성 버전 핀 | `zod`는 caret(`^`) range로 추가, 설치 후 실제 minor를 finding에 기록 | Phase 1 다른 dep과 동일. major bump는 phase 종료 시점 검토 |
| 14. JSDoc 사본의 동기화 강제 수단 | sync 테스트 1개로 통일 (정적 검사 + lint 추가는 Phase 6+) | 도입 비용 vs 회귀 차단 가치 trade-off. sync 테스트 1개로 충분 |

---

## 3. zod 의존성 추가

```bash
npm install zod --save --prefix server
```

설치 후 검증:
- `server/package.json` `dependencies`에 `"zod": "^X.Y.Z"` 추가됨
- `server/package-lock.json` 갱신됨 (transitive deps 거의 없음 — zod는 zero-dep)
- `npm --prefix server ls zod` 출력 한 줄

커밋 분리:
- 의존성 추가는 **Step 3 구현 커밋의 일부**로 포함. 별도 mini-commit 안 만듦. Phase 1·2 커밋 패턴 그대로 (lock 파일 갱신은 본 의존성 추가에 묶임)

`zod` 자체는 zero-runtime-dep, ESM/CJS dual export, TS 우선 라이브러리. Phase 1 dep과 충돌 없음. version pin은 caret range.

---

## 4. Server source-of-truth — `server/src/types/customers.ts`

### 모듈 export 표면

| Export | 종류 | 용도 |
|---|---|---|
| `CustomerStatus` | `z.enum(...)` + `z.infer` 동명 type | Step 2 repo의 동명 type 대체. enum literal "active"/"review"/"pending" |
| `CustomerPlan` | 동일 | "Starter"/"Pro"/"Enterprise" |
| `CustomerSortKey` | 동일 | "name"/"created_at"/"last_contacted_at" |
| `SortDirection` | 동일 | "asc"/"desc" |
| `Customer` | `z.object({...})` + `z.infer` type | Service 출력 row. 내부 (Date 컬럼) 표기 |
| `CustomerCreateInput` | `z.object({...})` + type | POST body schema |
| `CustomerPatchBase` | `CustomerCreateInput.partial()` (refine 전) | refine 전 schema. 라우트나 테스트에서 raw partial이 필요할 때 사용 (예: 빈-patch 검증을 별도 단계로 분리하고 싶은 경우). **sync 검증 대상 아님** (`.partial()` derived는 정의 파일의 텍스트에 필드 선언이 없음 — §6 sync 알고리즘은 top-level `z.object({...})` literal만 read) |
| `CustomerPatch` | `CustomerPatchBase.refine(...)` + type | PATCH body schema. 빈 patch 거부. PATCH 필드 = CREATE 필드라 sync 검증은 `CustomerCreateInput`이 흡수 |
| `CustomerListQuery` | `z.object({...})` + type | GET /customers query string schema. limit/offset/sort/dir default 포함 |
| `CustomerStats` | `z.object({...})` + type | GET /customers/stats 응답 |

### 주요 schema 정의 (sketch)

```ts
import { z } from "zod";

export const CustomerStatus = z.enum(["active", "review", "pending"]);
export type CustomerStatus = z.infer<typeof CustomerStatus>;

export const CustomerPlan = z.enum(["Starter", "Pro", "Enterprise"]);
export type CustomerPlan = z.infer<typeof CustomerPlan>;

export const CustomerSortKey = z.enum(["name", "created_at", "last_contacted_at"]);
export type CustomerSortKey = z.infer<typeof CustomerSortKey>;

export const SortDirection = z.enum(["asc", "desc"]);
export type SortDirection = z.infer<typeof SortDirection>;

// `last_contacted_at` 입력 정책 (POST/PATCH body):
//   - undefined → undefined  (필드 자체 누락 — `.optional()`이 처리)
//   - null      → null       (명시적 unset)
//   - Date      → Date       (그대로)
//   - ISO 8601 string → Date  (parse)
//   - "" / 숫자 / 임의 string → reject (의도치 않은 값 통과 차단)
// z.coerce.date()는 입력 범위가 너무 넓어 (숫자/임의 string도 Date로 강제 + ""을 epoch로 해석)
// 의도치 않은 값이 통과하므로 사용 안 함. 명시적 preprocess + z.date().nullable() 조합.
const LastContactedAt = z.preprocess((v) => {
  if (v === undefined || v === null) return v;        // undefined/null 그대로 흘림
  if (v === "") return v;                              // "" 보존 → z.date().nullable()이 reject
  if (v instanceof Date) return v;
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : d;          // parse 실패 시 원본 → reject
  }
  return v;                                            // 숫자/객체 등 → reject
}, z.date().nullable());

export const CustomerCreateInput = z.object({
  name:               z.string().trim().min(1).max(120),
  company:            z.string().trim().max(120).nullable().optional(),
  email:              z.string().email().nullable().optional(),
  phone:              z.string().trim().max(40).nullable().optional(),
  status:             CustomerStatus.optional(),
  plan:               CustomerPlan.nullable().optional(),
  assigned_user_id:   z.string().uuid().nullable().optional(),
  last_contacted_at:  LastContactedAt.optional(),
});
export type CustomerCreateInput = z.infer<typeof CustomerCreateInput>;

// PATCH base = same fields but all optional. 노출 이유: route나 테스트가
// refine 전 partial schema를 직접 쓰고 싶을 때 (빈-patch 검사를 별도 단계로
// 분리하는 경우 등). 본 step 시점에는 `CustomerPatch`만 실제 validation에 쓰임.
// **sync 검증 대상 아님** — `.partial()` derived는 정의 파일 텍스트에 필드
// 선언이 없어 §6 regex 파서가 읽을 수 없음. PATCH 필드 = CREATE 필드이므로
// sync는 `CustomerCreateInput`이 흡수.
export const CustomerPatchBase = CustomerCreateInput.partial();
export const CustomerPatch = CustomerPatchBase.refine(
  (obj) => Object.keys(obj).length > 0,
  { message: "patch must include at least one field" },
);
export type CustomerPatch = z.infer<typeof CustomerPatch>;

export const Customer = z.object({
  id:                z.string().uuid(),
  org_id:            z.string().uuid(),
  name:              z.string(),
  company:           z.string().nullable(),
  email:             z.string().nullable(),
  phone:             z.string().nullable(),
  status:            CustomerStatus,
  plan:              CustomerPlan.nullable(),
  assigned_user_id:  z.string().uuid().nullable(),
  last_contacted_at: z.date().nullable(),     // Date — service 내부
  created_at:        z.date(),
  updated_at:        z.date(),
});
export type Customer = z.infer<typeof Customer>;

// limit/offset clamp 동작 유지 (Step 2 plan §6 invalid input 정책 표):
//   - limit: parse 실패 → 20, <1 → 1, >100 → 100
//   - offset: parse 실패 → 0, <0 → 0
// zod의 `.min/.max`는 범위 밖을 reject하므로, clamp가 필요하면 preprocess에서
// 직접 처리한 뒤 plain z.number()로 통과. 실패 시 default로 fall-back.
const ListLimit = z.preprocess((v) => {
  if (v === undefined || v === null || v === "") return 20;
  const n = typeof v === "number" ? v : Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) return 20;
  if (n < 1) return 1;
  if (n > 100) return 100;
  return Math.floor(n);
}, z.number().int().min(1).max(100));

const ListOffset = z.preprocess((v) => {
  if (v === undefined || v === null || v === "") return 0;
  const n = typeof v === "number" ? v : Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  return Math.floor(n);
}, z.number().int().min(0));

// q (검색어) — Step 2 `pickQ` 동작 유지:
//   - undefined / null / blank string → undefined (필터 자체 없음)
//   - non-string → undefined (Step 2 동작 — pickQ는 typeof !== string에 undefined)
//   - string → trim + slice 200
// preprocess가 정규화를 모두 처리하므로 inner schema는 z.string().max(200).optional()로 단순.
const ListQ = z.preprocess((v) => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  if (trimmed === "") return undefined;
  return trimmed.slice(0, 200);
}, z.string().max(200).optional());

// status / plan — Step 2 `pickStatus` / `pickPlan` 동작 유지:
//   - undefined / null / "" → undefined (필터 자체 없음, query string에서 ?status= 같은 빈 값 흔함)
//   - valid enum value → 통과
//   - 그 외 (invalid enum) → 흘려보내 z.enum(...)이 reject → normalizeListOptions가 InvalidListOptionError로 wrap
// preprocess는 빈 값 정규화만 — invalid enum 판별은 inner z.enum에 위임.
const ListStatus = z.preprocess((v) => {
  if (v === undefined || v === null || v === "") return undefined;
  return v;
}, CustomerStatus.optional());

const ListPlan = z.preprocess((v) => {
  if (v === undefined || v === null || v === "") return undefined;
  return v;
}, CustomerPlan.optional());

// assignedUserId dual mode + 빈 문자열 처리 (Step 2 finding §3 + service `pickAssignedUserId` 동작 유지):
//   - undefined / "" → 필터 자체 없음 (undefined로 정규화)
//   - "null" / null  → "unassigned 명시 필터" (null로 정규화)
//   - UUID string    → 특정 사용자
const AssignedUserId = z.preprocess((v) => {
  if (v === undefined || v === "") return undefined;
  if (v === null || v === "null") return null;
  return v;
}, z.union([z.string().uuid(), z.null()]).optional());

// 불변조건 (CustomerListQuery 작성 규칙):
//   - q, sort, dir, limit, offset은 preprocess/catch/default로 항상 정규화 — 절대 throw하지 않음
//   - status, plan, assignedUserId만 invalid 시 throw (zod 기본 동작)
//   - 결과: safeParse 실패 path는 status/plan/assignedUserId field로 한정됨
//   - normalizeListOptions는 ZodError.issues[0].path로 field를 판별해 InvalidListOptionError로 wrap
export const CustomerListQuery = z.object({
  q:               ListQ,
  status:          ListStatus,
  plan:            ListPlan,
  assignedUserId:  AssignedUserId,
  limit:           ListLimit.default(20),
  offset:          ListOffset.default(0),
  // sort/dir도 whitelist 밖이면 default로 silent fallback (Step 2 정책 그대로).
  // zod enum은 invalid를 reject하므로 .catch(default)로 fallback 동작 유지.
  sort:            CustomerSortKey.catch("created_at").default("created_at"),
  dir:             SortDirection.catch("desc").default("desc"),
});
export type CustomerListQuery = z.infer<typeof CustomerListQuery>;

export const CustomerStats = z.object({
  total:   z.number().int().nonnegative(),
  active:  z.number().int().nonnegative(),
  review:  z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
});
export type CustomerStats = z.infer<typeof CustomerStats>;
```

`Customer.last_contacted_at`은 `z.date()` (서비스 내부 Date 객체). 라우트가 JSON 직렬화 시 Postgres 객체가 자동으로 ISO string으로 직렬화 — 별도 mapping 함수 불필요. 클라이언트 JSDoc 사본은 이 시점의 wire shape (string)을 표현 (§5).

---

## 5. Browser JSDoc 사본 — `platform/types/customers.js`

### 형태

순수 JSDoc `@typedef` 선언만. import/export 없음 (브라우저 직접 로드 안 됨, JSDoc 도구 / IDE intellisense / sync test 대상 전용). `platform/api.js`처럼 IIFE 기반 module이 아닌 **타입 메타데이터 파일**.

```js
// platform/types/customers.js — JSDoc-only 사본.
// Server source-of-truth: server/src/types/customers.ts.
// Sync 검증: test/sync_shared_types.mjs.
//
// 이 파일은 브라우저에 로드되지 않는다. IDE/JSDoc 도구가 platform/*.html
// 안의 fetch 응답 type annotation에 사용한다.

/**
 * @typedef {"active" | "review" | "pending"} CustomerStatus
 */

/**
 * @typedef {"Starter" | "Pro" | "Enterprise"} CustomerPlan
 */

/**
 * @typedef {Object} Customer
 * @property {string} id
 * @property {string} org_id
 * @property {string} name
 * @property {string|null} company
 * @property {string|null} email
 * @property {string|null} phone
 * @property {CustomerStatus} status
 * @property {CustomerPlan|null} plan
 * @property {string|null} assigned_user_id
 * @property {string|null} last_contacted_at  // ISO 8601 — wire format
 * @property {string} created_at              // ISO 8601 — wire format
 * @property {string} updated_at              // ISO 8601 — wire format
 */

/**
 * @typedef {Object} CustomerCreateInput
 * @property {string} name
 * @property {string|null} [company]
 * @property {string|null} [email]
 * @property {string|null} [phone]
 * @property {CustomerStatus} [status]
 * @property {CustomerPlan|null} [plan]
 * @property {string|null} [assigned_user_id]
 * @property {string|null} [last_contacted_at]
 */

/**
 * @typedef {Partial<CustomerCreateInput>} CustomerPatch
 */

/**
 * @typedef {Object} CustomerListQuery
 * @property {string} [q]
 * @property {CustomerStatus} [status]
 * @property {CustomerPlan} [plan]
 * @property {string|"null"|null} [assignedUserId]
 * @property {number} [limit]
 * @property {number} [offset]
 * @property {"name"|"created_at"|"last_contacted_at"} [sort]
 * @property {"asc"|"desc"} [dir]
 */

/**
 * @typedef {Object} CustomerStats
 * @property {number} total
 * @property {number} active
 * @property {number} review
 * @property {number} pending
 */
```

### 핵심 차이 (서버 vs 브라우저 사본)

| 항목 | 서버 (`*.ts`) | 브라우저 (`*.js`) | 이유 |
|---|---|---|---|
| timestamp 컬럼 | `z.date()` → `Date` | `string` | 서버는 내부 Date, 클라는 JSON wire (ISO string) |
| validation refine | `.refine(...)` 등 | 표현 안 함 (JSDoc은 refinement 표기 못함) | sync 테스트는 **필드명**만 비교. validation 본문은 서버 단일 |
| default 값 | `.default(20)` 등 | JSDoc에 표시 안 함 | client는 default 신경 안 씀 (서버 응답은 default 적용 후 값) |

sync 검증은 **field name set 일치**에만 책임을 둔다. type narrowing이나 default까지 비교하면 사본이 너무 복잡해지고 정적 페이지의 가성비 떨어짐.

---

## 6. Sync 검증 테스트 — `test/sync_shared_types.mjs`

### Sync 대상 schema 작성 컨벤션 (regex 파서 호환)

regex 파서를 단순하게 유지하기 위해 **sync 대상 schema는 다음 형식만 허용**:

- 반드시 top-level `export const <TypeName> = z.object({ ... });` literal
- 다음 구문은 **sync 대상 schema에 사용 금지**:
  - `.extend()`, `.merge()`, `.partial()`, `.pick()`, `.omit()` 등 derived
  - `satisfies` 연산자
  - 분리된 `const Shape = { ... }; export const X = z.object(Shape)` 형식
- derived schema (예: `CustomerPatchBase = CustomerCreateInput.partial()`)는 **sync 대상 아님** — 정의 파일 텍스트에 필드 선언이 없어 regex 파서가 읽을 수 없음. derived도 노출은 가능하나 sync registry에는 등록하지 않음
- 위 컨벤션을 깬 schema가 sync 대상 list에 들어 있으면 sync 테스트가 "type not found"로 fail — 컨벤션 위반을 회귀 차단

이 제약은 본 step의 customers entity 4종 (Customer, CustomerCreateInput, CustomerListQuery, CustomerStats) 모두 자연스럽게 충족. Phase 3+ 새 entity 추가 시도 같은 컨벤션 강제.

### 알고리즘

```
1. ENTITY_REGISTRY = [
     { name: "customers",
       server: "server/src/types/customers.ts",
       browser: "platform/types/customers.js",
       types: ["Customer", "CustomerCreateInput",
               "CustomerListQuery", "CustomerStats"] }
   ]

2. for each entity:
     serverFields = parseTsFields(server file)    // returns Map<typeName, Set<fieldName>>
     browserFields = parseJSDocFields(browser)    // returns Map<typeName, Set<fieldName>>

     for each typeName in entity.types:
       sLeft  = serverFields.get(typeName)        // missing → fail "type not found"
       sRight = browserFields.get(typeName)
       missing = sLeft - sRight        // server에는 있는데 browser엔 없는 필드
       extra   = sRight - sLeft        // browser에는 있는데 server엔 없는 필드
       if (missing.size + extra.size > 0):
         fail with diff message

3. if all entities pass, exit 0
```

`CustomerPatch` / `CustomerPatchBase`는 정의 파일 텍스트에 필드 선언이 없으므로 entity registry에 들어가지 않음. PATCH 필드 = CREATE 필드라 `CustomerCreateInput` 검증으로 자동 흡수. 브라우저 측 JSDoc도 `@typedef {Partial<CustomerCreateInput>} CustomerPatch`만 적고 끝.

### Parse 정책

서버 파일과 브라우저 파일 둘 다 **regex로 텍스트 파싱** (no AST, no tsx). 이유:
- repo root `test/sync_shared_types.mjs`는 plain `node`로 실행 (master plan §6 명시). tsx/typescript runtime dep 없음
- 두 파일의 패턴이 단순·고정 (위 컨벤션이 강제)
- AST를 도입하면 비용 ↑ — sync 테스트는 회귀 차단이 본업, 정확성보다 단순함 우선

regex 추출 규칙:

**서버 (zod `z.object({ ... })` literal)**:
- 매칭 entry: `export const <TypeName> = z.object({` 부터 매칭되는 `});` 까지
- 그 블록 안에서 `^\s*(\w+)\s*:` 로 필드명 추출
- 주석 라인 (`//` 또는 `*`) 무시

**브라우저 (JSDoc `@typedef`)**:
- 매칭 entry: `* @typedef {Object} <TypeName>` 부터 다음 빈 줄 또는 다음 `* @typedef` 까지
- 그 블록 안에서 `* @property {[^}]*} (?:\[)?(\w+)` 로 필드명 추출 (optional `[]` 처리)

### 실패 출력 형식

```
sync_shared_types: FAIL — Customer
  server has but browser missing: phone, last_contacted_at
  browser has but server missing: notes
sync_shared_types: 2 differences found
```

stderr에 출력 + `process.exitCode = 1`. master plan §6 게이트가 직접 보는 출력.

### 성공 출력

```
sync_shared_types: customers OK (Customer, CustomerCreateInput, CustomerListQuery, CustomerStats)
sync_shared_types: PASS
```

### Phase 3+ entity 추가

새 entity 추가 시:
- `server/src/types/<entity>.ts` 작성
- `platform/types/<entity>.js` 작성
- `ENTITY_REGISTRY` 배열에 1 entry 추가
- 그 외 sync 테스트 파일 본문 변경 0 — regex가 entity 무관

같은 패턴이 master plan의 "후속 entity 표준" 약속 그대로.

---

## 7. Step 2 repo/service 리팩터링 (정확한 변경점)

### `server/src/repositories/customers.ts`

| 제거 | 대체 |
|---|---|
| `export type CustomerStatus`, `CustomerPlan`, `CustomerSortKey`, `SortDirection` | `import type { ... } from "../types/customers.js"` |
| `export interface Customer`, `CustomerListFilters`, `CustomerListOptions`, `CustomerCreateInput`, `CustomerPatch`, `CustomerStats` | 동일 import |
| 내부 `SORT_EXPR: Record<CustomerSortKey, string>` | 그대로 유지 (SQL 매핑은 schema와 별개 도메인) |

repository는 **type-only import**. zod runtime은 import하지 않음 — repo는 SQL emission만 담당, validation은 boundary 일.

### `server/src/services/customers.ts`

| 항목 | 본 step에서의 처리 |
|---|---|
| `class InvalidListOptionError` | **유지**. service 방어선 그대로 (본 plan §8) |
| `STATUS_SET`, `PLAN_SET`, `SORT_SET`, `DIR_SET`, `UUID_RE`, `Q_MAX_LENGTH` 상수 | 삭제. 동등 검증이 `CustomerListQuery` zod schema에 들어가 있음 |
| `clampLimit`, `clampOffset`, `pickSort`, `pickDir`, `pickStatus`, `pickPlan`, `pickAssignedUserId`, `pickQ` 함수 | 삭제. zod schema의 preprocess/transform이 동등 동작 처리 |
| `normalizeListOptions(raw: unknown): CustomerListOptions` 함수 | **유지**. 단, 내부 구현을 zod parse로 교체. zod parse 성공 시 결과 그대로 반환, `ZodError`는 catch해서 invalid status/plan/assignedUserId field에 대해 `InvalidListOptionError`로 wrap (Step 2와 동일한 throw 동작 유지) |
| `listCustomers(app, actorOrgId, rawOpts: unknown)` 시그니처 | **유지**. service가 boundary parser 역할 그대로 — Step 4 route가 `CustomerListQuery.parse(req.query)`를 먼저 해도 service가 다시 parse해도 동작 동일 (중복 parse 비용 무시 가능). Step 4 도착 전까지 service가 유일한 boundary |
| 다른 5 service 함수 시그니처 (`createCustomer`, `updateCustomer` 등) | input 인자 타입을 shared types로 교체 (`createCustomer`의 `input: CustomerCreateInput`, `updateCustomer`의 `patch: CustomerPatch` 등). 동작 그대로 |
| `import * as repo from ...` | 그대로 |

핵심: 본 step은 **ad-hoc 타입 제거 + zod source-of-truth 도입**이지 service boundary 제거가 아님. zod 도입은 `normalizeListOptions` 내부 구현 교체에 그침.

### `server/test/customers_repo.test.mjs`

테스트는 repository를 직접 호출 — 시그니처가 `client: PoolClient` + 타입 인자라 변경 없음. typed 값을 직접 객체 literal로 넘기는 패턴 그대로 (`{ name: "...", limit: 100, offset: 0, sort: "created_at", dir: "desc" }`).

repository 함수가 받는 타입 (`CustomerListOptions`/`CustomerCreateInput` 등)이 shared types로 교체되어도 같은 객체 literal이 그대로 통과 — 필드명·타입이 동일하므로 컴파일 안전. zod parse는 service 경유에서만 수행, 테스트가 직접 호출하는 repository 경로는 zod 거치지 않음.

### 회귀 안전망

리팩터링 검증 순서:
1. `server/src/types/customers.ts` 작성 → typecheck (새 파일만으로는 다른 파일 영향 없음, PASS 기대)
2. repository import 경로 교체 → typecheck (타입 동치성으로 PASS 기대)
3. service 리팩터링 (제거 + 시그니처 교체) → typecheck → test (49/49 PASS 기대)
4. 단계별 commit 안 함 — 본 step 단일 commit. 회귀 zero가 본 step의 약속.

---

## 8. Invalid input 정책 정합 — Step 2 finding §6 유지

Step 2 finding §6의 결정 (zod parse는 1차 거름망, `InvalidListOptionError`는 service 방어선으로 유지)을 **본 step에서도 그대로 유지**. 이번 step은 layer 책임을 옮기지 않고 구현만 교체:

| Layer | Step 2 (현재) | Step 3 (본 step 결과) | 변동 |
|---|---|---|---|
| boundary parser | service `normalizeListOptions` (ad-hoc `if`) | service `normalizeListOptions` (zod parse) | 구현 교체만 |
| service throw | `InvalidListOptionError(field, value)` | 동일 — `ZodError`를 catch해서 `InvalidListOptionError`로 wrap | 동일 |
| service 시그니처 | `(app, actorOrgId, rawOpts: unknown)` | 동일 | 변동 없음 |
| Step 4 route | (없음) | `CustomerListQuery.parse(req.query)` 권장. service 중복 parse는 비용 무시 가능 | Step 4에서 도입 |
| 컴파일 타임 | TS interface | shared types (`z.infer`) | 도입 |
| DB level | CHECK constraints + RLS | 동일 | 변동 없음 |

근거:
- **본 step 종료 시점에는 Step 4 routes가 아직 없음**. service에서 normalization을 빼면 boundary parser가 부재 — 49 unit 테스트는 service validation 경로를 직접 커버하지 않으므로 회귀 자동 차단도 약함
- 중복 parse 비용은 ms 미만 (zod object literal parse). 안전성 가치 >> 성능 비용
- Step 4 route 작성 후 시점에 service의 zod parse를 제거하고 typed 시그니처로 옮기는 결정은 **Step 4 plan에서 별도 검토** (본 step에서는 미정 처리)

### `CustomerListQuery` schema 작성 불변조건 (zod parse 실패 경로 좁히기)

Step 2 정책상 sort/dir/limit/offset/q는 invalid 값에서 throw하면 안 되고 status/plan/assignedUserId만 throw 대상. zod 도입 후에도 동일 동작을 보장하려면 schema 자체가 다음을 만족해야 함:

1. **`CustomerListQuery.safeParse(...)`는 status, plan, assignedUserId 외 필드 때문에 실패하지 않는다.** q/sort/dir/limit/offset은 preprocess/catch/default/clamp로 항상 정규화 — `ZodIssue` 발생 안 함
2. **q, sort, dir, limit, offset은 어떤 input이 와도 valid 결과로 정규화된다.** 위 sketch의 `ListQ`/`ListLimit`/`ListOffset`/`CustomerSortKey.catch`/`SortDirection.catch`가 이 동작 보장
3. **status, plan, assignedUserId는 invalid 시 zod가 reject (issues 발생).** preprocess는 빈 문자열/null/undefined 정규화만 — invalid enum/UUID 값은 그대로 흘려보내 `z.enum(...)` / `z.string().uuid()`가 `ZodIssue`로 reject
4. **`normalizeListOptions`는 `safeParse` 결과의 `error.issues[0].path[0]`을 읽어 field를 판별 → 그 field만 `InvalidListOptionError(field, value)`로 wrap.** path가 위 셋 중 하나가 아니면 schema 작성이 잘못된 것 — assert로 즉시 fail (개발 시점 회귀 안전망)

이 불변조건은 Step 2 정책의 zod 등가물. schema 변경 시 이 4가지를 깨면 안 됨.

본 step finding (`PHASE_2_STEP_3_FINDINGS.md`)에 "Step 2 finding §6 결정 유지, 구현만 zod로 교체 + 불변조건 4개" 명시. Step 4 진입 시 재검토 가능 항목.

---

## 9. Step 4 routes에 미치는 영향 (참고용)

본 step의 결과로 Step 4 (REST routes) 작성자가 보게 되는 모습:

```ts
// server/src/routes/customers.ts (Step 4 sketch — 본 step에서는 작성 안 함)
import { CustomerCreateInput, CustomerPatch, CustomerListQuery } from "../types/customers.js";
import * as service from "../services/customers.js";

app.get("/customers", { preHandler: [requireAuth, orgContext] }, async (req, reply) => {
  const query = CustomerListQuery.parse(req.query);   // zod boundary
  return service.listCustomers(app, req.user.orgId, query);   // typed
});

app.post("/customers", { preHandler: [requireAuth, requireRole("admin","manager","employee")] }, async (req, reply) => {
  const input = CustomerCreateInput.parse(req.body);
  const customer = await service.createCustomer(app, req.user.orgId, input);
  return reply.code(201).send({ customer });
});
```

### Step 4가 반드시 해야 할 일 — `ZodError → 400` 매핑

기본 Fastify error handler는 `ZodError`를 자동으로 400으로 매핑하지 **않는다** (현재 코드에 그런 핸들러 없음, default는 500). **Step 4에서 다음 중 하나를 반드시 추가**:

- 옵션 A: 라우트별 try/catch — `ZodError` catch → `reply.code(400).send({ error: ..., details: err.flatten() })`
- 옵션 B: `app.setErrorHandler()`로 전역 핸들러 등록 — `ZodError` instance면 400으로 매핑
- 옵션 C: 작은 helper (`parseBody(schema, req)`) — parse + 실패 시 throw `HttpError(400, ...)`로 변환

본 step에서는 결정하지 않음. Step 4 plan에서 옵션 선택 + route 테스트에서 400 응답 검증.

**현재 service 방어선 (`InvalidListOptionError`)와의 관계**: route가 위 옵션 중 하나로 zod 처리하면 service의 `InvalidListOptionError`는 route → service 경로에서는 거의 발동 안 함 (route가 이미 catch). 그러나 service의 zod re-parse가 redundant하게 같은 throw를 일으킬 수 있으므로 Step 4 plan에서 service 방어선 제거 vs 유지를 별도로 결정.

본 step의 산출물은 routes가 위 형태로 작성될 수 있는 **재료**까지. routes 본체는 Step 4 plan에서.

---

## 10. 위험·미정

| 항목 | 처리 |
|---|---|
| `Customer` zod schema에 `last_contacted_at: z.date()` — DB row의 pg `Date`가 곧 JS `Date`이므로 type-level 정합. runtime parse는 안 함 | service가 DB row를 zod parse하지 않음 (§2-7). type derivation 전용 |
| `CustomerPatchBase` export — 다른 곳에서 import해서 잘못 쓰면 refine 우회 가능 (sync 검증 대상은 아님) | 본 step finding에 "라우트나 테스트가 raw partial schema가 필요할 때만 사용, 실제 PATCH validation은 `CustomerPatch`만"을 명시. naming convention (`*Base`) 자체가 신호 |
| sync 대상 schema 컨벤션 위반 (`.extend`/`.merge`/`.partial`/`satisfies` 등) | 컨벤션을 §6에 명시. 위반된 schema가 sync 대상 list에 들어가면 regex 파서가 "type not found"로 fail → 회귀 자동 차단 |
| zod major version (4.x → 5.x) bump 시 schema syntax 변화 | caret range로 lock — minor bump는 자동, major는 manual. lock 파일에 정확 버전 핀. major bump는 phase 종료 시점 검토 |
| sync 테스트가 regex 기반 — 미래 type 정의 형식이 바뀌면 깨짐 (e.g., `z.object` 대신 다른 builder) | 정의 형식을 컨벤션으로 유지 (zod object + JSDoc typedef). 변경 시 sync 테스트 regex도 동시 갱신. 본 step finding에 정의 컨벤션 명시 |
| 브라우저 JSDoc 사본은 enforcement 없어 PR 리뷰가 잊으면 drift | sync 테스트가 CI/local 검증의 회귀 차단. drift 발견 시 무관 PR이라도 빨리 fail. master plan §6 게이트에 항상 포함 |
| `test/sync_shared_types.mjs`가 master plan §6의 16/16 e2e와 별개 게이트 | 그대로 둠. 두 게이트가 차원이 다름 (e2e = 동작, sync = 타입 정합) |
| Phase 3 새 entity 추가 시 `ENTITY_REGISTRY` 배열 1줄 추가 잊으면 sync 통과 | drift 자체는 회귀 차단되지만, 새 entity는 등록 안 되면 검증 자체가 안 됨. 본 step finding에 "entity 추가 PR checklist"로 1줄 명시 |
| Step 2 service의 `app: FastifyInstance` 첫 인자 패턴 유지 | 변경 없음. shared types 도입은 인자 타입만 바꿈, service 구조 유지 |
| Step 2의 `CustomerListFilters` (count용 filter-only subset) 타입은 어디로? | shared types에 noise 추가하지 않음. repository 내부 type alias로 유지 (`type CustomerListFilters = Pick<CustomerListQuery, "q"\|"status"\|"plan"\|"assignedUserId">` 같은 derived). repo import는 변경되어도 사용처 동일 |

---

## 11. 완료 기준 (Step 3 — go/no-go)

- [ ] `server/package.json` `dependencies`에 `zod`가 `^X.Y.Z`로 추가됨, `package-lock.json`도 갱신
- [ ] `server/src/types/customers.ts` 작성 — **export 대상 (전체)**: `CustomerStatus`, `CustomerPlan`, `CustomerSortKey`, `SortDirection`, `Customer`, `CustomerCreateInput`, `CustomerPatchBase`, `CustomerPatch`, `CustomerListQuery`, `CustomerStats` (zod schema + `z.infer` types)
- [ ] **sync 검증 대상 (4개)** — `Customer`, `CustomerCreateInput`, `CustomerListQuery`, `CustomerStats`. 모두 §6 컨벤션 (top-level `export const X = z.object({ ... })` literal) 준수
- [ ] `platform/types/customers.js` 작성 — `Customer`, `CustomerCreateInput`, `CustomerPatch`(=`Partial<CustomerCreateInput>`), `CustomerListQuery`, `CustomerStats` JSDoc typedef 모두 표현 (`CustomerStatus`/`CustomerPlan`도 string literal union)
- [ ] `test/sync_shared_types.mjs` 작성 + customers entity registry 등록 (sync 대상 4개)
- [ ] `npm --prefix server run typecheck` PASS — 새 zod import + Step 2 repo/service 리팩터링 후
- [ ] `npm --prefix server test` **49/49 회귀 PASS** — Step 2 cases 모두 무변경. service 시그니처/`InvalidListOptionError`/`normalizeListOptions` **유지** 상태에서 통과
- [ ] `node test/sync_shared_types.mjs` PASS — sync 대상 4개 type 양쪽 필드 동일
- [ ] `node test/phase_0_5_e2e.mjs` 16/16 회귀 PASS (split-origin)
- [ ] `server/src/services/customers.ts`의 `normalizeListOptions` 내부가 zod parse로 교체됨 (ad-hoc `if`/whitelist Set 모두 제거). `InvalidListOptionError` 및 service 시그니처 (`(app, actorOrgId, rawOpts: unknown)`)는 유지
- [ ] **`CustomerListQuery` 불변조건 4개 (§8) 충족** — `safeParse`가 status/plan/assignedUserId 외 필드로 실패하지 않음 / q·sort·dir·limit·offset은 항상 정규화 / status·plan·assignedUserId만 invalid 시 reject / `normalizeListOptions`가 issue path로 field 판별해 `InvalidListOptionError`로 wrap
- [ ] `server/src/repositories/customers.ts`, `server/src/services/customers.ts`가 `../types/customers.js`에서 type을 import (ad-hoc 정의 제거)
- [ ] `docs/plan/phase-2/PHASE_2_STEP_3_FINDINGS.md` 작성 (구현 + 검증 후 별도 커밋)

---

## 12. 한 줄 요약

> **반나절 동안 zod runtime dep 추가 + `server/src/types/customers.ts` (zod source-of-truth) + `platform/types/customers.js` (JSDoc 사본) + `test/sync_shared_types.mjs` (필드명 diff)를 깔고 Step 2 ad-hoc TS interface를 shared types import로 일원화해, Phase 3+ 새 entity가 같은 3-파일 패턴으로 흡수되는 표준 정착.**

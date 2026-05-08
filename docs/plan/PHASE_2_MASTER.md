# Phase 2 — Customers CRUD 마스터 플랜

> **상위 계획**: `docs/plan/BACKEND_PLAN.md` v0.4 §8 Phase 2.
> **선행 단계**: Phase 1 완료 — `docs/plan/PHASE_1_MASTER.md`.
> **기간**: 1~1.5주 (sub-step 단위로 분해).
> **단계별로 진행**한다. 한 sub-step이 끝나야 다음으로 간다.

---

## 진행 상태 (Implementation Log)

> 이 섹션은 sub-step 진행 시 갱신된다. 본 plan은 master로, 각 sub-step은 별도 `PHASE_2_STEP_X_*.md` 문서에서 상세 설계.

- [ ] **Step 1** — `customers` 스키마 + RLS 정책 + 시드 → `docs/plan/PHASE_2_STEP_1_SCHEMA.md`
- [ ] **Step 2** — Repository + service + RLS 격리 단위 테스트 → `docs/plan/PHASE_2_STEP_2_REPO.md`
- [ ] **Step 3** — Shared types 도입 + zod validation 패턴 (Phase 0.5 인계 deferred 처리) — `server/src/types/customers.ts` source-of-truth + `platform/types/customers.js` JSDoc 사본 + sync 테스트. **`zod` 의존성 추가** → `docs/plan/PHASE_2_STEP_3_SHARED_TYPES.md`
- [ ] **Step 4** — REST routes (6 endpoints) + role 미들웨어 통합 + zod schema import + route 테스트 → `docs/plan/PHASE_2_STEP_4_ROUTES.md`
- [ ] **Step 5** — `platform/customers.html` 실 API 연결 + new customer 모달 + 검색·필터·페이지네이션 → `docs/plan/PHASE_2_STEP_5_CLIENT.md`
- [ ] **Step 6** — Customers e2e + findings + master plan 동기화 → `docs/plan/PHASE_2_STEP_6_E2E.md`

---

## 0. 왜 Phase 2인가

Phase 1은 **인증·격리·권한 기반**을 만들었다. 그 위에 무엇이든 올릴 수 있게 됐지만 **아직 실제 비즈니스 데이터는 하나도 없다**. Phase 2는 그 위에 첫 비즈니스 entity를 얹는다 — **customers** (고객).

핵심 산출물:

1. **고객 데이터의 영속화** — `customers` 테이블 + RLS + repository 패턴
2. **CRUD REST 표준 패턴 정립** — list/get/create/update/delete + stats = 6개 엔드포인트 + 권한 분기
3. **`customers.html` mock → 실 데이터 전환** — 평가자가 진짜 입력·수정·삭제를 시도해볼 수 있는 첫 페이지
4. **Shared types 도입** — Phase 0.5 인계 항목 (Phase 1 Step 4 §10 deferred). Phase 2 첫 entity가 곧 패턴 결정점

이걸 다 끝내고 나면 Phase 3 (회원가입/이메일/팀 초대)로 넘어간다.

---

## 1. 범위 (Scope)

### 한다

**스키마**
- `customers` 테이블 (`org_id`로 RLS 격리, soft delete, `assigned_user_id` 이미 박아둠)
- 인덱스 (검색 ILIKE + 필터 status/plan + soft delete 제외 partial index)
- 4개 RLS 정책 (SELECT / INSERT / UPDATE / DELETE)
- seed: Acme + Beta 각 12명 (mock UI와 동등 외관, 평가자가 즉시 데이터 보이게)

**서버**
- `repositories/customers.ts` (RLS-aware repository)
- `services/customers.ts` (search + 권한 검증 + soft delete)
- `routes/customers.ts`:
  - `GET /customers` — list + 검색/필터/페이지네이션
  - `GET /customers/stats` — 4 KPI (전체/활성/검토중/대기)
  - `GET /customers/:id` — 단건
  - `POST /customers` — 생성 (admin/manager/employee)
  - `PATCH /customers/:id` — 부분 수정 (admin/manager/employee)
  - `DELETE /customers/:id` — soft delete (admin/manager/employee). Phase 2 권한 단순화 (사전 결정 §2-2)에 정합 — soft delete라 운영 복구 가능. **viewer만 차단**
- 모든 핸들러는 `requireAuth` + `withOrgContext` + `requireRole` 조합

**Shared types (Phase 0.5 인계 마지막 deferred 항목)**
- `server/src/types/customers.ts` — server side source-of-truth (TS interfaces + zod schemas)
- `platform/types/customers.js` — JSDoc-only 브라우저 사본 (build step 없음)
- 동기화 검증: `test/sync_shared_types.mjs` — diff 검출 시 fail
- 패턴 정립: 향후 entity (calls, transcripts, etc.)도 동일 방식 따름

**클라이언트**
- `platform/customers.html` mock JS 제거, 실 API 호출로 교체
- New customer 모달 → `kloserApi.apiPost('/customers', ...)` 실작동
- 검색·필터·페이지네이션 → URL query string 매핑
- 4 KPI는 `/customers/stats`에서 fetch
- 행 클릭 상세 패널은 본 step 범위에 **포함하지 않음** (UI 신규 작업) — Phase 4+에서 통화 기록 결합 시점

**검증**
- 서버 단위 테스트: customers CRUD + RLS 격리 (다른 org 데이터 안 보임 / org A admin이 org B customer 생성 시도 차단)
- viewer write 차단 단위 테스트
- e2e: 로그인 → customers 페이지 → 신규 추가 → 수정 → 삭제 → 다른 org 계정으로 재로그인 시 보이지 않음
- Phase 0.5 e2e 16/16 회귀 (영향 없어야 함)

### 안 한다 (Phase 3+로 미룸)

**팀 단위 권한 분기** — manager가 자기 팀 customer만 write 가능하게 하는 정책. Phase 2에선 admin/manager/employee 모두 org-wide read/write로 단순화. team scope은 Phase 3 (team 초대 + 팀원 권한 활성화) 시점에 도입.

**고급 검색** — Postgres trigram 인덱스, full-text search. Phase 2에서는 ILIKE로 충분 (예상 데이터 < 1만 건).

**감사 로그(audit_log)** — `customers` 변경 추적. 테이블은 Phase 1에서 만들어뒀지만 hook은 Phase 2에서 미도입. Phase 4 (통화 기록과 묶어서 처리) 또는 별도 Phase에서.

**Bulk operations** — CSV import / bulk update. Phase 6+ enterprise 단계.

**HubSpot/Salesforce 동기화** — Phase 6 (v2 베타).

**행 클릭 상세 패널** — UI 신규 작업이고 customer-단독 정보로는 빈약. Phase 4 통화 기록과 묶을 때 같이.

---

## 2. 사전 결정 (Phase 2 시작 전 확정)

| 항목 | 결정 | 근거 |
|---|---|---|
| 1. Soft vs hard delete | **Soft delete** — `deleted_at timestamptz NULL` 컬럼. 모든 SELECT는 partial index `WHERE deleted_at IS NULL` | 영업 데이터는 실수 복구 가치가 높음. 비용 거의 0. partial index로 성능 영향도 미미 |
| 2. Permission 정책 (Phase 2 시점) | admin/manager/employee 모두 org-wide read + write. **viewer만 read only**. team scope은 Phase 3로 deferred | Phase 2 시점엔 team이 아직 mock. 단순함 우선. Phase 3에서 team 초대 활성화 시 manager/employee는 자기 팀 customer만 write로 좁힘 |
| 3. 페이지네이션 | **offset + limit + total count** (max limit 100, default 20). cursor 기반은 Phase 6+ 데이터 양 늘면 도입 | <1만 건 예상. offset이 단순하고 mock UI의 페이지 표시와도 매핑 자연스러움 |
| 4. 검색 | **ILIKE** on `name + email + company` (UNION 또는 OR). trigram·tsvector는 Phase 5+ | <1만 건이라 ILIKE seq scan도 ms 단위. 인덱스: `(org_id, lower(name) text_pattern_ops)` 등 prefix-only로 충분 |
| 5. status enum 형식 | **text + CHECK** (`'active'`, `'review'`, `'pending'`) | postgres ENUM은 ALTER가 비싸 (DDL lock). text + CHECK가 운영 친화적 |
| 6. plan 형식 | **text NULLABLE + CHECK** (`'Starter'`, `'Pro'`, `'Enterprise'`, NULL). NULL = "미할당" — mock UI의 "-" 표시에 매핑 | mock UI 그대로 매핑. 추후 플랜 추가 시 CHECK만 갱신 |
| 7. assigned_user_id | nullable uuid FK `users.id` ON DELETE SET NULL | 사용자가 떠나도 customer는 보존, 단지 unassigned로 전환. team_id는 본 step에서 추가 안 함 (Phase 3) |
| 8. last_contacted_at | nullable timestamptz | 통화 기록 후크는 Phase 4. Phase 2에서는 manual update만 (PATCH 본체 일부) |
| 9. Validation | zod schema on server + JSDoc-typed brower copy | manual JSON.parse + if 체크는 Phase 1 auth route에서 한 번 해봤고 양식이 길어짐. zod는 server route 수가 늘어날수록 가성비 |
| 10. Shared types 패턴 | **Option B**: `server/src/types/<entity>.ts` (TS + zod, source-of-truth) + `platform/types/<entity>.js` (JSDoc-only 사본) + `test/sync_shared_types.mjs` (diff 검증). bundler 미도입 | 정적 페이지에 build step 도입은 부담. JSDoc 사본은 enforcement 없지만 sync 테스트가 회귀 차단. Phase 6+ bundler 도입 시 자연스럽게 단일화 |
| 11. POST/PATCH 응답 형식 | 새 row 전체 반환 (`{ customer: {...} }`). 클라가 추가 GET 없이 캐시 갱신 가능 | REST 일반 패턴. 응답 크기 작음 |
| 12. 검색·필터 query string | `?q=&status=&plan=&assigned=me&offset=&limit=&sort=` — URL이 곧 view state | 브라우저 뒤로 가기 / 북마크 가능. mock UI의 `activeFilter` state를 URL로 승격 |
| 13. Stats endpoint | `GET /customers/stats` 별도 — `{ total, active, review, pending }` (4 필드, mock UI의 4 KPI 카드와 1:1). `my_customers`는 Phase 3 (team-scope 도입 시점)으로 deferred — assigned_user 기반 filter는 list query string (`?assigned=me`)으로 충분 | 4 KPI 카드를 list 응답 metadata에 끼워 넣으면 list cache invalidation이 stat까지 끌고 옴. 분리가 깔끔. my_customers 추가 시점은 team-scope이 함께 들어올 때 |
| 14. seed 동등성 | mock UI의 12명을 그대로 Acme org seed에 박고, Beta org에 다른 12명 (격리 시각 검증용) | 평가자가 evaluation 시 즉시 진짜 데이터를 보이게. mock UI가 실 API로 전환된 직후 같은 외관 유지 |

---

## 3. Sub-step 분해 (실행 순서)

### Step 1 — Schema + RLS + Seed (1일)

**목표**: `customers` 테이블 + 4개 RLS 정책 + 인덱스 + seed가 깨끗이 깔린다.

**산출물**:
- `server/migrations/<timestamp>_customers.sql` — 테이블 + 정책 + 인덱스
- `server/seeds/0002_customers.sql` — 24명 (Acme 12 + Beta 12)
- `docs/plan/PHASE_2_STEP_1_SCHEMA.md` — 컬럼·정책·인덱스 사전 결정
- `docs/plan/PHASE_2_STEP_1_FINDINGS.md` — 결과 인계

**완료 기준**:
- `npm run db:migrate:up` → customers 테이블 생성 + RLS FORCE ENABLE 확인
- `npm run db:seed` → 24명 seed 적재
- raw SQL로 (admin URL) `SELECT count(*) FROM customers` = 24
- app role + `set_config('app.org_id', acme)` 컨텍스트로 SELECT → 12 (격리 동작)

### Step 2 — Repository + Service + 격리 단위 테스트 (1일)

**목표**: `customers` repository/service가 RLS 컨텍스트 위에서 안전하게 CRUD 동작 + 다른 org 데이터 접근이 SQL 단에서 차단되는 것을 단위 테스트로 고정.

**산출물**:
- `server/src/repositories/customers.ts`
- `server/src/services/customers.ts` (search, soft-delete, role 검증 헬퍼)
- `server/test/customers_repo.test.mjs` — RLS 격리 + CRUD 7~10 cases

**완료 기준**:
- 단위 테스트 통과
- org A 컨텍스트에서 org B customer SELECT → 0 rows
- org A 컨텍스트에서 org B customer UPDATE → 0 rows affected (RLS USING 거부)

### Step 3 — Shared Types + Validation 패턴 (0.5일)

**목표**: `server/src/types/customers.ts`가 source-of-truth (zod schema + 유추 TS types). `platform/types/customers.js`는 JSDoc-only 브라우저 사본. `test/sync_shared_types.mjs`가 양쪽 diff 검출. **Step 4의 REST routes가 이 zod schema를 import해서 validation에 사용**하므로 routes보다 먼저 깔린다.

**산출물**:
- **`server/package.json` + `package-lock.json`** — `zod` runtime dependency 추가 (현재 미설치). `npm install zod --save --prefix server` 실행 후 lock 파일 commit.
- `server/src/types/customers.ts` — `Customer`, `CustomerCreateInput`, `CustomerUpdateInput`, `CustomerListQuery` 등 zod schema + `z.infer<typeof ...>`로 유추한 TS types. **Step 3에서 Step 2 repo/service 타입을 shared types import로 리팩터링** — Step 2는 ad-hoc TS interface로 시작했다가 Step 3에서 source-of-truth로 일원화하는 흐름. 이 리팩터링은 Step 3의 명시적 산출물.
- `platform/types/customers.js` — JSDoc typedef 사본 (`@typedef {{ id: string, name: string, ... }} Customer` 형식). 같은 필드·열거값을 그대로 mirror.
- `test/sync_shared_types.mjs` — 두 파일에서 entity별 필드 list를 추출해 diff. set difference 발생 시 fail. customers + 향후 entity 모두 같은 검증 통과.
- `docs/plan/PHASE_2_STEP_3_SHARED_TYPES.md` — 패턴 문서: server source-of-truth → JSDoc 사본 → sync 검증의 절차. Phase 3+ 새 entity 추가 시 동일 단계 follow.

**완료 기준**:
- `npm --prefix server run typecheck` PASS (새 zod import 포함)
- `npm --prefix server test` 회귀 통과 (Step 2 customer repo+service가 새 타입을 import해도 깨지지 않음)
- `node test/sync_shared_types.mjs` PASS — customers entity 양쪽 필드 동일
- Step 2의 service가 `CustomerCreateInput` 타입으로 입력을 받음 (이전엔 ad-hoc TS interface)

### Step 4 — REST Routes + Role Middleware + Route 테스트 (1.5일)

**목표**: 6개 엔드포인트 (`GET /customers`, `GET /customers/stats`, `GET /customers/:id`, `POST`, `PATCH`, `DELETE`)가 200/4xx로 정확히 동작 + viewer write 차단.

**산출물**:
- `server/src/routes/customers.ts` — Step 3의 zod schemas를 import해서 body/query validation. 모든 핸들러는 `requireAuth` + `withOrgContext` + `requireRole(...허용 역할)` 조합.
- 등록을 `server/src/server.ts`에 추가
- `server/test/customers_routes.test.mjs` — happy path + 4xx (validation 실패) + viewer 차단 + multi-org 격리 (다른 org JWT로 GET → 본인 org 데이터만)

**완료 기준**:
- `npm --prefix server test` 47/47 (37 + 신규 ~10) PASS
- `curl` 수동 검증: 로그인 → access token → 6개 endpoint 모두 200 응답
- viewer JWT로 POST/PATCH/DELETE → 403

### Step 5 — `customers.html` 실 API 연결 (1.5일)

**목표**: mock 12명 하드코딩 제거 + `kloserApi.apiGet/apiPost/apiPatch` 호출 + 검색·필터·페이지네이션 → URL query string + new customer 모달 실작동.

**산출물**:
- `platform/customers.html` 갱신 — mock JS 제거, fetch 흐름 도입
- 4 KPI 카드 → `GET /customers/stats` 호출
- 검색·필터 input/chip → URL query string 동기화 (history.replaceState)
- new customer 모달 → POST + 성공 시 list 갱신
- 행 클릭 시 inline 수정 또는 PATCH (행 inline edit이 모달보다 가볍음 — Phase 2 결정점)
- 삭제 → soft delete confirm → DELETE

**완료 기준**:
- 브라우저에서 4가지 시나리오 시각 확인:
  1. 로그인 → customers 페이지 → 12명 표시 (Acme seed)
  2. "신규 추가" → 모달 입력 → 저장 → 목록에 추가 + 4 KPI total +1
  3. 행 inline edit (또는 PATCH 모달) → 저장 → 즉시 반영
  4. 삭제 → confirm → 목록에서 제거 + KPI 갱신
- 다른 org (Beta) 계정으로 로그인 → 다른 12명 표시 (격리 시각 확인)

### Step 6 — Customers e2e + Findings (0.5일)

**목표**: customers 흐름 자동 회귀 + Phase 2 종료 인계.

**산출물**:
- `test/phase_2_customers_e2e.mjs` (또는 `phase_0_5_e2e.mjs`에 customers 케이스 추가) — 6~8 PASS
- `docs/plan/PHASE_2_STEP_6_E2E.md` (실행 절차)
- `docs/plan/PHASE_2_STEP_6_FINDINGS.md` (Phase 2 종합 인계)
- 모든 master plan / step plan 체크박스 동기화
- 루트 `README.md` + `server/README.md` 상태 블록 갱신

**완료 기준**:
- 새 e2e PASS
- Phase 0.5 e2e 16/16 회귀 PASS
- master plan §6 게이트 모두 충족
- branch가 main에 머지 가능한 상태

---

## 4. 데이터 모델

```sql
CREATE TABLE customers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- core profile
  name                text NOT NULL,
  company             text,
  email               citext,
  phone               text,

  -- classification
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('active','review','pending')),
  plan                text
                        CHECK (plan IS NULL OR plan IN ('Starter','Pro','Enterprise')),

  -- relations
  assigned_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,

  -- timestamps
  last_contacted_at   timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;

-- Indexes (모두 partial 'WHERE deleted_at IS NULL')
CREATE INDEX customers_org_status_idx
  ON customers (org_id, status) WHERE deleted_at IS NULL;
CREATE INDEX customers_org_plan_idx
  ON customers (org_id, plan) WHERE deleted_at IS NULL AND plan IS NOT NULL;
CREATE INDEX customers_org_assigned_idx
  ON customers (org_id, assigned_user_id) WHERE deleted_at IS NULL;
CREATE INDEX customers_org_lower_name_idx
  ON customers (org_id, lower(name) text_pattern_ops) WHERE deleted_at IS NULL;
CREATE INDEX customers_org_lower_email_idx
  ON customers (org_id, lower(email::text) text_pattern_ops) WHERE deleted_at IS NULL AND email IS NOT NULL;
CREATE INDEX customers_org_lower_company_idx
  ON customers (org_id, lower(company) text_pattern_ops) WHERE deleted_at IS NULL AND company IS NOT NULL;

-- RLS policies (4) — Phase 1의 current_app_org_id() helper 사용. helper는
-- 1715000000000_init.sql §148에서 정의됨:
--   CREATE OR REPLACE FUNCTION current_app_org_id() RETURNS uuid
--   LANGUAGE sql STABLE AS $$
--     SELECT NULLIF(current_setting('app.org_id', true), '')::uuid
--   $$;
-- NULLIF + missing-second-arg 처리로 GUC 미설정/blank 케이스에서 안전 (cast
-- 직접 호출은 ''에 cast 시도해 throw — 그래서 helper 표준 채택).
CREATE POLICY customers_select ON customers FOR SELECT
  USING (org_id = current_app_org_id());

CREATE POLICY customers_insert ON customers FOR INSERT
  WITH CHECK (org_id = current_app_org_id());

CREATE POLICY customers_update ON customers FOR UPDATE
  USING      (org_id = current_app_org_id())
  WITH CHECK (org_id = current_app_org_id());

CREATE POLICY customers_delete ON customers FOR DELETE
  USING (org_id = current_app_org_id());
```

> Phase 1과 동일 패턴: `app.org_id` GUC 기반 + `current_app_org_id()` helper + FORCE ROW LEVEL SECURITY + 운영(`kloser` admin) role은 BYPASSRLS로 마이그레이션·시드만 처리.

---

## 5. 위험·미정 — Phase 3+로 넘기는 것

| 항목 | Phase 2에서의 처리 | Phase 3+ |
|---|---|---|
| team-scope 권한 | admin/manager/employee 모두 org-wide write로 단순화 | Phase 3 (team 초대 활성화 시점)에서 manager/employee는 자기 팀만 |
| 감사 로그 (`activity_log`) | 미구현 — Phase 1에서 테이블만 존재 | Phase 4 (통화 기록과 같이) |
| Bulk import (CSV 등) | 미구현 | Phase 6+ enterprise |
| 외부 시스템 동기화 (HubSpot 등) | 미구현 | Phase 6 (v2 베타) |
| Soft-deleted customer 복구 UI | 미구현 (DB 차원 레코드는 보존됨) | Phase 4+ admin 콘솔 |
| Customer 행 클릭 상세 패널 | 미구현 | Phase 4 (통화 기록 결합 시) |
| Validation 에러 메시지 다국어 | server는 영어 code, client에서 번역 | Phase 6+ i18n 본격 도입 시 |
| Phase 0.5 e2e와 customers e2e 통합 | 별도 파일로 분리 시작 | Phase 6+ CI 도입 시점에 통합 검토 |

---

## 6. 완료 기준 (Phase 2 전체 — go/no-go gate)

다음을 모두 만족하면 Phase 2 종료, Phase 3 (회원가입/이메일/팀 초대) 착수.

- [ ] `npm --prefix server run typecheck` PASS (`zod` import 포함)
- [ ] `npm --prefix server test` PASS (37 + 신규 customers ~15 = 50+)
- [ ] `node test/phase_0_5_e2e.mjs` 16/16 회귀 PASS (split-origin)
- [ ] `node test/phase_2_customers_e2e.mjs` (또는 통합) PASS
- [ ] `node test/sync_shared_types.mjs` PASS (server source-of-truth ↔ browser JSDoc 사본 정합)
- [ ] `server/package.json`에 `zod` runtime dependency 추가됨 + `package-lock.json` commit
- [ ] `customers` 테이블 + `current_app_org_id()` 기반 4 RLS 정책 + 6 인덱스 + 24명 seed 적용됨
- [ ] 6개 customer endpoint (`GET /customers`, `GET /customers/stats`, `GET /customers/:id`, `POST`, `PATCH`, `DELETE`) 모두 200/4xx 정확히 응답
- [ ] viewer JWT로 POST/PATCH/DELETE 호출 시 403
- [ ] 다른 org JWT로 customer 접근 시 본인 org 데이터만 보임 (RLS 격리 e2e 통과)
- [ ] `platform/customers.html`이 mock 데이터 사용 안 함 — 실 API 호출만
- [ ] new customer 모달이 실작동 (POST + 즉시 목록 갱신)
- [ ] Shared types 패턴 `sync_shared_types.mjs` 통과
- [ ] `docs/plan/PHASE_2_STEP_1_FINDINGS.md` ~ `PHASE_2_STEP_6_FINDINGS.md` 작성됨
- [ ] 루트 `README.md` + `server/README.md` 상태 블록 Phase 2 완료로 갱신

하나라도 실패하면 해당 step에 머문다.

---

## 7. Phase 1 → Phase 2 인계 사항

Phase 1 findings에서 Phase 2 진입 시점에 처리하기로 한 항목:

1. **Shared types 도입** (Phase 1 Step 4 §10) — 본 plan §1 / §2-10 / Step 3에서 처리
2. **`requireFreshRole` opt-in 헬퍼** (Phase 1 Step 3 §6) — Phase 2의 destructive endpoint (DELETE customer)에서 도입 검토. 현재 결정: **Phase 2에서 도입하지 않음** — DELETE는 soft delete라 즉시 복구 가능, role staleness 15분이 중대한 위험 아님. Phase 3 (회원가입·역할 변경 잦아짐) 시점에 본격 도입.
3. **`listActiveMembershipsAcrossOrgs` O(orgs) scan** (Phase 1 Step 3 §8) — login 흐름과 무관한 customers 작업이라 본 step에선 다루지 않음. Phase 6+ org 수가 커질 때.
4. **`CommitAuthError` COMMIT 실패 시 client leak** (Phase 1 Step 3 §7) — auth 흐름 한정 이슈, customers와 무관. 별도 시점에 처리.
5. **`requireRole` style consistency** (Phase 1 Step 3 §9) — 사소함. Phase 2 routes 작성 시 같은 함수를 호출하면 자연스럽게 정합.

---

## 8. 한 줄 요약

> **1~1.5주 동안, 6개 sub-step으로 customers 테이블·RLS·CRUD·shared types·UI 통합·e2e를 차례로 깔아서, 평가자가 진짜 입력·수정·삭제 가능한 첫 비즈니스 entity를 완성하고 향후 entity 추가의 표준 패턴을 정립한다.**

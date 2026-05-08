# Phase 2 Step 1 — Customers schema + RLS + seed

> **상위 계획**: `docs/plan/PHASE_2_MASTER.md` §3 Step 1 + §4 데이터 모델.
> **선행**: Phase 1 완료 — `docs/plan/PHASE_1_MASTER.md`.
> **기간**: 1일.
>
> ⚠️ **본 문서는 도입 시점 (1715000002000_customers.sql) 기준이다.** Step 5 findings의 domain cleanup record가 적용된 **최종 모델은 master / Step 5 findings 참조**. 본 plan에서 명시한 `plan text + CHECK ('Starter','Pro','Enterprise')` 컬럼·`customers_org_plan_idx` 인덱스는 1715000003000_drop_customers_plan.sql에서 drop 됐다.

---

## 진행 상태

- [ ] 1. 컬럼·CHECK·NULL 정책 사전 결정 검증 (본 plan §2)
- [ ] 2. 인덱스 6개 사전 결정 검증 (본 plan §3)
- [ ] 3. RLS 정책 4개 사전 결정 검증 (본 plan §4) — `current_app_org_id()` helper 재사용
- [ ] 4. seed 24명 (Acme 12 + Beta 12) 데이터 사전 결정 (본 plan §5)
- [ ] 5. `server/migrations/1715000002000_customers.sql` 작성 (Up + Down)
- [ ] 6. `server/seeds/0002_customers.sql` 작성 (idempotent)
- [ ] 7. **`server/scripts/run-seed.mjs` 갱신** — `seeds/*.sql` glob + 정렬 후 순차 적용 + `customers` count=24 check 추가 (현재는 `0001_demo.sql` hardcoded + orgs/users/memberships count만 검증). Step 1 구현 커밋에 포함 (별도 mini-commit 안 만듦)
- [ ] 8. `npm run db:migrate:up` + `npm run db:seed` 통과 — seed가 0001 + 0002 둘 다 실행됨
- [ ] 9. RLS 격리 수동 검증 (app role + GUC swap → org A 12 / org B 12)
- [ ] 10. Down 마이그레이션 검증 — `npm run db:migrate:redo`로 1715000002000만 down→up 왕복, Phase 1 테이블 영향 없음 확인
- [ ] 11. `docs/plan/PHASE_2_STEP_1_FINDINGS.md` 작성

---

## 0. 목적

Phase 2의 첫 entity인 `customers` 테이블을 안전하게 깐다. 표면적으로는 단순한 CRUD 테이블이지만 **RLS 정책과 인덱스가 한 번 잘못 들어가면 후속 step (repo / routes / UI) 전체가 흔들리거나 운영 단계에서 정책 변경이 어려워지므로**, schema 단계에서 사전 결정을 한 번 더 점검한 뒤 migration을 작성한다.

이 step이 끝나면:
- `customers` 테이블이 FORCE RLS 상태로 존재
- 4개 RLS 정책이 `current_app_org_id()` 위에서 동작
- 6개 partial 인덱스가 deleted_at 필터 + org_id 분기를 흡수
- 24명 seed가 양쪽 org에 적재돼 평가자가 즉시 시각 격리 검증 가능

---

## 1. 마이그레이션 파일 + 의존성

| 항목 | 결정 | 근거 |
|---|---|---|
| 파일명 | `server/migrations/1715000002000_customers.sql` | Phase 1 convention (`1715000000000_init.sql`, `1715000001000_auth_sessions.sql`)을 +1000 increment로 이어감. node-pg-migrate가 timestamp prefix 순서로 적용 |
| 마커 | `-- Up Migration` / `-- Down Migration` | Phase 1 Step 1 finding §1에서 `-- Up`은 인식 안 된다고 확인됨. 정확히 v7 magic string 사용 |
| seed 파일명 | `server/seeds/0002_customers.sql` | Phase 1 seed (`0001_demo.sql`)의 +1 |
| **seed wrapper 갱신** | **`server/scripts/run-seed.mjs` — `0001_demo.sql` hardcoded → `seeds/*.sql` glob+정렬+순차 적용으로 변경**. checks도 `customers count=24` 추가. Step 1 구현 커밋에 포함 | 현재 wrapper는 `SEED_FILE = "seeds/0001_demo.sql"` 상수 한 줄로 묶여 있어 0002를 인식하지 못함. wrapper를 1회 일반화하면 Phase 3+ entity seed 추가 시 무수정으로 흡수 |
| 의존성 | 없음 — Postgres 16 기본 + `pgcrypto`/`citext` extension은 Phase 1 Step 1에서 이미 활성화됨 | 새 extension 도입 안 함. trigram·pgvector는 Phase 5+ |
| 적용 권한 | `MIGRATE_DATABASE_URL` (admin role, BYPASSRLS) | Phase 1과 동일. seed가 RLS GUC 신경 안 쓰고 INSERT 가능 |

---

## 2. 컬럼 사전 결정

| 컬럼 | 타입 | NULL | 기본값 | 비고 |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` | PRIMARY KEY |
| `org_id` | `uuid` | NOT NULL | — | FK `organizations(id) ON DELETE CASCADE`. RLS 분기의 키 |
| `name` | `text` | NOT NULL | — | 검색 대상 |
| `company` | `text` | NULL 허용 | — | 일부 customer는 회사 정보 없음 (미식별 단계). 검색 대상 |
| `email` | `citext` | NULL 허용 | — | citext로 case-insensitive. 검색 대상 |
| `phone` | `text` | NULL 허용 | — | 형식 검증은 클라/zod 단계. 한국 휴대폰 우선 (format은 free-text) |
| `status` | `text` | NOT NULL | `'pending'` | `CHECK (status IN ('active','review','pending'))`. mock UI와 1:1 |
| `plan` | `text` | NULL 허용 | NULL | `CHECK (plan IS NULL OR plan IN ('Starter','Pro','Enterprise'))`. NULL = mock UI의 "-" 표시에 매핑 |
| `assigned_user_id` | `uuid` | NULL 허용 | NULL | FK `users(id) ON DELETE SET NULL`. 사용자 떠나도 customer 보존 |
| `last_contacted_at` | `timestamptz` | NULL 허용 | NULL | Phase 4 통화 후크 시 자동 갱신. Phase 2에선 PATCH 본체로 manual update만 |
| `created_at` | `timestamptz` | NOT NULL | `now()` | |
| `updated_at` | `timestamptz` | NOT NULL | `now()` | trigger 또는 service-layer touch — 본 step 결정 필요 (다음 행) |
| `deleted_at` | `timestamptz` | NULL | NULL | soft delete. 모든 SELECT가 `WHERE deleted_at IS NULL` partial index 경유 |

### 결정점: `updated_at` 갱신 방식

| 옵션 | 장단 |
|---|---|
| (a) trigger (`BEFORE UPDATE` set `updated_at = now()`) | DB가 보장. service-layer가 잊어도 안전. trigger 추가 1개 |
| (b) service-layer touch (`UPDATE ... SET updated_at = now() WHERE ...`) | trigger 없음. service 마다 호출 필요 — 누락 위험 |

**권장: (a) trigger**. Phase 1에서는 trigger 없이 `now()` default만 두고 갱신은 service 책임이었음. customers는 PATCH endpoint가 표준 entity이고, 향후 calls/transcripts 등에서 같은 패턴 반복되므로 **공통 trigger function 하나 정의 + 테이블별 trigger 등록**이 깔끔.

```sql
-- 공통 함수 (idempotent CREATE OR REPLACE)
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- customers 전용 trigger
CREATE TRIGGER customers_touch_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
```

향후 Phase 4 calls / transcripts 등에서도 같은 trigger function 재사용. 함수 자체는 본 migration에서 처음 도입.

### 결정점: email/phone unique 제약?

| 옵션 | 결정 |
|---|---|
| `(org_id, lower(email))` UNIQUE | **도입 안 함** |
| `(org_id, phone)` UNIQUE | **도입 안 함** |

근거: 영업 현장에서 같은 사람이 여러 customer 레코드로 들어가는 경우 (다른 회사·다른 시기·중복 입력)가 흔함. UNIQUE는 운영상 false-positive로 막힐 위험. 중복 검출은 **service-layer warning** (`POST /customers` 시 같은 email/phone 있으면 응답에 `duplicates: [...]` 메타 포함, 그러나 INSERT는 통과)으로 Phase 4+에서 도입 검토. **본 step에선 제약 없음**.

---

## 3. 인덱스 사전 결정

모두 partial `WHERE deleted_at IS NULL` (soft-deleted row 제외).

| 인덱스 | 컬럼 | 용도 |
|---|---|---|
| `customers_org_status_idx` | `(org_id, status)` | 4 KPI stats + status 필터 칩 |
| `customers_org_plan_idx` | `(org_id, plan) WHERE plan IS NOT NULL` | "Enterprise" 필터 칩 |
| `customers_org_assigned_idx` | `(org_id, assigned_user_id)` | 향후 `?assigned=me` query (Phase 3 team-scope 시 본격 활용) |
| `customers_org_lower_name_idx` | `(org_id, lower(name) text_pattern_ops)` | 이름 prefix 검색 (`name ILIKE 'kim%'`) |
| `customers_org_lower_email_idx` | `(org_id, lower(email::text) text_pattern_ops) WHERE email IS NOT NULL` | 이메일 prefix 검색 |
| `customers_org_lower_company_idx` | `(org_id, lower(company) text_pattern_ops) WHERE company IS NOT NULL` | 회사 prefix 검색 |

### 결정점: `text_pattern_ops` vs `gin_trgm_ops`

| 옵션 | 결정 |
|---|---|
| `text_pattern_ops` | **본 step 채택** — prefix 검색 (`'kim%'`)에는 충분. extension 추가 없음 |
| `gin_trgm_ops` (trigram) | Phase 5+ 검토. 부분일치 (`'%min%'`) 필요해지면 도입 |

mock UI의 검색 input은 단어 단위 부분일치를 의도하므로 trigram이 더 정확함. 그러나 Phase 2 시점 ILIKE seq scan + 1만건 미만이면 응답시간 ms 단위. trigram extension 도입 비용 (`pg_trgm` 활성화 + 인덱스 빌드)이 가성비 낮아 deferred.

검색 동작은 service-layer에서 `ILIKE '%${q}%'`로 양방향 매치 (인덱스 미사용 + seq scan). 1만건 미만에서는 무리 없음. 운영 진입 시 trigram으로 전환.

---

## 4. RLS 정책 사전 결정

Phase 1의 `current_app_org_id()` helper 재사용. 4 정책 (SELECT/INSERT/UPDATE/DELETE) 동일 USING + WITH CHECK 패턴.

```sql
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;

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

### 결정점: soft delete를 RLS DELETE 정책으로 막을 것인가?

| 옵션 | 결정 |
|---|---|
| `FOR DELETE` 정책 정의 (위) | **도입함** |
| `FOR DELETE` 정책 정의 안 함 (RLS가 DELETE 자체 차단 — soft delete만 허용) | **도입 안 함** |

근거: soft delete는 **service-layer가 `UPDATE customers SET deleted_at = now()`로 처리**한다 (DELETE statement 안 씀). 따라서 `FOR DELETE` 정책은 일상 흐름에선 트리거되지 않음. 그럼에도 정책을 두는 이유:

1. Phase 4+에서 admin 콘솔이 진짜 hard delete 기능을 도입할 가능성 (e.g., GDPR 요청). 그 시점에 RLS 정책이 있으면 자동으로 org 격리 보장.
2. Phase 1의 4-정책 패턴 (SELECT/INSERT/UPDATE/DELETE) 정합성. 향후 entity도 같은 4종 세트 유지 → 코드 리뷰 시 missing policy 즉시 검출.

비용: 정책 1개 추가 — 무시 가능.

### 결정점: viewer write 차단은 RLS인가 application-layer인가?

**Application-layer**. RLS는 org 격리만 강제, role 기반 분기는 `requireRole(...)` middleware가 담당 (Phase 1 Step 3 패턴). `customers_update` RLS 정책이 viewer를 `org_id = current_app_org_id()`만 통과시키면 적힌 대로 — viewer가 own org customer를 UPDATE 시도하면 RLS는 통과시키고 application layer에서 403 응답.

이 분리는 의도된 design: RLS는 **org 격리 강제** (기술적 보장), role guard는 **권한 정책** (운영 가변). Phase 3에서 manager가 자기 팀만 write 가능해질 때도 RLS가 아닌 application service에 분기 추가.

---

## 5. Seed 사전 결정

### 파일 흐름

`server/seeds/0002_customers.sql` — 24명 (Acme 12 + Beta 12). idempotent (`ON CONFLICT (id) DO UPDATE` 패턴, Phase 1 seed와 동일 보수적 접근).

### `run-seed.mjs` wrapper 갱신 (확정)

현재 wrapper(`server/scripts/run-seed.mjs:22`)는 `SEED_FILE = "seeds/0001_demo.sql"` 상수 한 줄과 orgs/users/memberships 3종 count check만 가지고 있어 **0002를 자동 인식하지 못한다**. 본 step에서 wrapper를 다음과 같이 일반화한다 (별도 mini-commit 없이 Step 1 구현 커밋에 포함):

```js
// 1. 파일 발견: seeds/*.sql을 사전순 정렬해서 순차 적용
import { readdir, readFile } from "node:fs/promises";
const seedDir = path.resolve(__dirname, "..", "seeds");
const files   = (await readdir(seedDir))
  .filter((f) => f.endsWith(".sql"))
  .sort();   // "0001_demo.sql" → "0002_customers.sql" → ...

for (const f of files) {
  const sql = await readFile(path.join(seedDir, f), "utf8");
  await client.query(sql);
  console.log("seed: applied", f);
}

// 2. checks 확장 — Phase 1 (orgs/users/memberships) + Phase 2 (customers)
const checks = [
  ["organizations", 2],
  ["users",         4],
  ["memberships",   4],
  ["customers",    24],   // Phase 2 추가
];
```

**Phase 3+ 새 seed 파일을 추가할 때**는 wrapper 수정 없이 `seeds/0003_*.sql` 추가 + `checks` 배열에 entity 한 줄 append만으로 흡수. wrapper 일반화의 운영 가치는 여기서 발생.

기대 출력 (Step 1 검증 시):

```
seed: applied 0001_demo.sql
seed: applied 0002_customers.sql
seed: organizations count=2 OK
seed: users count=4 OK
seed: memberships count=4 OK
seed: customers count=24 OK
```

count 한 줄이라도 EXPECTED 표시되면 `process.exitCode = 1`로 fail (Phase 1 wrapper의 기존 동작 유지).

### Acme 12명 (mock UI 그대로)

```
이름      | 회사         | 이메일               | 전화          | status   | plan
김민수    | Kloser Inc.  | kim@kloser.com       | 010-1234-5678 | active   | Pro
이지은    | DesignCo.    | lee@designco.kr      | 010-2345-6789 | review   | Pro
박서준    | Nexus Lab    | park@nexuslab.io     | 010-3456-7890 | active   | Enterprise
정유진    | TerraBase    | jung@terrabase.kr    | 010-4567-8901 | active   | Enterprise
최서연    | OrbitLab     | choi@orbitlab.com    | 010-5678-9012 | pending  | NULL
강지훈    | SkyNode      | kang@skynode.kr      | 010-6789-0123 | active   | Pro
한수민    | GridWorks    | han@gridworks.io     | 010-7890-1234 | review   | NULL
윤서아    | MapCore      | yoon@mapcore.kr      | 010-8901-2345 | active   | Enterprise
조성훈    | DOI          | cjb@doi-kr.com       | 010-9012-3456 | active   | Pro
신예린    | DataFlow     | shin@dataflow.kr     | 010-0123-4567 | pending  | NULL
오민재    | Pulsar       | oh@pulsar.io         | 010-1357-2468 | review   | Pro
임채영    | Helix Group  | lim@helix.co         | 010-2468-1357 | active   | Enterprise
```

### Beta 12명 (시각 격리 검증을 위해 다른 이름 세트)

```
이름      | 회사            | 이메일                 | 전화          | status   | plan
정승호    | Beta Soft       | jung@betasoft.kr       | 010-1111-2222 | active   | Pro
이채린    | Vector Studio   | lee@vector.io          | 010-2222-3333 | active   | Enterprise
박재훈    | NorthBridge     | park@northbridge.com   | 010-3333-4444 | pending  | NULL
김수아    | Lumix           | kim@lumix.kr           | 010-4444-5555 | review   | Pro
최민준    | Coral Networks  | choi@coral.io          | 010-5555-6666 | active   | Pro
강하늘    | PlasmaCore      | kang@plasmacore.com    | 010-6666-7777 | active   | Enterprise
윤성준    | Zenith Labs     | yoon@zenith.kr         | 010-7777-8888 | review   | Pro
한지민    | Cobalt Group    | han@cobalt.io          | 010-8888-9999 | pending  | NULL
조유나    | Nimbus Tech     | jo@nimbus.com          | 010-9999-0000 | active   | Enterprise
신우진    | Quartz Inc.     | shin@quartz.kr         | 010-0000-1111 | active   | Pro
오재민    | Helio Systems   | oh@helio.io            | 010-1234-9876 | review   | NULL
임소연    | Vertex Co.      | lim@vertex.com         | 010-9876-1234 | active   | Enterprise
```

### `last_contacted_at` 분포

24명 모두에 시간 분포를 박아 mock UI의 "2시간 전 / 오늘 09:48 / 어제 / 2일 전 / 1주 전" 외관 유지. seed 시점 `now()`를 기준으로 `now() - interval '2 hours'`, `now() - interval '12 hours'`, `now() - interval '1 day'` 등 9~12종 분포. 평가자가 evaluation 시 시각 자연스럽게 보임.

### `assigned_user_id` 정책 (seed)

| 옵션 | 결정 |
|---|---|
| 모두 NULL (unassigned) | **본 step 채택** |
| 일부를 admin에게 assign | 본 step 안 함 |

근거: Phase 2 권한 정책이 admin/manager/employee 모두 org-wide write이므로 `assigned_user_id`는 시각 표시용일 뿐. Phase 3 team-scope 도입 시 평가자가 직접 PATCH로 할당해 보는 흐름이 자연스러움. seed가 미리 채워두면 "내 고객" 카운팅이 즉시 0이 아니어서 좋아 보이지만, 그것이 권한 정책에 대한 잘못된 신호를 줄 수 있음. **NULL이 정직한 시작**.

---

## 6. Down 마이그레이션

```sql
-- Down Migration
-- ============================================================================

DROP TRIGGER IF EXISTS customers_touch_updated_at ON customers;

-- Step 1 시점에는 customers 한 entity만 touch_updated_at()을 사용 — 본 down에서
-- 함수도 같이 drop. 향후 Phase 4+ 다른 entity (calls / transcripts 등)가 같은
-- 함수를 재사용하기 시작하면, 그 시점에 다음 정책 전환 중 하나 채택:
--
--   (A) 함수를 자체 migration으로 분리 — 예: 1715000003000_touch_function.sql.
--       그 migration의 down은 함수 drop, 사용 entity migration의 down은 trigger
--       만 drop. 의존성 그래프가 명시적이 됨.
--
--   (B) 본 migration의 down에서 DROP FUNCTION 줄을 제거 — 함수는 한 번 깔린
--       후 재사용만 됨. customers를 down하면 trigger만 사라지고 함수 본체는
--       다른 entity 사용을 위해 보존.
--
-- (A)가 더 깔끔하지만 분리 시점에 마이그레이션 1개 추가 비용. 본 step (단일
-- entity)에서는 단순히 같이 drop하고, Phase 4 첫 재사용 시점에 그 step의 plan
-- 에서 (A)/(B) 결정을 명시. 본 down을 그대로 둔 채 customers 외 entity가 함수를
-- 사용하게 두면 customers down → 함수 drop → 다른 entity의 trigger 깨짐 위험이
-- 발생하므로, **Phase 4+ 재사용 시작 시 본 down의 DROP FUNCTION 라인을 반드시
-- 동시 수정**해야 한다 (해당 시점 step plan의 명시 작업).
DROP FUNCTION IF EXISTS touch_updated_at();

DROP POLICY IF EXISTS customers_delete  ON customers;
DROP POLICY IF EXISTS customers_update  ON customers;
DROP POLICY IF EXISTS customers_insert  ON customers;
DROP POLICY IF EXISTS customers_select  ON customers;

DROP TABLE IF EXISTS customers;
```

CASCADE 안 씀 — `customers` 외에 의존하는 다른 객체는 본 step에서 도입하지 않음.

---

## 7. 검증

```bash
# 1. migration up
npm --prefix server run db:migrate:up
# expect: 1715000002000_customers applied

# 2. table + RLS 검증 (admin URL)
docker exec kloser-dev-postgres-1 psql -U kloser -d kloser_dev -c \
  "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
   WHERE relname='customers'"
# expect: customers | t | t

# 3. 정책 4개 + helper 사용 확인
docker exec kloser-dev-postgres-1 psql -U kloser -d kloser_dev -c \
  "SELECT policyname, cmd, qual FROM pg_policies WHERE tablename='customers'"
# expect: customers_select / SELECT / org_id = current_app_org_id(), 등 4개

# 4. trigger 등록 확인
docker exec kloser-dev-postgres-1 psql -U kloser -d kloser_dev -c \
  "SELECT tgname FROM pg_trigger WHERE tgrelid='customers'::regclass AND NOT tgisinternal"
# expect: customers_touch_updated_at

# 5. seed (admin URL 경유) — 갱신된 wrapper가 0001 + 0002를 모두 적용
npm --prefix server run db:seed
# expect:
#   seed: applied 0001_demo.sql
#   seed: applied 0002_customers.sql
#   seed: organizations count=2 OK
#   seed: users count=4 OK
#   seed: memberships count=4 OK
#   seed: customers count=24 OK

# 6. RLS 격리 — app role + GUC swap
docker exec kloser-dev-postgres-1 psql "postgres://app:app_dev@localhost:5432/kloser_dev" -c \
  "SELECT count(*) AS no_guc FROM customers;
   BEGIN;
   SELECT set_config('app.org_id','11111111-1111-1111-1111-111111111111', true);
   SELECT count(*) AS acme FROM customers;
   COMMIT;
   BEGIN;
   SELECT set_config('app.org_id','22222222-2222-2222-2222-222222222222', true);
   SELECT count(*) AS beta FROM customers;
   COMMIT;"
# expect: no_guc=0, acme=12, beta=12

# 7. Phase 1 회귀 — server unit + e2e 깨지지 않음
npm --prefix server run typecheck
npm --prefix server test
node test/phase_0_5_e2e.mjs
```

`#6` 결과가 핵심 — 다른 org 데이터가 0 rows로 차단되는 것을 SQL 레벨에서 직접 확인.

---

## 8. 위험·미정

| 항목 | 처리 |
|---|---|
| seed 24명을 INSERT할 때 `created_at`/`updated_at` 분포 | seed 시점 `now()` 기준 interval 분포. test가 시간 의존 안 하면 무관. Phase 4 통화 결합 시점에서는 customer 생성 시각이 통화 매칭 키가 될 수 있어 미리 실제스러운 분포 |
| `email`/`phone` 중복 (제약 없음 결정) | service layer warning은 Phase 4+. Phase 2 seed에는 의도적 중복 없음 |
| `gen_random_uuid()` for seed UUID | **고정 UUID 사용** — 각 customer에 deterministic UUID 박음. test가 ID 기반 assertion할 때 안정. Acme `aaaa-...` prefix, Beta `bbbb-...` prefix |
| `touch_updated_at()` 함수가 다른 schema와 충돌 | `public` schema 안에 정의. `CREATE OR REPLACE`라 idempotent. Phase 4+ 다른 entity 첫 사용 시 함수 존재 여부 체크 필요 — 본 step finding에 명시 |
| run-seed.mjs wrapper 갱신 | Step 1 구현에서 `seeds/*.sql` 정렬 실행 + `customers count=24` check로 일반화 (§1 의존성 표 + §5 코드 sketch 확정). 구현 후 실제 출력 6줄을 `PHASE_2_STEP_1_FINDINGS.md`에 기록 |
| migration 적용 후 Phase 1 회귀 깨짐 | 본 step에서 Phase 1 테이블 변경 없음. 회귀 테스트 (§7 #7)가 안전망 |
| 향후 plan/status enum 추가 | text + CHECK이라 ALTER로 단순 변경 가능. 운영 영향 minimal |
| `last_contacted_at`을 trigger가 자동 갱신해야 하는가 | **NO** — 본 step에서는 manual update만. Phase 4 통화 종료 시점 후크에서 갱신 |

---

## 9. 완료 기준 (Step 1 — go/no-go)

- [ ] `npm --prefix server run db:migrate:up` PASS — `1715000002000_customers` 적용
- [ ] `npm --prefix server run db:seed` PASS — customers count = 24 (admin URL)
- [ ] §7 #2~#4 검증 명령 모두 기대 출력 일치
- [ ] §7 #6 RLS 격리: `no_guc=0`, `acme=12`, `beta=12`
- [ ] `npm --prefix server run typecheck` PASS (Phase 1 회귀)
- [ ] `npm --prefix server test` 37/37 회귀 PASS
- [ ] `node test/phase_0_5_e2e.mjs` 16/16 회귀 PASS
- [ ] Down 마이그레이션 검증 — **`npm --prefix server run db:migrate:redo`** 사용 (down 1 + up 1을 자동 왕복하는 node-pg-migrate 단축 명령). 단순 `db:migrate:down`은 인자 없을 시 default count=1이지만 의도가 묻혀서 `redo`가 명시적. 결과:
  - `customers` 테이블·trigger·`touch_updated_at()` 함수가 한 번 사라졌다가 같은 명령 끝에 복원됨
  - Phase 1 테이블(`organizations`, `users`, `memberships`, `sessions`, `teams`, `invitations`, `activity_log`)은 **단 한 줄도 영향 없음** — `pgmigrations` 테이블 inspect로 1715000002000만 down 대상이었는지 확인
- [ ] `docs/plan/PHASE_2_STEP_1_FINDINGS.md` 작성

---

## 10. 한 줄 요약

> **하루 동안 `customers` 테이블 1개 + 4 RLS 정책 + 6 partial 인덱스 + 24명 seed를 깐다. `current_app_org_id()` 헬퍼와 새 공통 trigger function `touch_updated_at()`을 도입해 Phase 4+ 다른 entity가 같은 패턴을 그대로 쓰게 만든다.**

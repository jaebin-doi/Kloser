# Phase 2 Step 1 Findings — Customers schema + RLS + seed

> Audience: Phase 2 Step 2 작성자 (또는 미래의 나).
> Format: each finding has **(1) 관찰**, **(2) Step 2 또는 이후로의 의미**.
>
> ⚠️ **`plan` 컬럼·`customers_org_plan_idx` 인덱스는 Step 5에서 제거됐다** (도메인 경계 충돌 — `organizations.plan`과 단어 겹침). 최종 모델은 master plan / Step 5 findings 참조.

## 결론

Step 1 **완료** (2026-05-08). 계획서 (`PHASE_2_STEP_1_SCHEMA.md`) §9 완료 기준 11항목 모두 통과:

- `npm run db:migrate:up` → `1715000002000_customers` 적용
- `npm run db:seed` (갱신된 wrapper) → 6 lines 정확히 plan §5 기대 출력 일치:
  ```
  seed: applied 0001_demo.sql
  seed: applied 0002_customers.sql
  seed: organizations count=2 OK
  seed: users count=4 OK
  seed: memberships count=4 OK
  seed: customers count=24 OK
  ```
- RLS flag: `customers.relrowsecurity=t / relforcerowsecurity=t`
- 4 policies: SELECT/INSERT/UPDATE/DELETE 모두 `current_app_org_id()` (INSERT는 `with_check` column 사용)
- trigger·function: `customers_touch_updated_at` + `touch_updated_at()` 등록 확인
- **RLS 격리 SQL 검증 (app role + GUC swap)**: `no_guc=0 / acme=12 / beta=12`
- Phase 1 회귀: typecheck PASS · server unit 37/37 · e2e 16/16 (split-origin)
- Down/up 왕복: `db:migrate:redo`로 1715000002000만 redo (`run_on=2026-05-08`), Phase 1 7테이블 row count 무영향. 재 seed 후 idempotent 동작 (`ON CONFLICT (id) DO UPDATE` 경유)

Step 2 진입 가능.

---

## 발견 사항

### 1. Wrapper 일반화로 entity 추가의 운영 비용이 0에 수렴

(1) `server/scripts/run-seed.mjs`의 `SEED_FILE` 상수 hardcoded (`"seeds/0001_demo.sql"`) → `readdir(seedDir).filter('.sql').sort()`로 일반화. checks 배열은 entity별 한 줄 (`["customers", 24]`) 추가. Step 1 검증 시 6 lines 출력이 정확히 plan §5 기대값과 일치.

(2) Phase 3+ 새 entity (예: invitations seed, transcripts seed)를 추가할 때:
- seed 파일을 `seeds/0003_*.sql` 형식으로 drop in
- wrapper의 checks 배열에 `["entity_name", expected_count]` 한 줄 append
- 그 외 wrapper / 마이그레이션 wrapper / npm script 일체 수정 없음

이는 Phase 2부터 entity 추가가 표준 흐름이 된다는 뜻. 일반화 비용은 본 step 1회로 끝났고 후속 phase가 자연스럽게 흡수.

### 2. Down 마이그레이션을 `db:migrate:redo`로 검증한 실효 — Phase 1 영향 0 확인

(1) 계획서 §9에서 단순 `db:migrate:down` 대신 `db:migrate:redo` 채택. node-pg-migrate의 `redo`는 default count=1로 down→up을 atomic하게 왕복. 검증 후 `pgmigrations` 테이블의 `run_on` column을 보면:
```
1715000000000_init           | 2026-05-07 01:28:42  ← 무변경
1715000001000_auth_sessions  | 2026-05-07 03:43:01  ← 무변경
1715000002000_customers      | 2026-05-08 00:38:14  ← redo로 갱신
```
1715000002000만 redo 대상이었음을 SQL로 직접 확인. Phase 1 7테이블 row count도 redo 전후 동일 (orgs=2, users=4, memberships=4, sessions=2 — 활성 세션, teams=0, invitations=0, activity_log=0).

(2) Phase 4+ 새 migration 추가 시점에도 같은 검증 절차 권장. 특히 Step 1 §6에서 명시한 `touch_updated_at()` hand-off 케이스가 발생하는 Phase 4 entity 도입 시 down 정책 (분리 vs DROP 라인 제거)을 결정하기 전에 redo로 영향 범위 한 번 더 확인.

### 3. Deterministic seed UUID 컨벤션 — eeee/ffff prefix는 미래 entity와 충돌 안 남

(1) Phase 1이 사용 중인 prefix:
- `aaaa-...` users (admins · employees)
- `cccc-...` memberships
- `1111-...` Acme org id, `2222-...` Beta org id

본 step에서 customers는 `eeee-1111-...` (Acme), `ffff-2222-...` (Beta)로 채택. `bbbb`/`dddd`는 향후 entity (예: invitations, calls)에서 사용 가능하도록 보존.

(2) Phase 3+ 새 seed 추가 시 prefix 컨벤션:
- 사람 (users, customers): 글자형 prefix (a/c/e/g/...)
- 관계 (memberships, calls, transcripts): 다른 글자형 (c/d/...)
- org id: 숫자 (1111, 2222)

본격 정형화는 안 했지만 충돌만 회피하면 됨. seed UUID는 테스트가 ID 기반 assertion에 의존하지 않는 이상 임의 prefix 가능 — 운영 도입 시점에 표 정리 검토.

### 4. `touch_updated_at()` 공통 함수 도입 — Phase 4+ 첫 재사용 시점 정책 결정 필요

(1) 본 migration에서 `CREATE OR REPLACE FUNCTION touch_updated_at()` 도입 + `customers_touch_updated_at` trigger 등록. `pg_proc`로 함수 존재 확인. Down에는 `DROP FUNCTION IF EXISTS touch_updated_at()` 박혀 있고 인라인 코멘트로 Phase 4+ 재사용 시점 정책 두 옵션 명시 (자체 migration 분리 vs DROP 라인 제거).

(2) 이 정책 hand-off는 **Phase 4 첫 entity 도입 시 그 step의 plan에서 반드시 결정**해야 한다. 그렇게 하지 않고 customers down을 그대로 두면, customers 마이그레이션을 down하는 순간 다른 entity의 trigger가 함수 부재로 깨진다. 본 step의 Down 코멘트가 그 위험을 명시하고 있지만, **Phase 4 step plan에서 cross-reference 필수**.

(3) 권장 절차 (Phase 4 진입 시): (a) 해당 step plan에서 함수 분리 vs 잔존 결정 → (b) 분리라면 새 migration `1715000003000_touch_function.sql`로 함수만 이동 + customers migration의 down에서 DROP FUNCTION 제거 + 새 migration의 down에 DROP 추가. 잔존이라면 customers down에서 DROP FUNCTION 라인만 제거. → (c) 두 entity 모두 redo 검증.

### 5. RLS 정책의 INSERT 검증은 `qual`이 비고 `with_check`만 채워진다

(1) 검증 중 `pg_policies.qual`을 출력했을 때 `customers_insert` 행이 비어 보이는 현상 확인. 실제로는 `with_check` column에 정상 `(org_id = current_app_org_id())` 박혀 있음. INSERT 정책은 `USING`이 아닌 `WITH CHECK`만 사용하므로 `qual` (USING)은 NULL.

(2) Step 2 (repository + service + RLS isolation tests) 작성 시 `pg_policies` query는 `cmd`별로 `qual`/`with_check`를 다르게 봐야 함:
- SELECT/UPDATE/DELETE → `qual`
- INSERT → `with_check`
- UPDATE도 `with_check` 가짐 (정책 정의에 USING + WITH CHECK 모두 박혀 있음)

테스트 코드에서 직접 정책 검증하려면 두 column 모두 select하는 게 깔끔.

### 6. seed의 `ON CONFLICT (id) DO UPDATE` 패턴이 Phase 1 patterns에서 일관 — `updated_at = now()` 명시

(1) 0002_customers.sql의 ON CONFLICT 절에서 `updated_at = now()` 한 줄을 명시 추가. trigger가 자동 갱신하지만 ON CONFLICT path는 INSERT-or-UPDATE 합성이라 UPDATE branch가 trigger를 깨우는지 한 번 확인하는 게 안전. Postgres 문서에 따르면 `INSERT ... ON CONFLICT DO UPDATE`의 UPDATE branch는 정상적으로 trigger를 fire한다 — 따라서 `updated_at = now()` 명시는 redundant. 그러나 명시해도 동작에 영향 없음.

(2) 운영 entity가 늘어나며 ON CONFLICT 패턴이 정착할 텐데, 명시-vs-trigger-only를 컨벤션으로 정해두면 PR 리뷰 일관성에 좋음. 권장: **명시**. 이유: seed 파일을 직접 읽을 때 "이 row가 update될 때 어떤 컬럼이 갱신되는가"가 자명. Phase 3+ seed에 같은 패턴 유지.

### 7. 시드의 `last_contacted_at` 시간 분포 — 평가자 시각 자연스러움

(1) 24 customer seed의 `last_contacted_at`를 `now() - interval '...'`로 박아 다양한 시간 거리 (2시간 ~ 14일). Phase 4+ 통화 기록 결합 시 자동 갱신될 컬럼이지만, Phase 2 시점의 mock UI는 이 분포를 그대로 표시한다. 평가자가 evaluation 시 "어제 / 2일 전 / 1주 전" 같은 자연스러운 시각 분포를 즉시 봄.

(2) seed 시점 `now()` 기준이라 매 seed re-run마다 분포가 갱신. 시간 의존 테스트가 없으므로 무관. Phase 4 통화 결합이 들어오면 customer 생성 시각과 통화 기록 시각의 정합성을 위해 시드 시점을 더 결정론적으로 (e.g., fixed timestamp) 만들어야 할 수도 있음 — 그 step에서 결정.

### 8. INSERT 정책 검증 시 `with_check` 직접 보기

이 항목은 §5와 같은 본질이지만 Step 2 테스트 작성자에게 더 명시적인 검색-키 형태로 한 번 더 적음:

```sql
-- Step 2의 RLS isolation test가 정책을 직접 점검하려면:
SELECT policyname, cmd, qual, with_check FROM pg_policies
WHERE tablename = 'customers' ORDER BY policyname;
```

| policyname | cmd | qual | with_check |
|---|---|---|---|
| customers_delete | DELETE | `(org_id = current_app_org_id())` | NULL |
| customers_insert | INSERT | NULL | `(org_id = current_app_org_id())` |
| customers_select | SELECT | `(org_id = current_app_org_id())` | NULL |
| customers_update | UPDATE | `(org_id = current_app_org_id())` | `(org_id = current_app_org_id())` |

UPDATE만 양쪽 column 모두 채워짐. INSERT는 with_check만, SELECT/DELETE는 qual만.

---

## Step 2 진입 시 가장 먼저 봐야 할 것

1. **`server/src/types/customers.ts` 도입은 Step 3** — Step 2의 repo/service는 ad-hoc TS interface로 시작 (`PHASE_2_MASTER.md` Step 3 의도된 흐름). Step 3에서 shared types로 리팩터링.
2. **trigger 동작 검증** — Step 2 단위 테스트에서 `UPDATE customers SET name='...' WHERE id=...` 후 `updated_at` 컬럼이 변했는지 확인 (trigger가 정상 동작 = NEW.updated_at = now() 적용).
3. **soft delete = `UPDATE deleted_at`** — Step 2의 service에 `deleteCustomer(id)`가 `UPDATE customers SET deleted_at = now() WHERE id = ...`로 구현되어야 함. RLS DELETE 정책은 일상 흐름에서 트리거 안 됨 (본 finding §4 + Step 1 plan §4).
4. **모든 SELECT는 partial index path 사용** — `WHERE deleted_at IS NULL`을 service의 base query에 박아둘 것. 인덱스 6개가 모두 partial이라 누락하면 인덱스 무효.
5. **Step 2 test 시점에 `pg_policies` 쿼리는 `qual`/`with_check` 둘 다** — 본 finding §8.

---

## 의도하지 않게 남긴 것 / 후속 작업

- **Phase 4 `touch_updated_at()` 함수 hand-off 결정** — 본 finding §4. Phase 4 첫 entity 도입 step plan에서 반드시 다룸.
- **Phase 5+ trigram 인덱스 도입 시점** — 현재 ILIKE seq scan 충분, 1만 건 미만에서는 ms 단위. 운영 진입 시 `pg_trgm` extension + `gin_trgm_ops` 인덱스로 전환 검토.
- **email/phone UNIQUE 도입 검토** — Step 1 plan §2에서 의도적으로 안 도입. Phase 4+ service-layer warning (`POST /customers` 시 중복 검출 메타) 후 UNIQUE 도입 효과 측정.
- **assigned_user_id seed 분배** — Phase 3 team 활성화 시점에 seed 일부에 admin/employee 배정해서 "내 고객" 필터를 평가자가 즉시 시연 가능하게.
- **seed UUID prefix 컨벤션 정형화** — 본 finding §3. 운영 도입 시점.
- **Down 마이그레이션 자동 검증 CI** — `db:migrate:redo`를 PR CI 단계에 박으면 회귀 자동화. Phase 6+ infra 단계.

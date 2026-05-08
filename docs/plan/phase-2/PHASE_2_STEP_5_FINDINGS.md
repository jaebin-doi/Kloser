# Phase 2 Step 5 Findings — customers page real API integration + domain cleanup

> Audience: Phase 2 Step 6 작성자 (또는 미래의 나).
> Format: each finding has **(1) 관찰**, **(2) Step 6 또는 이후로의 의미**.

## 결론

Step 5 **완료** (2026-05-08). 두 단위로 진행:

1. **client integration 커밋** (`Phase 2 Step 5: customers page real API integration`):
   - `platform/api.js` — `apiPatch` / `apiDelete` 추가
   - `platform/_shared.js` — `formatRelativeTime(iso)` helper + sidebar `id="sidebarCustomersCount"` 부여
   - `platform/customers.html` — mock 12명 하드코딩·KPI 숫자 제거. fetch 흐름 (load + post + patch + delete), 모달 듀얼 모드, 3 그룹 chip (status/plan/sort), URL query string 동기화, `parseApiError` 헬퍼, ESC close, 인증 게이트 도입

2. **domain cleanup 커밋** (`Phase 2 domain cleanup: remove customers.plan`):
   - `customers.plan` 컬럼 + `customers_org_plan_idx` 인덱스 + CHECK 제약 모두 drop (새 forward migration `1715000003000_drop_customers_plan.sql`)
   - seed 0002_customers.sql에서 plan INSERT/ON CONFLICT 제거
   - shared types: `CustomerPlan` enum + `Customer`/`CustomerCreateInput`/`CustomerListQuery`의 `plan` 필드 + `ListPlan` preprocess 모두 제거
   - server: repository CUSTOMER_COLUMNS / INSERT / UPDATE에서 plan 제거. service `THROWABLE_FIELDS`에서 `"plan"` 제거 (status/assignedUserId 2종으로 축소). `CustomerListFilters` Pick에서 plan 제거
   - route 테스트: `plan=Trial` invalid case 제거 (status + assignedUserId 2 case로 축소)
   - browser JSDoc 사본 (`platform/types/customers.js`)에서 `CustomerPlan` typedef + plan 필드 제거
   - customers.html에서 plan chip group, 테이블 plan 컬럼, 모달 plan select, `planColors`, viewState/readModalForm/openEditModal/resetModalForm의 plan 모두 제거. 행 colspan 7 → 6 갱신
   - 삭제 confirm 문구 정합: `(복구 불가)` → `목록에서 삭제됩니다.` (server는 soft delete)
   - 마스터 plan §0/§1/§2-6/§2-12/§4 schema/§4 인덱스 갱신. Step 1/3/4 plans + Step 1/3/4 findings 머리에 short note ("최종 모델은 Step 5 findings 참조")

검증 결과 (양쪽 커밋 후):
- `npm --prefix server run typecheck` PASS
- `npm --prefix server test` **65/65 PASS**
- `node test/sync_shared_types.mjs` PASS
- `node test/phase_0_5_e2e.mjs` **16/16 PASS**
- 브라우저 시각 검증 — Step 5 plan §9 5 시나리오 + 필터 정합 시나리오 모두 PASS (Acme 12 / 추가 / 수정 / 삭제 / Beta 격리 / status=active 중 pending POST는 list 그대로)

Step 6 (e2e + Phase 2 종합 findings) 진입 가능.

---

## 발견 사항

### 1. **Domain cleanup record — `customers.plan` 제거 결정 + 영향 범위**

(1) **문제**: 1715000002000_customers.sql이 도입한 `customers.plan text` (CHECK in 'Starter','Pro','Enterprise')는 `organizations.plan`과 동일 단어 + 동일 enum literal을 공유했다. `organizations.plan`은 **Kloser 자체의 SaaS 구독 단계** (Starter = 99/월, Pro = 199/월 등)인데, `customers.plan`은 영업 대상 고객의 어떤 속성을 표현하려 했는지 의미가 모호. mock UI에서 가져온 잔재 — "Enterprise 플랜으로 결제하는 고객" 정도로 읽히지만, 그 의미를 customer entity에 박는 건 멀티테넌트 도메인 경계를 흐림. 같은 DB 안에 두 단계의 "plan"이 공존하면 향후 query·report·permission 분기 작성 시 사람이 매번 어느 plan인지 확인해야 하는 인지 부하가 누적.

(2) **해결**: 본 step에서 customers.plan 전면 제거. `organizations.plan`만 살아남아 Kloser 구독 단계 의미를 단독으로 가짐. customer row의 라이프사이클 stage가 필요해지는 시점 (Phase 3+ 영업 워크플로 도입)에는 다른 컬럼명 (`stage`, `lifecycle_stage` 등)으로 새로 도입 — `plan` 단어는 절대 재사용하지 않는다.

(3) Phase 3+에서 customer staging이 들어올 때:
- 새 컬럼: `customers.stage text NOT NULL DEFAULT 'lead'` + CHECK
- 의미: lead → qualified → proposal → won/lost 같은 영업 단계
- `status` 컬럼 (active/review/pending)과 직교 또는 통합 검토는 Phase 3 plan에서

### 2. customers entity의 도메인 정의 명확화

(1) Step 5 master plan §0에 한 줄 추가: "customers는 테넌트(=organization)가 보유한 영업 대상 (leads/contacts)이다. Kloser 자체의 구독 플랜과는 별개의 도메인이며, customer row는 Kloser 플랜 attribute를 가지지 않는다."

(2) 한국어 SaaS/CRM 문맥에서 "고객 관리"는 사용사가 관리하는 영업 대상을 가리키므로 메뉴명·페이지 제목은 그대로 유지 가능. UI 외관 변경 0. 다만 Phase 3+에서 B2B 정확히 가려갈 때 `accounts` (회사) + `contacts` (연락처) 분리 검토 — 본 phase 범위 밖.

(3) status 컬럼 의미 — 현재 `active / review / pending`은 영업 단계로는 약함 ("리드 관리 상태"보다 "고객 계정 상태"에 가깝게 읽힘). Phase 3~4 진입 전 `lead_status` 또는 `stage`로 재정의 검토. 본 step에서는 데모용 CRUD 상태값으로 유지.

### 3. New forward migration vs amend — forward 채택 + 검증 절차

(1) 1715000002000_customers.sql amend도 가능했지만 **forward migration** 채택 (1715000003000_drop_customers_plan.sql). 이유:
- Step 1~4 작업이 이미 그 마이그레이션 위에 쌓여 있음 (이력)
- redo는 dev 환경 검증을 한 번 더 거쳐야 하고, 다른 환경에 옮길 때 혼선
- forward migration은 Up/Down 둘 다 명시 — Down은 컬럼 + 인덱스 재추가 (rollback 시 historic plan 값은 NULL로 복구)
- node-pg-migrate의 표준 흐름

(2) Up 순서: `DROP INDEX customers_org_plan_idx` 먼저, 그다음 `ALTER TABLE customers DROP COLUMN plan`. 인덱스가 컬럼에 의존하므로 PG가 "cannot drop column ... because other objects depend on it"으로 fail시키는 걸 회피. CASCADE 안 씀 — 의도치 않은 의존성 (없음 확인됨)이 silent drop되지 않도록.

(3) CHECK 제약은 별도 DROP 안 함 — 컬럼이 사라지면 자동 제거.

### 4. `THROWABLE_FIELDS` 축소 + invariant 갱신

(1) Step 3 plan §8 / Step 3 finding §4의 `CustomerListQuery` 불변조건 4개 중 "status, plan, assignedUserId만 invalid 시 throw" 항목이 **status, assignedUserId 2종으로 축소**. service `normalizeListOptions`의 `THROWABLE_FIELDS = new Set(["status", "assignedUserId"])`. zod schema에서 `plan` 필드가 제거됐으므로 schema 자체가 plan 관련 throw를 emit할 수 없음 — invariant 자동 충족.

(2) 다른 invariant 3개 (q/sort/dir/limit/offset 정규화 + safeParse 실패 path 한정 + ZodError 우회 시 raw re-throw)는 변경 없음. 본 step finding은 "축소"만 기록 — 새로운 정책 도입 아님.

### 5. UI 외관 변경 zero — 데이터 도메인만 정리

(1) plan UI 제거 (chip group, 테이블 컬럼, 모달 select, planColors)는 사용자 시각에서 "필터 chip 4개 제거 + 컬럼 1개 제거 + 모달 필드 1개 제거"이지만, 페이지 layout은 깨지지 않음. status chip + sort chip 그룹은 그대로, 테이블은 6 컬럼으로 자연스럽게 좁아짐.

(2) 4 KPI 카드는 그대로 (total/active/review/pending). status 분포만 표현하므로 plan 제거와 무관.

(3) Step 6 e2e가 작성될 때 plan 관련 시나리오 (예: Enterprise 필터 → 특정 row만)는 시나리오 자체가 사라짐. status 필터·검색·sort 시나리오로 충분 — 핵심 동작 (CRUD round-trip + RLS 격리)은 status/검색만으로 검증 가능.

### 6. Test cleanup 잔재 — db:seed 재실행 시 5 row 검출

(1) Step 4/5 브라우저 probe 작업 중 누적된 routetest-/검증고객/필터정합검증/Validator-* 5 row가 customers 테이블에 남아 있어 plan drop 마이그레이션 후 첫 db:seed가 `customers count=29 EXPECTED 24`로 fail. 직접 admin URL로 `DELETE FROM customers WHERE id::text NOT LIKE 'eeeeeeee-%' AND id::text NOT LIKE 'ffffffff-%'` 실행 → 5 row 정리 → 재seed 24 OK.

(2) Step 6에서 customers e2e 작성 시 **시나리오 종료 시점 cleanup은 DB 직접 helper로 박을 것** — UI 시나리오의 try/finally 또는 afterEach 패턴. 사용자 cleanup은 수동·시각 검증 시점에만 유효, 자동화 e2e는 자체 cleanup 보장이 약속.

(3) Phase 3+ 새 entity (예: invitations) 도입 시 같은 패턴 — seed UUID prefix와 다른 UUID는 자동 cleanup 대상으로 인식 가능. db:seed wrapper의 expectation count도 교차 검증 안전망.

### 7. 마이그레이션 포함 verification 흐름 정착

(1) 본 step domain cleanup이 마이그레이션을 포함한 첫 step (Step 1 외). 흐름:
- 새 migration sql 작성
- `npm --prefix server run db:migrate:up`
- (optional) 직접 admin URL로 DB cleanup
- `npm --prefix server run db:seed`
- shared types / repo / service / route / browser JSDoc / UI 코드 동기화
- typecheck → unit → sync → e2e 4종 회귀 통과
- 브라우저 시각 재검증 (Playwright)

(2) Phase 3+ 도메인 변경 시 같은 흐름 follow. **schema 변경은 코드 변경 전에 끝내야** — 코드는 schema 기준으로 컴파일 통과 여부가 즉시 판정되므로 schema가 미정 상태에서 코드 작성하면 typecheck가 무의미.

---

## Step 6 진입 시 가장 먼저 봐야 할 것

Step 6 (`phase_2_customers_e2e.mjs` + Phase 2 종합 findings) 작성자가 본 step 결과 위에서 즉시 봐야 할 사항.

### 1. **e2e 시나리오에서 plan 관련 step 0** — 본 step 도메인 정리 결과

기존 mock UI에 있던 "Enterprise 플랜 chip 클릭 → row 6개" 같은 시나리오는 작성하지 않는다. 대신:
- 로그인 → list 12명
- 신규 추가 → 13명, KPI 갱신
- 행 클릭 → 수정 → in-place 갱신 (서버 재조회 후)
- 삭제 → 12명, KPI 원복
- Acme/Beta cross-org 격리 시각 (Acme JWT로 Beta row id 직접 접근 → 404)
- status=active 중 pending POST → list 그대로 (필터 정합)

### 2. **Step 6 e2e의 자체 cleanup 보장**

본 step finding §6 그대로 — 시나리오가 만든 row는 시나리오 종료 시점에 직접 정리. seed UUID 외 row 자동 sweep도 가능 (admin URL에서 prefix LIKE 절).

### 3. **Phase 2 종합 findings — domain cleanup이 master record**

`docs/plan/phase-2/PHASE_2_STEP_6_FINDINGS.md` 작성 시 본 step의 domain cleanup record를 cross-reference. Phase 2 전체 결정 흐름에서 "customers.plan 도입 → 5 step 후 제거"가 가장 큰 변경이므로 별도 항목으로 명시.

### 4. **서버 무변경 확인** — Step 6은 e2e 추가만

Step 6은 새로운 엔드포인트나 schema 변경이 없는 e2e + 종합 findings step. 본 step 결과 위에서 회귀 검증으로 완전히 보호됨. master plan §6 게이트 통과 후 Phase 3 진입.

---

## 의도하지 않게 남긴 것 / 후속 작업

- **`status` 컬럼 의미 재정의** — 본 finding §2의 P2. Phase 3 영업 워크플로 도입 시점에 `lead_status`/`stage`로 재명명 검토. 컬럼 추가가 아니라 RENAME 또는 새 컬럼 + 기존 deprecate.
- **`accounts` (회사) ↔ `contacts` (사람) 분리** — Phase 3+ B2B CRM 정확화 시점. 현재 customer row는 둘이 섞임 (`name` = 사람, `company` = 회사).
- **route 테스트의 plan 시나리오 영구 삭제** — 본 step에서 1 case 제거됨. 회귀 시점에 다시 추가하지 않도록 PR 리뷰 가이드.
- **db:seed 자동 cleanup** — 본 finding §6. seed UUID prefix 외 row는 db:seed 시점에 auto-sweep하는 옵션 검토. 단 명시 옵트인이 안전 (운영 데이터 잘못 쓸어버릴 위험).
- **Phase 3 새 entity (invitations) 도입 시 plan 단어 절대 재사용 금지** — naming convention. `plan` = Kloser SaaS 구독 단계 단독 사용.
- **mock UI에서 가져온 다른 도메인 잔재 점검** — `memo` 필드는 본 step에서 제거됐지만, 다른 entity 도입 시 mock UI 필드를 그대로 schema에 박는 패턴 자체에 주의. 도메인 경계 검토를 entity 도입 시점에 명시.
- **Playwright Chromium cache 끈질김** — 본 step 검증 중 `_shared.js` 변경이 cache로 가려지는 현상. CI/시각 검증 시 hard reload 또는 fresh context 필요. 운영 영향은 zero (실제 사용자는 hash filename으로 cache 회피 가능 — Phase 6+ build step 도입 시).

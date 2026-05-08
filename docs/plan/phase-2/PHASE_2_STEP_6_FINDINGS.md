# Phase 2 Step 6 Findings — Customers e2e + Phase 2 종합

> Audience: Phase 3 작성자 (또는 미래의 나).
> Format: each finding has **(1) 관찰**, **(2) Phase 3 또는 이후로의 의미**.
> Scope: Step 6 본 step + Phase 2 전체 인계 (Step 1~6 합본).

## 결론

Phase 2 **완료** (2026-05-08). 마스터 plan §6 go/no-go **14/14 통과**. 루트 `README.md` + `server/README.md` 상태 블록 모두 Phase 2 완료로 갱신 (Phase 1 visual guide는 Phase 2 진입 링크만 최소 갱신, 사용자 별도 편집 파일은 건드리지 않음).

**Step 6 단독 결과**:
- `test/phase_2_customers_e2e.mjs` 신규 작성 — 7 시나리오 + cleanup 검증
- `node test/phase_2_customers_e2e.mjs` PASS:
  ```
  scenario 1: 12 Acme seed rows + KPI 12/7/3/2 + sidebar 12
  scenario 2: 신규 추가 → 13 rows + KPI total=13 pending=3 sidebar=13
  scenario 3: 행 수정 → status active + name 갱신 + KPI active=8 pending=2
  scenario 4: 삭제 → list 12 + KPI 12/7/_/2 복귀
  scenario 5: Beta view 12 disjoint rows (Acme leak 0) + Acme 재로그인 복귀
  scenario 6: status=active 필터 중 pending POST → list stays 7, stats=13/3
  scenario 7: cleanup 후 e2etest- 잔재 0 (1/1 row 삭제, total=12 복귀)
  no console errors / screenshot saved
  ```
- 회귀 4종 모두 PASS:
  - `npm --prefix server run typecheck` PASS
  - `npm --prefix server test` 65/65 PASS
  - `node test/sync_shared_types.mjs` PASS
  - `node test/phase_0_5_e2e.mjs` 16/16 PASS

Phase 3 (회원가입/이메일/팀 초대) 진입 가능.

---

## Phase 2 전체 흐름 요약

| Step | 결과물 | 핵심 결정 / 도메인 변경 |
|---|---|---|
| 1 | `customers` 테이블 + 4 RLS 정책 + 6 partial 인덱스 + 24명 seed | `touch_updated_at()` 공통 trigger 도입. `current_app_org_id()` helper 재사용. (도입 시점 `plan` 컬럼 + `customers_org_plan_idx` — Step 5 cleanup으로 제거) |
| 2 | repository (7 함수) + service (6 함수, role-blind) + 단위 테스트 12 (RLS 6 + CRUD 6) | RLS isolation case 4가 SQL 레벨에서 cross-org INSERT 차단 검증. `existsByIdInCurrentOrg` 미도입 — RETURNING null로 충분 |
| 3 | shared types (`server/src/types/customers.ts` zod source-of-truth + `platform/types/customers.js` JSDoc 사본 + `test/sync_shared_types.mjs` regex diff) | `zod ^4.4.3` runtime dep 추가. `CustomerListQuery` 불변조건 4개 (q/sort/dir/limit/offset 정규화 + status/assignedUserId만 throw 등). `normalizeListOptions` 내부를 zod parse로 교체하면서 service 시그니처 + `InvalidListOptionError` 유지 |
| 4 | REST routes (6 endpoints) + scoped `setErrorHandler` + route 테스트 16 cases | ZodError → 400 invalid_input + flatten / InvalidListOptionError → 400 invalid_<field> + value 매핑 분리. zod 4.x `.uuid()`가 RFC 4122 strict라 seed deterministic UUID 거부 — Phase 1 UUID_RE regex로 정합. viewer JWT staleness 회피 절차 (DB demote → 새 로그인 → 403) 명시 |
| 5 | `platform/customers.html` 실 API 연결 (`apiPatch`/`apiDelete`/`formatRelativeTime` + 모달 듀얼 모드 + URL query sync + 2 그룹 chip + 인증 게이트) **+ domain cleanup** | mutation 후 `loadAll()` 재조회 정책 (필터 정합). **`customers.plan` 전면 제거** — `organizations.plan`과 도메인 경계 충돌. `1715000003000_drop_customers_plan.sql` 도입 |
| 6 | `test/phase_2_customers_e2e.mjs` 7 시나리오 + cleanup 검증 + Phase 2 종합 findings | 시나리오마다 `try/finally`로 자체 unwind, finally 블록 fresh Acme login → authed DELETE. 시나리오 7이 cleanup 메커니즘 자체의 회귀 안전망 |

---

## Step 6 본 step 발견 사항

### 1. e2e cleanup의 fresh-token 발급 패턴이 핵심

(1) 시나리오 5에서 logout/login (Beta) 후 acme 토큰 메모리 사라짐. cleanup이 acme row를 삭제해야 하므로 finally 블록 시작 시 `loginViaApi("admin@acme.test", ...)`로 새 토큰 발급. 시나리오 본문이 어디에서 throw해도 finally는 항상 fresh 토큰을 새로 받음.

(2) 일반화: **e2e의 cleanup은 시나리오 본문이 남긴 token state에 의존하지 말 것**. 직접 API login으로 fresh 토큰을 얻는 게 더 안전. UI 우회로 token을 얻는 helper (`loginViaApi`)를 모든 e2e가 공유 가능 — Phase 4+ 새 entity e2e 작성 시 같은 패턴 follow.

### 2. 시나리오 7이 cleanup 메커니즘 자체의 회귀 안전망

(1) 본 e2e는 모든 시나리오 종료 후 `authedList()`로 `e2etest-` prefix row가 0인지 확인. 만약 시나리오 1~6에서 row 추적이 누락되면 시나리오 7이 즉시 fail — 시나리오 본문 buggy/cleanup helper buggy 둘 다 표면화.

(2) Phase 4+ 새 e2e (calls, transcripts 등)도 같은 패턴: 시나리오마다 만든 row의 prefix를 약속하고, 마지막 시나리오가 prefix sweep으로 잔재 0 검증. **cleanup 약속을 테스트 코드 자체가 강제**.

### 3. UI를 통한 mutation은 자체 token state를 유지하지만 cleanup은 별도 fetch로

(1) 본 e2e는 시나리오 2의 POST를 UI 모달 흐름으로 실행 — 페이지의 `kloserApi`가 알아서 토큰 첨부. 시나리오 3의 PATCH, 4의 DELETE도 마찬가지. 그러나 finally cleanup은 UI 우회 직접 fetch — 시나리오 본문이 fail해도 cleanup은 동작.

(2) 분리 효과: 시나리오 본문이 UI 흐름의 정확성을 검증, cleanup은 데이터 정리에 집중. 두 책임이 섞이면 UI bug가 cleanup도 깨뜨려서 회귀 누적이 시작될 수 있음.

### 4. seed counts pre-check가 e2e 자체의 자기 검증

(1) e2e 본문 시작 전 `authedList(token)`로 Acme total === 12 확인. 만약 seed 외 row 잔재가 있으면 (이전 e2e cleanup 실패, 수동 검증 잔재 등) 시나리오 1의 KPI assertion이 false negative — 본문이 fail하지만 원인이 모호. **pre-check는 "환경 OK?"를 명시 분리**.

(2) Phase 3+ 새 e2e도 같은 pattern: 시나리오 시작 전 seed/환경 검증을 명시 PASS로 출력. 환경 fail vs 코드 fail이 구분.

### 5. `page.on("dialog", d => d.accept())` 1회 등록으로 confirm 자동 처리

(1) 시나리오 4의 삭제 흐름은 `confirm("정말 삭제?")` native dialog 발동. Playwright `page.on("dialog", d => d.accept())`를 main 시작 시 1회 등록하면 모든 후속 confirm/alert/prompt가 자동 accept. `window.confirm = () => true` 오버라이드보다 이 방식이 깔끔 — page reload 후에도 유지됨.

(2) Phase 4+ destructive UI 추가 시 같은 hook 재사용. confirm dialog가 늘어날수록 가치.

### 6. UI에서 row id가 가려진 경우 (필터 적용) 직접 API로 capture

(1) 시나리오 6은 `status=active` 필터 적용 상태에서 pending row를 추가. 새 row는 list에 안 보임 (의도된 필터 정합). 그런데 cleanup을 위해 id를 기록해야 함. UI 우회로 `authedList()` (필터 없이 전체) → name 매칭 → id 추출.

(2) 필터/페이지네이션이 활성화된 상태에서 mutation을 검증할 때 일반화: **UI는 시각 검증만, id 추적은 직접 API로**. UI DOM에서 못 보이는 row도 API에는 존재.

### 7. Playwright Chromium cache는 dev 서버 환경에서 끈질김

(1) Step 5 시각 검증 시점에 `_shared.js` 변경이 cached로 가려진 사례 (Step 5 finding §7 그대로). 본 step에서는 e2e 매 실행이 fresh `chromium.launch` + `newContext`이므로 영향 없음 — context 자체가 cache를 비움. 다만 사용자 측 manual probe에서 같은 함정 가능.

(2) Phase 6+ build step (hash filename 등) 도입 시 자연 해결. 본 phase 데모 단계라 무관.

---

## Phase 2 종합 — 핵심 인계

### domain cleanup (`customers.plan` 제거) — 최종 상태 재확인

(1) `customers.plan text + CHECK ('Starter','Pro','Enterprise')` 도입 시점 (1715000002000) → Step 5 cleanup (1715000003000)으로 컬럼·partial 인덱스·CHECK 모두 제거. 이유는 `organizations.plan` (Kloser 자체 SaaS 구독 단계)와 의미 충돌 — 한 DB 안에 같은 단어가 두 도메인을 표현하면 향후 query·report·permission 분기에서 매번 인지 부하.

(2) 결과:
- DB 컬럼 0
- shared types `CustomerPlan` enum 0
- repository / service / route 코드 0
- browser JSDoc 사본 / customers.html UI / 모달 / 칩 0
- e2e / unit 테스트의 `plan` assertion 0

(3) Phase 3+ customer 라이프사이클 stage가 필요해질 때:
- 새 컬럼 (`stage` 또는 `lifecycle_stage`) — 절대 `plan` 단어 재사용 금지
- 의미: lead → qualified → proposal → won/lost (영업 단계)
- 기존 `status` (active/review/pending)와 직교 또는 통합 검토는 Phase 3 plan에서

### `customers` 도메인 정의

> **Kloser 사용사 (= organization)가 관리하는 영업 대상 고객/리드.**
> Kloser 자체의 구독 플랜 (`organizations.plan` Starter/Pro/Enterprise)과는 **별개의 도메인**이며, customer row는 Kloser 플랜 attribute를 가지지 않는다.

한국어 SaaS/CRM 문맥에서 "고객 관리"는 사용사가 관리하는 영업 대상을 가리키므로 메뉴명·페이지 제목 그대로 유지. Phase 3+ B2B 정확히 가려갈 시점에 `accounts` (회사) ↔ `contacts` (사람) 분리 검토.

### 마스터 §6 go/no-go 통과 항목 (14/14)

```
[x] typecheck
[x] server unit 65/65
[x] phase 0.5 e2e 16/16
[x] phase 2 customers e2e 7 시나리오 + cleanup
[x] sync_shared_types
[x] zod runtime dep 추가됨
[x] customers 테이블 + RLS 4정책 + 5 인덱스 + 24명 seed
[x] 6 endpoint 200/4xx
[x] viewer JWT 403
[x] cross-org RLS 격리 (unit + e2e)
[x] customers.html 실 API 호출만
[x] new customer 모달 실작동
[x] sync_shared_types 패턴 통과
[x] Step 1~6 findings 작성됨
[x] README 상태 블록 갱신 (루트 + server) — Phase 2 완료 반영
```

README 항목은 본 step에서 정리 — 루트 `README.md`와 `server/README.md` 모두 Phase 2 완료 + Step 1~6 항목별 상태로 갱신. `USER_GUIDE_PHASE_1.md` / `AGENTS.md` 같은 사용자 별도 편집 파일은 건드리지 않았고, Phase 1 visual guide(`PHASE_1_FOUNDATIONS.html`)와 화면별 가이드(`USER_GUIDE.html`)는 Phase 2 진입 링크만 최소 갱신 (헤더 nav · 푸터 nav · 본문 reference 각 1줄).

---

## Deferred / 후속 작업 인계

### Phase 3 진입 시 우선

1. **`customers.status` 의미 재정의** — 현재 `active/review/pending`은 영업 단계로 약함 ("고객 계정 상태"에 가깝게 읽힘). Phase 3+ 영업 워크플로 도입 시점에 `lead_status` 또는 `stage`로 재명명 검토. 컬럼 추가 vs RENAME은 Phase 3 plan 결정.
2. **`accounts` (회사) ↔ `contacts` (사람) 분리** — 현재 customer row는 둘이 섞임 (`name` = 사람, `company` = 회사). B2B CRM 정확화에 본격 필요한 시점에 별도 step.
3. **`requireFreshRole` opt-in 도입** — Phase 1 finding §6 / Phase 2 master §7-2 deferred. Phase 3 (role 변경 잦아짐) 시점에 DELETE/critical write에 한정 도입.
4. **`activity_log` audit hook** — Phase 1에서 테이블만 존재, hook은 미구현. POST/PATCH/DELETE 시점 hook은 Phase 4 (통화 기록과 같이) 또는 본격 audit step.
5. **`requireRole` opt-in vs viewer 차단 정책의 전사 통일** — Phase 2 customers는 application-layer (preHandler) 차단. 다른 entity에도 일관 적용 — Phase 3+ 새 routes 작성 시 같은 패턴 follow.

### Phase 4+ 운영 단계

- **bulk import (CSV)** — Phase 6+ enterprise 단계
- **외부 시스템 동기화 (HubSpot/Salesforce)** — Phase 6 v2 베타
- **Soft-deleted customer 복구 UI** — Phase 4+ admin 콘솔
- **customer 행 클릭 상세 패널** — Phase 4 통화 기록 결합 시점
- **trigram 인덱스 (pg_trgm)** — Phase 5+ 데이터 양 늘면 substring 검색 인덱스화
- **페이지네이션 UI (offset/cursor)** — Phase 4+ 운영 데이터 늘면

### 운영 위생

- **e2e screenshot ignore 정책** — `test/phase_0_5_e2e.png` 정책 그대로 `test/phase_2_customers_e2e.png`도 적용. 각 e2e 실행마다 갱신되는 binary는 git diff에 잡히지 않도록 하거나 deterministic하게.
- **Down 마이그레이션 자동 검증 CI** — `db:migrate:redo`를 PR CI 단계에 박으면 회귀 자동화. Phase 6+ infra.
- **README 상태 블록 갱신 cycle** — 본 step에서 루트 + server 양쪽 모두 갱신 완료. Phase 3 진입 시점에 같은 패턴으로 sub-step 단위 추가만 하면 됨.
- **Playwright Chromium cache 회피** — fresh context 매 실행 + 사용자 manual probe 시 hard reload 안내. Phase 6+ build step 도입 시 자연 해결.

### Phase 0.5 → Phase 2 인계 모두 처리됨

Phase 1 finding의 deferred 항목 5개 중:
- ✅ Shared types 도입 → Step 3에서 처리
- 진행 중 / Phase 3 deferred: `requireFreshRole` opt-in, `listActiveMembershipsAcrossOrgs` O(orgs) scan, `CommitAuthError` COMMIT 실패 client leak, `requireRole` style consistency

Phase 2 finding 5종에서 추가된 deferred는 위 §Phase 3 진입 시 우선 / Phase 4+ 운영 단계 항목으로 통합.

---

## 다음 phase 진입 시 가장 먼저 봐야 할 것

1. **`customers.plan` 단어 절대 재사용 금지** — `plan` = Kloser SaaS 구독 단계 단독. customer row의 영업 단계는 다른 컬럼명.
2. **shared types 패턴 follow** — Phase 3+ 새 entity (예: invitations, calls, transcripts) 도입 시 `server/src/types/<entity>.ts` (zod) + `platform/types/<entity>.js` (JSDoc) + `test/sync_shared_types.mjs` `ENTITY_REGISTRY` 1줄 추가.
3. **e2e cleanup 약속 follow** — `e2etest-`/`<entity>test-` prefix + finally fresh-token DELETE + 마지막 시나리오 sweep 검증.
4. **`requireRole` 미들웨어 + RLS 격리 더블 보호** — Phase 1 패턴. application-layer + DB-layer 모두 권한 분기. Phase 3+ 새 routes도 동일.
5. **마이그레이션은 forward-only** (Step 5 domain cleanup 패턴) — amend 대신 새 migration 추가. Down 명시.

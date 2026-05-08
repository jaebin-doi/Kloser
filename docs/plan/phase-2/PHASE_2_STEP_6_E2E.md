# Phase 2 Step 6 — Customers e2e + Phase 2 종합 findings

> **상위 계획**: `docs/plan/phase-2/PHASE_2_MASTER.md` §3 Step 6 + §6 (Phase 2 go/no-go).
> **선행**: Step 1~5 완료 — `PHASE_2_STEP_5_FINDINGS.md`까지 push 됨 (`origin/feature/phase-2-customers-crud` HEAD = 6d8efba).
> **기간**: 0.5일.

---

## 진행 상태

- [x] 1. e2e 환경 + 실행 전제 사전 결정 (본 plan §3) 검증
- [x] 2. 시나리오 7개 사전 결정 (본 plan §4) 검증
- [x] 3. cleanup 원칙 사전 결정 (본 plan §5) 검증
- [x] 4. `test/phase_2_customers_e2e.mjs` 작성 — 7 시나리오 + finally cleanup
- [x] 5. `node test/phase_2_customers_e2e.mjs` PASS (시나리오 모두 + cleanup 검증)
- [x] 6. 회귀 검증 4종 (`server/typecheck`, `server/test` 65/65, `sync_shared_types`, `phase_0_5_e2e` 16/16)
- [x] 7. `docs/plan/phase-2/PHASE_2_STEP_6_FINDINGS.md` — Phase 2 종합 findings + deferred 정리
- [x] 8. `docs/plan/phase-2/PHASE_2_MASTER.md` Step 6 완료 처리 + go/no-go 체크 동기화
- [x] 9. README 상태 블록 (필요 시 최소 갱신)

---

## 0. 목적

Step 1~5가 schema·repository·service·shared types·routes·client을 차례로 깔았다. Step 6은 그 위에서 **사람이 직접 만지는 흐름이 자동 e2e로 회귀 차단**되는 것을 보장한다. Phase 0.5 e2e (16/16)가 통화 실시간 흐름을 회귀 보호하는 것과 같은 위치를 customers CRUD 흐름에 부여.

이 step이 끝나면:
- `node test/phase_2_customers_e2e.mjs`가 **로그인 → list → 추가 → 수정 → 삭제 → Beta 격리 → 필터 정합** 7 시나리오를 자동 검증
- Phase 2 go/no-go (master plan §6) 모든 항목 통과
- `docs/plan/phase-2/PHASE_2_STEP_6_FINDINGS.md`가 Phase 2 전체 종합 + deferred 작업 명시
- branch가 main에 머지 가능한 상태

Phase 3 (회원가입/이메일/팀 초대) 진입 가능.

---

## 1. 디렉토리 변화

```text
test/
├── phase_0_5_e2e.mjs                  # 기존 (변경 없음 — 회귀 baseline)
├── phase_2_customers_e2e.mjs          # 🆕 7 시나리오
└── sync_shared_types.mjs              # 기존 (변경 없음)

docs/plan/phase-2/
├── PHASE_2_MASTER.md                  # ⬆ Step 6 [x] + §6 go/no-go 동기화
├── PHASE_2_STEP_6_E2E.md              # 🆕 본 plan
└── PHASE_2_STEP_6_FINDINGS.md         # 🆕 Phase 2 종합 findings
```

서버 코드·schema·UI·shared types 변경 0. Step 6은 e2e + 문서만.

---

## 2. 사전 결정 (요약 표)

| 항목 | 결정 | 근거 |
|---|---|---|
| 1. 자동화 도구 | **Playwright Chromium** (Phase 0.5 e2e와 동일) | 같은 의존성·동일 스타일 — 향후 entity 추가 시 같은 패턴 재사용 |
| 2. 실행 모드 | **split-origin 기본** (`http://localhost:8765/platform/customers.html` + API `:3001`). `KLOSER_E2E_BASE_URL` env 지원해서 Caddy single-origin도 동작 (Phase 0.5 e2e 패턴) | Phase 0.5 e2e와 동일 환경 가정 — README의 dev 환경 그대로 |
| 3. 인증 흐름 | login.html 폼 자동화 → live.html 리다이렉트 → 별도 navigate `/platform/customers.html`. `kloserApi.getAccessToken()`이 cookie refresh로 자동 채워짐 | Phase 0.5 e2e의 login pattern 그대로. 별도 mock JWT 안 만듦 |
| 4. 시나리오 수 | **7개 (필수)** — 본 plan §4 | 사용자 지시 (지시문 §2). 추가 케이스는 후속 step에서 |
| 5. cleanup 전략 | 테스트가 만든 row의 id를 Set에 push → `finally` 블록에서 authed `apiDelete('/customers/:id')` 호출. 모든 시나리오 종료 후에도 잔재 row가 남으면 fail | 본 plan §5. e2e가 실 DB를 건드리는 만큼 cleanup이 핵심 |
| 6. 시나리오 격리 | 단일 browser context 안에서 순차 실행 (Phase 0.5 e2e와 같음). 시나리오 간 상태 (KPI/list)는 cleanup으로 격리 | 단일 사용자 흐름이 자연 — 시나리오 1이 만든 row를 시나리오 4에서 수정·삭제하는 흐름 자체가 시연 |
| 7. 어설션 형식 | `pass()` / `fail()` 헬퍼로 콘솔 출력 + `process.exitCode` (Phase 0.5 e2e 동일) | 같은 출력 → CI/스크립트에서 동일 판정 |
| 8. console error gate | 시나리오 종료 시 `consoleErrors.length === 0` 검증 (Phase 0.5 e2e §12 동일) | UI 깨짐의 1차 표면 — 시각 검증 보강 |
| 9. seed 의존성 | Acme 12명 + Beta 12명 (`server/seeds/0002_customers.sql` 기준) 가정. 시나리오 1이 12명 가정으로 시작 | seed 외 잔재가 있으면 db 직접 cleanup 가이드는 Step 5 finding §6 인계 그대로 |
| 10. 신규 row 식별 prefix | `e2etest-` (이름 앞에 박음) — 사람이 봐도 시각으로 식별, finally cleanup grep도 가능 | Step 4 unit 테스트의 `routetest-`, Step 5 시각 검증의 `검증고객`과 구분 |
| 11. 시나리오 실패 시 cleanup | `try/finally` 패턴 — 시나리오 본문이 throw해도 cleanup이 실행되어야 함. cleanup 자체가 throw해도 다음 cleanup이 진행되도록 individual try/catch | e2e가 중도 fail하고 잔재 row 남기는 회귀 방지 |
| 12. timeout 정책 | 페이지 로드 wait 5s, list 갱신 wait 3s, KPI 갱신 wait 3s | Phase 0.5 e2e와 같은 보수적 budget. flaky 회피 |
| 13. 회귀 baseline | `phase_0_5_e2e.mjs` 16/16 PASS는 본 step에서도 유지 | customers e2e와 통화 e2e가 별개 파일 — 서로 영향 없음 |
| 14. 스크린샷 저장 | `test/phase_2_customers_e2e.png` (Phase 0.5 e2e 패턴 그대로). git ignore 정책은 `test/phase_0_5_e2e.png`와 같음 (이미 ignored) | 시각 evidence + git noise 회피 |

---

## 3. e2e 환경 + 실행 전제

### 환경

| 컴포넌트 | 명령 | 포트 |
|---|---|---|
| Postgres + Redis | `docker compose up -d --remove-orphans` (ops/) | 5432 / 6379 |
| Migrate + seed | `npm --prefix server run db:migrate:up && npm --prefix server run db:seed` | — |
| Server (API + WS) | `npm --prefix server run dev` | 3001 |
| Static (platform) | `npx http-server . -p 8765 --silent` (또는 `python -m http.server 8765` from repo root) | 8765 |

### 실행

```bash
# 기본 (split-origin)
node test/phase_2_customers_e2e.mjs

# Caddy single-origin (선택)
KLOSER_E2E_BASE_URL=https://localhost node test/phase_2_customers_e2e.mjs
```

### 사전 검증 (e2e 본문 시작 전)

- `GET /health` 200 응답 — server 가동 여부 1차 확인
- seed 가정: `GET /customers/stats` (admin@acme.test JWT)가 `{ total:12, active:7, review:3, pending:2 }` — 시나리오 1이 이 가정 위에 빌드됨

### 만약 사전 검증 실패

- "API health probe failed" → server 미가동 안내
- "seed counts mismatch" → `npm --prefix server run db:seed` 안내. 자동 재실행은 안 함 (e2e는 read-mostly + 자기 row만 cleanup, seed 자체는 evaluator 책임)

---

## 4. 시나리오 (7개)

### 시나리오 1 — 로그인 + Acme list 12명

```
1. /platform/login.html 접속
2. admin@acme.test / acme-admin-1234 입력 → 로그인
3. /platform/live.html으로 redirect (auth gate 통과)
4. /platform/customers.html navigate
5. 검증:
   - 12개 row가 #customersTable에 렌더
   - KPI: total 12, active 7, review 3, pending 2
   - sidebar count도 12
   - console error 0
```

### 시나리오 2 — 신규 추가

```
1. "고객 추가" 버튼 클릭 → 모달 open
2. name="e2etest-<timestamp>", company="E2E Co", status=pending 입력
3. "고객 추가" 클릭 → POST /customers 201
4. 응답 customer.id 추적 (cleanup용)
5. 검증:
   - 모달 닫힘
   - list 13개 row + 새 row 표시 (default sort=created_at desc → 최상단)
   - KPI: total 13, pending 3
   - sidebar count 13
```

### 시나리오 3 — 수정

```
1. 시나리오 2의 row 클릭 → edit 모달 open + 값 prefill
2. status를 active로 변경, name 끝에 "-edited" 추가
3. "저장" 클릭 → PATCH /customers/:id 200
4. 검증:
   - 모달 닫힘
   - 같은 id row의 status badge "활성"
   - row 이름 "...-edited"
   - KPI: pending 2 (3 → 2), active 8 (7 → 8)
```

### 시나리오 4 — 삭제

```
1. 시나리오 3의 row 클릭 → edit 모달 open
2. "삭제" 버튼 클릭 → confirm 자동 accept (`page.on("dialog", d => d.accept())`로 등록된 dialog 핸들러)
3. DELETE /customers/:id 204
4. 검증:
   - 모달 닫힘
   - list 12개 row (삭제된 id 없음)
   - KPI: total 12, active 7
   - cleanup Set에서도 해당 id 제거 (이미 soft-deleted라 finally에서 다시 삭제할 필요 없음)
```

### 시나리오 5 — Beta 격리

```
1. logout (kloserApi.logout) + login.html 재진입
2. admin@beta.test / beta-admin-1234 입력 → 로그인
3. /platform/customers.html navigate
4. 검증:
   - 12개 row, **이름 set이 Acme seed (김민수/이지은/...)와 disjoint**
   - 12명 모두 정승호/이채린/박재훈/... 같은 Beta seed 이름
   - KPI total 12 (Beta 분포)
   - 다시 admin@acme.test로 logout/login 후 customers.html → Acme 12 복귀 확인
```

### 시나리오 6 — `status=active` 필터 정합

```
1. (admin@acme.test 상태에서) status=active chip 클릭
2. URL에 ?status=active 반영, list 7개 (active만)
3. "고객 추가" 모달 → name="e2etest-filter-<timestamp>", status=pending → 저장
4. POST /customers 201, cleanup Set에 id 추가
5. 검증:
   - list 여전히 7개 (필터 위반 없음 — 새 pending row는 active 필터에 안 잡힘)
   - KPI: total 13 (12 → 13), pending 3 (2 → 3) — 서버 stats 기준 반영
6. cleanup으로 새 row 삭제 → list 7개 + KPI total 12 / pending 2 복귀 확인
```

### 시나리오 7 — 잔재 row 0 (cleanup 검증)

```
모든 시나리오 종료 후:
1. 새 fetch (`GET /customers?limit=100`)로 list 가져오기
2. 검증:
   - 12개 row + 이름 모두 seed 패턴 (e2etest- prefix 0)
   - KPI: total 12 (Acme 기준)
3. seed UUID 외 row가 있으면 fail — cleanup이 leak 검출
```

---

## 5. cleanup 원칙

### 핵심 약속

> **테스트가 만든 row는 테스트가 자체 정리한다.** 다음 e2e 실행이 깨끗한 seed 상태에서 시작될 수 있어야 함.

### 메커니즘

```js
const createdIds = new Set();        // 시나리오에서 만든 customer id 추적
let acmeToken = null;                 // 마지막 로그인 토큰

async function authedDelete(id) {
  // 직접 fetch — UI 흐름과 분리. 시나리오 본문이 fail해도 cleanup은 동작
  const r = await fetch(`${API_BASE}/customers/${id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${acmeToken}` },
  });
  // 204 / 404 모두 OK (이미 삭제됨)
  if (!r.ok && r.status !== 204 && r.status !== 404) {
    console.error(`[cleanup] DELETE ${id} → ${r.status}`);
  }
}

try {
  // 시나리오 1~7 본문
} finally {
  // Beta 시나리오 후 acmeToken 갱신 필요 — finally에서 admin@acme로 fresh login
  if (createdIds.size > 0 && !acmeToken) {
    acmeToken = await freshAcmeLogin();
  }
  for (const id of createdIds) {
    try { await authedDelete(id); }
    catch (e) { console.error(`[cleanup] ${id} threw:`, e.message); }
  }
}
```

### finally의 individual try/catch

cleanup 한 건이 throw해도 다음 row의 cleanup이 멈추지 않도록 각 `await authedDelete()`를 자체 try/catch로 감쌈. cleanup이 fail하더라도 시나리오 본문의 fail은 그대로 표면화 (`process.exitCode` 우선).

### Beta 로그인 후 acme 토큰 만료

시나리오 5에서 logout/login → Beta 토큰만 메모리에 남음. cleanup은 acme row를 지워야 하므로 **finally 시작 시 `freshAcmeLogin()`로 acme 토큰 재발급**. 토큰 발급은 직접 `POST /auth/login` (페이지 우회).

### 시나리오 7의 의의

cleanup 후 list/stats가 seed 12명으로 복귀하는지 검증 — cleanup mechanism 자체의 회귀 안전망. 시나리오 1~6에서 leak이 발생하면 시나리오 7에서 표면화.

---

## 6. 회귀 검증 (4종 + 본 e2e)

| 검증 | 명령 | 기대 |
|---|---|---|
| typecheck | `npm --prefix server run typecheck` | PASS |
| server unit | `npm --prefix server test` | 65/65 PASS |
| sync types | `node test/sync_shared_types.mjs` | `customers OK ...` |
| phase 0.5 e2e | `node test/phase_0_5_e2e.mjs` | 16/16 PASS |
| **본 step e2e** | `node test/phase_2_customers_e2e.mjs` | **7 시나리오 + cleanup 검증 PASS** |

5종 모두 PASS이면 Phase 2 go/no-go (master §6) 통과.

---

## 7. 위험·미정

| 항목 | 처리 |
|---|---|
| 시나리오 5 (Beta 로그인) 후 acme 토큰 invalidate | 새 로그인 흐름. cleanup의 freshAcmeLogin이 자동 처리 |
| sort=created_at desc에서 갓 추가된 row가 최상단이 아닐 가능성 | seed 24명 모두 `now() - interval`로 분포되어 있어 새 row created_at = 현재 = 최대값 → desc 정렬상 최상단 |
| KPI 갱신 wait 부족 | `await page.waitForFunction(...)`으로 polling — 단순 sleep 대신 |
| Playwright Chromium cache | 본 step finding §7 (Step 5 finding §6과 같은 이슈) — fresh context로 시작, 매 시나리오마다 page reload는 안 함 (cache 영향 미미) |
| 시나리오 6에서 chip click 후 list 7개 보장 | URL `?status=active` 반영 + 별도 wait. seed의 active 7명이 명확하므로 결정적 |
| seed 비-Acme/Beta UUID row가 남아 있으면 시나리오 7 fail | 시나리오 7 메시지에 "test/sync helper로 cleanup 후 재실행" 안내 |
| customers.html 캐싱으로 옛 코드 동작 | 본 step plan §3 환경 가정상 dev 서버 (캐싱 약함) — Phase 0.5 e2e와 동일 risk profile |
| confirm dialog 자동 accept | Playwright `page.on('dialog', d => d.accept())` 채택 — `test/phase_2_customers_e2e.mjs` §168이 page-level dialog 핸들러 1회 등록으로 모든 시나리오 confirm/alert를 자동 수용. `window.confirm` 오버라이드는 매 시나리오마다 page reload 시 다시 주입해야 해서 더 복잡 — Phase 0.5 e2e 패턴 없음, 본 step에서 dialog 이벤트 방식으로 신규 도입 |
| 시나리오 본문이 throw하면 cleanup이 stale acme 토큰으로 시도 가능 | finally의 freshAcmeLogin이 항상 새 토큰 발급 |
| screenshot 경로 git tracked 회귀 | `test/phase_0_5_e2e.png` 경로 정책과 동일 — `test/phase_2_customers_e2e.png`도 ignore 정책 적용 (`.gitignore` 또는 같은 패턴 follow) |

---

## 8. 완료 기준 (Step 6 — go/no-go)

- [x] `test/phase_2_customers_e2e.mjs` 작성 — 7 시나리오 모두 + cleanup 검증
- [x] `node test/phase_2_customers_e2e.mjs` PASS (시나리오 1~7 모두)
- [x] cleanup 후 잔재 row 0 (시나리오 7이 직접 검증)
- [x] `npm --prefix server run typecheck` PASS
- [x] `npm --prefix server test` 65/65 회귀 PASS
- [x] `node test/sync_shared_types.mjs` PASS
- [x] `node test/phase_0_5_e2e.mjs` 16/16 회귀 PASS
- [x] `docs/plan/phase-2/PHASE_2_STEP_6_FINDINGS.md` 작성 (Phase 2 종합 + deferred 정리)
- [x] `docs/plan/phase-2/PHASE_2_MASTER.md` Step 6 [x] + §6 go/no-go 체크 동기화
- [x] README 상태 블록 갱신 (루트 README + server/README — Phase 2 완료 반영)
- [x] USER_GUIDE_PHASE_1.md / AGENTS.md 같은 사용자 별도 편집 파일은 건드리지 않음. Phase 1 visual guide(`PHASE_1_FOUNDATIONS.html`)와 화면별 가이드(`USER_GUIDE.html`)는 Phase 2 진입 링크만 최소 갱신 (헤더 nav 1줄 + 푸터 nav 1줄 + 본문 reference 1줄).

---

## 9. 한 줄 요약

> **반나절 동안 customers CRUD 흐름을 7 시나리오 e2e로 자동화하고, finally 기반 cleanup 약속으로 잔재 row 0을 보장해 Phase 2 go/no-go 통과 + Phase 2 전체를 main에 머지 가능한 상태로 만든다.**

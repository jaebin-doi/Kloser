# Phase 2 Step 5 — `customers.html` 실 API 연결

> **상위 계획**: `docs/plan/PHASE_2_MASTER.md` §3 Step 5 + §1.
> **선행**: Step 4 완료 — `PHASE_2_STEP_4_ROUTES.md`, `PHASE_2_STEP_4_FINDINGS.md`.
> **기간**: 1.5일.
>
> ⚠️ **본 plan은 domain cleanup (`customers.plan` 제거) 반영 후 최종 모델 기준으로 갱신됐다.** 도입 당시 (2026-05-08 오전) 작성 시점에는 plan chip group / plan 모달 select / plan 컬럼 / planColors / plan URL query가 포함됐지만, 같은 날 오후 도메인 경계 충돌 (`organizations.plan`과 단어 겹침)로 전면 제거. 변경 이유·영향은 `PHASE_2_STEP_5_FINDINGS.md` 참조.

---

## 진행 상태

- [x] 1. 페이지네이션·렌더 정책 사전 결정 (본 plan §2) 검증
- [x] 2. 모달 듀얼 모드 (create + edit) 사전 결정 (본 plan §6) 검증
- [x] 3. ISO Date → 한국어 상대시간 helper 위치 사전 결정 (본 plan §7) 검증
- [x] 4. 에러 응답 두 형식 분기 정책 사전 결정 (본 plan §8) 검증
- [x] 5. URL query string 동기화 정책 사전 결정 (본 plan §5) 검증
- [x] 6. `platform/api.js`에 `apiPatch` + `apiDelete` 추가
- [x] 7. `platform/_shared.js`에 ISO → 상대시간 helper (`formatRelativeTime`) 추가
- [x] 8. `platform/customers.html` 갱신 — mock JS 제거 + fetch 흐름 + 모달 듀얼 모드 + URL sync + 에러 처리
- [x] 9. 브라우저 시각 검증 — Acme 12명 / 신규 추가 / 수정 / 삭제 / Beta 격리 5 시나리오 (본 plan §9)
- [x] 10. `node test/sync_shared_types.mjs` PASS (회귀)
- [x] 11. `npm --prefix server test` 65/65 회귀 PASS (서버 무변경)
- [x] 12. `node test/phase_0_5_e2e.mjs` 16/16 회귀 PASS
- [x] 13. `docs/plan/PHASE_2_STEP_5_FINDINGS.md` 작성 (domain cleanup record 포함, 별도 커밋으로 push 됨)

---

## 0. 목적

Step 1~4가 schema·repository·service·shared types·REST routes를 완성했다. Step 5는 그 위에 **사람이 직접 만지는 첫 화면**을 얹는다 — `platform/customers.html`을 mock 12명 하드코딩에서 실 API 호출로 전환.

이 step이 끝나면:
- `customers.html`이 mock JS 0줄. 모든 데이터가 `kloserApi.apiGet/apiPost/apiPatch/apiDelete`로 흐름
- 4 KPI 카드가 `GET /customers/stats` 응답으로 갱신
- 검색 input + 필터 chip 2 그룹 (status / sort 동시 active 가능) → URL query string → `GET /customers?...` 호출 → 렌더
- "고객 추가" 모달 → `POST /customers` → 성공 후 list + stats 재조회 (`loadAll`)
- 행 클릭 → 같은 모달 (편집 모드) → `PATCH /customers/:id` 또는 "삭제" 버튼 → confirm → `DELETE /customers/:id`
- 다른 org 계정으로 로그인 → 다른 12명 + 다른 KPI (격리 시각 확인)

Step 6 (`phase_2_customers_e2e.mjs` + 종합 findings) 진입 가능.

---

## 1. 디렉토리 변화

```text
platform/
├── api.js                          # ⬆ apiPatch / apiDelete 추가
├── _shared.js                      # ⬆ formatRelativeTime helper 추가
├── customers.html                  # ⬆ mock JS 제거 + fetch 흐름 도입
└── types/
    └── customers.js                # 변경 없음 (Step 3 결과물 그대로)
```

서버 코드 변경 0. Step 5는 client only.

---

## 2. 사전 결정 (요약 표)

| 항목 | 결정 | 근거 |
|---|---|---|
| 1. 페이지네이션 UI | **본 step에서 미도입** — 단일 GET `/customers?limit=100`으로 1회 fetch (org 고객 수 ≤ 100인 데모 단계) | 마스터 §2-3 (offset+limit+total)는 서버 계약. UI는 평가 데모에서 12명·≤100명 조회만 — 무한 스크롤·prev/next는 Phase 4+ 운영 데이터 늘면 도입 |
| 2. 검색 입력 debounce | **300ms** | 매 keystroke마다 서버 호출은 과함. mock UI도 즉시 필터지만 API에선 짧은 debounce 권장 |
| 3. 필터 chip 구조 — **2 그룹 분리** (status / sort) | mock UI는 단일 `.filter-chip` 그룹 (한 번에 하나만 active). Step 5는 2 그룹으로 재구성해 status/sort를 동시에 URL query에 올림. (a) **status 그룹**: 전체 / 활성 / 검토중 / 대기 → `status=`/`active`/`review`/`pending`. (b) **sort 그룹**: 최신순 / 최근 연락 → `sort=created_at` (default) / `sort=last_contacted_at&dir=desc`. 각 그룹은 자체 단일 선택 (그룹 내 chip 클릭 시 같은 그룹 chip에서만 active 제거). 그룹 간 동시 active 가능 → 예: `?status=active&sort=last_contacted_at&dir=desc`. (도입 시점에는 `plan` 그룹도 포함됐지만 domain cleanup으로 제거 — `customers.plan` 컬럼이 `organizations.plan`과 충돌해 Step 5 findings §1에서 단일 결정으로 drop) | 서버 query 계약 (`CustomerListQuery`)이 status/sort 2 차원을 별개로 받음 — 단일 그룹은 한 차원만 활용해 계약 미사용. 사전 결정 §2-12 (URL이 view state)도 다차원 chip을 전제로 함 |
| 4. URL query string 동기화 | `history.replaceState`로 brower URL 갱신. 새로고침/북마크 시 같은 view 복구 | 마스터 §2-12. SPA 아니므로 push 필요 없음 (페이지 이동은 sidebar) |
| 5. 행 클릭 동작 | **모달 듀얼 모드** — 같은 모달이 create/edit 두 상태. 행 클릭 = edit 모드 + 값 prefill | 마스터 §3 Step 5 "inline edit (또는 PATCH 모달)" 선택. 모달이 inline edit보다 검증·UX 단순. 본 plan §6에서 형태 |
| 6. 삭제 UX | edit 모달 안 footer에 "삭제" 보조 버튼 — 클릭 시 `confirm("정말 삭제?")` → `DELETE` | confirm dialog는 native (Phase 6+ 디자인 통합 시 toast 기반 confirm으로 교체) |
| 7. ISO Date → 상대시간 helper 위치 | **`platform/_shared.js`에 `formatRelativeTime(iso)` 추가** | Step 4 finding §6의 옵션 B. Phase 4+ live 통화·transcript 시간 표시도 같은 함수 재사용 가능 |
| 8. 에러 응답 두 형식 분기 | helper `parseApiError(response)` — body parse 후 `error` field로 분기 (`invalid_input` vs `invalid_<field>` vs `not_found` vs `forbidden`). 각 케이스 사용자 메시지 매핑 | Step 4 finding §1. inline 분기는 호출처마다 복제됨 — helper 1개로 통합 |
| 9. 4 KPI 카드 데이터 소스 | `GET /customers/stats` 별도 호출 (list 호출과 병렬 OK — 서로 다른 endpoint이므로 fastify가 동시 처리) | 마스터 §2-13. list cache invalidation과 stats 분리 |
| 10. POST/PATCH/DELETE 후 처리 | 응답 검증 후 **`await loadAll()`로 list + stats 서버 재조회**. local prepend/in-place/splice + KPI 직접 +/- 같은 optimistic update는 본 step에서 **하지 않음** | URL query (q/status/sort)가 활성 상태에서 local-only 반영은 정합 깨짐 — 예: `status=active` 화면에서 `pending`으로 POST하면 prepend된 row가 필터 위반, `sort=last_contacted_at` 상태에서 prepend는 정렬 위반, PATCH로 status/name 바뀌면 현재 view에서 빠져야 할 row가 남거나 보여야 할 row가 안 보임. limit=100 단일 fetch는 데모 규모에서 ms 단위 — 정합성 가치 >> 부하. optimistic update는 Phase 6+ 운영 최적화 시점 |
| 13. 인증 게이트 | 페이지 로드 시 `kloserApi.getAccessToken()` 없으면 `kloserApi.refreshAccessToken()` 시도 → 실패 시 `loginRedirect()` (live.html 패턴 그대로) | Phase 1 패턴 그대로 |
| 14. `mock UI 외관 변경 0` | 시각 디자인·layout·CSS 변경 없음. 데이터 source만 교체 | 평가자가 즉시 동일 외관에서 진짜 데이터 시연 가능 (마스터 §0) |
| 15. POST 모달 필드 vs 서버 schema | 최종 모달 필드: name (필수) / company / email / phone / status. mock UI의 `memo` textarea는 서버 schema에 없으므로 제거. (도입 시점 본 표는 `plan` 추가도 포함했지만 domain cleanup으로 drop — 서버 `CustomerCreateInput`에서 plan 필드 자체 제거됨) | mock UI의 memo 필드는 본 phase 미구현. 제거가 깔끔 — 서버 `CustomerCreateInput` schema와 정확 정합 |
| 16. 검증 데이터 갱신 cleanup | **본 step에서 자동 cleanup 없음** — UI 시각 검증 후 발생한 row는 evaluator가 직접 삭제 (또는 `db:seed` 재실행). e2e 자동화는 Step 6 | UI 시각 검증은 ad-hoc, e2e가 자동 회귀 |

---

## 3. `platform/api.js` 확장 — `apiPatch` + `apiDelete`

현재 `kloserApi`는 `apiGet` / `apiPost`만 노출 (`apiGet`이 `opts.method` override를 받지만 ad-hoc 형태). PATCH/DELETE 호출이 늘어나므로 같은 패턴으로 명시 helper 추가.

### 추가 함수

```js
function apiPatch(path, body, opts) {
  const optsLocal = opts || {};
  const headers = Object.assign(
    { 'Content-Type': 'application/json' },
    optsLocal.headers || {},
  );
  return authFetch(path, {
    method: 'PATCH',
    headers: headers,
    body: typeof body === 'string' ? body : JSON.stringify(body || {}),
  });
}

function apiDelete(path, opts) {
  const optsLocal = opts || {};
  return authFetch(path, {
    method: 'DELETE',
    headers: optsLocal.headers,
  });
}

window.kloserApi = {
  // ... 기존 항목 그대로
  apiGet,
  apiPost,
  apiPatch,    // 🆕
  apiDelete,   // 🆕
  // ...
};
```

기존 `apiGet`/`apiPost`와 같은 401 → refresh → retry 흐름 자동 적용 (`authFetch` 경유).

### 변경 비용

`platform/api.js`만 두 함수 + `window.kloserApi` export 항목 2줄 추가. 기존 `apiGet`/`apiPost`는 **무변경**. live.html / login.html 등 기존 사용처에 회귀 없음.

---

## 4. `platform/customers.html` 변경 항목

### 제거 (mock JS — 약 60줄)

- `let customers = [...]` 12명 하드코딩 배열 (`:190-203`)
- `addCustomer()`의 `customers.unshift(...)` + 카운터 직접 증가 로직
- 4 KPI 카드의 하드코딩 숫자 (`2,486`, `1,892`, `312`, `282`)
- 모달의 `memo` textarea (서버 schema 없음 — 사전 결정 §2-15)
- 모달 이메일 라벨의 `<span class="text-rose-500">*</span>` 필수 표식 + `addCustomer()`의 `if (!name || !email)` 검증 — **이메일은 서버 schema에서 nullable/optional**. 필수는 `name`만 (사전 결정 §2-15)

### HTML 구조 변경 — 필터 chip 2 그룹 분리 (사전 결정 §2-3)

기존 `<div>` 한 줄에 단일 `.filter-chip` 그룹 (mock UI) → status/sort 2 그룹 컨테이너로 분리. 클릭 핸들러도 그룹 단위 (active toggle은 같은 그룹 chip만). (도입 시점에는 `plan` 포함 3 그룹이었으나 domain cleanup으로 2 그룹으로 축소.)

```html
<div class="chip-group" data-group="status">
  <button class="filter-chip active" data-value="">전체</button>
  <button class="filter-chip" data-value="active">활성</button>
  <button class="filter-chip" data-value="review">검토중</button>
  <button class="filter-chip" data-value="pending">대기</button>
</div>
<div class="chip-group" data-group="sort">
  <button class="filter-chip active" data-value="created_at">최신순</button>
  <button class="filter-chip" data-value="last_contacted_at">최근 연락순</button>
</div>
```

핸들러:
```js
document.querySelectorAll('.chip-group').forEach((group) => {
  const dim = group.dataset.group; // 'status' | 'sort'
  group.querySelectorAll('.filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      group.querySelectorAll('.filter-chip').forEach((x) => x.classList.remove('active'));
      chip.classList.add('active');
      const v = chip.dataset.value;
      if (dim === 'sort') {
        viewState.sort = v || undefined;
        viewState.dir = v === 'last_contacted_at' ? 'desc' : undefined;
      } else {
        viewState[dim] = v || undefined;
      }
      syncUrl(); loadAll();
    });
  });
});
```

### 추가 (fetch 흐름)

```js
// 1. 인증 게이트 (페이지 로드)
async function ensureAuth() {
  if (!window.kloserApi) { console.error('api.js not loaded'); return false; }
  if (!window.kloserApi.getAccessToken()) {
    try {
      await window.kloserApi.refreshAccessToken();
    } catch (_) {
      window.kloserApi.loginRedirect();
      return false;
    }
  }
  return true;
}

// 2. 상태 (URL ↔ 메모리)
let viewState = readViewStateFromUrl();   // { q, status, sort, dir }
let customers = [];                        // 서버 응답 캐시
let stats = { total: 0, active: 0, review: 0, pending: 0 };

// 3. 데이터 fetch (list + stats 병렬)
async function loadAll() {
  const [listRes, statsRes] = await Promise.all([
    window.kloserApi.apiGet('/customers?' + buildQueryString(viewState) + '&limit=100'),
    window.kloserApi.apiGet('/customers/stats'),
  ]);
  if (!listRes.ok) { showError(await parseApiError(listRes)); return; }
  if (!statsRes.ok) { showError(await parseApiError(statsRes)); return; }
  customers = (await listRes.json()).items;
  stats = await statsRes.json();
  renderTable();
  renderStats();
}

// 4. 입력 → URL → fetch
const debouncedReload = debounce(() => { syncUrl(); loadAll(); }, 300);
searchInput.addEventListener('input', (e) => {
  viewState.q = e.target.value || undefined;
  debouncedReload();
});
// chip click handler는 §4 위쪽 "HTML 구조 변경 — 필터 chip 2 그룹 분리"의
// `.chip-group` 기반 handler를 그대로 사용 (그룹 내 active toggle + viewState
// 갱신 + syncUrl + loadAll). 단일 그룹 forEach 형태는 사용하지 않음.

// 5. POST → 성공 후 loadAll() 재조회
//   현재 URL query (필터/정렬)와 KPI 정합을 서버 기준으로 다시 맞춘다.
//   local prepend/in-place/splice는 필터·sort 위반이 쉽게 발생 — 사전 결정 §2-10.
async function addCustomer() {
  const payload = readModalForm();
  const res = await window.kloserApi.apiPost('/customers', payload);
  if (!res.ok) { showFormError(await parseApiError(res)); return; }
  closeModal(); resetModalForm();
  await loadAll();
}

// 6. PATCH → 성공 후 loadAll() 재조회
async function saveEdit(id) {
  const patch = readModalForm();
  const res = await window.kloserApi.apiPatch(`/customers/${id}`, patch);
  if (!res.ok) { showFormError(await parseApiError(res)); return; }
  closeModal();
  await loadAll();
}

// 7. DELETE → 성공 후 loadAll() 재조회
async function deleteCustomer(id) {
  if (!confirm('정말 삭제하시겠습니까? (복구 불가)')) return;
  const res = await window.kloserApi.apiDelete(`/customers/${id}`);
  if (!res.ok && res.status !== 204) {
    showError(await parseApiError(res)); return;
  }
  closeModal();
  await loadAll();
}
```

### 렌더 변경

- `renderTable()`: server `Customer` shape 그대로 사용. `c.last_contacted_at`은 ISO string → `formatRelativeTime(c.last_contacted_at)`로 변환. `c.company` null이면 빈칸
- `renderStats()`: `stats.total/active/review/pending`을 4 카드에 박음. 비율은 `(active/total*100).toFixed(1) + '%'` 형태 (mock의 76.1% 자리)
- empty state: `customers.length === 0`이면 "고객이 없습니다 / 첫 고객을 추가해 보세요" 메시지
- error state: 최상단 banner 또는 toast. 본 step은 alert로 시작 (Step 5 finding에서 toast 도입 검토)

### `<script>` 추가

```html
<script src="api.js"></script>            <!-- 🆕 -->
<script src="_shared.js"></script>
<script>
  renderSidebar('customers');
  // ...
</script>
```

`api.js`를 `_shared.js`보다 먼저 로드 — `kloserApi`가 page script보다 먼저 준비되어야 함.

---

## 5. URL query string 동기화

### viewState ↔ URL 매핑

```
?q=<search>&status=<active|review|pending>&sort=last_contacted_at&dir=desc
```

전체/필터 없음 = key 자체 미존재. mock UI의 chip 활성 상태와 1:1.

### 함수

```js
function readViewStateFromUrl() {
  const p = new URLSearchParams(window.location.search);
  return {
    q: p.get('q') || undefined,
    status: p.get('status') || undefined,    // active|review|pending
    sort: p.get('sort') || undefined,         // name|created_at|last_contacted_at
    dir: p.get('dir') || undefined,           // asc|desc
  };
}

function buildQueryString(state) {
  const p = new URLSearchParams();
  if (state.q)      p.set('q', state.q);
  if (state.status) p.set('status', state.status);
  if (state.sort)   p.set('sort', state.sort);
  if (state.dir)    p.set('dir', state.dir);
  return p.toString();
}

function syncUrl() {
  const qs = buildQueryString(viewState);
  const newUrl = window.location.pathname + (qs ? '?' + qs : '');
  window.history.replaceState(null, '', newUrl);
}
```

`replaceState`이라 뒤로가기 stack은 안 늘어남 — 페이지 navigation은 sidebar의 `<a>` 클릭이 담당. mock UI의 single-page navigation 모델 유지.

### 부수 효과

- 새로고침 → URL 그대로 → `readViewStateFromUrl`이 viewState 복구 → 같은 view
- 북마크 가능 — "내가 보던 검토중 고객 목록" URL 그대로 공유

---

## 6. 모달 듀얼 모드 (create + edit)

### 상태

```js
let modalMode = 'create';   // 'create' | 'edit'
let editingId = null;       // edit 모드일 때만 set
```

### `openModal(customer?)`

- 인자 없음 → create 모드. 모달 제목 "새 고객 추가", 입력 필드 빈값, footer 버튼 "고객 추가" 1개
- `customer` 객체 인자 → edit 모드. 모달 제목 "고객 정보 수정", 입력 필드 prefill, footer 버튼 "저장" + "삭제" 2개. `editingId = customer.id`

### 모달 필드 (서버 schema와 정합)

| 필드 | 입력 타입 | 서버 | 비고 |
|---|---|---|---|
| 이름 (**필수 — 유일**) | text | `name` | 빈값이면 client에서 차단 + 서버 schema도 `min(1)` |
| 회사 | text | `company` (nullable) | 빈값 → 서버에 `null` 또는 누락 전달 |
| 이메일 | email | `email` (nullable) | **필수 아님** — mock UI의 `*` 표식 제거. 빈값 허용 |
| 전화번호 | text | `phone` (nullable) | 빈값 허용 |
| 상태 | select (활성/검토중/대기) | `status` | default `pending` |

(도입 시점에는 `플랜 select (Starter/Pro/Enterprise/-)` 행도 포함됐지만 domain cleanup으로 제거 — Step 5 findings §1.)

제거:
- mock UI의 `memo` textarea — 서버 schema에 없음
- mock UI 이메일 라벨의 `<span class="text-rose-500">*</span>` 필수 표식
- `addCustomer()`의 `if (!name || !email)` 검증 — `name`만 검증으로 변경
- mock UI의 `플랜` select — domain cleanup으로 컬럼 자체 제거

### 저장 동작

- create: `addCustomer()` → `POST /customers` → 성공 후 `loadAll()` 재조회
- edit: `saveEdit(editingId)` → `PATCH /customers/:id` → 성공 후 `loadAll()` 재조회
- delete (edit 모드 only): `deleteCustomer(editingId)` → confirm → `DELETE /customers/:id` → 성공 후 `loadAll()` 재조회

세 동작 모두 동일 패턴 — local state 직접 조작 (prepend / in-place / splice / KPI +-) 사용 안 함 (사전 결정 §2-10).

### 행 클릭 → edit 모드 진입

```js
function onRowClick(customer) {
  modalMode = 'edit';
  editingId = customer.id;
  fillModalForm(customer);
  setModalTitleAndButtons('edit');
  openModal();
}
```

mock UI의 행 우측 `...` 버튼은 **제거**하고 행 전체를 클릭 영역으로 변경 (체크박스·드롭다운 영역은 `event.stopPropagation()`).

---

## 7. ISO Date → 한국어 상대시간 helper

### `platform/_shared.js`에 추가 (Step 4 finding §6의 옵션 B)

```js
// 입력: ISO 8601 string (서버에서 옴) 또는 null
// 출력: "방금 전" / "5분 전" / "2시간 전" / "어제" / "3일 전" / "1주 전" / "2주 전" / "MM/DD"
function formatRelativeTime(iso) {
  if (!iso) return '-';
  const now = Date.now();
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '-';

  const diffSec = Math.max(0, Math.floor((now - t) / 1000));
  if (diffSec < 60)        return '방금 전';
  if (diffSec < 3600)      return `${Math.floor(diffSec / 60)}분 전`;
  if (diffSec < 86400)     return `${Math.floor(diffSec / 3600)}시간 전`;

  const diffDay = Math.floor(diffSec / 86400);
  if (diffDay === 1)       return '어제';
  if (diffDay < 7)         return `${diffDay}일 전`;
  if (diffDay < 30)        return `${Math.floor(diffDay / 7)}주 전`;

  // 30일 이상 — 절대 날짜로 표시
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

window.formatRelativeTime = formatRelativeTime;
```

### 사용처

- `customers.html`의 `last_contacted_at` 컬럼
- Phase 4+ live.html의 transcript 시각·통화 종료 시각·다른 entity 페이지 — 같은 함수 재사용

### 본 step에서 정착시키는 약속

`platform/_shared.js`는 사이드바·로그아웃·페이지 공통 유틸의 자리. `formatRelativeTime`도 같은 자리에 둬 **다음 entity (Phase 4+) 진입 시 무수정으로 import**.

---

## 8. 에러 응답 두 형식 분기

### Step 4 finding §1 그대로

```
GET /customers (query invalid):  { error: "invalid_<field>", value: "<raw>" }
POST/PATCH (body/params):        { error: "invalid_input", issues: <flatten> }
404:                             { error: "not_found" }
403:                             { error: "forbidden" }
401:                             { error: "<msg>" }
```

### helper

```js
async function parseApiError(response) {
  let body = null;
  try { body = await response.json(); } catch (_) { /* */ }
  const err = (body && body.error) || `http_${response.status}`;

  // Translate to user-facing Korean message
  if (err === 'invalid_input') {
    return '입력값이 올바르지 않습니다.';
  }
  if (err.startsWith('invalid_')) {
    return `필터 값이 올바르지 않습니다: ${err.replace('invalid_', '')}`;
  }
  if (err === 'not_found')  return '고객을 찾을 수 없습니다.';
  if (err === 'forbidden')  return '권한이 없습니다.';
  if (response.status === 401) return '로그인이 필요합니다.';
  return '요청 처리 중 오류가 발생했습니다.';
}
```

### 사용

- `loadAll()` 실패 시 → 화면 상단 banner 또는 alert
- `addCustomer()`/`saveEdit()` 실패 시 → 모달 안 inline 메시지 (form 위 banner)
- `deleteCustomer()` 실패 시 → alert

본 step은 **alert로 시작** — 시각적 다듬기는 Step 5 finding에서 toast/banner 도입 검토.

---

## 9. 검증 시나리오 (브라우저 시각 — 5종)

### 환경

- `npm --prefix server run dev` (3001)
- **`python -m http.server 8765`** — repo root에서 실행. `--directory platform/` 사용 금지: `api.js`의 `LOGIN_PATH = '/platform/login.html'`이라 root가 platform/이 되면 404. README 패턴과 정합
- 접속 URL: `http://localhost:8765/platform/customers.html`
- Chrome DevTools Network 탭 열어두고 진행

### 시나리오 (mutation 후 loadAll() 재조회 정책 — 사전 결정 §2-10)

```
1. 로그인 → /platform/customers.html
   - admin@acme.test / acme-admin-1234
   - 화면: 12명 (seed Acme), 4 KPI 카드 { total:12, active:7, review:3, pending:2 }
   - DevTools: GET /customers + GET /customers/stats 두 호출, 각 200

2. "고객 추가" → 모달 입력 → 저장
   - 이름: 검증고객, 회사: TestCo, 이메일: ver@example.test, status: pending(default)
   - DevTools: POST /customers (201) → loadAll → GET /customers + GET /customers/stats (각 200)
   - 화면: 13명 표시 (서버 정렬·필터 기준 — 현재 default sort=created_at desc면 최상단)
   - 4 KPI: total: 13, pending: 3 (서버 stats 응답 그대로)

3. 행 클릭 → edit 모달 → 상태 active → 저장
   - 같은 검증고객 row 클릭, 모달 edit 모드 값 prefill 확인
   - DevTools: PATCH /customers/:id (200) → loadAll → GET /customers + GET /customers/stats
   - 화면: 같은 row의 status badge 갱신
   - 4 KPI: pending: 2, active: 8

4. 같은 row → edit 모달 → 삭제
   - confirm 다이얼로그 OK
   - DevTools: DELETE /customers/:id (204) → loadAll → GET /customers + GET /customers/stats
   - 화면: row 사라짐 (count 12)
   - 4 KPI: total: 12, active: 7

5. 로그아웃 → admin@beta.test로 로그인 → /platform/customers.html
   - 화면: Beta seed 12명 (이름 set: 정승호/이채린/박재훈/...). Acme set과 disjoint 확인
   - 4 KPI: { total:12, active:?, review:?, pending:? } (Beta 분포)
   - URL query string 다른 view로 변경해도 cross-org leak 없음

(추가 — 필터/정렬 정합 시각 검증)
6. status=active 필터 chip 활성 상태에서 "고객 추가" → status=pending 입력 → 저장
   - mutation 후 loadAll이 status=active query로 재조회 → 새 row는 응답에 없음
   - 화면: list 그대로 (필터 위반 안 함). KPI는 total +1, pending +1 정확 반영
   - 같은 chip을 "전체"로 바꾸면 새 row 보임 — 데이터는 서버에 정상 저장됨을 시각 확인
```

각 시나리오에 대해:
- DevTools Network 탭에서 정확한 endpoint + method + status 확인
- Response body 구조가 Step 3 shared types와 일치 (`customer.id`, `customer.last_contacted_at` ISO string 등)
- 시각적으로 외관이 mock UI와 동일 (마스터 §0)

### 회귀 검증

- `node test/sync_shared_types.mjs` PASS — 본 step에서 `platform/types/customers.js`에 변경 없으므로 자동 PASS
- `npm --prefix server test` 65/65 PASS — 서버 무변경
- `node test/phase_0_5_e2e.mjs` 16/16 PASS — Phase 0.5 e2e가 customers 페이지를 로드 안 하므로 무관, 그래도 baseline 회귀

---

## 10. 위험·미정

| 항목 | 처리 |
|---|---|
| `kloserApi.apiPatch`/`apiDelete`가 다른 페이지에 회귀 | 기존 `apiGet`/`apiPost` 무변경. 새 함수 추가만 — 다른 페이지 (live.html / login.html) 영향 zero. live e2e 16/16이 회귀 안전망 |
| 필터 chip이 그룹 분리 후 active toggle 범위 실수 | mock UI는 단일 그룹 (`document.querySelectorAll('.filter-chip')` 전체에서 active 제거). Step 5는 같은 `.chip-group` 안에서만 active toggle — `group.querySelectorAll('.filter-chip')`로 좁힘. 잘못 구현하면 다른 그룹 chip이 의도치 않게 deactivate. 사전 결정 §2-3 sketch 그대로 따르면 안전 |
| 검색 input debounce가 너무 짧으면 서버 부하 | 300ms — keystroke 빠른 사용자도 1초당 ~3 fetch 한도. 운영 부하 본격은 Phase 6+ |
| 모달 필드 갯수 vs 서버 schema 차이 | mock의 `memo` 제거 (사전 결정 §2-15). 서버 `CustomerCreateInput` schema와 정확 정합. (도입 시점에는 `plan` 추가도 포함했지만 domain cleanup으로 plan 자체 drop) |
| URL query string 길이 한계 | typical 200자 미만. 모든 필터 동시 활성 시도 안전. 한국어 검색어는 URLEncoded이므로 약 6~8자 = 50자 정도 |
| `formatRelativeTime`의 timezone 의존 | 입력 ISO는 UTC `Z`, `new Date(iso).getTime()`가 사용자 로컬 시각 epoch로 변환 — `Date.now() - t`는 UTC vs UTC라 무관 |
| 행 클릭 vs 체크박스 클릭 충돌 | 체크박스/드롭다운 영역은 `event.stopPropagation()` 명시. mock UI의 `onclick="event.stopPropagation()"` 패턴 유지 |
| mutation 시 매번 GET /customers + GET /customers/stats 재호출 비용 | 데모 규모 (org 당 ≤ 100명) ms 단위. 정합성 가치 >> 부하. Phase 6+ 운영 데이터 늘면 optimistic update + filter-aware merge 도입 검토 |
| 동시에 여러 사용자가 같은 customer 수정 | optimistic update 결과가 다른 사용자의 변경을 덮을 수 있음. Phase 6+ 본격 동시성 도입 시 ETag/version 도입 검토. 본 phase 데모 단계라 무관 |
| 4 KPI 카드의 비율 표시 (mock UI) | mock은 `76.1%` 식 비율. 서버 stats는 4 카운트만 — 비율은 `(active/total*100).toFixed(1)`로 client 계산. total=0이면 `-` 표시 |
| 로그인 직후 access token 발급 시점 | login.html이 setAccessToken 호출. customers.html 로드 시 access token 있으면 OK, 없으면 refresh 시도 — Phase 1 패턴 |
| 다른 org 계정 로그인 시 페이지 reload 안 함 | login.html → customers.html 페이지 이동이 발생하므로 `viewState` reset 자동. 같은 페이지 안 org switch는 본 phase 미지원 |

---

## 11. 완료 기준 (Step 5 — go/no-go)

- [x] `platform/api.js`에 `apiPatch`, `apiDelete` 추가, `window.kloserApi`에 export
- [x] `platform/_shared.js`에 `formatRelativeTime(iso)` 추가, `window.formatRelativeTime`에 export
- [x] `platform/customers.html`에서 mock JS (12명 배열, 하드코딩 KPI 숫자) 모두 제거
- [x] `platform/customers.html`이 `<script src="api.js"></script>`를 포함 (`_shared.js` 보다 먼저)
- [x] **필터 chip 2 그룹 분리** (status / sort) — `<div class="chip-group" data-group="...">` 컨테이너 단위로 active toggle. 그룹 간 동시 활성 → URL `?status=&sort=&dir=` 매핑. (도입 시점 3 그룹 — plan 포함 — 은 domain cleanup으로 2 그룹으로 축소)
- [x] **모달 필수 검증 = `name`만** — mock의 email 필수 표식 (`<span class="text-rose-500">*</span>`) + `addCustomer`의 `if (!name || !email)` 모두 제거. email/phone/company는 빈값 허용, 서버에 null 또는 누락 전달. memo textarea + plan select 모두 제거 (서버 schema 없음 / domain cleanup)
- [x] 페이지 로드 시 `GET /customers + GET /customers/stats` 병렬 호출 + 12명 + 4 KPI 정확히 표시 (admin@acme.test)
- [x] 검색 input + 필터 chip + 정렬 chip 모두 URL query string에 반영, `replaceState`로 새로고침 시 view 복구
- [x] "고객 추가" 모달 → POST → 201 → **`loadAll()` 재호출** → 현재 URL view + 서버 stats 기준 갱신
- [x] 행 클릭 → edit 모달 (값 prefill) → PATCH → 200 → **`loadAll()` 재호출** → 동일 갱신
- [x] edit 모달의 "삭제" → confirm → DELETE → 204 → **`loadAll()` 재호출** → 동일 갱신
- [x] **필터 정합** — `status=active` chip 활성 상태에서 `pending` 고객을 POST해도 list 그대로 (필터 위반 없음). KPI 카드만 서버 stats 기준 +1 반영
- [x] 다른 org (admin@beta.test) 로그인 시 다른 12명 + 다른 KPI 분포 (격리 시각)
- [x] 에러 응답 두 형식 (`invalid_<field>` vs `invalid_input`) 모두 사용자 메시지로 표시 (Korean)
- [x] `formatRelativeTime` 출력이 mock UI 외관 ("2시간 전", "어제", "3일 전") 매치
- [x] `node test/sync_shared_types.mjs` PASS
- [x] `npm --prefix server test` 65/65 회귀 PASS
- [x] `node test/phase_0_5_e2e.mjs` 16/16 회귀 PASS
- [x] `docs/plan/PHASE_2_STEP_5_FINDINGS.md` 작성 (domain cleanup record 포함, 별도 커밋)

---

## 12. 한 줄 요약

> **1.5일 동안 `platform/customers.html`을 mock 12명 하드코딩에서 실 API 호출 (GET list/stats + POST + PATCH + DELETE)로 전환하고, `apiPatch`/`apiDelete` + `formatRelativeTime` + URL query string 동기화 + 모달 듀얼 모드 (create/edit/delete)를 도입해 평가자가 진짜 입력·수정·삭제를 시각으로 시연 가능한 첫 완전한 비즈니스 페이지를 완성한다.**

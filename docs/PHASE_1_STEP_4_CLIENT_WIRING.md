# Phase 1 Step 4 — Client wiring + WS handshake auth

> **상위 계획**: `docs/PHASE_1_MASTER.md` §3 Step 4.
> **선행**: Step 3 완료 — `docs/PHASE_1_STEP_3_AUTH_CORE.md`, `docs/PHASE_1_STEP_3_FINDINGS.md`.
> **기간**: 2일.

---

## 진행 상태

- [x] 1. Step 3 baseline 재검증 (`npm --prefix server test`, typecheck)
- [x] 2. `server/src/ws/calls.ts` — handshake auth + `userId` query 폐기 + `text_chunk` invariant + error 코드 문자열 고정. **`registerCallsNamespace(io, app)` 시그니처로 변경하여 `app.jwt.verify` 접근 가능** (server.ts 호출부도 동기 갱신)
- [x] 3. `platform/api.js` 신설 — fetch wrapper (메모리 토큰 + single in-flight refresh + retry once + login redirect + `API_BASE_URL` prefix). `kloserApi.login/logout/refreshAccessToken`은 wrapper 자동 분기와 분리
- [x] 4. `platform/login.html` 신설 — 미니멀 email/password 폼 + returnUrl 흐름. `kloserApi.login()` 사용 (auto-Bearer/refresh 미적용)
- [x] 5. `platform/live.html` — 진입 시 auth gate (`/auth/refresh` 또는 redirect) + suggestion/transcript 렌더 경로에 DOMPurify 적용
- [x] 6. `platform/ws.js` — `auth: { token }` 사용, `connect_error` 시 refresh + reconnect, **`__liveSocket`는 localhost 계열(`localhost`/`127.0.0.1`/`::1`/`[::1]`)에서만 노출** + first-only 소유권 (§1.8 도중 발견된 보조 socket clobber 방지)
- [x] 7. `server/test/ws_auth.test.mjs` — 8 케이스 (handshake 5 + runtime invariant 1 + happy path 2). socket.io-client + 실제 fastify random port
- [x] 8. `test/phase_0_5_e2e.mjs` 갱신 — login pre-step + auth reject 2 케이스 (16/16)
- [x] 9. `docs/PHASE_1_STEP_4_FINDINGS.md` 작성 + 마스터 plan §6의 shared types 항목을 Phase 2 deferral로 갱신

---

## 0. 목적

Step 1~3에서 서버는 인증·격리 경계를 갖췄다. Step 4는 **그 경계를 넘는 첫 진짜 클라이언트**를 만든다. 마침표는 두 개:

1. **로그인한 사용자만 `/calls` WebSocket에 진입** — `userId` query param 폐기, JWT-derived (orgId, membershipId, role)이 socket에 결합.
2. **새로고침 후에도 자동 재인증** — refresh cookie가 살아있으면 access token 재발급, 그 사이 fetch 401은 single in-flight refresh로 retry.

Step 4가 끝나면 platform/live.html이 실제 인증 흐름 위에서 Phase 0.5 동등 데모를 재생할 수 있다.

---

## 1. 사전 결정 9건

| 항목 | 결정 | 근거 |
|---|---|---|
| 1. access token 저장 | **메모리만** (모듈-local 변수). 페이지 로드 시 첫 동작은 `POST /auth/refresh` — refresh cookie가 살아있으면 access 재발급 | XSS 누수 표면 최소. localStorage·sessionStorage는 JS 노출. refresh cookie가 reload 비용 흡수 |
| 2. fetch wrapper refresh 자동화 | **single in-flight refresh + 원 요청 1회 retry + terminal 401 시 login redirect**. `apiGet/apiPost`만 자동 Bearer + 401 retry 분기를 탄다. **`kloserApi.login()` / `kloserApi.logout()` / `kloserApi.refreshAccessToken()`는 별도 함수 — wrapper의 자동 refresh 분기에 절대 들어가지 않음** (refresh가 401이면 즉시 terminal). 일관 옵션이 필요하면 내부 fetch 헬퍼에 `{ auth: false, retryAuth: false }`를 보존 | 동시 401이 N개 refresh 발사하면 family revoke 위험 (grace 30s 안전망 있지만 race 자체를 방지). single in-flight가 표준. login/logout/refresh는 unauthenticated이라 wrapper와 분리 |
| 3. WS handshake auth 형식 | **`auth: { token: accessToken }`** (`socket.io-client`). 서버는 `socket.handshake.auth.token` 읽음 | socket.io 표준 인증 슬롯. URL access log에 token 안 흐름. query param fallback 도입 안 함 |
| 4. WS error 코드 (계약) | **handshake `connect_error` 코드 3종**: `missing_token` / `expired_token` / `invalid_token`. **runtime `error` event 코드 1종**: `no_active_call` (§8 invariant 위반). 모두 `err.data.code` 또는 emit payload `.code` 문자열로 고정 | handshake에서 끊는 게 가장 명확. 코드 문자열은 client 분기 의존성이라 fix. handshake와 runtime은 별 채널이지만 코드 네임스페이스는 한 set으로 관리 |
| 5. dev login 화면 위치 | **`platform/login.html` 신설** (미니멀, email/password input + 버튼 + returnUrl 쿼리). live.html은 진입 시 token 없으면 `?returnUrl=/platform/live.html` 첨부해서 redirect | index.html(마케팅)과 책임 분리. live.html 내 modal은 거부 — 책임 흐려짐 |
| 6. Phase 0.5 e2e 운명 | **기존 `test/phase_0_5_e2e.mjs` 갱신** — login pre-step 추가 + 기존 14 케이스 회귀 + auth reject 2 케이스 추가. 결과 기대: **14 + 2 = 16 PASS** | 기존 14 케이스의 가치를 살리고, cross-file 동기화 부담 제거. 새 파일로 분기하지 않음 |
| 7. `__liveSocket` dev 핸들 | **`location.hostname` ∈ {`localhost`, `127.0.0.1`, `::1`, `[::1]`}일 때만** `window.__liveSocket = socket`. prod 도메인엔 노출 안 됨. 브라우저는 IPv6 localhost를 보통 bracket 없이 `::1`로 보고하지만 일부 환경은 `[::1]`이라 둘 다 포함 | static HTML이라 빌드타임 가드 못 씀. hostname 체크가 가장 단순. query string `?debug=1`은 prod URL에서 누가 실수 시 노출됨 |
| 8. `text_chunk` before `start_call` invariant | `server/src/ws/calls.ts`에서 per-socket `callStarted: boolean` 트래킹. text_chunk가 `!callStarted`면 `socket.emit("error", { code: "no_active_call" })` + 무시 | 클라 버그 / 악의적 호출이 fixture 미시작 상태로 transcript echo 받아가는 것 차단. silent drop은 디버깅 곤란 |
| 9. API base URL 분리 | static (`:8765`)과 API (`:3001`)가 다른 origin이라 cross-origin. `platform/api.js`가 module-local `API_BASE_URL` (기본 `http://localhost:3001`) 보유. 모든 `/auth/*`, `/me`, `/api/*` 호출 앞에 prefix. 페이지가 override할 수 있게 `<meta name="kloser-api-base" content="...">` 또는 `window.KLOSER_API_BASE` 우선 적용 | 정적 서버에 fetch가 가면 404. 절대 URL은 prod 배포 시 도메인 변경. meta/window override가 build-step 없는 환경에서 가장 단순한 환경 분기 |

---

## 2. 범위

### 한다

- WS handshake JWT 검증 + 클라이언트 토큰 부착
- `platform/api.js` fetch wrapper (token 메모리 보관, refresh 자동화, 401 redirect, `API_BASE_URL` 분리)
- `platform/login.html` 미니멀 폼
- `platform/live.html` 진입 게이트
- `platform/ws.js` 갱신 (auth slot, connect_error → refresh → reconnect, dev 핸들 가드)
- `server/src/ws/calls.ts` 갱신 (handshake auth, `text_chunk` invariant, error 코드 문자열)
- `userId` query param 폐기 (서버·클라 양쪽)
- 서버 측 WS auth 단위 테스트
- Phase 0.5 e2e 갱신 (auth 필수 흐름)
- **DOMPurify로 suggestion HTML sanitize** — Phase 0.5 인계 항목. live.html이 server emit 받은 `transcript`/`suggestion`을 innerHTML로 꽂는 경로 모두 `DOMPurify.sanitize()` 통과. 현재 fixture는 통제된 `<b>`/`<br>`이지만 Phase 5에서 LLM 출력이 들어오기 전에 미리 깔아둠 (defense in depth, 비용 거의 없음)

### 안 한다 (Phase 2~5으로 미룸)

- **shared types / zod 스키마 도입** — Phase 0.5 finding과 마스터 §6에서 Step 4 항목으로 잡혀 있었으나 본 step에서 Phase 2로 deferral 결정. 이유: 브라우저 측 정적 HTML은 build step이 없어 TS/zod 직접 import 불가, JSDoc 주석은 enforcement가 없어 "shared"라는 이름값을 못 함. Phase 2 customers CRUD 시점에 (a) bundler 도입 결정 또는 (b) `server/src/types/calls.ts` + 브라우저용 JSDoc 사본 정도로 시작. master plan §6 동기 갱신 필요.
- WS 핸들러 안에서 DB 호출 — Step 4 시점 fixture는 setTimeout 기반이라 DB 접근 없음. Phase 4 (calls REST + dashboard)에서 본격 도입 시 `withOrgContext` 패턴 적용.
- 로그인 화면의 "회원가입" 링크 — `/auth/signup` 라우트는 Step 3에 있지만 dev 흐름은 seed 사용자로 충분. 마케팅 회원가입 UX는 GA 단계.
- Org switcher UI (multi-org 사용자) — Step 3 §6의 400+`availableOrgs` 응답을 받으면 login.html이 단순히 에러 메시지를 보여주고 사용자가 orgId를 직접 입력. 진짜 picker는 Phase 2+에서.

---

## 3. 디렉토리 변화

```text
kloser/
├── platform/
│   ├── api.js                           # 🆕 fetch wrapper (token + refresh + 401 redirect)
│   ├── login.html                       # 🆕 미니멀 dev login
│   ├── live.html                        # 🟡 진입 시 auth gate, kloserWS에 token 전달
│   └── ws.js                            # 🟡 auth: { token }, connect_error → refresh → reconnect, __liveSocket 가드
├── server/
│   ├── src/
│   │   └── ws/
│   │       └── calls.ts                 # 🟡 handshake auth, text_chunk invariant, error codes
│   └── test/
│       └── ws_auth.test.mjs             # 🆕 handshake 3코드 + runtime no_active_call 1코드
└── test/
    └── phase_0_5_e2e.mjs                # 🟡 login pre-step + auth reject 2 cases (16 total)
```

---

## 4. 단계별 작업

### 1. Step 3 baseline 재검증

```bash
npm --prefix server test                      # 29/29
npm --prefix server run typecheck             # PASS
docker compose -f ops/docker-compose.yml ps   # postgres + redis healthy
```

검증: 위 셋 모두 깨끗할 때 시작.

### 2. `server/src/ws/calls.ts` — handshake auth 우선 구현

서버를 먼저 손대는 이유: 클라가 의존하는 contract (auth slot 키, connect_error 코드 문자열)를 fix해야 client wiring이 거꾸로 안 끌려옴.

**시그니처 변경 필요**: 현재 `registerCallsNamespace(io)`로는 fastify의 `app.jwt.verify`에 접근할 수 없다. `(io, app)`으로 확장하고 `server.ts`의 호출부도 함께 갱신:

```ts
// server/src/ws/calls.ts
export function registerCallsNamespace(io: IOServer, app: FastifyInstance) { ... }

// server/src/server.ts
const io = new IOServer(app.server, { cors: ... });
registerCallsNamespace(io, app);   // <-- app도 같이
```

handshake middleware:

```ts
// 의사 코드
io.of("/calls").use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(authError("missing_token"));
  try {
    const decoded = app.jwt.verify(token);            // 같은 JWT secret + alg
    const payload = validateAccessTokenPayload(decoded);
    socket.data.user = toAuthenticatedUser(payload);
    socket.data.callStarted = false;
    return next();
  } catch (err) {
    if (err?.code === "FAST_JWT_EXPIRED" || err?.name === "TokenExpiredError") {
      return next(authError("expired_token"));
    }
    return next(authError("invalid_token"));
  }
});

function authError(code) {
  const e = new Error(code);
  e.data = { code };          // socket.io-client는 err.data로 받음
  return e;
}
```

`text_chunk` 핸들러에 invariant 추가:

```ts
socket.on("text_chunk", (payload) => {
  if (!socket.data.callStarted) {
    socket.emit("error", { code: "no_active_call" });
    return;
  }
  // ... 기존 echo 로직
});
socket.on("start_call", (payload, ack) => {
  // ... 기존 로직
  socket.data.callStarted = true;
  ack({ callId, ... });
});
socket.on("end_call", (...) => {
  socket.data.callStarted = false;
  // ...
});
```

`userId` query 분기 폐기. handshake 단계에서 인증 실패하면 socket이 아예 안 열리므로 기존의 `socket.handshake.query.userId` 코드는 삭제.

검증:
- 서버 단독 부팅 + `wscat`/curl로 handshake 시도 → token 없음 connect_error
- §1.7의 단위 테스트가 본 절차의 회귀 가드

### 3. `platform/api.js` 신설 — fetch wrapper

API base URL: 정적 페이지(`:8765`)와 API 서버(`:3001`) origin 분리. module-local 상수에 기본값을 두고, 페이지 측 override 우선순위 검사:

```js
const API_BASE_URL =
  window.KLOSER_API_BASE
  || document.querySelector('meta[name="kloser-api-base"]')?.content
  || 'http://localhost:3001';
```

표준 인터페이스:

```js
window.kloserApi = {
  // 인증 흐름 — wrapper 자동 분기에 들어가지 않음
  login({ email, password, orgId }) { ... },     // POST /auth/login (no Bearer, no auto-refresh)
  logout() { ... },                              // POST /auth/logout (no Bearer, no auto-refresh)
  refreshAccessToken() { ... },                  // POST /auth/refresh (cookie only, no Bearer)

  // 토큰 보관소 (메모리)
  setAccessToken(t) { ... },                     // login 성공 시 내부 호출
  clearAccessToken() { ... },                    // logout 또는 terminal 401
  getAccessToken() { ... },                      // ws.js가 handshake에 넣을 때 호출

  // 일반 API — 자동 Bearer + 401 retry
  apiGet(path, opts) { ... },
  apiPost(path, body, opts) { ... },

  // 유틸
  loginRedirect() { ... },                       // 현재 URL을 returnUrl로 끼워서 /platform/login.html로
};
```

내부 fetch 헬퍼 옵션 (외부엔 안 노출): `{ auth: false, retryAuth: false }`로 `/auth/*` 경로 호출 시 자동 분기를 우회. `apiGet/apiPost`는 기본 `{ auth: true, retryAuth: true }`.

핵심 로직:

- 모든 호출은 `${API_BASE_URL}${path}` 절대 URL로 발사. credentials: `'include'` 항상 (refresh cookie 동행).
- `apiGet/apiPost`가 401을 받으면:
  1. 단일 module-level promise (`refreshing`)이 있으면 그걸 await, 아니면 `kloserApi.refreshAccessToken()`을 호출하여 promise를 module에 캐시
  2. promise resolved → 새 토큰으로 원 요청 한 번 retry
  3. retry도 401이거나 refresh가 401이면 `clearAccessToken()` + `loginRedirect()`
  4. **`/auth/refresh` 자체 호출은 401 retry 분기에 절대 들어가지 않음** (login/logout/refresh는 `{ auth: false, retryAuth: false }`로 호출되므로 wrapper의 자동 분기와 분리)

검증:
- 수동 dev: `apiGet('/me')` → `Authorization: Bearer <token>` 자동 헤더, `${API_BASE_URL}/me`로 발사
- 401 시뮬레이션: 만료된 토큰 메모리에 박고 호출 → single in-flight refresh + retry 일어나는 걸 network tab으로 확인 (refresh 호출은 1회뿐)
- meta override: `<meta name="kloser-api-base" content="http://api.staging.kloser.test">` 박은 페이지에서 호출이 그 base로 가는지

### 4. `platform/login.html` 신설

레이아웃: 한 화면에 email + password input + (optional) orgId input + Login 버튼 + 에러 영역. CSS는 기존 `_shared.css` 재사용.

흐름:

1. 페이지 로드 → URL의 `returnUrl` 쿼리 파라미터 파싱 (없으면 `/platform/live.html` 기본). 변수명·쿼리키 모두 `returnUrl`로 통일.
2. 폼 submit → **`kloserApi.login({ email, password, orgId? })`** 호출 (apiPost가 아님 — login은 unauthenticated이라 자동 Bearer + 401 retry 분기에 들어가면 안 됨).
3. 200 → 응답 body의 `accessToken`을 (login 함수 내부에서) `setAccessToken`으로 저장한 뒤 resolve, 호출자는 `window.location.replace(returnUrl)`.
4. 400 (`org_id_required`) → 에러 영역에 메시지 + `availableOrgs` 목록을 렌더, 사용자가 orgId를 추가 입력 후 재시도.
5. 401 → "이메일/비밀번호 다시 확인" 에러.

dev fixture 안내: `<small>` 영역에 seed 4쌍 (`admin@acme.test / acme-admin-1234` 등) 노출 — `if (location.hostname === 'localhost' || ...)`로 가드.

검증:
- Playwright 또는 수동: seed 자격증명으로 login → live.html로 redirect
- 잘못된 password → 에러 메시지 노출, redirect 없음

### 5. `platform/live.html` 진입 게이트 + DOMPurify

기존 live.html 헤드에:

```html
<!-- DOMPurify (CDN), defer 가능 -->
<script src="https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js"></script>
<script src="api.js"></script>
<script src="ws.js"></script>
<script>
  (async () => {
    if (!kloserApi.getAccessToken()) {
      try {
        await kloserApi.refreshAccessToken();
      } catch {
        kloserApi.loginRedirect();
        return;
      }
    }
    initLivePage();   // 기존 부팅 로직을 함수로 감싸 전환
  })();
</script>
```

`kloserWS.connectCallNamespace`에 `userId` 대신 `tokenProvider: () => kloserApi.getAccessToken()` 형식 함수 전달 (재연결 시 fresh 토큰 사용 위해).

**DOMPurify 적용 지점**: server emit한 `transcript`/`suggestion` payload를 innerHTML로 꽂는 모든 경로에 `DOMPurify.sanitize()` 통과. 헬퍼 한 군데로 감싸기:

```js
function safeSetHtml(el, html) {
  el.innerHTML = window.DOMPurify
    ? window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
    : ''; // DOMPurify 로드 실패 시 차단 (silent ignore보다 강함)
}
```

DOMPurify CDN 로드 실패 시 silent으로 unsanitized HTML이 들어가는 것보다 빈 문자열로 두는 게 fail-safe. console에 warning 남김.

검증:
- 토큰 없는 상태로 live.html 직접 진입 → `login.html?returnUrl=/platform/live.html`로 redirect
- login → 다시 live.html 자동 복귀 → demo 흐름 재생
- 의도적으로 `<script>alert(1)</script>` 같은 payload를 server fixture에 끼워 emit해도 (또는 console에서 직접 호출해도) 렌더 안 됨

### 6. `platform/ws.js` — auth slot + reconnect 흐름 + dev 가드

`connectCallNamespace` 시그니처 갱신:

```js
window.kloserWS.connectCallNamespace({
  baseUrl,
  tokenProvider,      // () => string | null
  onAuthFailure,      // () => void  (refresh 도 실패 시 caller가 redirect)
})
```

내부:

```js
const socket = window.io(url, {
  auth: { token: tokenProvider() },     // initial
  transports: ['websocket'],
  reconnection: true,
});
socket.io.on('reconnect_attempt', () => {
  socket.auth = { token: tokenProvider() };   // refresh 후 새 token이 들어오게
});
socket.on('connect_error', async (err) => {
  const code = err.data?.code;
  if (code === 'expired_token' || code === 'invalid_token') {
    try {
      await kloserApi.refreshAccessToken();
      socket.auth = { token: tokenProvider() };
      socket.connect();   // 수동 재연결
    } catch {
      onAuthFailure();
    }
  } else if (code === 'missing_token') {
    onAuthFailure();
  }
});
// dev 핸들 가드 — IPv6 localhost는 브라우저에 따라 ::1 또는 [::1]
if (location.hostname === 'localhost' ||
    location.hostname === '127.0.0.1' ||
    location.hostname === '::1' ||
    location.hostname === '[::1]') {
  window.__liveSocket = socket;
}
```

검증:
- 만료 토큰 시뮬레이션: 토큰을 일부러 expired 상태로 박고 socket.connect → connect_error → refresh → reconnect
- prod 시뮬레이션: hostname을 dev tools로 다른 값으로 보이게 한다거나 — 실측은 prod 배포 시점. 코드 리뷰로 가드 확인.

### 7. `server/test/ws_auth.test.mjs` — handshake 단위 테스트

`socket.io-client`로 실제 fastify에 붙어 코드들을 fix.

**handshake `connect_error` 3종**:

- 토큰 없음 → `data.code = "missing_token"`
- 만료 토큰 (expired exp) → `data.code = "expired_token"`
- 변조 토큰 (서명 깨짐) → `data.code = "invalid_token"`

**handshake 정상 1 케이스**:

- 정상 토큰 (seed admin 로그인 후 받은 access) → connect 성공, `socket.data.user` 적재 후 disconnect

**runtime `error` event 1종 (`no_active_call`)** — `text_chunk` invariant:

- start_call 없이 text_chunk 발송 → server가 `error: { code: "no_active_call" }` emit
- start_call 후 text_chunk → 정상 echo (error event 없음)

테스트는 fastify를 random port에 listen, after에서 close. 기존 9개 test 파일 + 본 1개 → 통과 시 합계 35개 (29 + 6).

검증: `npm --prefix server test` PASS.

### 8. `test/phase_0_5_e2e.mjs` 갱신

기존 14 케이스 그대로 + 시작에 login pre-step + 끝에 auth reject 2 케이스:

```js
// 0. login (new pre-step)
await page.goto(STATIC + "/platform/login.html");
await page.fill('input[name=email]', 'admin@acme.test');
await page.fill('input[name=password]', 'acme-admin-1234');
await page.click('button[type=submit]');
await page.waitForURL(/live\.html/);

// 1~14. 기존 케이스

// 15. auth reject — 토큰 없는 socket 직접 만들어 connect → connect_error
//      (별도 page.evaluate에서 수행, 또는 raw socket.io-client)

// 16. invalid token reject
```

기대 결과: **16/16 PASS** (또는 "기존 14 + auth 2"로 표기).

검증: `node test/phase_0_5_e2e.mjs` 16/16.

### 9. `docs/PHASE_1_STEP_4_FINDINGS.md`

Step 4에서 발견·결정·미해결 인계. 최소 다음 항목:

- 토큰 메모리 보관 + reload 시 refresh — UX 함의
- `kloserApi`의 single in-flight refresh 패턴
- WS error 코드 계약: handshake `connect_error` 3종 (`missing_token` / `expired_token` / `invalid_token`) + runtime `error` event 1종 (`no_active_call`)
- `__liveSocket` dev 가드 — hostname 기반 한계 (e.g. *.localhost.test 같은 변형)
- `text_chunk` invariant — 클라 버그 보호망이지만 정상 클라 흐름에선 트리거되지 않음
- Phase 0.5 e2e가 16/16으로 갱신됨 — 회귀 baseline 새로 정의
- shared types deferral 사유 (browser build step 부재) + Phase 2 진입 시 처리 방향
- DOMPurify 적용 결과 — 어느 렌더 경로에 통과시켰는지, CDN 로드 실패 fail-safe 동작 확인 결과, 운영 시 self-host 필요 여부

---

## 5. 위험·미정

| 항목 | 처리 |
|---|---|
| 동일 hostname 변형 (`*.localhost.test` 등 dev 변형) | 본 step에선 로컬 표준만 가드. 변형 hostname dev 환경은 별도 noted. |
| IPv6 localhost로 정적 페이지를 띄우면 CORS가 깨질 수 있음 | 현재 server CORS는 `STATIC_ORIGIN` 기본값(`http://localhost:8765`) + `http://127.0.0.1:8765`만 허용 (`server.ts`). client가 `[::1]`/`::1` hostname으로 띄워졌고 fetch가 `:3001`로 가면 preflight 차단. 본 step 구현 중 server CORS 배열에 `http://[::1]:8765` 케이스 추가 검토 (또는 dev 한정 와일드카드). 결정은 구현 시점에. |
| Multi-tab login 동시성 | 두 탭이 거의 동시에 login → 두 session 생성 → 정상 (서로 다른 family). refresh 시 race는 grace window가 흡수. |
| WS `connect_error` 후 reconnection 무한 루프 | client wrapper가 refresh 실패 시 `onAuthFailure` 콜백으로 빠져 명시적 disconnect. socket.io 자체 reconnection 옵션은 켜되, auth 분기에서는 수동 제어. |
| `text_chunk` invariant가 정상 흐름의 첫 chunk를 놓칠 수 있는가 | 정상 클라는 `start_call` 응답(ack)을 받은 뒤 `text_chunk`를 발사하므로 race 없음. spec상 start_call ack가 callStarted 플립과 동기화. |
| login.html의 dev fixture 자격증명 노출 | hostname 가드. prod 배포 시 마케팅 페이지에선 평문 노출 안 됨. |
| WS 핸들러에서 DB 접근 없음 → `withOrgContext` 미사용 | Phase 4 진입 시 패턴 도입. Step 4에선 token-derived `socket.data.user.orgId`만 결합. |
| Phase 0.5 e2e가 ws.js 수정으로 깨질 가능성 | login pre-step + tokenProvider 인터페이스 변경이 핵심 변경. 기존 14 케이스는 동일 fixture 흐름이라 재생되어야 함. 깨지면 본 step에서 drilling. |
| socket.io-client의 `auth.token` 갱신 타이밍 | `socket.auth = { token: ... }` 재할당이 reconnect 전 적용되는지 — `reconnect_attempt` 훅에서 갱신하는 패턴이 표준. 검증은 §1.7 단위 테스트가 일부 커버. |

---

## 6. 완료 기준 (Step 4 — go/no-go)

- [x] `npm --prefix server run typecheck` PASS
- [x] `npm --prefix server test` PASS (Step 1~3 회귀 29 + WS auth 신규 8 = **37/37**)
- [x] `node test/phase_0_5_e2e.mjs` 16/16 PASS (login pre-step + 기존 14 + auth reject 2)
- [x] 토큰 없이 `/platform/live.html` 진입 → login.html로 redirect (returnUrl 첨부)
- [x] login → live.html 데모 흐름이 Phase 0.5 동등 (RTT 0~2ms 유지)
- [x] 만료된 토큰으로 WS handshake → `connect_error: { code: "expired_token" }` → 클라가 refresh 후 reconnect 성공 (단위 테스트 §1.7 + wrapper 흐름 §1.6)
- [x] `__liveSocket`이 prod 도메인 (예: `127.0.0.1`이 아닌 임의 호스트)에서 미노출 — 코드 리뷰
- [x] `text_chunk` before `start_call` → server가 `error: { code: "no_active_call" }` emit + 무시
- [x] `userId` query param 흔적이 server / client 양쪽에서 사라짐
- [x] `docs/PHASE_1_STEP_4_FINDINGS.md` 작성

---

## 7. 한 줄 요약

> **2일 동안, `userId` query를 폐기하고 JWT 기반 WS handshake + 메모리 토큰 + 자동 refresh + login redirect 흐름을 깔아서, 로그인된 사용자만 `live.html` 데모를 진짜 인증 위에서 재생하도록 만든다.**

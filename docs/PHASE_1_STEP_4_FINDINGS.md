# Phase 1 Step 4 Findings — Client wiring + WS handshake auth

> Audience: Phase 1 Step 5 작성자 (또는 미래의 나).
> Format: each finding has **(1) 관찰**, **(2) Step 5 또는 이후로의 의미**.

## 결론

Step 4 **완료** (2026-05-07). 정적 페이지 (`platform/login.html`, `platform/live.html`)가 자체 fetch wrapper (`platform/api.js`)와 WS wrapper (`platform/ws.js`)를 통해 메모리 access token + HttpOnly refresh cookie 흐름 위에서 동작. `/calls` 네임스페이스는 더 이상 `userId` query param을 받지 않고 `socket.handshake.auth.token`의 JWT 서명·페이로드를 검증한다. `text_chunk` before `start_call` invariant가 server-side로 들어왔다.

- `npm --prefix server run typecheck` PASS
- `npm --prefix server test` 37/37 PASS (Step 1~3 회귀 29 + WS auth 신규 8 = 37)
- `node test/phase_0_5_e2e.mjs` 16/16 PASS — login pre-step + 기존 14 케이스 회귀 + auth reject 2 케이스. RTT 0~2ms 유지.
- 수동 확인: 토큰 없이 `/platform/live.html` 진입 → `loginRedirect()`가 `?returnUrl=/platform/live.html` 첨부해서 `login.html`로 보내고, 로그인 후 자동 복귀해서 데모 흐름 재생.

`PHASE_1_STEP_4_CLIENT_WIRING.md` §6 완료 기준 모두 충족.

---

## 발견 사항

### 1. 메모리 access token + refresh cookie — page reload 시 refresh 1회로 흡수

(1) `platform/api.js`는 access token을 module-local 변수에 보관한다. 새로고침이나 새 탭은 이 메모리를 잃지만, refresh cookie (HttpOnly, `Path=/auth`, 30d)는 살아있어서 live.html의 auth gate가 boot 직후 `/auth/refresh`를 한 번 호출해 access를 재발급받는다. 이 refresh는 wrapper의 401 retry와 분리된 별도 함수(`kloserApi.refreshAccessToken`)이며 cookie 외에는 어떤 입력도 안 받는다.

(2) UX 함의:
- **첫 화면 1회 round-trip 추가** — auth gate가 끝나야 `connectCallNamespace`가 시작되므로 첫 transcript 도착 시간이 그만큼 밀린다. e2e에서 첫 greeting wait를 2000ms → 4000ms로 늘려 흡수했다. 운영 환경에서 LAN 기준이면 100ms 이내. 
- **Refresh 실패 = login redirect** — Step 5에서 reverse proxy 들어와 cookie domain 정책이 바뀌면 reload UX가 바로 깨진다. 도메인 분리 (`api.example.com` vs `app.example.com`) 시 cookie 설계 재검토 필요. 

### 2. `kloserApi`의 single in-flight refresh + retry once + terminal 401 → loginRedirect

(1) `apiGet` / `apiPost`만 자동 Bearer + 401 retry 분기를 탄다. 401이 도착하면 `_inFlightRefresh` promise가 있으면 그것을 await하고 (없으면 새로 생성), 같은 token으로 원 요청을 한 번 retry. 두 번째 401은 terminal — `loginRedirect()`로 throw 없이 흐름 종료. `kloserApi.login()` / `logout()` / `refreshAccessToken()`은 wrapper 자동 분기와 분리된 low-level fetch를 직접 사용 (refresh 자체가 401이면 즉시 terminal이라 자기 자신을 재호출하면 무한 루프 위험).

(2) Step 5에서 reverse proxy origin 통합 (`https://app.example.com`)으로 가더라도 `credentials: 'include'`만으로는 cookie가 호환되지만, CSRF 표면이 늘어나면 `Sec-Fetch-Site` 검증 또는 double-submit token 추가 검토. 본 step에선 dev 한정 cross-origin이라 `credentials: 'include'`로 충분.

(3) login 흐름 자체가 wrapper에 들어가지 않는 분리는 **명시적 호출 분리 (login/logout/refresh = primitive, 나머지 = managed)**로 봐야 안전. 한 번 wrapper에 통합하면 `login → 401 → refresh → login → 401 → ...` 무한 루프 위험. 의식적으로 두 종류의 fetch를 유지.

### 3. WS error 코드 계약 (handshake 3 + runtime 1) — 클라이언트 분기 의존성으로 고정

(1) handshake `connect_error.data.code`:
- `missing_token` — `auth.token` 부재 또는 빈 문자열
- `expired_token` — `@fastify/jwt`의 `FAST_JWT_EXPIRED` (또는 `TokenExpiredError`)
- `invalid_token` — 서명 불일치, 페이로드 shape 검증 실패 (validateAccessTokenPayload), 그 외 모든 verify 실패

runtime `error.code`:
- `no_active_call` — `text_chunk`가 prior `start_call` 없이 도착
- `BAD_PAYLOAD` — `text_chunk` 페이로드 shape 불일치 (Phase 0.5에서 spec 고정)

(2) 클라이언트 wrapper (`platform/ws.js`)는 `connect_error`의 `data.code`가 위 세 auth 코드 중 하나일 때만 refresh + reconnect를 시도하고, 그 외 (transport 실패 등)는 socket.io 자체 reconnection에 위임. **이 분기는 server side의 코드 문자열에 강하게 의존** — 서버에서 코드 이름을 바꾸면 client wrapper가 침묵하게 reconnect 못 하게 된다. 향후 코드 추가/변경은 양쪽 동시 갱신 + `ws_auth.test.mjs`의 5케이스 동기 갱신.

(3) Step 5 reverse proxy 진입 후 `socket.io` ping/pong이 proxy timeout과 충돌할 수 있음. 그 경우 reconnection은 socket.io 자체 흐름 (auth 코드 아님)에서 자동 처리되므로 본 wrapper 영향 없음. 다만 wrapper의 `connect` 이벤트에서 `recovering = false` 클리어 패턴은 그대로 유지.

### 4. `recovering` latch — refresh 1회만 시도, 두 번째 auth-code error는 terminal

(1) `connect_error`가 auth 코드로 도착하면 `recovering = true` 세팅 후 refresh + reconnect. 새 connection이 성공(`connect`)하면 `recovering = false`. 새 connection이 또 auth-code error면 (refresh가 token을 줬지만 server는 여전히 거부) **refresh family를 더 태우지 않고 `onAuthFailure()` 호출 후 disconnect**.

(2) Codex 리뷰 §1.6에서 발견: 초기 코드는 `try { refresh; reconnect } finally { recovering = false }`였는데, 이러면 reconnect attempt가 또 401일 때 latch가 이미 풀려서 또 refresh를 시도하고, 결국 refresh family를 다 태운다. 수정: latch를 `connect` 이벤트에서만 클리어. 두 번째 auth-code connect_error는 `recovering === true` 분기에서 terminal로 처리.

(3) Step 5에서 wrapper가 multi-tab 또는 long-lived idle 상태로 가면 access token이 자연 만료 → reconnect 시 expired_token → refresh + reconnect 흐름이 정상 경로. 이 latch 패턴은 multi-tab의 동시 refresh도 single in-flight refresh가 흡수한다 (api.js).

### 5. `__liveSocket` dev 핸들 — first-only 소유권 (§1.8 e2e 도중 발견)

(1) §1.5/§1.6에서 `live.html`의 `__liveSocket = socket` 라인을 `ws.js`의 `connectCallNamespace` 안으로 옮겼다. 의도는 "dev 핸들 노출 책임을 wrapper로 일원화". 그러나 §1.8 e2e가 보조 probe socket (`connectCallNamespace`로 만든)도 만들면서, 매 호출마다 `__liveSocket`을 덮어쓰는 부작용 발생 → probe.close() 후 `__liveSocket`은 닫힌 probe를 가리키고, 페이지 socket으로의 sendTextChunk가 작동 안 해 latency assertion이 30s 타임아웃.

(2) 수정: `if (isDevHost() && !window.__liveSocket) { window.__liveSocket = socket }`. 첫 socket만 dev 핸들 소유. 페이지의 첫 socket이 load 직후에 만들어지므로 자연스럽게 그것이 핸들을 가져간다. 보조 probe / secondary tab은 경합하지 않는다.

(3) 운영 환경에선 page = single socket이라 first-only 정책이 의미 없어 보이지만, 미래의 multi-window scenario (popup, embedded iframe 등)에서도 안전하다. 정의상 "live socket"은 페이지의 primary call socket이지 "마지막에 만들어진 socket"이 아님.

(4) 운영적 한계 (변경 안 함): hostname 가드가 `localhost` / `127.0.0.1` / `::1` / `[::1]`만 본다. `*.localhost.test` 같은 dev 변형 호스트는 가드를 통과 못 함 — 의도한 보수적 동작. 운영 도메인엔 절대 노출 안 됨이 핵심.

### 6. login.html dev fixture 자격증명 — hostname 가드만으로 prod 노출 차단

(1) login.html에 dev seed 4쌍 (admin/emp × acme/beta) + auto-fill 버튼 표시. `isLocalhost()` (위 가드와 동일 룰)일 때만 disclosure가 보인다. 정적 HTML이라 build-time 가드가 불가능 — runtime hostname 체크가 가장 단순한 방어선.

(2) Step 5 reverse proxy 진입 후 prod URL로 띄우면 fixture가 보이지 않음을 manual smoke로 확인. 또는 prod 배포 시 dev fixture 영역 자체를 제거하는 build step 도입 (Phase 2 bundler 도입 시 자연스러운 흐름).

(3) seed 평문 password가 코멘트에 노출됨은 **dev 한정** — `server/seeds/0001_demo.sql`의 plaintext 표기는 의도적이며, prod 배포 절차에 seed 실행이 포함되지 않게 운영 매뉴얼에서 분리 (Step 3 finding §4 참고).

### 7. `text_chunk` before `start_call` invariant — 클라 버그 보호망

(1) server `calls.ts`가 per-socket `WeakMap<Socket, CallContext>`로 in-flight call을 추적. text_chunk가 도착했을 때 `calls.has(socket)` 검사로 active call 여부 확인. 없으면 `error: { code: "no_active_call" }` emit + 페이로드 무시. 정상 클라이언트는 `start_call` ack를 await한 뒤 text_chunk 발사하므로 race 없음 — `ws_auth.test.mjs:172`가 이 path를 단위 테스트로 고정.

(2) BAD_PAYLOAD 검증과 우선순위가 있다: `no_active_call`이 먼저, BAD_PAYLOAD가 나중. 이는 의도적 — active call 없으면 페이로드 검증 자체가 무의미. e2e §1.8에서 BAD_PAYLOAD probe가 start_call을 먼저 호출하도록 수정한 이유.

(3) Phase 4 (calls REST + dashboard) 진입 시 `calls` Map이 in-process 메모리에서 Redis 또는 DB로 이동할 수 있음. invariant 자체는 unchanged — "active call 없으면 거부" 의미만 보존.

### 8. WS 핸들러는 아직 DB 컨텍스트 없음 — `withOrgContext` 미사용

(1) `socket.data.user.orgId`는 token-derived (`validateAccessTokenPayload`가 검증). WS 핸들러 안에서 DB query를 안 하므로 `withOrgContext`/`SET LOCAL app.org_id`/repository 호출이 한 번도 일어나지 않는다. 현재의 fixture는 setTimeout 기반 in-memory.

(2) Phase 4 진입 시: `start_call`이 `calls` 테이블에 INSERT, `text_chunk`가 `transcripts`에 INSERT를 하기 시작한다. 이 시점 패턴은 **HTTP route와 동일** — `app.withOrgContext(socket.data.user.orgId, async (client) => { ... })`. JWT-derived orgId가 이미 socket에 결합돼 있어 별도 인증 분기 없이 그대로 사용 가능.

(3) `ws_auth.test.mjs`는 dbPlugin을 등록해두지만 현재 미사용 — 다른 테스트의 boot 흐름과 parity 유지 + Phase 4 진입 시 자연스럽게 활성화될 forward-compat 셋업 (코덱스 리뷰 메모로 인지).

### 9. Phase 0.5 e2e는 Step 4의 회귀 baseline으로 갱신됨

(1) 기존 14 케이스 (greeting, 두 sentiment 전환, suggestion cards, RTT probe, latency probe, transcript count, BAD_PAYLOAD)는 그대로 유지. 추가:
- **Step 0** (setup, not counted): login pre-step — `admin@acme.test / acme-admin-1234`로 login.html → live.html 자동 redirect.
- **Case 13~14** (new): handshake without token → `connect_error: missing_token`; handshake with mangled token → `connect_error: invalid_token`. 둘 다 raw `window.io`를 직접 사용 — wrapper의 auto-refresh 분기가 테스트를 오염시키지 않게.

(2) 결과: 16/16 PASS. probe socket들은 이제 `tokenProvider: () => kloserApi.getAccessToken()`을 받아 페이지의 access token을 공유. RTT 0~2ms 유지로 Phase 0.5 동등 성능 확인.

(3) Step 5에서 Caddy 통합 들어오면 origin이 `https://localhost` 단일로 통일된다. e2e는 `STATIC_ORIGIN` / `API_BASE` 두 변수로 분리해뒀으므로 변경 한 줄로 흡수 가능.

### 10. shared types — Phase 2로 deferral

(1) Phase 0.5 finding의 "shared types 중복"이 master plan §6에서 Step 4 deliverable로 잡혀 있었으나, 정적 HTML이 build step 없는 환경 (Tailwind CDN, socket.io UMD)이라 TS/zod를 직접 import 불가. JSDoc 주석은 enforcement 없음. **2026-05-07 결정으로 Phase 2 (customers CRUD) 진입 시점으로 deferral** — 그때 bundler 도입 또는 server/types + browser JSDoc 사본 + script로 동기화 검증 패턴 중 결정.

(2) Step 4 시점의 임시 contract:
- WS event payload (`transcript`, `suggestion`, `sentiment`, `error`)는 `live.html` 안의 console.log + handler shape으로 inline 문서화.
- HTTP response shape은 `api.js` 안에 JSDoc.

(3) Phase 2에서 본격 도입 시 우선순위:
- (A) HTTP API request/response — 가장 자주 변경되는 표면
- (B) WS payload — 안정적이지만 다중 클라이언트 대상
- (C) DB row shape — server-only, 우선순위 낮음

### 11. DOMPurify — suggestion 렌더 경로에 적용, 신뢰 SVG는 bypass

(1) `live.html`의 `safeSuggestionHtml(html)`이 DOMPurify를 통해 server-supplied suggestion title/body를 sanitize. CDN 로드 실패 시 fail-safe로 빈 문자열 반환 (`window.DOMPurify`가 없으면 묵묵히 제거). `USE_PROFILES: { html: true }`로 SVG는 기본 차단.

(2) toneIcon SVG는 우리가 코드에 박은 trusted constant이므로 sanitize 분기 밖에서 직접 innerHTML로 주입 — codex 리뷰 §1.5 Low finding의 수정. 결과: tone 아이콘이 다시 보임 + 외부 입력은 계속 sanitize.

(3) 운영 진입 시 self-host 여부:
- CDN 의존성은 fail-safe가 빈 문자열이라 보안 측면에선 안전 (사용자에게 빈 카드만 보임).
- UX 측면에선 suggestion이 안 보이는 게 곧 문제. Phase 5 suggestion job이 본격 들어올 때 self-host (또는 import map) 검토.

### 12. Cross-origin dev 환경 — `API_BASE_URL` resolver

(1) 정적 (`:8765`) + API (`:3001`) 두 origin 분리. `api.js`가 `API_BASE_URL`을 다음 우선순위로 resolve:
1. `window.KLOSER_API_BASE` (런타임 override)
2. `<meta name="kloser-api-base" content="...">` (페이지 inline)
3. `http://localhost:3001` (default)

`apiGet/apiPost/login/refresh/logout` 모두 이 prefix를 쓴다. fetch는 `credentials: 'include'`로 cookie 포함.

(2) Step 5에서 single origin (Caddy)으로 통합되면 `<meta>` 변경 한 줄로 흡수 (`/api`로 prefix 변경) — wrapper 코드 변경 없음. 

(3) CORS가 server side에서 허용되어야 cookie 송신 가능. 본 step에서 `STATIC_ORIGIN` 기본값 + `127.0.0.1:8765` 두 origin 허용. `[::1]:8765`는 dev 변형 (IPv6 localhost) — 운영적 우선순위 낮아 본 step에선 미추가. 필요시 추가 origin은 1줄 변경.

---

## 두 가지 codex 리뷰 메모 (acknowledged)

### M-1. `ws_auth.test.mjs` happy-path assertion 범위

(1) 테스트 파일 헤더 주석이 "server attaches socket.data.user from the JWT"라고 적었지만 happy-path 케이스는 클라이언트 측에서 관찰 가능한 `socket.connected` + `socket.id`까지만 assert. 서버 내부 `socket.data.user` 결합은 클라이언트 테스트에서 직접 관찰 수단 없음.

(2) §1.9에서 헤더 주석을 실제 assertion 범위에 맞춰 정리. server-side data 결합은 "transcript echo가 도착한다 = 핸드셰이크가 받아들여졌다"로 간접 검증. 더 강한 검증이 필요하면 별도 server-side 테스트 (fastify hook으로 socket 등록 시 콜백 잡기)를 추가하거나, Phase 4 진입 후 첫 DB 호출에서 orgId scoping이 작동하는지로 자연스럽게 확인됨.

### M-2. `dbPlugin` 현재 미사용

(1) `ws_auth.test.mjs:57`이 `dbPlugin`을 등록하지만 handshake 자체는 DB 안 탐. parity 유지 + forward-compat (Phase 4에서 WS 핸들러 안 DB 접근 시작 시 자연스럽게 필요해짐).

(2) 본 step에서 변경 없음. 위 헤더 주석에 의도 명시.

---

## Phase 0.5 → Phase 1 인계 처리 현황

`PHASE_1_MASTER.md` §6의 7개 인계 항목:

- [x] **JWT auth** — Step 3 완료
- [x] **DOMPurify** — Step 4 완료 (위 finding §11)
- [x] **`__liveSocket` 가드** — Step 4 완료 (위 finding §5)
- [x] **`text_chunk` start_call 선행 강제** — Step 4 완료 (위 finding §7)
- [x] **shared types 중복** — Phase 2로 명시 deferral (위 finding §10)
- [ ] FASTIFY_GUIDE.md snake_case 동기화 — Step 5
- [x] **PostgreSQL 부트스트랩** — Step 1 완료

7개 중 6개 closed, 1개(snake_case 동기화)는 Step 5에서.

---

## 의도하지 않게 남긴 것 / 후속 작업

- **Step 3 §7 `CommitAuthError` COMMIT 실패 시 client leak** — 미해결, Phase 1 마무리 또는 Phase 2 시작 시점에.
- **Step 3 §8 `listActiveMembershipsAcrossOrgs` O(orgs) scan** — 미해결, Phase 2 customers CRUD 시점에 SECURITY DEFINER 함수로 교체 검토.
- **Step 3 §9 `requireRole` style consistency** — 미해결, 사소함.
- **shared types** — Phase 2 진입 시 본격 도입.
- **DOMPurify CDN 의존성** — Phase 5 suggestion job 도입 시 self-host 검토.
- **CORS `[::1]:8765` 미허용** — 우선순위 낮음, 필요 시 1줄 추가.
- **`requireFreshRole` opt-in 헬퍼** — Phase 2 destructive endpoint 도입 시.
- **JWT_SECRET 키 회전** — RS256/EdDSA + `kid` 헤더로 (운영 진입 시).

---

## Step 5 진입 시 가장 먼저 봐야 할 것

1. `server/README.md` — Phase 1 step 4까지의 동작 흐름이 정리됨. Step 5는 Caddyfile.dev 추가 + 단일 origin (`https://localhost`)으로 정적/`/api/*`/`/socket.io/*` 라우팅.
2. `platform/api.js`의 `API_BASE_URL` resolver — Caddy 통합 후 `<meta name="kloser-api-base" content="/api">` 한 줄로 수렴 (위 finding §12).
3. 본 finding §1 (refresh cookie + reload UX) — single origin 통합 후 cookie 정책 단순화 (Path만 그대로) + `Domain` 명시 불필요.
4. `test/phase_0_5_e2e.mjs`의 `STATIC_ORIGIN` / `API_BASE` 두 변수 — Caddy origin 사용으로 변경 한 줄.
5. WS reverse proxy: socket.io는 `Upgrade` 헤더가 필요 — Caddyfile에서 `/socket.io/*` block 명시.
6. `FASTIFY_GUIDE.md` §8 snake_case 동기화 — Phase 0.5 인계 항목 마지막 1개 처리.

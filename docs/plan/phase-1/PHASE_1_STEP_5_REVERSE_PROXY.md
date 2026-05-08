# Phase 1 Step 5 — Reverse proxy (Caddy) + 운영 메모

> **상위 계획**: `docs/plan/phase-1/PHASE_1_MASTER.md` §3 Step 5.
> **선행**: Step 4 완료 — `docs/plan/phase-1/PHASE_1_STEP_4_CLIENT_WIRING.md`, `docs/plan/phase-1/PHASE_1_STEP_4_FINDINGS.md`.
> **기간**: 1일.

---

## 진행 상태

- [x] 1. Step 4 baseline 재검증 (`npm --prefix server test` 37/37, `node test/phase_0_5_e2e.mjs` 16/16, typecheck)
- [x] 2. `ops/Caddyfile.dev` 신설 — `localhost:443` 단일 origin (`tls internal`), `/socket.io/*` + `/auth/*` + `/me` + `/api/*` + `/health` → `127.0.0.1:3001`, 그 외 → static (`{$KLOSER_STATIC_ROOT:.}` env-with-default `.`)
- [x] 3. `server/src/server.ts` — CORS allow-list에 `https://localhost`, `https://127.0.0.1` 추가 (dev direct API 호출 호환성용 — Caddy same-origin 경로 자체는 CORS를 타지 않음)
- [x] 4. `platform/api.js` + `platform/ws.js` — **same-origin auto-detect 휴리스틱** 도입. 명시 override (`window.KLOSER_API_BASE` / `<meta>`)가 없으면 `location.protocol === 'https:' && location.hostname === 'localhost'`일 때 자동으로 `''` (relative URL)을 사용. 기존 `length > 0` 가드 두 군데 풀고 빈 문자열 통과 허용. live.html 추적 파일은 **수정 안 함** — Caddy 모드는 단지 `https://localhost`로 접속하기만 하면 자동 활성화.
- [x] 5. `test/phase_0_5_e2e.mjs` — `KLOSER_E2E_BASE_URL` env로 `STATIC_ORIGIN` + `API_BASE` 동시 override + Caddy self-signed 흡수용 `ignoreHTTPSErrors: true` 분기 (URL이 `https:`로 시작할 때만). `page.evaluate` 안에 박힌 절대 URL `"http://localhost:3001"` 두 군데도 인자로 전달.
- [x] 6. `docs/decision/FASTIFY_GUIDE.md` §8 — `call:start`/`call:chunk`/`call:end` (3 군데) → `start_call`/`text_chunk`/`end_call`로 동기화. JSON 예시의 `"type": "call:chunk"`도 함께. Phase 0.5 인계 항목 마지막 1건 클로즈.
- [x] 7. `server/README.md` — Caddy 사용법 + 두 origin 모드 비교표 (split `:8765+:3001` vs single `https://localhost`)
- [x] 8. 루트 `README.md` run section — Caddy variant 옵션 한 단락 + dev seed 자격증명 흐름이 동일함을 명시
- [x] 9. `docs/plan/phase-1/PHASE_1_STEP_5_FINDINGS.md` 작성 + 마스터 plan §3 Step 5 체크박스 + Phase 1 전체 §7 게이트 모두 동기화

---

## 0. 목적

Step 4까지 정적(`:8765`)과 API/WS(`:3001`)는 두 origin으로 분리돼 있다. Step 5는 그 두 origin을 **하나로 묶는 진입점**을 만든다. 마침표는 셋:

1. **단일 origin (`https://localhost`)** — 정적 + REST + WS가 한 도메인에 보임. prod 배포 외형과 동등.
2. **TLS prod 동등 검증** — Caddy `tls internal`이 self-signed 인증서를 발급. 이 모드에서만 `cookieSecure=true` 흐름이 실제로 동작 가능 (HTTP localhost에선 Secure cookie가 거부됨). Step 3의 `authEnv.cookieSecure` 분기가 prod-equivalent 환경에서 검증된다.
3. **Phase 0.5 인계 마지막 1건 처리** — `FASTIFY_GUIDE.md` §8의 콜론 표기 (`call:start`/`call:chunk`/`call:end`)를 코드와 일치하는 snake_case로 동기화. `BACKEND_PLAN.md` §6 + `server/src/ws/calls.ts`와 표기 통일.

Step 5가 끝나면 Phase 1 종료 게이트 (`PHASE_1_MASTER.md` §7) 9개가 모두 채워진다.

---

## 1. 사전 결정 8건

| 항목 | 결정 | 근거 |
|---|---|---|
| 1. Reverse proxy 선택 | **Caddy** (Master plan §2 결정 재확인) | TLS 자동 갱신·`tls internal`로 dev에서도 self-signed 단순. Nginx 대비 설정 1/3 분량. WS upgrade 헤더 자동 forward |
| 2. dev TLS 전략 | **`tls internal`로 self-signed 인증서 발급** (Caddy 내장 CA). 브라우저는 처음 접속 시 경고 — 한 번 트러스트하거나 `--ignore-certificate-errors` 사용 | `cookieSecure=true` 동작 검증을 위해 진짜 HTTPS가 필요. plaintext `:80`만 띄우면 prod-equivalent 검증 안 됨. 자체 CA를 시스템에 install하는 가이드는 별도 (`docs/plan/phase-1/PHASE_1_STEP_5_FINDINGS.md`) |
| 3. Caddy 도메인 / 포트 | **`localhost:443`** 단일 endpoint (`:80`은 Caddy 자체가 자동으로 `:443` redirect). 다른 도메인 (예: `kloser.local`) 사용은 운영 단계로 미룸 | `localhost`는 hosts 파일 수정 없이 동작. dev 단순함 우선 |
| 4. routing 분리 | **prefix matching** — `/socket.io/*` + `/auth/*` + `/me` + `/api/*` + `/health` → `127.0.0.1:3001`, 그 외 (`/`, `/platform/*`, `/assets/*`, `/index.html` 등) → `file_server`. `handle` 블록 (prefix 보존) 사용, `handle_path` (prefix strip) 사용 안 함 — socket.io는 prefix를 받아야 동작. **`/api/*`는 현재 Fastify에 매핑된 라우트 없음 — Phase 4+ (calls REST + dashboard) 진입 시 의미** — 라우팅만 미리 깔아둠 | path-based 분리가 가장 직관적. health probe는 외부에서 띄울 때 단일 endpoint로 |
| 5. 정적 루트 | **`{$KLOSER_STATIC_ROOT:.}`** — Caddy v2의 env-with-default 문법. env가 없으면 caddy 실행 디렉토리(`.`)를 사용. README 권장값은 절대경로 (`Resolve-Path .` / `$(pwd)`)로 명시 | Caddyfile은 commit되지만 머신별 경로는 env로 분리. env 없이 project root에서 caddy를 실행하면 `.` 기본값으로도 동작 — silent failure 없음 |
| 6. 기존 split-origin dev 기본 동작 유지 | **Caddy는 옵트인** — Step 4까지의 `:8765` + `:3001` 흐름을 `npm run dev` 기본으로 유지. Caddy 사용은 별도 명령 (`caddy run --config ops/Caddyfile.dev`)으로만 트리거. **API base URL 결정은 페이지 origin 기반 auto-detect** (다음 결정 7) — `live.html` 등 추적 파일에 commented-out `<meta>`나 별도 hint 박지 않음 | 16/16 e2e baseline을 기존 dev로 유지. Caddy 변형 e2e는 page origin이 `https://localhost`로 바뀌는 것만으로 자동 활성화 — 추가 수동 조작 없이 자동화 가능 |
| 7. same-origin auto-detect 휴리스틱 | `api.js` `resolveApiBase()`의 우선순위:<br>1. `window.KLOSER_API_BASE` (string이면 그 값, 빈 문자열도 그대로 통과)<br>2. `<meta name="kloser-api-base">`가 `content` attr을 가지면 그 값 (빈 문자열도 통과)<br>3. `location.protocol === 'https:' && location.hostname === 'localhost'`이면 `''` (auto same-origin — Caddy 모드 추정)<br>4. 그 외 default `http://localhost:3001`<br>`ws.js` `defaultBaseUrl()`도 `length > 0` 가드를 풀고 빈 문자열을 그대로 통과시켜 `io('/calls', ...)` (socket.io-client가 page origin 사용) | (a) Caddy 모드 사용자는 `https://localhost`에 접속하기만 하면 자동 활성화 — HTML 수정 없음. (b) 명시 override가 여전히 가능 — Phase 6+에서 `https://kloser.local` 등 custom 도메인 사용 시 `window.KLOSER_API_BASE` 또는 `<meta>`로 지정. (c) 자동 분기 조건이 좁음 (`localhost` 한정) — `127.0.0.1` 등은 false negative. 자동 분기를 넓히려면 `isDevHost()`와 동일하게 4-host로 확장 가능 — 본 step에선 단순함 우선 |
| 8. CORS allow-list 갱신 | **server.ts의 CORS array에 `https://localhost`, `https://127.0.0.1` 추가** — Caddy same-origin 경로(`https://localhost/auth/*` 같은)는 CORS를 트리거하지 않으므로 same-origin 자체에는 불필요. 본 변경은 **다른 HTTPS dev proxy origin (예: VS Code Dev Tunnels, 다른 reverse-proxy 도구) 뒤에서 페이지가 `https://localhost`로 보이는 경우에 대한 안전망**. 현재 Fastify는 plaintext `:3001`로 listen하므로 `https://localhost:3001` direct call은 실제 시나리오 아님. 운영 배포는 `STATIC_ORIGIN` env로 실제 도메인 override (Step 1~4 흐름 동일) | "Caddy 필수가 아닌 forward-compat 호환성 안전망"이 정확한 의미. 별도 env 추가 없이 array literal로 충분 |

---

## 2. 범위

### 한다

- `ops/Caddyfile.dev` 작성 (단일 origin, TLS internal, path-based 라우팅)
- `server/src/server.ts` CORS array 갱신
- `platform/api.js` + `platform/ws.js`의 same-origin sentinel 지원 (옵트인)
- `test/phase_0_5_e2e.mjs` 환경변수 기반 origin 파라미터화 + HTTPS-aware launch context
- `docs/decision/FASTIFY_GUIDE.md` §8 snake_case 동기화 (Phase 0.5 인계 마지막 1건)
- `server/README.md` Caddy 섹션 + 두 모드 비교표
- 루트 `README.md` run section에 Caddy variant 한 단락 + 상태 블록 갱신
- `docs/plan/phase-1/PHASE_1_STEP_5_FINDINGS.md` + master plan / step plan 체크박스 동기화

### 안 한다 (이후로 미룸)

- **Caddy의 system service / autostart** — dev에선 foreground 실행으로 충분. systemd / launchd 등은 운영 배포 시.
- **Custom 도메인 + TLS chain** — `localhost`로 dev 충분. `kloser.local` 등 hosts 수정 가이드는 별도 ops 문서 (Phase 6+).
- **Production Caddyfile** — Phase 1 결과물은 `Caddyfile.dev` 하나. prod용 (`Caddyfile.prod`)은 도메인 + Let's Encrypt + rate limit 등이 결정된 시점에.
- **Caddy 메트릭/로그 통합** — Phase 6 또는 운영 진입 단계에서.
- **HTTP/3 또는 QUIC** — Caddy가 자동으로 켜지만 dev 검증 범위 밖. 그대로 두되 본 Step에선 명시 검증 안 함.
- **WS reconnection through proxy 장기 idle 검증** — 본 step에선 16/16 e2e + 수동 smoke로 충분. 장기 idle disconnect는 운영 단계의 별도 부하 검증.

---

## 3. 디렉토리 변화

```text
kloser/
├── ops/
│   ├── docker-compose.yml
│   ├── postgres/
│   └── Caddyfile.dev                       # 🆕 Step 5
├── platform/
│   ├── api.js                              # 🟡 same-origin sentinel 지원
│   └── ws.js                               # 🟡 same-origin sentinel 지원
├── server/
│   └── src/
│       └── server.ts                       # 🟡 CORS array에 https://localhost 추가
├── test/
│   └── phase_0_5_e2e.mjs                   # 🟡 KLOSER_E2E_BASE_URL env + TLS-ignore
└── docs/
    ├── decision/
    │   └── FASTIFY_GUIDE.md                # 🟡 §8 snake_case 동기화
    └── plan/
        └── phase-1/
            └── PHASE_1_STEP_5_FINDINGS.md  # 🆕
```

---

## 4. 단계별 작업

### 1. Step 4 baseline 재검증

```bash
npm --prefix server test                      # 37/37
npm --prefix server run typecheck             # PASS
node test/phase_0_5_e2e.mjs                   # 16/16 (split-origin dev)
docker compose -f ops/docker-compose.yml ps   # postgres + redis healthy
```

검증: 위 모두 깨끗할 때 시작. 깨지면 Step 5 진입 안 함 — Step 4 회귀 가드.

### 2. `ops/Caddyfile.dev`

Caddy v2 syntax. `tls internal`로 자동 self-signed 발급. `handle` (prefix 보존) 사용 — `/socket.io`는 그 prefix를 그대로 받아야 socket.io-client / server가 호환.

```caddy
# Phase 1 Step 5 — single-origin reverse proxy (dev only)
# Run from project root:
#   $env:KLOSER_STATIC_ROOT = (Resolve-Path .).Path   # PowerShell
#   caddy run --config ops/Caddyfile.dev
#
# Or:
#   KLOSER_STATIC_ROOT=$(pwd) caddy run --config ops/Caddyfile.dev   # bash
#
# First-time access on https://localhost:
#   - Browser will warn about self-signed cert. Trust it once or
#     follow `caddy trust` (system CA install) per OS.
#   - For e2e: set KLOSER_E2E_BASE_URL=https://localhost; the test
#     uses ignoreHTTPSErrors when the URL is https.

{
	# Auto-HTTPS via Caddy's internal CA. Browser will warn until
	# trusted; that's expected in dev.
	local_certs
}

localhost {
	# Order matters: more specific paths first. handle (prefix kept,
	# no strip) is the right primitive for both socket.io and the
	# REST surface — Fastify and socket.io-server both expect to see
	# their original paths on the wire.

	handle /socket.io/* {
		reverse_proxy 127.0.0.1:3001
	}

	handle /auth/* {
		reverse_proxy 127.0.0.1:3001
	}

	handle /me {
		reverse_proxy 127.0.0.1:3001
	}

	handle /api/* {
		# Forward-compat only. No /api/* route is wired in Fastify today
		# (Step 1~4 surface is /auth/*, /me, /health). Phase 4+ (calls
		# REST + dashboard) populates this prefix. Routing it now keeps
		# the Caddyfile stable across that transition.
		reverse_proxy 127.0.0.1:3001
	}

	handle /health {
		reverse_proxy 127.0.0.1:3001
	}

	# Everything else falls through to the static project root.
	# That covers /, /index.html, /platform/*, /assets/*, /docs/*.html.
	# Caddy's env-default syntax `{$VAR:default}` makes this resilient:
	# if KLOSER_STATIC_ROOT is unset, Caddy serves from its own working
	# directory (".") — fine when launched from project root, and a
	# clear failure mode otherwise (404 on /platform/...).
	handle {
		root * {$KLOSER_STATIC_ROOT:.}
		file_server
	}
}
```

검증:
- `caddy validate --config ops/Caddyfile.dev` → ok.
- 수동: `caddy run` 후 `curl -k https://localhost/health` → `{"ok":true,...}`.
- `curl -k https://localhost/platform/login.html` → 200.
- 브라우저: `https://localhost/platform/live.html` 로딩 → login redirect → 정상 데모.

### 3. `server/src/server.ts` — CORS allow-list 확장

Caddy same-origin 경로(`https://localhost/auth/login` 같은) 자체는 CORS preflight를 타지 않는다 — 페이지와 fetch 대상이 같은 origin이기 때문. 따라서 본 변경은 **Caddy 동작에 필수가 아니다**. 추가하는 의미는 forward-compat 안전망: 다른 HTTPS dev proxy 도구 (VS Code Dev Tunnels, ngrok, 또 다른 reverse-proxy) 뒤에서 페이지가 `https://localhost`로 보이는 경우 그 origin을 거부하지 않도록 미리 허용. 현재 Fastify는 plaintext `:3001`로 listen하므로 `https://localhost:3001`로의 direct call은 실제 시나리오가 아님.

```ts
await app.register(cors, {
  origin: [
    STATIC_ORIGIN,
    "http://127.0.0.1:8765",
    // Forward-compat safety net for HTTPS dev proxy origins (e.g.
    // VS Code Dev Tunnels) where the page resolves to https://localhost
    // but the API is still hit directly. Caddy single-origin requests
    // never reach this allow-list — they're same-origin.
    "https://localhost",
    "https://127.0.0.1",
  ],
  credentials: true,
});
```

socket.io의 `cors.origin`도 동일 array로 갱신.

검증: `npm --prefix server test` 37/37 PASS 그대로 유지.

### 4. `platform/api.js` + `platform/ws.js` — same-origin auto-detect

핵심: **추적 파일 (`live.html`, `login.html`)은 손대지 않는다.** 사용자가 `https://localhost`로 접속하기만 하면 api.js가 자동으로 same-origin 모드로 전환. e2e Caddy variant도 별도 HTML 변형 없이 동일 코드 경로로 검증 가능.

`api.js` `resolveApiBase()` (4-step 우선순위):

```js
function resolveApiBase() {
  // 1. Explicit window override — empty string also passes through
  //    (operator-set same-origin signal).
  if (typeof window.KLOSER_API_BASE === 'string') {
    return window.KLOSER_API_BASE.replace(/\/+$/, '');
  }
  // 2. Explicit <meta> override — same empty-string passthrough.
  const meta = document.querySelector('meta[name="kloser-api-base"]');
  if (meta && meta.hasAttribute('content')) {
    return meta.content.replace(/\/+$/, '');
  }
  // 3. Auto: HTTPS on localhost is almost certainly Caddy single-origin
  //    dev (or a prod-equivalent setup) — use relative URLs so fetch
  //    targets the page's own origin. Plain http://localhost:8765 keeps
  //    falling through to the absolute default below.
  if (
    window.location.protocol === 'https:' &&
    window.location.hostname === 'localhost'
  ) {
    return '';
  }
  // 4. Default — split-origin dev (http://localhost:8765 page hits
  //    http://localhost:3001 API).
  return DEFAULT_API_BASE;
}
```

`buildUrl(path)`은 빈 문자열을 받으면 `'' + '/auth/login'` = `/auth/login` (relative)을 반환 — 현재 구현이 이미 그렇게 동작. 추가 분기 없음.

`ws.js` `defaultBaseUrl()`:

```js
function defaultBaseUrl() {
  // Mirror api.js: empty string from kloserApi.apiBaseUrl is the
  // legitimate same-origin signal — pass through without falling back.
  if (window.kloserApi && typeof window.kloserApi.apiBaseUrl === 'string') {
    return window.kloserApi.apiBaseUrl;
  }
  return 'http://localhost:3001';
}
```

`connectCallNamespace`의 `const url = baseUrl + '/calls';`은 빈 baseUrl이면 `/calls` (relative). socket.io-client는 절대/상대 모두 받으며, 상대일 때 `window.location.origin`을 사용한다.

검증:
- split-origin (`http://localhost:8765/platform/live.html`) → `resolveApiBase()` step 3 false, step 4 → `http://localhost:3001`. 16/16 e2e 그대로.
- Caddy (`https://localhost/platform/live.html`) → step 3 hit → `''`. 16/16 e2e Caddy variant도 동일 코드 경로로 통과 (다음 §4.5).

### 5. `test/phase_0_5_e2e.mjs` — origin 파라미터화 (Caddy variant 자동화)

§4.4의 auto-detect 휴리스틱 덕분에 추적 파일 (`live.html`, `login.html`)을 변형하지 않고도 두 모드를 동일 코드 경로로 검증한다. e2e는 base URL만 env로 swap.

현재 4개 상수를 단일 base로 collapse:

```js
const E2E_BASE = process.env.KLOSER_E2E_BASE_URL;  // e.g. "https://localhost"
const STATIC_ORIGIN = E2E_BASE || "http://localhost:8765";
const API_BASE      = E2E_BASE || "http://localhost:3001";
const LOGIN_URL     = `${STATIC_ORIGIN}/platform/login.html`;
const LIVE_URL      = `${STATIC_ORIGIN}/platform/live.html`;
const API_HEALTH    = `${API_BASE}/health`;

const isHttps = STATIC_ORIGIN.startsWith("https:");
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ ignoreHTTPSErrors: isHttps });
```

probe 코드 (page.evaluate)에 박혀 있는 절대 URL `"http://localhost:3001"` 두 군데도 외부에서 받아 인자로 전달:

```js
const noTokenResult = await page.evaluate(async (apiBase) => {
  const sock = window.io(apiBase + "/calls", { ... });
  // ...
}, API_BASE);
```

이미 §1.8의 두 auth-reject 케이스가 동일 패턴이라 정합.

검증 (양쪽 모두 본 step §6 완료 기준):
- (A) split-origin: `node test/phase_0_5_e2e.mjs` → 16/16 PASS (회귀)
- (B) Caddy single-origin: `KLOSER_E2E_BASE_URL=https://localhost node test/phase_0_5_e2e.mjs` → 16/16 PASS

(B) 사전 조건: `caddy run --config ops/Caddyfile.dev`이 백그라운드에서 동작 중이어야 함. e2e 시작 시점에 `https://localhost/health`를 health probe로 사용하므로 Caddy + Fastify 둘 다 살아있어야 통과.

### 6. `docs/decision/FASTIFY_GUIDE.md` §8 — snake_case 동기화

현재:

```text
client -> server
  call:start
  call:chunk
  call:end
```

```json
{ "type": "call:chunk", ... }
```

변경:

```text
client -> server
  start_call
  text_chunk
  end_call
```

```json
{ "type": "text_chunk", ... }
```

같은 §8의 server→client 이벤트(`transcript`, `suggestion`, `sentiment`, `checklist:update`, `error`)는 코드와 일치하므로 변경 없음. 단, `checklist:update`는 현재 코드에 없음 — `BACKEND_PLAN.md` §6과 비교하여 코드에 없는 이벤트면 가이드에서 제거하거나 "Phase 4 예정"으로 표기.

또 §10의 마지막 한 줄 `WebSocket call:chunk -> transcript/suggestion 이벤트`도 동기화: `text_chunk -> transcript/suggestion`.

검증: `grep -n "call:" docs/decision/FASTIFY_GUIDE.md` 결과 0건.

### 7. `server/README.md` — Caddy 섹션

기존 "Run" 섹션 뒤에 새 섹션 추가:

```markdown
## Run (Caddy single-origin variant — optional)

For a prod-equivalent single-origin dev setup (HTTPS, cookie Secure
flag exercised, same-origin /api + /socket.io + /platform/*):

1. Install Caddy v2 (`scoop install caddy` on Windows; `brew install
   caddy` on macOS; `apt install caddy` on Debian).
2. Set the static root and run:
   ```bash
   # PowerShell
   $env:KLOSER_STATIC_ROOT = (Resolve-Path .).Path
   caddy run --config ops/Caddyfile.dev

   # bash
   KLOSER_STATIC_ROOT=$(pwd) caddy run --config ops/Caddyfile.dev
   ```
3. Trust the Caddy CA once (browser warning):
   ```bash
   caddy trust
   ```
4. Open `https://localhost/platform/live.html`. Because the page
   origin is `https://localhost`, `platform/api.js` auto-detects
   Caddy single-origin mode and uses relative URLs (`/auth/*`,
   `/me`, `/calls`) without editing `live.html`. To override
   (e.g. for a custom domain like `https://kloser.local`), set
   `window.KLOSER_API_BASE` or add a `<meta name="kloser-api-base">`
   to the page head — those take precedence over the auto-detect.

| 비교 | split-origin (default) | Caddy single-origin |
|---|---|---|
| 정적 | http://localhost:8765 (http-server) | https://localhost (Caddy) |
| API | http://localhost:3001 (Fastify) | https://localhost/auth/* etc. (Caddy → :3001) |
| WS | http://localhost:3001/calls | https://localhost/socket.io/* (Caddy → :3001) |
| TLS | none | tls internal (self-signed) |
| Cookie Secure flag | false (HTTP) | true 가능 (HTTPS) |
| api.js base URL | `http://localhost:3001` (default) | `""` auto-detected on `https://localhost` |
| 사용 시나리오 | 일상 dev / 16/16 e2e baseline | prod 등가 검증 / TLS 동작 확인 |
```

검증: 새 섹션 read-through + 명령어 그대로 실행 가능 확인.

### 8. 루트 `README.md` — Caddy variant 한 단락

`라이브 통화 백엔드` 섹션 끝에 한 단락 추가:

```markdown
> **선택**: prod-equivalent single-origin (HTTPS) 검증이 필요하면
> `ops/Caddyfile.dev`로 Caddy 단일 origin 모드를 띄울 수 있습니다.
> 자세한 절차는 [`server/README.md`](../../../server/README.md)의
> "Run (Caddy single-origin variant)" 참고.
```

상태 블록 (line 146 부근) 갱신: `Step 1~4 완료, 다음 Step 5` → `Phase 1 완료 (Step 1~5)`. 검증 수치는 17/17 또는 그대로 (e2e가 깨지면 수정).

### 9. `docs/plan/phase-1/PHASE_1_STEP_5_FINDINGS.md`

Step 5에서 발견·결정·미해결 인계. 최소 다음 항목:

- Caddy `tls internal` self-signed CA install / trust 절차 (OS별 메모)
- single-origin vs split-origin 두 모드 정합성 — same-origin sentinel 옵트인 contract
- cookie Secure flag가 Caddy 모드에서만 유효함 — split-origin은 false 강제 (env로 제어)
- WS upgrade 헤더 자동 forward 검증 결과 (16/16 회귀 통과 시)
- FASTIFY_GUIDE.md §8 동기화 결과 (Phase 0.5 인계 7개 모두 closed)
- Phase 1 전체 완료 게이트 (`PHASE_1_MASTER.md` §7) 9개 체크 결과
- Phase 2 진입 시 우선순위 (customers CRUD + shared types 동시 시점)

`PHASE_1_MASTER.md` §3 Step 5 체크박스 + §7 게이트 9개 + Phase 0.5 인계 7개 모두 닫는다.

검증: `grep -n "\[ \]" docs/plan/phase-1/PHASE_1_MASTER.md` 결과가 의도된 deferral (Phase 2+) 항목만 남았는지 확인.

---

## 5. 위험·미정

| 항목 | 처리 |
|---|---|
| Caddy CA가 시스템에 미설치 → 브라우저 경고 / e2e 실패 | `caddy trust` 1회 실행 명시. e2e는 `ignoreHTTPSErrors: true`로 흡수. self-host 대안 (Let's Encrypt staging)은 운영 단계로 미룸. |
| `KLOSER_STATIC_ROOT` 머신별 절대경로 — Caddyfile commit 시 노출 안 됨 | env 기반 → Caddyfile에 `{$KLOSER_STATIC_ROOT}` placeholder. 절대경로 leak 없음. |
| socket.io의 namespace path와 Caddy `/socket.io/*` 매칭 | socket.io 클라/서버 모두 `/socket.io` prefix가 prefix로 굳어 있음. `handle /socket.io/*` (prefix 보존)이 정합. `handle_path`는 strip이라 사용 금지. |
| WS upgrade 헤더 차단 | Caddy의 `reverse_proxy`는 `Upgrade: websocket`/`Connection: upgrade`/`Sec-WebSocket-*`를 자동 forward. 별도 directive 없음. 검증: e2e Caddy variant에서 transcript echo가 RTT 0~5ms로 재현되는지. |
| port 80 / 443 점유 충돌 (특히 Windows IIS 또는 다른 dev) | Caddy가 port 사용 중이면 fail-fast. 우회: Caddyfile address를 `localhost:8443` 등으로 override (단, browser url + e2e env도 함께 변경). |
| Caddy 모드에서 cookie Secure 강제 — split-origin 회귀 충돌 | `authEnv.cookieSecure`는 env 기반 (`COOKIE_SECURE` 또는 `NODE_ENV=production` 분기). Caddy 모드 사용자는 `COOKIE_SECURE=true`를 별도 set. 두 모드 동시 운영은 권장 안 함 (다른 PORT로도 cookie attribute가 충돌). |
| auto-detect 휴리스틱이 다른 dev 환경에서 false-positive | 조건이 좁음 (`https:` + `localhost` 동시 만족) — 일반 dev (`http://localhost:8765`)는 절대 매칭 안 함. `https://kloser.local` 등 custom 도메인은 false-negative이지만 `window.KLOSER_API_BASE` / `<meta>`로 명시 override 가능. Phase 6+에서 prod 도메인 대응 시 그때 분기 추가. |
| e2e Caddy variant 자동화 — Caddy 미기동 시 health probe 실패 | 본 step §6 완료 기준에 두 시나리오 (split + Caddy) 모두 자동화. Caddy variant 사전 조건은 `caddy run --config ops/Caddyfile.dev` 백그라운드. STEP_5_FINDINGS에 booting 절차 명시. CI 자동화는 Phase 6+ infra 단계로 미룸. |
| `FASTIFY_GUIDE.md` §8 갱신이 다른 문서/예시를 깨는지 | `grep -n "call:" docs/` 전수 점검. 코드(`server/src/ws/calls.ts`, `platform/ws.js`, `platform/live.html`, e2e)는 이미 snake_case라 영향 없음. |

---

## 6. 완료 기준 (Step 5 — go/no-go)

- [x] `npm --prefix server run typecheck` PASS
- [x] `npm --prefix server test` PASS (37/37 그대로 — Step 5는 server src 변경 거의 없음)
- [x] `node test/phase_0_5_e2e.mjs` 16/16 PASS (split-origin 회귀)
- [x] Caddy single-origin variant 16/16 PASS — `caddy run --config ops/Caddyfile.dev` 사전 기동 후 다음 명령으로 검증됨:
  ```bash
  # bash / macOS / Linux
  KLOSER_E2E_BASE_URL=https://localhost node test/phase_0_5_e2e.mjs
  ```
  ```powershell
  # PowerShell (이 repo 기본 셸)
  $env:KLOSER_E2E_BASE_URL = 'https://localhost'
  node test/phase_0_5_e2e.mjs
  Remove-Item Env:KLOSER_E2E_BASE_URL
  ```
- [x] `caddy validate --config ops/Caddyfile.dev` ok
- [x] `caddy run --config ops/Caddyfile.dev` + `curl -k https://localhost/health` → `{"ok":true}`
- [x] 수동 smoke: 브라우저로 `https://localhost/platform/live.html` 진입 → login redirect → 데모 흐름 재생 (auto-detect 휴리스틱이 별도 HTML 변형 없이 동작 확인)
- [x] `grep -n "call:" docs/decision/FASTIFY_GUIDE.md` 결과 0건
- [x] `docs/plan/phase-1/PHASE_1_STEP_5_FINDINGS.md` 작성
- [x] `PHASE_1_MASTER.md` §3 Step 5 `[x]` + §7 게이트 9개 모두 `[x]`
- [x] Phase 0.5 인계 7개 모두 closed (snake_case 동기화로 마지막 항목 처리)

---

## 7. 한 줄 요약

> **1일 동안, 정적 + REST + WS를 `https://localhost` 단일 origin (Caddy `tls internal`) 뒤에 묶고, `FASTIFY_GUIDE.md` §8을 코드와 일치하는 snake_case로 동기화해서, Phase 1을 종료한다.**

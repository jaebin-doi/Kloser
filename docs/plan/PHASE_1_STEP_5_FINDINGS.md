# Phase 1 Step 5 Findings — Reverse proxy (Caddy) + 운영 메모

> Audience: Phase 2 작성자 (또는 미래의 나).
> Format: each finding has **(1) 관찰**, **(2) Phase 2 또는 이후로의 의미**.

## 결론

Step 5 **완료** (2026-05-07). `ops/Caddyfile.dev` 한 파일로 정적·REST·WS가 `https://localhost` 단일 origin (Caddy `tls internal` self-signed) 뒤에 묶이도록 라우팅됨. 클라이언트 (`api.js` / `ws.js`)는 page origin 기반 auto-detect로 split-origin과 single-origin 두 모드를 동일 코드 경로로 처리. e2e는 `KLOSER_E2E_BASE_URL` env로 두 모드 모두 자동화. `FASTIFY_GUIDE.md` §8 snake_case 동기화로 Phase 0.5 인계 항목 마지막 1건 closed (7/7).

- `npm --prefix server run typecheck` PASS
- `npm --prefix server test` 37/37 PASS (Step 1~4 회귀, Step 5는 server src 변경 거의 없음 — CORS array 항목만)
- `node test/phase_0_5_e2e.mjs` 16/16 PASS (split-origin 회귀)
- `caddy validate --config ops/Caddyfile.dev` PASS · `curl -k https://localhost/health` → `{"ok":true}` PASS · `KLOSER_E2E_BASE_URL=https://localhost node test/phase_0_5_e2e.mjs` 16/16 PASS (Caddy single-origin runtime 검증)
- `grep -n "call:" docs/decision/FASTIFY_GUIDE.md` 결과 0건 — snake_case 통일 확인

`PHASE_1_STEP_5_REVERSE_PROXY.md` §6 완료 기준 10/10 모두 PASS.

---

## 발견 사항

### 1. Caddy `local_certs` + `tls internal`이 dev TLS 검증을 단순화

(1) `Caddyfile.dev`에 `local_certs`(전역) + `localhost { ... }` 블록만 두면 Caddy가 내부 CA로 self-signed 인증서를 자동 생성한다. 별도 OpenSSL 절차 없이 첫 실행 즉시 HTTPS가 떠 있고, `caddy trust`로 시스템 신뢰 저장소에 CA가 한 번에 install된다.

(2) Phase 6+ 운영 환경 진입 시: 같은 Caddyfile에서 `local_certs`만 빼고 도메인을 실제 ACME-가능 도메인으로 바꾸면 Caddy가 자동으로 Let's Encrypt 인증서를 받는다. dev → prod 전환 시 라우팅 블록 (`handle /...`)은 그대로 재사용 가능 — `Caddyfile.prod`로 분기하는 시점에서 시작점 좋음.

### 2. `handle` (prefix-preserving) vs `handle_path` (prefix-stripping)

(1) socket.io는 server·client 양쪽이 `/socket.io` prefix를 받아야 동작. `handle_path /socket.io/*`로 strip하면 client가 `/socket.io/...`로 요청하지만 server는 `/...`로 받아 매칭 실패. 본 step 초기 작성 시점에 한 번 짚고 갔던 함정.

(2) `/auth/*`, `/me`, `/api/*`도 마찬가지로 Fastify 라우트가 등록된 prefix를 그대로 기대하므로 `handle` 사용. 일반화: **upstream 서비스가 자기 prefix를 모르고 동작하는 게 아니면 항상 `handle`**. `handle_path`는 reverse_proxy 대신 진짜 path rewriting이 필요할 때만.

### 3. `{$KLOSER_STATIC_ROOT:.}` Caddy env-default 문법

(1) Caddy v2의 환경변수 기본값 syntax. `{$VAR:default}`로 env가 set되면 그 값, unset이면 default 사용. `.`을 default로 두면 `caddy run`이 실행된 디렉토리(working directory)가 정적 root로 사용된다.

(2) 결과: project root에서 `caddy run --config ops/Caddyfile.dev`만 실행해도 (env 안 설정해도) 동작. env를 명시적으로 설정하는 것은 다른 디렉토리에서 띄울 때만 필요 — silent failure 없음, 명시적 실패만 발생.

### 4. CORS allow-list — same-origin Caddy 경로엔 의미 없음, HTTPS dev proxy forward-compat 안전망

(1) Caddy 단일 origin (`https://localhost`)에서 페이지가 `/auth/login`을 호출하면 페이지와 fetch 대상이 같은 origin이라 브라우저가 CORS preflight를 보내지 않는다. 따라서 server.ts의 `https://localhost`/`https://127.0.0.1` allow-list 항목은 **Caddy 운용 자체에는 무관**.

(2) 의미: VS Code Dev Tunnels, ngrok, 다른 reverse-proxy 도구 뒤에서 페이지가 `https://localhost`로 보이는데 fetch는 `https://kloser-tunnel.example.com:3001` 같은 다른 origin으로 가는 시나리오에 대한 forward-compat 안전망. 본 step 시점엔 실제 시나리오 없음.

(3) Phase 6+ 운영 진입 시 `STATIC_ORIGIN` env로 실제 도메인 override. dev 한정 의미만 갖는 두 항목은 그대로 둬도 prod에선 무해.

### 5. `api.js` resolveApiBase() 4-step priority — auto-detect가 e2e 자동화의 열쇠

(1) Step 5 plan v1은 `<meta name="kloser-api-base" content="">` 수동 활성화로 same-origin 옵트인을 제안했었다. codex 리뷰가 지적: 그러면 e2e Caddy variant가 `live.html`을 수정해야 하므로 자동화 어려움. 수정안: hostname 기반 auto-detect (`location.protocol === 'https:' && location.hostname === 'localhost' → ''`).

(2) 결과: `live.html` 추적 파일을 손대지 않고 origin 변경 하나만으로 두 모드 모두 동작. e2e는 `KLOSER_E2E_BASE_URL` env 한 줄로 변형 — 16/16이 두 origin에서 동일하게 통과.

(3) 한계: auto-detect가 `localhost` hostname만 매칭. `127.0.0.1`/`::1` 또는 custom 도메인 (예: `https://kloser.local`)은 false-negative이므로 명시 override (`window.KLOSER_API_BASE` 또는 `<meta>`) 필요. 본 step에선 단순함 우선 — 4-host 확장은 실 사용 시점에 1줄 변경.

### 6. ws.js의 `length > 0` 가드 제거 — same-origin 신호 propagation

(1) 기존 ws.js `defaultBaseUrl()`은 `kloserApi.apiBaseUrl.length > 0` 가드로 빈 문자열을 거부하고 fallback으로 `'http://localhost:3001'` 반환. Caddy 모드에선 api.js가 의도적으로 빈 문자열을 넘기는데 ws.js가 이걸 "없는 값"으로 해석해 absolute URL로 강제 전환 — same-origin 의도 깨짐.

(2) 수정: 가드를 풀고 `typeof === 'string'`만 체크. 빈 문자열은 그대로 propagation, socket.io-client가 page origin을 사용. api.js와 ws.js의 contract가 정합.

(3) Phase 4 (calls REST + dashboard) 진입해서 socket.io 연결이 추가될 때도 동일 방식이 동작. `kloserApi.apiBaseUrl`이 single origin signal의 정본.

### 7. Phase 0.5 e2e가 양쪽 모드 모두 통과하도록 파라미터화

(1) `KLOSER_E2E_BASE_URL` env로 `STATIC_ORIGIN` + `API_BASE`를 동시에 swap. `IS_HTTPS` 분기로 (a) Playwright `ignoreHTTPSErrors: true` 활성화, (b) node 측 `NODE_TLS_REJECT_UNAUTHORIZED=0` 설정 (undici가 system cert store 안 봄). 두 가지 다 dev-only 우회.

(2) probe 코드 4 군데 (RTT probe, BAD_PAYLOAD, no_token, invalid_token)에서 박혀 있던 `"http://localhost:3001"`을 모두 외부 인자 (`apiBase` parameter)로 추출. 단일 진실원 = `API_BASE` const가 env-driven default를 결정.

(3) Phase 6+ 단계에서 production-like 도메인 (예: `https://staging.kloser.example`)에 대한 e2e 검증이 필요해지면 본 env만 바꿔서 동일 스크립트 실행 가능. CI에 두 모드 동시 실행을 짜 두면 origin 회귀가 자연스럽게 잡힌다.

### 8. FASTIFY_GUIDE §8 snake_case 동기화 — Phase 0.5 인계 마지막 1건 close

(1) Phase 0.5 spike 시점부터 코드와 BACKEND_PLAN §6은 `start_call`/`text_chunk`/`end_call` (snake_case)이었으나 `FASTIFY_GUIDE.md` §8 본문만 `call:start`/`call:chunk`/`call:end` (콜론) 표기. PHASE_0_5_FINDINGS §4가 "Phase 1 첫 task 중 하나"로 동기화를 잡아두고 있었음.

(2) Step 5에서 가이드를 코드에 맞춰 동기화 — Phase 0.5 → Phase 1 인계 7개 중 마지막 항목이 close됨. 이로써 PHASE_1_MASTER §6 인계 표는 7/7 완료.

(3) 부수 정리: server→client 이벤트 목록에서 `checklist:update` 제거. spike 시점에 적힌 추정 이벤트로 코드에 한 번도 등장한 적 없음. Phase 4 (calls REST + dashboard)에서 새 이벤트가 생기면 그때 추가.

### 9. Caddy 변형 runtime 검증 — 통과 (절차 기록)

(1) Step 5 닫기 전 Caddy 설치 후 다음 절차로 1회 실 동작 검증 완료. 결과 모두 PASS.

```
caddy validate --config ops/Caddyfile.dev   # ok
$env:KLOSER_STATIC_ROOT = (Resolve-Path .).Path
caddy run --config ops/Caddyfile.dev        # 별도 터미널 — listening on :443
caddy trust                                  # 1회 — system CA install
curl -k https://localhost/health             # {"ok":true,...}
$env:KLOSER_E2E_BASE_URL = 'https://localhost'
node test/phase_0_5_e2e.mjs                  # 16/16 PASS (Caddy variant)
Remove-Item Env:KLOSER_E2E_BASE_URL
```

(2) auto-detect 휴리스틱 (api.js §4)이 `https://localhost` 도착만으로 same-origin 모드를 켜는지 시각 smoke로도 확인 — `live.html`을 수정하지 않은 상태에서 데모 시퀀스 정상 재생.

(3) Phase 6+ CI 자동화 시점에 caddy를 build env에 추가하면 두 모드 e2e가 한 파이프라인에서 실행 가능. 본 step 범위 밖.

### 10. `cookie Secure` 동작 검증 — 환경 분리는 의도된 보수적 설계

(1) `authEnv.cookieSecure`는 env (`COOKIE_SECURE` 또는 `NODE_ENV=production`)로 결정. dev (`COOKIE_SECURE=false`, plaintext localhost)에선 cookie의 `Secure` flag가 꺼짐 — 그대로 두면 HTTP에서 cookie가 정상 송신.

(2) Caddy single-origin 모드를 띄우려면 `COOKIE_SECURE=true` (또는 `NODE_ENV=production`)로 별도 set 필요. **두 모드 동시 운영은 비권장** — 같은 server 인스턴스에 다른 cookie 정책을 양립시키면 cookie attribute 충돌 위험.

(3) 운영 환경 진입 시 `NODE_ENV=production`이 자동으로 `cookieSecure=true`를 강제 — Caddy + Fastify 페어가 prod 모드로 동작. 본 step에선 별도 변경 없음 (이미 step 3에서 깔린 분기).

---

## Phase 0.5 → Phase 1 인계 처리 현황

`PHASE_1_MASTER.md` §6의 7개 인계 항목:

- [x] **JWT auth** — Step 3 완료
- [x] **DOMPurify** — Step 4 완료
- [x] **`__liveSocket` 가드** — Step 4 완료
- [x] **`text_chunk` start_call 선행 강제** — Step 4 완료
- [x] **shared types 중복** — Phase 2로 명시 deferral (Step 4 finding §10)
- [x] **`FASTIFY_GUIDE.md` snake_case 동기화** — **Step 5 완료** (위 finding §8)
- [x] **PostgreSQL 부트스트랩** — Step 1 완료

**7/7 closed.** 

---

## 의도하지 않게 남긴 것 / 후속 작업

- **CI 자동화 — 두 origin 동시 e2e** — 현재는 split-origin과 Caddy variant 모두 수동 실행으로 검증. Phase 6+ infra 단계에서 caddy를 CI 환경에 추가하면 한 파이프라인에서 자동 회귀 가능.
- **운영 도메인 + Let's Encrypt** — `Caddyfile.prod` 분기는 Phase 6+ 운영 진입 시점에. dev Caddyfile은 그 출발점으로 그대로 활용.
- **Step 3 §7 `CommitAuthError` COMMIT 실패 시 client leak** — 미해결, Phase 2 시작 시점에.
- **Step 3 §8 `listActiveMembershipsAcrossOrgs` O(orgs) scan** — 미해결, Phase 2 customers CRUD 시점에 SECURITY DEFINER 함수로 교체.
- **Step 3 §9 `requireRole` style consistency** — 미해결, 사소함.
- **shared types** — Phase 2 진입 시 본격 도입.
- **DOMPurify CDN 의존성** — Phase 5 suggestion job 도입 시 self-host 검토.
- **`requireFreshRole` opt-in 헬퍼** — Phase 2 destructive endpoint 도입 시.

---

## Phase 2 진입 시 가장 먼저 봐야 할 것

1. `plan/PHASE_1_MASTER.md` §7 — Phase 1 종료 게이트 9개 모두 충족 확인.
2. `plan/PHASE_1_STEP_3_FINDINGS.md` §6~§9 — Phase 2의 destructive endpoint (customers CRUD) 도입 시 먼저 처리할 staleness / SECURITY DEFINER / `requireFreshRole` 항목들.
3. `plan/PHASE_1_STEP_4_FINDINGS.md` §10 — shared types 도입 패턴 결정 (bundler vs JSDoc 사본).
4. 본 finding §6 + §7 — Phase 4 (calls REST) 진입 시 socket 추가가 동일 origin contract를 따라야 함.
5. `server/README.md` "Run (Caddy single-origin variant)" — Phase 2 진입 후 dev 환경 안정성 확인 시점에 1회 수동 검증.

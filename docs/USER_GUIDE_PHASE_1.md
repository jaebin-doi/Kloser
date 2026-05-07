# Phase 1 사용자 가이드 (개발자용)

> 이 레포를 받아서 로컬에서 띄우고, 로그인해서 live demo (`platform/live.html`)를 확인하기 위한 공식 가이드입니다.
> 대상: **이 레포를 처음 받는 개발자**. 운영 배포는 아직 범위 밖이며 Phase 5+에서 다룹니다.
> 기준 시점: **Phase 1 Step 1~4 완료, Step 5 (Caddy reverse proxy) 진입 전**.

---

## 0. 이 가이드로 무엇을 할 수 있나

**할 수 있는 것 (Phase 1 시점)**:
- PostgreSQL (RLS 활성) + Redis를 docker compose로 띄움
- 자체 인증 흐름 동작 확인: signup / login / refresh / logout / `/me`
- `platform/live.html`에서 인증된 WebSocket으로 데모 통화 시퀀스 (greeting → sentiment → suggestion) 재생
- 4 종류의 시드 계정 (acme/beta × admin/employee)으로 멀티 organization isolation 확인
- 단위 테스트 37/37 + Playwright e2e 16/16 PASS 회귀

**아직 안 되는 것 (Phase 2+ 예정)**:
- 실제 STT / LLM 연동 (현재는 setTimeout 기반 fixture, Phase 5)
- customers / calls / dashboard CRUD (Phase 2~4)
- email verification, password reset, SSO (Phase 3)
- TLS / reverse proxy / production 배포 (Step 5 / Phase 6)
- 이메일 발송 (Phase 3)
- pgvector / RAG (Phase 5)

---

## 1. 사전 요구사항

| 도구 | 버전 | 확인 |
|---|---|---|
| Node.js | 20 LTS+ | `node --version` |
| npm | 10+ | `npm --version` |
| Docker Desktop | 4.x+ | `docker --version` |
| Git | 2.40+ | `git --version` |

OS는 Windows 11 / macOS / Linux 모두 지원 (이 가이드는 Windows 11 + bash/PowerShell 기준 명령을 동시 표기). Git Bash 또는 WSL을 쓰면 bash 예시 그대로, PowerShell이면 별도 표기를 사용.

Playwright e2e를 돌리려면 첫 실행 시 chromium 다운로드가 필요합니다 (`npx playwright install chromium`).

---

## 2. 환경 변수 셋업

루트 + server 두 군데에 `.env`가 필요합니다. 둘 다 gitignored.

```bash
# 1. project-root .env — docker-compose 변수 (postgres/redis user/pw/port)
cp .env.example .env

# 2. server/.env — Fastify 런타임 설정 (DB URL 두 종류 + JWT 시크릿 등)
cp server/.env.example server/.env
```

기본값 그대로 dev에서 바로 동작합니다. 핵심 변수만 정리:

| 변수 | 어디 | 의미 |
|---|---|---|
| `DATABASE_URL` | `server/.env` | 런타임 — `app` 역할 (NOSUPERUSER, NOBYPASSRLS). 모든 user-facing query는 이걸 사용 |
| `MIGRATE_DATABASE_URL` | `server/.env` | 마이그레이션·시드 전용 — `kloser` admin 역할. 런타임이 절대 쓰지 않도록 변수 분리 |
| `JWT_SECRET` | `server/.env` | HMAC 서명 키. dev 기본값은 32자 이상이라 부팅 통과. **prod에선 반드시 `openssl rand -base64 48`로 교체** |
| `STATIC_ORIGIN` | `server/.env` | CORS allow-list 첫 entry. 기본 `http://localhost:8765` |
| `COOKIE_SECURE` | `server/.env` | dev (plaintext)에선 `false`. HTTPS 뒤에선 `true` |
| `POSTGRES_HOST_PORT` | `.env` (root) | 호스트에 노출되는 postgres 포트. 기본 `5432`, 충돌 시 `15432` 등으로 override |

> **중요**: `JWT_SECRET`이 32자 미만이면 server가 부팅 시 fail-fast로 거부합니다 (`server/src/config/authEnv.ts`). 이건 의도된 가드.

---

## 3. Docker DB 부팅

Postgres 16 + Redis 7을 한 번에 띄움. 첫 실행 시 init script (`ops/postgres/init/01_app_role.sql`)가 자동으로 `app` 역할을 생성합니다.

```bash
docker compose -f ops/docker-compose.yml up -d
```

healthcheck 통과 확인:

```bash
docker compose -f ops/docker-compose.yml ps
# expect: postgres + redis 둘 다 (healthy)
```

> **기존 Docker volume이 있다면 init script가 재실행되지 않습니다** — `app` 역할이 빠질 수 있습니다. 그 경우 한 번만 수동 적용:
> ```bash
> docker exec -i kloser-dev-postgres-1 \
>   psql -U kloser -d kloser_dev -f /docker-entrypoint-initdb.d/01_app_role.sql
> ```

---

## 4. 마이그레이션 + 시드

```bash
cd server
npm install                      # 첫 실행만

npm run db:migrate:up            # 7 tables + RLS FORCE ENABLE + sessions enrichment
# expect: "Migrations complete!"  또는 이미 적용된 상태

npm run db:seed                  # 2 orgs × (admin + employee), Argon2id 해시
# expect: organizations count=2 OK / users count=4 OK / memberships count=4 OK
```

마이그레이션과 시드는 `MIGRATE_DATABASE_URL` (`kloser` admin)을 사용. wrapper script가 변수 누락 시 즉시 fail-fast.

---

## 5. server (API + WebSocket) 실행

```bash
# server/ 디렉토리에서
npm run dev
# 로그:
#   kloser-server listening on :3001
#   [ws/calls] namespace registered at /calls (handshake auth ON)
```

`tsx watch` 기반이라 src 변경 시 자동 재시작. 별도 터미널에서 `curl http://localhost:3001/health` → `{"ok":true,"version":"0.5-spike","uptimeSec":N}`.

---

## 6. 정적 페이지 서버 실행

별도 터미널에서 프로젝트 루트의 정적 파일을 :8765로 서빙.

```bash
# Python이 있으면
python -m http.server 8765

# 또는 Node 도구
npx http-server . -p 8765 --silent
```

이 시점에서 두 origin이 동시에 살아있어야 합니다:
- `http://localhost:3001` — Fastify (API + WS)
- `http://localhost:8765` — 정적 페이지

---

## 7. 로그인 흐름

### 7.1 시드 계정 4쌍

`server/seeds/0001_demo.sql`에 박힌 dev 시드 — 평문 password를 코멘트로 명시.

| 이메일 | 비밀번호 | 조직 / 역할 |
|---|---|---|
| `admin@acme.test` | `acme-admin-1234` | Acme / admin |
| `emp@acme.test` | `acme-emp-1234` | Acme / employee |
| `admin@beta.test` | `beta-admin-1234` | Beta / admin |
| `emp@beta.test` | `beta-emp-1234` | Beta / employee |

> dev 한정. prod 배포에선 시드 자체를 실행하지 않도록 운영 매뉴얼에서 분리.

### 7.2 login.html 접속

브라우저에서 <http://localhost:8765/platform/login.html>.

- localhost 가드 안에서만 노란 "dev seed 자격증명" 박스 + auto-fill 버튼이 노출됩니다 (prod 도메인엔 안 보임).
- "admin@acme.test 자동 채우기" 버튼으로 이메일·비밀번호 칸 채우기 → "로그인" 버튼.
- 다중 organization 사용자가 orgId 없이 로그인하면 400 + 가능한 org 목록이 응답에 박혀 있어 inline alert로 표시됨 (multi-org switcher는 Phase 2+).

### 7.3 live.html auth gate

login 성공 후 `window.location.replace('/platform/live.html')`로 자동 redirect. 직접 <http://localhost:8765/platform/live.html>로 접속해도 다음 흐름:

1. 페이지 boot 시 `kloserApi.getAccessToken()` → 메모리에 토큰 없음 (페이지 새로고침).
2. `kloserApi.refreshAccessToken()` 시도 — refresh cookie (`Path=/auth`)가 살아있으면 새 access token 받음.
3. 성공 시 `connectCallNamespace`가 그 토큰으로 WebSocket handshake.
4. cookie도 없으면 `loginRedirect()`가 `?returnUrl=/platform/live.html` 첨부해서 `login.html`로 보냄.

---

## 8. WebSocket 데모 시퀀스 확인

`live.html`이 인증된 WS로 연결되면 자동으로 시작:

| 시점 | 일어나는 일 |
|---|---|
| t=0 | "안녕하세요. 김민수입니다" — 첫 agent transcript |
| t=4.5s 간격 | customer / agent transcript 교차 출력 |
| t=5s, 14s, 23s, 36.5s | AI suggestion 카드 자동 갱신 |
| t=14s, 23s | sentiment 전환: `관심` → `망설임` |
| 사용자가 텍스트 입력 후 send | client → server `text_chunk` → server echo → 화면에 transcript 추가 + 우상단 `latency` 뱃지 갱신 |

> 이 모든 시퀀스는 **server-side fixture** (`server/src/fixtures/demo-call.ts`)가 setTimeout으로 emit. 실제 STT는 Phase 5에서 도입.

---

## 9. 검증 명령

전체 테스트 스위트를 한 번 돌려서 환경이 정상인지 확인:

```bash
# 1. Type check
npm --prefix server run typecheck
# expect: PASS (no output)

# 2. Server unit tests (37 cases: auth 19 + rls 7 + orgContext 3 + ws_auth 8)
npm --prefix server test
# expect: tests 37 / pass 37

# 3. End-to-end Playwright (login → live demo → auth-reject 2 cases)
node test/phase_0_5_e2e.mjs
# expect: 16 PASS lines + "E2E PASSED"
```

**3번이 통과하면 Phase 1 Step 1~4 전체가 정상 동작 중**입니다.

> e2e가 처음이면 chromium 다운로드 필요: `npx playwright install chromium`.

---

## 10. 흔한 문제 해결

### `JWT_SECRET must be at least 32 characters`
`server/.env`의 `JWT_SECRET` 값이 비어있거나 짧음. 기본 dev 값 (`dev-only-change-me-please-this-is-not-a-real-secret-aaaaaaaaaaaa`)을 그대로 사용.

### `ECONNREFUSED 127.0.0.1:5432` / `password authentication failed for user "app"`
1. `docker compose ps`로 postgres 컨테이너가 healthy인지 확인.
2. 컨테이너는 살아있는데 로그인 실패면 `app` 역할이 미생성 — `docs/USER_GUIDE_PHASE_1.md` §3 마지막 박스의 init-script 수동 실행.

### login은 되는데 live.html에서 무한히 login으로 redirect
- `COOKIE_SECURE=true`인 상태로 plaintext (`http://`)로 접속 중. dev에선 `false`로 두기.
- 또는 브라우저가 cookie를 거부 — DevTools Application → Cookies에서 `kloser_refresh` 존재 여부 확인.

### 401 `org_id_required` + availableOrgs 응답
이 user가 여러 org에 멤버십을 가짐. login 폼의 orgId 필드를 펼쳐 (또는 dev fixture에서 다른 계정 선택) 명시 입력.

### e2e가 latency 어서션에서 30초 timeout
ws.js의 `__liveSocket` 가드는 첫 socket만 핸들 점유. probe socket이 먼저 만들어지면 페이지 socket이 핸들을 못 가져감. 이건 Step 4 §1.8에서 수정됨 — 코드가 최신인지 확인.

### `npm run db:migrate:up`이 모두 성공해도 빈 DB
node-pg-migrate v7는 `-- Up`이 아닌 `-- Up Migration` 마커를 본다. Step 1 마이그레이션 (`1715000000000_init.sql`)에서 이 버그 1건 수정 — 코드 최신 시 안 만남.

### `pgmigrations` 테이블 권한 거부
`MIGRATE_DATABASE_URL` 대신 `DATABASE_URL`을 마이그레이션에 쓰려는 시도. `npm run db:migrate:*`은 admin URL을 사용해야 함 — wrapper script (`server/scripts/migrate.mjs`)가 자동 라우팅하므로 직접 `node-pg-migrate` 호출 대신 `npm run`을 사용.

### Playwright "browserType.launch: Executable doesn't exist"
chromium 미설치. `npx playwright install chromium`.

---

## 11. 다음 단계

| 다음 | 어디서 |
|---|---|
| Phase 1 전체 진행 상태 보기 | [`plan/PHASE_1_MASTER.md`](plan/PHASE_1_MASTER.md) |
| Step 4가 어떻게 끝났는지 (가장 최근) | [`plan/PHASE_1_STEP_4_FINDINGS.md`](plan/PHASE_1_STEP_4_FINDINGS.md) |
| Step 5 (Caddy reverse proxy) 계획 | [`plan/PHASE_1_STEP_5_REVERSE_PROXY.md`](plan/PHASE_1_STEP_5_REVERSE_PROXY.md) |
| 상위 백엔드 로드맵 | [`plan/BACKEND_PLAN.md`](plan/BACKEND_PLAN.md) |
| 인증 흐름 디테일 | [`plan/PHASE_1_STEP_3_AUTH_CORE.md`](plan/PHASE_1_STEP_3_AUTH_CORE.md) |
| WebSocket handshake 계약 | [`plan/PHASE_1_STEP_4_CLIENT_WIRING.md`](plan/PHASE_1_STEP_4_CLIENT_WIRING.md) §1.4 |

문제가 생기면 우선 본 §10을 확인하고, 그래도 안 풀리면 `plan/PHASE_1_STEP_*_FINDINGS.md`의 "의도하지 않게 남긴 것" 섹션을 참고하세요.

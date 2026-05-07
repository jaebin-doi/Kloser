# Phase 1 — 온프레미스 기반 + 자체 Auth 마스터 플랜

> **상위 계획**: `BACKEND_PLAN.md` v0.4 §8 Phase 1.
> **선행 단계**: Phase 0.5 (live stream spike) 완료 — `docs/plan/PHASE_0_5_LIVE_SPIKE.md`, `docs/plan/PHASE_0_5_FINDINGS.md`.
> **기간**: 1.5~2주 (sub-step 단위로 쪼갠다).
> **단계별로 진행**한다. 한 sub-step이 끝나야 다음으로 간다.

---

## 진행 상태 (Implementation Log)

> 이 섹션은 sub-step 진행 시 갱신된다.

- [x] **Step 1** — DB 인프라 (docker-compose + node-pg-migrate + 초기 스키마 + RLS FORCE ENABLE + seed) → `docs/plan/PHASE_1_STEP_1_DB_INFRA.md` · 결과 `docs/plan/PHASE_1_STEP_1_FINDINGS.md`. **완료** (2026-05-07 runtime 검증 통과)
- [x] **Step 2** — DB 연결/저장소 + RLS SET LOCAL + 격리 테스트 → `docs/plan/PHASE_1_STEP_2_RLS_CONTEXT.md` · 결과 `docs/plan/PHASE_1_STEP_2_FINDINGS.md`. **완료** (2026-05-07, 10/10 격리 + 14/14 e2e PASS)
- [x] **Step 3** — Auth 코어: Argon2id + sessions + signup/login/refresh/logout + GET /me + role middleware → `docs/plan/PHASE_1_STEP_3_AUTH_CORE.md` · 결과 `docs/plan/PHASE_1_STEP_3_FINDINGS.md`. **완료** (2026-05-07, 29/29 tests + 14/14 e2e PASS)
- [x] **Step 4** — `platform/api.js` + WebSocket handshake auth + `live.html` 통합 → `docs/plan/PHASE_1_STEP_4_CLIENT_WIRING.md` · 결과 `docs/plan/PHASE_1_STEP_4_FINDINGS.md`. **완료** (2026-05-07, 37/37 unit + 16/16 e2e PASS)
- [x] **Step 5** — Reverse proxy (Caddy `tls internal`) + 클라이언트 origin auto-detect + e2e parameterization + FASTIFY_GUIDE snake_case sync → `docs/plan/PHASE_1_STEP_5_REVERSE_PROXY.md` · 결과 `docs/plan/PHASE_1_STEP_5_FINDINGS.md`. **완료** (2026-05-07, 37/37 unit + 16/16 split-origin e2e + Caddy single-origin runtime 검증 (`caddy validate`, `curl -k https://localhost/health`, `KLOSER_E2E_BASE_URL=https://localhost` variant e2e 16/16) 모두 PASS).

각 step 완료 시 해당 step의 `PHASE_1_STEP_X_FINDINGS.md`도 작성한다.

---

## 0. 왜 Phase 1인가

Phase 0.5는 "실시간 파이프라인이 기술적으로 가능한가?"를 답했다. Phase 1은 그 위에 **제품을 운영할 수 있는 최소 기반**을 깐다.

핵심 산출물:

1. **데이터가 죽지 않는 환경** — PostgreSQL + 마이그레이션 도구 + 백업 가능성
2. **조직별 데이터가 새지 않는 보장** — RLS default-deny가 처음부터 켜진 채 시작
3. **로그인이 진짜로 동작** — 자체 Auth (JWT + refresh + sessions)
4. **클라이언트가 인증된 상태로 WS에 들어옴** — placeholder userId 폐기
5. **운영 진입 가능한 외형** — reverse proxy 초안

이걸 다 끝내고 나서야 Phase 2 (customers CRUD)로 들어갈 수 있다.

---

## 1. 범위 (Scope)

### 한다

**인프라**
- `ops/docker-compose.yml`: postgres 16, redis 7, app(server)
- node-pg-migrate 도입 + npm scripts (`migrate:up`, `migrate:down`, `seed`)
- `.env.example` + `server` 측 환경 변수 로딩
- Nginx 또는 Caddy reverse proxy 초안 (TLS는 self-signed 또는 미적용 dev 환경)

**스키마 (`migrations/0001_init.sql`)**
- organizations, users, memberships, sessions, teams, invitations, activity_log
- 모든 org-스코프 테이블에 `org_id uuid` + `ENABLE ROW LEVEL SECURITY` + default-deny 정책
- `pgcrypto` extension 활성화

**Auth**
- password Argon2id hash
- JWT access token (짧은 만료) + refresh token DB 저장 (rotation)
- session 테이블 (`refresh_token_hash`, ip, ua, expires_at, revoked_at)
- Fastify auth 플러그인 + 매 요청 시작 시 `SET LOCAL app.org_id` 트랜잭션 주입
- role 미들웨어 (`admin`, `manager`, `employee`, `viewer`)

**API**
- `POST /auth/signup`
- `POST /auth/login`
- `POST /auth/refresh`
- `POST /auth/logout`
- `GET /me`

**Client wiring**
- `platform/api.js` — fetch wrapper (CSRF/credentials 포함, error normalize)
- WebSocket handshake에서 token 검증 (placeholder `userId` 폐기)
- `live.html`이 로그인 가정 하에 동작 (또는 dev용 fixture login 화면)

**검증**
- RLS 격리 단위 테스트 — 다른 org JWT로 다른 org 데이터 접근 차단 (PR 머지 게이트)
- signup/login/refresh/logout e2e (Playwright 또는 Fastify inject)
- viewer write 차단 단위 테스트

### 안 한다 (Phase 2~6으로 미룸)

- customers CRUD (Phase 2)
- team/invitations/이메일 발송 (Phase 3)
- calls REST + dashboard (Phase 4)
- Clova STT, Claude/OpenAI suggestion job (Phase 5)
- newsletter, daily, integrations (Phase 6)
- 이메일 발송 인프라 (Phase 3에서 도입)
- HttpOnly cookie vs Bearer 정책 — Phase 1에서 결정하지만 양쪽 다 구현하지는 않음 (Step 3에서 결정)

이 경계가 흐려지면 Phase 1이 4주 넘는다. 흔들리면 멈추고 이 문서로 돌아온다.

---

## 2. 사전 결정 (Phase 1 시작 전 확정)

| 항목 | 결정 | 근거 |
|---|---|---|
| DB 버전 | **PostgreSQL 16** | BACKEND_PLAN §3.1 권장. RLS, jsonb, pgvector 호환 |
| 마이그레이션 도구 | **node-pg-migrate** | BACKEND_PLAN §3.1 1순위. SQL-first, RLS 정의 명시적 |
| password hash | **Argon2id** | BACKEND_PLAN §3.2 |
| JWT 라이브러리 | **`@fastify/jwt`** | Fastify 공식, 적은 의존성 |
| token 저장 방식 (Step 3 확정) | **access = Authorization Bearer (응답 body, 클라이언트 메모리)** + **refresh = HttpOnly cookie, `Path=/auth`, SameSite=Lax, prod Secure**. desktop도 동일 Bearer 사용. 자세한 근거는 `docs/plan/PHASE_1_STEP_3_AUTH_CORE.md` §1·§3. | BACKEND_PLAN §11.1 권장 + WS handshake에서 같은 access token 재사용 |
| ORM/Query layer | **pg + 직접 SQL + repository 패턴** | BACKEND_PLAN §3.1 — RLS·partial index를 명시적으로 다루기 위해 ORM 회피 |
| docker compose 위치 | `ops/docker-compose.yml` | BACKEND_PLAN §2 디렉토리 구조 |
| migration 위치 | `server/migrations/` | node-pg-migrate 기본 |
| 환경 변수 | `.env` (server에서 로딩, gitignored) + `.env.example` | dotenv 기반 |
| Reverse proxy | **Caddy** (Step 5 결정) | TLS 자동 갱신 단순함, dev에서도 self-signed 쉬움 |

---

## 3. Sub-step 분해 (실행 순서)

### Step 1 — DB 인프라 (1~2일)

**목표**: PostgreSQL이 docker compose로 뜨고, 초기 스키마가 마이그레이션되며, RLS default-deny가 켜진 상태로 seed 데이터가 들어간다.

**산출물**:
- `ops/docker-compose.yml`
- `server/migrations/0001_init.sql` (또는 .ts/.js)
- `server/seeds/0001_demo.sql` (또는 스크립트)
- `server/src/db/pool.ts` (pg Pool 설정)
- `.env.example`
- npm scripts: `migrate:up`, `migrate:down`, `migrate:create`, `seed`

**완료 기준**:
- `docker compose up -d postgres` → 정상 기동
- `npm run migrate:up` → 7개 테이블 + 모든 RLS 정책 적용
- `npm run seed` → org 2개 + 각 org당 admin 1명 + employee 1명 (총 4 user)
- raw SQL로 (RLS 우회) `SELECT count(*) FROM organizations` = 2

상세 계획: `docs/plan/PHASE_1_STEP_1_DB_INFRA.md`.

### Step 2 — 연결/저장소 + RLS SET LOCAL + 격리 테스트 (1~2일)

**목표**: Fastify가 트랜잭션마다 `SET LOCAL app.org_id`를 주입하고, repository 계층이 그 컨텍스트 위에서 동작하며, RLS가 실제로 다른 org 데이터를 차단한다.

**산출물**:
- `server/src/plugins/db.ts` — fastify decorator로 `app.pg` 노출
- `server/src/repositories/organizations.ts`, `users.ts`, `memberships.ts` (최소)
- `server/src/middleware/orgContext.ts` — `SET LOCAL app.org_id` 주입
- 테스트: `test/server/rls-isolation.test.ts` — org A 컨텍스트로 org B 데이터 접근 시 0 rows 또는 에러

**완료 기준**:
- 격리 테스트 통과 (PR 머지 게이트로 등록)
- 워커 컨텍스트에서도 동등 처리 (Step 2 끝에 worker stub 추가)

### Step 3 — Auth 코어 (3~4일)

**목표**: signup → login → 인증된 상태로 `/me` 조회 → refresh → logout이 모두 동작.

**산출물**:
- `server/src/plugins/auth.ts` — `@fastify/jwt` 등록 + `request.user` 데코레이터
- `server/src/services/auth.ts` — Argon2id, JWT 발급, refresh rotation
- `server/src/routes/auth.ts` — signup/login/refresh/logout
- `server/src/routes/me.ts` — GET /me
- `server/src/middleware/role.ts` — role-based 가드
- 테스트: signup/login/refresh/logout flow + role 가드 + RLS 격리 (다른 org JWT)

**완료 기준**:
- 모든 5개 endpoint가 200/4xx로 정확히 동작
- refresh token rotation 검증 (구 token은 무효)
- viewer가 write endpoint 호출 시 403

### Step 4 — Client wiring (2일)

**목표**: 브라우저가 로그인 후 `platform/live.html`이 인증된 WebSocket 연결로 들어가고, `userId` 쿼리 파라미터 폐기.

**산출물**:
- `platform/api.js` — fetch wrapper (`apiGet`, `apiPost`, error normalize, 메모리 토큰, single in-flight refresh, `API_BASE_URL` 분리). `kloserApi.login/logout/refreshAccessToken`은 wrapper 자동 분기와 분리.
- `platform/login.html` 신설 — dev 미니멀 로그인 폼 (returnUrl 흐름)
- `platform/live.html` — auth gate + `kloserWS.connectCallNamespace`가 token을 handshake에 전달 + DOMPurify로 transcript/suggestion sanitize
- `platform/ws.js` — `auth: { token }` slot, `connect_error` (3 코드: missing/expired/invalid) 시 refresh + reconnect, `__liveSocket` localhost-only 가드
- `server/src/ws/calls.ts` — handshake에서 JWT 검증, `userId` query 폐기, token-derived (user, orgId, membershipId, role)을 `socket.data.user`에 결합. **`registerCallsNamespace(io, app)` 시그니처로 변경**. `text_chunk` before `start_call` invariant. **WS 핸들러 안의 DB 호출 + `withOrgContext`/`SET LOCAL` 주입은 Phase 4 (calls REST + dashboard)에서 본격 도입** — Step 4 시점 fixture는 setTimeout 기반이라 DB 접근 없음.

**완료 기준**:
- 로그인 안 된 상태에서 live.html 열면 redirect 또는 명시적 에러
- 로그인 후 live.html에서 데모 흐름이 그대로 (Phase 0.5 e2e 16/16 회귀 가드 통과 — 기존 14 + auth reject 2)
- `__liveSocket` 핸들 localhost 계열에서만 노출
- WS handshake error 코드 계약 (3 + 1) 단위 테스트로 고정

### Step 5 — Reverse proxy + 운영 메모 (1일)

**목표**: Caddy가 단일 도메인 뒤에서 정적 + API + WS를 한 묶음으로 서빙하는 dev 구성을 만든다.

**산출물**:
- `ops/Caddyfile.dev` — `:443 → /platform/* (static), /api/* (Fastify), /socket.io/* (WS)` (self-signed)
- `server/README.md` 갱신 — Caddy 사용법
- `docs/plan/PHASE_1_STEP_5_FINDINGS.md` (간단)

**완료 기준**:
- Caddy 띄우고 https://localhost (또는 designated host)에서 모든 컴포넌트 작동
- Phase 0.5 e2e 변형(Caddy origin 사용)도 통과

---

## 4. 인증·세션 데이터 모델 (요약)

`BACKEND_PLAN.md` §5와 같음. Step 1에서 모두 생성:

```sql
organizations (
  id uuid PK,
  name text,
  plan text,
  settings jsonb,
  created_at, updated_at
)

users (
  id uuid PK,
  email citext UNIQUE,
  password_hash text,
  name text,
  avatar_url text,
  email_verified_at timestamptz,
  disabled_at timestamptz,
  created_at, updated_at
)

memberships (
  id uuid PK,
  org_id uuid FK organizations.id,
  user_id uuid FK users.id,
  role text CHECK (role IN ('admin','manager','employee','viewer')),
  team_id uuid FK teams.id,
  status text,
  UNIQUE (org_id, user_id),
  created_at, updated_at
)

sessions (
  id uuid PK,
  user_id uuid FK users.id,
  refresh_token_hash text,
  user_agent text,
  ip inet,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at
)

teams (
  id uuid PK,
  org_id uuid FK,
  name text,
  manager_id uuid FK users.id,
  created_at, updated_at
)

invitations (
  id uuid PK,
  org_id uuid FK,
  email citext,
  role text,
  token_hash text,
  expires_at timestamptz,
  accepted_at timestamptz,
  created_at
)

activity_log (
  id uuid PK,
  org_id uuid FK,
  user_id uuid FK NULL,
  action text,
  target_type text,
  target_id uuid,
  payload jsonb,
  created_at
)
```

org-스코프 테이블 (`memberships`, `teams`, `invitations`, `activity_log`)은 모두 RLS ENABLE + default-deny + USING/WITH CHECK 정책.

`users`는 org-스코프가 아님 (한 user가 여러 org에 멤버십 가능 — multi-tenant). `users` 자체에는 RLS 안 걸고, `memberships`로 join할 때 org 격리 보장.

---

## 5. 위험·미정 — Phase 2로 넘기는 것

| 항목 | Phase 1에서의 처리 | Phase 2 이후 |
|---|---|---|
| email verification | 미구현 (`email_verified_at` 컬럼만 추가) | Phase 3 (invitations와 같이 SMTP 도입 시) |
| password reset | 미구현 | Phase 3 |
| SSO/SAML | 미구현 | Enterprise 단계, Keycloak 검토 |
| audit_log 자동 작성 | activity_log 테이블만 만들고, 기록 hook은 Step 3 끝에 시작 | 본격 운영 hook은 Phase 2 customers CRUD 시 |
| 백업/PITR | docker compose volume + 일일 dump 스크립트 메모만 | 운영 진입 시 본격 PITR |
| pgvector | extension 활성화 안 함 | Phase 5 (knowledge_base RAG) |
| 모니터링 | 미구현 | Enterprise 단계 |

---

## 6. Phase 0.5 인계 사항 (반영해야 할 것)

`docs/plan/PHASE_0_5_FINDINGS.md`에서 Phase 1으로 넘긴 항목:

1. **shared types 중복** — ~~Step 4~~ → **Phase 2 customers CRUD 시점으로 deferral** (2026-05-07 결정, `PHASE_1_STEP_4_CLIENT_WIRING.md` §2 참고). 이유: 브라우저 측 정적 HTML이 build step 없어서 TS/zod 직접 import 불가, JSDoc은 enforcement 없음. Phase 2에서 bundler 도입 또는 server/types + browser JSDoc 사본 패턴으로 결정.
2. **PostgreSQL + RLS 부트스트랩** — Step 1~2의 핵심
3. **JWT auth 미들웨어** — Step 3
4. **DOMPurify + suggestion sanitize** — Step 4 (`live.html` 손댈 때 같이)
5. **`FASTIFY_GUIDE.md` §8 snake_case 동기화** — Step 5 또는 Step 4 마무리 시점에
6. **`__liveSocket` 핸들 제거 또는 dev 가드** — Step 4
7. **`text_chunk` start_call 선행 강제** — Step 4 (auth 검증과 같이)

---

## 7. 완료 기준 (Phase 1 전체 — go/no-go gate)

다음을 모두 만족하면 Phase 1 종료, Phase 2 (customers CRUD) 착수.

- [x] `docker compose up`으로 postgres + redis가 뜨고 health 정상
- [x] `npm run migrate:up` → 7개 테이블 + 모든 RLS 정책 적용
- [x] `npm run seed` → 2개 org seed 완료
- [x] signup/login/refresh/logout/me 5개 endpoint 200 응답
- [x] RLS 격리 테스트 통과 (다른 org 데이터 접근 0 rows 또는 에러)
- [x] viewer가 write endpoint 호출 시 403
- [x] live.html이 인증된 WS 연결로 데모 흐름 재생 (Phase 0.5 e2e 회귀 통과)
- [x] Caddy reverse proxy 동작 — `ops/Caddyfile.dev` + runtime 검증 모두 통과 (`caddy validate`, `curl -k https://localhost/health`, Caddy variant e2e `KLOSER_E2E_BASE_URL=https://localhost` 16/16 PASS)
- [x] Phase 0.5 인계 7개 항목 모두 처리됨 — Step 5 §6 snake_case 동기화로 마지막 1건 close
- [x] `docs/plan/PHASE_1_STEP_1_FINDINGS.md` ~ `PHASE_1_STEP_5_FINDINGS.md` 작성됨

**Phase 1 완료** (2026-05-07). Phase 2 (customers CRUD) 착수 가능.

---

## 8. 한 줄 요약

> **1.5~2주 동안, 5개 sub-step으로 PostgreSQL/RLS/Auth/클라 통합/Reverse proxy를 차례로 깔아서, 인증된 상태로 live.html이 동작하고 조직 격리가 처음부터 보장되는 기반을 만든다.**

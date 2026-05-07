# Phase 1 Step 2 — DB 연결/저장소 + RLS SET LOCAL + 격리 테스트

> **상위 계획**: `docs/PHASE_1_MASTER.md` §3 Step 2.
> **선행**: Step 1 (DB 인프라) 완료 — `docs/PHASE_1_STEP_1_DB_INFRA.md`, `docs/PHASE_1_STEP_1_FINDINGS.md`.
> **기간**: 1~2일.

---

## 진행 상태

- [ ] 1. `app` role 부트스트랩 (`ops/postgres/init/01_app_role.sql`) + docker-compose에 init 마운트 + 기존 volume 재실행 절차 문서화
- [ ] 2. 환경 변수 분리: `DATABASE_URL`(=app) / `MIGRATE_DATABASE_URL`(=admin), `.env.example` 양쪽 갱신
- [ ] 3. `node-pg-migrate` + `run-seed.mjs`가 `MIGRATE_DATABASE_URL`을 쓰도록 변경
- [ ] 4. `server.ts` 상단에 `import "dotenv/config"` (findings §7)
- [ ] 5. `pool.ts` — `DATABASE_URL`(app) 기반, dev fallback 제거
- [ ] 6. `server/src/plugins/db.ts` — fastify decorator `app.pg` + `app.withOrgContext(orgId, fn)` 트랜잭션 헬퍼
- [ ] 7. `server/src/middleware/orgContext.ts` — preHandler hook (dev-only `X-Org-Id` 헤더 + UUID 형식 검증, 실패 시 400/401)
- [ ] 8. 최소 repository 3개: `memberships.ts`(getById, listForCurrentOrg) / `organizations.ts`(getCurrentOrg만) / `users.ts`(listForCurrentOrg, getByIdInCurrentOrg — JOIN 가드). 무가드 list/getById 금지
- [ ] 9. `server/test/{orgContext,rls_isolation}.test.mjs` (`tsx --test`) — middleware 3 케이스 + RLS 격리/repository 7 케이스. (계획 시 `test/server/`로 적었으나 root `test/`에 server 의존성용 node_modules가 없어 `server/test/`로 이동 — findings에 기록)
- [ ] 10. `npm test` 스크립트 등록 + e2e 회귀 (Phase 0.5 e2e 그대로 통과)
- [ ] 11. `docs/PHASE_1_STEP_2_FINDINGS.md` 작성

---

## 0. 목적

Step 1은 schema와 정책을 깔았다. Step 2는 **그 위에서 application이 안전하게 query를 돌릴 수 있는 통로**를 만든다.

핵심은 두 개:

1. **owner와 runtime을 분리** — 마이그레이션은 admin role(`kloser`, BYPASSRLS), runtime은 일반 `app` role(NOSUPERUSER NOBYPASSRLS). RLS가 dev에서도 진짜로 작동.
2. **트랜잭션 단위로 `SET LOCAL app.org_id` 주입** — 매 요청이 자기 org의 컨텍스트로만 query. 미들웨어는 헬퍼를 부르고, 헬퍼가 BEGIN/COMMIT을 책임진다.

격리 테스트가 PR 머지 게이트로 등록되면 그 다음부터는 누가 RLS를 깨뜨려도 CI가 잡는다.

---

## 1. 범위

### 한다

- `app` role 도입 + cluster bootstrap (init 스크립트 + 기존 volume 재실행 절차)
- env 분리 (`DATABASE_URL` / `MIGRATE_DATABASE_URL`) + 도구 측 적용
- `pool.ts` 업데이트 (app role pool, prod fallback 제거)
- fastify db plugin (`app.pg`, `app.withOrgContext`)
- orgContext 미들웨어 (Step 3 전까지 dev 헤더 fallback)
- repository 3개:
  - `memberships` — `getById`, `listForCurrentOrg` (RLS가 자동 격리)
  - `organizations` — `getCurrentOrg`만 (RLS 미적용 테이블이라 `list()` / 무가드 `getById()` 금지)
  - `users` — `listForCurrentOrg`, `getByIdInCurrentOrg` (memberships JOIN 가드)
- 격리 테스트 (`tsx --test`) + `npm test` 스크립트 (§10)
- Phase 0.5 e2e 회귀 통과

### 안 한다 (Step 3~ 으로 넘김)

- Auth/JWT/login/signup (Step 3)
- password hashing (Step 3에서 Argon2id로 seed 재처리)
- worker 컨텍스트의 SET LOCAL — Step 2 끝에 worker stub만 추가, 실제 worker job은 Phase 4
- HTTP route 추가 (Step 3~4)
- WebSocket handshake auth (Step 4)
- 다른 테이블 repository (Phase 2)

---

## 2. 사전 결정

| 항목 | 결정 | 근거 |
|---|---|---|
| app role 이름 | `app` (LOGIN, NOSUPERUSER NOBYPASSRLS) | 짧고 PG 컨벤션. 격리는 DB 단위 GRANT로 충분 |
| URL 명명 | `DATABASE_URL` = app role / `MIGRATE_DATABASE_URL` = admin role | 안전한 기본값. `process.env.DATABASE_URL`을 무심코 쓰면 RLS 적용된 권한이 됨. admin은 의도적으로만 꺼내 씀 |
| role 생성 위치 | `ops/postgres/init/01_app_role.sql` (Docker `/docker-entrypoint-initdb.d/` 마운트) | role은 cluster-wide 객체. migration에 넣으면 down/redo에서 꼬임 |
| 기존 volume 처리 | `docker exec ... psql -f /docker-entrypoint-initdb.d/01_app_role.sql` 수동 1회 (init은 신규 volume에서만 자동 실행) | PostgreSQL Docker image 표준 동작 |
| GRANT 전략 | role 생성 시 현 테이블에 SELECT/INSERT/UPDATE/DELETE + `ALTER DEFAULT PRIVILEGES`로 미래 테이블 자동 부여 | 새 마이그레이션마다 GRANT 잊을 위험 제거 |
| 트랜잭션 패턴 | `BEGIN; SELECT set_config('app.org_id', $1, true); ... COMMIT/ROLLBACK` | `set_config(..., true)`는 SET LOCAL의 파라미터화 형식 — SQL 인젝션 차단. LOCAL은 트랜잭션 범위라 connection pool 재사용 누수 위험 ↓. `SET app.org_id`는 금지 |
| 헬퍼 시그니처 | `withOrgContext(orgId: string, fn: (client: PoolClient) => Promise<T>): Promise<T>` | 콜백 패턴, finally에서 client.release |
| orgId 출처 (Step 2 한정) | `request.headers['x-org-id']` + UUID 정규식 검증, 실패 시 400. 헤더 부재 시 401. dev only — Step 3에서 JWT user.orgId로 교체 | invalid 값을 RLS 함수 캐스팅 단계까지 흘리면 5xx로 새 나옴 — 미들웨어 입구에서 끊음 |
| organizations/users repository | RLS 미적용 테이블이므로 `list()`/`getById()` 무가드 노출 금지. 모두 memberships join 또는 GUC 명시 사용 | Step 1 findings §2 — user/org 격리는 application 책임 |
| 격리 테스트 러너 | `tsx --test` | node 단독 `--test`는 .ts source import 시 ERR_UNKNOWN_FILE_EXTENSION. tsx loader가 통과시킴 |
| 테스트 파일 위치 | `server/test/*.test.mjs` (실행 시 변경됨, 계획 §9 참고) | server 의존성을 import하므로 server/node_modules 가까이에 배치해야 module 해상이 깨끗 |

---

## 3. 디렉토리 변화

```text
kloser/
├── ops/
│   ├── docker-compose.yml          # 🟡 init 디렉토리 마운트 추가
│   └── postgres/
│       └── init/
│           └── 01_app_role.sql     # 🆕 app role + GRANT + DEFAULT PRIVILEGES
├── server/
│   ├── package.json                # 🟡 npm scripts (test, migrate가 MIGRATE_DATABASE_URL 사용)
│   ├── .env.example                # 🟡 두 URL 모두 포함
│   ├── scripts/
│   │   ├── migrate.mjs             # 🆕 wrapper: dotenv → MIGRATE_DATABASE_URL 주입 후 node-pg-migrate spawn
│   │   └── run-seed.mjs            # 🟡 MIGRATE_DATABASE_URL 사용
│   ├── src/
│   │   ├── server.ts               # 🟡 import "dotenv/config" (최상단)
│   │   ├── db/
│   │   │   └── pool.ts             # 🟡 dev fallback 제거, app role 풀
│   │   ├── plugins/
│   │   │   └── db.ts               # 🆕 fastify plugin: app.pg + app.withOrgContext
│   │   ├── middleware/
│   │   │   └── orgContext.ts       # 🆕 preHandler — X-Org-Id + UUID 검증
│   │   └── repositories/
│   │       ├── memberships.ts      # 🆕 getById, listForCurrentOrg
│   │       ├── organizations.ts    # 🆕 getCurrentOrg only (no list/getById)
│   │       └── users.ts            # 🆕 listForCurrentOrg, getByIdInCurrentOrg (JOIN 가드)
│   └── test/                       # 🆕 server-deps에 의존하는 unit/integration 테스트
│       ├── orgContext.test.mjs     # 🆕 tsx --test
│       └── rls_isolation.test.mjs  # 🆕 tsx --test
├── test/                           # root — server import 안 하는 e2e만 (Phase 0.5 e2e 등)
└── .env.example                    # 🟡 ops 공통값 그대로 (변경 없음)
```

---

## 4. 단계별 작업

### 1. `ops/postgres/init/01_app_role.sql` + compose 마운트

**전체 idempotent**: 기존 volume 위에 수동 재실행해도 실패하면 안 됨.

```sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app') THEN
    CREATE ROLE app LOGIN PASSWORD 'app_dev' NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE kloser_dev TO app;
GRANT USAGE   ON SCHEMA public TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app;
GRANT USAGE,  SELECT                  ON ALL SEQUENCES IN SCHEMA public TO app;

-- 미래에 kloser(=마이그레이션 owner)가 생성하는 테이블/시퀀스에도 자동 적용.
-- FOR ROLE을 명시하지 않으면 "현재 세션이 만드는 객체"로만 한정되어 버려서 의도와 어긋남.
ALTER DEFAULT PRIVILEGES FOR ROLE kloser IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app;
ALTER DEFAULT PRIVILEGES FOR ROLE kloser IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app;
```

`ops/docker-compose.yml`의 postgres volumes에 추가:

```yaml
- ./postgres/init:/docker-entrypoint-initdb.d:ro
```

검증:
- 신규 volume: `docker compose down -v && docker compose up -d` → init 자동 실행
- 기존 volume: `docker exec -i kloser-dev-postgres-1 psql -U kloser -d kloser_dev -f /docker-entrypoint-initdb.d/01_app_role.sql` (마운트는 들어가 있으므로 컨테이너 안에서 경로 참조 가능)
- `psql "postgres://app:app_dev@localhost:5432/kloser_dev" -c "SELECT 1"` 성공
- `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname='app'` → `app | f | f`

### 2. 환경 변수 분리

루트 `.env.example`은 변경 없음 (ops 공통값만).

`server/.env.example`:

```bash
# 런타임 (앱이 실제로 쓰는 connection — RLS가 적용되는 권한)
DATABASE_URL=postgres://app:app_dev@localhost:5432/kloser_dev

# 마이그레이션·시드 전용 (admin 권한, 의도적으로만 꺼내 씀)
MIGRATE_DATABASE_URL=postgres://kloser:kloser_dev@localhost:5432/kloser_dev
```

검증:
- 두 URL 모두 `psql`로 직접 접속 가능

### 3. `node-pg-migrate` + `run-seed.mjs` 가 admin URL 사용

`server/package.json`의 `db:migrate:*` 스크립트에 `DATABASE_URL=$MIGRATE_DATABASE_URL` 주입 또는 node-pg-migrate가 인식하는 `--database-url` 명시적 전달. 가장 호환성 좋은 방법은 cross-env 없이 inline 설정 가능한 wrapper 스크립트(`scripts/migrate.mjs`)를 작성해서 dotenv 로드 후 `MIGRATE_DATABASE_URL`을 `DATABASE_URL`로 매핑한 뒤 node-pg-migrate를 spawn.

`run-seed.mjs`도 동일하게 `MIGRATE_DATABASE_URL`을 우선 읽도록 변경 (시드는 RLS 우회가 필요한 작업이므로 admin이어야 함).

검증:
- `npm run db:migrate:up` → admin으로 접속, "No migrations to run"
- `npm run db:seed` → admin으로 접속, count 검증 통과

### 4. `server.ts` 상단 dotenv

```ts
import "dotenv/config";
```

import 그래프 가장 위에 위치 (다른 모든 import보다 먼저). `pool.ts`가 module load 시 `process.env.DATABASE_URL`을 읽으므로 순서가 중요.

검증:
- `npm run dev` (또는 `npx tsx src/server.ts`) 부팅 시 `.env` 미존재 → 명시적 throw, `.env` 존재 → 정상 boot
- `npm run typecheck` 통과

### 5. `pool.ts` 업데이트

- `DATABASE_URL` 환경변수 미설정 시 dev fallback 제거 (실수로 admin 떨어지는 걸 막음)
- `pool.on("error", ...)` 유지

```ts
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required (app role connection)");
}
```

검증:
- env 안 set한 채로 import → 명시적 throw

### 6. `server/src/plugins/db.ts` — fastify decorator + 헬퍼

```ts
// 의사코드
app.decorate("pg", pool);
app.decorate("withOrgContext", async (orgId, fn) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(()=>{});
    throw err;
  } finally {
    client.release();
  }
});
```

- `set_config(..., true)`는 `SET LOCAL`과 등가이지만 prepared-statement 형식으로 안전하게 GUC 주입 (SQL injection 회피).

검증:
- 단위 테스트: 같은 client로 트랜잭션 내부에서 `current_setting('app.org_id')`이 매개변수와 일치, 트랜잭션 종료 후엔 reset

### 7. `server/src/middleware/orgContext.ts`

fastify preHandler hook. 동작:

1. `request.headers['x-org-id']` 읽기. 없으면 → **401**.
2. UUID 형식 검증 (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` 또는 `node:crypto`의 `validate`). 잘못된 형식이면 → **400**. 검증 안 하면 RLS 함수의 `::uuid` 캐스팅에서 5xx로 떨어짐.
3. `request.orgId`에 담음.

실제 query는 route handler가 `app.withOrgContext(request.orgId, async (client) => { ... })`로 감싸서 실행. 즉 미들웨어는 검출·검증만 하고, 트랜잭션 진입은 라우트가 명시 호출.

이 분리의 이유: 모든 요청이 트랜잭션을 열 필요 없음 (health check, static asset 등). 라우트가 명시 호출.

검증:
- 헤더 없음 → 401
- 헤더 있으나 형식 깨짐 (`xxx`, `'';drop`, 임의 문자열) → 400
- 정상 UUID → request.orgId 채워짐, 라우트 도달

### 8. Repository 3개

⚠️ **중요**: `organizations`와 `users`는 RLS 미적용 테이블이다. app role이 일반 `SELECT * FROM users`를 돌리면 **다른 org의 사용자까지 다 보인다**. 따라서 두 테이블의 list는 **membership join을 통한 scoped 조회만** 노출한다.

`memberships.ts`:
- `getById(client, id)` — RLS가 자동 격리
- `listForCurrentOrg(client)` — RLS가 자동 격리, 단순 `SELECT FROM memberships`

`organizations.ts`:
- `getCurrentOrg(client)` — 현재 GUC org_id에 해당하는 단 1개 row만. `SELECT * FROM organizations WHERE id = current_app_org_id()`로 application-level 가드.
- ❌ `list()`는 만들지 않음

`users.ts`:
- `listForCurrentOrg(client)` — `SELECT u.* FROM users u JOIN memberships m ON m.user_id = u.id` (memberships의 RLS가 자동으로 같은 org만 필터)
- `getByIdInCurrentOrg(client, userId)` — 같은 패턴, JOIN 가드. 단순 `SELECT FROM users WHERE id=...`는 금지.
- ❌ 무가드 `getById`, `list`는 만들지 않음

이 분리는 Step 1 findings §2의 "user/organization은 application-level 격리 책임"을 코드에 박는 것.

검증:
- repository 단위 테스트는 격리 테스트(§9)에서 통합으로 검증
- 모든 organizations/users 함수가 memberships에 의존하거나 GUC를 명시 사용하는지 코드 리뷰

### 9. RLS 격리 테스트 (`server/test/rls_isolation.test.mjs`)

`tsx --test` 사용. seed의 2개 org (acme=`1111...`, beta=`2222...`)를 활용. 트랜잭션은 각 케이스가 `withOrgContext()`로 독립 분리.

`app` role로만 의미 있음 (admin role은 BYPASSRLS라 false-positive). DATABASE_URL=app이 강제됨.

- A: GUC 없이 `SELECT FROM memberships` (bare pool) → 0 rows (default-deny)
- B: `withOrgContext(ORG_ACME, ...)` → 2 rows, 모두 `org_id = ORG_ACME`
- C: `withOrgContext(ORG_BETA, ...)` → 2 rows, 모두 `org_id = ORG_BETA`
- D: `withOrgContext(ORG_ACME, ...)` 안에서 `INSERT INTO memberships (org_id=ORG_BETA, ...)` → SQLSTATE `42501` (RLS 정책 위반)
- E: `organizations.getCurrentOrg(client)` — 두 컨텍스트 모두 자신의 org 반환
- F: `users.listForCurrentOrg(client)` — acme 컨텍스트는 admin@acme/emp@acme, beta 컨텍스트는 admin@beta/emp@beta
- G: `users.getByIdInCurrentOrg(client, acme_admin_id)` — acme에서 visible, beta에서 null

(`server/test/orgContext.test.mjs`는 별도 파일, middleware의 401/400/200 동작 3 케이스.)

검증:
- `cd server && npx tsx --test test/rls_isolation.test.mjs` → 7/7 PASS (no GUC, ACME 2 rows, BETA 2 rows, WITH CHECK violation, getCurrentOrg, listForCurrentOrg, getByIdInCurrentOrg)

### 10. `npm test` 등록 + e2e 회귀

테스트 파일은 **`server/test/`**에 둔다 (계획 시 root `test/server/`였으나 fastify·pg·dotenv가 server/node_modules에만 있고 root `test/`에서 import 불가하여 이동). server-deps에 의존하는 모든 unit/integration 테스트는 `server/test/`로, 브라우저 e2e처럼 server 코드를 import 안 하는 테스트는 root `test/` 그대로.

`server/package.json`에 추가 (Step 2 §10에서):

```json
"test": "tsx --test test/*.test.mjs"
```

`tsx --test`는 node test runner를 통과시키되 .ts source import를 처리. node 단독 `--test`만으로는 test의 src/*.ts import가 ERR_UNKNOWN_FILE_EXTENSION으로 실패.

기존 `test/phase_0_5_e2e.mjs`도 회귀로 한 번 돌려서 DB 도입이 기존 흐름을 안 깨는지 확인 (Step 1에서 14/14 PASS 기록 있음). 이건 별도 명령 (`node test/phase_0_5_e2e.mjs`, root 디렉토리 기준).

검증:
- `npm --prefix server test` → 10/10 PASS (orgContext 3 + rls_isolation 7)
- `node test/phase_0_5_e2e.mjs` → 14/14 PASS

### 11. `docs/PHASE_1_STEP_2_FINDINGS.md`

Step 2에서 발견한 함정·결정·미해결 사항 인계.

---

## 5. 위험·미정

| 항목 | 처리 |
|---|---|
| 기존 volume에 `01_app_role.sql` 자동 실행 안 됨 | findings + Step 2 사전 절차에 수동 실행 명시 |
| `MIGRATE_DATABASE_URL` 누락 시 마이그레이션 동작 모호 | wrapper 스크립트가 명시적 throw |
| dev `X-Org-Id` 헤더가 prod에 누수 | Step 3 시작 시 미들웨어 내에서 prod 환경 가드 + JWT 우선 |
| `withOrgContext` 안에서 nested 호출 | 본 step 범위 밖. 한 요청 = 한 트랜잭션 가정 |
| organizations/users 테이블의 RLS 미적용 | repository에서 무가드 노출 금지(§4-8). 미래에 누가 `SELECT * FROM users` 무심코 추가 → Step 2 finding으로 코드 리뷰 가이드 명시 |
| 격리 테스트가 seed 데이터에 의존 | 테스트 시작 전 seed 재실행 또는 fixture 별도 분리 — 본 step에서는 seed 의존 (간단함 우선) |
| `pool.ts`의 prod fallback 제거 | env 누락 시 즉시 실패. dev에서도 `.env` 빠뜨리면 server.ts boot 실패 — `import "dotenv/config"`로 보장 |
| `set_config(..., true)`가 트랜잭션 내부에서만 valid | autocommit 환경에서 호출 시 무효. 헬퍼가 BEGIN을 강제하므로 안전 |

---

## 6. 완료 기준 (Step 2 — go/no-go)

- [ ] `app` role 존재 (`rolsuper=f, rolbypassrls=f`), 기존·신규 volume 양쪽에서 재현 가능
- [ ] `DATABASE_URL`(app), `MIGRATE_DATABASE_URL`(admin) 분리, 마이그레이션·시드는 admin URL로만 동작
- [ ] `npm run db:migrate:up`, `npm run db:seed` 회귀 통과 (admin URL 경로)
- [ ] `app.withOrgContext`가 트랜잭션 + GUC 주입 + ROLLBACK on error 모두 처리
- [ ] `cd server && npx tsx --test test/*.test.mjs` 10/10 PASS — orgContext (missing/malformed/valid) + rls_isolation (no GUC, ACME, BETA, WITH CHECK violation, getCurrentOrg, listForCurrentOrg, getByIdInCurrentOrg)
- [ ] Phase 0.5 e2e 회귀 14/14 PASS
- [ ] `npm run typecheck` 통과
- [ ] `docs/PHASE_1_STEP_2_FINDINGS.md` 작성

---

## 7. 한 줄 요약

> **1~2일 동안, app role을 분리해서 RLS가 진짜로 작동하게 만들고, 매 트랜잭션마다 SET LOCAL app.org_id를 주입하는 헬퍼와 미들웨어를 깔고, 4-case 격리 테스트가 PR 머지 게이트로 굳어진다.**

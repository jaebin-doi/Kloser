# Phase 1 Step 1 — DB 인프라

> **상위 계획**: `docs/plan/phase-1/PHASE_1_MASTER.md` §3 Step 1.
> **선행**: Phase 0.5 (`server/` Fastify+Socket.io 부트스트랩 완료).
> **기간**: 1~2일.

---

## 진행 상태

- [x] 1. `ops/docker-compose.yml` (postgres 16-alpine + redis 7-alpine + healthcheck + named volumes)
- [x] 2. `.env.example` (루트, ops 공통값) + `server/.env.example`
- [x] 3. node-pg-migrate 도입 + npm scripts (`db:migrate:up/down/create/redo`, `db:seed`)
- [x] 4. `server/migrations/1715000000000_init.sql` — 7개 테이블 + 인덱스 + RLS default-deny FORCE ENABLE + `current_app_org_id()` 헬퍼 + 4개 정책
- [x] 5. `server/seeds/0001_demo.sql` + `server/scripts/run-seed.mjs` — 2 orgs × (admin + employee)
- [x] 6. `server/src/db/pool.ts` — pg Pool (Step 2에서 plugin으로 wire)
- [x] 7. 정적 검증: typecheck OK, run-seed.mjs syntax OK, node-pg-migrate가 파일 인식 (dry-run 시 connection만 실패 = 환경 이슈)
- [x] 8. **Runtime 검증 완료** (2026-05-07): docker compose up → migrate → seed → RLS 검증까지 통과. 진행 중 마이그레이션 파일의 `-- Up` / `-- Down` 마커가 node-pg-migrate v7가 인식하는 `-- Up Migration` / `-- Down Migration`이 아니어서 첫 실행이 CREATE+DROP을 한 번에 실행한 버그 1건 발견·수정. 자세한 결과와 finding은 `docs/plan/phase-1/PHASE_1_STEP_1_FINDINGS.md` §1, §8.

---

## 0. 목적

Phase 0.5는 메모리 기반이었다. Step 1은 데이터가 죽지 않는 환경 + 조직 격리가 처음부터 켜진 환경을 만든다. 이 step은 **app 코드 거의 안 건드리고 DB 인프라만**.

Step 2부터 이 위에서 `SET LOCAL app.org_id` 주입하고, repository를 짜고, RLS 격리 테스트를 PR 머지 게이트로 등록한다.

---

## 1. 범위

### 한다

- docker compose: postgres 16 + redis 7 (둘 다 healthcheck)
- node-pg-migrate 도입
- migration 0001: 7개 테이블 (`organizations`, `users`, `memberships`, `sessions`, `teams`, `invitations`, `activity_log`)
- 모든 org-스코프 테이블 (`memberships`, `teams`, `invitations`, `activity_log`)에 RLS default-deny ENABLE + USING/WITH CHECK 정책
- `pgcrypto`, `citext` extension 활성화
- seed: 2 orgs, 각 org당 admin 1 + employee 1 (총 4 users + 4 memberships)
- `.env.example`로 환경 변수 합의
- pg Pool 정의 (Step 2까지 import만, 실제 query는 다음 step)

### 안 한다 (Step 2~5으로 넘김)

- 실제 query 코드, repository 패턴 (Step 2)
- Auth 미들웨어, JWT, password 검증 (Step 3)
- HTTP route, WebSocket handshake auth (Step 3~4)
- pgvector (Phase 5)
- 백업/PITR/모니터링 (운영 진입 시)
- 다중 인스턴스/replication (Enterprise 단계)

---

## 2. 사전 결정

| 항목 | 결정 | 근거 |
|---|---|---|
| postgres image | `postgres:16-alpine` | LTS, 작은 이미지, pgcrypto 기본 포함 |
| redis image | `redis:7-alpine` | BACKEND_PLAN §3.4. Phase 4부터 본격 사용 |
| compose 위치 | `ops/docker-compose.yml` | BACKEND_PLAN §2 디렉토리 구조 |
| 호스트 포트 매핑 | postgres 5432, redis 6379 (정직하게 노출, dev only) | 충돌 시 `.env`로 덮어쓰기 |
| 데이터 영속 | named volume `kloser_pgdata`, `kloser_redisdata` | volume이 있어야 컨테이너 재시작에 데이터 유지 |
| migration 도구 | **node-pg-migrate** + raw SQL | RLS, partial index를 SQL로 명시 |
| migration 위치 | `server/migrations/` | tool 기본 |
| migration 작성 형식 | **`.sql` 파일** (TS API 안 씀) | RLS 정책 가독성 우선 |
| seed 위치 | `server/seeds/` | 별도 디렉토리, migration과 분리 |
| password hash in seed | `bcrypt`로 미리 해시한 값을 박아둠 (Argon2id는 Step 3에서 도입) | seed는 데이터만, hash 알고리즘 실제 검증은 Step 3 |
| 시간/타임존 | `timestamptz` 일관 | UTC 저장, 클라에서 변환 |
| ID | `uuid` (`gen_random_uuid()` from pgcrypto) | BACKEND_PLAN §5 |

---

## 3. 디렉토리 변화

```text
kloser/
├── ops/                            # 🆕
│   ├── docker-compose.yml          # 🆕 postgres + redis (+ optional pgadmin)
│   └── postgres/
│       └── init/                   # 🆕 (예약, 본 step에서는 비어있음)
├── server/
│   ├── package.json                # 🟡 scripts 추가
│   ├── .env.example                # 🆕
│   ├── migrations/                 # 🆕 node-pg-migrate 디폴트
│   │   └── 0001_init.sql           # 🆕
│   ├── seeds/                      # 🆕
│   │   └── 0001_demo.sql           # 🆕
│   └── src/
│       └── db/
│           └── pool.ts             # 🆕 (Step 2에서 본격 사용)
└── .env.example                    # 🆕 (루트, ops 공통값)
```

`server/.env`, `.env`는 `.gitignore` 적용 (이미 `node_modules` 등 같이).

---

## 4. 단계별 작업

### 1. `ops/docker-compose.yml`

postgres + redis. 둘 다 healthcheck. Named volume.

검증:
- `docker compose -f ops/docker-compose.yml up -d`
- `docker compose -f ops/docker-compose.yml ps` → 두 서비스 모두 `(healthy)`
- `docker exec ops-postgres-1 psql -U kloser -d kloser_dev -c "SELECT 1"` → `1`

### 2. 환경 변수

루트 `.env.example` (ops 공통값) + `server/.env.example` (server 측).

관건: `DATABASE_URL`이 docker compose 안에서 (compose network)와 호스트에서 (`localhost:5432`) 둘 다 동작해야 한다. 본 spike에서는 호스트에서 직접 마이그레이션을 실행하므로 `localhost:5432` 기준으로 박아둔다.

### 3. node-pg-migrate

`server/package.json`에 추가:
- dev dependency: `node-pg-migrate`, `@types/pg` (없다면)
- runtime dependency: `pg`
- npm scripts:
  - `db:migrate:up` → `node-pg-migrate up`
  - `db:migrate:down` → `node-pg-migrate down`
  - `db:migrate:create` → `node-pg-migrate create -j sql`
  - `db:seed` → `psql ${DATABASE_URL} -f seeds/0001_demo.sql`
- `node-pg-migrate` 설정은 환경 변수 또는 `.node-pg-migraterc` (이번엔 환경 변수만)

검증:
- `npm run db:migrate:create test` → `migrations/<timestamp>_test.sql` 생성됨 (검증 후 삭제)

### 4. `server/migrations/0001_init.sql`

`pgcrypto`, `citext` 활성화 → 7개 테이블 → 인덱스 → RLS ENABLE + 정책.

핵심 주의:
- `users` 테이블에는 RLS **안 건다** (multi-tenant: 한 user → 여러 org membership 가능). 격리는 `memberships` 조인으로.
- `sessions`도 user-스코프 (org 격리 아님). RLS 안 검.
- `organizations`도 RLS 미적용 (사용자가 자기가 속한 org만 보지만, 그 격리는 application-level membership 검사로).
- 나머지 (`memberships`, `teams`, `invitations`, `activity_log`) 4개 테이블만 default-deny RLS + `USING (org_id = current_setting('app.org_id')::uuid)`.

`memberships`는 user-side에서도 보고 싶을 수 있다 ("내가 속한 org 목록"). 이건 Step 2 repository 설계 시 결정. 본 step에서는 일단 org_id 기반 RLS 적용하고, "self-membership lookup" 정책은 Step 2~3에서 추가/완화.

검증:
- `npm run db:migrate:up` → 모든 테이블 + 정책 생성
- `psql ... -c "\d+ memberships"` → RLS enabled 확인
- `psql ... -c "SELECT relname FROM pg_class WHERE relrowsecurity"` → 4개 테이블 확인

### 5. `server/seeds/0001_demo.sql`

2 org × (1 admin + 1 employee) = 4 user + 4 membership. password는 dev-only 평문 (e.g. `demo1234`)을 bcrypt 해시로 박아둔다 (Step 3에서 Argon2id로 재처리).

⚠️ Argon2id로 미리 해시할 수도 있지만, Step 3에서 password hashing 라이브러리를 도입하므로 일관성 위해 Step 3 시작 시 seed를 갱신할 수 있다. 그때까지는 bcrypt 또는 SHA-256 placeholder 박아둔다는 메모를 seed 안에 박는다.

검증:
- `npm run db:seed` → 4 users, 4 memberships 행 생성
- `psql ... -c "SELECT count(*) FROM users"` → `4`
- `psql ... -c "SELECT count(*) FROM memberships"` → `4`

### 6. `server/src/db/pool.ts`

pg Pool 설정만. import는 안 함 (아직 server.ts가 사용하지 않음). Step 2에서 plugin으로 wire.

```ts
import { Pool } from "pg";
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // dev 기본값. Step 2에서 환경별 override.
});
```

검증:
- `npm run typecheck` 통과

### 7. 통합 검증

- `docker compose down -v` → 깨끗히 시작
- `docker compose up -d`
- `npm run db:migrate:up`
- `npm run db:seed`
- 직접 SQL로 행 수 확인 (위 4, 5의 검증 단계)
- e2e 회귀: Phase 0.5 e2e 그대로 통과 (DB 추가가 기존 흐름을 깨지 않는지)

---

## 5. 위험·미정

| 항목 | 처리 |
|---|---|
| docker가 없는 환경 | dev 표준은 docker compose. Windows에서 docker desktop 또는 podman compose 가정. 이 step에서는 docker 가정. |
| 호스트 5432 이미 다른 postgres 점유 | `.env`로 `POSTGRES_HOST_PORT=15432` 등 override 가능하게 변수화 |
| `users` RLS 미적용 | 위 Step 4 주의 참고. Step 2에서 `memberships` 기반 격리 검증 추가 |
| bcrypt seed → Argon2id 재해시 | Step 3 시작 시 seed 재실행 + Argon2id로 갱신 (또는 application code에서 first-login 시 rehash) |
| pgvector | Phase 5에서 활성화. 본 step에서는 install 안 함 |
| RLS 정책의 `current_setting('app.org_id')` 미설정 시 | default-deny이므로 0 rows. 명시적 에러는 Step 2 SET LOCAL 미들웨어에서 처리 |

---

## 6. 완료 기준 (Step 1 — go/no-go)

- [x] `docker compose up`으로 postgres + redis 모두 healthy — 2026-05-07 통과 (`(healthy) (healthy)`)
- [x] `npm run db:migrate:up` 후 `pg_class` 조회 시 4개 테이블 `relrowsecurity = true` — memberships/teams/invitations/activity_log 모두 `t/t`, users/organizations/sessions은 `f/f`
- [x] `npm run db:seed` 후 organizations=2, users=4, memberships=4 — 시드 스크립트가 자체 검증
- [x] `npm run typecheck` 통과
- [x] Phase 0.5 e2e (`test/phase_0_5_e2e.mjs`) 회귀 통과 (DB 인프라 추가가 기존 흐름을 깨지 않음) — 14/14 PASS, RTT 1ms
- [x] `docs/plan/phase-1/PHASE_1_STEP_1_FINDINGS.md` 작성됨
- [x] (보너스) 비-superuser role(`rls_probe`)로 RLS 격리 동작 확인 — GUC 없음 시 0 rows, GUC=org1 시 해당 org의 2 memberships만 가시화

**현재 상태**: Step 1 완료. Step 2 진입 가능.

---

## 7. 한 줄 요약

> **1~2일 동안, app 코드는 거의 안 건드리고 PostgreSQL+Redis가 docker로 뜨고, 7개 테이블이 RLS default-deny와 함께 생성되며, 2개 org seed가 들어가는 데까지만.**

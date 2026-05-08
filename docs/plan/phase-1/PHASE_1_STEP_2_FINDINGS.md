# Phase 1 Step 2 Findings — DB 연결/저장소 + RLS SET LOCAL + 격리 테스트

> Audience: Phase 1 Step 3 작성자 (또는 미래의 나).
> Format: each finding has **(1) 관찰**, **(2) Step 3 또는 이후로의 의미**.

## 결론

Step 2 **완료** (2026-05-07). app role 분리 + 트랜잭션 컨텍스트 헬퍼 + middleware + repository + 격리 테스트까지 한 사이클로 마무리.

- `npm --prefix server run typecheck` PASS
- `npm --prefix server test` 10/10 PASS (orgContext 3 + rls_isolation 7)
- `node test/phase_0_5_e2e.mjs` 14/14 PASS (DB 도입이 Phase 0.5 흐름을 깨지 않음)
- `cd server && npm run db:migrate:up` / `db:seed` 정상 (admin URL 경로)

`PHASE_1_STEP_2_RLS_CONTEXT.md` §6의 완료 기준 항목 모두 충족.

---

## 발견 사항

### 1. DATABASE_URL = app role / MIGRATE_DATABASE_URL = admin role — 안전한 기본값

(1) Step 1까지는 `DATABASE_URL`이 admin role(`kloser`, BYPASSRLS)을 가리켰다. 그 상태에서 server가 import만 해도 RLS가 모두 우회되는 구조였다. Step 2에서 두 URL로 분리:
- `DATABASE_URL` → 런타임 `app` role (NOSUPERUSER NOBYPASSRLS)
- `MIGRATE_DATABASE_URL` → 마이그레이션·시드 전용 admin role
즉 어떤 코드가 무심코 `process.env.DATABASE_URL`을 읽어도 RLS-적용된 권한으로 떨어진다.

(2) Step 3 이후 모든 새 dependency·라이브러리·worker는 `DATABASE_URL`만 가정해야 한다. admin이 필요한 작업(스키마 변경, 시드, 데이터 백필)은 명시적으로 `MIGRATE_DATABASE_URL`을 읽어 별도 connection을 만들어야 한다 — pool에 섞으면 안 됨.

### 2. `app` role 부트스트랩은 마이그레이션이 아니라 docker init 스크립트

(1) Role은 PostgreSQL cluster-wide 객체이지 DB-scoped이 아니다. node-pg-migrate down/redo로 관리하면 다른 DB까지 영향이 가거나 마이그레이션 실패 시 partial state가 남는다. 그래서 `ops/postgres/init/01_app_role.sql`로 분리 + docker-compose에서 `/docker-entrypoint-initdb.d/`로 마운트.

(2) PostgreSQL Docker image의 init script는 **신규 volume 첫 생성 시에만** 자동 실행. 기존 volume 위에서는 수동 1회 실행 필요:
```bash
docker exec -i kloser-dev-postgres-1 \
  psql -U kloser -d kloser_dev \
  -f /docker-entrypoint-initdb.d/01_app_role.sql
```
파일은 `DO $$ BEGIN IF NOT EXISTS (...) ... END $$;` + `GRANT` + `ALTER DEFAULT PRIVILEGES`로 멱등하게 짜여있어 몇 번 돌려도 안전.

(3) **dev-only 패스워드 (`app_dev`)**가 하드코딩됨. prod에서는 secret store에서 주입 + DATABASE_URL을 deploy env에서 빌드해야 함. init 파일 헤더에 명시.

### 3. 마이그레이션·시드는 `MIGRATE_DATABASE_URL` 누락 시 fail-fast

(1) `server/scripts/migrate.mjs`(node-pg-migrate wrapper)와 `server/scripts/run-seed.mjs` 모두 시작 시 `MIGRATE_DATABASE_URL`을 읽고, 없으면 명시적 메시지와 함께 `process.exit(2)`. 이전엔 `DATABASE_URL`로 fallback했었으나 이제는 침묵 fallback 없음.

(2) `migrate.mjs`는 `process.execPath`로 `node_modules/node-pg-migrate/bin/node-pg-migrate.js`를 직접 spawn (Windows의 `.cmd` 우회 + `shell:true` DEP0190 회피). 자식 프로세스 env에만 `DATABASE_URL=MIGRATE_DATABASE_URL`로 override해서 부모 셸의 값에 영향 없음.

(3) Step 3 또는 이후에 추가될 새 admin 작업(예: rehash 스크립트, 백필 스크립트)은 같은 패턴(`MIGRATE_DATABASE_URL` 명시 + 미존재 시 throw)을 따라야 한다.

### 4. `withOrgContext(orgId, fn)` — 트랜잭션 단위 RLS 컨텍스트

(1) `server/src/plugins/db.ts`의 `app.withOrgContext`는 다음 시퀀스:
```
client = pool.connect()
BEGIN
SELECT set_config('app.org_id', $1, true)
fn(client)
COMMIT  (성공 시)
ROLLBACK (실패 시)
client.release()
```
호출자는 `app.withOrgContext(orgId, async (client) => { ... })`만 쓰면 RLS 컨텍스트가 자동으로 깔리고 정리된다.

(2) Routes는 `app.pg`(bare pool)에 직접 query 보내지 말고 항상 `app.withOrgContext`를 통과해야 한다. `app.pg`는 onClose 시 pool.end 용도와 관리 작업용으로만 노출.

(3) ROLLBACK 자체가 throw하는 케이스 (이미 죽은 connection 등) — `client.release(rollbackErr)`로 connection을 폐기. 정상 ROLLBACK 후엔 plain `client.release()`로 풀에 반환. 의심스러운 connection이 다른 요청에 재사용되는 상황 차단.

### 5. `set_config('app.org_id', $1, true)` — SET LOCAL의 파라미터화 형식

(1) `SET LOCAL app.org_id = '<value>'` 직접 박으면 SQL injection 면에 취약 (orgId가 사용자 입력에서 왔을 때). `set_config(name, value, is_local=true)`은 prepared statement 매개변수로 값이 들어가므로 인젝션 차단.

(2) 세 번째 인자 `true` = "is_local" — 트랜잭션 끝나면 자동 reset. 세션-level GUC 누수 방지. 헬퍼가 항상 `BEGIN`을 강제해서 set_config가 트랜잭션 안에서 실행되도록 보장.

(3) Step 3에서 auth middleware가 JWT의 `orgId`를 그대로 set_config에 넘겨도 안전. JWT 검증 통과한 값이라도 trust boundary는 DB까지 끌고 가지 말고 매개변수화해야 한다는 원칙.

### 6. `X-Org-Id` 헤더는 dev-only — Step 3 진입 시 JWT로 교체

(1) `server/src/middleware/orgContext.ts`는 현재 `request.headers['x-org-id']`에서 orgId를 꺼낸다. UUID 정규식 검증 (실패 시 400) + 헤더 부재 (401)까지 처리. 하지만 **클라이언트가 임의의 org를 사칭할 수 있다** — Step 3 auth가 들어와야 진짜 격리.

(2) Step 3 액션 아이템:
- JWT 검증 미들웨어 등록 (Argon2id 검증한 user 발급) — `request.user`에 `{ id, orgId, role }` 적재
- orgContext middleware의 헤더 분기를 **prod에서는 비활성화** + JWT의 `request.user.orgId` 사용. dev에서는 헤더 fallback 유지(테스트 편의)
- JWT의 `orgId`도 UUID 검증 통과 후 사용 (서명 통과해도 페이로드는 한 번 더 validate)
- WS handshake도 같은 패턴 (Step 4)

(3) prod 환경에서 X-Org-Id 헤더가 도착하면 명시적으로 reject (`request.user`로만 결정)하는 가드를 Step 3에서 추가. 이게 없으면 누군가 prod에 헤더 던져서 cross-org 공격 가능.

### 7. `users` / `organizations`는 RLS 없음 — repository에서 JOIN 가드 필수

(1) Step 1 findings §2 그대로: 한 user가 여러 org에 멤버십 가능해서 `users` 테이블에 단일 `org_id` 칼럼이 없음. `organizations`도 마찬가지로 다른 user-side에서 보임. RLS는 못 걸고 application-level 격리.

(2) Step 2에서 한 일:
- `users.ts`에 `list()` / 무가드 `getById()` **금지**. 대신 `listForCurrentOrg(client)` / `getByIdInCurrentOrg(client, userId)` — 둘 다 `JOIN memberships`로 자동 격리 (memberships RLS가 효력)
- `organizations.ts`에 `list()` 금지. 대신 `getCurrentOrg(client)` 하나만 — `WHERE id = current_app_org_id()`로 GUC와 일치하는 row 1개만
- 미래에 누가 무심코 `SELECT * FROM users WHERE id = $1`을 추가하면 cross-org 노출. 코드 리뷰에서 잡거나, 더 엄격하게 가려면 **app role의 `users`·`organizations` 테이블 SELECT 권한을 view 경유로만 허용**하는 옵션도 있음 (Step 3+에서 검토).

(3) `users.ts`의 SELECT 절에서 `password_hash`도 명시적으로 제외. Auth(Step 3)는 별도 `getByEmailWithPasswordHash` 함수를 만들어 password 검증 시점에만 hash를 노출 (defense in depth).

### 8. 테스트는 `server/test/`에 둠 — root `test/`에 server 의존성 없음

(1) 계획서는 root `test/server/`로 적었으나 root에는 fastify·pg·dotenv 등 server-deps가 깔린 node_modules가 없다. 거기 둔 .mjs 파일이 `import "fastify"` 하면 ERR_MODULE_NOT_FOUND. 그래서 `server/test/`로 이동.

(2) 분리 원칙:
- `server/test/` — server의 src를 import하거나 server-deps에 의존하는 unit/integration 테스트
- root `test/` — server 코드 import 없는 e2e만 (Phase 0.5 e2e처럼 HTTP·browser 기반)

(3) **`tsx --test` 채택**: node 단독 `--test`만 쓰면 .ts source import 시 ERR_UNKNOWN_FILE_EXTENSION. tsx loader가 통과시킴. `npm --prefix server test` 한 번이면 전부 돌아감.

### 9. Phase 0.5 e2e 회귀 — 14/14 PASS

(1) Step 2 끝에 다시 한번 확인. 절차:
```bash
# terminal 1
npx http-server . -p 8765 --silent
# terminal 2
npm --prefix server run dev
# terminal 3
node test/phase_0_5_e2e.mjs
```
DB 플러그인 추가가 기존 라이브 흐름(transcript / sentiment / suggestion / latency / WS handshake)을 깨지 않음.

(2) 단, `npm --prefix server run dev`는 이제 **`.env` 존재 + DB 컨테이너 healthy**가 사전 조건. `pool.ts`가 module load 시 `DATABASE_URL`을 강제하므로 .env 없으면 boot 실패.

(3) Step 3 이후엔 e2e 자체에 auth flow가 들어가서 Phase 0.5 e2e는 placeholder userId가 사라지면서 자연스럽게 deprecated. 회귀는 새 auth e2e로 대체.

### 10. Step 3 진입 전 주의사항 (체크리스트)

- [ ] Docker 컨테이너 healthy + `app` role 존재 확인 (재기동했다면 init 자동 실행 — 첫 volume일 때만)
- [ ] `npm --prefix server test` 10/10 — Step 3가 RLS를 깨지 않는다는 baseline
- [ ] **`X-Org-Id` 헤더 fallback을 prod에서는 차단**. Step 3 첫 작업 — prod env일 때 미들웨어가 헤더를 무시하고 `request.user.orgId`만 사용
- [ ] JWT의 `orgId`도 UUID 정규식 한 번 더 통과시킬 것 (서명 통과 ≠ payload trust)
- [ ] `MIGRATE_DATABASE_URL`을 사용하는 새 admin 스크립트(rehash 등)는 `migrate.mjs`와 동일한 fail-fast 패턴 따를 것
- [ ] `users` 테이블에 password 관련 query 추가 시 `getByEmailWithPasswordHash` 같은 별도 함수로 분리 (현재 `users.ts`의 type에는 password_hash가 없음)
- [ ] seed의 password_hash는 placeholder. Step 3 첫 작업으로 Argon2id로 재해시 (또는 first-login rehash)
- [ ] worker 컨텍스트도 `withOrgContext` 같은 패턴 필요 — Phase 4부터 본격, Step 3에선 stub만

---

## Phase 0.5 → Phase 1 인계 처리 현황

`PHASE_1_MASTER.md` §6의 7개 인계 항목 중 본 step에서 직접 처리한 것: 없음 (Step 2는 DB 인프라·격리에 집중).

남은 인계는 Step 3~5에서:
- shared types 중복 — Step 4
- JWT auth — **Step 3**
- DOMPurify — Step 4
- FASTIFY_GUIDE.md snake_case 동기화 — Step 5
- `__liveSocket` 가드 — Step 4
- `text_chunk` start_call 선행 강제 — Step 4

---

## 의도하지 않게 남긴 것 / 후속 작업

- `app_dev` 패스워드 하드코딩 — prod에서 secret store로 교체 필요 (init 파일 헤더에 명시함)
- pgmigrations에 대한 app role REVOKE — write+read 모두 차단했지만, 미래에 새 시스템 테이블 추가 시 같은 review 필요
- `withOrgContext` 안에서 nested 호출 미지원 — 본 step 범위 밖, 한 요청 = 한 트랜잭션 가정. 필요해지면 savepoint 도입
- 테스트가 seed 데이터(2 org × 2 user)에 의존 — fixture 분리는 Phase 2~ 에서 검토
- `__liveSocket` dev 핸들 — Step 4

---

## Step 3 진입 시 가장 먼저 봐야 할 것

1. `docs/plan/phase-1/PHASE_1_STEP_2_RLS_CONTEXT.md` §1 + 본 findings §6 — `X-Org-Id` 헤더의 prod 차단 가드를 가장 먼저
2. `server/src/middleware/auth.ts` 신설 — `@fastify/jwt` 등록 + `request.user` 데코레이터
3. `server/src/services/auth.ts` — Argon2id, JWT 발급, refresh rotation
4. `server/src/routes/auth.ts` — signup / login / refresh / logout + GET /me
5. seed의 password placeholder 갱신 (Argon2id로)
6. `server/test/auth.test.mjs` — login flow + refresh rotation + role guard

# Phase 1 Step 1 Findings — DB 인프라

> Audience: Phase 1 Step 2 작성자 (또는 미래의 나).
> Format: each finding has **(1) 관찰**, **(2) Step 2 또는 이후로의 의미**.

## 결론

Step 1은 **코드/스크립트 측 완료**, **runtime 검증 3건은 docker 환경 대기**. 정적 검증 (typecheck, syntax, migration 파일 인식, Phase 0.5 e2e 회귀)은 모두 통과.

`PHASE_1_STEP_1_DB_INFRA.md` §6의 6개 완료 기준 중 5개 충족, 1개 (`docker compose up` runtime)는 docker 미설치로 보류.

---

## 발견 사항

### 1. Windows 호스트에 Docker가 설치되어 있지 않음 — Step 1 runtime 검증 보류

(1) `docker --version` → command not found, `Docker Desktop`도 미설치 (`/c/Program Files/Docker/...` 부재). 따라서 `docker compose up`으로 postgres+redis를 실제로 띄우는 검증을 이번 spike(자율 작업) 중에 진행하지 못했다. 사용자 자리 비운 동안 임의로 Docker Desktop을 설치하지 않는 게 안전하다고 판단.

(2) **사용자가 돌아왔을 때 진행할 수동 검증 절차**:

```bash
# 1. Docker Desktop 설치 (Windows 11) — https://docs.docker.com/desktop/install/windows-install/
#    또는 Rancher Desktop / Podman Desktop도 호환됨 (compose v2 지원)

# 2. 환경 변수
cp .env.example .env                     # 프로젝트 루트
cp server/.env.example server/.env       # 서버

# 3. 인프라 기동
docker compose -f ops/docker-compose.yml up -d
docker compose -f ops/docker-compose.yml ps
# expect: postgres (healthy), redis (healthy)

# 4. 마이그레이션
cd server
npm run db:migrate:up
# expect: "Migrations complete!" + 1 migration applied

# 5. 시드
npm run db:seed
# expect:
#   seed: applied seeds/0001_demo.sql
#   seed: organizations count=2 OK
#   seed: users count=4 OK
#   seed: memberships count=4 OK

# 6. RLS 적용 확인 (호스트 psql 또는 docker exec)
docker exec kloser-dev-postgres-1 psql -U kloser -d kloser_dev -c \
  "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('memberships','teams','invitations','activity_log','users','organizations','sessions') ORDER BY relname"
# expect: 4개 테이블 (memberships, teams, invitations, activity_log)에 t/t,
#         users/organizations/sessions는 f/f
```

(3) Step 2 진입 전 위 검증을 한 번 돌려서 RLS가 실제로 default-deny 작동하는지 확인 필수. 안 그러면 Step 2의 SET LOCAL 미들웨어가 무용지물이라는 사실을 늦게 발견할 수 있다.

### 2. `users`와 `organizations`에 RLS를 안 건 이유 — 명시적으로 기록

(1) 보통 "보안 = 모든 테이블 RLS"로 단순하게 가지만, Kloser는 multi-tenant 멤버십이 있다 (한 user가 여러 org에 admin/employee로 속할 수 있음). `users`에 `org_id` 단일 칼럼이 없으니 RLS가 자연스럽게 안 걸린다. `organizations`도 마찬가지 — 한 org를 여러 user가 보지만 user 입장에서 보면 "내가 속한 org들"이라 application-level membership 검사로 격리.

(2) Step 2~3에서 확인할 것:
- `GET /me`에서 `users` + `memberships` 조인 시 application 코드가 user 본인 row만 select하는지
- 다른 user의 정보를 노출할 수 있는 endpoint(예: `/team/members`)가 `memberships` (RLS 적용)를 join 키로 쓰는지
- 즉, RLS는 org-수준 격리를 책임지고, user-수준 격리(자기 자신만 보기 등)는 application이 책임지는 분담

### 3. seed의 password_hash는 placeholder — Step 3에서 재처리 필요

(1) `seeds/0001_demo.sql`의 password_hash는 형태만 bcrypt 같은 placeholder 문자열. 실제로는 어떤 password로도 검증되지 않는다 (Step 3에서 Argon2id 도입 시 직접 해시).

(2) Step 3 진입 시 첫 작업:
- argon2 또는 `@node-rs/argon2` 라이브러리 추가
- 평문 password 4개를 정의 (admin@acme.test → `acme-admin-1234` 등)
- 그 4개를 Argon2id로 해시
- seed SQL 갱신 또는 별도 `seeds/0002_argon2_passwords.sql` 추가
- `npm run db:seed` 재실행

### 4. node-pg-migrate의 파일명 timestamp

(1) 본 step의 첫 마이그레이션은 `1715000000000_init.sql`로 임의 timestamp(2024-05-06 09:33 UTC경)를 박았다. 일반적으로 `npm run db:migrate:create init`이 현재 시각으로 생성하는데, "초기 init"임을 알아보기 좋게 의도적으로 숫자로 뒷자리 0 패딩한 timestamp를 선택. **앞으로는 `db:migrate:create <name>` 명령으로 만들면 자동으로 정확한 timestamp가 들어간다.**

(2) Step 2부터는 일반 명령으로 새 마이그레이션 생성. 본 init만 예외.

### 5. RLS의 `FORCE ROW LEVEL SECURITY`가 핵심

(1) PostgreSQL의 RLS는 기본적으로 테이블 owner는 정책을 우회한다. 마이그레이션 사용자가 곧 테이블 owner이므로, 그냥 `ENABLE ROW LEVEL SECURITY`만으로는 정책이 평소에는 안 적용되고 (테스트 시) 어이없게 SELECT 다 보임. **`FORCE ROW LEVEL SECURITY`까지 붙여야 owner도 정책을 따른다.**

(2) Step 2 격리 테스트 작성 시 이 사실을 모르면 "왜 RLS가 안 막지?" 디버그에 시간을 잃기 쉽다. 본 마이그레이션은 4개 테이블 모두 FORCE 해놨다.

(3) Phase 1 이후 구조: 운영용 `app` role을 별도로 만들고 (`CREATE ROLE app NOLOGIN`), connection을 그 role로 해서 owner와 분리하는 게 더 안전. 본 step에서는 단순화.

### 6. `current_app_org_id()` 함수 vs 인라인 GUC 캐스팅

(1) 정책에 `org_id = current_setting('app.org_id')::uuid`를 직접 박을 수도 있지만, GUC가 비어있을 때 `''::uuid` 캐스팅 에러가 난다. `NULLIF(..., '')::uuid` 패턴을 헬퍼 함수로 빼서 중복 제거 + 에러 회피.

(2) Step 2 미들웨어가 `SET LOCAL app.org_id = ''`으로 명시적 reset할 때도 안전하게 0 rows로 떨어진다.

### 7. dotenv는 Step 1에서 도입했지만 server.ts는 아직 안 씀

(1) `run-seed.mjs`만 dotenv를 부른다. `server.ts`는 환경 변수를 직접 `process.env`에서 읽기 때문에, 셸이 export하지 않으면 `DATABASE_URL`이 없다. Step 2에서 server.ts도 dotenv 호출하도록 변경 필요.

(2) Step 2 첫 작업: `server.ts` 상단에 `import "dotenv/config"` 추가. 이걸 잊으면 db plugin이 등록될 때 `pool.ts`에 박아둔 dev 기본값으로 떨어져서 production-ready가 아님.

---

## Phase 0.5 → Phase 1 인계 처리 현황

`PHASE_1_MASTER.md` §6의 7개 인계 항목 중 본 step에서 직접 처리한 것:

- [x] **`server/src/__test_client.ts` 삭제** — Phase 0.5 throwaway, Phase 1 kickoff 권장 시점에 삭제.
- [ ] shared types 중복 — Step 4에서
- [ ] PostgreSQL 부트스트랩 — Step 1 (본 step에서 코드 완료, runtime 보류)
- [ ] JWT auth — Step 3
- [ ] DOMPurify — Step 4
- [ ] FASTIFY_GUIDE.md snake_case 동기화 — Step 5
- [ ] `__liveSocket` 가드 — Step 4
- [ ] `text_chunk` start_call 선행 강제 — Step 4

---

## 의도하지 않게 남긴 것

- `server/migrations/1715000000000_init.sql` 파일명의 임의 timestamp — 앞으로는 `db:migrate:create`로 자동 생성된 것을 사용
- `seeds/0001_demo.sql`의 password_hash placeholder — Step 3에서 재처리

---

## Step 2 진입 시 가장 먼저 봐야 할 것

1. Docker 환경 갖춰졌는지 확인 (위 §1 절차)
2. 위 §7대로 `server.ts`에 `import "dotenv/config"` 추가
3. `server/src/plugins/db.ts` 작성 — `app.pg` decorator + 트랜잭션 helper
4. `SET LOCAL app.org_id` 미들웨어
5. RLS 격리 테스트를 PR 머지 게이트로 등록

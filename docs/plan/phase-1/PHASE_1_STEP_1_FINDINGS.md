# Phase 1 Step 1 Findings — DB 인프라

> Audience: Phase 1 Step 2 작성자 (또는 미래의 나).
> Format: each finding has **(1) 관찰**, **(2) Step 2 또는 이후로의 의미**.

## 결론

Step 1 **완료** (2026-05-07). 정적 검증과 runtime 검증 모두 통과:

- docker compose: postgres + redis `(healthy)`
- 마이그레이션: 7개 테이블 + 4개 RLS 정책 + `current_app_org_id()` 함수 적용
- 시드: organizations=2, users=4, memberships=4
- RLS flag: 4개 org-scoped 테이블 `relrowsecurity=t / relforcerowsecurity=t`, 비-org 3개는 `f/f`
- 격리 sanity check: 비-superuser role(`rls_probe`)로 GUC 없음 시 0 rows, GUC=org1 시 2 rows 확인

진행 중 발견·수정한 코드 버그 1건은 §8을 참고. Step 2 진입 가능.

---

## 발견 사항

### 1. Windows 호스트 Docker 설치 후 runtime 검증 — 통과 (2026-05-07)

(1) 사용자가 Docker Desktop(Docker 29.4.2 / compose v5.1.3) 설치 후 아래 절차로 검증 완료. 첫 실행에서 마이그레이션 마커 버그가 드러나서 1회 수정·재실행 (§8 참고). 이후 모든 단계 통과.

(2) **수행한 검증 절차** (그대로 다시 실행해도 동일 결과):

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

(3) RLS 격리 동작은 마이그레이션의 owner 역할(`kloser`)이 superuser/BYPASSRLS이라 그대로는 검증할 수 없었다. 임시 비-superuser role(`rls_probe`)를 만들어서 검증 완료 — GUC 없음 시 0 rows, GUC=org1 시 2 rows. 자세한 함의는 §9 참고.

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

### 8. node-pg-migrate v7의 raw SQL 마커는 `-- Up Migration` / `-- Down Migration` (필수)

(1) 첫 runtime 실행 시 `npm run db:migrate:up`이 "Migrations complete!"를 출력하고도 테이블이 하나도 생기지 않는 현상이 있었다. 원인: 마이그레이션 파일이 `-- Up` / `-- Down`만 마커로 사용했고, node-pg-migrate v7은 정확히 `-- Up Migration` / `-- Down Migration` 헤더를 보고 두 섹션을 분리한다. 헤더가 매칭 안 되면 **파일 전체를 한 묶음으로 실행** — 결과적으로 CREATE TABLE 직후 같은 파일 안의 DROP TABLE이 이어 실행되어 빈 DB로 끝났다. `pgmigrations`에는 row가 박혀서 "성공한 척" 보였다.

(2) 수정: `1715000000000_init.sql`의 두 헤더에 ` Migration` 추가. `pgmigrations`에서 해당 row를 DELETE 후 재실행 → 정상.

(3) Step 2 이후 새 마이그레이션을 만들 때는 `npm run db:migrate:create <name>`을 쓰면 도구가 마커를 자동으로 박는다 (수기로 만들지 말 것).

(4) 정적 검증("파일 인식 OK")은 이 버그를 못 잡는다. 다음 Step부터는 격리 테스트가 항상 같이 실행되므로 동일 사고는 자동으로 노출됨.

### 9. 마이그레이션 owner(`kloser`)가 superuser/BYPASSRLS — RLS 격리 검증은 별도 role 필요

(1) `postgres:16-alpine` 이미지가 `POSTGRES_USER=kloser`로 만든 role은 기본 `rolsuper=t, rolbypassrls=t`. FORCE ROW LEVEL SECURITY를 걸어도 superuser는 못 막는다. 그 결과 같은 role로 SELECT하면 RLS가 적용되지 않는 것처럼 모든 row가 보인다 — Step 2의 SET LOCAL 미들웨어를 만들어 놓고 dev에서 테스트해도 거짓 통과 위험.

(2) 본 step에서는 임시로 `rls_probe` role(NOSUPERUSER NOBYPASSRLS) + GRANT SELECT로 격리가 실제로 작동하는지 확인 (GUC 없음 시 0 rows, GUC=org1 시 2 rows). 확인 후 role drop.

(3) Step 2 액션 아이템:
- 운영용 `app` role 도입 (NOSUPERUSER NOBYPASSRLS) + `DATABASE_URL`을 두 종류로 분리:
  - `MIGRATE_DATABASE_URL` (또는 단순 `DATABASE_URL` admin 권한): 마이그레이션 + 시드 + 관리 작업용
  - `APP_DATABASE_URL`: 런타임 connection pool 전용, `app` role
- pool.ts/db plugin은 `app` role 기반.
- RLS 격리 PR-게이트 테스트 역시 `app` role로 접속. 그래야 SET LOCAL/GUC가 진짜 효과를 발휘.

### 10. 첫 runtime 통과 후 init 마이그레이션 in-place 보강 (cross-org FK + sessions UNIQUE)

(1) 첫 runtime 통과 직후 코드 리뷰에서 두 건의 schema 약점이 추가로 잡혔다:
- `memberships.team_id`가 `teams(id)`만 참조해서 org A 멤버십이 org B 팀을 가리킬 수 있었다 (cross-org 데이터 오염).
- `sessions.refresh_token_hash`가 일반 인덱스라 동일 hash 다중 row가 가능. Step 3의 refresh rotation에서 조회가 모호해진다.

(2) 둘 다 day-1부터 깨끗한 게 미래 read cost가 가장 낮다고 판단해 `1715000000000_init.sql`을 in-place로 보강했다 (feature 브랜치 미푸시 상태 + dev DB만 존재 + Step 2 진입 시 어차피 `compose down -v` 한 번 하므로 비용 0).

- `teams`에 `UNIQUE (org_id, id)` 추가
- `memberships.team_id` FK를 composite `(org_id, team_id) REFERENCES teams(org_id, id)`로 변경
- `sessions_refresh_token_hash_idx`를 `CREATE UNIQUE INDEX`로 변경

(3) 그 결과 같은 init 파일을 수정해서 git history에 follow-up 마이그레이션 없이 한 줄로 재현 가능. Step 1 완료 commit (`5cc7819`)에 amend로 합쳤다.

(4) **이후 룰**: Step 1 init 파일은 더 이상 in-place 수정 금지. Step 2 이후의 schema 변경은 모두 새 마이그레이션(`db:migrate:create <name>`)으로 추가.

---

## Phase 0.5 → Phase 1 인계 처리 현황

`PHASE_1_MASTER.md` §6의 7개 인계 항목 중 본 step에서 직접 처리한 것:

- [x] **`server/src/__test_client.ts` 삭제** — Phase 0.5 throwaway, Phase 1 kickoff 권장 시점에 삭제.
- [ ] shared types 중복 — Step 4에서
- [x] PostgreSQL 부트스트랩 — Step 1 완료 (코드 + runtime 검증 통과, 2026-05-07)
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

1. ~~Docker 환경 갖춰졌는지 확인~~ — Step 1에서 완료 (`docker compose -f ops/docker-compose.yml up -d`)
2. §9의 `app` role 도입: `CREATE ROLE app LOGIN ... NOSUPERUSER NOBYPASSRLS;` + 적절한 GRANT, `APP_DATABASE_URL` 환경 변수 분리. 이 작업이 Step 2의 1번이어야 함 (안 하면 RLS 테스트가 거짓 통과)
3. §7대로 `server.ts`에 `import "dotenv/config"` 추가
4. `server/src/plugins/db.ts` 작성 — `app.pg` decorator + 트랜잭션 helper, `app` role 풀 사용
5. `SET LOCAL app.org_id` 미들웨어
6. RLS 격리 테스트를 PR 머지 게이트로 등록 (반드시 `app` role 접속)

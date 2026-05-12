# Phase 5 — Step 1 Findings (Schema 보강)

> **완료일**: 2026-05-12
> **범위**: pgvector extension + 5 신규 테이블 (`knowledge_bases` / `knowledge_chunks` / `org_call_checklist_templates` / `call_checklist_items` / `call_suggestions`) + `calls` 컬럼 6개 + `transcripts` 컬럼 2개 + `current_app_user_id()` helper + `app` role grants. Repository / service / route / WS / frontend / test 변경 0건 (계획서 §0 schema-only 원칙 준수).

---

## 1. 적용 파일

신규 (8 migration + 1 findings):

- `server/migrations/1715000013000_phase5_pgvector.sql` — `CREATE EXTENSION IF NOT EXISTS vector`
- `server/migrations/1715000014000_phase5_knowledge.sql` — `knowledge_bases` + `knowledge_chunks` + RLS 4×2 정책 + ivfflat 인덱스
- `server/migrations/1715000015000_phase5_checklist.sql` — `org_call_checklist_templates` + `call_checklist_items` + RLS 4×2 정책 + 인덱스
- `server/migrations/1715000016000_phase5_call_suggestions.sql` — `call_suggestions` + RLS 4 정책 + 인덱스
- `server/migrations/1715000017000_phase5_calls_columns.sql` — `calls` 컬럼 6개 + 부분 인덱스 1개
- `server/migrations/1715000018000_phase5_transcripts_columns.sql` — `transcripts` 컬럼 2개 + CHECK
- `server/migrations/1715000019000_phase5_user_context.sql` — `current_app_user_id()` helper
- `server/migrations/1715000020000_phase5_grants.sql` — `app` role CRUD grants
- `docs/plan/phase-5/PHASE_5_STEP_1_FINDINGS.md` (본 문서)

수정 (2):

- `ops/docker-compose.yml` — postgres image `postgres:16-alpine` → `pgvector/pgvector:pg16` (volume `kloser_pgdata`는 보존)
- `docs/plan/phase-5/PHASE_5_MASTER.md` — Implementation Log Step 1 체크박스 `[x]` + 통과일 기재 (별도 commit)

수정 안 함: 서버 코드 / 프론트엔드 / 테스트 / shared types / seed 파일 / `server/.env`.

---

## 2. 도커 이미지 교체 + 기존 volume 호환성

`pgvector/pgvector:pg16`는 `postgres:16` Debian-bookworm 베이스 + pgvector preinstalled. `postgres:16-alpine` (Alpine)에서 Debian-bookworm 베이스로 OS 자체는 달라졌지만 PG data file format은 동일 (16.x 시리즈 메이저 동일).

**실측 결과** — `kloser_pgdata` volume을 그대로 mount한 상태에서:

| 검증 | 결과 |
|---|---|
| 컨테이너 시작 + `pg_isready` | OK (`accepting connections`) |
| `SELECT version()` | `PostgreSQL 16.13 (Debian 16.13-1.pgdg12+1)` |
| 기존 사용자 데이터 `SELECT count(*) FROM calls / customers / users` | 잔존 — `calls=8, customers=78, users=5` (이전 e2e run 흔적 일부 포함) |
| `pg_available_extensions` `vector` | `0.8.2` available, installed 미설치 (migration이 설치) |
| 이전 phase 0.5/2/3/4 e2e 회귀 | 모두 PASS (자세히 §5) |

기존 volume + Alpine→Debian 이미지 교체에서 data 호환성 이슈는 발견되지 않았다.

> **운영 인계 메모**: 본 작업 이후 dev 머신에서는 `docker compose -f ops/docker-compose.yml pull && docker compose -f ops/docker-compose.yml up -d`를 한 번 실행해야 pgvector 이미지로 컨테이너가 recreate된다. volume은 보존되므로 `db:migrate:up` 외 별도 작업 불필요.

---

## 3. 검증 — admin 역할 (kloser superuser)

```sql
-- vector extension
SELECT extname, extversion FROM pg_extension WHERE extname='vector';
-- → vector | 0.8.2 ✓

-- 5 신규 테이블 RLS FORCE
SELECT relname, relrowsecurity AS rls_on, relforcerowsecurity AS rls_force
  FROM pg_class
 WHERE relname IN ('knowledge_bases','knowledge_chunks','org_call_checklist_templates','call_checklist_items','call_suggestions')
 ORDER BY relname;
-- → 5 rows, 모두 t/t ✓

-- 정책 개수 — 5 테이블 × 4 정책 = 20개
SELECT tablename, count(*) FROM pg_policies
 WHERE schemaname='public'
   AND tablename IN ('knowledge_bases','knowledge_chunks','org_call_checklist_templates','call_checklist_items','call_suggestions')
 GROUP BY tablename ORDER BY tablename;
-- → 5 tables × 4 policies ✓

-- helper function
SELECT proname FROM pg_proc WHERE proname='current_app_user_id';
-- → current_app_user_id (1 row) ✓

-- calls 신규 컬럼 6개
-- → customer_linked_at / customer_linked_by_user_id / dropped_reason
--   / last_seen_at / summary_generated_at / summary_source ✓

-- transcripts 신규 컬럼 2개
-- → stt_provider / stt_session_id ✓

-- vector 검색 동작 (smoke)
INSERT INTO knowledge_chunks (... position, text, embedding) VALUES (0, '__a__', $vec_a), (1, '__b__', $vec_b);
SELECT position, text, (embedding <=> $query)::numeric(6,4) AS dist
  FROM knowledge_chunks ORDER BY embedding <=> $query LIMIT 5;
-- → 2 rows, distance 정상 계산 ✓

-- CHECK 위반 거부 (DO block에서 EXCEPTION 캐치)
-- call_suggestions: dismissed_at + used_at 동시 NOT NULL → check_violation ✓
-- calls.dropped_reason='garbage' → check_violation ✓
```

## 4. 검증 — app 역할 (NOSUPERUSER NOBYPASSRLS)

```sql
-- 본 org GUC + INSERT OK
SET LOCAL app.org_id = '11111111-1111-1111-1111-111111111111';
INSERT INTO knowledge_bases (org_id, title, source_type) VALUES (acme, '__smoke__', 'manual');
-- → INSERT 0 1 ✓

-- cross-org INSERT 차단 (WITH CHECK 위반)
SET LOCAL app.org_id = '11111111-1111-1111-1111-111111111111';
INSERT INTO knowledge_bases (org_id, title, source_type) VALUES ('22222222-...', 'cross-org', 'manual');
-- → insufficient_privilege (42501) ✓

-- current_app_user_id() set + read
SELECT set_config('app.user_id', 'aaaa...', true);
SELECT current_app_user_id();
-- → aaaa... ✓
```

`current_app_user_id()`는 본 step에서 RLS 정책에 *사용되지 않는다* (§2.8 결정 — manager team-scope을 service layer로 미룸). helper function + GUC는 Step 2의 service layer가 `denyForManagerNonTeam(...)` 같은 권한 검사 helper에서 사용할 자리.

---

## 5. 회귀 스위트 결과

```
docker compose -f ops/docker-compose.yml up -d postgres  → pgvector:pg16 시작 OK
npm --prefix server run db:migrate:up                    → 8 migration UP PASS
npm --prefix server run typecheck                        → PASS
node test/sync_shared_types.mjs                          → PASS (9 entity, Phase 5는 entity 추가 0건)
npm --prefix server test                                 → PASS 212/212
node test/phase_0_5_e2e.mjs                              → PASS (16 assertion + 콘솔 에러 0)
node test/phase_2_customers_e2e.mjs                      → PASS (7 시나리오 + 잔재 0)
node test/phase_3_e2e.mjs                                → PASS (33 assertion + cleanup)
node test/phase_4_e2e.mjs                                → PASS (8 시나리오 + cleanup sweep)
```

본 step의 schema 변경(`calls` / `transcripts` 컬럼 추가)이 Phase 4 기존 동작을 깨지 않음을 phase_4_e2e가 그대로 PASS함으로써 증명.

---

## 6. 회귀 발견 사항 — dashboard_routes.test.mjs 일시 실패와 해결

첫 `npm test` 실행 시 `dashboard_routes.test.mjs`의 4 케이스가 실패. 분석 결과 본 step migration 회귀가 아니라 **이전 e2e의 orphan `calls` row 4건 (agent_user_id NULL / title NULL / notes NULL) 잔재** 때문.

원인: Phase 4 e2e cleanup이 `phase4test-` prefix sweep으로 user를 삭제 → memberships FK가 cascade하면서 `calls.agent_user_id`가 SET NULL로 cascade. 그 4 row의 title/notes는 NULL이라 dashboard test의 `beforeEach`가 정리 대상으로 잡지 않음 (test는 `agent_user_id = ACME_ADMIN_USER_ID AND title IS NULL`만 정리).

대응:

```sql
DELETE FROM call_action_items WHERE call_id IN (SELECT id FROM calls WHERE agent_user_id IS NULL AND title IS NULL AND notes IS NULL);
DELETE FROM transcripts        WHERE call_id IN (SELECT id FROM calls WHERE agent_user_id IS NULL AND title IS NULL AND notes IS NULL);
DELETE FROM calls              WHERE agent_user_id IS NULL AND title IS NULL AND notes IS NULL;
-- → DELETE 4
```

정리 후 `npm test` 다시 → 212/212 PASS.

> **Step 5 인계**: Phase 4 e2e cleanup이 user 삭제 시 cascade로 orphan `calls`를 남기는 패턴을 phase_5_e2e 작성 시 개선. 또는 dashboard_routes.test.mjs의 `beforeEach`를 `WHERE agent_user_id IS NULL OR title LIKE 'p4dashtest-%'`로 확장.

---

## 7. 주요 결정의 실현

Step 1 plan §2의 8가지 핵심 결정이 migration에서 어떻게 구현됐는지 한 줄씩:

| 결정 | migration 파일 | 핵심 구현 |
|---|---|---|
| §2.1 checklist 마스터/진행 분리 | `15000_phase5_checklist.sql` | 2 테이블, `org_call_checklist_templates.active` soft inactive, `call_checklist_items (call_id, template_id) UNIQUE` + status/checked_at CHECK |
| §2.2 call_suggestions 별 테이블 | `16000_phase5_call_suggestions.sql` | `(call_id, group_seq, type) UNIQUE`, dismissed/used 동시 set 금지 CHECK |
| §2.3 pgvector + RAG | `13000_phase5_pgvector.sql` + `14000_phase5_knowledge.sql` | `CREATE EXTENSION vector`, `knowledge_chunks.embedding vector(1536)`, ivfflat lists=100 cosine ops |
| §2.4 calls AI summary 컬럼 | `17000_phase5_calls_columns.sql` | 메타 2개만 (`summary_generated_at` / `summary_source`) + CHECK |
| §2.5 STT 메타 | `18000_phase5_transcripts_columns.sql` | transcripts에 `stt_provider` / `stt_session_id` 추가, 별 `stt_jobs` 테이블 안 만듦 |
| §2.6 heartbeat 컬럼 | `17000_phase5_calls_columns.sql` | `last_seen_at` / `dropped_reason` + 부분 인덱스 `calls_in_progress_seen_idx` |
| §2.7 customer linkage flat | `17000_phase5_calls_columns.sql` | `customer_linked_at` / `customer_linked_by_user_id` + composite FK to memberships |
| §2.8 manager team-scope을 service로 | `19000_phase5_user_context.sql` | `current_app_user_id()` helper + `app.user_id` GUC만. RLS 추가 정책 0개. Phase 4 4 정책 그대로 유지 |

`kloser_service` (BYPASSRLS service role)에 신규 5 테이블 grant 추가 0건 — anonymous 흐름 없음 (Phase 5 §2 보안 §10-5 결정 일관).

---

## 8. 미해결 / 위험 — Step 2 인계

| # | 항목 | 상태 | Step 2/3에서 처리 |
|---|---|---|---|
| 8-1 | `withOrgContext` plugin signature 변경 | 미반영 — Phase 4 호출자 전체가 `(orgId, fn)` 사용. Step 2에서 `(orgId, userId, fn)` 또는 `(orgId, opts)` 형태로 일괄 마이그레이션 필요 | Step 2 plan에서 변경 범위 명시 + 회귀 보호 |
| 8-2 | ivfflat lists=100 적합성 | 본 step에서 lists=100으로 깔았음. dev 데이터 규모(<100 chunks)에서 ordering이 의미 있게 작동하는지는 Step 3 RAG service 작성 후 실측 | Step 3 plan에서 lists 재평가 + ANALYZE 시점 |
| 8-3 | `knowledge_chunks.embedding` 비동기 ingest 모델 | 본 step은 nullable로 둠. ingest API는 텍스트만 받고 embedding 워커가 사후 UPDATE — search query는 `WHERE embedding IS NOT NULL` 필터 동반 필요 | Step 3 service에서 명시 |
| 8-4 | seed 갱신 부재 | Step 1 범위 외. dev seed에 5 체크리스트 + 1~2 KB 가 미리 없으면 settings.html / live.html이 빈 상태로 진입 | Step 2/3에서 seed 작성 |
| 8-5 | dashboard test의 orphan 잔재 정리 | 본 step에서 1회 수동 cleanup 후 PASS. 향후 Phase 4 e2e cleanup 자체를 강화하거나 dashboard test beforeEach를 확장 | Phase 5 Step 5 e2e plan에서 cleanup 전략 통합 |
| 8-6 | docker image 교체의 운영 영향 | dev 머신에서 `docker compose pull` 필요 — 첫 사용자가 마주칠 수 있음. README나 server/README에 안내 메모 권장 | Step 2 또는 Step 5 closeout에서 README 보강 |
| 8-7 | `dropped_reason='manual'` 사용 흐름 | 본 step에서 enum 값만 깔아둠. admin 강제 종료 UI는 Phase 6+ | 향후 |
| 8-8 | `customer_linked_by_user_id` NULL 의미 | start_call 시 미선택은 NULL. 자동 매칭 등 후속 흐름이 도입되면 별 컬럼 (`customer_linked_source`) 추가 검토 | Phase 6+ |

---

## 9. Codex 집중 리뷰 포인트

1. **이미지 교체와 volume 보존** — `pgvector/pgvector:pg16` (Debian) 으로 base OS가 바뀌었지만 PG data 호환. 본 step에서 실측 PASS. 다만 운영 머신에서 다른 사용자가 처음 pull할 때 안내 필요 (server/README 또는 PHASE_5_STEP_1_FINDINGS reference 안내 검토).
2. **ivfflat 부분 인덱스 vs 전체** — 본 step은 부분 인덱스 (`WHERE embedding IS NOT NULL`) 회피하고 전체 인덱스로 두고 search query 측에서 필터. pgvector 0.8.2가 `WHERE` 절을 지원할 수 있지만 안전한 선택. Step 3 search service 작성 시 재검토 가능.
3. **knowledge_chunks 미설치 시 vector 컬럼 INSERT** — embedding이 NULL인 row가 search 결과에 안 잡히게 service가 `WHERE embedding IS NOT NULL`을 항상 거는지 (Step 3 plan).
4. **manager team-scope을 service로 옮긴 결정의 트레이드오프** — RLS는 회사 단위만 막고, 팀 단위 차단은 service 함수가 함. cross-team READ는 RLS가 막지 않으므로, manager가 *같은 org 다른 팀* 통화 SELECT 가능 (Phase 4 동작과 동일). Step 2가 의도적으로 read는 풀어두고 write에만 team-scope 적용할 것임을 확인.
5. **dashboard test의 orphan 잔재 cleanup 정책** — 본 step에서 1회 수동 처리. 영구 해결은 Phase 4 e2e cleanup 강화 또는 test beforeEach 확장. 어느 쪽이 운영 정합적인지 결정 필요.
6. **`current_app_user_id()` 본 step에서 미사용** — helper만 깔고 RLS / route에서 사용 0건. Step 2가 `withOrgContext` plugin 갱신과 함께 사용 진입.

---

## 10. git 작업

git add / commit / push / merge 0건. Codex가 본 보고와 diff를 검토 후 commit 결정.

변경 파일 git 표면:

```
M  ops/docker-compose.yml                                        (image → pgvector/pgvector:pg16)
?? server/migrations/1715000013000_phase5_pgvector.sql           (신규)
?? server/migrations/1715000014000_phase5_knowledge.sql          (신규)
?? server/migrations/1715000015000_phase5_checklist.sql          (신규)
?? server/migrations/1715000016000_phase5_call_suggestions.sql   (신규)
?? server/migrations/1715000017000_phase5_calls_columns.sql      (신규)
?? server/migrations/1715000018000_phase5_transcripts_columns.sql(신규)
?? server/migrations/1715000019000_phase5_user_context.sql       (신규)
?? server/migrations/1715000020000_phase5_grants.sql             (신규)
?? docs/plan/phase-5/PHASE_5_STEP_1_FINDINGS.md                  (신규, 본 문서)
M  docs/plan/phase-5/PHASE_5_MASTER.md                           (Step 1 체크 갱신)
```

서버 코드 / 테스트 / 프론트엔드 / shared types / seed / `server/.env` 변경 0건.

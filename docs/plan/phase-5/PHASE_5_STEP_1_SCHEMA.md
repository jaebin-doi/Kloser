# Phase 5 — Step 1 Schema Plan

> **상위**: `PHASE_5_MASTER.md` §3 Step 1.
> **출력 형태**: 본 문서는 schema 설계서다. 마이그레이션 SQL 파일은 본 문서 통과 후 작성한다.
> **AGENTS.md Phase Workflow §1 (schema migration first)을 따른다.** 본 step 통과까지는 어떤 repo/route/frontend 파일도 만들지 않는다.

---

## 0. Step 1 목표

Phase 5의 외부 데이터 표면 — RAG 인프라(`knowledge_bases` + `knowledge_chunks` + pgvector), 회사 체크리스트(`org_call_checklist_templates` + `call_checklist_items`), AI 응대 추천 영속화(`call_suggestions`), 통화 메타 보강(`calls` + `transcripts` 컬럼 추가), service-layer team-scope 권한 검사를 위한 user context helper — 가 RLS FORCE / 인덱스 / 제약 / 트랜잭션 일관성까지 깨끗이 깔린다. Step 2 (repository / service) 진입 시 schema가 "이거 어떻게 쓰지" 같은 질문을 만들지 않는다.

---

## 1. 산출물 (Step 1 통과 시 생성)

| 종류 | 경로 | 비고 |
|---|---|---|
| plan | `docs/plan/phase-5/PHASE_5_STEP_1_SCHEMA.md` | 본 문서 |
| findings | `docs/plan/phase-5/PHASE_5_STEP_1_FINDINGS.md` | 구현 후 결과 인계 |
| migration | `server/migrations/<ts>_phase5_pgvector.sql` | `CREATE EXTENSION IF NOT EXISTS vector` |
| migration | `server/migrations/<ts>_phase5_knowledge.sql` | `knowledge_bases` + `knowledge_chunks` + RLS 4×2 정책 + vector index (ivfflat) |
| migration | `server/migrations/<ts>_phase5_checklist.sql` | `org_call_checklist_templates` + `call_checklist_items` + RLS 4×2 정책 + 인덱스 |
| migration | `server/migrations/<ts>_phase5_call_suggestions.sql` | `call_suggestions` + RLS 4 정책 + 인덱스 |
| migration | `server/migrations/<ts>_phase5_calls_columns.sql` | `calls` 컬럼 6개 추가 + 부분 인덱스 1개 |
| migration | `server/migrations/<ts>_phase5_transcripts_columns.sql` | `transcripts` 컬럼 2개 추가 |
| migration | `server/migrations/<ts>_phase5_user_context.sql` | `current_app_user_id()` helper function 신설 (`app.user_id` GUC read) |
| migration | `server/migrations/<ts>_phase5_grants.sql` | `app` role grants — 신규 5 테이블 CRUD |
| (선택) infra | `ops/docker-compose.yml` | pgvector 지원 image로 교체 또는 init script 갱신 |

> **Step 1 구현 결과**: migration 8개 + (선택) docker-compose 갱신 + findings 1개. seed 갱신은 본 step 범위 외 (Step 2/4에서 결정).

---

## 2. 사전 결정 (Step 1 시작 전 확정)

> 각 결정에는 선택안 / 선택한 안 / 이유 / 후속 Step 영향을 명시한다. 사용자 지시문이 요구한 8가지 핵심 결정은 §2.1~§2.8로 별도 정리.

### 2.1 `call_checklist_items` 또는 유사 테이블이 필요한가

**선택안**
- (A) 회사별 마스터 (`org_call_checklist_templates`) + 통화별 진행 (`call_checklist_items`) 2 테이블 분리
- (B) 통화별 단일 테이블 — 매 통화 시작 시 5항목 복제 (마스터 없음)
- (C) `calls.checklist` `jsonb` 컬럼
- (D) Phase 5에서 도입 안 함 (live.html 정적 5항목 유지)

**선택한 안: (A)**

**이유**: 회사가 자기 체크리스트를 관리하려면 마스터가 필요하다 (Phase 5 settings.html에 관리 UI 도입 — master §5). 통화별 진행 상태는 별 테이블이어야 어느 통화에서 어떤 항목이 언제 누구에 의해 체크됐는지 추적 가능. (B)는 마스터 변경이 과거 통화에 소급되지 않게 하려면 결국 row를 더 가져야 함. (C)는 schema-less라 향후 분석 / 정렬 / 통계 비용 큼. (D)는 master §0의 핵심 산출물 4번을 깨버림.

**후속 Step 영향**:
- Step 2: `callChecklistTemplates.ts` + `callChecklistItems.ts` repo + 단위 테스트 (cross-org / 마스터 비활성화 후 기존 진행 상태 영향).
- Step 3: `POST /checklist-templates` (admin), `POST /calls/:id/checklist/:itemId/check` (본인 통화 write 권한).
- Step 4: live.html이 통화 시작 시 회사 active 템플릿 fetch → 통화별 행 자동 생성 / 토글 시 영속. settings.html에 관리 UI.
- 시드: dev seed에 5항목 기본 마스터 (`'고객 요구사항 청취' / '회사 규모 확인' / '기존 시스템 연동' / '플랜 추천' / '도입 시연 일정'`) — Phase 0.5 fixture와 동일. Step 1에서는 시드 갱신 안 함, 후속 step에서.

### 2.2 `call_suggestions` 또는 AI suggestion 저장 테이블이 필요한가

**선택안**
- (A) `call_suggestions` 별 테이블 — 매 group 단위로 INSERT, dismissed_at / used_at 추적
- (B) `calls.suggestions` `jsonb[]` 컬럼
- (C) 저장 안 함 (실시간만)

**선택한 안: (A)**

**이유**: 통화 후 calls.html detail 패널에서 *어떤 추천이 떴고 사용·기각됐는지*를 보여주는 게 Phase 5 핵심 가치. (C)는 master §1 "통화 후 자동 요약 + 어떤 추천이 떴는지" 가시성을 깨버림. (B)는 schema-less라 dismissed_at / used_at 추적이 어려움 + group 단위 UNIQUE 제약을 DB가 강제할 수 없음. (A)는 group 단위 row가 영속화돼 `(call_id, group_seq, type)` UNIQUE로 중복 INSERT 차단. master §2 결정 7과 일관.

**후속 Step 영향**:
- Step 2: `callSuggestions.ts` repo + 단위 테스트. `callSuggestions` service가 LLM 호출 결과를 group 단위로 INSERT (`(call_id, group_seq, type)` UNIQUE로 중복 차단).
- Step 3: WS persistence hook이 server-side LLM service 호출 → INSERT + 클라이언트에 push. REST `POST /calls/:id/suggestions/:id/dismiss` + `.../use`.
- Step 4: calls.html detail 패널에 suggestion 이력 카드 (dismissed / used 라벨 표시).

### 2.3 `knowledge_bases` / `knowledge_chunks` / pgvector 도입 여부와 migration 순서

**선택안**
- (A) Phase 5 Step 1에서 도입 — pgvector extension + 2 테이블 신설 + vector index
- (B) 외부 RAG provider (Pinecone / Weaviate) 사용 — DB 외부에서 검색
- (C) RAG 자체를 Phase 6+로 미룸 — Phase 5는 LLM 직답만

**선택한 안: (A)**

**이유**: BACKEND_PLAN v0.4 + README가 pgvector를 명시. 외부 RAG provider는 (1) 추가 인프라 비용 (2) cross-org 격리를 별 시스템에서 관리해야 함 (3) Phase 4에서 깐 RLS 모델을 그대로 활용 가능한 pgvector 대비 운영 복잡도 큼. RAG 없이 LLM 직답은 회사 가이드 적용이 약해져 master §1 "회사 가이드 + 실시간 대화 기반" 추천 가치를 깨버림.

**Migration 순서** (timestamp 오름차순):
1. `<ts1>_phase5_pgvector.sql` — `CREATE EXTENSION IF NOT EXISTS vector`
2. `<ts2>_phase5_knowledge.sql` — `knowledge_bases` → `knowledge_chunks` (FK 의존성 순)
3. `<ts3>_phase5_checklist.sql` — `org_call_checklist_templates` → `call_checklist_items`
4. `<ts4>_phase5_call_suggestions.sql`
5. `<ts5>_phase5_calls_columns.sql`
6. `<ts6>_phase5_transcripts_columns.sql`
7. `<ts7>_phase5_user_context.sql` — `current_app_user_id()` helper function
8. `<ts8>_phase5_grants.sql` — 신규 5 테이블 grants

**pgvector image / extension 설치 경로**:
- 옵션 1: `ops/docker-compose.yml`의 image를 `pgvector/pgvector:pg16`으로 교체
- 옵션 2: 기존 `postgres:16-alpine`을 그대로 두고 init script로 `CREATE EXTENSION vector` (단, alpine에는 vector 라이브러리 미포함)
- **권장**: 옵션 1. Step 1 plan 통과 후 마이그레이션 작성과 함께 `ops/docker-compose.yml` 갱신.

**vector index 패턴**:
- `ivfflat (embedding vector_cosine_ops) WITH (lists = 100)` — 작은 데이터 (<10k chunks) dev 환경에 적합. lists=100은 Phase 5 시점 권장값. Phase 6+ 운영 데이터 규모에 따라 `hnsw`로 재평가.

**후속 Step 영향**:
- Step 2: `knowledgeBases.ts` + `knowledgeChunks.ts` repo. similarity search는 `ORDER BY embedding <=> $1 LIMIT k` (cosine distance 작은 순).
- Step 3: `EmbeddingAdapter` (OpenAI ada-002 호환 1536d) + `RAGService.searchSimilarChunks(orgId, query, k)` + LLM 호출에 chunks를 context로 결합. `POST /knowledge-bases/:id/chunks/ingest` 엔드포인트.
- Step 4: settings.html에 knowledge base 관리 UI (manual 텍스트 입력 + 단일 텍스트 파일 업로드).
- 시드: dev seed에 회사별 1~2 KB + chunk 5~10건 (manual 텍스트). embedding은 Step 3 adapter가 실 호출 또는 mock으로 채움 — Step 1에서는 schema만.

### 2.4 `calls`에 AI summary 관련 컬럼 추가 vs 기존 컬럼 그대로

**선택안**
- (A) 기존 `summary` / `needs` / `issues` / `sentiment` 4 컬럼 그대로 + 메타 컬럼 `summary_generated_at` / `summary_source` 2개만 추가
- (B) 별도 `call_summaries` 테이블 (다버전 보존 — AI / 사람 / 재생성 이력)
- (C) calls 4 컬럼 + AI 전용 별도 컬럼 (`summary_ai` / `summary_manual`) 분리

**선택한 안: (A)**

**이유**: Phase 4 master §6 결정대로 1:1 관계라 같은 행 UPDATE로 충분. 다버전 보존이 필요해지면 별 `call_summaries` 테이블 분리 (Phase 6+). 메타 컬럼 2개 (`summary_generated_at` / `summary_source`)는 "AI 자동 생성인지 / 언제 생성됐는지"를 추적해 endCall 직후 워커가 채울 자리. master §2 결정 8 (graceful degradation — LLM 실패 시 summary NULL 유지) 추적도 같은 컬럼으로 됨. (B)는 calls.html detail 패널 fetch가 1 row → JOIN으로 비싸짐. (C)는 사용자 수동 입력 / AI 자동 생성 conflict 정책이 복잡해짐 (어느 컬럼을 표시할지 priority 필요).

**Conflict 정책**: AI 자동 생성과 사용자 수동 입력은 같은 4 컬럼을 쓰지만, `summary_source` 컬럼이 last-write-wins 단서로 작동.
- AI 생성: `UPDATE calls SET summary=$1, needs=$2, issues=$3, sentiment=$4, summary_generated_at=now(), summary_source='ai' WHERE id=$5 AND deleted_at IS NULL`
- 사용자 수동 입력 (`POST /calls/:id/notes` 또는 향후 summary PATCH endpoint): `summary_source='manual'`로 set. AI 워커가 사후에 도착해도 `WHERE summary_source IS NULL OR summary_source='ai'`로 제한하면 사용자 수동 입력을 덮어쓰지 않음.

**후속 Step 영향**:
- Step 2: `callSummary.ts` service의 AI 호출 결과 UPDATE 시 `summary_source IS NULL OR summary_source='ai'` guard. 사용자 수동 입력 endpoint는 `summary_source='manual'` set.
- Step 3: `POST /calls/:id/summarize` endpoint가 워커 enqueue (즉시 ack). 응답에 `summary_generated_at` 포함 — 클라이언트가 polling 또는 WS push로 갱신.
- Step 4: calls.html detail에 "생성 중…" / "AI 요약" / "사용자 수정" 라벨 분기.

### 2.5 STT job/session 저장 테이블이 필요한가

**선택안**
- (A) `stt_jobs` 별 테이블 — 큐 상태 / 재시도 / 에러 추적
- (B) 저장 안 함 — 실시간 stream이라 통화 끝나면 transcripts 행만 남음
- (C) `transcripts`에 `stt_provider` / `stt_session_id` 컬럼만 추가

**선택한 안: (B) + (C)**

**이유**: 실시간 STT는 stream 처리라 별도 job 테이블은 영속 무용. 통화가 끝나면 transcripts 행에 의미 있는 정보가 다 들어감. 단, 추후 운영 (retry / replay / 디버깅) 을 위해 transcripts에 `stt_provider` (`'clova' / 'whisper' / 'manual' / 'fixture'`) + `stt_session_id` (Clova session id 또는 자체 발급 UUID) 2 컬럼을 추가. retry / replay 운영 도구가 필요해지면 Phase 6+에서 `stt_sessions` 테이블 도입.

**후속 Step 영향**:
- Step 2: `transcripts` repo의 `appendForCallInCurrentOrg` input에 stt_provider / stt_session_id 옵셔널 필드 추가. Phase 4 호환성 (NULL 허용).
- Step 3: STT adapter가 chunk 처리 시 session id 발급 → transcripts INSERT에 같이 박음. WS persistence hook이 stt_provider='fixture'를 기본값으로 (Phase 0.5 fixture 흐름 회귀 보호).
- Step 4: calls.html detail panel transcript bubble에 STT provider 작은 라벨 (선택 — Step 4 plan에서 결정).

### 2.6 disconnect heartbeat용 `calls` 컬럼

**선택안**
- (A) `calls.last_seen_at` + `dropped_reason` 2 컬럼 추가
- (B) 별 `call_heartbeats` 테이블 (히스토리 보존)
- (C) Redis 키만 사용 (DB 영속 없음, sweep도 Redis로)

**선택한 안: (A)**

**이유**: 1 call = 1 last_seen_at, 1 dropped_reason이라 row 자체가 가벼움. (B)는 heartbeat가 20초마다 발신되는데 row 단위 영속화는 비용 큼 (1시간 통화에 180 row). (C)는 DB 외부 상태 도입 — sweep 워커가 Redis + DB 양쪽 봐야 함. (A)가 가장 단순.

**dropped_reason enum**: `'browser_disconnect' / 'server_timeout' / 'manual'`
- `browser_disconnect`: WS disconnect 이벤트 (브라우저 탭 닫음 / 네트워크 끊김 직후)
- `server_timeout`: 60초 sweep 결과 (heartbeat 끊긴 지 60초 경과)
- `manual`: admin / manager가 강제 종료

**Sweep cron**: 별도 cron worker 또는 `setInterval` (Step 2/3 plan에서 결정). 60초 주기로 `WHERE status='in_progress' AND (last_seen_at IS NULL OR last_seen_at < now() - interval '60s')`.

**부분 인덱스 필요**: `CREATE INDEX calls_in_progress_seen_idx ON calls (last_seen_at) WHERE status='in_progress' AND deleted_at IS NULL` — sweep 쿼리 cover.

**후속 Step 영향**:
- Step 2: `callHeartbeat.ts` service의 `markDroppedTimedOut(client, cutoffSec)` + `touchLastSeen(client, callId)`. 단위 테스트에서 cutoff 변화에 따른 row count 변동 검증.
- Step 3: WS `heartbeat` 이벤트 수신 → `touchLastSeen` 호출. 별 worker가 60초마다 sweep.
- Step 4: live.html이 20초마다 `socket.emit('heartbeat')`.

### 2.7 customer selection — `calls.customer_id`만 vs 별도 link history

**선택안**
- (A) flat — `calls.customer_id` + `customer_linked_at` + `customer_linked_by_user_id` 컬럼 추가
- (B) 별도 `call_customer_links` 테이블 (call_id, customer_id, linked_at, linked_by) — 이력 보존
- (C) 기존 customer_id만 사용, 이력 추적 없음

**선택한 안: (A)**

**이유**: 1 통화 = 1 고객 모델이 유지된다 (master §2 결정 12). 이력 보존 (예: "이 통화는 처음 A 고객으로 연결됐다가 B 고객으로 변경됨")이 필요한 운영 도구는 `activity_log` (Phase 6+)로 해결. (A)는 누가 / 언제 연결했는지만 추적해도 사용자 picker UX에 충분. (B)는 1:N 모델로 가야 하는데 본 phase 시점엔 과한 복잡도. (C)는 picker 흐름에서 "누가 이 고객을 연결했지" 같은 audit이 안 됨.

**`customer_linked_at` 갱신 정책**:
- 통화 시작 시 customer를 선택 → `start_call` payload의 customer_id를 service가 set + `customer_linked_at=now()` + `customer_linked_by_user_id=current_user_id()`.
- 통화 중 / 종료 후 customer 변경 → REST `POST /calls/:id/link-customer` (Step 3에서 신설) — 같은 3 컬럼 갱신.
- 자동 매칭 (Phase 6+ 발신번호 매칭 등) — 도입 시 `customer_linked_by_user_id`를 NULL로 두고 별 `customer_linked_source` 컬럼 추가 검토 (현재는 도입 안 함).

**후속 Step 영향**:
- Step 2: `customerLinkage.ts` service. 단위 테스트에서 권한 매트릭스 (employee 본인 통화만 link 가능 등).
- Step 3: `POST /calls/:id/link-customer` endpoint. WS start_call payload에 customer_id를 받아 service가 같은 트랜잭션에서 calls 3 컬럼 set.
- Step 4: live.html customer picker 모달. settings 또는 customers.html에서 picker 진입.

### 2.8 manager team-scope 권한 — RLS vs service layer

**선택안**
- (A) Step 1에서 RLS 정책으로 도입 — 기존 Phase 4 정책 위에 manager team 분기 정책 추가
- (B) Step 1은 `current_app_user_id()` / `app.user_id` 컨텍스트만 깔고, 실제 team-scope 권한 검사는 Step 2 service layer에서 처리
- (C) Phase 5에서 도입 안 함 (Phase 6+로 미룸)

**선택한 안: (B)**

**이유**: Phase 4의 `calls_select` 정책은 이미 `org_id = current_app_org_id()`로 같은 조직 전체 read를 허용한다. 여기에 manager team 정책을 *추가*해도 PostgreSQL RLS는 정책들을 OR로 결합하므로 read 범위가 좁아지지 않는다. 실제 운영 의도는 "manager가 다른 팀 통화를 메모/종료/요약/action item 변경하지 못하게" 하는 mutation 권한 분기이므로, Phase 4의 employee-non-owner 차단과 같은 service-layer helper가 더 정확하다. RLS는 계속 회사 단위 격리의 마지막 안전선으로 유지한다.

**Step 1에서 실제로 깔리는 것**: `current_app_user_id()` helper function + GUC `app.user_id` 사용 준비. `current_app_org_id()`와 같은 패턴이다.

```sql
CREATE OR REPLACE FUNCTION current_app_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;
```

**후속 Step 영향**:
- Step 2: `withOrgContext` plugin이 `SET LOCAL app.user_id = $1`도 함께 set. service 권한 helper들이 `current_app_user_id()` / `memberships.team_id`를 사용.
- Step 2: `denyForManagerNonTeam(...)` helper — Phase 4의 `denyForEmployeeNonOwner` 옆에 추가. routes에서 employee-non-owner와 함께 호출.
- Step 3: 라우트 mutation에서 manager team-scope 분기. 다른 팀 통화 mutation → 403.
- Step 5 e2e: manager 시드 사용자 추가 + 다른 팀 통화 mutation 403 검증.

### 2.9 기타 결정 (도메인 / 보안 / 기술)

#### 도메인

| # | 항목 | 결정 | 근거 |
|---|---|---|---|
| 9-1 | `knowledge_bases.source_type` enum | `'manual' / 'file' / 'url'` 3종 | manual은 텍스트 직접 입력, file은 텍스트 파일 업로드, url은 향후 웹 크롤 (Phase 6+). url은 본 phase에서 enum만 깔고 처리 로직 미구현 |
| 9-2 | `knowledge_chunks.position` 발급 | service 레이어에서 ingest 시 0부터 순차 | DB sequence 불요. 한 KB에 동시 ingest 없음 (admin only) |
| 9-3 | `knowledge_chunks.embedding` dimension | `vector(1536)` — OpenAI ada-002 / text-embedding-3-small 호환 | master §2 결정 3 일관. 향후 provider 교체 시 column drop+add 마이그레이션 필요 — 그때 Phase 6+ |
| 9-4 | `knowledge_chunks.token_count` 추적 | YES — `int CHECK (> 0)`. ingest 시 tokenizer 결과 저장 | LLM context budget 계산 + 운영 cost 분석에 필요 |
| 9-5 | `call_suggestions` UNIQUE key | `(call_id, group_seq, type)` | Phase 0.5 fixture의 group 안에 type별 카드가 1~3개. 같은 group의 같은 type 중복 INSERT 차단 |
| 9-6 | `call_suggestions.dismissed_at` / `used_at` | 둘 다 nullable timestamptz. service가 mutation 시 동시 NULL 또는 한 쪽만 set | 사용자가 dismiss 후 use 다시 불가, use 후 dismiss 불가 — CHECK으로 둘 중 하나만 NOT NULL이거나 둘 다 NULL |
| 9-7 | `org_call_checklist_templates.active` | YES — soft inactive (비활성화한 항목은 새 통화에 안 뜨지만 과거 통화 진행 상태는 유지) | hard delete는 과거 진행 상태 cascade 영향. soft active 토글이 안전 |
| 9-8 | `call_checklist_items` 자동 생성 시점 | live.html start_call 직후 service가 `org_call_checklist_templates WHERE active=true`를 fetch → 통화별 항목 INSERT | 시작 시 한 번에 자동 생성. 통화 중 마스터 변경은 진행 중 통화에 영향 없음 |
| 9-9 | `calls.summary_source` 기본값 | NULL (생성 전) | 명시적 source가 없으면 NULL — `summary` 컬럼이 NULL이면 source도 NULL이 자연 |
| 9-10 | `calls.last_seen_at` 기본값 | start_call 시점에 `now()`. 이후 heartbeat마다 갱신 | NULL인 상태로 두면 sweep이 NULL 처리해야 — 명확하게 시작 시각으로 |

#### 보안

| # | 항목 | 결정 | 근거 |
|---|---|---|---|
| 10-1 | RLS FORCE 적용 | 5 신규 테이블 모두 `FORCE ROW LEVEL SECURITY` | Phase 1·2·3·4 일관 |
| 10-2 | RLS 정책 4종 | SELECT / INSERT WITH CHECK / UPDATE USING+WITH CHECK / DELETE — 모두 `org_id = current_app_org_id()` | Phase 4 customers 4 정책 그대로 |
| 10-3 | manager team-scope 처리 | §2.8 결정 — RLS 새 정책 추가 안 함. service layer에서 처리 + Step 1은 `current_app_user_id()` helper만 깔음 | §2.8 근거 |
| 10-4 | `knowledge_chunks.embedding` 기밀성 | `org_id` RLS로 격리. 같은 org 내 admin / manager / employee / viewer 모두 read 가능 | embedding 자체는 텍스트 derived — 별도 권한 분기 없음. 운영 시 admin only로 좁히려면 후속 결정 |
| 10-5 | `kloser_service` BYPASSRLS grant | 본 phase 신규 5 테이블에 grant 안 부여 | anonymous 흐름 없음 — Phase 4와 동일 |
| 10-6 | `app` role grant | SELECT / INSERT / UPDATE / DELETE on 신규 5 테이블 | Phase 4 패턴 일관 |
| 10-7 | `dropped_reason` 기록자 | service 레이어가 결정 (`browser_disconnect` / `server_timeout` / `manual`). DB는 단순 enum 강제 | 운영 분석 / 감사 |
| 10-8 | retention enforce | 본 phase 0건. knowledge_chunks 자동 삭제 / call_suggestions 보관 기한 등은 Phase 6+ | Phase 4 §17과 일관 |

#### 기술

| # | 항목 | 결정 | 근거 |
|---|---|---|---|
| 11-1 | migration 분리 단위 | 8개 — pgvector / knowledge / checklist / call_suggestions / calls_columns / transcripts_columns / user_context / grants | Phase 1·3·4 패턴. 한 migration이 한 entity 책임. user_context는 §2.8 결정대로 helper function + GUC 사용 준비만 |
| 11-2 | timestamp prefix | `1715000013000` ~ `1715000020000` (Phase 4 마지막 `1715000012000` 다음) | Phase 4 패턴 일관 |
| 11-3 | timestamptz / uuid / gen_random_uuid | Phase 1~4 일관 | 변경 없음 |
| 11-4 | FK ON DELETE 정책 | 신규 5 테이블 모두 `org_id` CASCADE. `knowledge_chunks.knowledge_base_id` CASCADE. `call_checklist_items.template_id` CASCADE. `call_suggestions.call_id` CASCADE. `customer_linked_by_user_id` SET NULL (membership). `created_by_user_id` SET NULL (membership) | 부모 삭제 시 자식 cascade가 의도. 사용자 / membership 삭제는 정보 보존 (audit 가치) |
| 11-5 | 부분 인덱스 | calls의 새 인덱스 `(last_seen_at) WHERE status='in_progress' AND deleted_at IS NULL` 1개 + 기타 §3에서 명시 | sweep 쿼리만 좁히면 충분 |
| 11-6 | CHECK 제약 표현 | text + CHECK enum (Phase 1~4 일관) | ENUM type 미사용 |
| 11-7 | UNIQUE 제약 | `knowledge_chunks (knowledge_base_id, position)` / `call_checklist_items (call_id, template_id)` / `call_suggestions (call_id, group_seq, type)` 3개 | 자연 unique key가 명확한 자리 |
| 11-8 | vector index 타입 | `ivfflat` with `vector_cosine_ops` + `lists=100` | dev 데이터 규모. Phase 6+에서 `hnsw` 재평가 |
| 11-9 | `current_app_user_id()` helper | 새 SQL 함수. `app.user_id` GUC 읽기. `current_app_org_id()` 패턴 그대로 | §2.8 결정. Step 2가 service에서 사용 |
| 11-10 | docker-compose image 교체 | `pgvector/pgvector:pg16` 권장. 기존 volume 재사용 가능 (data 호환) | Postgres 16 호환 image. 본 step에서 migration 작성 시 함께 갱신 — 사용자에게 docker-compose 갱신 알림 명시 |

---

## 3. `knowledge_bases` 테이블 정밀화

### 3.1 컬럼 정의

```sql
CREATE TABLE knowledge_bases (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title              text NOT NULL CHECK (length(title) > 0),
  source_type        text NOT NULL CHECK (source_type IN ('manual','file','url')),
  source_uri         text,
  created_by_user_id uuid,
  deleted_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CONSTRAINT knowledge_bases_creator_membership_fk
    FOREIGN KEY (org_id, created_by_user_id)
    REFERENCES memberships(org_id, user_id) ON DELETE SET NULL (created_by_user_id)
);
```

### 3.2 RLS 정책 (4개)

`calls`와 동일한 4 정책 패턴 — `org_id = current_app_org_id()`.

### 3.3 인덱스 (1개)

```sql
CREATE INDEX knowledge_bases_org_updated_idx
  ON knowledge_bases (org_id, updated_at DESC)
  WHERE deleted_at IS NULL;
```

settings.html "회사 가이드 목록" + 최근 업데이트 순.

---

## 4. `knowledge_chunks` 테이블 정밀화

### 4.1 컬럼 정의

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE knowledge_chunks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_base_id uuid NOT NULL,
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  position          int  NOT NULL CHECK (position >= 0),
  text              text NOT NULL CHECK (length(text) > 0),
  embedding         vector(1536),
  token_count       int  CHECK (token_count IS NULL OR token_count > 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (knowledge_base_id, position),
  CONSTRAINT knowledge_chunks_kb_same_org_fk
    FOREIGN KEY (org_id, knowledge_base_id)
    REFERENCES knowledge_bases(org_id, id) ON DELETE CASCADE
);
```

`embedding`은 NULL 허용 — ingest 직후 chunk 자체는 들어가지만 embedding은 비동기 worker가 채우는 경로 (LLM/Embedding provider 호출 latency).

### 4.2 RLS 정책 (4개)

`org_id = current_app_org_id()` 4 정책.

### 4.3 인덱스 (2개)

```sql
CREATE INDEX knowledge_chunks_kb_position_idx
  ON knowledge_chunks (knowledge_base_id, position);

CREATE INDEX knowledge_chunks_embedding_ivfflat_idx
  ON knowledge_chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
```

`(knowledge_base_id, position)`은 UNIQUE에 의해 자동 — `WHERE embedding IS NOT NULL` 부분 인덱스로 vector 인덱스만 따로 만들면 안 됨? ivfflat은 부분 인덱스 미지원 케이스가 있어 Step 1 구현 시점에 Postgres 16 + pgvector 0.7+에서 `WHERE` 절 동작 확인 필요. 안 되면 전체 인덱스 + 검색 시 `WHERE embedding IS NOT NULL` 필터.

---

## 5. `org_call_checklist_templates` 테이블 정밀화

### 5.1 컬럼 정의

```sql
CREATE TABLE org_call_checklist_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title       text NOT NULL CHECK (length(title) > 0),
  sort_order  int  NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
```

### 5.2 RLS 정책 (4개)

`org_id = current_app_org_id()` 4 정책.

### 5.3 인덱스 (1개)

```sql
CREATE INDEX org_call_checklist_templates_active_idx
  ON org_call_checklist_templates (org_id, sort_order)
  WHERE active = true;
```

live.html start_call이 active 항목만 sort_order 순서대로 fetch.

---

## 6. `call_checklist_items` 테이블 정밀화

### 6.1 컬럼 정의

```sql
CREATE TABLE call_checklist_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id             uuid NOT NULL,
  template_id         uuid NOT NULL,
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  checked_at          timestamptz,
  checked_by_user_id  uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id, template_id),
  CHECK (
    (status = 'done' AND checked_at IS NOT NULL) OR
    (status = 'open' AND checked_at IS NULL)
  ),
  CONSTRAINT call_checklist_items_call_same_org_fk
    FOREIGN KEY (org_id, call_id) REFERENCES calls(org_id, id) ON DELETE CASCADE,
  CONSTRAINT call_checklist_items_template_same_org_fk
    FOREIGN KEY (org_id, template_id) REFERENCES org_call_checklist_templates(org_id, id) ON DELETE CASCADE,
  CONSTRAINT call_checklist_items_checker_membership_fk
    FOREIGN KEY (org_id, checked_by_user_id)
    REFERENCES memberships(org_id, user_id) ON DELETE SET NULL (checked_by_user_id)
);
```

### 6.2 RLS 정책 (4개)

`org_id = current_app_org_id()` 4 정책.

### 6.3 인덱스 (1개)

```sql
CREATE INDEX call_checklist_items_call_idx
  ON call_checklist_items (call_id);
```

`(call_id, template_id)` UNIQUE에 의해 read query는 cover. detail panel fetch 시 1 call의 모든 항목.

---

## 7. `call_suggestions` 테이블 정밀화

### 7.1 컬럼 정의

```sql
CREATE TABLE call_suggestions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id      uuid NOT NULL,
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  group_seq    int  NOT NULL CHECK (group_seq >= 0),
  at_ms        int  NOT NULL CHECK (at_ms >= 0),
  tone         text NOT NULL CHECK (tone IN ('blue','cyan','amber','rose','emerald','slate')),
  type         text NOT NULL CHECK (type IN ('direction','script','alert','risk','next','kb')),
  title        text NOT NULL CHECK (length(title) > 0),
  body         text,
  dismissed_at timestamptz,
  used_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id, group_seq, type),
  CHECK (
    NOT (dismissed_at IS NOT NULL AND used_at IS NOT NULL)
  ),
  CONSTRAINT call_suggestions_call_same_org_fk
    FOREIGN KEY (org_id, call_id) REFERENCES calls(org_id, id) ON DELETE CASCADE
);
```

`tone` / `type` enum은 Phase 0.5 fixture 그대로. CHECK은 dismissed_at과 used_at이 동시에 set되지 않음 강제.

### 7.2 RLS 정책 (4개)

`org_id = current_app_org_id()` 4 정책.

### 7.3 인덱스 (1개)

```sql
CREATE INDEX call_suggestions_call_seq_idx
  ON call_suggestions (call_id, group_seq);
```

`(call_id, group_seq, type)` UNIQUE에 의해 read는 cover. 명시적 추가 인덱스는 단일 group 조회용.

---

## 8. `calls` 컬럼 추가 정밀화

### 8.1 ALTER 문

```sql
ALTER TABLE calls
  ADD COLUMN summary_generated_at        timestamptz,
  ADD COLUMN summary_source              text CHECK (summary_source IS NULL OR summary_source IN ('ai','manual')),
  ADD COLUMN last_seen_at                timestamptz,
  ADD COLUMN dropped_reason              text CHECK (dropped_reason IS NULL OR dropped_reason IN ('browser_disconnect','server_timeout','manual')),
  ADD COLUMN customer_linked_at          timestamptz,
  ADD COLUMN customer_linked_by_user_id  uuid;

ALTER TABLE calls
  ADD CONSTRAINT calls_customer_linked_by_membership_fk
    FOREIGN KEY (org_id, customer_linked_by_user_id)
    REFERENCES memberships(org_id, user_id) ON DELETE SET NULL (customer_linked_by_user_id);
```

### 8.2 부분 인덱스

```sql
CREATE INDEX calls_in_progress_seen_idx
  ON calls (last_seen_at)
  WHERE status = 'in_progress' AND deleted_at IS NULL;
```

heartbeat sweep 쿼리 (`WHERE status='in_progress' AND last_seen_at < $cutoff`)가 본 인덱스만 스캔.

### 8.3 CHECK 일관성

`summary_source` ↔ `summary_generated_at` 일관성 (생성 시 둘 다 set, NULL은 둘 다 NULL)을 DB CHECK으로 강제하지 않음 — service layer 책임. CHECK로 강제하면 사용자 수동 입력 시 `summary` 만 set하고 `summary_generated_at`은 NULL인 케이스를 다루기 복잡. 운영 의도: source='manual'이면 `summary_generated_at`은 NULL 가능 (사용자 입력은 생성 시각 무관).

---

## 9. `transcripts` 컬럼 추가

### 9.1 ALTER 문

```sql
ALTER TABLE transcripts
  ADD COLUMN stt_provider     text CHECK (stt_provider IS NULL OR stt_provider IN ('clova','whisper','manual','fixture')),
  ADD COLUMN stt_session_id   text;
```

기본값 없음 (NULL). Phase 4 기존 row는 NULL — Phase 5 코드가 모두 nullable 처리.

### 9.2 인덱스

추가 인덱스 없음. STT session 단위 조회는 운영 도구 (Phase 6+).

---

## 10. `current_app_user_id()` helper function + GUC

### 10.1 새 함수

```sql
CREATE OR REPLACE FUNCTION current_app_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;
```

### 10.2 GUC `app.user_id`

기존 `app.org_id`와 동일 패턴. Step 2의 `withOrgContext` plugin이 호출자가 userId를 넘긴 경우 `SET LOCAL app.org_id = $1; SET LOCAL app.user_id = $2`로 같이 set.

`withOrgContext`는 backward-compatible overload로 바꾼다. 기존 `(orgId, fn)` 호출은 그대로 동작하고, manager team-scope처럼 현재 사용자 id가 필요한 경로만 `(orgId, userId, fn)`을 사용한다.

```ts
app.withOrgContext = async (orgId: string, userIdOrFn, maybeFn) => {
  const userId = typeof userIdOrFn === "function" ? null : userIdOrFn;
  const fn = typeof userIdOrFn === "function" ? userIdOrFn : maybeFn;
  return pool.connect(async (client) => {
    await client.query("BEGIN");
    await client.query("SET LOCAL app.org_id = $1", [orgId]);
    if (userId) await client.query("SET LOCAL app.user_id = $1", [userId]);
    // ...
  });
};
```

> **Phase 4 호환성**: 기존 `withOrgContext(orgId, fn)` 호출은 수정 없이 `app.user_id` 미설정 상태로 계속 동작한다. Step 2는 helper 구현만 overload로 바꾸고, manager team-scope 권한 검사가 필요한 호출자부터 새 signature를 쓴다.

---

## 11. manager team-scope — 본 Step에서는 RLS 정책 추가 안 함

§2.8 결정 — RLS에 새 정책 추가 안 함. Step 1 산출은 `current_app_user_id()` helper function + `app.user_id` GUC만. manager team-scope의 실제 권한 검사는 Step 2 service layer에서 `denyForManagerNonTeam(...)` helper로 구현.

기존 Phase 4 RLS 4 정책은 그대로 유지. 회귀 위험 0.

---

## 12. `app` role grant migration

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_bases              TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_chunks             TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON org_call_checklist_templates TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON call_checklist_items         TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON call_suggestions             TO app;
```

`kloser_service`에는 grant 추가하지 않음 (Phase 4와 동일 — anonymous 흐름 없음).

---

## 13. docker-compose 갱신 (선택)

기존 `ops/docker-compose.yml`의 `postgres:16-alpine`을 `pgvector/pgvector:pg16`으로 교체. 기존 volume (`kloser_pgdata`) 호환 — data file format은 동일하므로 image만 교체.

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16   # was: postgres:16-alpine
```

본 step plan은 schema 설계만 다루므로 docker-compose 갱신은 *migration 작성 시점*에 함께 처리. 사용자가 본 plan을 승인하면 migration 구현 단계에서 docker-compose 갱신 + 사용자에게 `docker compose down && docker compose up -d` 안내.

---

## 14. 시드 정책

`server/seeds/`에 본 Step 1에서 새 파일 추가 안 함. 후속 step에서 결정:

- Step 2/3: 회사별 체크리스트 5항목 기본값 (`org_call_checklist_templates`), Acme/Beta 각 5 row
- Step 3: knowledge_bases 1~2개 + chunks 5~10건 (manual 텍스트). embedding은 adapter mock 또는 실 호출 — Step 3 plan에서 결정
- suggestion / summary는 실 LLM 호출 결과라 시드 없음

---

## 15. 완료 기준

다음을 모두 만족해야 Step 1 종료 → Step 2 (repository / service) 진입.

- [ ] 8 migration 작성 + `npm --prefix server run db:migrate:up` PASS
- [ ] fresh DB에서 `npm --prefix server run db:migrate:up` PASS (pgvector image 사용)
- [ ] `db:migrate:down` 8회 후 재 `db:migrate:up` PASS (단, pgvector extension은 down에서 drop하지 않음 — 다른 데이터 보호)
- [ ] admin URL로 5 신규 테이블 RLS FORCE 확인 (`pg_class.relforcerowsecurity = true`)
- [ ] admin URL로 RLS 정책 20개 존재 확인 (5 테이블 × 4 정책 = 20)
- [ ] `SELECT * FROM pg_extension WHERE extname='vector'` 1 row
- [ ] `current_app_user_id()` 함수 존재 + `app.user_id` GUC set/read 동작 확인
- [ ] app role + GUC로 cross-org INSERT 차단 (`42501`, `23503`, `23514`)
- [ ] vector similarity 검색 동작 — `INSERT chunks + embedding` 후 `ORDER BY embedding <=> $1 LIMIT 5` 결과 ordering 확인
- [ ] `call_checklist_items` CHECK (status / checked_at) 위반 INSERT 시도 → `23514` 거부
- [ ] `call_suggestions` CHECK (dismissed_at + used_at 동시 set 금지) 위반 → `23514` 거부
- [ ] `calls` 신규 6 컬럼 추가 후 Phase 4 e2e 회귀 PASS (schema 변경이 기존 동작 깨지 않음 — 회귀 보호)
- [ ] `PHASE_5_STEP_1_FINDINGS.md` 작성 (구현 중 발견 사항·trade-off·diff 인계)
- [ ] `PHASE_5_MASTER.md` Implementation Log의 Step 1 체크박스 `[x]` flip + 통과일 기재

---

## 16. 위험 / 미해결 항목 (Step 1 → Step 2 인계)

| # | 항목 | 미해결 상태 | Step 2/3에서 결정 |
|---|---|---|---|
| 16-1 | pgvector image 교체 시 기존 dev DB volume 호환 | `pgvector/pgvector:pg16`은 `postgres:16` 기반이라 data 호환 예상. 실측 필요 | Step 1 구현 시 첫 작업 — `docker compose pull` 후 기존 volume mount해서 `db:migrate:up` PASS 확인 |
| 16-2 | ivfflat 인덱스 lists=100이 dev 데이터 규모에 과한지 부족한지 | dev seed가 10~20 chunk라 lists=100은 과함. 단, lists=10도 chunks <100에서 잘 동작. 100은 운영 초기 기준 | Step 1 구현 시 lists=10 또는 lists=100 final 결정. Step 3 RAG service 작성 시 결과 ordering 검증 |
| 16-3 | `withOrgContext` signature 확장 — optional `userId` 인자 추가 | Phase 4 코드 전체가 `withOrgContext(orgId, fn)` 사용. 기존 호출을 깨지 않도록 overload로 구현 | Step 2 plan에서 새 signature가 필요한 호출자만 명시 + 기존 호출자 회귀 테스트 |
| 16-4 | manager team-scope을 service에서 처리하면 RLS는 cross-team read 허용 | 의도된 trade-off. 회사 단위 격리는 RLS가, 팀 단위는 service. 운영 감사 관점에서 cross-team SELECT을 막고 싶다면 별도 정책 추가 | Step 2 service plan에서 명시. Phase 6+ 운영 감사 요구 시 RLS 추가 정책 도입 |
| 16-5 | `knowledge_chunks.embedding` ingest 비동기 — chunk INSERT 시점에 embedding NULL | Step 3 worker가 embedding 채움. ingest 직후 search는 결과 0. 사용자 안내 필요 | Step 3 plan에서 `is_indexed` 상태 노출 또는 ingest endpoint가 동기 호출 |
| 16-6 | `dropped_reason='manual'` 사용 흐름 | admin / manager 강제 종료 UI는 본 phase에서 도입 안 함 (settings.html에 진입점 없음). enum 값만 schema에 깔아둠 | Step 4 또는 Phase 6+ 운영 UI |
| 16-7 | live.html `customer_linked_by_user_id` NULL 케이스 | start_call 시 customer 안 골랐으면 NULL. 이후 customer picker로 link하면 set. Step 2 service의 권한 분기에서 NULL 케이스 명시 처리 | Step 2 service plan |
| 16-8 | 시드 갱신 — Phase 5 시점 dev DB에 5 체크리스트 + 1~2 KB가 미리 있어야 UI가 빈 화면 회피 | Step 1은 schema only. Step 2/3에서 seed 작성 또는 dev fixture 도입 | Step 2/3 plan |

---

## 17. 한 줄 요약

> **Step 1은 pgvector + 5 신규 테이블 (`knowledge_bases` / `knowledge_chunks` / `org_call_checklist_templates` / `call_checklist_items` / `call_suggestions`) + 2 보강 (calls / transcripts 컬럼) + `current_app_user_id()` helper + GUC 도입 + app role grants로, Phase 5의 SQL 표면을 깨끗이 깐다. manager team-scope의 RLS 추가 정책은 의도적으로 넣지 않고 service layer로 처리하며, knowledge / checklist mutation 권한 분기는 Step 3 route에서. seed 갱신은 Step 1 범위 외.**

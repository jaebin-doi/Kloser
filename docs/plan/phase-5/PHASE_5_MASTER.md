# Phase 5 — 실 STT + AI + RAG + 운영 정착 마스터 플랜

> **상위 계획**: `docs/plan/roadmap/BACKEND_PLAN.md` v0.4 §9 Phase 5.
> **선행 단계**: Phase 4 완료 — `docs/plan/phase-4/PHASE_4_MASTER.md` + `docs/plan/phase-4/PHASE_4_STEP_5_FINDINGS.md`.
> **워크플로**: `AGENTS.md` "Phase Workflow" 5단계 (schema → repo + test → routes + types + test → frontend → e2e + findings)를 따른다. UI부터 먼저 만들지 않는다.
> **기간**: 3~4주 (sub-step 단위로 분해).

---

## 진행 상태 (Implementation Log)

> 이 섹션은 sub-step 진행 시 갱신된다. 본 plan은 master로, 각 sub-step은 별도 `PHASE_5_STEP_X_*.md` 문서에서 상세 설계.

- [ ] **Step 1** — Schema (`knowledge_bases` / `knowledge_chunks` / `org_call_checklist_templates` / `call_checklist_items` / `call_suggestions` + `calls` 메타 컬럼 + `transcripts` STT 메타 컬럼 + `current_app_user_id()` / `app.user_id` 컨텍스트 + app grants) → `PHASE_5_STEP_1_SCHEMA.md`
- [ ] **Step 2** — Repository + service + unit tests (체크리스트 / suggestions / knowledge ingest·검색 / heartbeat / customer linkage / manager team-scope 권한 helper)
- [ ] **Step 3** — STT/LLM/Embedding adapter + RAG search service + AI summary/suggestion service + REST routes + shared types + WS persistence 보강 + route/WS tests
- [ ] **Step 4** — Frontend wiring (live.html customer picker + 실 checklist/suggestion · calls.html action item 작성·완료 · settings.html knowledge base 관리)
- [ ] **Step 5** — Phase 5 통합 e2e + 종합 findings + Phase 6 인계

---

## 0. 왜 Phase 5인가

Phase 4까지 갖춰진 것:

- 통화 / 발화 / 다음 액션이 DB에 영속 (Phase 4)
- 통화 기록 / 대시보드가 실 API로 동작 (Phase 4)
- 인증 / 셀프서비스 / 격리 / 권한 (Phase 1~3)

평가자는 자기 통화를 만들고 다시 보고 집계할 수 있게 됐지만, 통화 안에 흐르는 *내용*은 여전히 Phase 0.5 fixture다 — 마이크 음성도 가짜고, AI 추천도 정해진 카드를 시점만 다르게 띄우며, 통화 후 요약도 직접 입력해야 한다. Phase 5는 그 fixture를 진짜로 바꾼다.

핵심 산출물:

1. **실 STT 어댑터** — Naver Clova Speech (한국어). live.html 진입 시 실제 마이크 입력이 transcripts 테이블에 적층된다.
2. **AI 응대 추천** — Claude / OpenAI LLM이 회사 가이드를 RAG로 검색해 통화 중 추천 카드를 만든다. 결과는 `call_suggestions`로 영속.
3. **통화 후 자동 요약** — endCall 직후 LLM이 `calls.summary` / `needs` / `issues` / `sentiment`를 채운다. 사용자 수동 입력과 공존.
4. **체크리스트 / 빠른 응대 멘트 영속화** — 회사 단위 마스터 + 통화별 진행 상태.
5. **knowledge_bases / knowledge_chunks + pgvector RAG** — 회사 가이드·FAQ를 임베딩으로 저장하고 LLM에 컨텍스트로 결합.
6. **disconnect heartbeat → 자동 `dropped` 처리** — 브라우저 비정상 종료 통화가 자동 마감.
7. **live.html 고객 선택 흐름** — 통화 시작 전/도중 customer를 골라 통화에 연결.
8. **action item 작성·상태 UI** — calls.html detail 패널이 read-only에서 mutation으로.
9. **manager team-scope 권한** — 회사 단위 격리는 기존 RLS가 맡고, "자기 팀 통화만 변경" 규칙은 service layer 권한 helper가 맡는다.

이걸 끝내면 Phase 6 (운영 도메인 + SMTP + MFA + activity log + retention enforce + 결제)로 넘어간다.

---

## 1. 범위 (Scope)

### 한다

**스키마 (Step 1)**

- `knowledge_bases` 신규 — 회사 가이드/FAQ 문서 메타 (org_id, title, source_type, source_uri, created_by_user_id, soft delete)
- `knowledge_chunks` 신규 — 청크 단위 + `embedding vector(1536)` (pgvector) + RLS FORCE
- `org_call_checklist_templates` 신규 — 회사별 체크리스트 마스터 (org_id, title, sort_order, active)
- `call_checklist_items` 신규 — 통화별 진행 상태 (call_id, template_id, status='open'/'done', checked_at, checked_by_user_id)
- `call_suggestions` 신규 — AI 응대 추천 영속 (call_id, group_at_ms, tone, type, title, body, dismissed_at, used_at)
- `calls` 컬럼 추가 — `summary_generated_at` / `summary_source` / `last_seen_at` / `dropped_reason` / `customer_linked_at` / `customer_linked_by_user_id`
- `transcripts` 컬럼 추가 — `stt_provider` / `stt_session_id` (실 STT replay/디버깅용)
- manager team-scope 준비 — Step 1은 `current_app_user_id()` / `app.user_id` 컨텍스트만 깔고, 실제 team-scope 권한 검사는 Step 2 service layer에서 구현
- pgvector extension activation (migration 첫 줄)
- `app` role grants (신규 5 테이블 CRUD)

**서버 (Step 2~3)**

- `server/src/repositories/knowledgeBases.ts` + `knowledgeChunks.ts` — ingest / upsert / vector similarity search
- `server/src/repositories/callChecklist.ts` + `callSuggestions.ts`
- `server/src/services/stt.ts` — STT adapter interface + Clova 구현 + Redis/BullMQ 큐
- `server/src/services/llm.ts` — LLM adapter interface + Claude 구현
- `server/src/services/embedding.ts` — Embedding adapter (OpenAI ada-002 또는 Voyage)
- `server/src/services/rag.ts` — knowledge_chunks similarity search + context build
- `server/src/services/callSummary.ts` — endCall 후 LLM 호출 + `calls.summary/needs/issues/sentiment` UPDATE
- `server/src/services/callSuggestions.ts` — text_chunk 흐름 중 LLM 호출 + `call_suggestions` INSERT
- `server/src/services/callHeartbeat.ts` — cron 또는 timer로 `WHERE status='in_progress' AND last_seen_at < now() - interval '60s'` → `dropped`
- `server/src/services/calls.ts` 보강 — `linkCustomer(callId, customerId, byUserId)`
- `server/src/routes/calls.ts` 보강 — `POST /calls/:id/summarize` / `POST /calls/:id/link-customer` / action item mutation (이미 노출됨 — Step 3에서 UI wire)
- `server/src/routes/knowledgeBases.ts` 신규 — CRUD + chunk ingest
- `server/src/routes/checklistTemplates.ts` 신규 — 회사별 체크리스트 마스터 CRUD
- `server/src/ws/calls.ts` 보강 — `heartbeat` 이벤트 수신 + `last_seen_at` UPDATE + suggestion persistence hook
- `server/src/types/{knowledgeBase,knowledgeChunk,checklistTemplate,callChecklistItem,callSuggestion}.ts` zod 원본 + `platform/types/*.js` JSDoc 사본 + `test/sync_shared_types.mjs` 5 entity 등록

**클라이언트 (Step 4)**

- `platform/live.html` — customer picker 모달 (시작 시점 또는 통화 중) · 체크리스트가 회사별 마스터에서 fetch · suggestion 카드가 실 LLM 응답으로 갱신 · WS heartbeat 정주기 발신
- `platform/calls.html` — detail 패널 action item 작성/완료 + suggestion 이력 표시 + 통화 후 요약 자동 생성 트리거
- `platform/settings.html` — knowledge base 관리 (업로드 / 텍스트 입력 / 삭제) + 체크리스트 템플릿 관리
- `platform/dashboard.html` — Phase 4 실 KPI 유지. manager 전용 read-scope 화면은 Phase 6+ report 트랙으로 미룸
- `platform/types/*.js` JSDoc 사본 (5 entity)

**검증 (Step 5)**

- 서버 단위 테스트 — knowledge ingest + similarity search (pgvector 결과 ordering 검증) / checklist mark+rollback / suggestion persistence (group seq UNIQUE) / heartbeat dropped 마킹 / customer linkage / manager team-scope service 권한 분기
- LLM/STT adapter는 mock provider로 단위 테스트 (실 외부 호출은 e2e에서도 mock fixture)
- Phase 5 통합 e2e — 시드 user 로그인 → 통화 시작 → mock STT가 한국어 utterance push → mock LLM이 suggestion 발사 + 통화 종료 → 자동 요약 + customers.last_contacted_at 갱신 → calls.html detail에 모두 표시 → manager 로그인 → 자기 팀 통화 mutation 허용 + 다른 팀 통화 mutation 403
- Phase 0.5 / 2 / 3 / 4 e2e 회귀

### 안 한다 (Phase 6+로 미룸)

**call_recordings (오디오 파일)** — 파일 스토리지 (S3 / 로컬) + 암호화 at-rest + retention 정책. Phase 6+. 본 phase는 STT 결과 transcript만 영속.

**실 SMTP / Resend 어댑터** — Phase 3 dev outbox 그대로. Phase 6+ 운영 단계.

**MFA / 2FA / WebAuthn** — Phase 6+.

**activity_log / 감사 로그** — Phase 2 deferred. Phase 6+ 운영 위생.

**retention enforce (cron으로 통화 녹음 90일 / Transcript 3년 삭제)** — DB 트리거 / cron. Phase 6+.

**Manager 보고서 / 팀 KPI 차트 화면** — Phase 5는 manager team-scope mutation 권한만 깔고, "자기 팀 통화만 보이는" 별도 보고서 화면 (주간 성과 막대 / 우수 사례 자동 표시)은 Phase 6+ UI 트랙.

**결제·구독 흐름** — `organizations.plan`은 컬럼만 존재. Stripe / Toss 연동은 Phase 6+ 운영 진입.

**bulk knowledge import (CSV / Word / PDF parser)** — Phase 5는 manual 텍스트 입력 + 단일 텍스트 파일 업로드 (UTF-8). PDF/Word OCR + chunking 워커는 Phase 6+ enterprise.

**다국어 transcript** — Clova 한국어만. 영어/일본어는 Phase 6+ 다국어 트랙.

**call summary 다버전 (AI / 사람) 동시 보존** — 본 phase는 1행 = 최신 버전. 다버전이 필요해지면 별 `call_summaries` 테이블 (Phase 6+).

**organizations.timezone** — dashboard "오늘" 기준이 여전히 UTC. Phase 6+ i18n 트랙.

---

## 2. 사전 결정 (Phase 5 시작 전 확정)

| # | 항목 | 결정 | 근거 |
|---|---|---|---|
| 1 | STT provider | **Naver Clova Speech** (한국어 영업 도메인 정확도 우선). 인터페이스 `STTAdapter`로 추상화해 향후 Whisper / Azure 교체 가능 | BACKEND_PLAN v0.4 + README 명시. 한국어 도메인 정확도 |
| 2 | LLM provider | **Anthropic Claude (claude-sonnet-4-x)** primary, OpenAI는 fallback. `LLMAdapter` 인터페이스로 추상화 | 한국어 응대 품질 + 회사가 보유한 Claude 라이선스 + Anthropic 직접 활용 |
| 3 | Embedding provider | **OpenAI `text-embedding-3-small` (1536d)** 또는 Voyage. `EmbeddingAdapter` 인터페이스 | Claude는 직접 embedding API 미제공. ada-002 호환 차원 1536으로 통일 |
| 4 | pgvector extension | **YES — Step 1 migration 첫 줄에서 `CREATE EXTENSION IF NOT EXISTS vector`** | RAG 도입의 첫 step. Docker Postgres 16에서 별도 image 필요 시 ops/docker-compose.yml 갱신 (Step 1 plan에서 명시) |
| 5 | RAG chunk size | **300~500 token + 50 token overlap** | OpenAI 권장 + 영업 가이드 평균 문단 길이. Step 1 plan에서 명시 |
| 6 | knowledge ingest scope | **org 단위만** — cross-org RAG 없음. `knowledge_bases.org_id` NOT NULL + RLS FORCE | 회사 가이드는 회사 자산. cross-org leak은 가장 큰 사고 시나리오 |
| 7 | AI suggestion 영속화 시점 | **매 group 단위로 INSERT** (Phase 0.5 fixture의 group 구조 그대로) — 통화 종료 시 batch INSERT 아님 | 통화 중 dismissed / used가 group 단위로 발생하므로 실시간 row가 필요. `(call_id, group_seq)` UNIQUE |
| 8 | AI 자동 요약 트리거 | **endCall 직후 BullMQ에 enqueue → 비동기 워커가 LLM 호출 + `calls.summary/needs/issues/sentiment` UPDATE.** endCall ack는 워커 완료를 기다리지 않음 | LLM latency (1~5s) 때문에 ack를 막으면 UX 저하. 워커 완료는 SSE / WebSocket으로 후속 push |
| 9 | LLM 호출 실패 시 calls 상태 | **graceful degradation — 통화 자체는 ended로 마감, summary 컬럼은 NULL 유지** + `calls`에 `summary_generated_at IS NULL`로 미생성 추적 | 외부 의존성 실패가 운영 흐름 막지 않도록 |
| 10 | dropped 마킹 timeout | **60초** (`last_seen_at < now() - interval '60s' AND status='in_progress'`) | 모바일 네트워크 지연 / 사용자 잠시 자리 비움 케이스 흡수. cron 또는 startup-timer가 60초마다 sweep |
| 11 | heartbeat 발신 주기 | **20초** (WS `heartbeat` 이벤트) | timeout 60초 대비 3분의 1 — 1회 누락도 안전 마진 |
| 12 | customer 연결 모델 | **flat — `calls.customer_id` + `customer_linked_at` + `customer_linked_by_user_id` 2 컬럼 추가** | 1통화 = 1고객 모델. 이력 보존이 필요하면 향후 `activity_log` (Phase 6+) |
| 13 | checklist 마스터 모델 | **회사별 마스터 (`org_call_checklist_templates`) + 통화별 진행 (`call_checklist_items`)** | 회사가 자기 체크리스트 관리 + 통화별 진행 상태 분리. settings.html에 마스터 관리 UI 도입 (Step 4) |
| 14 | checklist 기본값 시드 | **`'고객 요구사항 청취' / '회사 규모 확인' / '기존 시스템 연동' / '플랜 추천' / '도입 시연 일정'` 5항목 (Phase 0.5 fixture와 동일)** | 시드 user 진입 시 빈 화면 회피 |
| 15 | call_action_items mutation UI | **calls.html detail 패널에 작성/완료/삭제 추가.** 백엔드는 Phase 4에서 이미 노출됨 (route test 32 case) | Step 4 wiring만 |
| 16 | manager team-scope 처리 위치 | **service layer** — Step 1은 `current_app_user_id()` helper + `app.user_id` GUC만 추가. RLS는 회사 단위 격리로 유지 | 기존 Phase 4 `calls_select`가 이미 같은 org 전체 read를 허용하므로 RLS 정책 추가만으로 team read 제한이 되지 않음. mutation 권한은 service helper에서 정밀하게 처리 |
| 17 | manager team-scope 적용 entity | **calls mutation / summary / action item / suggestion 사용·기각** — `agent_user_id`가 같은 팀이면 manager write 허용 | knowledge_bases / checklist templates / customers는 manager team-scope 적용 안 함. knowledge/checklist master mutation은 admin only |
| 18 | STT 큐 인프라 | **BullMQ + Redis (Phase 1에서 docker-compose만 됐던 Redis 본격 활용)** + 워커는 별도 process 또는 `tsx watch`로 dev에서 같이 기동 | 실시간 STT는 큐 없이 stream 직접 처리지만, LLM 요약은 큐 — 둘을 분리. Step 3 plan에서 정밀화 |
| 19 | AI 호출 cost cap | **org 단위 일일 호출 수 limit (`organizations` 컬럼 추가는 Phase 6+).** Phase 5는 dev env에서 호출 시 cost log만 남김 | 운영 단계 결제와 묶임. dev에서 cost 폭주만 방지 |
| 20 | LLM/STT 키 환경변수 | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `CLOVA_*` 를 `server/.env.example`에 추가. `.env`는 손대지 않음 (각 dev 머신에서 직접 채움) | `.env`는 user-owned. dev 머신마다 다름 |
| 21 | 실패 시 fallback 정책 | STT 실패 → transcripts 적층만 중단 (이미 적층된 행 보존). LLM 실패 → summary NULL 유지. Embedding 실패 → ingest 실패로 chunks INSERT 안 함. 모든 외부 호출에 timeout (STT 5s / LLM 30s / Embedding 10s) | 외부 의존성 실패가 통화 흐름 막지 않도록 |
| 22 | 통화 latency UI 표시 | live.html `latencyVal`은 WS RTT 그대로 유지. LLM/RAG latency는 별도 measurement (response time histogram) — Phase 6+ 모니터링 | Phase 0.5 RTT 1ms는 fixture. 실 LLM은 1~3s, UI shimmer가 받아줌 |
| 23 | shared types 패턴 | **Phase 2·3·4와 동일** — server/src/types zod 원본 + platform/types JSDoc 사본 + sync registry 5 entity 추가 (knowledgeBase / knowledgeChunk / checklistTemplate / callChecklistItem / callSuggestion) | 누적 14 entity |
| 24 | innerHTML XSS gate | suggestion `title` / `body`는 server-supplied LLM 응답. `live.html`의 DOMPurify 경로 그대로 사용 + Step 4에서 추가 audit | 외부 LLM 응답을 신뢰하지 않음. AGENTS.md 기존 패턴 유지 |
| 25 | seed 정책 | dev seed에 회사별 체크리스트 5항목 + knowledge base 1~2개 + chunk 5~10건 (manual 텍스트). suggestion / summary는 LLM 실호출 결과라 시드 없음 | UI 진입 시 빈 화면 회피. seed는 schema-only Step 1에서는 미작성, 후속 step에서 결정 |

---

## 3. Sub-step 분해 (실행 순서)

> **순서 엄격**: AGENTS.md Phase Workflow §3. UI부터 만들지 않는다. Step N이 통과해야 Step N+1로 간다.

### Step 1 — Schema 보강 (2~2.5일)

**목표**: pgvector + 5 신규 테이블 + 2 테이블 컬럼 추가 + user context helper + grant까지 깨끗이 깔린다. Step 2 (repository/service)가 진입할 때 schema가 "이거 어떻게 쓰지" 질문을 만들지 않는다. manager team-scope의 실제 권한 검사는 Step 2 service layer에서 구현한다. seed는 schema-only Step 1에서 미작성.

**산출물**:
- `server/migrations/<ts>_phase5_pgvector.sql` — extension 활성화
- `server/migrations/<ts>_phase5_knowledge.sql` — `knowledge_bases` + `knowledge_chunks` + RLS + vector index (`ivfflat` 또는 `hnsw`)
- `server/migrations/<ts>_phase5_checklist.sql` — `org_call_checklist_templates` + `call_checklist_items` + RLS + 인덱스
- `server/migrations/<ts>_phase5_call_suggestions.sql` — `call_suggestions` + RLS + 인덱스
- `server/migrations/<ts>_phase5_calls_columns.sql` — `calls`에 6 컬럼 추가 (`summary_generated_at`, `summary_source`, `last_seen_at`, `dropped_reason`, `customer_linked_at`, `customer_linked_by_user_id`)
- `server/migrations/<ts>_phase5_transcripts_columns.sql` — `transcripts`에 2 컬럼 추가 (`stt_provider`, `stt_session_id`)
- `server/migrations/<ts>_phase5_user_context.sql` — `current_app_user_id()` helper + `app.user_id` GUC 사용 준비
- `server/migrations/<ts>_phase5_grants.sql` — app role grants (신규 5 테이블 CRUD)
- (선택) `ops/docker-compose.yml` 갱신 — pgvector 지원 Postgres image (`pgvector/pgvector:pg16` 또는 init script로 extension 활성화)
- `PHASE_5_STEP_1_SCHEMA.md` (계획서, 이번 작업에서 작성)
- `PHASE_5_STEP_1_FINDINGS.md` — 구현 결과·검증·Step 2 인계

**완료 기준**:
- `npm --prefix server run db:migrate:up` PASS (fresh DB + 기존 DB 양쪽)
- pgvector extension 존재 확인 (`SELECT * FROM pg_extension WHERE extname='vector'`)
- 5 신규 테이블 RLS FORCE 확인
- `current_app_user_id()` helper 존재 + `app.user_id` GUC set/read 동작 확인
- app role + GUC 컨텍스트로 cross-org INSERT 차단 / vector similarity 검색 동작 확인

### Step 2 — Repository + service + unit tests (2.5~3일)

**목표**: 5 신규 entity의 typed accessor + 4개 핵심 service (AI summary / suggestion / heartbeat / customer linkage) 가 RLS 격리 / pgvector ordering / manager team-scope service 권한 분기를 단위 테스트로 증명.

**산출물**:
- `server/src/repositories/knowledgeBases.ts` + `knowledgeChunks.ts` — ingest / vector similarity search (`<=>` cosine distance)
- `server/src/repositories/callChecklistTemplates.ts` + `callChecklistItems.ts`
- `server/src/repositories/callSuggestions.ts`
- `server/src/services/callSummary.ts` — endCall enqueue + LLM 호출 (mock provider 단위 테스트)
- `server/src/services/callSuggestions.ts` — text_chunk hook + LLM 호출 (mock)
- `server/src/services/callHeartbeat.ts` — `markDroppedTimedOut(client, cutoffSec)` + 단위 테스트 (cutoff에 따른 row count)
- `server/src/services/customerLinkage.ts` — `linkCustomer(callId, customerId, byUserId)` (Phase 4의 endCall과 분리)
- `server/src/services/rag.ts` — `searchSimilarChunks(orgId, query, k)`
- 단위 테스트 ~30~40 케이스 — RLS 격리 / pgvector ordering / manager same-team mutation 허용 + cross-team mutation 차단 / heartbeat cutoff / suggestion (call_id, group_seq) UNIQUE / customer linkage 권한 / LLM mock adapter

**완료 기준**:
- `npm --prefix server test` 신규 ~30~40 cases PASS
- 회귀 (Phase 1~4 unit tests 212개) 모두 PASS
- pgvector cosine similarity 결과 ordering 단위 테스트로 증명

### Step 3 — STT/LLM/Embedding adapter + RAG + REST routes + shared types + route tests (3~3.5일)

**목표**: 외부 adapter 3종 + RAG + REST + WS hook + shared types가 권한 매트릭스 + 입력 검증 + 본 org 격리를 모두 통과.

**산출물**:
- `server/src/adapters/stt/clova.ts` + `server/src/adapters/stt/mock.ts` (인터페이스 `STTAdapter`)
- `server/src/adapters/llm/anthropic.ts` + `server/src/adapters/llm/mock.ts` (인터페이스 `LLMAdapter`)
- `server/src/adapters/embedding/openai.ts` + `server/src/adapters/embedding/mock.ts` (인터페이스 `EmbeddingAdapter`)
- `server/src/services/queue.ts` — BullMQ producer (summary enqueue 등)
- `server/src/workers/callSummary.worker.ts` — 별도 entry point
- `server/src/routes/knowledgeBases.ts` — `GET /knowledge-bases` / `POST /knowledge-bases` / `POST /knowledge-bases/:id/chunks/ingest` / `DELETE /knowledge-bases/:id`
- `server/src/routes/checklistTemplates.ts` — 회사별 마스터 CRUD
- `server/src/routes/calls.ts` 보강 — `POST /calls/:id/summarize` / `POST /calls/:id/link-customer` / `POST /calls/:id/checklist/:itemId/check` (체크리스트 토글)
- `server/src/ws/calls.ts` 보강 — `heartbeat` 이벤트 수신 + `last_seen_at` UPDATE + suggestion persistence hook
- `server/src/types/{knowledgeBase,knowledgeChunk,checklistTemplate,callChecklistItem,callSuggestion}.ts` — zod 원본
- `platform/types/{knowledgeBase,knowledgeChunk,checklistTemplate,callChecklistItem,callSuggestion}.js` — JSDoc 사본
- `test/sync_shared_types.mjs` — 5 entity registry 추가
- 단위/통합 테스트 ~30~40 케이스 — REST 4xx 경로 + WS heartbeat 검증 + adapter mock 통합

**완료 기준**:
- 신규 endpoint 모두 200/4xx 정확
- viewer가 knowledge base CRUD → 403 (admin only)
- manager가 다른 팀 통화 summarize → 403 (team-scope)
- `node test/sync_shared_types.mjs` PASS (14 entity)
- `npm --prefix server test` 신규 ~30~40 + 누적 ~280~290 PASS

### Step 4 — Frontend wiring (2.5~3일)

**목표**: 5개 페이지가 실 데이터로 동작.

**산출물**:
- `platform/live.html` — customer picker 모달 (시작 시점 또는 통화 중) · 체크리스트가 회사 마스터에서 fetch + 토글 시 영속 · suggestion 카드가 실 LLM 응답으로 갱신 · WS heartbeat 20초 주기 발신 · 종료 후 요약 생성 중 라벨
- `platform/calls.html` — detail 패널 action item 작성/완료/삭제 + 통화 후 요약 자동 트리거 + suggestion 이력 표시
- `platform/settings.html` — 회사 가이드 (knowledge base) 관리 + 체크리스트 템플릿 관리 UI (admin only)
- `platform/dashboard.html` — Phase 4 실 KPI 유지. manager 전용 read-scope 화면은 Phase 6+ report 트랙으로 미룸
- `platform/api.js` 보강 — knowledge / checklist / summarize / link-customer helpers
- innerHTML XSS gate 준수 — LLM 응답 모두 DOMPurify 경유

**완료 기준**:
- 브라우저 시각 검증 8 시나리오 (live customer picker / 체크리스트 토글 영속 / suggestion 실 LLM / disconnect→dropped 자동 마킹 / 통화 후 요약 자동 / action item 작성·완료 / settings knowledge / manager team-scope mutation)
- AGENTS.md innerHTML XSS gate 위반 0건
- `node test/sync_shared_types.mjs` PASS

### Step 5 — 통합 e2e + 종합 findings + Phase 6 인계 (1.5~2일)

**목표**: 자동 회귀 + Phase 5 종료 인계.

**산출물**:
- `test/phase_5_e2e.mjs` — 10~12 시나리오: mock STT/LLM/Embedding로 — signup → live 진입 → customer picker → mock STT utterance → mock LLM suggestion → 종료 → 자동 요약 생성 완료 → calls.html detail에 모두 표시 → manager 로그인 → 자기 팀 통화 mutation 허용 + 다른 팀 통화 mutation 403 → 다른 org 격리 → action item 작성 → settings knowledge upload → cleanup sweep
- `PHASE_5_STEP_2_REPO.md` / `PHASE_5_STEP_3_ROUTES.md` / `PHASE_5_STEP_4_CLIENT.md` / `PHASE_5_STEP_5_E2E.md` + 각 `*_FINDINGS.md`
- 마스터 plan 체크박스 동기화
- 루트 `README.md` + `server/README.md` 상태 블록 갱신
- `docs/USER_GUIDE_PHASE_5.md` + `docs/product/PHASE_5_FOUNDATIONS.html` (Phase 1·2·3·4 패턴)
- `docs/product/USER_GUIDE.html` 실 브라우저 캡처 기반 재작성 (Phase 5 완료 시점에 화면 캡처가 안정됨)

**완료 기준**:
- 새 e2e 10~12 시나리오 PASS + cleanup sweep
- Phase 0.5 / 2 / 3 / 4 e2e 회귀 PASS
- master plan §완료 기준 모두 충족
- branch가 develop에 머지 가능한 상태

---

## 4. 권한 정책 보강

### Role × Action 매트릭스 (Phase 5 시점, Phase 4 위에 추가)

| Role | calls read (자기 org) | 본인 통화 write | 같은 팀 통화 write | 다른 팀 통화 write | knowledge_bases CRUD | checklist_templates CRUD | action item create/complete |
|---|---|---|---|---|---|---|---|
| **admin** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **manager** | ✓ | ✓ | ✓ | ✗ | ✗ (read OK) | ✗ (read OK) | ✓ (자기 팀) |
| **employee** | ✓ | ✓ | ✗ | ✗ | ✗ (read OK) | ✗ (read OK) | ✓ (본인 통화) |
| **viewer** | ✓ | ✗ | ✗ | ✗ | ✗ (read OK) | ✗ (read OK) | ✗ |

> Phase 5에서는 cross-org 격리만 RLS가 맡고, team-scope는 service layer가 mutation에서 검사한다. 따라서 read는 Phase 4처럼 자기 org 전체가 보이지만, manager가 다른 팀 통화를 요약·메모·종료·action item 변경하려 하면 403으로 차단한다. "자기 팀 통화만 read" 화면은 Phase 6+ manager report 트랙으로 미룬다.

### 추가 보호 규칙

1. **본인 통화 판정** — Phase 4와 동일 (`calls.agent_user_id = current_user_id()`)
2. **manager team-scope** — `memberships.team_id` 기반. `calls.agent_user_id`가 같은 팀에 속하면 manager write 허용. read 제한은 본 phase에서 RLS로 좁히지 않음
3. **knowledge / checklist template mutation** — `admin only` (manager 포함 불가). 회사 가이드는 회사 단위 정책
4. **call summarize 권한** — 본인 통화 write 권한과 동일 (employee 본인만, manager 자기 팀, admin 전체)
5. **action item assignee 변경** — 본인이 담당자가 되는 건 자유, 다른 사람 담당 변경은 admin/manager만

### Phase 6+에서 도입 예정

- **manager team read-scope / 보고서** — 매니저가 자기 팀 통화만 보는 전용 보고서 화면
- **employee self-scope** — 자기 담당 고객 통화만 (현재는 자기 통화만)
- **call_recordings 권한** — 오디오 파일 read는 별도 권한 (개인정보)
- **activity_log 결합** — mutation 별로 누가 무엇을 언제 했는지

---

## 5. 데이터 모델 후보

> **사전 결정**: 본 섹션은 Step 1 schema plan (`PHASE_5_STEP_1_SCHEMA.md`)에서 정밀화. 본 master는 골격만 제시.

### 5.1 신규 — `knowledge_bases`

```sql
CREATE TABLE knowledge_bases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title           text NOT NULL,
  source_type     text NOT NULL CHECK (source_type IN ('manual','file','url')),
  source_uri      text,
  created_by_user_id uuid,
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, created_by_user_id)
    REFERENCES memberships(org_id, user_id) ON DELETE SET NULL (created_by_user_id)
);
```

### 5.2 신규 — `knowledge_chunks`

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE knowledge_chunks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_base_id uuid NOT NULL,
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  position      int NOT NULL CHECK (position >= 0),
  text          text NOT NULL CHECK (length(text) > 0),
  embedding     vector(1536),
  token_count   int CHECK (token_count IS NULL OR token_count > 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (knowledge_base_id, position),
  FOREIGN KEY (org_id, knowledge_base_id) REFERENCES knowledge_bases(org_id, id) ON DELETE CASCADE
);
```

### 5.3 신규 — `org_call_checklist_templates`

```sql
CREATE TABLE org_call_checklist_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title       text NOT NULL,
  sort_order  int  NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
```

### 5.4 신규 — `call_checklist_items`

```sql
CREATE TABLE call_checklist_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id         uuid NOT NULL,
  template_id     uuid NOT NULL,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  checked_at      timestamptz,
  checked_by_user_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id, template_id),
  FOREIGN KEY (org_id, call_id) REFERENCES calls(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, template_id) REFERENCES org_call_checklist_templates(org_id, id) ON DELETE CASCADE,
  CHECK (
    (status = 'done' AND checked_at IS NOT NULL) OR
    (status <> 'done' AND checked_at IS NULL)
  )
);
```

### 5.5 신규 — `call_suggestions`

```sql
CREATE TABLE call_suggestions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id     uuid NOT NULL,
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  group_seq   int  NOT NULL CHECK (group_seq >= 0),
  at_ms       int  NOT NULL CHECK (at_ms >= 0),
  tone        text NOT NULL CHECK (tone IN ('blue','cyan','amber','rose','emerald','slate')),
  type        text NOT NULL CHECK (type IN ('direction','script','alert','risk','next','kb')),
  title       text NOT NULL,
  body        text,
  dismissed_at timestamptz,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id, group_seq, type),
  FOREIGN KEY (org_id, call_id) REFERENCES calls(org_id, id) ON DELETE CASCADE
);
```

### 5.6 보강 — `calls` 컬럼 6개

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

### 5.7 보강 — `transcripts` 컬럼 2개

```sql
ALTER TABLE transcripts
  ADD COLUMN stt_provider     text CHECK (stt_provider IS NULL OR stt_provider IN ('clova','whisper','manual','fixture')),
  ADD COLUMN stt_session_id   text;
```

### 5.8 보강 — user context helper (`current_app_user_id`)

Step 1은 manager team-scope RLS 정책을 추가하지 않는다. 대신 Step 2 service layer가 현재 사용자 id를 DB 컨텍스트에서 읽을 수 있도록 `current_app_user_id()` helper와 `app.user_id` GUC를 깐다.

```sql
CREATE OR REPLACE FUNCTION current_app_user_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;
```

Step 2에서 `withOrgContext`가 `app.org_id`와 함께 `app.user_id`를 설정하고, `denyForManagerNonTeam(...)` helper가 memberships.team_id를 조회해 같은 팀 mutation만 허용한다.

### 5.9 인덱스·정책 정밀화 (Step 1 plan에서)

| 테이블 | 인덱스 |
|---|---|
| `knowledge_chunks` | `(org_id, knowledge_base_id)` + `(org_id) WITH (lists=100)` 등 ivfflat / hnsw |
| `org_call_checklist_templates` | `(org_id, sort_order) WHERE active` |
| `call_checklist_items` | `(call_id)` (UNIQUE 자동) + `(org_id, status) WHERE status='open'` |
| `call_suggestions` | `(call_id, group_seq)` (UNIQUE 자동) + `(org_id, created_at DESC)` |

`calls`의 새 인덱스: `(org_id, last_seen_at) WHERE status='in_progress'` (heartbeat sweep용)

---

## 6. Current Mock/API Boundary

> 본 섹션은 Phase 5 진입 직전 (2026-05-12) 시점의 mock/API 경계. Phase 5 완료 시점에는 표 아래 `(demo / mock)` 행이 모두 `(API / 실데이터)`로 이동해야 한다.

### `platform/live.html`

| 영역 | 출처 | Phase 5에서 |
|---|---|---|
| Transcript 발화 (`text_chunk` echo) | Phase 0.5 fixture | 실 STT (Clova) → transcripts append |
| AI Suggestion 카드 | Phase 0.5 fixture (서버 push) | LLM (Claude) + RAG knowledge_chunks 결과 |
| Sentiment (감정·관심도·단계) | Phase 0.5 fixture | LLM 분석 결과 |
| 고객 카드 (김민수 · Kloser Inc. · CTO) | client HTML hardcode | customer picker로 선택한 `/customers/:id` 응답 |
| 통화 meta (유형 / 번호 / 상담원) | client HTML hardcode | calls 행 + customer 행 결합 |
| 상담 체크리스트 5항목 | client HTML hardcode | `org_call_checklist_templates` + `call_checklist_items` |
| 빠른 응대 멘트 3개 | client HTML hardcode | LLM이 통화 컨텍스트 기반 생성 |
| 음소거 / 대기 / 종료 버튼 | 종료만 wire (Phase 4) | 음소거 / 대기는 Phase 6+ |
| WS heartbeat | 없음 | 20초 주기 발신 + `last_seen_at` 갱신 |

### `platform/calls.html`

| 영역 | 출처 | Phase 5에서 |
|---|---|---|
| 상세 패널 — 통화 요약·니즈·이슈·감정 | NULL 또는 사용자 수동 입력 (Phase 4) | LLM 자동 생성 (endCall enqueue) |
| 상세 패널 — 다음 액션 (read-only) | Phase 4 list | mutation UI 추가 (작성·완료·삭제) |
| 상세 패널 — Transcript | transcripts SELECT | Phase 5에서 stt_provider 라벨 부착 |
| Suggestion 이력 | 없음 | `call_suggestions` 결과 — 어떤 추천이 떴고 사용·기각됐는지 |

### `platform/settings.html`

| 영역 | 출처 | Phase 5에서 |
|---|---|---|
| 회사 가이드 / FAQ 관리 | UI 자체 없음 | knowledge_bases CRUD 패널 신설 (admin) |
| 상담 체크리스트 관리 | UI 자체 없음 | checklist_templates CRUD 패널 신설 (admin) |

### `platform/dashboard.html`

| 영역 | 출처 | Phase 5에서 |
|---|---|---|
| KPI 4장 + 최근 통화 5건 | `/dashboard/summary` (Phase 4) | org-wide 유지. manager team-scope read/report는 Phase 6+로 분리 |
| To-Do / 시장 트렌드 / 팀 활동 | demo | demo 유지 (Phase 6+) |

---

## 7. Phase 4 인계 항목 반영

Phase 4 findings (`PHASE_4_STEP_5_FINDINGS.md` §7)에서 Phase 5 진입 시 처리하기로 한 항목:

1. **WS disconnect → `dropped` 자동 마킹** — 본 phase Step 1·2에서 도입 (`calls.last_seen_at` + heartbeat service + cron sweep)
2. **`live.html` 좌측 고객 카드 / 통화 meta 정적** — 본 phase Step 4 customer picker로 해결
3. **action item / transcript 작성 UI** — 본 phase Step 4
4. **`calls.html` 정렬 미지원** — 백엔드 schema 변경 + UI 정렬 컨트롤. 본 phase는 schema 추가 적고 정렬 컨트롤은 후속 (Phase 6+ 운영 polish)
5. **dashboard `오늘 통화` UTC 기준** — Phase 6+ org timezone 도입 시 해결
6. **`live.html` `callState` 비노출** — Step 4에서 dev-only `window.__liveCallState` 노출 추가 (Phase 5 e2e용)
7. **cleanup이 superuser 역할 의존** — Phase 4 e2e cleanup 패턴 그대로 유지 (`kloser_service`에 phase 5 신규 테이블 grant도 부여 안 함 — anonymous 흐름 없음)

---

## 8. 완료 기준 (Phase 5 전체 — go/no-go gate)

다음을 모두 만족하면 Phase 5 종료, Phase 6 (운영 도메인 + SMTP + MFA + activity log + retention enforce + 결제)로 착수.

- [ ] `npm --prefix server run typecheck` PASS
- [ ] `npm --prefix server test` PASS — Phase 4의 212 + 신규 ~70~80 = 누적 ~280~290
- [ ] `node test/phase_0_5_e2e.mjs` 16/16 회귀 PASS
- [ ] `node test/phase_2_customers_e2e.mjs` 7/7 회귀 PASS
- [ ] `node test/phase_3_e2e.mjs` 33 assertion 회귀 PASS
- [ ] `node test/phase_4_e2e.mjs` 8 시나리오 회귀 PASS
- [ ] `node test/phase_5_e2e.mjs` 10~12 시나리오 + cleanup sweep PASS
- [ ] `node test/sync_shared_types.mjs` PASS (14 entity)
- [ ] 8 신규/보강 마이그레이션 적용 + raw SQL로 RLS FORCE + pgvector + `current_app_user_id()` helper 검증
- [ ] STT mock adapter로 transcripts 적층 / LLM mock adapter로 summary 생성 / Embedding mock으로 chunk ingest 모두 e2e에서 검증
- [ ] **manager가 자기 팀 통화만 mutation 가능** (service-layer team-scope) — 다른 팀 통화 변경은 403
- [ ] **knowledge / checklist template CRUD viewer/employee/manager 모두 403** (admin only)
- [ ] **WS disconnect 60초 후 `dropped` 자동 마킹**
- [ ] **customer picker로 통화에 고객 연결** + `customer_linked_at` / `customer_linked_by_user_id` 기록
- [ ] **endCall 직후 자동 요약** (BullMQ 워커) + summary_generated_at / summary_source='ai' 기록
- [ ] **AGENTS.md innerHTML XSS gate 위반 0건** — LLM 응답 DOMPurify 경유
- [ ] `docs/plan/phase-5/PHASE_5_STEP_1~5_FINDINGS.md` 모두 작성
- [ ] `docs/USER_GUIDE_PHASE_5.md` + `docs/product/PHASE_5_FOUNDATIONS.html` 작성
- [ ] `docs/product/USER_GUIDE.html` 실 브라우저 캡처 기반 재작성 (Phase 5 완료 시점)
- [ ] 루트 `README.md` + `server/README.md` 상태 블록 Phase 5 완료로 갱신

하나라도 실패하면 해당 step에 머문다.

---

## 9. 한 줄 요약 + 바로 다음 작업

> **3~4주 동안 5개 sub-step으로 외부 STT/LLM/Embedding adapter + RAG + 체크리스트·suggestion·knowledge base 영속화 + disconnect heartbeat + customer 연결 + manager team-scope 권한을 schema-first 순서로 깔아서, 통화 안에 흐르는 *내용*까지 진짜로 만든다.**

### 바로 다음 작업

1. **본 master plan 사용자 리뷰** — 사전 결정 25개 / step 분해 5개 / 권한 매트릭스 / 종료 게이트가 모두 사용자 의도와 일치하는지 확인
2. **Step 1 plan 검토** — `docs/plan/phase-5/PHASE_5_STEP_1_SCHEMA.md` (본 작업에서 작성). 컬럼·인덱스·RLS 정책·pgvector 도입 패턴의 최종 확정
3. **Step 1 구현 진입** — 마이그레이션 작성 + raw SQL 검증. 본 작업에서는 진입하지 않는다 (계획만)

### 본 master plan 작성 후 후속 (코드/마이그레이션/테스트는 아직 작성 안 함)

- 본 master plan 사용자 리뷰 통과 → Step 1 구현 단계로 이동
- master plan 변경 요청 들어오면 본 문서 직접 갱신 → 다시 리뷰
- AGENTS.md Phase Workflow 위반 (UI부터 만들기 등) 발생 시 본 plan으로 즉시 복귀

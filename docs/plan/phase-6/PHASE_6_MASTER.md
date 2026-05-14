# Phase 6 — Production runtime + real providers + ops gap closure 마스터 플랜

> **상위 계획**: `docs/plan/roadmap/BACKEND_PLAN.md` v0.4 — 본 Phase는 BACKEND_PLAN의 "Phase 6 — Daily / Newsletter / Integrations" 항목을 **Phase 5 종료 인계 우선순위로 재정의**한다. Phase 5 findings §7이 새 우선순위 표를 정본으로 둔다.
> **선행 단계**: Phase 5 종료 — `docs/plan/phase-5/PHASE_5_STEP_5_FINDINGS.md` (2026-05-13 PASS).
> **워크플로**: `AGENTS.md` "Phase Workflow" 5단계 (schema → repo + test → routes + types + test → frontend → e2e + findings)를 준수한다. 단, 본 Phase는 schema 변경이 있는 sub-step(Step 2)에만 5단계를 적용하고, schema 변경이 없는 sub-step(Step 1·3·4)은 service/route/frontend/e2e 단계만 거친다.
> **기간**: 3~4주 (sub-step 단위 분해).

---

## 0. 진행 상태 (Implementation Log)

> 이 섹션은 sub-step 진행 시 갱신된다. 각 sub-step은 `PHASE_6_STEP_X_*.md` 문서에서 상세 설계.

- [x] **Step 1** — Worker infrastructure + AI summary 자동 생성 + 60s heartbeat sweep cron + WS suggestion persistence (mock providers, schema 무변경) — 2026-05-12 완료, `PHASE_6_STEP_1_FINDINGS.md` 참조
- [x] **Step 2** — 실 provider client (Clova STT + Anthropic LLM + OpenAI Embedding) + `llm_usage_log` 신규 테이블 + cost log — 2026-05-13 완료, `PHASE_6_STEP_2_FINDINGS.md` 참조 (sub-unit: `PHASE_6_STEP_2_SCHEMA_FINDINGS.md` / `PHASE_6_STEP_2_WIRING_FINDINGS.md` / `PHASE_6_STEP_2_PROVIDER_FINDINGS.md`). Residual: `cost_usd_micros`는 현재 NULL — model→price map은 별도 cost-accuracy commit으로 분리. `phase_4_e2e` / `phase_5_e2e` 회귀는 Step 5 통합 e2e 또는 Codex review 시점에 일괄 검증.
- [x] **Step 3** — Action item DELETE endpoint + frontend 삭제 UI (hard delete 채택, schema 무변경) — 2026-05-13 완료, `PHASE_6_STEP_3_FINDINGS.md` 참조
- [x] **Step 4** — Manager team-scope read/report 화면 (`GET /reports/team-summary` + `platform/reports.html`, schema 무변경) — 2026-05-13 완료, `PHASE_6_STEP_4_FINDINGS.md` 참조. `sync_shared_types` 14 → 15 (`teamReport` 신규).
- [x] **Step 5** — Phase 6 통합 e2e + 종합 findings + Phase 7 인계 — 2026-05-14 완료, `PHASE_6_STEP_5_FINDINGS.md` 참조. `test/phase_6_e2e.mjs` 7 시나리오 + cleanup PASS, Phase 0.5/2/3/4/5 회귀 PASS. `platform/live.html`에서 viewer role gate를 적용해 Phase 3 e2e의 pre-existing 403 console error를 제거. Phase 7+ 인계는 `PHASE_7_HANDOFF.md`.

---

## 1. 왜 Phase 6인가

Phase 5까지 깔린 토대:

- 회사 가이드 / 체크리스트 / suggestion / heartbeat / customer link / manual summary가 **schema → repo → route → frontend → e2e** 5층 모두 닫혀 있다.
- 단, 실제 운영 루프는 미완성: **AI 요약 자동 생성**, **suggestion DB persistence**, **disconnect 60초 자동 dropped 마킹**이 모두 service helper만 있고 호출자가 없다.
- 실 외부 provider(Clova / Anthropic / OpenAI)는 adapter mock만 wire되어 있고 실 client는 resolver의 throw branch에 묶여 있다.
- Action item 삭제는 master plan에 명시됐으나 endpoint와 UI가 부재 (Step 4 finding §5.1).
- Manager team-scope mutation 권한은 service layer로 닫혔지만, "자기 팀 통화만 보이는" 보고서 화면이 없어 매니저가 자기 통화/팀 통화를 분리해 보려면 별도 도구가 필요.

Phase 6은 위 네 영역만 닫는다. 운영 도메인(SMTP/MFA/audit/retention/결제/bulk import/다국어/timezone/SSO/녹취)은 본 Phase에서 다루지 않는다 — Phase 7+로 미룬다. 본 Phase가 끝나면 SaaS 운영 출시 직전 단계(SMTP/결제 등 외부 의존성 도입 + 인증 강화)로 넘어갈 수 있다.

핵심 산출물:

1. **BullMQ + Redis 기반 워커 인프라** + workers 엔트리 프로세스.
2. **AI summary 자동 생성 워커** — endCall이 큐에 작업을 넣고 워커가 LLM(mock)을 호출해 `calls.summary/needs/issues/sentiment`를 채운다. manual summary 보호는 Phase 5 repo SQL이 이미 처리.
3. **60s heartbeat sweep cron** — `last_seen_at < now() - 60s AND status='in_progress'` 통화를 `dropped/server_timeout`으로 마감.
4. **WS suggestion persistence hook** — text_chunk 흐름 중 LLM(mock) 호출 결과를 `call_suggestions`에 INSERT하고 클라이언트에 id 포함 카드 발사.
5. **실 provider 어댑터 3종** + `llm_usage_log` 테이블 + cost log.
6. **Action item DELETE** — backend endpoint + frontend 삭제 컨트롤.
7. **Manager team-scope read 보고서** — 자기 팀 통화 통계 / KPI / 리스트.

---

## 2. 범위 (Scope)

### 한다

**Worker + cron (Step 1)**
- `server/src/queue/` 모듈 (ioredis + BullMQ producer/consumer 헬퍼)
- `server/src/workers/` 엔트리 + 개별 워커
- `services/calls.ts` `endCall` 후크에 큐 enqueue
- `services/callHeartbeat.ts` 의 multi-org sweep 추가
- `ws/calls.ts` `text_chunk` 핸들러에 mock LLM 호출 + persist 후크 + suggestion 이벤트 재발사

**Real provider clients (Step 2)**
- `adapters/stt/clova.ts` (gRPC 또는 REST)
- `adapters/llm/anthropic.ts` (`@anthropic-ai/sdk`)
- `adapters/embedding/openai.ts` (`openai` SDK)
- 어댑터 resolver의 `throw` branch 채움
- `.env.example`에 `CLOVA_*` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` 추가 (`.env` 무수정)
- `llm_usage_log` 신규 테이블 + RLS + 워커 finished hook

**Action item DELETE (Step 3)**
- `DELETE /call-action-items/:id` endpoint
- Service `deleteActionItem(actor, id)` + assertCanMutateCall
- Repository — hard delete 또는 soft delete(컬럼 추가) 결정
- `calls.html` detail 패널 row에 삭제 버튼

**Manager team-scope reports (Step 4)**
- `GET /reports/team-calls?team_id=...` 또는 `GET /dashboard/team` 신설
- Manager가 본인 team의 통화만 조회. admin은 전체. employee/viewer는 자기 통화만.
- 화면: `platform/dashboard.html` 섹션 신설 또는 별 `platform/reports.html` (계획서에서 결정).

**E2E (Step 5)**
- `test/phase_6_e2e.mjs` — 6~8 시나리오 (Step 1~4 통합)
- Phase 5 e2e 회귀

### 안 한다 (Phase 7+로 미룸)

- **SMTP / Resend 실 adapter** — Phase 3 dev outbox 그대로.
- **MFA / 2FA / WebAuthn** — Phase 7+.
- **activity_log 표 + 감사 로그** — Phase 7+ ops 위생.
- **retention enforce cron** (Transcript 3년 / call_recordings 90일 삭제) — Phase 7+ ops.
- **결제·구독 흐름** (Stripe / Toss / `organizations.plan` 기반 cap) — Phase 7+ commercial.
- **bulk knowledge import** (CSV / Word / PDF parser) — Phase 7+ enterprise.
- **다국어 transcript** (영어 / 일본어) — Phase 7+ i18n.
- **`organizations.timezone`** + dashboard "오늘" 회사 TZ 기준 — Phase 7+ i18n.
- **enterprise SSO (Keycloak)** — Phase 7+ enterprise.
- **call_recordings 오디오 파일 + S3/MinIO** — Phase 7+ (Phase 5 master plan §1 명시).
- **dashboard / live.html UI polish** (정적 demo 필드 → API 전환) — Phase 7+ UX.

### 본 Phase에서 결정 보류 (sub-step plan에서 확정)

| 항목 | 후보 | 결정 시점 |
|---|---|---|
| Heartbeat sweep 주체 | (a) BullMQ repeatable job, (b) setInterval inside worker, (c) node-cron | Step 1 plan |
| Sweep 시 사용할 DB role | (a) 새 `worker` role + 추가 grant, (b) `kloser_service` 재사용, (c) `app` role + cross-org loop | Step 1 plan |
| Demo WS replay 제거 vs. 유지 | (a) Step 1에서 fixture replay 제거, (b) env flag로 토글, (c) 그대로 두고 persisted 카드와 공존 | Step 1 plan |
| Cost log granularity | (a) per-job row, (b) per-org daily aggregate | Step 2 plan |
| Action item 삭제 모델 | (a) hard delete, (b) `call_action_items.deleted_at` 신규 컬럼 | Step 3 plan |
| Manager 보고서 위치 | (a) dashboard.html 섹션, (b) reports.html 신설 | Step 4 plan |

---

## 3. 사전 결정 (Phase 6 시작 전 확정)

| # | 항목 | 결정 | 근거 |
|---|---|---|---|
| 1 | 큐 인프라 | **BullMQ + Redis** (Phase 1 docker-compose에 이미 깔림) | BACKEND_PLAN §9 / Phase 5 master plan §2 결정 18 |
| 2 | 워커 실행 단위 | 별도 Node 프로세스 (`server/src/workers/index.ts` 엔트리) | dev에서는 `npm run dev:worker`, prod에서는 systemd unit |
| 3 | 워커 ↔ DB 연결 | 워커도 `db/pool.ts` 동일 pool 사용. org-scoped writes는 `app` role + `withOrgContext` 동일 패턴. multi-org sweep의 org id 목록 조회만 `organizations`가 RLS 비적용 테이블인 점을 이용해 내부 worker repository에서 `SELECT id FROM organizations`로 수행한다. 이 helper는 route/service 공개 API로 노출하지 않는다. | Step 1 plan §시스템 sweep 한정 결정 |
| 4 | mock provider 강제 환경변수 | `STT_PROVIDER=mock` / `LLM_PROVIDER=mock` / `EMBEDDING_PROVIDER=mock` 우선. 실 provider는 `.env`에 키가 있을 때만 활성 | Step 3 resolver의 throw 자리에서 분기 |
| 5 | 실 provider client 도입 시점 | Step 2. Step 1에서는 mock 그대로 사용 | Step 1·2 분리해 실패 표면 줄임 |
| 6 | LLM cost cap | `llm_usage_log` 테이블 → 일일 cap은 Phase 7+ (이번 Phase에서는 기록만 함) | dev에서 cost 폭주 막는 hard limit는 별도 PR |
| 7 | 워커 실패 시 calls 상태 | Phase 5 결정 9 그대로 — graceful degrade. summary NULL 유지. retry는 BullMQ exponential backoff 3회 후 dead-letter | summary는 통화 종결을 막지 않음 |
| 8 | Phase 5 e2e 회귀 정책 | Phase 5 e2e는 워커 없는 상태에서도 PASS 해야 한다 (mock-only adapter + manual summary 경로만 테스트). Phase 6 워커는 e2e와 독립 프로세스 | 워커가 dev 머신에서 안 떠 있어도 Phase 5 e2e는 통과해야 함 |
| 9 | 워커 실행 중 e2e 회귀 | `phase_5_e2e.mjs`가 워커 실행 중에 돌아도 통과해야 한다. summary_source='manual' 보호가 이미 SQL에 있으므로 race 안전 | Phase 5 Step 2 repo guard 재확인 |
| 10 | RLS / 마이그레이션 | Step 1: 변경 0건. Step 2: `llm_usage_log` 신규 테이블 (RLS FORCE). Step 3: 결정에 따라 `call_action_items` 컬럼 추가 가능. Step 4: 변경 0건 | AGENTS.md 준수 |
| 11 | Action item delete 권한 | `assertCanMutateCall` 동일 — admin / manager-team / employee-own | 일관성 유지 |
| 12 | Manager 보고서 cross-org | 조회 endpoint는 본 org만. `current_app_org_id()` RLS 그대로 사용 | Phase 5 결정 17 유지 |
| 13 | Manager 보고서 read-scope 매트릭스 | admin → 전체 org, manager → 자기 team만, employee → 자기 통화만, viewer → 자기 org read | Phase 5 §4 권한 매트릭스의 read read-scope 정밀화 |
| 14 | XSS gate | Phase 5 동일. LLM 응답 / server 필드 모두 escapeHtml or DOMPurify | AGENTS.md innerHTML gate |
| 15 | shared types 정책 | 신규 entity 등장 시 server zod + browser JSDoc + sync registry 3축 패턴 | Phase 5 동일 |
| 16 | Phase 6 e2e prefix | `phase6-e2e-` | Phase 5 prefix `phase5-e2e-`와 분리 |

---

## 4. Sub-step 분해 (실행 순서)

> **순서 엄격**: AGENTS.md Phase Workflow §3. Schema 변경이 있는 step은 schema → repo+test → route+types+test → frontend → e2e. 변경이 없는 step은 service → route → frontend → e2e.

### Step 1 — Worker infrastructure + AI summary auto + heartbeat sweep + WS suggestion persistence (3~4일)

**목표**: BullMQ + Redis 기반 워커 인프라가 부팅되고, endCall 후 AI 요약이 비동기로 생성되며, disconnect 60초 후 통화가 자동 dropped로 마감되고, live 통화 중 LLM(mock)이 suggestion을 영속한다.

**Schema 변경**: 없음. Phase 5 Step 1에서 이미 모든 컬럼/테이블 마련 완료.

**산출물**:
- `server/src/queue/redis.ts` — ioredis connection
- `server/src/queue/queues.ts` — BullMQ 큐 정의
- `server/src/queue/index.ts` — enqueue helper export (`enqueueCallSummary({ orgId, callId })`)
- `server/src/workers/callSummary.worker.ts`
- `server/src/workers/heartbeatSweep.worker.ts`
- `server/src/workers/index.ts` — runner entry point
- `server/src/services/calls.ts` 보강 — endCall transaction commit 이후 best-effort enqueue
- `server/src/services/callHeartbeat.ts` 보강 — multi-org sweep helper
- `server/src/ws/calls.ts` 보강 — text_chunk 시 LLM mock 호출 + persistSuggestionGroup + suggestion 이벤트 재발사
- `server/package.json` — `worker:dev` script
- `server/.env.example` — `REDIS_URL` 확인
- 단위/통합 테스트 — `server/test/phase6_workers.test.mjs` (~15~20 케이스)

**완료 기준**:
- 워커 프로세스 부팅 OK
- endCall 호출 시 큐에 `{ orgId, callId }` job 1건 추가, 워커가 org context 안에서 transcript를 모아 mock LLM 응답으로 summary 채움 (`summary_source='ai'`)
- manual summary 이후 AI 워커가 row를 덮어쓰지 못함 (`summary_source='manual'` 보호 검증)
- 60초 heartbeat cutoff sweep이 stale 통화를 `status='dropped' / dropped_reason='server_timeout'`로 마킹
- text_chunk push 시 `call_suggestions` 1 row INSERT + WS `suggestion` 이벤트가 id를 포함해 클라이언트로 발사
- `npm test` 회귀 + Phase 5 e2e 회귀 PASS

### Step 2 — Real provider clients + `llm_usage_log` (3~4일)

**목표**: Mock 자리에 Clova / Anthropic / OpenAI 실 client를 끼우고, 호출 단위 cost를 `llm_usage_log` 표에 기록한다.

**Schema 변경**:
- `llm_usage_log` 신규 테이블 — `id`, `org_id`, `call_id` (nullable), `provider`, `model`, `tokens_in`, `tokens_out`, `latency_ms`, `cost_usd_micros`, `created_at`. RLS FORCE on `org_id = current_app_org_id()`. INSERT은 워커가 `app` role + `withOrgContext`.

**산출물**:
- `server/migrations/<ts>_phase6_llm_usage_log.sql`
- `server/src/adapters/stt/clova.ts`
- `server/src/adapters/llm/anthropic.ts`
- `server/src/adapters/embedding/openai.ts`
- `server/src/adapters/index.ts` — resolver branches 채움
- `server/src/services/llmUsage.ts` — 워커 finished hook에서 log INSERT
- `server/src/repositories/llmUsage.ts`
- 단위 테스트 — adapter mock-only, real provider는 contract 테스트(env가 있을 때만) 분리
- `.env.example` — `CLOVA_INVOKE_URL`, `CLOVA_SECRET_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` 추가

**완료 기준**:
- mock-only 모드(`*_PROVIDER=mock`)에서 모든 e2e + 단위 테스트 PASS
- `.env`에 키가 있을 때만 실 provider 활성. 키 없으면 mock으로 fallback
- 워커 job finished hook이 `llm_usage_log`에 1행 INSERT
- 실 provider 호출 cost가 log에 기록되어 운영 admin이 SELECT로 확인 가능

### Step 3 — Action item DELETE (1.5~2일)

**목표**: action item에 hard delete (또는 soft delete) endpoint와 UI를 추가해 Phase 5의 master plan "작성·완료·삭제"를 닫는다.

**Schema 변경**: 결정에 따라 선택
- (a) hard delete: 변경 없음
- (b) soft delete: `call_action_items.deleted_at timestamptz` 컬럼 + 모든 read query에 `WHERE deleted_at IS NULL` 추가

**산출물**:
- (b일 경우) `server/migrations/<ts>_phase6_action_items_soft_delete.sql`
- `server/src/repositories/callActionItems.ts` 보강 — delete (hard 또는 soft)
- `server/src/services/calls.ts` 또는 신규 service — `deleteActionItem(actor, id)` + `assertCanMutateCall`
- `server/src/routes/calls.ts` 또는 `callsPhase5.ts` — `DELETE /call-action-items/:id`
- `platform/calls.html` — detail 패널 row에 삭제 버튼
- 단위/route 테스트 — admin / manager-team / employee-own / employee-other / viewer / cross-org

**완료 기준**:
- DELETE endpoint 200/204 (success) + 403 (cross-team) + 404 (cross-org) 매트릭스 정확
- 프런트엔드 삭제 컨트롤 + 404/403 UI 처리
- 회귀 PASS

### Step 4 — Manager team-scope read/report (2~2.5일)

**목표**: 매니저가 자기 팀 통화만 보는 화면이 등장. read-scope를 service layer가 좁힌다(RLS는 본 org 그대로).

**Schema 변경**: 없음 (memberships.team_id로 충분).

**산출물**:
- `server/src/services/teamReports.ts` — team-scope KPI 계산. admin/manager/employee/viewer 분기.
- `server/src/routes/reports.ts` (또는 `dashboard.ts` 보강) — `GET /reports/team-summary?team_id=...`
- `server/src/types/teamReport.ts` + `platform/types/teamReport.js` + sync_shared_types entity 등록 (15 → 16)
- `platform/dashboard.html` 섹션 또는 신규 `platform/reports.html`
- 단위/route 테스트

**완료 기준**:
- manager가 자기 팀의 통화 카운트/완료율/평균 통화 시간을 본다
- manager가 다른 팀 team_id를 query에 넣어도 403 (service helper 차단)
- admin은 모든 team 조회 가능
- employee/viewer는 자기 통화만 보이는 경로 (또는 endpoint 미노출)
- 회귀 PASS

### Step 5 — Phase 6 통합 e2e + 종합 findings + Phase 7 인계 (1.5~2일)

**목표**: 4개 step이 함께 작동하는 e2e + 종합 보고.

**산출물**:
- `test/phase_6_e2e.mjs` — 6~8 시나리오, `phase6-e2e-` prefix:
  - 워커 boot + endCall enqueue + AI summary 자동 채움
  - heartbeat sweep cutoff 후 dropped 마킹 (테스트 가속용 짧은 cutoff env 또는 fake clock)
  - WS text_chunk 시 `call_suggestions` 1 row 발생
  - action item DELETE 200/404/403
  - manager 보고서 team-scope read
  - 실 provider 분기 — `*_PROVIDER=mock` 강제 (실 키 사용 안 함)
  - cleanup sweep + residue 0
- `docs/plan/phase-6/PHASE_6_STEP_5_E2E.md` + `_FINDINGS.md`
- 각 sub-step `_FINDINGS.md`
- `PHASE_6_MASTER.md` 체크박스 동기화
- 루트 `README.md` + `server/README.md` 상태 갱신
- `docs/USER_GUIDE_PHASE_6.md` (있다면 갱신)

**완료 기준**:
- 새 e2e PASS
- Phase 0.5 / 2 / 3 / 4 / 5 e2e 회귀 PASS
- `npm test` 회귀 PASS
- `sync_shared_types` 회귀 PASS

---

## 5. 권한 매트릭스 (Phase 6 시점, Phase 5 위에 추가)

| Role | calls read | 본인 통화 write | 같은 팀 통화 write | 다른 팀 통화 write | action item delete | manager 보고서 read | knowledge / template / `llm_usage_log` |
|---|---|---|---|---|---|---|---|
| **admin** | org-wide | ✓ | ✓ | ✓ | ✓ | 전체 team | CRUD (admin) / read |
| **manager** | org-wide (Step 5+에서 좁힐 수 있음) | ✓ | ✓ | ✗ | ✓ (자기 팀) | 자기 team | knowledge/template read / `llm_usage_log` read (자기 org) |
| **employee** | org-wide | ✓ | ✗ | ✗ | ✓ (본인 통화) | 자기 통화만 | read |
| **viewer** | org-wide | ✗ | ✗ | ✗ | ✗ | 자기 org KPI(있다면) | read |

> 본 Phase 4까지의 RLS 그대로. mutation 좁힘은 service layer가 책임. read 좁힘은 Step 4 service helper가 처리.

---

## 6. 데이터 모델 변경 요약

| 표 | 변경 | step |
|---|---|---|
| `llm_usage_log` | 신규 (id, org_id, call_id, provider, model, tokens_in, tokens_out, latency_ms, cost_usd_micros, created_at) + RLS FORCE | Step 2 |
| `call_action_items` | (옵션) `deleted_at timestamptz` 컬럼 추가 — Step 3 결정 | Step 3 |
| 기타 | 변경 없음 | — |

---

## 7. 테스트 전략

### 7.1 sub-step 별

- **Step 1**: 단위 — BullMQ producer/consumer + workers는 in-process queue로 테스트 (BullMQ + redis-mock 또는 실 Redis). text_chunk hook은 ws 단위 테스트에 1 케이스 추가.
- **Step 2**: 단위 — 실 provider 호출은 `process.env.E2E_ALLOW_REAL_PROVIDERS=1` 일 때만 활성, 평소 PR에서는 skip. mock 어댑터 단위 테스트는 그대로 유지.
- **Step 3**: 단위 + route — 권한 매트릭스 + 4xx 매트릭스.
- **Step 4**: 단위 + route — team-scope read 분기 검증. UI는 e2e에서 확인.
- **Step 5**: e2e — 위 4 step 통합.

### 7.2 회귀

- 모든 sub-step 종료 시점에:
  - `npm --prefix server run typecheck`
  - `npm --prefix server test`
  - `node test/sync_shared_types.mjs`
  - `node test/phase_4_e2e.mjs`
  - `node test/phase_5_e2e.mjs`
- `phase_5_e2e.mjs`는 워커 OFF 환경에서도 PASS 한다 (Phase 5 결정 8 그대로).

### 7.3 워커 테스트 vs e2e

- 워커는 별도 process. e2e에서는 BullMQ jobs를 inline으로 처리하는 helper(`drainQueue()` 등) 또는 `npm run dev:worker`를 별 process로 띄우고 e2e가 그 process가 살아있는지 health check.
- Step 5 e2e plan에서 둘 중 하나를 결정.

---

## 8. Cleanup 전략

Phase 5 cleanup 패턴을 그대로 확장.

| Phase | prefix |
|---|---|
| Phase 4 | `phase4test-` |
| Phase 5 unit | `phase5test-` |
| Phase 5 e2e | `phase5-e2e-` |
| Phase 6 unit | `phase6test-` |
| Phase 6 e2e | `phase6-e2e-` |

- `phase6-e2e-` prefix 기반 sweep — `phase_5_e2e`와 동일 구조.
- `llm_usage_log` 도 cleanup 대상에 포함. cost log가 누적되지 않도록 모든 e2e 실행 후 prefix-scoped 제거.
- 좌석 시드(admin/emp@acme, admin/emp@beta + customers/memberships/teams) — 본 Phase에서도 절대 건드리지 않는다.

---

## 9. Phase 5 e2e 회귀 유지 계약

본 Phase의 모든 변경은 `phase_5_e2e.mjs`를 깨뜨리지 않아야 한다. 점검 항목:

1. **Step 1 워커 ON 상태**에서 phase_5_e2e가 시나리오 3에서 manual summary를 저장한다. 워커가 AI summary로 덮어쓰려 해도 `summary_source='manual'` SQL guard가 막는다. 이미 Phase 5 Step 2 repo가 검증된 영역.
2. **Step 1 heartbeat sweep ON 상태**에서 phase_5_e2e는 통화를 short-lived로 만들고 endCall로 명시 종료한다. 60초 cutoff 전에 ended 상태가 되므로 sweep 대상 아님.
3. **Step 1 WS suggestion hook ON 상태**에서 phase_5_e2e의 시나리오 2 (live 통화)는 text_chunk를 보내지 않는다 (실제 STT 없음). 즉 mock LLM이 호출되지 않으므로 새 suggestion row가 생기지 않음. 시나리오 4는 여전히 psql 시드로 우회.
4. **Step 2 real provider ON 상태**에서도 phase_5_e2e는 `*_PROVIDER=mock`을 강제. 본 Phase의 e2e도 동일.
5. **Step 3 action item DELETE 추가** 시 phase_5_e2e의 action item create/toggle 시나리오는 그대로 동작. 삭제 컨트롤이 새로 추가될 뿐, 기존 토글 시나리오는 깨지지 않음.
6. **Step 4 manager team-scope 보고서 추가** 시 phase_5_e2e의 employee/admin 시나리오는 영향 없음. 새 endpoint는 RBAC 추가만.

---

## 10. 위험 요소와 보류 항목

### 10.1 위험

- **Real LLM cost 폭주** — Step 2 도입 시 dev 머신에서 무한 retry로 cost 폭주 가능. Step 1에서 BullMQ retry 횟수를 명확히 캡(3회 + 백오프). Step 2 plan에서 `llm_usage_log` 일일 cap을 dev-only 가드로 추가할지 결정.
- **워커 inline e2e 처리 vs 별 process** — inline은 빠르지만 운영과 거리감, 별 process는 운영과 비슷하지만 e2e 부팅 비용 큼. Step 5 e2e plan에서 결정.
- **WS suggestion persistence + demo replay 충돌** — Phase 0.5 fixture가 그대로 살아있어 라이브 카드와 LLM 카드가 동시 노출될 수 있음. Step 1 plan에서 demo replay 제거 또는 env flag 결정.
- **Heartbeat sweep race** — 워커가 통화를 dropped로 마킹하는 순간 사용자가 endCall을 누르면 SQL CHECK 위반 위험 (status='dropped' → 'ended'). Step 1 plan에서 sweep SQL WHERE 조건과 endCall SQL의 충돌 검토.
- **action item delete 권한** — assertCanMutateCall이 manager team-scope를 강제하지만, 본인이 작성한 다른 사람 통화의 action item을 삭제할 수 있는지 시나리오 명확화 필요. Step 3 plan에서.

### 10.2 보류 / Phase 7+

- SMTP / Resend
- MFA / WebAuthn
- activity_log + 감사
- retention enforce (90일/3년)
- 결제 (Stripe/Toss)
- bulk knowledge import
- 다국어
- organizations.timezone
- enterprise SSO (Keycloak)
- call_recordings (오디오 파일 + S3/MinIO)
- dashboard / live.html UI polish (정적 demo 필드 → API 전환)

---

## 11. 완료 기준 (Phase 6 전체 — go/no-go gate)

다음을 모두 만족하면 Phase 6 종료, Phase 7 (운영 도메인 + SMTP + MFA + activity_log + retention + 결제 + i18n) 진입.

- [x] `npm --prefix server run typecheck` PASS — Step 2 closeout 시점 PASS, Step 5 재검증 시점도 PASS
- [x] `npm --prefix server test` PASS (Phase 5 결과 + 신규 Phase 6 단위 + 워커 통합) — Step 5 재검증 `381 pass / 3 skipped / 0 fail` (total 384). skipped 3은 Phase 6 Step 2의 real-provider opt-in (`E2E_ALLOW_REAL_PROVIDERS` 미설정).
- [x] `node test/phase_0_5_e2e.mjs` 회귀 PASS — Step 5에서 PASS (`PHASE_6_STEP_5_FINDINGS.md §4`)
- [x] `node test/phase_2_customers_e2e.mjs` 회귀 PASS — Step 5에서 PASS
- [x] `node test/phase_3_e2e.mjs` 회귀 PASS — `platform/live.html` viewer role gate 적용 후 PASS
- [x] `node test/phase_4_e2e.mjs` 회귀 PASS — 1번째 실행에서 historical race(`Failed to fetch`) 1건, 2번째 즉시 PASS. Phase 6 코드 무관 (`PHASE_6_STEP_5_FINDINGS.md §9.2`)
- [x] `node test/phase_5_e2e.mjs` 회귀 PASS — inline worker drain 사용. 별 process worker가 없으므로 "워커 ON" 별도 실행은 의미 없음 (Step 5 plan §6 명시 기록)
- [x] `node test/phase_6_e2e.mjs` 7 시나리오 + cleanup PASS — Step 5 산출물 (`PHASE_6_STEP_5_FINDINGS.md §3`)
- [x] `node test/sync_shared_types.mjs` PASS — Step 4 closeout 시점 **15 entity** (Step 2 → 14, Step 4 `teamReport` +1). master 초기 문구의 "16 entity 목표"는 본 closeout에서 실제 결과 15로 정정. Step 4 산출물이 의미상 하나의 entity (`teamReport`)에 자연스럽게 묶여 가짜 entity를 추가하지 않았다.
- [x] BullMQ 워커 boot + AI summary 자동 + heartbeat sweep + WS suggestion persistence 작동 — Step 1 + Step 2 wiring
- [x] 실 provider 어댑터 3종 인터페이스 충족 + `llm_usage_log` 1행 INSERT 검증 — Step 2 완료. 단 `cost_usd_micros`는 현재 NULL (Step 2 plan §2 허용, `PHASE_6_STEP_2_FINDINGS.md §6.1` residual)
- [x] Action item DELETE endpoint + UI 동작 — Step 3 완료 (`PHASE_6_STEP_3_FINDINGS.md`)
- [x] Manager team-scope read 보고서 + 권한 매트릭스 검증 — Step 4 완료. 14 케이스 권한/엣지 매트릭스 검증 (`PHASE_6_STEP_4_FINDINGS.md §4·§7`).
- [x] AGENTS.md innerHTML XSS gate 위반 0건 — Step 3 (calls.html ✕ 버튼) + Step 4 (reports.html 최근 통화 표) 모두 escapeHtml 또는 textContent 처리. Step 5 재검증 시점에도 0건 (`PHASE_6_STEP_5_FINDINGS.md §6`).
- [x] `docs/plan/phase-6/PHASE_6_STEP_1~5_FINDINGS.md` 모두 작성 — Step 1·2(`SCHEMA`/`WIRING`/`PROVIDER` 3분할)·3·4·5 모두 완료
- [x] 루트 `README.md` + `server/README.md` 상태 블록 Phase 6 완료로 갱신 — Step 5 closeout 시점 일괄 처리

하나라도 실패하면 해당 sub-step에 머문다.

---

## 12. 한 줄 요약 + 바로 다음 작업

> **3~4주 동안 5개 sub-step으로 Phase 5의 mock-backed adapter 자리를 실 worker + 실 provider로 닫고, 미완성이던 action item DELETE와 manager team-scope read 화면을 마저 깐다. Phase 6은 운영 출시 직전까지의 마지막 코어 작업 — 운영 도메인(SMTP/MFA/audit/retention/결제)은 본 Phase 범위 밖.**

### 바로 다음 작업

Phase 6 완료. 다음 단계는 Phase 7 (운영 출시 직전 게이트) — `docs/plan/phase-6/PHASE_7_HANDOFF.md` §15 권고 순서:

1. **§1 SMTP / Resend 실 adapter** (P0)
2. **§2 MFA / 세션 강화** (P0)
3. **§3 activity_log + 감사 로그** (P0)
4. **§4 retention enforce cron** (P0)
5. **§6 `llm_usage_log` cost model→price map** (P1, Step 2 residual 해소)
6. **§7 role-based sidebar nav 가시성** (P1, Step 4 residual 해소)
7. **§8 보고서 날짜 윈도우 / 상담원 drilldown** (P1)
8. **§9 demo-to-real frontend 정리** (P1)
9. **§5 결제·구독 흐름** (P1)
10. **§10·§11·§12·§13** — Phase 8+로 이관 가능

# Phase 4 — Calls + Dashboard 마스터 플랜

> **상위 계획**: `docs/plan/roadmap/BACKEND_PLAN.md` v0.4 §8 Phase 4.
> **선행 단계**: Phase 3 완료 — `docs/plan/phase-3/PHASE_3_MASTER.md` + `docs/plan/phase-3/PHASE_3_STEP_7_FINDINGS.md`.
> **워크플로**: `AGENTS.md` "Phase Workflow" 5단계 (schema → repo + test → routes + types + test → frontend → e2e + findings)를 따른다. UI부터 먼저 만들지 않는다.
> **기간**: 2~2.5주 (sub-step 단위로 분해).

---

## 진행 상태 (Implementation Log)

> 이 섹션은 sub-step 진행 시 갱신된다. 본 plan은 master로, 각 sub-step은 별도 `PHASE_4_STEP_X_*.md` 문서에서 상세 설계.

- [x] **Step 1** — Schema (`calls` / `transcripts` / `call_action_items`) + RLS + 인덱스 + app grants → `PHASE_4_STEP_1_SCHEMA.md` + `PHASE_4_STEP_1_FINDINGS.md` (2026-05-12 완료, demo seed는 schema-only 지시에 따라 후속 결정)
- [ ] **Step 2** — Repository + unit tests (calls / transcripts / action items 저장소, RLS 격리 증명, soft delete 동작) → `PHASE_4_STEP_2_REPO.md` (계획 작성됨)
- [ ] **Step 3** — Route layer (`/calls` REST + `/dashboard/summary` + WebSocket 영속 hook) + shared types + route tests
- [ ] **Step 4** — Frontend wiring (live.html 영속 hook 추가 / calls.html mock 제거 → 실 API / dashboard.html mock 제거 → 실 KPI)
- [ ] **Step 5** — Phase 4 통합 e2e + Phase 4 종합 findings

---

## 0. 왜 Phase 4인가

Phase 1~3까지 갖춰진 것:

- 인증·조직 격리·권한·세션·실시간 연결 (Phase 1)
- 첫 비즈니스 entity인 고객 CRUD (Phase 2)
- 자가 가입·이메일 인증·비밀번호 복구·동료 초대·팀/멤버 관리 (Phase 3)

평가자가 자기 손으로 가입해 동료를 모은 다음, **실제 통화를 영속 저장**해서 다시 보고 분석할 수 있게 만드는 단계가 Phase 4다. Phase 0.5 spike에서 실시간 WebSocket 흐름은 이미 동작하지만, 그 흐름이 끝나면 데이터가 메모리에서 사라진다. Phase 4는 그 사라짐을 막고, 끝난 통화를 대시보드와 통화 기록 화면에서 다시 보게 한다.

핵심 산출물:

1. **`calls` / `transcripts` / `call_action_items` 영속 저장** — Phase 0.5의 실시간 이벤트가 끝나면 DB에 남는다
2. **`/calls` REST API** — 목록·상세·필터·검색·종료 후 메모 갱신
3. **`/dashboard/summary` API** — 오늘 통화 수 / 응답률 / 평균 통화 / LIVE 통화 수 / 최근 통화 5건
4. **`platform/live.html` 영속 hook** — start_call/transcript/end_call 흐름이 DB에 commit
5. **`platform/calls.html` mock 제거** — in-page 8건 array → 실 API
6. **`platform/dashboard.html` mock 제거** — 정적 KPI 4장 + 최근 통화 5건 → 실 데이터
7. **`customers.last_contacted_at` 자동 갱신** — call 종료 시점에 해당 고객의 마지막 연락 시각이 업데이트

이걸 다 끝내고 나면 Phase 5 (실제 STT / AI 응대 추천 / 통화 후 자동 요약)로 넘어간다.

---

## 1. 범위 (Scope)

### 한다

**스키마 (Step 1)**

- `calls` 신규 — 통화 세션 (org_id, customer_id, agent_user_id, direction, status, started_at, ended_at, duration_seconds, summary, sentiment, soft delete)
- `transcripts` 신규 — 발화 단위 (call_id, org_id 비정규화, seq, speaker, text, start_ms/end_ms, confidence)
- `call_action_items` 신규 — 통화 후 다음 액션 (call_id, org_id, title, due_date, assignee_user_id, status)
- 모든 신규 테이블 RLS FORCE ENABLE (Phase 1·2·3 패턴)
- 인덱스 설계 — list / per-customer / per-agent / open-action-items 4 패턴
- seed: 시드 고객 기반 통화 fixture는 schema-only Step 1에서 제외. repository/routes/UI 진입 시점에 필요한 형태로 후속 결정

**서버 (Step 2~3)**

- `server/src/repositories/calls.ts` — 저장소 + 단위 테스트
- `server/src/repositories/transcripts.ts` — append + range read + cleanup
- `server/src/repositories/callActionItems.ts` — CRUD + assignee 변경
- `server/src/services/calls.ts` — start/end/summary 트랜잭션 + `customers.last_contacted_at` 동시 갱신
- `server/src/routes/calls.ts` — `GET /calls`, `GET /calls/:id`, `GET /calls/:id/transcript`, `POST /calls/:id/notes`, `POST /calls/:id/end`
- `server/src/routes/dashboard.ts` — `GET /dashboard/summary` (org-scoped, today 기준)
- `server/src/ws/persistence.ts` — `start_call` ack 시 calls 행 생성, `text_chunk` event 시 transcripts 행 append, `end_call` 시 calls update + customer.last_contacted_at 갱신
- `server/src/types/{call,transcript,actionItem,dashboard}.ts` zod 원본 + `platform/types/<entity>.js` JSDoc 사본 + `test/sync_shared_types.mjs` registry 4 entity 추가

**클라이언트 (Step 4)**

- `platform/live.html` — start_call ack에서 call_id 받아 보관, 종료 시 `/calls/:id/end` 호출 + 메모 폼 wiring
- `platform/calls.html` — in-page `calls` array 제거, `kloserApi.apiGet('/calls?...')` 호출 + detail panel 실 데이터 + 필터·검색은 URL 동기화 (Phase 2 customers.html 패턴 따름)
- `platform/dashboard.html` — KPI 4장 + 최근 통화 5건만 실 API. To-Do / 시장 트렌드 / 팀 활동은 demo 유지 (각각 Phase 5 / 6 / 4+ 영역, 본 phase 범위 외)
- `platform/types/{call,transcript,actionItem,dashboard}.js` JSDoc 사본
- 미인증 배너(`renderUnverifiedBanner`)를 dashboard / calls 두 페이지에도 wire (Phase 3 Step 6 인계 항목)

**검증 (Step 5)**

- 서버 단위 테스트 — calls repo / transcripts repo / action items repo / calls service / WS persistence / dashboard summary / RLS 격리 / soft delete 동작
- viewer / employee / manager / admin 권한 매트릭스 단위 테스트 (calls는 자기 조직 read OK / write 권한은 결정 §13 참조)
- Phase 4 통합 e2e — 시드 user 로그인 → live.html 들어가 통화 시작 → 종료 후 calls.html에 등장 확인 → detail panel → dashboard.html KPI 반영 → 다른 org user로 로그인해서 자기 조직 데이터만 보임 확인
- Phase 0.5 e2e 16/16 + Phase 2 customers e2e 7/7 + Phase 3 e2e 33/33 회귀

### 안 한다 (Phase 5+로 미룸)

**실제 STT (Naver Clova / Whisper)** — Phase 4 시점 transcript 원천은 Phase 0.5 fixture 또는 수동 입력. 실제 음성 인식 어댑터는 Phase 5.

**AI 통화 요약 / 응대 추천 자동 생성** — Phase 4의 `calls.summary`는 NULL 또는 사용자 수동 입력. 자동 생성(Claude / OpenAI)은 Phase 5.

**call_checklist / ai_suggestions 영속화** — 본 phase 범위 외. live.html의 정적 체크리스트 5항목 / AI suggestion 카드는 현재 in-page 또는 WebSocket fixture로 유지. 영속화는 Phase 5 (실 AI와 함께).

**knowledge_bases / knowledge_chunks** — RAG용 회사 가이드 영속 저장. Phase 5+.

**call_recordings (오디오 파일)** — 파일 스토리지·암호화·retention 정책 결정 필요. Phase 5+.

**대시보드 To-Do / 시장 트렌드 / 팀 활동** — 각각 daily todos / trend_snapshots / activity_log 영역. Phase 5+ (daily) 또는 Phase 4+ (activity).

**행 클릭으로 고객 상세 → 통화 history 결합** — customers.html에서 행 클릭 시 그 고객의 통화 목록·요약·노트가 한 패널에 결합되는 UI. Phase 4 범위 외 (REST 자체는 본 phase에서 깔리지만 UI 결합은 Phase 5).

**Bulk export (CSV / Excel)** — `통화 기록 내보내기` 버튼은 settings.html에 노출돼 있으나 미구현. Phase 6+ 운영 단계.

**Activity log / 감사 로그** — Phase 2 Step 5 deferred 항목. Phase 4 범위 외, 별도 운영 위생 step.

**Manager 보고서 / 팀 KPI** — admin/manager 전용 팀 단위 KPI 화면. Phase 4 범위 외 (Phase 5 manager track).

---

## 2. 사전 결정 (Phase 4 시작 전 확정)

| # | 항목 | 결정 | 근거 |
|---|---|---|---|
| 1 | 스키마 진입 순서 | **`calls` → `transcripts` → `call_action_items`** 순서로 단일 forward-only migration 4개 (테이블 3 + grant 1) | Phase 1·3 패턴 일관. `customers` 변경은 컬럼 추가 0건 (`last_contacted_at`은 이미 Phase 2에 존재) |
| 2 | `transcripts.org_id` 비정규화 | **YES** — `calls.org_id`와 동기. RLS 정책이 JOIN 없이 transcripts.org_id 단독으로 평가하고 `(org_id, call_id)` composite FK가 drift를 차단 | Phase 3 `auth_tokens.org_id` 동일 패턴. 조회 빈도 높고 JOIN 비용 회피 |
| 3 | soft delete 정책 | `calls.deleted_at` + 부분 인덱스. `transcripts` / `call_action_items`는 부모(calls) CASCADE — 독립 soft delete 없음 | Phase 2 customers 패턴. 통화 자체가 운영 감사 대상이라 보존, 발화/액션은 통화 종속 |
| 4 | 통화 종료 후 최종 상태 | `status='ended' / 'missed' / 'dropped'` 셋. `in_progress`는 진행 중에만 | Phase 0.5 spike에서 `dropped` (네트워크 끊김) 케이스 발생 — 별도 status 필요 |
| 5 | `customers.last_contacted_at` 갱신 | **call 종료 시 service 레이어에서 같은 트랜잭션 안에 UPDATE.** trigger 미사용 | trigger는 디버깅 어려움. service 레이어 명시적 갱신이 흐름 명확. `WHERE customer_id IS NOT NULL AND (last_contacted_at IS NULL OR call.ended_at > last_contacted_at)` |
| 6 | `calls.summary` 위치 | calls 본 행에 컬럼 — `summary text`, `sentiment text`, `needs text`, `issues text` | 1:1 관계 + lazy AI 처리도 같은 행 UPDATE로 충분. `call_summaries` 분리 테이블은 향후 다버전(AI / 사람) 동시 보존이 필요해지면 도입 |
| 7 | `call_action_items` 분리 | **분리 테이블 — 1:N.** 통화 1건당 액션 여러 개, 담당자 지정 + 상태 변경이 별개 라이프사이클 | 향후 personal todo 화면이 이 테이블에서 SELECT 받아 갈 entry point. `jsonb[]`로 두면 작성 후 수정 비용 큼 |
| 8 | `call_action_items.assignee_user_id` ON DELETE 정책 | `(org_id, assignee_user_id) REFERENCES memberships(org_id, user_id) ON DELETE SET NULL (assignee_user_id)` | 담당자 떠나도 action item 자체는 보존 — 미할당 상태로. Membership composite FK로 다른 org 사용자 할당 차단 |
| 9 | `transcripts` append 정책 | **`seq INT NOT NULL`, `UNIQUE(call_id, seq)`** — server-side counter로 발급 | 동시 append 없음 (call 한 번에 한 클라이언트). server가 `MAX(seq)+1` 발급 또는 sequence per call. 자세한 패턴은 Step 2 plan에서 |
| 10 | WebSocket 영속 hook 책임 | **server-side `ws/persistence.ts`가 connect 후 listener로 wire — UI 클라이언트가 영속 호출 안 함.** WS 메시지 처리 핸들러가 동일 트랜잭션 단위로 DB write | 클라이언트가 별도 REST 호출하면 race·중복 위험. server-side에서 단일 출처 |
| 11 | dashboard summary 구현 | **단일 endpoint `GET /dashboard/summary`** — 5~6 KPI를 단일 응답. 서버에서 미리 집계 | 각 KPI마다 별도 endpoint는 dashboard 로딩 N+1 요청 발생. Phase 2 `/customers/stats` 패턴과 일관 |
| 12 | dashboard "오늘" 기준 시간대 | **org의 timezone 컬럼이 없으므로 Phase 4 시점은 server timezone (UTC) 기준 today.** 향후 `organizations.timezone` 도입은 Phase 6+ | i18n / 타임존 처리는 별도 영역. 본 phase의 보고 정확성 trade-off는 Step 1·3에서 명시 |
| 13 | calls / transcripts mutation 권한 | **모든 role이 자기 org의 calls를 read 가능. write (POST notes / end_call)는 `agent_user_id`인 본인 + admin/manager.** viewer는 모든 write 403. employee는 본인 통화만 write | Phase 2 customers와 다른 패턴 — calls는 본인 통화라는 강한 소유 의식. 매니저는 팀 통화 검토 권한 필요. 자세한 매트릭스는 §4 |
| 14 | manager team-scope 권한 | **Phase 4에서는 도입하지 않음.** "매니저는 자기 팀 통화만" 정책은 Phase 5 (manager 보고서와 같이) | Phase 3 §13 인계. team-scope 추가 시 `manager` role + `memberships.team_id` 조합 정책 4개를 모든 신규 테이블 RLS에 추가해야 — 같이 묶는 게 효율적 |
| 15 | shared types 패턴 | **Phase 2·3 동일 — `server/src/types/<entity>.ts` zod 원본 + `platform/types/<entity>.js` JSDoc 사본 + `test/sync_shared_types.mjs` registry 1줄 추가**. 본 phase에서 `call`, `transcript`, `action-item`, `dashboard` 4개 entity 등록 | AGENTS.md Frontend Conventions와 일관 |
| 16 | `plan` 단어 재사용 금지 | **enforce.** `organizations.plan`은 Kloser 자체 구독 단계. 본 phase 신규 컬럼·필드명에 `plan` 절대 재사용 안 함. 통화 후 다음 단계는 `next_actions` 또는 `action_items`, 통화 종류는 `direction` 등 | AGENTS.md Backend Conventions § |
| 17 | retention 정책 표면화 | **DB 컬럼·정책으로는 표현하지 않음.** settings.html UI에 표시되는 "통화 녹음 90일 / Transcript 3년 / 통신비밀보호법 5년"은 운영 위생으로 cron 또는 시점 정리로 Phase 6+ 도입 | retention enforce를 DB 트리거로 박으면 디버깅 어려움. Phase 4 시점은 무기한 보존 (settings 화면 표시는 demo) |
| 18 | seed 정책 | dev seed에 시드 user 별 통화 10~15건 + transcript 5~10발화/통화 + action item 2~3개/통화. e2e 진입 직후 시각 검증 가능 | UI 진입 시 빈 화면이 아닌 실 데이터로 즉시 확인 |
| 19 | dashboard `오늘 통화` KPI 정의 | `calls.started_at >= today_start_utc()` AND `deleted_at IS NULL` | 단순·일관. 진행 중 통화도 today 통화 수에 포함 |
| 20 | `response_rate` KPI 정의 | `(status='ended' 통화 수) / (status IN ('ended','missed') 통화 수)` — 응답률은 ended/(ended+missed). dropped는 분모 제외 (네트워크 오류는 응답 의지와 무관) | settings dashboard 라벨 "응답률"의 의도와 일치 |

---

## 3. Sub-step 분해 (실행 순서)

> **순서 엄격**: AGENTS.md Phase Workflow §3. UI부터 만들지 않는다. Step N이 통과해야 Step N+1로 간다.

### Step 1 — Schema 보강 (1.5~2일)

**목표**: `calls` / `transcripts` / `call_action_items` 3개 테이블이 RLS FORCE + 인덱스 + grant까지 깨끗이 깔린다. Demo seed는 schema-only 지시에 따라 후속 step에서 결정한다.

**산출물**:
- `server/migrations/<ts>_phase4_calls.sql` — `calls` 테이블 + RLS 4 정책 + 인덱스 4
- `server/migrations/<ts>_phase4_transcripts.sql` — `transcripts` 테이블 + RLS 4 정책 + 인덱스 2
- `server/migrations/<ts>_phase4_call_action_items.sql` — `call_action_items` 테이블 + RLS 4 정책 + 인덱스 2
- `server/migrations/<ts>_phase4_grants.sql` — `app` role grant 추가 (calls / transcripts / call_action_items SELECT/INSERT/UPDATE/DELETE)
- `server/seeds/0004_phase4_demo.sql` — 후속 step에서 결정 (schema-only 작업에서는 미작성)
- `PHASE_4_STEP_1_SCHEMA.md` (계획서, 이번 작업에서 작성) — 컬럼·정책·인덱스 사전 결정
- `PHASE_4_STEP_1_FINDINGS.md` — 구현 결과·검증·Step 2 인계 사항

**완료 기준**:
- `npm --prefix server run db:migrate:up` PASS
- fresh DB에서 `npm --prefix server run db:migrate:up` PASS
- raw SQL (admin URL)로 3 테이블 RLS FORCE 확인
- app role + GUC 컨텍스트로 SELECT → 본 org 데이터만 노출, INSERT WITH CHECK이 cross-org 차단

### Step 2 — Repository + unit tests (1.5일)

**목표**: 3개 entity의 typed accessor가 RLS 격리 / soft delete / append (transcripts seq) / `customers.last_contacted_at` 갱신을 모두 단위 테스트로 증명.

**산출물**:
- `server/src/repositories/calls.ts` — list / getById / create / patch / softDelete / endCall (status + duration_seconds + ended_at 동시)
- `server/src/repositories/transcripts.ts` — appendForCall (seq 자동) / listByCall (seq range) / countByCall
- `server/src/repositories/callActionItems.ts` — list / create / patchStatus / patchAssignee / softDelete
- `server/src/services/calls.ts` — `endCall(client, callId)` 트랜잭션 — `UPDATE calls SET status='ended' ...` + `UPDATE customers SET last_contacted_at = GREATEST(last_contacted_at, $ended_at) WHERE id = calls.customer_id AND org_id = $org` 둘이 한 트랜잭션
- 단위 테스트 ~15~20 케이스 — cross-org 격리 / soft delete 후 SELECT 제외 / transcripts append 연속 seq / customers.last_contacted_at 갱신 / NULL customer_id 통화 (unknown caller)

**완료 기준**:
- `npm --prefix server test` 신규 ~15~20 cases PASS
- 회귀 (Phase 1~3 unit tests 155개) 모두 PASS

### Step 3 — Route + shared types + route tests (2~2.5일)

**목표**: REST + Dashboard + WebSocket 영속 hook이 권한 매트릭스 + 입력 검증 + 본 org 격리를 모두 통과.

**산출물**:
- `server/src/routes/calls.ts` — 5 endpoint (`GET /calls`, `GET /calls/:id`, `GET /calls/:id/transcript`, `POST /calls/:id/notes`, `POST /calls/:id/end`)
- `server/src/routes/dashboard.ts` — `GET /dashboard/summary`
- `server/src/ws/persistence.ts` — connect listener wiring (start_call → INSERT calls / text_chunk → INSERT transcripts / end_call → service.endCall)
- `server/src/types/{call,transcript,actionItem,dashboard}.ts` — zod 원본
- `platform/types/{call,transcript,actionItem,dashboard}.js` — JSDoc 사본
- `test/sync_shared_types.mjs` — 4 entity registry 추가
- 단위 테스트 ~20~25 케이스 — 정상 흐름 + 모든 4xx 경로 + 권한 매트릭스

**완료 기준**:
- 7 endpoints (calls 5 + dashboard 1 + WS hook 단위) 200/4xx 정확히
- viewer가 `POST /calls/:id/notes` → 403
- employee가 다른 agent 통화의 `POST /:id/end` → 403 (admin/manager만 허용 — 결정 §13)
- 다른 org 통화 ID로 mutation → 404 (존재 자체 노출 없음)
- `node test/sync_shared_types.mjs` PASS (9 entity로 늘어남)
- `npm --prefix server test` 신규 ~20~25 + 누적 ~190~200 PASS

### Step 4 — Frontend wiring (2일)

**목표**: 3개 페이지가 실 API로 동작하고, 미인증 배너가 정착.

**산출물**:
- `platform/live.html` — start_call ack에서 call_id 수신·보관, beforeunload / 종료 버튼에서 `/calls/:id/end` 호출, 메모 input → `/calls/:id/notes`. AGENTS.md innerHTML XSS gate 준수
- `platform/calls.html` — in-page `calls` array 제거, `kloserApi.apiGet('/calls?q=&filter=&sort=&page=')` 호출, detail panel은 `/calls/:id` + `/calls/:id/transcript` 결합. URL 동기화 (Phase 2 customers.html 패턴). innerHTML로 보간되는 모든 server-source 필드 escape 적용
- `platform/dashboard.html` — KPI 4장 + 최근 통화 5건만 `/dashboard/summary`로 교체. To-Do / 트렌드 / 팀 활동은 demo 유지하되 `(demo)` 라벨 코멘트 명시
- `platform/_shared.js` 보강 — `renderUnverifiedBanner`를 dashboard.html / calls.html 부팅 코드에 wire (Phase 3 Step 7 인계 항목)
- `platform/api.js` 보강 — 필요 시 calls / dashboard helper 추가

**완료 기준**:
- 브라우저 시각 검증 6 시나리오:
  1. 시드 user 로그인 → live.html 진입 → 통화 시작 → 종료 → calls.html 목록 최상단에 등장
  2. calls.html에서 row 클릭 → detail panel 요약 / transcript / action item 표시
  3. dashboard.html KPI 4장이 실 데이터 (오늘 통화 / 응답률 / 평균 / 신규)
  4. 다른 org user로 재로그인 → 자기 조직 통화만 노출
  5. viewer 권한 user 로그인 → calls.html read OK / notes 입력 시도 → 403 안내
  6. 미인증 user 로그인 → dashboard / calls 진입 시 상단 노란 띠 + 재발송 버튼 표시
- AGENTS.md innerHTML XSS gate 위반 0건 (server 응답 필드 보간은 모두 textContent 또는 escapeHtml)
- `node test/sync_shared_types.mjs` PASS

### Step 5 — 통합 e2e + 종합 findings (1일)

**목표**: 자동 회귀 + Phase 4 종료 인계.

**산출물**:
- `test/phase_4_e2e.mjs` — 8~10 시나리오: signup signed-in → start_call → transcript append → end_call → calls.html 등장 → detail panel → customers.html last_contacted_at 갱신 확인 → dashboard.html KPI 반영 → viewer 권한 차단 → 다른 org 격리 → cleanup sweep
- `PHASE_4_STEP_2_REPO.md` / `PHASE_4_STEP_3_ROUTES.md` / `PHASE_4_STEP_4_CLIENT.md` / `PHASE_4_STEP_5_E2E.md` + 각 `*_FINDINGS.md`
- 마스터 plan 체크박스 동기화
- 루트 `README.md` + `server/README.md` 상태 블록 갱신
- `docs/USER_GUIDE_PHASE_4.md` + `docs/product/PHASE_4_FOUNDATIONS.html` (Phase 1·2·3 패턴 따름)

**완료 기준**:
- 새 e2e 8~10 시나리오 PASS + cleanup sweep
- Phase 0.5 e2e 16/16 회귀 PASS
- Phase 2 customers e2e 7/7 회귀 PASS
- Phase 3 e2e 33 assertion 회귀 PASS
- master plan §완료 기준 모두 충족
- branch가 develop에 머지 가능한 상태

---

## 4. 권한 정책 초안

### Role × Action 매트릭스 (Phase 4 시점)

| Role | calls read (자기 org) | 본인 통화 write (notes / end) | 다른 사람 통화 write | calls 통화 삭제 (soft) | dashboard read |
|---|---|---|---|---|---|
| **admin** | ✓ | ✓ | ✓ | ✓ | ✓ |
| **manager** | ✓ | ✓ | ✓ | ✓ | ✓ |
| **employee** | ✓ | ✓ | ✗ (403) | ✗ | ✓ |
| **viewer** | ✓ | ✗ (403) | ✗ | ✗ | ✓ |

### 추가 보호 규칙

1. **본인 통화 판정** — `calls.agent_user_id = current_user_id()`. employee가 자기 통화에만 mutation. admin/manager는 무관.
2. **cross-org 격리** — RLS 4 정책 (SELECT/INSERT/UPDATE/DELETE)이 `org_id = current_app_org_id()` 강제. 다른 org calls ID로 시도 → 404.
3. **soft delete** — 모든 read query는 `WHERE deleted_at IS NULL`이 적용된 부분 인덱스를 사용. 삭제는 admin/manager만.
4. **WS persistence** — start_call / text_chunk / end_call 이벤트의 socket.user 정보를 server-side에서 calls.agent_user_id로 박음. 클라이언트가 임의의 agent_user_id로 위조 불가.

### Phase 5+에서 도입 예정

- **manager team-scope** — 자기 팀 통화만 read+write (현재는 자기 org 전체)
- **employee self-scope** — 자기 담당 고객 통화만 (현재는 자기 통화만)
- **call_recordings 권한** — 오디오 파일 read는 별도 권한 (개인정보)
- **activity_log 결합** — mutation 별로 누가 무엇을 언제 했는지 추적

---

## 5. 데이터 모델 후보

> **사전 결정**: 본 섹션은 Step 1 schema plan(`PHASE_4_STEP_1_SCHEMA.md`)에서 정밀화. 본 master는 골격만 제시.

### 5.1 신규 — `calls`

```sql
CREATE TABLE calls (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id         uuid,
  agent_user_id       uuid,
  direction           text NOT NULL CHECK (direction IN ('inbound','outbound','meeting')),
  status              text NOT NULL CHECK (status IN ('in_progress','ended','missed','dropped')),
  started_at          timestamptz NOT NULL DEFAULT now(),
  ended_at            timestamptz,
  duration_seconds    int,
  title               text,
  summary             text,
  needs               text,
  issues              text,
  sentiment           text CHECK (sentiment IN ('positive','neutral','cautious','negative') OR sentiment IS NULL),
  notes               text,
  deleted_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, customer_id)
    REFERENCES customers(org_id, id) ON DELETE SET NULL (customer_id),
  FOREIGN KEY (org_id, agent_user_id)
    REFERENCES memberships(org_id, user_id) ON DELETE SET NULL (agent_user_id)
);

ALTER TABLE calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE calls FORCE ROW LEVEL SECURITY;
```

부분 인덱스 4개: list `(org_id, started_at DESC) WHERE deleted_at IS NULL` / per-customer `(org_id, customer_id, started_at DESC) WHERE deleted_at IS NULL` / per-agent `(org_id, agent_user_id, started_at DESC) WHERE deleted_at IS NULL` / filter `(org_id, status) WHERE deleted_at IS NULL`.

### 5.2 신규 — `transcripts`

```sql
CREATE TABLE transcripts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id       uuid NOT NULL,
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  seq           int NOT NULL,
  speaker       text NOT NULL CHECK (speaker IN ('agent','customer','system')),
  text          text NOT NULL,
  start_ms      int,
  end_ms        int,
  confidence    numeric(4,3),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id, seq),
  FOREIGN KEY (org_id, call_id) REFERENCES calls(org_id, id) ON DELETE CASCADE
);

ALTER TABLE transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcripts FORCE ROW LEVEL SECURITY;
```

인덱스 2개: append/read `(call_id, seq)` (UNIQUE에 의해 자동) + RLS scan helper `(org_id, created_at)`.

### 5.3 신규 — `call_action_items`

```sql
CREATE TABLE call_action_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id           uuid NOT NULL,
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title             text NOT NULL,
  due_date          date,
  assignee_user_id  uuid,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dropped')),
  completed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, call_id) REFERENCES calls(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, assignee_user_id)
    REFERENCES memberships(org_id, user_id) ON DELETE SET NULL (assignee_user_id)
);

ALTER TABLE call_action_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_action_items FORCE ROW LEVEL SECURITY;
```

인덱스 2개: per-call `(call_id)` + open-by-assignee `(org_id, assignee_user_id, status) WHERE status='open'`.

### 5.4 보강 — `customers.last_contacted_at`

이미 Phase 2 schema에 존재. Phase 4는 service 레이어가 call 종료 시 같은 트랜잭션에서 갱신.

### 5.5 인덱스·RLS 정책 설계 (Step 1로 위임)

각 신규 테이블에 SELECT / INSERT WITH CHECK / UPDATE USING+WITH CHECK / DELETE 4 정책. service-role(`kloser_service`)은 본 phase 신규 테이블에 access 부여하지 않음 — anonymous 흐름 없음 (Phase 3의 verify/reset/accept와 달리 calls는 모두 인증된 흐름).

---

## 6. Current Mock/API Boundary

> 본 섹션은 Phase 4 진입 직전 (2026-05-11) 시점의 audit 결과. Phase 4 Step 4 후에는 calls/dashboard 페이지의 (demo) 행이 (API)로 이동해야 한다.

### `platform/live.html`

| 영역 | 출처 | 분류 |
|---|---|---|
| `/me` 호출 (인증 게이트) | server | **(API)** |
| 미인증 배너 (`renderUnverifiedBanner`) | server `/me` 응답 | **(API)** |
| WebSocket 연결 (`kloserWS.connectCallNamespace`) | server (Phase 0.5) | **(API)** |
| 통화 timer (실시간 카운터) | client (`Date.now()` 차이) | **(real)** — 컴퓨트 |
| 통화 latency `latencyVal` | WebSocket RTT | **(API)** |
| Transcript 발화 bubbles | WebSocket `transcript` event — 서버에 Phase 0.5 fixture | (mixed: 전송은 API, 컨텐츠는 server-side fixture) |
| AI Suggestions 카드 | WebSocket `suggestion` event — server fixture | (mixed) |
| Sentiment (감정 / 관심도 / 단계) | WebSocket `sentiment` event — server fixture | (mixed) |
| 고객 카드 (`김민수 · Kloser Inc. · CTO`) | client HTML hardcode | **(demo)** |
| 통화 meta (유형 / 번호 / 상담원 / 캡처 품질) | client HTML hardcode | **(demo)** |
| 상담 체크리스트 5항목 | client HTML hardcode | **(demo)** |
| 빠른 응대 멘트 3개 | client HTML hardcode | **(demo)** |
| 음소거 / 대기 / 종료 버튼 핸들러 | 없음 (UI 데모) | **(demo — no handler)** |

→ Phase 4 Step 4 변경: 종료 버튼이 `/calls/:id/end` 호출, 노트 input이 `/calls/:id/notes` 호출. 고객 카드는 customer_id 전달받아 `/customers/:id`로 채움. 통화 meta는 calls 행에서 가져옴. 체크리스트는 본 phase 범위 외 (Phase 5).

### `platform/dashboard.html`

| 영역 | 출처 | 분류 |
|---|---|---|
| 오늘 날짜 표시 | client (`new Date()`) | **(real)** — 컴퓨트 |
| 인사 "좋은 아침, 김민수님 ☀️" | client HTML hardcode | **(demo)** |
| 오늘 17개 To-Do / 3건 미팅 안내 | client HTML hardcode | **(demo)** |
| KPI 카드 4장 (오늘 통화 23 / 응답률 82.6% / 평균 11m24s / 신규 4) | client HTML hardcode | **(demo)** |
| 시장 트렌드 알림 5건 | client HTML hardcode | **(demo)** |
| 오늘의 추천 To-Do 6건 (`todos` array) | client array | **(demo)** |
| 최근 통화 5건 (`recent` array) | client array | **(demo)** |
| 팀 활동 5건 | client HTML hardcode | **(demo)** |
| 알림 버튼 + 빨간 점 | `_shared.js` static notif data | **(demo)** |

→ Phase 4 Step 4 변경: KPI 4장 + 최근 통화 5건이 `/dashboard/summary` 응답에서 채워짐. 인사·To-Do·트렌드·팀 활동은 demo 유지하되 코드 상단에 `(demo)` 라벨 코멘트.

### `platform/calls.html`

| 영역 | 출처 | 분류 |
|---|---|---|
| 헤더 "총 1,243건" | client HTML hardcode | **(demo)** |
| 통화 목록 8건 (`calls` in-page array) | client array | **(demo)** |
| 검색·필터 chips (전체/오늘/이번 주/완료/미완료/후속 필요) | client array filter | **(demo)** |
| Detail panel (요약 / 니즈 / 이슈 / 액션 / Transcript / 태그) | client array | **(demo)** |
| 알림 버튼 | `_shared.js` static | **(demo)** |
| `(보안)` Detail panel `dActions` / `dTranscript` `innerHTML` 보간 | client array 직접 보간 | **(XSS 잠재 — Phase 4 Step 4에서 escape 적용 필수)** |

→ Phase 4 Step 4 변경: 전체 `calls` array 제거 → `GET /calls?...` 호출. detail panel은 `GET /calls/:id` + `GET /calls/:id/transcript`. innerHTML 보간 자리는 모두 textContent 또는 `escapeHtml` 경유. URL 동기화는 Phase 2 customers.html 패턴 따름.

---

## 7. Phase 3 인계 항목 반영

Phase 3 findings에서 Phase 4 진입 시 처리하기로 한 항목:

1. **미인증 user의 cross-user write 차단 (`requireVerified` 미들웨어)** (Phase 3 master §304 + USER_GUIDE_PHASE_3 §201) — **본 phase에서 도입.** calls 관련 mutation (notes / end / soft delete) + dashboard summary는 verified 필수 / read는 자유. 미들웨어는 `server/src/middleware/requireVerified.ts`로 분리.
2. **미인증 배너를 logged-in 페이지 전반에 wire** (Phase 3 Step 7 findings) — calls / dashboard 두 페이지를 본 phase Step 4에서 wire. 나머지 daily / settings / newsletter는 Phase 4 시점에 같이 처리할지 별 step으로 뺄지는 Step 4에서 결정 (1줄 추가라 묶어도 무해).
3. **`kloser_service` DELETE grant 부재** (Phase 3 Step 7 finding) — **본 phase에서 grant 표 손대지 않음.** calls는 anonymous 흐름 없음 → service role 안 씀. 영향 0.
4. **forward-only migration** — 본 phase의 4개 신규 migration 모두 새 timestamp. 기존 amend 0건.
5. **e2e cleanup 약속** — Phase 4 e2e는 prefix `phase4test-` 사용 + finally sweep 검증.
6. **shared types 패턴** — Phase 2·3 패턴 그대로 — call / transcript / actionItem / dashboard 4 entity 등록.
7. **`customers.plan` 단어 재사용 금지** — Phase 4 신규 컬럼에 `plan` 0건.

---

## 8. 완료 기준 (Phase 4 전체 — go/no-go gate)

다음을 모두 만족하면 Phase 4 종료, Phase 5 (실 STT + AI 응대 추천)로 착수.

- [ ] `npm --prefix server run typecheck` PASS
- [ ] `npm --prefix server test` PASS — Phase 3의 155 + 신규 ~35~45 = 누적 ~190~200
- [ ] `node test/phase_0_5_e2e.mjs` 16/16 회귀 PASS
- [ ] `node test/phase_2_customers_e2e.mjs` 7/7 회귀 PASS
- [ ] `node test/phase_3_e2e.mjs` 33 assertion 회귀 PASS
- [ ] `node test/phase_4_e2e.mjs` 8~10 시나리오 + cleanup sweep PASS
- [ ] `node test/sync_shared_types.mjs` PASS (9 entity: customers + signup + password-reset + team + invitation + call + transcript + actionItem + dashboard)
- [ ] 4 신규 마이그레이션 적용 + raw SQL로 RLS FORCE 검증
- [ ] 신규 endpoints 모두 200/4xx 정확히 — `GET/POST /calls` 계열 5 + `GET /dashboard/summary` + WS persistence hooks
- [ ] **viewer의 calls mutation → 403 / employee의 다른 agent 통화 mutation → 403**
- [ ] **cross-org calls ID로 mutation → 404 (존재 노출 없음)**
- [ ] **call 종료 시 `customers.last_contacted_at` 동시 갱신** (단위 + e2e 둘 다 검증)
- [ ] **미인증 user의 calls mutation → 403 `email_not_verified`** (`requireVerified` 적용)
- [ ] **`platform/calls.html` mock 제거** — in-page `calls` array 0건
- [ ] **`platform/dashboard.html` KPI 4장 + 최근 통화 5건 실 데이터** (정적 demo 영역은 코멘트로 라벨)
- [ ] **`platform/live.html` start/end/notes 영속 hook** 동작
- [ ] **AGENTS.md innerHTML XSS gate 위반 0건** — 모든 server-source 보간이 textContent 또는 escapeHtml 경유
- [ ] `docs/plan/phase-4/PHASE_4_STEP_1~5_FINDINGS.md` 모두 작성됨
- [ ] `docs/USER_GUIDE_PHASE_4.md` + `docs/product/PHASE_4_FOUNDATIONS.html` 작성됨
- [ ] 루트 `README.md` + `server/README.md` 상태 블록 Phase 4 완료로 갱신

하나라도 실패하면 해당 step에 머문다.

---

## 9. 한 줄 요약 + 바로 다음 작업

> **2~2.5주 동안 5개 sub-step으로 calls/transcripts 영속화 + dashboard 실 KPI 전환을 schema-first 순서로 깔아서, 통화 끝난 뒤 다시 보고 분석할 수 있는 첫 운영 데이터 흐름을 완성한다.**

### 바로 다음 작업

1. **본 master plan 사용자 리뷰** — 사전 결정 20개 / step 분해 5개 / 권한 매트릭스 / mock/API audit / 종료 게이트가 모두 사용자 의도와 일치하는지 확인
2. **Step 1 plan 검토** — `docs/plan/phase-4/PHASE_4_STEP_1_SCHEMA.md` (본 작업에서 작성). 컬럼·인덱스·RLS 정책의 최종 확정.
3. **Step 1 구현 진입** — 마이그레이션 + 시드 작성 + raw SQL 검증. 본 작업에서는 진입하지 않는다 (계획만).

### 본 master plan 작성 후 후속 (코드/마이그레이션/테스트는 아직 작성 안 함)

- 본 master plan 사용자 리뷰 통과 → Step 1 구현 단계로 이동
- master plan 변경 요청 들어오면 본 문서 직접 갱신 → 다시 리뷰
- AGENTS.md Phase Workflow 위반 (UI부터 만들기 등) 발생 시 본 plan으로 즉시 복귀

# Phase 5 — Step 2 Findings (Repository + Service + Unit Tests)

> **완료일**: 2026-05-12
> **범위**: `withOrgContext` overload + `calls` / `transcripts` Phase 5 컬럼 projection + 5 신규 repository (`knowledgeBases` / `knowledgeChunks` / `callChecklistTemplates` / `callChecklistItems` / `callSuggestions`) + 7 신규 service (`callPermissions` / `knowledge` / `callChecklist` / `callSuggestions` / `callHeartbeat` / `customerLinkage` / `callSummary`) + orgContext / repository / service 단위 테스트 43건 추가. 라우트 / shared types / 프론트엔드 / 실제 STT·LLM adapter / e2e 추가 0건 (계획서 §7 비-목표 준수).

---

## 1. 적용 파일

신규 (14개):

- `server/src/repositories/knowledgeBases.ts`
- `server/src/repositories/knowledgeChunks.ts`
- `server/src/repositories/callChecklistTemplates.ts`
- `server/src/repositories/callChecklistItems.ts`
- `server/src/repositories/callSuggestions.ts`
- `server/src/services/callPermissions.ts`
- `server/src/services/knowledge.ts`
- `server/src/services/callChecklist.ts`
- `server/src/services/callSuggestions.ts`
- `server/src/services/callHeartbeat.ts`
- `server/src/services/customerLinkage.ts`
- `server/src/services/callSummary.ts`
- `server/test/phase5_repositories.test.mjs`
- `server/test/phase5_services.test.mjs`

수정 (5):

- `server/src/plugins/db.ts` — `WithOrgContext`를 interface로 바꾸고 `(orgId, userId, fn)` 오버로드 추가. 기존 `(orgId, fn)` 호출자는 수정 없음.
- `server/src/repositories/calls.ts` — `Call` 인터페이스에 Phase 5 컬럼 6개 추가, `CALL_COLUMNS` 확장, heartbeat / sweep / linkCustomer / updateAiSummary / updateManualSummary 5개 함수 추가.
- `server/src/repositories/transcripts.ts` — `Transcript` projection에 `stt_provider` / `stt_session_id` 추가, `TranscriptAppendInput` 확장.
- `server/test/orgContext.test.mjs` — `withOrgContext` 오버로드 회귀 6 케이스 추가.
- `docs/plan/phase-5/PHASE_5_MASTER.md` — Step 2 완료 체크 + 결과 요약.

수정 안 함: `server/src/routes/*`, `server/src/types/*`, `platform/*`, `platform/types/*`, `test/sync_shared_types.mjs`, 실제 외부 어댑터, BullMQ worker, e2e 스크립트, `server/.env`.

---

## 2. 핵심 결정 재확인

| # | 항목 | 결정 (구현) |
|---|---|---|
| 2-1 | `withOrgContext` signature | interface로 정의된 2-form / 3-form overload. 구현부는 callback이 두 번째 인자인지로 분기 (`typeof userIdOrFn === "function"`) |
| 2-2 | `app.user_id` 미설정 의미 | `current_app_user_id()` → NULL. RLS는 user id를 사용하지 않음. 2-arg 호출에서 `app.user_id` GUC 미설정 |
| 2-3 | manager team-scope 적용 위치 | `services/callPermissions.assertCanMutateCall` — RLS 정책 변경 없음 |
| 2-5 | write 권한 기본 규칙 | admin: allow, viewer: deny, employee: 자기 call only, manager: 같은 팀 + non-null team_id |
| 2-7 | same-team 판정 | `memberships.team_id`가 NULL이 아니며 양쪽이 같을 때만 허용. NULL team은 "같은 팀"으로 보지 않음 |
| 2-9 | vector parameter format | `toVectorLiteral(values: number[]) → "[v1,v2,...]"`, SQL에서 `$1::vector` 캐스트. 길이 1536 검증을 SQL 진입 전에 수행 |
| 2-10 | vector search filter | 모든 search에 `WHERE embedding IS NOT NULL` 포함 |
| 2-12 | checklist call snapshot | `INSERT ... SELECT ... ON CONFLICT (call_id, template_id) DO NOTHING` 단일 SQL로 idempotent |
| 2-13 | suggestion duplicate | 23505 그대로 surface (service에서 흡수 안 함) |
| 2-14 | suggestion use/dismiss 상태 | 이미 used/dismissed 시 `SuggestionStateError` 던짐. Step 3 route가 409로 매핑 |
| 2-15 | AI summary overwrite | repository UPDATE의 WHERE 절에 `summary_source IS NULL OR summary_source='ai'`. manual은 SQL에서 차단 |
| 2-16 | heartbeat touch | repository WHERE: `status='in_progress' AND deleted_at IS NULL`. ended/missed/dropped는 null 반환 |
| 2-17 | dropped sweep | `last_seen_at IS NOT NULL AND last_seen_at < cutoff` AND in_progress. 미heartbeat 통화는 보존 |
| 2-18 | customer linkage | composite FK가 cross-org를 23503으로 차단. unlink (customer_id=null)도 audit 컬럼 stamp |

---

## 3. `withOrgContext` 오버로드 — 후방 호환성

기존 시그니처:

```ts
export type WithOrgContext = <T>(orgId, fn) => Promise<T>;
```

Phase 5 시그니처:

```ts
export interface WithOrgContext {
  <T>(orgId, fn): Promise<T>;
  <T>(orgId, userId | null, fn): Promise<T>;
}
```

구현은 인자 수와 두 번째 인자가 함수인지를 검사해 분기. `userId === null`은 "명시적으로 actor 없음"으로 받아들이고 GUC를 set하지 않는다 (background sweep / heartbeat 흐름 대비).

기존 호출자 24곳 (`grep -r "withOrgContext"`) 가운데 한 곳도 수정하지 않았다. `orgContext.test.mjs`에 6 케이스 추가:

1. 2-arg `(orgId, fn)` → `current_app_org_id()` 반환 (기존 동작)
2. 2-arg → `current_app_user_id()` IS NULL (GUC 미설정 증명)
3. 3-arg `(orgId, userId, fn)` → `current_app_user_id()` = userId
4. 3-arg `(orgId, null, fn)` → `current_app_user_id()` IS NULL
5. 트랜잭션 종료 후 bare pool 쿼리에서 `current_app_user_id()` IS NULL (GUC 누수 없음)
6. callback이 throw해도 client release + 후속 호출 정상

전부 PASS (`npx tsx --test test/orgContext.test.mjs`, 9/9).

---

## 4. Repository / Service 정합성

### 4.1 `calls` Phase 5 컬럼 + 신규 mutation

`Call` 인터페이스에 6개 컬럼 추가 (`summary_generated_at`, `summary_source`, `last_seen_at`, `dropped_reason`, `customer_linked_at`, `customer_linked_by_user_id`). `CALL_COLUMNS` projection을 단일 라인 보강.

신규 함수 5개:

| 함수 | SQL 핵심 | 반환 |
|---|---|---|
| `touchHeartbeatInCurrentOrg` | `UPDATE ... WHERE status='in_progress' AND deleted_at IS NULL` | Call \| null |
| `markDroppedTimedOutInCurrentOrg` | `WHERE status='in_progress' AND last_seen_at IS NOT NULL AND last_seen_at < cutoff` | number |
| `linkCustomerInCurrentOrg` | `UPDATE ... SET customer_id, customer_linked_at, customer_linked_by_user_id` | Call \| null. composite FK가 cross-org → 23503 |
| `updateAiSummaryInCurrentOrg` | `WHERE summary_source IS NULL OR summary_source='ai'`. set source='ai' | Call \| null (manual 차단 시 null) |
| `updateManualSummaryInCurrentOrg` | set source='manual'. `summary_generated_at`은 건드리지 않음 | Call \| null |

### 4.2 `transcripts` STT 메타

`Transcript` projection에 `stt_provider`, `stt_session_id` 추가. `TranscriptAppendInput`은 optional 두 필드 수신. 기존 seq lock 정책 변경 없음.

### 4.3 knowledge

`knowledgeBases.ts`:
- `listForCurrentOrg` / `getByIdInCurrentOrg`: `deleted_at IS NULL` 필터 + `updated_at DESC` 정렬
- `softDeleteByIdInCurrentOrg`: `deleted_at=now()` (chunks는 hard delete 하지 않음)
- composite FK가 cross-org `created_by_user_id` → 23503

`knowledgeChunks.ts`:
- `toVectorLiteral` exported helper — 길이 1536 검증을 SQL 전에 throw (`InvalidEmbeddingError`)
- `replaceForKnowledgeBaseInCurrentOrg`: parent KB 존재 확인 → 기존 chunks DELETE → 새 chunks INSERT
- `searchSimilarInCurrentOrg`: `WHERE embedding IS NOT NULL ORDER BY embedding <=> $1::vector`. cosine distance를 `::float8 AS distance`로 같이 반환

### 4.4 checklist

`callChecklistTemplates.ts`: list / listActive / get / insert / patch / setActive / deleteById. `listActive`는 `WHERE active=true ORDER BY sort_order ASC`.

`callChecklistItems.ts`:
- `initializeForCallInCurrentOrg`: parent call FOR UPDATE → `INSERT INTO ... SELECT FROM org_call_checklist_templates WHERE active=true ON CONFLICT (call_id, template_id) DO NOTHING` → 최종 리스트 반환. 두 번 호출해도 row 수가 늘지 않음 (테스트 검증).
- `markStatusInCurrentOrg`: status='done'은 `checked_at=now(), checked_by_user_id=$userId` 동시 set, 'open'은 둘 다 NULL — CHECK constraint가 중간 상태를 보지 않게 한 SQL UPDATE 한 번으로 처리.
- `getParentCallForChecklistItem`: 권한 helper 진입 직전에 사용.

### 4.5 suggestions

`callSuggestions.ts`:
- `insertGroupForCallInCurrentOrg`: parent call 존재 확인 후 group 단위 insert. duplicate (23505)는 흡수하지 않고 raw로 surface.
- `markUsedInCurrentOrg` / `markDismissedInCurrentOrg`: UPDATE WHERE에 `dismissed_at IS NULL AND used_at IS NULL` — 이미 한 행동이 있으면 UPDATE가 0 row 반환 → service가 추가 SELECT로 row 존재 확인 후 `SuggestionStateError` throw.

### 4.6 service 분리

- `callPermissions.ts`: 단일 `assertCanMutateCall(client, actor, call)` export. `Actor.role` enum과 `PermissionError(code='forbidden')` 클래스 동봉.
- `knowledge.ts`: KB / chunks CRUD glue. role 강제 안 함 (Step 3 route 책임).
- `callChecklist.ts`: `initialize` (org-scoped, no actor) / `markChecklistItem` (actor → assertCanMutateCall → markStatus).
- `callSuggestions.ts`: `persistSuggestionGroup` (server-internal) / `useSuggestion` / `dismissSuggestion` (actor 검사 + state 검사).
- `callHeartbeat.ts`: 단일 org 단위 wrap. multi-org sweep cron은 Step 3+.
- `customerLinkage.ts`: link / unlink — composite FK가 cross-org를 자동 차단.
- `callSummary.ts`: `applyAiSummary` (no actor, summary_source='manual'은 SQL이 차단) / `applyManualSummary` (actor 검사).

---

## 5. 검증

### 5.1 typecheck

```bash
npm --prefix server run typecheck
# > tsc --noEmit
# (출력 없음 — 0 에러)
```

### 5.2 server unit tests

```bash
npm --prefix server test
# ...
# ℹ tests 255
# ℹ pass 255
# ℹ fail 0
# ℹ duration_ms 26818.8362
```

- 기존 212건 회귀 0건
- 신규 43건:
  - `orgContext.test.mjs`에 6건 (`withOrgContext` overload + GUC 누수 + rollback)
  - `phase5_repositories.test.mjs` 25건 (knowledge 10 + checklist 5 + suggestions 5 + calls Phase 5 컬럼 5)
  - `phase5_services.test.mjs` 12건 (permission 5 + service transaction 7)

세부 카운트:
- knowledge: bare-pool 0 / Acme insert+list+get / Beta cross-org get null / Acme→Beta WITH CHECK 42501 / wrong-org creator 23503 / soft delete hide / toVectorLiteral 차원 reject / replace chunks 0..N / cross-org KB replace null / vector search NULL 필터 + nearest first
- checklist: active sort + inactive 제외 / initialize 1 per active / idempotent / cross-org null / mark done/open / CHECK 23514
- suggestions: insert group 정렬 / duplicate 23505 / dismissed+used CHECK 23514 / cross-org list null / markUsed/markDismissed
- calls Phase 5: heartbeat live OK / ended null / sweep stale + 보존 fresh+no-hb+ended / customer link same-org OK + wrong-org 23503 + unlink stamp / AI fill→AI replace→manual→AI blocked / transcript STT 메타

### 5.3 sync_shared_types

```bash
node test/sync_shared_types.mjs
# ... 9 entities OK ... PASS
```

Step 2가 shared types를 만들지 않으므로 entity 수 변경 없음 (계획서 §9 체크리스트와 일치).

### 5.4 phase_4_e2e

```bash
PORT=32173 node test/phase_4_e2e.mjs
# E2E PASSED
```

8 시나리오 + cleanup sweep 모두 PASS. Phase 4 surface에 행동 변경 없음 (Step 2는 internal layer만).

### 5.5 git diff --check

LF→CRLF 경고만 출력 (Windows 환경 표준). 실제 whitespace 오류 없음.

---

## 6. 발견 / 리스크

### 6.1 manager same-team SQL 단순화

`isSameTeam` 헬퍼는 2개 sub-select로 양쪽 `team_id`를 가져와 비교. 양쪽 NULL이면 `NULL = NULL` → 결과 NULL → `same=false`로 정확히 떨어진다. PostgreSQL 3-value logic이 우리 의도와 정확히 일치하는 드문 경우.

### 6.2 vector search index 미사용 시 ordering

ivfflat 인덱스는 `lists=100` 설정. 본 step의 테스트 데이터는 2 row뿐이라 planner가 seq scan을 선택할 수 있다. 그래도 cosine ordering은 `<=>` 연산자 자체가 보장하므로 결과 순서는 정확하다 (테스트에서 `nearest first` 검증).

운영 규모 (수천 row 이상)에서 ivfflat이 정말로 사용되는지는 Step 3 ingest pipeline + 운영 데이터 투입 후 `EXPLAIN ANALYZE`로 재검증 예정. 현재는 query plan 정확성보다 "결과가 옳다"를 우선 검증.

### 6.3 `embedding::text` projection

`KNOWLEDGE_CHUNK_COLUMNS`는 `embedding::text AS embedding`. pgvector는 기본적으로 binary 형태로 직렬화될 수 있는데, node-postgres가 OID를 모르면 `Buffer`로 받게 된다. text로 캐스트해 `"[v1,v2,...]"` 문자열로 받아 application에서 안전하게 다룰 수 있게 했다. 검색 결과 ordering은 server-side `<=>`로 이미 결정된 상태이므로 client-side에서 embedding을 다시 파싱할 필요는 없다.

### 6.4 manager team-scope 미사용 NULL 케이스

테스트에서 NULL team_id manager가 다른 사람 통화 mutation 거부됨을 확인. 단 manager가 자기 자신이 agent인 통화는 허용되어야 하므로 `assertCanMutateCall`에 `agent_user_id === actor.id` 단축 분기를 두었다 (manager 본인이 자기 통화 mutation은 OK).

### 6.5 `markDroppedTimedOutInCurrentOrg`가 `ended_at`도 set

원래 plan §4.1 SQL contract는 `last_seen_at` 변화만 언급했으나, sweep이 만든 dropped 통화도 calls UI에서 ended_at / duration_seconds 컬럼을 사용한다 (calls.html, dashboard). 이를 채우지 않으면 dropped 통화가 "진행 중인 dropped 통화"처럼 보이게 된다. SQL에서 `ended_at = $droppedAt`, `duration_seconds = GREATEST(0, EPOCH(droppedAt - started_at))`를 같이 set하여 일관성 확보 (`services.test`에서 검증).

### 6.6 `phase5test-` cleanup contract

각 테스트는 try/finally로 자기 row를 hard-delete. `after()` hook은 `phase5test-` prefix 텍스트 필드 기준 broad sweep (child → parent 순). 좌석 데이터 (users / customers / memberships / teams) 가운데 시드 row는 절대 건드리지 않고, **`phase5_services.test.mjs`가 만든 ephemeral users / teams / memberships만** `after()`에서 정확한 UUID 5개·2개·5개로 삭제. Phase 4 orphan calls 재발 방지 결정 (memory: report-scope rule) 준수.

---

## 7. Codex Review Focus 응답

| Plan §10 | 확인 |
|---|---|
| `withOrgContext` overload safety | 기존 24 호출자 변경 없음. `set_config(..., true)` 두 GUC 모두 트랜잭션-로컬. orgContext.test에 GUC 누수 검증 케이스 추가 |
| team-scope semantics | read는 org-wide (RLS 정책 그대로). mutation만 service helper에서 좁힘. services.test 5종 케이스 |
| pgvector parameterization | string-built SQL 없음. embedding은 toVectorLiteral → `$1::vector` cast |
| AI summary overwrite guard | repository SQL의 WHERE에 `summary_source IS NULL OR summary_source='ai'`. repositories.test에서 manual→AI 보호 검증 |
| heartbeat cutoff | `last_seen_at IS NOT NULL AND last_seen_at < cutoff`. 미heartbeat 신생 통화는 sweep 영향 받지 않음 |
| test cleanup | 시드 user/customer/membership 삭제 없음. ephemeral phase5test 5 users만 삭제. broad started_at sweep 없음 |
| Step boundary | routes / shared types / frontend / 실제 외부 adapter 0건 변경 (계획서 §1 산출물 표와 정확히 일치) |

---

## 8. Step 3 인계

Step 3 (`PHASE_5_STEP_3_*` 가칭)에서 처리:

1. **REST routes**:
   - `GET/POST /knowledge-bases`, `POST /knowledge-bases/:id/chunks` (admin-only)
   - `GET/PATCH /call-checklist-templates` (admin/manager)
   - `POST /calls/:id/checklist/initialize`, `PATCH /call-checklist-items/:id/status`
   - `POST /calls/:id/suggestions` (server-internal token), `POST /call-suggestions/:id/use|dismiss`
   - `POST /calls/:id/heartbeat`, `PATCH /calls/:id/customer-link`
   - `PATCH /calls/:id/summary` (manual writer)
2. **shared zod types** for the new routes (`platform/types/*`, `server/src/types/*`) — sync_shared_types entity 수가 9 → 14로 증가 예상.
3. **STT adapter wiring** (Clova primary, Whisper fallback) — `services/sttDispatcher.ts` 가칭.
4. **LLM summarizer worker** — BullMQ job → `applyAiSummary`.
5. **Heartbeat sweep cron** — multi-org loop over `services/callHeartbeat.markTimedOutCallsDropped`.
6. **Frontend** — Phase 5 surfaces (settings 회사 가이드 / 체크리스트 / live.html 통화 detail UI).
7. **phase_5_e2e** — end-to-end coverage of the above.

본 Step 2에서 service 함수와 domain error 클래스를 노출했으므로 Step 3는 route handler → service call → error → HTTP 매핑만 작성하면 된다.

---

## 9. 한 줄 요약

> **Phase 5 신규 schema를 코드에서 안전하게 쓰는 repository / service 계층과 단위 테스트 43건이 추가되었다. `withOrgContext`가 `app.user_id` GUC를 후방-호환적으로 받을 수 있게 되었고, manager team-scope mutation 권한이 service helper로 분리되었다. 라우트 / shared types / 프론트엔드 / 실제 외부 어댑터는 Step 3로 미뤘다.**

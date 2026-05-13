# Phase 6 Step 3 Findings — Action Item DELETE

> 완료일: 2026-05-13
> 범위: `DELETE /call-action-items/:id` hard delete + frontend 삭제 버튼. 마이그레이션 0건.
> 기준 계획: `docs/plan/phase-6/PHASE_6_STEP_3_PLAN.md`.
> 선행 단계: Phase 6 Step 2 closeout (`db99922`).
> 현재 브랜치: `feature/phase-3-team-invitations`.

---

## 1. 현재 상태

Step 3 완료. `PHASE_6_MASTER.md` §0 Implementation Log의 Step 3 체크박스를 `[x]`로, §11 go/no-go의 "Action item DELETE endpoint + UI" 항목을 `[x]`로 전환했다.

남은 Phase 6 작업은 Step 4 (manager team-scope read 보고서) / Step 5 (통합 e2e + Phase 6 종합 closeout). Phase 6 전체 closeout(README 갱신 / Phase 7 인계 등)은 Step 5에서.

---

## 2. 변경 파일

신규 4개, 수정 5개.

### 신규
- `docs/plan/phase-6/PHASE_6_STEP_3_PLAN.md` — hard delete 결정 근거 + 권한 매트릭스 + endpoint shape + XSS gate plan + 작업 순서.
- `docs/plan/phase-6/PHASE_6_STEP_3_FINDINGS.md` — 본 완료 보고.
- `server/src/services/callActionItems.ts` — `deleteActionItem(app, actor, id)`. parent call 조회 → `assertCanMutateCall` → repository hard delete. PermissionError throw + null/false 차이 유지.
- `server/test/phase6_action_item_delete.test.mjs` — route + service + repo 12 케이스.

### 수정
- `server/src/repositories/callActionItems.ts` — `deleteByIdInCurrentOrg(client, id): Promise<boolean>` helper 추가. 기존 status/assignee patch와 같은 `EXISTS (calls WHERE deleted_at IS NULL)` 가드.
- `server/src/routes/calls.ts` — `DELETE /call-action-items/:id` route + 에러 핸들러에 `PermissionError → 403` 분기 1줄 추가. import 추가 (`callActionItemsService`, `PermissionError`, `Actor`).
- `platform/api.js` — `deleteActionItem(id)` helper + `window.kloserApi` 등록.
- `platform/calls.html` — `renderActionItems` row 우측에 ✕ 삭제 버튼 + 클릭 핸들러. 핸들러는 204/404 → `openDetail(currentCallId)` 재조회, 403 → "권한 없음", 그 외 → 상태 문자열.
- `docs/plan/phase-6/PHASE_6_MASTER.md` — Step 3 implementation log + go/no-go Action item DELETE 항목 갱신.

마이그레이션 0개 (hard delete 선택). `.env*` 무수정. `package.json` 무수정.

---

## 3. Hard delete 선택 근거 (한 줄 요약)

`PHASE_6_STEP_3_PLAN.md §1` 참조. 핵심:

1. `call_action_items`에 `deleted_at` 컬럼이 없다 → soft delete는 schema 변경 + 모든 read query 수정 필요.
2. UI 요구는 "사라지는 것"이며 audit 추적이 필요한 도메인 신호가 없다 (action item은 통화 결과의 부수 메모).
3. retention / activity_log는 `PHASE_6_MASTER.md §10.2`에 따라 Phase 7+ 보류.
4. cost / 외부 시스템 연결 없음 → 정보 손실 비용이 낮다.

soft delete가 필요해지는 사용 사례(분석 / 감사 / "휴지통" UI)가 향후 등장하면 `call_action_items.deleted_at` 컬럼 추가 + 모든 read query 보강을 별도 PR로 처리.

---

## 4. Backend 요약

### 4.1 Repository (`server/src/repositories/callActionItems.ts`)

신규 함수:

```ts
export async function deleteByIdInCurrentOrg(
  client: PoolClient,
  id: string,
): Promise<boolean>
```

SQL:
```sql
DELETE FROM call_action_items
 WHERE id = $1
   AND EXISTS (
     SELECT 1 FROM calls
      WHERE calls.id = call_action_items.call_id
        AND calls.deleted_at IS NULL
   )
RETURNING id
```

- RLS가 cross-org row를 0건으로 가림 → 반환 false (route가 404로 매핑).
- soft-deleted parent call의 action item도 false (EXISTS 차단).
- 이미 삭제된 id 재시도도 false.

### 4.2 Service (`server/src/services/callActionItems.ts`)

```ts
export async function deleteActionItem(
  app: FastifyInstance,
  actor: Actor,
  id: string,
): Promise<boolean>
```

`app.withOrgContext(actor.orgId, actor.id, ...)` 한 트랜잭션 안에서:
1. `getParentCallForActionItem(client, id)` → null이면 false.
2. `assertCanMutateCall(client, actor, { agent_user_id: parent.agent_user_id })` — PermissionError throw 가능.
3. `deleteByIdInCurrentOrg(client, id)` 결과 반환.

본 단위에서 신규 service 파일 분리 — 향후 action item 관련 로직(bulk export / archive)의 단일 진입점. 기존 `services/calls.ts`는 통화 lifecycle 위주라 분리가 자연스럽다.

### 4.3 Route (`server/src/routes/calls.ts`)

`DELETE /call-action-items/:id`:
- preHandler: `requireAuth → orgContext → requireVerified → requireRole(admin/manager/employee) → requireFreshRole`. viewer는 `requireRole`에서 막힘.
- Handler: `UuidParam.parse` → `deleteActionItem(app, actor, id)`.
- 성공 → 204 No Content (body 없음).
- service false → 404 not_found.
- service throw PermissionError → 에러 핸들러에서 403 forbidden.
- ZodError → 400 invalid_input.

calls.ts 에러 핸들러에 `PermissionError → 403` 한 줄 추가 — Phase 5 `callsPhase5.ts`와 동일 패턴.

---

## 5. Frontend 요약

### 5.1 `platform/api.js`

```js
function deleteActionItem(id) {
  return apiDelete('/call-action-items/' + encodeURIComponent(id));
}
```

`window.kloserApi.deleteActionItem` 으로 노출. raw `Response`를 반환 (다른 Phase 4/5 API helper와 동일).

### 5.2 `platform/calls.html` — `renderActionItems` 갱신

기존 row:
```
[→ / ✓] [title] (due)
```

신규 row:
```
[→ / ✓] [title (due)]                       [✕]
```

`✕` 버튼:
- 우측 정렬 (`flex-1`을 title span에 줘서 자동 배치).
- `text-slate-300 hover:text-rose-600` — 조용한 색, hover 시 위험 강조.
- `aria-label="삭제"`, `title="삭제"`.
- 확인 모달 없음 — 같은 페이지 다른 mutation과 일관. 실수 시 사용자가 다시 입력 (hard delete).

클릭 핸들러:
- 204 / 404 → `await openDetail(currentCallId)` (다른 사용자가 먼저 지웠을 때도 새 상태로 동기화).
- 403 → `dActionStatus`에 "권한 없음".
- 그 외 → "삭제 실패 (status)" 또는 "네트워크 오류".

### 5.3 API / demo boundary

| 필드 | source |
|---|---|
| action item list / status toggle / assignee / **delete** | **API** (Phase 4·5·6 통합) |
| 통화 detail panel 좌측 KPI, 통화 list 행 | API (Phase 4 Step 5) |
| 통화 detail의 가이드 / 추천 history | API (Phase 5) |
| 좌측 사이드바 user 블록 | API (`/me`) |
| daily.html / newsletter.html 위젯 | demo (변경 없음) |

본 단위에서 새 demo 잔여 0건. 라벨 변경 없음.

### 5.4 XSS gate (AGENTS.md)

`renderActionItems`의 `innerHTML` 구성에서 interpolated되는 값:

| 위치 | source | classification | 처리 |
|---|---|---|---|
| `data-action-id` (기존) | server (UUID) | server-returned | `escapeHtml(a.id)` |
| `data-action-status` (기존) | server (enum) | server-returned | `escapeHtml(a.status)` |
| `a.title` (기존) | server (사용자 자유 입력) | server-returned | `escapeHtml(a.title \|\| '')` |
| `a.due_date` (기존) | server (YYYY-MM-DD) | server-returned | `escapeHtml(a.due_date)` |
| `data-delete-action-id` (**신규**) | server (UUID) | server-returned | `escapeHtml(a.id)` |

신규 `data-delete-action-id` attribute 한 곳만 추가. 기존과 같은 escape 패턴. XSS gate 위반 0건.

새로 노출하는 user-facing 텍스트 0건 (✕는 페이지 작성자 상수).

---

## 6. 검증 결과

```powershell
npm --prefix server run typecheck
```
PASS.

```powershell
npm --prefix server test
```
PASS. **370 tests / 367 pass / 3 skipped / 0 fail**. 이전 baseline 358 + 신규 12 = 370 total. skipped 3개는 Step 2 real-provider opt-in 그대로.

```powershell
node test/sync_shared_types.mjs
```
PASS. 14 entity 그대로 (response body 없음 → 신규 entity 0개).

```powershell
node test/phase6_action_item_delete.test.mjs (via tsx)
```
**12 / 12 PASS** (10 route + 2 repo direct).

프런트엔드 inline script syntax check:
- `platform/calls.html` 2 inline scripts → 둘 다 `new Function(...)` 로드 OK.
- `platform/api.js` → `new Function(...)` 로드 OK.

라이브 브라우저 smoke는 실 서버 (API:32173 + Static:8765) 부팅이 필요해 본 단위에서 자동 수행하지 않음. 회귀 보장은 server-side 12 케이스 + 정적 syntax 검증으로 충분 (Step 5 통합 e2e가 브라우저 경로를 최종 검증 예정).

---

## 7. 테스트 케이스 (10 + 2)

`server/test/phase6_action_item_delete.test.mjs`:

| # | 케이스 | expected |
|---|---|---|
| 1 | admin same-org delete | 204, row gone |
| 2 | employee own call | 204 |
| 3 | employee other agent call | 403 forbidden |
| 4 | manager same-team call | 204 |
| 5 | manager other-team call | 403 |
| 6 | manager unassigned (agent_user_id=NULL) | 403 |
| 7 | viewer | 403 (requireRole이 차단) |
| 8 | cross-org id | 404 not_found |
| 9 | invalid UUID path param | 400 invalid_input |
| 10 | repeated delete of same id | second → 404 |
| 11 | repo `deleteByIdInCurrentOrg` already-removed id | returns false |
| 12 | repo `deleteByIdInCurrentOrg` cross-org id | returns false, row remains in Acme |

기존 `calls_routes.test.mjs` / `phase5_routes_calls.test.mjs` / `calls_service.test.mjs` 등 회귀 영향 없음 (export 변경 / 시그니처 변경 0건).

---

## 8. 중요 결정

### 8.1 service의 race window

`getParentCallForActionItem` → `assertCanMutateCall` → `deleteByIdInCurrentOrg` 사이에 다른 트랜잭션이 같은 row를 지울 수 있다. 본 단위는 lock을 걸지 않았다. 두 번째 DELETE가 0 row affected → service false → 404. 사용자 관점에서 "방금 사라짐"이라 404가 올바른 응답이고, action item 단일 row를 위해 추가 lock 비용을 부담할 가치가 낮다.

### 8.2 manager unassigned 통화 정책

`assertCanMutateCall`은 `call.agent_user_id IS NULL`일 때 manager를 throw로 차단한다. 본 단위도 동일 정책을 채택 — 테스트 케이스 6번이 검증. 정책 변경(manager가 unassigned 통화의 action item을 삭제 가능)이 필요하면 별도 PR / Step 5 e2e plan에서 합의.

### 8.3 confirmation modal 없음

`platform/calls.html`의 status toggle, manual summary save, link-customer 등 다른 mutation도 모달 없이 즉시 실행한다. 일관성과 조작 효율 우선. 실수 비용은 hard delete 후 사용자가 다시 입력하는 비용이며 통화 결과의 부수 메모라 허용 가능. UX 피드백으로 필요해지면 별도 PR.

### 8.4 service 파일 분리

기존 패턴은 통화 자체(`services/calls.ts`)와 sub-aspect 서비스(`callSummary.ts`, `callChecklist.ts`, `callSuggestions.ts`, `customerLinkage.ts`)가 별 파일로 분리되어 있다. action item만 service가 없었던 이유는 Phase 4 시점에 권한 정책이 단순(`denyForEmployeeNonOwner`)했기 때문. Phase 6 Step 3가 `assertCanMutateCall`을 가져오면서 동일 패턴(`services/callActionItems.ts`)으로 분리 — 향후 bulk export / archive가 자연스럽게 같은 파일에 들어간다.

---

## 9. 남은 Phase 6 항목

### 9.1 Step 4 — Manager team-scope read 보고서 (다음 즉시 진행 가능)

- `server/src/services/teamReports.ts` — team-scope KPI 계산. admin/manager/employee/viewer 분기.
- `server/src/routes/reports.ts` (또는 `dashboard.ts` 보강) — `GET /reports/team-summary?team_id=...`.
- `server/src/types/teamReport.ts` + `platform/types/teamReport.js` + `sync_shared_types` entity 등록 (**14 → 15**, master plan은 16을 목표로 잡았으나 본 closeout 시점 14라 +2 = 16이 맞다).
- `platform/dashboard.html` 섹션 또는 신규 `platform/reports.html`.
- 단위/route 테스트.

### 9.2 Step 5 — 통합 e2e + Phase 6 종합 closeout

- `test/phase_6_e2e.mjs` 6~8 시나리오 (워커 boot + endCall enqueue / heartbeat sweep / WS suggestion persistence / **action item DELETE** / manager 보고서 / cleanup 일괄 + Phase 0.5/2/3/4/5 e2e 회귀).
- master §11 go/no-go gate 남은 항목 닫기.
- 루트 `README.md` + `server/README.md` 상태 블록 Phase 6 완료로 갱신.
- `docs/USER_GUIDE_PHASE_6.md` 작성.
- Phase 7+ 인계 문서.

### 9.3 보류 (Phase 6 closeout과 무관)

- Step 2 cost-accuracy commit (`cost_usd_micros` 계산 model→price map). `PHASE_6_STEP_2_FINDINGS.md §6.1` 그대로.
- `npm audit` high 2건 (pre-existing). `PHASE_6_STEP_2_FINDINGS.md §6.4` 그대로.

---

## 10. Codex Review Focus

- Repository `deleteByIdInCurrentOrg`이 기존 patch helper와 같은 `EXISTS (calls WHERE deleted_at IS NULL)` 패턴을 따르는지 (soft-deleted parent의 action item이 노출되지 않도록).
- Service가 `withOrgContext(actor.orgId, actor.id, ...)`로 actor user id GUC를 함께 세팅해 `assertCanMutateCall`의 SQL이 정상 동작하는지.
- Route가 새 service를 호출하지만 기존 `denyForEmployeeNonOwner`는 status/assignee route에 그대로 남아 있는 점이 의도된 분리인지 (Phase 4 Step 3 정책 유지 + Step 6 Step 3는 manager team-scope 강제).
- calls.ts 에러 핸들러에 `PermissionError → 403` 추가가 callsPhase5의 패턴과 일치하는지 (코드 / 메시지 / status).
- frontend 신규 `data-delete-action-id` interpolation이 escapeHtml로 escape되는지 (XSS gate).
- 마이그레이션 / `.env*` / `package*.json`을 건드리지 않았는지.
- `sync_shared_types` count가 14 그대로인지 (DELETE 응답 body 없음 → 신규 entity 0).

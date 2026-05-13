# Phase 6 Step 3 Plan — Action Item DELETE

> 상위 계획: `docs/plan/phase-6/PHASE_6_MASTER.md` §4 Step 3.
> 선행 단계: Phase 6 Step 2 closeout (`db99922`).
> 워크플로: schema 변경이 *없는* sub-step → service → route → frontend → tests + findings (AGENTS.md Phase Workflow 단축형).
> 기간: 1.5~2일.

---

## 0. 목표

`call_action_items` row를 회수할 수 있는 `DELETE /call-action-items/:id`을 추가한다. Phase 4 Step 3에서 create / status / assignee까지 닫혔던 action item lifecycle의 마지막 한 칸. master plan에서 "작성·완료·삭제"가 닫혔다고 선언할 수 있게 만드는 게 본 단위의 단일 목표.

---

## 1. 삭제 모델 결정 — Hard delete

본 단위는 **hard delete**를 채택한다.

| 후보 | 결정 | 근거 |
|---|---|---|
| (a) hard delete: `DELETE FROM call_action_items WHERE id = $1` | ✅ 채택 | 1. 현재 `call_action_items`에 `deleted_at` 컬럼이 없다. 새 컬럼은 schema 변경 + 모든 read query에 `WHERE deleted_at IS NULL` 추가를 요구한다. 2. UI 요구는 "삭제된 action item이 사라지는 것"이며 audit 추적은 없다. 3. retention / activity_log는 Phase 7+ 보류 (`PHASE_6_MASTER.md §10.2`). 4. action item 삭제는 통화 결과의 부수 메모이고 cost / 청구 / 외부 시스템과 연결되지 않아 hard delete의 정보 손실 비용이 낮다. |
| (b) soft delete: `call_action_items.deleted_at timestamptz` 추가 | ❌ 미채택 | 위 1~4의 역. 필요해지면 Phase 7 audit_log / retention 단위에서 함께 도입. |

**Schema 변경 없음.** 마이그레이션 0개.

---

## 2. 권한 매트릭스

`assertCanMutateCall` (Phase 5 `services/callPermissions.ts`) 정책을 그대로 적용. 본 단위는 helper를 재사용만 한다 — 새 helper 추가 금지.

| Role | 본인 통화 action item | 같은 팀 통화 action item | 다른 팀 통화 action item | unassigned 통화 action item | cross-org |
|---|---|---|---|---|---|
| **admin** (same-org) | ✓ | ✓ | ✓ | ✓ | ✗ (404) |
| **manager** (same-org) | ✓ | ✓ | ✗ (403) | ✗ (403) | ✗ (404) |
| **employee** (same-org) | ✓ | ✗ (403) | ✗ (403) | ✗ (403) | ✗ (404) |
| **viewer** | ✗ (403) | ✗ (403) | ✗ (403) | ✗ (403) | ✗ (404) |

**Manager unassigned 통화 정책**: `assertCanMutateCall`은 `call.agent_user_id IS NULL`일 때 manager를 deny. 본 단위도 동일.

**Cross-org 비공개 (404 vs 403)**: RLS가 cross-org row를 0건으로 가리므로 `getParentCallForActionItem`이 null → 404. 본 org에서 권한이 모자란 경우만 403. 즉 "row가 다른 org에 있다"는 사실이 응답으로 노출되지 않는다 (AGENTS.md Backend Conventions §"Keep RLS behavior opaque").

---

## 3. Endpoint 설계

```
DELETE /call-action-items/:id
```

요청:
- path param: `id` — UUID. 기존 `UuidParam` zod schema 재사용.
- body: 없음.
- headers: `Authorization: Bearer <access_token>`.

응답:
- `204 No Content` — 성공. body 없음.
- `400 invalid_input` — `:id`가 UUID 형식이 아님. `UuidParam.parse(...)` ZodError → 기존 route 에러 핸들러.
- `403 forbidden` — `PermissionError` (viewer / employee non-owner / manager other-team / manager unassigned). `code: 'forbidden'`.
- `404 not_found` — action item이 본 org에 없거나 parent call이 soft-deleted됐거나 이미 삭제됨 (반복 DELETE). RLS와 일관.

응답 contract는 기존 `POST /call-action-items/:id/status` / `/assignee`와 같은 4xx 매트릭스 — 단 성공만 204 (body 없음).

**Shared types**: response body가 없으므로 신규 entity 0개. `sync_shared_types` count는 14 그대로 유지 (Step 4가 +2 → 16 예정).

---

## 4. Backend 구조 (3 layer)

### 4.1 Repository — `server/src/repositories/callActionItems.ts`

신규 helper 1개:

```ts
export async function deleteByIdInCurrentOrg(
  client: PoolClient,
  id: string,
): Promise<boolean>;
```

동작:
- `DELETE FROM call_action_items WHERE id = $1 AND EXISTS (SELECT 1 FROM calls WHERE calls.id = call_action_items.call_id AND calls.deleted_at IS NULL) RETURNING id`
- 반환: 삭제된 row가 있으면 `true`, 없으면 `false`.
- RLS가 cross-org row를 0건으로 가리므로 cross-org `id` → false (서비스가 404로 변환).
- soft-deleted parent call의 action item → false (위 EXISTS subquery 차단).

기존 `patchStatusInCurrentOrg` / `patchAssigneeInCurrentOrg`의 `EXISTS (calls WHERE deleted_at IS NULL)` 가드와 동일 패턴.

### 4.2 Service — `server/src/services/callActionItems.ts` (신규)

기존 `services/calls.ts`는 통화 자체의 lifecycle 위주이고 action item 관련 service 함수가 없다. 새 service 파일을 만들어 future action item logic의 단일 진입점으로 둔다 — Step 4 / 5에서 action item bulk export / archive 같은 게 들어오면 본 파일이 자연 확장.

```ts
import type { FastifyInstance } from "fastify";
import * as actionItemsRepo from "../repositories/callActionItems.js";
import {
  assertCanMutateCall,
  type Actor,
} from "./callPermissions.js";

// Returns `true` when a row was deleted, `false` when nothing matched
// (missing / cross-org / already-deleted / soft-deleted parent call).
// Throws PermissionError when the actor lacks permission for the parent
// call. Caller maps `false` → 404 and PermissionError → 403.
export async function deleteActionItem(
  app: FastifyInstance,
  actor: Actor,
  id: string,
): Promise<boolean>;
```

동작 시퀀스 (`app.withOrgContext(actor.orgId, actor.id, ...)` 한 transaction 안):

1. `getParentCallForActionItem(client, id)` → `null`이면 즉시 `false` 반환 (없음 / cross-org / soft-deleted).
2. `assertCanMutateCall(client, actor, { agent_user_id: parent.agent_user_id })` — 권한 위반이면 `PermissionError` throw (route layer가 403 매핑).
3. `actionItemsRepo.deleteByIdInCurrentOrg(client, id)` → 결과 그대로 반환.

`assertCanMutateCall`은 manager team-scope를 검증하기 위해 같은 transaction에서 memberships를 읽으므로 같은 `withOrgContext` 안에 둔다.

**Race condition**: 다른 트랜잭션이 동시에 행을 지우면 step 1은 hit이고 step 3는 miss. 사용자 관점에서는 "방금 사라짐"이라 `false` → 404가 맞다. lock은 걸지 않는다 (간단함 > 동시성 정확성, 작업 대상이 단일 row).

### 4.3 Route — `server/src/routes/calls.ts`

기존 action item status/assignee 라우트와 같은 파일에 추가. 단:
- `calls.ts`의 기존 라우트는 route-local `denyForEmployeeNonOwner`를 쓴다 (admin/manager 통과, employee만 own-call 강제). 본 신규 DELETE는 **`assertCanMutateCall` (manager team-scope 포함)을 사용** — 지시문 명시 요구.
- 따라서 `calls.ts`의 `setErrorHandler`에 `PermissionError → 403` 분기를 추가한다. `callsPhase5.ts`가 같은 분기를 이미 갖고 있으므로 패턴은 검증된 것.

라우트 코드:

```ts
app.delete(
  "/call-action-items/:id",
  {
    preHandler: [
      requireAuth,
      orgContext,
      requireVerified,
      requireRole(...WRITER_ROLES),  // admin / manager / employee. viewer는 여기서 막힘
      requireFreshRole,
    ],
  },
  async (request, reply) => {
    const { id } = UuidParam.parse(request.params);
    const actor: Actor = {
      id: request.user!.id,
      orgId: request.user!.orgId,
      role: request.user!.role,
    };
    const deleted = await callActionItemsService.deleteActionItem(app, actor, id);
    if (!deleted) return reply.code(404).send({ error: "not_found" });
    return reply.code(204).send();
  },
);
```

**preHandler 매트릭스**: viewer는 `requireRole(...WRITER_ROLES)`에서 401/403으로 차단. 즉 service에 들어오는 actor는 admin / manager / employee 중 하나. service가 manager / employee 분기 검증.

**Note**: viewer는 `requireRole`에서 차단되므로 service `assertCanMutateCall`의 viewer-deny 분기가 실행되지는 않지만 service의 정책은 그대로 유지 — service가 라우트 보호 없이 호출될 가능성도 닫아야 한다.

### 4.4 calls.ts 에러 핸들러 보강

기존:
```ts
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof ZodError) { ... }
  if (err instanceof AuthError) { ... }
  // pg codes 23503/23514/42501
});
```

추가 1줄: `if (err instanceof PermissionError) return reply.code(403).send({ error: "forbidden" });` — `AuthError` 분기 위에 둔다 (PermissionError가 AuthError 상속이 아니라 별 클래스라 순서는 상관없지만 callsPhase5의 패턴과 통일).

---

## 5. Test plan

### 5.1 신규 테스트 파일 1개

`server/test/phase6_action_item_delete.test.mjs` — Step 3 단위 테스트만 모은다. 9 케이스.

기존 `calls_routes.test.mjs` / `phase5_routes_calls.test.mjs`에 끼우면 두 파일이 같이 부풀어 검토 비용이 커지고, 본 단위에 한정된 회귀 실행도 어려워진다.

### 5.2 케이스 (9개)

`_phase5Fixture.mjs`의 manager/employee/viewer team-fixture 재사용 + Phase 4 seed admin/employee 재사용.

1. **admin same-org delete** → 204, row gone (`listByCallInCurrentOrg`로 확인).
2. **employee own call delete** → 204.
3. **employee other agent call** → 403 forbidden.
4. **manager same-team call** → 204.
5. **manager other-team call** → 403.
6. **manager unassigned (agent_user_id = NULL) call** → 403 (manager는 unassigned 차단).
7. **viewer** → 403 (요청은 `requireRole(WRITER_ROLES)`에서 미리 막히므로 실제로는 403).
8. **cross-org id** (Beta 사용자 토큰으로 Acme action item 삭제 시도) → 404.
9. **invalid UUID** (`/call-action-items/not-a-uuid`) → 400 invalid_input.
10. **repeated delete** (한 번 삭제 후 같은 id를 다시 삭제) → 404.

> 케이스가 명목상 9개 + 추가 1 = 10개. 위에 나열한 그대로 작성.

### 5.3 회귀

기존 `calls_routes.test.mjs`의 action item create/status/assignee 케이스가 본 변경에 영향받는지 확인:
- repo / service에 신규 추가만, 기존 export 미변경 → 영향 없음.
- route 에러 핸들러에 `PermissionError → 403` 한 줄 추가 → 기존 핸들러 분기 미변경 → 영향 없음.
- 회귀 PASS 가정. 실제 `npm test`가 두 파일을 모두 돌리므로 자연스럽게 확인.

### 5.4 cleanup

`phase6_action_item_delete.test.mjs`의 prefix는 `phase6test-actiondelete-`. 본 suite가 만든 모든 call / action item row는 같은 prefix 정책으로 `afterEach` 또는 `after`에서 정리. seed 데이터 / Phase 5 fixture 사용자는 절대 손대지 않는다.

`call_action_items`는 cascade 없는 별도 테이블이지만 부모 `calls`가 cascade로 떨어뜨리므로 call DELETE 한 번이면 action items도 함께 사라짐. 명시적으로 action_items 정리는 불필요.

---

## 6. Frontend 작업

### 6.1 변경 파일

- `platform/calls.html` — `renderActionItems`에 삭제 버튼 추가 + 핸들러.
- `platform/api.js` — `deleteActionItem(id)` 추가.

### 6.2 UI 디자인

기존 row:
```
[→ / ✓] [title] (due)
```

신규 row:
```
[→ / ✓] [title] (due) [✕]    ← 삭제 버튼을 우측 끝에 작게
```

`✕` 버튼:
- 작은 svg (red-500/600), `aria-label="삭제"`, `title="삭제"`.
- 확인 모달은 사용하지 않음 (조작 비용 vs 실수 비용을 고려해 다른 mutation 컨트롤과 일관). 실수로 누르면 다시 `POST /calls/:id/action-items`로 재생성 (action item 본문이 hard delete로 사라졌으므로 복구는 사용자가 다시 입력).
- 클릭 핸들러:
  1. `btn.disabled = true`.
  2. `window.kloserApi.deleteActionItem(id)`.
  3. `res.status === 204` → `await openDetail(currentCallId)` (서버 재조회).
  4. `403` → `dActionStatus`에 "권한 없음".
  5. `404` → `dActionStatus`에 "이미 삭제됨" 후 `openDetail(currentCallId)` 재조회 (다른 사용자가 먼저 지웠을 수 있음).
  6. 네트워크 오류 → "네트워크 오류".
- mock vs API 라벨: action item list/status/assignee/delete 모두 **API**. demo 잔여 없음 (Phase 4 Step 4에서 정적 데모를 제거함).

### 6.3 XSS gate (AGENTS.md)

`renderActionItems` 내부 `innerHTML` 구성에서 새로 interpolated되는 값은:

| 위치 | 출처 | classification | 처리 |
|---|---|---|---|
| `data-action-id` (기존) | server (action item id, UUID) | server-returned | 기존 `escapeHtml(a.id)` 유지 |
| `data-action-status` (기존) | server (open/done/dropped enum) | server-returned | 기존 `escapeHtml(a.status)` 유지 |
| `a.title` (기존) | server (사용자 자유 입력) | server-returned | 기존 `escapeHtml(a.title || '')` 유지 |
| `a.due_date` (기존) | server (YYYY-MM-DD) | server-returned | 기존 `escapeHtml(a.due_date)` 유지 |
| `data-delete-action-id="<id>"` (신규) | server (UUID) | server-returned | `escapeHtml(a.id)` |

기존 모든 interpolation이 escapeHtml로 처리됨. 신규 `data-delete-action-id` 한 attribute만 추가되며 같은 escape 패턴을 적용. innerHTML XSS gate 위반 0건.

본 단위에서 새 demo 필드를 추가하지 않는다. 라벨로 표기할 user-facing data 변동 없음.

### 6.4 Optimistic vs reload

`AGENTS.md` Frontend Conventions: "prefer reloading list + stats from the server over optimistic local mutation". 본 단위도 동일 — DELETE 204 응답 후 `openDetail(currentCallId)`로 서버 재조회. action item list 외에 다른 KPI 영향 없으므로 호출 1회면 충분.

---

## 7. 사전 결정

| # | 항목 | 결정 | 근거 |
|---|---|---|---|
| 1 | 삭제 모델 | hard delete | §1 |
| 2 | Schema 마이그레이션 | 없음 | §1 |
| 3 | 권한 helper | 기존 `assertCanMutateCall` 재사용 | 지시문 + Phase 5 일관성 |
| 4 | Route 위치 | `routes/calls.ts` (기존 action item status/assignee와 같은 파일) | 지시문 |
| 5 | calls.ts 에러 핸들러 | `PermissionError → 403` 한 줄 추가 (callsPhase5.ts와 동일 패턴) | §4.4 |
| 6 | Service 위치 | 신규 `services/callActionItems.ts` (action item 전용 service 진입점) | §4.2 |
| 7 | 응답 status | 성공 204 (body 없음) | REST 관례, 지시문 |
| 8 | shared types | 추가 0개 (response body 없음) | §3 |
| 9 | 프런트 UI | row 우측 ✕ 버튼 + 확인 모달 없음 | §6.2 |
| 10 | 테스트 prefix | `phase6test-actiondelete-` | §5.4 |

---

## 8. 작업 순서 (실행 시퀀스)

1. 본 plan 문서 — 본 작업에서 작성.
2. Repository helper (`deleteByIdInCurrentOrg`).
3. Service (`services/callActionItems.ts`).
4. Route + 에러 핸들러 보강.
5. 테스트 파일 (`phase6_action_item_delete.test.mjs`) + 검증.
6. Frontend (`api.js` + `calls.html`).
7. `PHASE_6_STEP_3_FINDINGS.md` 작성.
8. `PHASE_6_MASTER.md` Step 3 체크박스 + go/no-go 갱신.
9. 최종 검증 게이트.

---

## 9. 위험 / 결정 보류

본 단위는 schema 무변경 + 신규 SDK 의존성 없음 + 프런트 단일 페이지 변경이라 위험 표면이 좁다. 단:

- **이미 삭제된 row를 다시 삭제할 때의 race**: §4.2에서 잠금 없이 처리한다고 결정. 사용자 관점에서는 "방금 사라짐" → 404가 의도된 동작.
- **manager unassigned 통화 정책**: 본 단위는 기존 `assertCanMutateCall` 정책을 그대로 따른다. unassigned 통화의 action item을 manager가 삭제하지 못한다 — 운영자가 admin에게 위임. 정책 변경이 필요하면 별도 PR.
- **delete confirmation 미도입**: §6.2. 사용자 피드백으로 필요해지면 추후 UX 보강.

---

## 10. 완료 기준

- [ ] Repository `deleteByIdInCurrentOrg` 추가
- [ ] Service `services/callActionItems.deleteActionItem` 추가
- [ ] Route `DELETE /call-action-items/:id` + 에러 핸들러 보강
- [ ] `phase6_action_item_delete.test.mjs` 10 케이스 PASS
- [ ] Frontend 삭제 버튼 + `api.js` helper
- [ ] XSS gate classification 본 plan §6.3 기준
- [ ] `npm --prefix server run typecheck` PASS
- [ ] `npm --prefix server test` PASS
- [ ] `node test/sync_shared_types.mjs` PASS
- [ ] `PHASE_6_STEP_3_FINDINGS.md` 작성
- [ ] `PHASE_6_MASTER.md` Step 3 체크박스 ON + go/no-go "Action item DELETE endpoint + UI" 항목 ON

하나라도 실패하면 본 sub-step에 머문다.

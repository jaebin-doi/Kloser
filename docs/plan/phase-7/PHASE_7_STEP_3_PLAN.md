# Phase 7 Step 3 Plan - activity_log / audit trail

작성일: 2026-05-15

상위 문서: `PHASE_7_MASTER.md`

선행 상태:

- Phase 7 Step 1 email delivery 구현 완료
- Phase 7 Step 2 MFA/session hardening 구현 및 frontend wiring 완료
- Step 2 closeout findings는 별도 문서로 작성 예정

범위는 기존 `activity_log` 테이블을 실제 운영 감사 로그로 채우고, 관리자 조회 API와 최소 frontend 연결까지 닫는 것이다.

---

## 1. Current State

`activity_log` 테이블은 Phase 1 초기 migration에 이미 존재한다.

현재 columns:

```sql
id uuid primary key default gen_random_uuid(),
org_id uuid not null references organizations(id) on delete cascade,
user_id uuid references users(id) on delete set null,
action text not null,
target_type text,
target_id uuid,
payload jsonb not null default '{}'::jsonb,
created_at timestamptz not null default now()
```

현재 RLS:

- `activity_log`는 `ENABLE ROW LEVEL SECURITY`
- `FORCE ROW LEVEL SECURITY`
- `USING/WITH CHECK (org_id = current_app_org_id())`

현재 미구현:

- audit repository 없음
- service-level writer 없음
- mutation/auth event hook 없음
- admin 조회 route 없음
- shared type 없음
- settings/dashboard frontend는 demo 또는 placeholder

결론: Step 3는 schema-first 순서를 따르되, 새 테이블 생성보다 기존 테이블의 제약/인덱스/권한을 점검하고 필요한 forward migration만 추가한다.

---

## 2. Goals

Step 3의 목표:

1. 운영상 중요한 행위가 누가, 언제, 어떤 org에서, 어떤 target에 대해 일어났는지 남긴다.
2. 감사 로그 기록 실패가 핵심 업무 mutation을 조용히 성공시켜서는 안 되는 영역과, 로그 실패 때문에 사용자 작업을 막지 않는 영역을 구분한다.
3. 관리자만 자기 조직의 audit log를 조회할 수 있게 한다.
4. cross-org 존재 여부는 계속 숨긴다.
5. payload에는 raw token, MFA secret, password, ciphertext, provider key 같은 민감값이 절대 들어가지 않게 한다.

Non-goals:

- 전문 SIEM 연동
- immutable append-only storage/WORM
- full object diff 저장
- user-facing activity feed 전체 교체
- retention 삭제 worker 구현
- billing/audit export CSV

---

## 3. Decisions

### 3.1 Audit Write Model

결정: mutation service가 같은 DB transaction 안에서 `activity_log` row를 insert한다.

이유:

- membership role 변경, org MFA required toggle, MFA disable 같은 보안 이벤트는 원 mutation과 audit row가 같이 commit되어야 한다.
- out-of-band queue로 밀면 mutation은 성공했는데 audit row만 유실될 수 있다.
- 현재 backend는 대부분 service/repository가 `PoolClient`를 받고 transaction 경계를 명시하는 패턴이다.

정책:

- high-risk mutation의 audit insert 실패는 transaction rollback 대상이다.
- read/view 이벤트 중 report view 같은 저위험 이벤트는 별도 helper로 best-effort를 허용할 수 있다. 단 Step 3 최초 구현은 가능하면 transaction-bound write만 우선한다.

### 3.2 Actor Model

`user_id`는 행위자다.

- authenticated route: `request.user.id`
- anonymous token flow: token이 가리키는 user가 확정된 뒤 그 user id를 사용한다.
- 시스템/worker 이벤트: `user_id = null`, `payload.actor_type = "system"`

서비스 계정 `kloser_service`는 `activity_log` table grant를 받지 않는다. anonymous auth flow가 audit을 남겨야 한다면 app role + org context로 전환하거나, service transaction 안에서 직접 남겨야 하는 이유를 별도 finding에 남긴다. 기본값은 runtime app role이다.

### 3.3 Action Taxonomy

`action`은 free text로 시작하지 않는다. Step 3에서 allow-list를 TypeScript union과 DB CHECK 양쪽에 둔다.

초기 action set:

```text
auth.login
auth.logout
auth.refresh_mfa_required
auth.password_reset_requested
auth.password_reset_completed
auth.email_verified
auth.email_verification_resent

mfa.login_challenge_issued
mfa.login_verified
mfa.setup_started
mfa.enabled
mfa.disabled
mfa.failed_attempt
mfa.locked

organization.mfa_required_enabled
organization.mfa_required_disabled

membership.role_changed
membership.status_changed
membership.team_changed

invitation.created
invitation.resent
invitation.cancelled
invitation.accepted

customer.created
customer.updated
customer.deleted

call.created
call.ended
call.customer_linked
call.customer_unlinked
call.notes_updated
call.manual_summary_updated

call_action_item.created
call_action_item.status_changed
call_action_item.assignee_changed
call_action_item.deleted

knowledge_base.created
knowledge_base.updated
knowledge_base.deleted
knowledge_chunk.replaced

checklist_template.created
checklist_template.updated
checklist_template.deleted

report.team_viewed
```

Deferred action set:

- raw login failure per bad password: do not log every invalid password attempt in Step 3. It can create noise and enumeration concerns. MFA failed attempts are already stateful and security-sensitive, so they are included.
- every transcript append: too high-volume. Retention/audit only needs call-level events.
- every live suggestion use/dismiss: optional later; not P0 for operational audit.

### 3.4 Target Model

`target_type` is a short string and `target_id` is the primary id where one exists.

Examples:

- `target_type = "membership"`, `target_id = memberships.id`
- `target_type = "organization"`, `target_id = organizations.id`
- `target_type = "user"`, `target_id = users.id`
- `target_type = "customer"`, `target_id = customers.id`
- `target_type = "call"`, `target_id = calls.id`
- `target_type = "auth_token"`, `target_id = auth_tokens.id`

When a target id should not be exposed to a user, route response must still apply normal org-scoped access. The audit row can store it because it is admin-only and org-scoped.

### 3.5 Payload Policy

Payload stores small, redacted context only.

Allowed examples:

```json
{ "from_role": "employee", "to_role": "manager" }
{ "from_status": "active", "to_status": "disabled" }
{ "method": "totp" }
{ "reason": "mfa_required" }
{ "count_after": 5 }
{ "member_count_without_mfa": 2 }
```

Forbidden:

- password or password hash
- raw auth token / reset token / invite token / MFA challenge token
- TOTP secret, `otpauthUri`, `secretBase32`
- encrypted MFA secret ciphertext/tag/iv
- email outbox encrypted payload
- provider API key
- full transcript text
- full LLM prompt/completion

Repository/service tests must include at least one payload hygiene test for MFA and token-related events.

---

## 4. Schema Plan

Existing table is usable, but Step 3 should add a forward migration for stricter contracts and query performance.

Migration name:

```text
server/migrations/1715000024000_phase7_activity_log_hardening.sql
```

Additions:

1. `activity_log_action_check`

```sql
ALTER TABLE activity_log
ADD CONSTRAINT activity_log_action_check
CHECK (action IN (...initial action set...));
```

2. `activity_log_target_type_check`

```sql
ALTER TABLE activity_log
ADD CONSTRAINT activity_log_target_type_check
CHECK (
  target_type IS NULL OR target_type IN (
    'organization',
    'user',
    'membership',
    'invitation',
    'customer',
    'call',
    'call_action_item',
    'knowledge_base',
    'knowledge_chunk',
    'checklist_template',
    'auth_token',
    'session',
    'report'
  )
);
```

3. Payload object check

```sql
ALTER TABLE activity_log
ADD CONSTRAINT activity_log_payload_object_check
CHECK (jsonb_typeof(payload) = 'object');
```

4. Indexes

```sql
CREATE INDEX activity_log_org_action_created_idx
  ON activity_log(org_id, action, created_at DESC);

CREATE INDEX activity_log_org_target_created_idx
  ON activity_log(org_id, target_type, target_id, created_at DESC)
  WHERE target_type IS NOT NULL AND target_id IS NOT NULL;

CREATE INDEX activity_log_org_user_created_idx
  ON activity_log(org_id, user_id, created_at DESC)
  WHERE user_id IS NOT NULL;
```

5. Grants

No `kloser_service` grant by default. Runtime app role must have SELECT/INSERT through existing app grants; verify in migration or add explicit grants if missing.

Do not rewrite `1715000000000_init.sql`.

---

## 5. Repository Plan

Add `server/src/repositories/activityLog.ts`.

Types:

```ts
export type ActivityAction = ...;
export type ActivityTargetType = ...;

export interface ActivityLog {
  id: string;
  org_id: string;
  user_id: string | null;
  action: ActivityAction;
  target_type: ActivityTargetType | null;
  target_id: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
}
```

Helpers:

```ts
insertActivity(client, input)
listForCurrentOrg(client, query)
countForCurrentOrg(client, query)
```

`insertActivity` rules:

- takes `orgId`, but insert must still go through current org RLS.
- for most org-scoped service calls, pass `orgId = current org id`.
- no raw SQL string building for filters.
- payload defaults to `{}`.
- no `undefined` in payload; normalize to `null` or omit.

`listForCurrentOrg` query:

- `limit` default 50, max 100
- cursor pagination by `(created_at, id)` or offset-free `before` timestamp + id pair
- filters:
  - `action`
  - `target_type`
  - `target_id`
  - `user_id`
  - `created_from`
  - `created_to`

Repository tests:

- insert visible only in same org context
- bare pool/no GUC returns 0 rows
- cross-org list does not see other org row
- DB rejects unknown action
- DB rejects non-object payload
- filters work
- pagination stable with same `created_at`

---

## 6. Service Plan

Add `server/src/services/activityLog.ts`.

Responsibilities:

- central action constants
- payload sanitizer
- insert wrapper with typed action/target
- optional helpers for common events

Core API:

```ts
export async function recordActivity(client, input): Promise<void>
```

Common helper examples:

```ts
recordMembershipRoleChanged(client, { orgId, actorUserId, membershipId, fromRole, toRole })
recordMfaEnabled(client, { orgId, actorUserId, targetUserId, method })
recordOrgMfaRequiredChanged(client, { orgId, actorUserId, required, membersWithoutMfaCount })
recordActionItemDeleted(client, { orgId, actorUserId, actionItemId, callId })
```

Sanitizer:

- reject payload keys containing `token`, `secret`, `password`, `ciphertext`, `key`, `raw`
- allow explicit safe keys like `token_id` only if needed; prefer `auth_token_id`
- truncate string values to a reasonable max, e.g. 500 chars
- recursively reject arrays/objects that contain forbidden keys

Failure policy:

- default `recordActivity` throws and lets caller rollback
- optional `tryRecordActivity` can be added only for low-risk reads such as report view

---

## 7. Hook Plan

Implement hooks in small commits. Do not wire every event in one huge patch.

### 7.1 Security/auth events

Files likely touched:

- `server/src/services/auth.ts`
- `server/src/routes/auth.ts` only if route-level context is needed
- `server/src/services/organizationSecurity.ts`

Events:

- `mfa.login_challenge_issued`
- `mfa.login_verified`
- `mfa.setup_started`
- `mfa.enabled`
- `mfa.disabled`
- `mfa.failed_attempt`
- `mfa.locked`
- `organization.mfa_required_enabled`
- `organization.mfa_required_disabled`
- `auth.refresh_mfa_required`

Notes:

- Wrong TOTP should record failed attempt without challenge token or code.
- `mfa.locked` should record only when threshold trips, not on every locked retry.
- org MFA toggle should include `members_without_mfa_count` if already computed.

### 7.2 Team/invite events

Files likely touched:

- `server/src/services/team.ts` or route/service equivalents
- `server/src/routes/team.ts`
- `server/src/services/invitations.ts`

Events:

- `membership.role_changed`
- `membership.status_changed`
- `membership.team_changed`
- `invitation.created`
- `invitation.resent`
- `invitation.cancelled`
- `invitation.accepted`

Notes:

- last-admin-protected failures are not logged in Step 3 unless explicitly needed.
- invitation accept can be anonymous; actor user is the accepted/new user once known.

### 7.3 Customer/call/workflow events

Files likely touched:

- customer service/routes
- call service/routes
- call action item service/routes
- knowledge/checklist services

Events:

- customer create/update/delete
- call create/end/customer link/unlink/notes/manual summary
- action item create/status/assignee/delete
- knowledge base create/update/delete/chunks replaced
- checklist template create/update/delete

Notes:

- Avoid full object snapshots.
- For updates, payload should include changed field names and safe old/new values only where low risk.
- Customer name/email are server-returned/user-entered fields; storing full values in audit payload is allowed only if the admin audit UI escapes them. Prefer ids + field list for Step 3.

### 7.4 Report view

Event:

- `report.team_viewed`

This can be best-effort because a report read should not fail solely due to audit insert. If implemented in Step 3, use `tryRecordActivity` and log server-side warning on failure.

---

## 8. Route / Shared Type Plan

Add `server/src/types/activityLog.ts`.

Shared types:

- `ActivityLog`
- `ActivityLogListQuery`
- `ActivityLogListResponse`

Browser mirror:

- `platform/types/activityLog.js`

Registry:

- update `test/sync_shared_types.mjs`

Route:

```text
GET /activity-log
```

Prehandlers:

```text
requireAuth -> orgContext -> requireRole("admin") -> requireFreshRole
```

Query:

- `limit`
- `beforeCreatedAt`
- `beforeId`
- `action`
- `targetType`
- `targetId`
- `userId`
- `createdFrom`
- `createdTo`

Response:

```ts
{
  items: ActivityLog[],
  nextCursor: { beforeCreatedAt: string; beforeId: string } | null
}
```

Route behavior:

- employee/viewer: 403
- stale admin JWT after DB demotion: 401 `stale_role`
- cross-org target filter returns empty, not 403
- invalid UUID/date/query: 400 `invalid_input`

---

## 9. Frontend Plan

Frontend starts after schema/repo/service/route/shared type tests are green.

Primary page:

- `platform/settings.html`

UI:

- Security or Organization section gets an "감사 로그" panel.
- Admin-only.
- Show latest 20-50 events.
- Filters can be minimal in Step 3:
  - action select
  - date range optional
  - "더 보기" pagination

Data labels:

- every displayed audit value is `(API)`.
- no demo audit rows after this wiring.

XSS gate:

- audit payload values are server-returned fields.
- render action labels, user names/emails, target labels, payload text via `textContent`.
- do not use raw `innerHTML` for payload rendering.

Optional later:

- `dashboard.html` team activity demo can be replaced by latest activity log rows, but this is not required to close Step 3 unless explicitly scoped.

---

## 10. Test Plan

Required baseline:

```powershell
npm --prefix server run typecheck
npm --prefix server test
node test/sync_shared_types.mjs
```

New tests:

1. `server/test/phase7_step3_activity_log_repo.test.mjs`
   - insert/list/filter/pagination/RLS/DB checks

2. `server/test/phase7_step3_activity_log_routes.test.mjs`
   - admin GET
   - employee 403
   - stale admin 401
   - invalid query 400
   - cross-org isolation

3. Focused service/hook tests can be added to existing route test files when the hook is tightly coupled to the mutation.

Must prove at least:

- org MFA required toggle creates audit row
- authenticated MFA enable/disable creates audit rows
- membership role/status update creates audit row
- invitation created/resent/cancelled/accepted creates audit row
- action item delete creates audit row

Optional Playwright:

- settings admin can view audit log panel
- org MFA toggle appears in audit list after action

---

## 11. Implementation Order

Use standalone commits matching AGENTS.md workflow.

1. Schema hardening migration
   - CHECK constraints, indexes, grants verification
   - migration test/inspection only

2. Repository + unit tests
   - `activityLog.ts`
   - repo tests for RLS and pagination

3. Service helper + sanitizer tests
   - `recordActivity`
   - payload forbidden-key tests

4. Security/MFA/org hooks
   - auth + organization security events
   - tests prove rows are written

5. Team/invitation hooks
   - membership/invite events
   - tests prove rows are written

6. Customer/call/workflow hooks
   - selected P0 events only
   - avoid transcript high-volume events

7. Route + shared types
   - `GET /activity-log`
   - `server/src/types/activityLog.ts`
   - `platform/types/activityLog.js`
   - sync registry

8. Frontend
   - settings admin audit log panel
   - optional dashboard team activity replacement only if low risk

9. Closeout
   - implementer writes `PHASE_7_STEP_3_FINDINGS.md`
   - update `PHASE_7_MASTER.md`

---

## 12. Completion Criteria

Step 3 is complete when:

- [ ] activity log schema constraints/indexes are added via forward migration.
- [ ] activity log repository is typed and RLS-tested.
- [ ] payload sanitizer blocks sensitive key names.
- [ ] core MFA/org security events create audit rows.
- [ ] team/invitation high-risk events create audit rows.
- [ ] customer/call/action item selected events create audit rows.
- [ ] admin can query own org audit log via `GET /activity-log`.
- [ ] non-admin cannot query audit log.
- [ ] stale admin JWT cannot query audit log.
- [ ] shared types are synced.
- [ ] settings admin UI shows real `(API)` audit rows.
- [ ] `npm --prefix server run typecheck` PASS.
- [ ] `npm --prefix server test` PASS.
- [ ] `node test/sync_shared_types.mjs` PASS.
- [ ] Step 3 findings written and reviewed.

---

## 13. Next Task For Implementer

Start with Step 3 schema hardening:

1. Add `1715000024000_phase7_activity_log_hardening.sql`.
2. Add action and target type CHECK constraints.
3. Add payload object CHECK.
4. Add query indexes.
5. Verify app role can INSERT/SELECT through RLS.
6. Do not wire service hooks yet.

After that commit is green, proceed to repository + unit tests.

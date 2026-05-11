# Phase 3 Step 4 — Team / Member API + 마지막 admin 보호 + requireFreshRole

> **상위 계획**: `docs/plan/phase-3/PHASE_3_MASTER.md` §3 Step 4 + §2-11·12·13·14.
> **선행**: Step 3 완료 — `PHASE_3_STEP_3_FINDINGS.md`. Phase 1 auth + Step 1 schema (`memberships.status` CHECK + active partial index) + Step 3 session revoke 패턴 모두 깔린 상태.
> **기간**: 1일.

---

## 진행 상태

- [ ] 1. lock-ins 사전 결정 (본 plan §1)
- [ ] 2. `memberships` repository 확장 (§2) — `listForCurrentOrgWithUser` / `getByIdInCurrentOrgForUpdate` / `lockActiveAdminIds` / `updateRoleStatus`
- [ ] 3. `services/memberships.ts` 신규 (§3) — `updateMembership({client, id, patch})` wrapper. 마지막 active admin 보호 트랜잭션 + (status='disabled' 시) 같은 user+org 활성 sessions 즉시 revoke
- [ ] 4. `services/teams.ts` 신규 (§4) — list / create / update / delete. cross-org pollution 방어 (`managerId`는 같은 org의 user인지 검증)
- [ ] 5. `requireFreshRole` middleware 신규 (§5) — JWT의 role 대 DB 현재 role 비교, 다르면 `401 stale_role`
- [ ] 6. `resolveMembershipForLogin` 변경 (§6) — 활성 membership 0건이면 `401 account_disabled`로 명시 throw (현재 `invalid_credentials`와 분기)
- [ ] 7. `routes/team.ts` 신규 (§7) — 6 endpoints (`/team/members`, `/memberships/:id`, `/teams`×4) + middleware 매트릭스
- [ ] 8. shared types (§8) — `team` entity 등록 (`Member`, `MemberListItem`, `TeamCreateInput`, `TeamPatchInput` 등)
- [ ] 9. 단위 테스트 (§9) — ~22 cases 목표
- [ ] 10. `npm --prefix server run typecheck` PASS
- [ ] 11. `npm --prefix server test` PASS — 신규 ~22 + Step 1·2·3 회귀 101 = ~123
- [ ] 12. `node test/sync_shared_types.mjs` PASS — `team` entity 등록 후
- [ ] 13. Phase 0.5 / Phase 2 customers e2e 회귀 PASS
- [ ] 14. 수동 검증 (§10) — 마지막 admin 강등 차단 / disabled 멤버 로그인 401 / stale JWT 401 / team CRUD
- [ ] 15. `PHASE_3_STEP_4_FINDINGS.md` 작성

---

## 0. 목적

Master §1의 다섯 번째 산출물 "Team / Member API + 권한 매트릭스" 구현. 이 step이 끝나면:

- 평가자가 admin으로 로그인해 같은 org의 멤버 목록 / 팀 목록을 보고, 새 팀 만들고, 멤버 역할/상태를 바꾸고, 마지막 admin을 잘못 강등 시도 시 차단되는 경험까지 확인 가능
- Step 5 (invitations 생성/취소) 가 `requireFreshRole` middleware + 마지막 admin 보호 + 멤버 lookup 패턴을 그대로 재사용
- 옛 access token (예: 막 demote된 admin) 으로 admin-only mutation 시도 → `401 stale_role` 즉시 차단
- per-org disabled 멤버는 `/auth/login`에서 `401 account_disabled` (현재의 generic `invalid_credentials`와 분리)

신규 인프라 (서비스 credential / 추가 풀 / 신규 마이그레이션) **없음** — 본 step은 인증 인프라 위 도메인 추가만.

---

## 1. 사전 결정 lock-ins

| 항목 | 결정 | 근거 |
|---|---|---|
| 1. 본 step의 mutation 권한 매트릭스 | **admin only** — manager/employee/viewer는 모두 read-only. Master §1-팀 단위 분기와 §2-13 정합 | Phase 3은 흐름 완성. team-scope write (manager가 자기 팀만)는 Phase 4+. 본 step 분기는 binary (admin vs nonadmin) |
| 2. `requireFreshRole` 적용 범위 | **본 plan에서 admin-only mutation 4 endpoint 전부에 적용**: `PATCH /memberships/:id`, `POST /teams`, `PATCH /teams/:id`, `DELETE /teams/:id`. Master §2-14와 정합 (role/status/team/invitation 모두 동일 security-class로 묶음) | demoted admin이 act하는 케이스를 동일 방식으로 차단. cost는 endpoint당 DB round-trip 1회 — 무시 가능. Step 5에서 `POST /invitations` / `DELETE /invitations/:id` 동일 미들웨어 추가 적용 |
| 3. 마지막 active admin 보호 트랜잭션 패턴 | mutation tx 시작 시 `SELECT id FROM memberships WHERE org_id=? AND role='admin' AND status='active' ORDER BY id FOR UPDATE` — **모든 활성 admin 행을 deterministic 순서로 lock**한 뒤 변경 시뮬레이션. 변경 후 활성 admin이 0이 되면 `409 last_admin_protected` throw. ORDER BY id는 두 동시 mutator 간 cross-row deadlock 방지 | 단순 count() 후 변경은 phantom race (두 admin 동시 demote → 0 admin) 위험. 전체 admin 집합 lock으로 concurrent mutation 직렬화 — Phase 1 refresh rotation의 FOR UPDATE 패턴 정신과 동일 |
| 4. 본인이 자기를 admin → 다른 role로 강등 시 | 별도 차단 없음 — 마지막 admin 보호만 적용. 본인이 마지막 admin이면 self-demote도 막힘, 아니면 허용 | 마지막 admin 보호로 충분. 본인이 본인을 다른 admin으로 바꾸는 자기 보호 logic은 over-engineering — admin이 N명일 때 자기 강등은 정상 운영 흐름 |
| 5. `PATCH /memberships/:id`에서 status='disabled' 시 sessions revoke 정책 | **같은 tx 안에서 `(user_id, org_id)` 매칭 활성 sessions 즉시 revoke** (`revoked_reason = 'admin_disabled'`). Step 3 password reset pattern 재사용 | Master §11 "기존 활성 sessions은 refresh 시 무효화"의 eager 해석. lazy (refresh 시 reject)만으로도 가능하지만 audit trail / 운영 가시성 측면에서 eager가 유리. cost는 UPDATE 1행 |
| 5b. disabled member가 team manager였을 때 cleanup | **같은 tx 안에서 `UPDATE teams SET manager_id = NULL WHERE org_id = ? AND manager_id = user_id`** 즉시 실행. eager — sessions revoke와 동일 정책 | 비활성 멤버를 teams.manager_id가 계속 가리키면 운영 일관성 깨짐 (UI에 disabled 사람이 "팀 매니저"로 표시). lazy (다음 PATCH 때만 정리)는 0건일 가능성 — eager가 안전 |
| 6. status enum 확장 여부 | **변경 없음** — `'active' \| 'disabled'` 2 값 그대로. 'invited' / 'suspended' 등 추가 안 함 | Step 1 CHECK 그대로. invitation 미수락은 invitations 테이블에 존재하지 멤버십 status가 아님 |
| 7. role 변경 가능 값 | 모든 4 role 간 자유 전환 (`admin` ↔ `manager` ↔ `employee` ↔ `viewer`). 단 admin이 0이 되는 변경만 차단 (§1-3) | 본 step은 단순 admin 매트릭스. team-scope 권한 (manager의 sub-권한)은 Phase 4+에서 별도 분기 |
| 8. disabled membership login 분리 응답 | `401 account_disabled` (Master §11) — 현재 `invalid_credentials`와 분기. enumeration 측면에서 email 존재가 노출되지만 master 정책 의도 | UX 측면에서 사용자가 "비밀번호 틀림"인지 "계정 비활성화"인지 구분 가능. enumeration 차단은 forgot password에 한정 (Step 3) |
| 9. `GET /team/members` 응답 shape | `Member` = (id, role, status, team {id,name}\|null, user {id,email,name,email_verified_at\|null}) + 페이지네이션 없음. Phase 3 시점 org 멤버 수가 N<100 가정 | 단순. pagination/검색은 Phase 4+ |
| 10. `teams.manager_id` cross-org pollution 방어 | service에서 `managerId` 검증: 같은 org의 active membership 보유한 user인지 확인. 미일치 시 `400 invalid_manager` | FK는 users(id)라 다른 org user도 INSERT 가능. service-layer가 1차 방어. 향후 composite FK로 강화 가능하지만 본 step에선 service 검증으로 충분 |
| 11. `DELETE /teams/:id` 동작 | **service 트랜잭션이 먼저 `UPDATE memberships SET team_id = NULL WHERE team_id = $1` 후 `DELETE FROM teams`** (hard delete). Phase 1 composite FK `(org_id, team_id) → teams(org_id, id) ON DELETE SET NULL`이 단순 적용 시 `org_id`까지 NULL 시도해 NOT NULL 위반으로 cascade가 실패하므로, service-layer 사전 정리로 회피. 자세한 SQL은 §4 DELETE 섹션 | soft delete 도입 비용 vs 운영 가치 — 본 step에선 hard delete 단순. Phase 4+ team archive 요구 발생 시 별도. DB-level fix (`ON DELETE SET NULL (team_id)` 문법, PG 15+)는 별도 migration 비용이라 Phase 3에선 service-layer로 |
| 12. team 삭제가 마지막 team이 되어도 막지 않음 | 별도 차단 없음. 팀이 0개여도 멤버 자체는 정상 동작 (team_id NULL) | "마지막 team 보호" 정책은 비즈니스 가치 불명확. last admin과 다른 ranks |
| 13. `requireFreshRole` 미들웨어가 DB 못 잡을 때 | `401 stale_role` 대신 `500` (Fastify default). RLS GUC 없이 `getActiveMembershipInCurrentOrg` 호출 시점 `setOrgContext(orgId)`로 selectively scope | DB transient는 stale role 판단과 무관. requireAuth → orgContext → requireFreshRole 순으로 middleware chain |
| 14. 본 step의 shared types | `Member` (route 응답 shape), `MembershipPatchInput`, `Team`, `TeamCreateInput`, `TeamPatchInput`. zod 원본 + JSDoc 사본 + sync registry 등록 | Phase 2 패턴 그대로. entity name = `team` (members와 teams 둘 다 묶음). 별도 `member` entity는 안 만듦 — `Member`는 `team`의 sub-type |
| 15. e2e 영향 | Phase 0.5 / Phase 2 customers e2e 회귀만. Phase 3 e2e는 Step 7에서 별도 작성 | 본 step은 routes 추가지 기존 동작 변경 없음. login은 disabled branch만 추가라 seed 시 disabled 멤버가 없으므로 회귀 영향 없음 |

---

## 2. `memberships` repository 확장

`server/src/repositories/memberships.ts`에 추가 함수:

```ts
// for GET /team/members — user/team JOIN
export interface MemberRow {
  id: string;
  role: MembershipRole;
  status: string;
  team_id: string | null;
  team_name: string | null;
  user_id: string;
  user_email: string;
  user_name: string;
  user_email_verified_at: Date | null;
}
export async function listForCurrentOrgWithUser(client: PoolClient): Promise<MemberRow[]>;

// for PATCH /memberships/:id — FOR UPDATE lock on the target row
export async function getByIdForUpdate(client: PoolClient, id: string): Promise<Membership | null>;

// for last admin protection — locks every active admin row in the current org.
// SQL: `SELECT id FROM memberships
//        WHERE org_id = current_app_org_id()      -- enforced by RLS too
//          AND role = 'admin' AND status = 'active'
//        ORDER BY id
//        FOR UPDATE`
// ORDER BY id makes the lock acquisition order deterministic across
// concurrent callers — two simultaneous mutators always grab the rows in
// the same sequence, eliminating cross-row deadlock risk.
export async function lockActiveAdminIds(client: PoolClient): Promise<string[]>;

// applies the patch + returns the new row
export async function updateRoleStatus(
  client: PoolClient,
  id: string,
  patch: { role?: MembershipRole; status?: 'active' | 'disabled' },
): Promise<Membership | null>;
```

`getActiveMembershipInCurrentOrg` (services/auth.ts 내부 헬퍼)는 그대로 유지. 본 step의 repo 추가는 read·write 분리.

`memberships` RLS 정책이 `org_id = current_app_org_id()`라 routes가 `app.withOrgContext(orgId, ...)` 안에서 호출하면 자동 격리. 다른 org의 membership을 patch하려는 시도는 `getByIdForUpdate`가 0행 → `404 not_found` (RLS 동작이 그대로 격리 보장).

---

## 3. `services/memberships.ts` 신규

```ts
// Phase 3 Step 4 — membership mutation service.
// Plan: docs/plan/phase-3/PHASE_3_STEP_4_TEAM_MEMBER_API.md §3.

export interface UpdateMembershipInput {
  membershipId: string;                       // 대상 membership.id
  patch: { role?: MembershipRole; status?: 'active' | 'disabled' };
}

export async function updateMembership(
  ctx: { withOrgContext: WithOrgContext; orgId: string },
  input: UpdateMembershipInput,
): Promise<Membership> {
  return ctx.withOrgContext(ctx.orgId, async (client) => {
    // 1) Lock the target row + the entire active-admin set.
    //    The order matters: lock active admins first so concurrent mutators
    //    queue deterministically (any tx that needs to read/modify an active
    //    admin must wait on this set).
    const adminIds = await lockActiveAdminIds(client);
    const target   = await getByIdForUpdate(client, input.membershipId);
    if (!target) throw new AuthError(404, "not_found", "membership not found");

    // 2) Simulate the patch and check the post-state of active admins.
    const wouldBeAdmin = (input.patch.role ?? target.role) === 'admin';
    const wouldBeActive = (input.patch.status ?? target.status) === 'active';
    const isAdminNow = target.role === 'admin' && target.status === 'active';

    if (isAdminNow && !(wouldBeAdmin && wouldBeActive)) {
      // Target is being demoted or disabled — remove them from the set.
      const survivingAdmins = adminIds.filter((id) => id !== target.id);
      if (survivingAdmins.length === 0) {
        throw new AuthError(409, "last_admin_protected",
          "cannot remove the last active admin");
      }
    }

    // 3) Apply the patch.
    const updated = await updateRoleStatus(client, target.id, input.patch);
    if (!updated) throw new AuthError(404, "not_found", "membership not found");

    // 4) If we just disabled the member, perform two cleanups in the same
    //    transaction (eager — see plan §1-5):
    //    (a) Revoke their active sessions in this org (sessions has
    //        user_id + org_id columns from Phase 1 Step 3).
    //    (b) Clear any teams.manager_id pointing at this user in this org
    //        so a disabled member is never listed as a team manager.
    if (input.patch.status === 'disabled' && target.status === 'active') {
      await client.query(
        `UPDATE sessions
            SET revoked_at     = COALESCE(revoked_at, now()),
                revoked_reason = COALESCE(revoked_reason, 'admin_disabled')
          WHERE user_id    = $1
            AND org_id     = $2
            AND revoked_at IS NULL`,
        [target.user_id, ctx.orgId],
      );
      // RLS scopes the UPDATE to current org automatically. The org_id
      // filter is redundant here but kept for clarity.
      await client.query(
        `UPDATE teams SET manager_id = NULL
          WHERE org_id = $2 AND manager_id = $1`,
        [target.user_id, ctx.orgId],
      );
    }

    return updated;
  });
}
```

**Race condition 안전성**: `lockActiveAdminIds` 직후 다른 tx가 같은 org의 admin row를 변경하려면 우리 lock이 풀릴 때까지 대기. 우리 commit 후 다른 tx 재평가 시 admin 집합이 갱신돼 정확한 카운트 적용.

---

## 4. `services/teams.ts` 신규

```ts
export async function listTeams(ctx: WithOrgCtx): Promise<Team[]>;
export async function createTeam(ctx: WithOrgCtx, input: { name: string; managerId?: string | null }): Promise<Team>;
export async function updateTeam(ctx: WithOrgCtx, id: string, patch: { name?: string; managerId?: string | null }): Promise<Team>;
export async function deleteTeam(ctx: WithOrgCtx, id: string): Promise<void>;
```

### managerId 검증 (cross-org pollution 방어)

create/update에서 `managerId !== null`이면:
```sql
SELECT 1 FROM memberships
 WHERE user_id = $1
   AND status  = 'active'
LIMIT 1
```
`withOrgContext` 안에서 호출되므로 RLS가 자동으로 `org_id = current_app_org_id()` 적용. 다른 org의 user면 0행 → `400 invalid_manager`.

### DELETE

**중요 — Phase 1 FK 형태가 ON DELETE SET NULL을 단순 적용 못 함**:

`memberships` 테이블의 FK는 Phase 1 init schema (line 65)에서:
```sql
FOREIGN KEY (org_id, team_id) REFERENCES teams(org_id, id) ON DELETE SET NULL
```
composite FK + 컬럼 리스트 미지정 + SET NULL이면 PostgreSQL은 referencing columns 전부 (`org_id`, `team_id`)를 NULL로 set하려고 시도. 하지만 `memberships.org_id`는 NOT NULL이라 cascade 자체가 실패 (`23502 not_null_violation`). 결과: 단순 `DELETE FROM teams WHERE id = $1`은 그 team을 참조하는 membership이 1개라도 있으면 실패.

**해결 (서비스-레벨 사전 정리)** — DB-레벨 FK 재정의 대신 service 트랜잭션이 먼저 `team_id`만 NULL 처리한 뒤 DELETE:

```ts
await ctx.withOrgContext(ctx.orgId, async (client) => {
  // 1) Drop the team_id pointer from every membership in this org.
  //    RLS scopes the UPDATE to current org automatically.
  await client.query(
    `UPDATE memberships SET team_id = NULL WHERE team_id = $1`,
    [teamId],
  );
  // 2) Also clear teams.manager_id pointer if any other team referenced
  //    the same manager (none currently — manager_id is on teams itself —
  //    but defensive). Skip if not applicable.
  // 3) DELETE the team. teams.manager_id is users(id) ON DELETE SET NULL
  //    which works fine (no composite FK).
  const r = await client.query(`DELETE FROM teams WHERE id = $1`, [teamId]);
  if (r.rowCount === 0) throw new AuthError(404, "not_found", "team not found");
});
```

soft delete 도입 안 함 (§1-11). Phase 4+ 운영 단계에서 composite FK를 `ON DELETE SET NULL (team_id)` (PG 15+ 문법)으로 재정의하면 service의 사전 정리 단계 제거 가능 — 본 step은 마이그레이션 추가 없이 service-layer로 해결.

---

## 5. `requireFreshRole` middleware 신규

`server/src/middleware/requireFreshRole.ts`:

```ts
import type { FastifyRequest, FastifyReply } from "fastify";

export async function requireFreshRole(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!request.user) {
    reply.code(401).send({ error: "authentication required", code: "auth_required" });
    return;
  }
  const { id: userId, orgId, role: jwtRole, membershipId } = request.user;

  const current = await request.server.withOrgContext(orgId, async (client) => {
    const r = await client.query<{ role: string; status: string }>(
      `SELECT role, status FROM memberships WHERE id = $1`,
      [membershipId],
    );
    return r.rows[0] ?? null;
  });

  if (!current || current.status !== 'active') {
    reply.code(401).send({ error: "session no longer valid", code: "stale_session" });
    return;
  }
  if (current.role !== jwtRole) {
    reply.code(401).send({ error: "role changed — please re-login", code: "stale_role" });
    return;
  }
}
```

### preHandler 매트릭스 (route별)

| Endpoint | preHandlers |
|---|---|
| `GET /team/members` | requireAuth |
| `PATCH /memberships/:id` | requireAuth, requireRole('admin'), requireFreshRole |
| `GET /teams` | requireAuth |
| `POST /teams` | requireAuth, requireRole('admin'), requireFreshRole |
| `PATCH /teams/:id` | requireAuth, requireRole('admin'), requireFreshRole |
| `DELETE /teams/:id` | requireAuth, requireRole('admin'), requireFreshRole |

`requireRole('admin')`이 1차 차단 (JWT role 검사), `requireFreshRole`이 2차 차단 (DB role 검사). 둘 다 통과해야 mutation 진입.

---

## 6. `resolveMembershipForLogin` 변경 — `account_disabled` 분기

(`services/auth.ts`)

현재 `resolveMembershipForLogin`은 활성 membership 0건 시 `401 invalid_credentials`. 본 step에서:

```ts
const memberships = await listActiveMembershipsAcrossOrgs(client, input.userId);
if (memberships.length === 0) {
  // user 존재 + password OK + 활성 membership 0건 = per-org 모두 disabled.
  throw new AuthError(401, "account_disabled", "account is disabled");
}
// ... 기존 multi-membership / single-membership 분기 그대로
```

`invalid_credentials` 분기 (user 없음 / password 틀림)와 `account_disabled` 분기 (user 있음 + password OK + 활성 membership 0건)가 분리됨. enumeration 차단은 forgot password에 한정 (Step 3). master §11 정합.

---

## 7. `routes/team.ts` 신규

```ts
async function teamRoutes(app: FastifyInstance) {
  app.get(  "/team/members", { preHandler: [requireAuth, orgContext] }, ...);
  app.patch("/memberships/:id", { preHandler: [requireAuth, orgContext, requireRole('admin'), requireFreshRole] }, ...);

  app.get(   "/teams",     { preHandler: [requireAuth, orgContext] }, ...);
  app.post(  "/teams",     { preHandler: [requireAuth, orgContext, requireRole('admin'), requireFreshRole] }, ...);
  app.patch( "/teams/:id", { preHandler: [requireAuth, orgContext, requireRole('admin'), requireFreshRole] }, ...);
  app.delete("/teams/:id", { preHandler: [requireAuth, orgContext, requireRole('admin'), requireFreshRole] }, ...);
}
```

본 step에선 `team.ts` 단일 파일에 두 entity 묶음. customer.ts와 같은 단순 구조.

`orgContext` middleware는 Phase 1 / Phase 2에서 정의된 것 — `request.orgId`를 설정. 본 step에서 변경 없음.

응답 shape는 §8 shared types로 정형.

---

## 8. Shared types — `team` entity 등록

`server/src/types/team.ts`:

```ts
import { z } from "zod";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = z.string().regex(UUID_RE);

export const Team = z.object({
  id:         z.string(),
  name:       z.string(),
  manager_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const TeamCreateInput = z.object({
  name:      z.string().min(1).max(200),
  managerId: uuid.nullable().optional(),
});

export const TeamPatchInput = z.object({
  name:      z.string().min(1).max(200).optional(),
  managerId: uuid.nullable().optional(),
});

export const Member = z.object({
  id:                z.string(),
  role:              z.enum(['admin','manager','employee','viewer']),
  status:            z.enum(['active','disabled']),
  team_id:           z.string().nullable(),
  team_name:         z.string().nullable(),
  user_id:           z.string(),
  user_email:        z.string(),
  user_name:         z.string(),
  user_email_verified_at: z.string().nullable(),
});

export const MembershipPatchInput = z.object({
  role:   z.enum(['admin','manager','employee','viewer']).optional(),
  status: z.enum(['active','disabled']).optional(),
}).refine((v) => v.role !== undefined || v.status !== undefined,
  { message: "at least one of role/status required" });

export type Team                 = z.infer<typeof Team>;
export type TeamCreateInput      = z.infer<typeof TeamCreateInput>;
export type TeamPatchInput       = z.infer<typeof TeamPatchInput>;
export type Member               = z.infer<typeof Member>;
```

`platform/types/team.js` JSDoc 사본. `test/sync_shared_types.mjs` registry에 `team` entity 추가.

Sync targets: `Team`, `TeamCreateInput`, `TeamPatchInput`, `Member`. `MembershipPatchInput`은 `.refine`이 있어 derived — sync scope 밖.

---

## 9. 단위 테스트 — `server/test/team_member_routes.test.mjs`

새 파일 1개, ~22 cases. 시드 (Acme admin / employee) 재사용 + 필요 시 test 안에서 추가 user/membership 생성. afterEach가 본 테스트가 만든 row만 정리.

### Members

1. `GET /team/members` admin → 200, 본 org 멤버 N건 (Acme=2 default)
2. `GET /team/members` employee → 200, 같은 N건 (read는 role 무관)
3. `GET /team/members` viewer (없으면 추가 생성 후 테스트) → 200
4. `GET /team/members` 다른 org admin → 자기 org 멤버만 (RLS isolation)

### PATCH /memberships/:id (role / status / 마지막 admin / requireFreshRole)

5. admin이 employee role → manager로 변경 → 200, status 보존
6. admin이 employee status → disabled로 변경 → 200, `sessions` 그 user+org 항목 모두 `revoked_reason='admin_disabled'`
6b. disabled되는 멤버가 team manager였을 때 → `teams.manager_id` 자동 NULL 처리 (같은 tx). 다른 org의 team에서 같은 user가 manager면 그 row는 건드리지 않음 (RLS scope)
7. admin이 자기 자신을 employee로 강등 (다른 admin 없음, 시드 상태) → **409 last_admin_protected**
8. 추가 admin 생성 후 자기 자신 강등 → 200 (last admin 보호 해제)
9. **모든 admin을 disable** 시도 (마지막 활성 admin disable) → 409 last_admin_protected
10. **race**: 두 동시 PATCH가 각각 다른 admin을 demote 시도 — FOR UPDATE lock으로 직렬화 → 한 쪽만 성공, 다른 쪽 409
11. **stale role**: JWT의 role='admin', DB role 'employee'로 직접 변조 → PATCH 호출 시 `401 stale_role`
12. employee가 PATCH 시도 → 403 (requireRole)
13. 다른 org의 membership id로 PATCH 시도 → 404 not_found (RLS)
14. 빈 body (role/status 모두 없음) → 400 schema

### disabled login (login 흐름 변경)

15. user 생성 후 그 user의 유일한 membership을 disabled로 만든 뒤 `/auth/login` → **401 account_disabled** (`invalid_credentials`와 분리)
16. user의 비밀번호가 틀린 경우 → **401 invalid_credentials** (account_disabled와 분리 — enumeration 분기 확인)
17. user가 multi-org 중 한 org disabled, 다른 org active → 200 + active org로 로그인

### Teams CRUD

18. admin이 `POST /teams {name}` → 201, list에 등장
19. admin이 `POST /teams {name, managerId}` cross-org user → 400 invalid_manager
20. admin이 `PATCH /teams/:id {name}` → 200
21. admin이 `DELETE /teams/:id` → 204. service 트랜잭션이 먼저 `UPDATE memberships SET team_id=NULL WHERE team_id=$1` 후 DELETE — composite FK SET NULL이 org_id까지 건드려 실패하는 케이스 회피 (§4 DELETE 섹션). memberships.team_id가 NULL로 정리됐는지 DB assert
22. employee가 `POST /teams` → 403
23. 다른 org의 team id로 PATCH/DELETE → 404 not_found
24. stale role JWT로 DELETE → 401 stale_role

afterEach가 test에서 만든 추가 user/team을 prefix-based sweep. seeded 행 손대지 않음.

---

## 10. e2e 영향 + 수동 검증 (Phase 3 Step 7 e2e에 합치기 전 사전 확인)

수동:
- Acme admin 로그인 → `GET /team/members` → 2건
- `PATCH /memberships/<emp>` `status='disabled'` → 200
- emp 로그인 → 401 account_disabled
- `PATCH` 다시 status='active' → 200, 로그인 다시 가능
- admin이 본인 강등 시도 → 409 last_admin_protected
- `POST /teams {name:"Test"}` → 201 → `GET /teams` 1건 → `DELETE` 후 빈 목록

자동 회귀:
- `node test/phase_0_5_e2e.mjs` 16/16
- `node test/phase_2_customers_e2e.mjs` 7/7

Phase 3 e2e는 Step 7에서 별도 작성 — 본 step에선 수동 검증 + 단위 테스트만.

---

## 11. 위험·미정

| 항목 | 처리 |
|---|---|
| `lockActiveAdminIds`가 admin 0명 org에서는 빈 set 반환 → 정상 진행 후 변경 적용 시 활성 admin 새로 생기는 케이스 (예: employee → admin 승격) | 본 step에서 그 케이스는 `wouldBeAdmin && wouldBeActive` 분기가 admin set 증가로 인식 — 보호 비활성. 마지막 admin "보호"는 admin 감소 방향만 |
| `requireFreshRole`가 endpoint당 DB round-trip 1회 추가 | dev에서 <5ms 추가. cost 무시 가능. 운영 측정은 Phase 6+ |
| sessions revoke가 eager — Master §11의 "refresh 시 무효화" 문구와 일견 다름 | Master 의도는 "next refresh가 실패해야 한다"이고 eager도 그 결과를 충족 + audit trail 우월. Step 4 finding에 명시 |
| disabled login의 `account_disabled` 응답이 email enumeration 노출 | Master §11 의도된 정책. forgot password (Step 3)는 enumeration 차단, login은 노출 — UX와 보안의 의도된 분기 |
| 마지막 admin 보호의 `FOR UPDATE`가 admin 행 전체 lock — admin이 매우 많은 org에서 contention | Phase 3 시점 org 멤버 N<100 가정이라 무시. Phase 6+ enterprise tier에서 admin 100명+ 경우 advisory lock 등 정교화 검토 |
| `teams.manager_id` 검증을 service-layer만으로 — DB-level composite FK 강화 안 함 | service 검증으로 1차 방어. Phase 4+ teams 스키마 정리 시 composite FK 추가 검토 (`FOREIGN KEY (org_id, manager_id) REFERENCES memberships(org_id, user_id)`) |
| `memberships`의 composite FK (`(org_id, team_id) → teams(org_id, id) ON DELETE SET NULL`)가 단순 SET NULL 사용 시 `org_id`까지 NULL 시도해 NOT NULL 위반으로 cascade 실패 | 본 step에서 DB 마이그레이션 없이 service-layer 사전 정리로 해결 (§4 DELETE 섹션). Phase 4+에서 `ON DELETE SET NULL (team_id)` (PG 15+) 문법으로 FK 재정의하면 service 사전 정리 단계 제거 가능 |
| disabled member가 다른 org에서 manager일 가능성 (`UPDATE teams SET manager_id = NULL`이 RLS로 자기 org만 affect) | 의도된 동작. cross-org manager 정리는 그 org의 admin이 별도로 처리. multi-org 시나리오는 본 step 단위 테스트 #6b에 명시 |
| `requireFreshRole`이 stale_session (membership row 없음 / disabled)도 401로 묶음 | 본 step에서 분기 코드 (`stale_session` vs `stale_role`) 분리 응답. 운영 디버깅 시 구분 가능 |
| `account_disabled` 응답이 multi-org user의 일부 org disabled에서 발생하지 않음 — active org가 하나라도 있으면 정상 진입 | 의도된 동작. user는 active org로 진입. multi-org disabled 알림은 평가자 UX 별 |
| 본 step에 e2e 부재 | Step 7에서 통합 e2e 작성. 본 step 단위 테스트 + 수동 검증으로 게이트 |
| `requireFreshRole` 가 `request.user.role`이 stale일 때 401만 던지고 자동 재발급 안 함 | 의도. 사용자는 재로그인 안내. 자동 silent refresh로 복구하는 흐름은 Phase 6+ UX 정책 (예: 클라이언트가 stale_role 응답 시 logout 후 안내) |

---

## 12. 완료 기준 (Step 4 — go/no-go)

- [ ] `server/src/middleware/requireFreshRole.ts` 신규
- [ ] `server/src/services/memberships.ts` 신규 + `updateMembership` 함수
- [ ] `server/src/services/teams.ts` 신규 + 4 함수
- [ ] `server/src/repositories/memberships.ts` 확장 + `lockActiveAdminIds` / `listForCurrentOrgWithUser` 등
- [ ] `server/src/routes/team.ts` 신규 + 6 endpoint
- [ ] `server/src/services/auth.ts` 변경 — `resolveMembershipForLogin`에 `account_disabled` 분기
- [ ] `server/src/types/team.ts` + `platform/types/team.js` + sync registry 추가
- [ ] `npm --prefix server run typecheck` PASS
- [ ] `npm --prefix server test` PASS — 신규 ~22 + Step 1·2·3 회귀 101 = ~123
- [ ] `node test/sync_shared_types.mjs` PASS (customers + signup + password-reset + team)
- [ ] `node test/phase_0_5_e2e.mjs` 16/16 회귀 PASS
- [ ] `node test/phase_2_customers_e2e.mjs` 7/7 회귀 PASS
- [ ] 수동 검증 (§10) 모두 의도대로 동작
- [ ] `docs/plan/phase-3/PHASE_3_STEP_4_FINDINGS.md` 작성

---

## 13. 한 줄 요약

> **1일 동안 6 endpoint (`/team/members`, `/memberships/:id`, `/teams` × 4) + 마지막 active admin 보호 트랜잭션 (FOR UPDATE lock 패턴) + `requireFreshRole` middleware (admin-only mutation 4개에 적용) + `account_disabled` 로그인 분기를 깐다. Step 3의 sessions revoke 패턴 재사용. 신규 마이그레이션 / 풀 / 환경 변수 0개.**

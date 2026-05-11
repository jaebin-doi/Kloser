# Phase 3 Step 5 — Invitation API (생성 / 목록 / 재발송 / 취소 / 익명 수락)

> **상위 계획**: `docs/plan/phase-3/PHASE_3_MASTER.md` §3 Step 5 + §2-9·10.
> **선행**: Step 4 완료 — `PHASE_3_STEP_4_FINDINGS.md`. Step 1 schema (invitations 보강 + auth_tokens UNIQUE partial + email_outbox) + Step 2 service credential + Step 3 sendTokenError + Step 4 requireFreshRole 모두 깔린 상태.
> **기간**: 1일.

---

## 진행 상태

- [ ] 1. lock-ins 사전 결정 (본 plan §1)
- [ ] 2. `server/src/repositories/invitations.ts` (신규) — `findPendingByOrgEmailForUpdate` / `findActiveTokenByInvitationForUpdate` / `createInvitationRow` / `cancelInvitationRow` / `markAcceptedRow` / `listActivePendingForCurrentOrg`
- [ ] 3. `server/src/services/invitations.ts` (신규) — `createInvitation` / `listActivePendingInvitations` / `resendInvitation` / `cancelInvitation` / `acceptInvitation` (anonymous, servicePool 트랜잭션 owner)
- [ ] 4. `server/src/routes/invitations.ts` (신규) — 5 endpoint. mutation 3개 (`POST`, `POST .../resend`, `DELETE`)에 `requireAuth → orgContext → requireRole('admin') → requireFreshRole` 체인. `accept`는 anonymous + sendTokenError 매핑
- [ ] 5. `sendTokenError` 공용화 — `routes/auth.ts` file-local을 분리/export (회귀 0)
- [ ] 6. shared types — `invitation` entity 등록 (zod + JSDoc + sync registry)
- [ ] 7. 단위 테스트 — ~25 cases (already_member 2 + disabled-retry / membership-retry / users.email race 3 추가)
- [ ] 8. `npm --prefix server run typecheck` PASS
- [ ] 9. `npm --prefix server test` PASS — 신규 ~25 + Step 1·2·3·4 회귀 125 = ~150
- [ ] 10. `node test/sync_shared_types.mjs` PASS — `invitation` entity 등록 후
- [ ] 11. Phase 0.5 / Phase 2 customers e2e 회귀 PASS
- [ ] 12. 수동 검증 (§10) — admin → invite → outbox token 추출 → accept (신규 user) → login → 멤버 목록 등장 / resend / cancel
- [x] 13. `PHASE_3_MASTER.md` §2-14 / §3-302 갱신 — invitation `requireFreshRole` 범위에 "재발송" 추가 + accept를 명시적으로 제외 (본 plan 갱신 turn에 함께 적용)
- [ ] 14. `PHASE_3_STEP_5_FINDINGS.md` 작성

---

## 0. 목적

Master §1 산출물 4 "직원 초대 — 생성·재발송·취소·수락 흐름 완성"의 5 endpoint 구현. 본 step이 끝나면:

- admin이 `POST /invitations`로 새 멤버를 초대 → dev outbox에 메일 → 외부 사용자가 raw token으로 `POST /invitations/accept` → 신규 user + active membership + access/refresh 발급 (즉시 로그인 상태)
- 같은 (org, email)에 미만료 pending 초대가 있으면 409. 만료 pending은 자동 cancel 후 새 발급 (Step 1 §8 patterns)
- 토큰 라이프사이클: `mintToken` / `invalidateActiveTokens`는 Step 2 헬퍼 그대로 재사용 (createInvitation / resendInvitation / cancelInvitation에서). `consumeToken`은 본 step에서 acceptInvitation에는 쓰지 않고, 대신 **`findTokenByRaw(client, raw, purpose)` (no-lock SELECT) + `lockAndValidateTokenById(client, tokenId, purpose)` (FOR UPDATE + 4 fail 검사) + `markTokenConsumed(client, tokenId)` (UPDATE only)** 세 헬퍼를 신규로 도입 — lock 순서를 `invitations → auth_tokens`로 통일하면서 409 ROLLBACK 시 token이 함께 복구되도록 consume mark를 happy path 끝으로 분리하기 위함 (§6.1 + lock-in #9). verifyEmail / resetPassword는 기존 `consumeToken` 그대로 (회귀 0)
- accept 흐름은 anonymous (raw token이 유일한 server-side identity) → servicePool wrapper, Step 3 `verifyEmail` / `resetPassword`와 같은 트랜잭션 owner 패턴 (단 token 사용 방식은 위 항목대로 분리)
- mutation 3개 (`POST` / resend / `DELETE`)는 Step 4 `requireFreshRole` 적용

Phase 3 코드 자체는 본 step으로 사실상 완성. 남은 Step 6 (client wiring) / Step 7 (e2e + Phase 3 종합)은 frontend + e2e 검증 단계.

---

## 1. 사전 결정 lock-ins

| 항목 | 결정 | 근거 |
|---|---|---|
| 1. 5 endpoint 권한 매트릭스 | `POST` / resend / `DELETE` = **admin only + requireFreshRole**. `GET /invitations` = **admin only** (read 무관, requireFreshRole 미적용). `POST /invitations/accept` = **anonymous** (raw token만으로 identity 확립) | Master §2-13 / §2-14 / Step 4 §1-2. read도 admin only인 이유: 초대 목록은 잠재 가입 예정자 이메일이라 노출 면적 좁힘 |
| 2. `POST /invitations` 입력 | `{ email, role, teamId? }`. role enum 검증 (admin/manager/employee/viewer). teamId가 set이면 service-layer에서 같은 org의 active team인지 확인 (cross-org 차단). **`lower(email)`이 같은 org의 active 또는 disabled membership에 매칭되면 `409 already_member`로 즉시 거부** — accept 단계 500/토큰 무한 재시도 루프 차단 | invitation의 "역할"은 `role`. Master §16 plan 단어 충돌 방지. already_member 사전 가드는 Codex Step 5 review 반영 |
| 3. 같은 (org, email) 미만료 pending 중복 처리 | **409 `invitation_already_pending`**. service가 `FOR UPDATE` lock으로 직렬화하되, **동시 두 INSERT race가 partial unique 위반 (23505 `invitations_active_org_email_idx`)을 일으키면 동일 `409 invitation_already_pending`으로 매핑** | Master §2-9. UNIQUE partial (Step 1 §5)이 보조 + race 23505 매핑 명시 (Codex Step 5 review) |
| 4. 같은 (org, email) **만료** pending 처리 | service 트랜잭션이 (a) 옛 invitations 행을 `canceled_at = now()` 처리 (b) 옛 auth_tokens 행에 `invalidated_at = now()` 처리 (c) 새 invitations + 새 auth_tokens 행 발급 | Master §2-9 + Step 1 §8 sketch. partial 유니크 위반 회피. 2-query lock 패턴 (invitations FOR UPDATE → 그 id로 auth_tokens FOR UPDATE) — Step 1 §8 LEFT-JOIN-FOR-UPDATE 제약 회피 |
| 5. `GET /invitations` 결과 set 정의 | **active pending** = `invitations.accepted_at IS NULL AND invitations.canceled_at IS NULL AND` 짝 `auth_tokens` (purpose='invitation', consumed_at IS NULL, invalidated_at IS NULL)가 존재하고 `expires_at > now()`인 invitation. 만료 pending은 자동 제외 (Master §1 안 한다 §초대 만료 자동 정리). 응답: `{ invitations: Invitation[] }` |
| 6. `POST /invitations/:id/resend` 동작 | service tx: (a) 대상 invitation FOR UPDATE → `accepted_at IS NULL AND canceled_at IS NULL` 확인 (b) 활성 auth_tokens invalidate (c) 새 auth_tokens mint (purpose='invitation', invitation_id, ttlMs=7d) (d) invitations.last_sent_at = now() 갱신 (e) outbox에 새 메일 INSERT. 옛 raw token으로 accept 시도 → 410 generic | Master §2-9·invitation TTL 7d. UNIQUE partial이 mint 직전 invalidate를 강제 |
| 7. `DELETE /invitations/:id` 동작 | **soft cancel**. service tx: (a) FOR UPDATE → 이미 accepted/canceled면 409 `invitation_already_finalized` (b) `invitations.canceled_at = now()` 설정 (c) 활성 auth_tokens invalidate. 응답 204 | hard delete 안 함 (참조 무결성 / audit). 옛 raw token으로 accept 시도 → 410 generic |
| 8. `POST /invitations/accept` 입력 | `{ token, name, password }`. password min 8 / max 1024 (signup과 동일). name min 1 / max 200 | invitation이 role/team을 정의하므로 사용자는 자기 식별 정보만 |
| 9. accept 흐름 — 신규 user vs 기존 user 분기 | servicePool wrapper tx 안에서, **lock 순서는 `invitations → auth_tokens`로 cancel/resend와 통일** (Codex Step 5 3차 리뷰 #1 — 반대 순서일 때 cancel↔accept deadlock 가능): (a) **token row 식별** — 새 헬퍼 `findTokenByRaw(client, raw, 'invitation')`: sha256 lookup으로 `auth_tokens` 1행을 일반 SELECT (FOR UPDATE 없음). 행이 없으면 410 (token_not_found). 행은 있지만 invitation_id가 NULL이면 500 (b) **invitations FOR UPDATE** — token row가 가리키는 invitation_id로 `SELECT ... FOR UPDATE`. row가 없거나 accepted_at/canceled_at set이면 410 generic (c) **auth_tokens FOR UPDATE + validity check** — 새 헬퍼 `lockAndValidateTokenById(client, tokenId, 'invitation')`: `SELECT ... FOR UPDATE WHERE id = $1 AND purpose = $2` + 4 fail 코드 (already_used / invalidated / expired) 검사. (b)와 (c) 사이에 동시 cancel/resend가 들어왔다면 (c) 시점에 invalidated_at이 보여 410을 받음 (d) `lower(email)` 매칭 user lookup (`disabled_at` 포함 SELECT) (d-1) 기존 user의 `disabled_at IS NOT NULL`이면 `409 account_disabled` (d-2) 기존 user면 같은 (org_id, user_id) membership 존재 확인 → 있으면 `409 already_member` (e) 없으면 `INSERT INTO users ... ON CONFLICT (email) DO NOTHING RETURNING id` → 결과가 비면 같은 email의 user를 재조회 (concurrent 다른 org accept가 동시에 신규 user를 만든 race를 흡수, multi-org membership 경로로 계속) (f) 있으면 기존 user 재사용 (password/name/email_verified_at 손대지 않음) (g) memberships INSERT — race 23505 (memberships UNIQUE org_id+user_id) 시 `409 already_member`로 매핑 (h) `invitations.accepted_at = now()` 갱신 (i) **token consume mark** — `markTokenConsumed(client, tokenId)`가 `UPDATE auth_tokens SET consumed_at = now() WHERE id = $1` (j) 새 session 발급 (k) COMMIT. **409 경로 (account_disabled / already_member)는 ROLLBACK → token도 (i) 이전이라 그대로 → 동일 token으로 재시도하면 같은 409**. 동시 같은 token 두 accept: 둘 다 (a) 통과 → 둘 다 같은 invitation_id로 (b) invitations FOR UPDATE → 첫 tx가 lock 획득 / 두 번째 대기 → 첫 tx commit (h에서 accepted_at set + i에서 consumed_at set) → 두 번째가 lock 획득 → (b) 단계 accepted_at 체크에서 410 generic (또는 (c) 단계 consumed_at 체크에서 410) | Master §2-10. 기존 user의 password 덮어쓰기는 보안상 위험. disabled_at / already_member 가드 + 신규 user 23505 race 흡수 + lock 순서 통일 (Codex Step 5 reviews 1·4 + 3차 #1 반영) |
| 10. accept 응답 status | 신규 user면 **201**, 기존 user에 membership 추가만이면 **200** | RESTful 의미 ("리소스 생성" vs "기존 리소스 변경"). 클라이언트가 둘 다 동일 처리 가능 |
| 11. accept 시 access token + refresh cookie 발급 여부 | **발급** — signup과 동일. 사용자가 accept 완료 후 즉시 새 org dashboard로 진입. cookie 설정 + accessToken JSON | UX 매끄러움. anonymous endpoint이지만 응답에서 인증 상태로 전환 |
| 12. accept token 실패 응답 | Step 3 `sendTokenError` 그대로 — `404 token_not_found` / `410 token_already_used` / `410 token_invalidated` / `410 token_expired` 4 코드 모두 외부 `410 token_invalid_or_expired` generic. `findTokenByRaw` (no-lock SELECT) + `lockAndValidateTokenById` (FOR UPDATE + 검사) 두 단계에서 throw 발생 | Step 2 §7 / Step 3 §3.2 정합. cancel/resend 옛 token이 invalidated_at set 됐으므로 같은 generic 410 |
| 13. invitations.invited_by_user_id 채움 | `POST /invitations` 호출자 (`request.user.id`)로 set. accept 흐름에서는 손대지 않음. user 삭제 시 SET NULL (Step 1 schema) | 감사 trail. 본인 user 삭제돼도 invitation row 보존 |
| 14. invitations.team_id 검증 | `POST /invitations`에 teamId set이면 같은 org의 team인지 확인 (RLS scope으로 SELECT 1개 행 확인). 없으면 `400 invalid_team` | cross-org pollution 방어. Phase 3 §2-4 invitations 보강 컬럼 정합 |
| 15. accept 시 team_id 적용 | invitation.team_id를 새 membership.team_id에 **그대로 복사만**. accept tx 안에서 `teams` SELECT는 **하지 않음**. FK `invitations.team_id REFERENCES teams(id) ON DELETE SET NULL`이 invitation 발급 후 team 삭제 시 자동으로 NULL 처리해주므로 별도 검증 불필요 | servicePool grant 표 (Step 2 §0008)에 `teams` 미추가 유지. team 삭제 race FK가 흡수 (Codex Step 5 review 반영) |
| 16. accept 시 race condition — 같은 token으로 2 요청 동시 진입 | (b) 단계 `invitations FOR UPDATE`가 직렬화. 첫 tx가 (h) `invitations.accepted_at = now()` + (i) `markTokenConsumed` + COMMIT한 뒤 두 번째 tx가 invitations lock 획득. 두 번째는 (b)의 `accepted_at IS NOT NULL` 분기에서 410 generic을 받음 (도달 못 한 경우 (c)에서 `consumed_at IS NOT NULL`로 410). cancel/resend도 같은 invitations → auth_tokens 순서이므로 cross-flow deadlock 없음 | lock 순서 통일이 핵심 (Codex Step 5 3차 #1) |
| 17. servicePool 권한 vs accept 흐름 필요 grant | Step 2 migration 0008 grant 표 그대로 충분: `auth_tokens` (SELECT/UPDATE consumed_at·invalidated_at), `users` (INSERT/SELECT), `memberships` (INSERT/SELECT), `sessions` (INSERT — session + refresh token이 같은 테이블), `invitations` (SELECT/UPDATE accepted_at), `organizations` (SELECT). **`teams` SELECT는 grant 표에 없으며 그대로 유지** — accept에서 teams 조회를 제거 (lock-in #15). 신규 grant 추가 **없음** | 본 step에서 schema/grant 변경 0건. refresh_tokens 별도 테이블 없음 (Codex Step 5 재리뷰 #2 반영) |
| 18. shared types | `Invitation` (route 응답 shape — invitation row + token expires_at + 발신자 이름), `InvitationCreateInput`, `InvitationAcceptInput`. zod 원본 + JSDoc 사본 + sync registry | Phase 2 패턴 그대로 |
| 19. seed 시드 사용 가능성 | 본 step 단위 테스트는 시드 (`pending-invitee@acme.test` live + `expired-invitee@acme.test` expired)를 일부 활용 가능. 단 raw token이 알려지지 않은 시드 token이라 accept 테스트는 새로 발급한 토큰을 outbox에서 추출 (verify_routes 패턴) | Step 1 §9 시드 + Step 2 outbox 추출 헬퍼 재사용 |
| 20. e2e 영향 | Phase 0.5 / Phase 2 회귀만. 본 step 완료 후 Phase 3 종합 e2e (Step 7)에서 invitation flow를 통합 시나리오로 다룸 | 본 step은 routes 추가지 기존 동작 변경 없음 |

---

## 2. `POST /invitations` — service + route

### 2.1 service: `createInvitation`

```ts
export async function createInvitation(
  client: PoolClient,           // app pool tx client (caller wraps withOrgContext)
  orgId: string,
  invitedByUserId: string,
  input: {
    email: string;
    role: MembershipRole;       // admin | manager | employee | viewer
    teamId?: string | null;
  },
): Promise<{ invitation: Invitation; rawToken: string }>
```

흐름:
1. teamId 검증 (있으면): `SELECT 1 FROM teams WHERE id = $1` (RLS scope) → 없으면 `400 invalid_team`
2. **already_member 가드**: `lower(email)`이 같은 org의 active 또는 disabled membership과 매칭되면 `409 already_member`:
   ```sql
   SELECT 1 FROM memberships m
     JOIN users u ON u.id = m.user_id
    WHERE m.org_id = $1 AND lower(u.email::text) = lower($2)
    LIMIT 1
   ```
   RLS scope이라 자기 org만 검사. 매칭 있으면 즉시 throw — accept 단계 500 / 토큰 재시도 루프 방지 (Codex Step 5 review)
3. 같은 (orgId, lower(email)) pending invitation 행 lock (Step 1 §8 pattern):
   ```sql
   SELECT id FROM invitations
   WHERE org_id = $1 AND lower(email::text) = lower($2)
     AND accepted_at IS NULL AND canceled_at IS NULL
   FOR UPDATE
   ```
4. row 존재 시:
   - 짝 auth_tokens row를 별도 FOR UPDATE로 lock
   - 토큰이 없거나 만료된 경우 (`expires_at < now()`) → 옛 invitation `canceled_at = now()`, 옛 token (있으면) `invalidated_at = now()`. 이어서 새 invitation 생성으로 fall through
   - 토큰이 live면 `409 invitation_already_pending`
5. 새 invitations row INSERT (org_id, email, role, team_id, invited_by_user_id, last_sent_at=now()). RLS WITH CHECK가 org_id 일치 강제. **동시 race로 23505 `invitations_active_org_email_idx` 위반 발생 시 `409 invitation_already_pending`으로 매핑** (lock-in #3 정합)
6. `mintToken({client, orgId, invitationId, purpose:'invitation', ttlMs: TTL_INVITATION_MS})` — Step 2 헬퍼
7. `emailProvider.sendInvitationEmail({client, orgId, toEmail, toName: email, inviterName, organizationName, acceptUrl: buildAcceptInvitationUrl(rawToken), invitationId, rawToken})` — Step 2 헬퍼

리턴: `{ invitation, rawToken }`. route는 rawToken을 응답 body에 노출하지 않음.

### 2.2 route: `POST /invitations`

```
preHandler: [requireAuth, orgContext, requireRole('admin'), requireFreshRole]
body: zod InvitationCreateInput
response 201: { invitation }
```

`request.user.id`가 `invitedByUserId`. service throw가 AuthError이면 route plugin-scoped errorHandler가 statusCode/code 매핑 (Step 4 패턴).

---

## 3. `GET /invitations` — service + route

### 3.1 service: `listActivePendingInvitations`

```ts
export async function listActivePendingInvitations(
  client: PoolClient,
): Promise<InvitationListItem[]>
```

JOIN invitations + auth_tokens (active filter) + users(invited_by):
```sql
SELECT i.id, i.email, i.role, i.team_id, t.name AS team_name,
       i.created_at, i.last_sent_at, i.invited_by_user_id,
       u.name AS invited_by_name,
       at.expires_at AS token_expires_at
  FROM invitations i
  JOIN auth_tokens at ON at.invitation_id = i.id
                     AND at.purpose = 'invitation'
                     AND at.consumed_at IS NULL
                     AND at.invalidated_at IS NULL
  LEFT JOIN teams t ON t.id = i.team_id
  LEFT JOIN users u ON u.id = i.invited_by_user_id
 WHERE i.accepted_at IS NULL
   AND i.canceled_at IS NULL
   AND at.expires_at > now()
 ORDER BY i.created_at DESC
```

만료 / canceled / accepted 자동 제외 (Master §1-11 정합).

### 3.2 route: `GET /invitations`

```
preHandler: [requireAuth, orgContext, requireRole('admin')]
response 200: { invitations: InvitationListItem[] }
```

requireFreshRole 미적용 — read endpoint.

---

## 4. `POST /invitations/:id/resend` — service + route

### 4.1 service: `resendInvitation`

```ts
export async function resendInvitation(
  client: PoolClient,
  invitationId: string,
): Promise<void>
```

흐름:
1. invitations 행 FOR UPDATE → 없거나 `accepted_at IS NOT NULL OR canceled_at IS NOT NULL`이면 `409 invitation_already_finalized` (404와 분리 — invitation 자체가 finalized 됐다는 의미 노출은 admin 시각에서 OK)
2. 활성 auth_tokens FOR UPDATE → 있으면 `invalidated_at = now()`. 만료된 경우도 invalidate (cleanup)
3. 새 auth_tokens mint (Step 2 헬퍼)
4. `invitations.last_sent_at = now(), updated_at = now()`
5. `emailProvider.sendInvitationEmail(...)` — 같은 outbox 행 추가

응답: `200 { ok: true }`. resend 후 옛 raw token은 → 410 generic.

### 4.2 route: `POST /invitations/:id/resend`

```
preHandler: [requireAuth, orgContext, requireRole('admin'), requireFreshRole]
params: id UUID
response: 200 { ok: true }
```

---

## 5. `DELETE /invitations/:id` — service + route

### 5.1 service: `cancelInvitation`

```ts
export async function cancelInvitation(
  client: PoolClient,
  invitationId: string,
): Promise<void>
```

흐름:
1. invitations 행 FOR UPDATE → 없으면 `404 not_found`. 이미 accepted/canceled면 `409 invitation_already_finalized`
2. `invitations.canceled_at = now(), updated_at = now()`
3. 짝 auth_tokens FOR UPDATE → 있으면 `invalidated_at = now()`. 옛 raw token으로 accept 시도 → 410 generic

응답: 204.

### 5.2 route: `DELETE /invitations/:id`

```
preHandler: [requireAuth, orgContext, requireRole('admin'), requireFreshRole]
params: id UUID
response: 204 no body
```

---

## 6. `POST /invitations/accept` — anonymous + servicePool wrapper

### 6.1 service: `acceptInvitation`

```ts
export async function acceptInvitation(input: {
  rawToken: string;
  name: string;
  password: string;
  userAgent?: string | null;
  ip?: string | null;
}): Promise<{ created: boolean; result: AuthResult }>
```

흐름 (Step 3 `resetPassword` 패턴 — wrapper가 servicePool 트랜잭션 1개 소유):

```ts
const passwordHash = await hashPassword(input.password);  // tx 밖
const client = await getServicePool().connect();
try {
  await client.query("BEGIN");

  // 1) Token row 식별 (no lock). `findTokenByRaw`는 sha256 lookup으로
  //    auth_tokens 1행을 일반 SELECT — FOR UPDATE 없이 token_id +
  //    invitation_id만 회수. 행이 없으면 410 (token_not_found).
  //    lock을 여기서 잡지 않는 이유: cancel/resend가 invitations →
  //    auth_tokens 순서로 lock을 잡기 때문에, accept도 invitations를
  //    먼저 lock해야 cross-flow deadlock이 안 생긴다 (Codex Step 5 3차 #1).
  const tok = await findTokenByRaw(client, input.rawToken, "invitation");
  if (!tok) {
    throw new AuthError(410, "token_not_found",
      "invitation token not found");
  }
  if (!tok.invitationId) {
    throw new AuthError(500, "accept_internal_inconsistency",
      "invitation token missing invitation_id");
  }

  // 2) invitations FOR UPDATE (가장 먼저 잠그는 row — cancel/resend와
  //    같은 순서). servicePool BYPASSRLS → 모든 org row 읽기 가능.
  //    이 step과 step 3 사이에 cancel/resend가 끼어들 수 없음 (같은
  //    invitations row를 동시에 lock할 수 없으므로 직렬화됨).
  const invRow = await client.query<{...}>(
    `SELECT id, org_id, email, role, team_id, accepted_at, canceled_at
       FROM invitations WHERE id = $1 FOR UPDATE`,
    [tok.invitationId]);
  const inv = invRow.rows[0];
  if (!inv || inv.accepted_at || inv.canceled_at) {
    // 동시 accept 직렬화: 첫 tx가 commit한 뒤 두 번째 tx가 lock 획득
    // 시 accepted_at이 set돼 있음 → 410 generic.
    throw new AuthError(410, "token_invalidated", "invitation finalized");
  }

  // 3) auth_tokens FOR UPDATE + validity check. `lockAndValidateTokenById`는
  //    `SELECT ... FOR UPDATE WHERE id = $1 AND purpose = $2` + 4 fail
  //    코드 (already_used / invalidated / expired) 검사. step 1↔2 사이에
  //    cancel이 어차피 못 끼어들지만, step 1 시점에 token이 이미 invalidate된
  //    상태였다면 (예: 옛 resend가 이미 invalidate한 token으로 시도) 여기서
  //    410을 받음.
  await lockAndValidateTokenById(client, tok.tokenId, "invitation");

  // 4) Existing user lookup. users.email은 citext라 case-insensitive 비교.
  //    disabled_at 포함 — global disabled user의 invitation hijack 차단.
  const existing = await client.query(
    `SELECT id, email, name, avatar_url, email_verified_at, disabled_at
       FROM users WHERE email = $1`,
    [inv.email]);

  let userId: string;
  let isNew = false;
  if (existing.rows.length > 0) {
    if (existing.rows[0].disabled_at) {
      // global disabled user → 409. ROLLBACK으로 token 그대로 복구 →
      // 같은 token 재시도는 (admin이 user를 활성화하지 않는 한) 같은 409.
      throw new AuthError(409, "account_disabled",
        "user account is disabled");
    }
    userId = existing.rows[0].id;
    // 같은 (org_id, user_id) membership이 이미 있으면 409. ROLLBACK으로
    // token 복구 → 같은 409 재현 (Codex Step 5 재리뷰 #1 반영).
    const m0 = await client.query(
      `SELECT 1 FROM memberships
        WHERE org_id = $1 AND user_id = $2 LIMIT 1`,
      [inv.org_id, userId]);
    if (m0.rows.length > 0) {
      throw new AuthError(409, "already_member",
        "user is already a member of this organization");
    }
    // 기존 user는 password/name/email_verified_at 손대지 않음 — 다른 org
    // 계정 hijack 방지 (Master §2-10).
  } else {
    // 5) 신규 user INSERT. 동시 두 org accept가 같은 새 email로 진입하면
    //    한쪽은 users_email_key 23505로 막힘. ON CONFLICT DO NOTHING +
    //    재조회로 multi-org 경로로 흡수 (Codex Step 5 재리뷰 #4 반영).
    const created = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, email_verified_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [inv.email, passwordHash, input.name]);
    if (created.rows.length > 0) {
      userId = created.rows[0].id;
      isNew = true;
    } else {
      // race: 다른 tx가 같은 email user를 막 만들었음. 재조회 →
      // disabled_at 재검사 → already_member 재검사 후 multi-org 경로.
      const refound = await client.query(
        `SELECT id, disabled_at FROM users WHERE email = $1`, [inv.email]);
      if (refound.rows.length === 0) {
        throw new AuthError(500, "accept_internal_inconsistency",
          "user not found after ON CONFLICT");
      }
      if (refound.rows[0].disabled_at) {
        throw new AuthError(409, "account_disabled", "user account is disabled");
      }
      userId = refound.rows[0].id;
      const m1 = await client.query(
        `SELECT 1 FROM memberships
          WHERE org_id = $1 AND user_id = $2 LIMIT 1`,
        [inv.org_id, userId]);
      if (m1.rows.length > 0) {
        throw new AuthError(409, "already_member",
          "user is already a member of this organization");
      }
      isNew = false;
    }
  }

  // 6) team_id 그대로 복사. invitations.team_id REFERENCES teams(id)
  //    ON DELETE SET NULL이라 team 삭제 race는 이미 처리됨.
  //    accept tx에서 teams SELECT는 하지 않음 (servicePool grant 표에
  //    teams 미추가 유지 — lock-in #15·#17).
  const teamIdForMembership = inv.team_id;

  // 7) Membership INSERT. RLS off + org_id 명시. (org_id, user_id) UNIQUE
  //    race로 23505 발생 시 catch → 409 already_member로 매핑
  //    (사전 lookup으로 통과한 뒤 race가 끼어들 표면은 좁지만 방어적).
  const m = await client.query(
    `INSERT INTO memberships (org_id, user_id, role, team_id, status)
     VALUES ($1, $2, $3, $4, 'active')
     RETURNING id, org_id, user_id, role, status`,
    [inv.org_id, userId, inv.role, teamIdForMembership]);

  // 8) invitations.accepted_at = now().
  await client.query(
    `UPDATE invitations SET accepted_at = now(), updated_at = now()
       WHERE id = $1`, [inv.id]);

  // 9) Session + refresh — Phase 1 createSessionWithToken 재사용
  //    (services/auth.ts에서 export 필요 시). refresh도 sessions 테이블에
  //    같이 저장됨 (별도 refresh_tokens 테이블 없음).
  const { session, refreshToken } = await createSessionWithToken(client, {
    userId, orgId: inv.org_id, membershipId: m.rows[0].id,
    userAgent: input.userAgent, ip: input.ip,
  });

  // 10) Token consume mark — 모든 happy path 검증이 끝난 뒤에만 set.
  //     `markTokenConsumed`가 UPDATE auth_tokens SET consumed_at = now().
  //     이 시점 이후 ROLLBACK이 없으므로 token이 실제로 consumed로 commit됨.
  await markTokenConsumed(client, tok.tokenId);

  // 11) Organization metadata (응답에 필요)
  const o = await client.query(
    `SELECT id, name, plan FROM organizations WHERE id = $1`, [inv.org_id]);
  const organization = o.rows[0];

  // 12) Read back the user row for response shape.
  const uFull = await client.query(
    `SELECT id, email, name, avatar_url, email_verified_at
       FROM users WHERE id = $1`, [userId]);

  await client.query("COMMIT");
  return {
    created: isNew,
    result: {
      user: toPublicAuthUser(uFull.rows[0]),
      organization,
      membership: m.rows[0],
      session,
      accessPayload: buildAccessPayload(session, m.rows[0].role),
      refreshToken,
    },
  };
} catch (err) {
  try { await client.query("ROLLBACK"); }
  catch (rb) { client.release(rb as Error); throw err; }
  client.release();
  throw err;
}
client.release();
```

**불변식**: token row 조회 + invitation lock + token lock·validity + user create/lookup + membership insert + invitation accepted + session + token consume mark 모두 같은 servicePool 트랜잭션. partial state 0건. consume mark는 happy path 끝부분에서만 수행 → 409 throw 시 ROLLBACK이 token까지 복구.

**lock 순서**: `invitations → auth_tokens` (모든 invitation tx 동일 — createInvitation 만료 재발급 / resendInvitation / cancelInvitation / acceptInvitation). cross-flow deadlock 방지 (Codex Step 5 3차 #1).

**race: 같은 token으로 2 동시 accept** → step 2의 `invitations FOR UPDATE`가 직렬화. 첫 tx가 step 8 (accepted_at) + step 10 (consumed_at) + COMMIT 후 두 번째 tx가 invitations lock 획득 → step 2의 `accepted_at IS NOT NULL` 분기에서 410 generic.

**race: accept vs cancel/resend 동시 진입** → 둘 다 `invitations FOR UPDATE`를 먼저 잡으므로 직렬화. 어느 쪽이 먼저 commit되든 다른 쪽은 다음 분기 중 하나로 흡수: (a) cancel이 먼저 → accept step 2의 `canceled_at IS NOT NULL`로 410 (b) accept이 먼저 commit → cancel은 step 1 invitations FOR UPDATE 통과 후 `accepted_at IS NOT NULL`로 409 `invitation_already_finalized` (c) resend가 먼저 commit → accept step 3 auth_tokens FOR UPDATE에서 token invalidated_at으로 410 generic.

**race: 같은 user + 같은 org membership 중복** → 사전 lookup에서 통과한 뒤에도 동시 INSERT가 끼어들 가능성. INSERT 23505 (memberships UNIQUE org_id+user_id) catch → `409 already_member`로 매핑. ROLLBACK으로 token 복구되므로 (해당 race가 해결되지 않는 한) 재시도해도 같은 409.

**race: 신규 user INSERT 23505 (users.email unique)** → 같은 새 email로 다른 org 초대 2개를 동시 accept 시 한 쪽이 `users_email_key` 위반. step 5의 `ON CONFLICT (email) DO NOTHING` + 재조회 분기로 multi-org membership 경로로 흡수 (Codex Step 5 재리뷰 #4 반영).

### 6.2 route: `POST /invitations/accept`

```
no preHandler (anonymous)
body: zod InvitationAcceptInput { token, name, password }
response: 201 (created) or 200 (existing user → membership added) + AuthResult shape
        + Set-Cookie refresh
```

token 실패 (4 코드) → `sendTokenError` → 410 generic. 그 외 AuthError (400 invalid_input, 409 `already_member` / `account_disabled`, 500 등) → standard mapping.

**sendTokenError 분리 — 본 step 작업**: 현재 `server/src/routes/auth.ts`에 file-local로 있는 `sendTokenError`를 `server/src/routes/_tokenErrorMap.ts` (또는 `server/src/services/auth-tokens.ts`)로 분리/`export`해서 routes/auth.ts + routes/invitations.ts 둘 다 import. 동일 매핑 (`token_not_found` / `token_already_used` / `token_invalidated` / `token_expired` → 410 generic). routes/auth.ts에서 import path만 교체 (회귀 0). (Codex Step 5 review 반영 — completion checklist 추가)

---

## 7. Pool / RLS / `requireFreshRole` 경계 정리

| Endpoint | Pool | RLS | Middleware |
|---|---|---|---|
| `POST /invitations` | app pool + `withOrgContext` | 자기 org만 access | requireAuth → orgContext → requireRole('admin') → requireFreshRole |
| `GET /invitations` | app pool + `withOrgContext` | 자기 org만 | requireAuth → orgContext → requireRole('admin') |
| `POST /invitations/:id/resend` | app pool + `withOrgContext` | 자기 org만 | requireAuth → orgContext → requireRole('admin') → requireFreshRole |
| `DELETE /invitations/:id` | app pool + `withOrgContext` | 자기 org만 | requireAuth → orgContext → requireRole('admin') → requireFreshRole |
| `POST /invitations/accept` | **servicePool wrapper** | BYPASSRLS — token이 유일한 identity | none (anonymous) |

본 step에서 신규 풀 / env / migration 추가 **없음**. Step 2 인프라 그대로.

---

## 8. Shared types — `invitation` entity 등록

`server/src/types/invitation.ts`:

```ts
import { z } from "zod";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = z.string().regex(UUID_RE);
const ROLE  = z.enum(["admin","manager","employee","viewer"]);

export const Invitation = z.object({
  id:                z.string(),
  org_id:            z.string(),
  email:             z.string(),
  role:              ROLE,
  team_id:           z.string().nullable(),
  team_name:         z.string().nullable(),
  invited_by_user_id: z.string().nullable(),
  invited_by_name:   z.string().nullable(),
  last_sent_at:      z.string(),
  token_expires_at:  z.string(),
  created_at:        z.string(),
});

export const InvitationCreateInput = z.object({
  email:  z.string().min(3).max(320),
  role:   ROLE,
  teamId: uuid.nullable().optional(),
});

export const InvitationAcceptInput = z.object({
  token:    z.string().min(1).max(512),
  name:     z.string().min(1).max(200),
  password: z.string().min(8).max(1024),
});
```

`platform/types/invitation.js` JSDoc 사본. `test/sync_shared_types.mjs` ENTITY_REGISTRY entry. Sync targets: `Invitation`, `InvitationCreateInput`, `InvitationAcceptInput`.

---

## 9. 단위 테스트 — `server/test/invitation_routes.test.mjs`

새 파일 1개, ~25 cases. verify_routes / password_reset_routes 패턴 (prefix-based 일회용 user) 그대로. Acme admin (시드)로 invite 발송, `invitetest-` prefix email로 accept.

### POST /invitations (생성)

1. admin이 `invitetest-X@example.test` 초대 → 201, outbox에 invitation 1행, auth_tokens에 active row 1, invitations에 row 1
2. 같은 (org,email)로 두 번째 초대 → 409 `invitation_already_pending`
3. seed의 `expired-invitee@acme.test` (시드 만료 토큰) 같은 email로 새 초대 → 201 + 옛 invitation `canceled_at` set + 옛 token `invalidated_at` set + 새 invitation + 새 token (만료 재발급 자동 cancel)
4. employee가 초대 시도 → 403 (requireRole)
5. stale_role JWT로 초대 시도 → 401 stale_role
6. teamId가 다른 org의 team → 400 invalid_team
7. teamId가 자기 org의 valid team → 201, invitation.team_id 설정됨
8. 빈 body → 400 invalid_input
8-A. 이미 같은 org **active** member의 email (`emp@acme.test`) 초대 → 409 `already_member`
8-B. 이미 같은 org **disabled** member의 email 초대 (테스트 setup으로 잠시 disabled 상태) → 409 `already_member`. 종료 시 active로 복원

### GET /invitations (목록)

9. admin → 200, 활성 pending만 (시드 1 live + 본 테스트가 만든 N개). 만료/취소/수락된 행은 자동 제외
10. employee → 403

### POST /invitations/:id/resend

11. admin이 활성 invitation 재발송 → 200, 옛 token `invalidated_at` set, 새 token 생성, outbox 2행, `last_sent_at` 갱신
12. 옛 raw token으로 accept 시도 → 410 generic
13. 이미 accepted된 invitation resend → 409 `invitation_already_finalized`

### DELETE /invitations/:id (취소)

14. admin이 cancel → 204. invitations.canceled_at set + 활성 auth_token invalidated
15. 취소된 invitation의 옛 raw token으로 accept 시도 → 410 generic
16. 이미 accepted된 invitation cancel → 409 `invitation_already_finalized`
17. cross-org invitation id로 cancel 시도 → 404 not_found (RLS)

### POST /invitations/accept (anonymous)

18. **신규 user accept**: invite 발송 → outbox token 추출 → `POST /accept {token, name, password}` → 201 + AuthResult shape + Set-Cookie refresh. DB: users 1 신규 (email_verified_at set), memberships 1 신규 (active, role from invitation, team_id from invitation), invitations.accepted_at set, auth_tokens.consumed_at set
19. **기존 user accept (multi-org)**: 시드의 emp@acme.test를 Beta org에 invite → emp가 그 token으로 accept → 200 (not 201, 기존 user) + Beta membership 추가. 옛 Acme password로는 여전히 Acme 로그인 가능 (password 변경 안 됨)
20. 신규 user accept 후 새 access token으로 `/me` → 200, org=invitation의 org, role=invitation의 role
21. 같은 token으로 두 번째 accept → 410 generic
22. 만료 token으로 accept → 410 generic
23. 알 수 없는 token으로 accept → 410 generic
24. canceled invitation의 옛 token으로 accept → 410 generic (token invalidated_at set 됐으므로)
24-A. **기존 user disabled accept 거부 + 재시도 같은 409**: `users.disabled_at`을 직접 set한 user 이메일로 새 org에 invite → token 추출 → accept → 409 `account_disabled`. **같은 token으로 즉시 재시도 → 같은 409** (`auth_tokens.consumed_at`이 NULL인 채 ROLLBACK으로 그대로 보존됨을 함께 assert). 종료 시 `users.disabled_at` 복원
24-B. **accept 단계 already_member 거부 + 재시도 같은 409**: invitation 발급 후 외부 SQL로 같은 (org_id, user_id) membership을 미리 INSERT → accept → 409 `already_member`. **같은 token으로 재시도 → 같은 409** (`auth_tokens.consumed_at` 여전히 NULL). 외부 INSERT한 membership 정리는 afterEach
24-C. **신규 user 동시 accept (users.email race) 흡수**: 같은 새 email (`invitetest-multiorg@example.test`)로 Acme + Beta 두 org에서 동시 invite 발송 → outbox에서 두 token 추출 → `Promise.all`로 동시 accept. 두 응답 모두 성공 (한 쪽 201 created=true + 다른 쪽 200 created=false, 또는 순서 무관). DB 검증: `users` 1행 + 두 org에 membership 1개씩. 종료 시 user / memberships cleanup
25. password 7자 → 400 schema invalid_input
26. token / name / password 누락 → 400 schema

afterEach: `DELETE FROM organizations WHERE name LIKE 'invitetest-org-%'` (본 step에선 org 추가 안 만들지만 안전망) + `DELETE FROM users WHERE email LIKE 'invitetest-%@example.test'`. Step 4 패턴처럼 seeded memberships 복원.

---

## 10. e2e 영향 + 수동 검증

수동:
- Acme admin 로그인 → `POST /invitations { email: "manual-accept@example.test", role: "employee" }` → 201
- outbox에서 token 추출 → `POST /invitations/accept { token, name, password }` → 201 + AuthResult
- 새 user로 로그인 → `/me` 응답이 Acme + role=employee
- admin 시각에서 `GET /team/members` → 새 멤버 등장
- admin이 다른 email로 초대 → resend → outbox 2건 → 첫 raw로 accept 시도 → 410, 두 번째 raw로 accept 시도 → 201
- admin이 cancel → 옛 raw로 accept 시도 → 410

자동 회귀:
- `node test/phase_0_5_e2e.mjs` 16/16
- `node test/phase_2_customers_e2e.mjs` 7/7

Phase 3 통합 e2e는 Step 7에서 별도 작성.

---

## 11. 위험·미정

| 항목 | 처리 |
|---|---|
| 같은 user + 같은 org membership 중복 (외부 경로로 이미 멤버) | **사전 lookup으로 `409 already_member` 거부** (POST /invitations + accept 둘 다, lock-in #2 / #9). race로 INSERT 23505 발생 시도 동일 코드로 매핑. **accept 시 token consume mark는 step 9에서만 set되므로 ROLLBACK 시 token 그대로 → 재시도하면 같은 409 (admin이 해당 멤버를 제거하기 전까지)** (Codex Step 5 reviews 1+2) |
| 기존 user의 `disabled_at` (global 비활성 계정의 invitation hijack) | accept tx 안 SELECT users에 `disabled_at` 포함 → not null이면 `409 account_disabled` 거부. ROLLBACK → token 그대로 → 재시도해도 같은 409 (admin이 user를 활성화하지 않는 한). 옛 안은 disabled global user가 새 org membership을 얻는 경로가 열려 있었고 "token consume된 채 finalize"라는 거짓 명세였음 (Codex Step 5 reviews 1+3) |
| 신규 user 동시 accept의 `users_email_key` race | 같은 새 email로 서로 다른 org 초대 2개 동시 accept 시 한 쪽 INSERT users 23505. `ON CONFLICT (email) DO NOTHING` + 재조회 + multi-org membership 경로로 흡수. 두 tx 모두 성공적으로 commit (각자 다른 org의 membership 1개씩) (Codex Step 5 재리뷰 #4) |
| 동시 두 admin이 같은 (org, email) 초대 race | service `FOR UPDATE` lock으로 직렬화 + 두 트랜잭션이 INSERT까지 동시 진입 시 partial unique 23505 → `409 invitation_already_pending`으로 매핑 (lock-in #3) |
| 기존 user accept 시 password 무시 — 사용자가 입력한 password가 무용 | UX: 응답에서 `created: false`를 노출해 클라이언트가 "기존 계정으로 로그인됐습니다" 안내 가능. 본 step 단위 테스트에서 created flag assert |
| accept 시 invitation의 team이 그 사이 삭제 | team_id NULL로 fallback. accept 자체는 성공. 별도 알림 없음. Step 6 client wiring에서 안내 추가 검토 |
| invitations.invited_by_user_id가 SET NULL (Step 1 schema) | user 삭제 후에도 invitation row 보존. 목록 응답에서 `invited_by_name`이 NULL이면 "(deleted)" 표시는 client 책임 |
| accept tx가 길어짐 — 9 단계 | 모두 같은 servicePool tx. argon2 hash는 tx 밖. 측정은 Phase 6+ |
| anonymous accept에 IP rate-limit 없음 | Phase 6+. 단일 token이 1회만 작동하므로 brute-force 표면 작음. 모든 토큰 시도는 servicePool으로 DB 라운드트립 + argon2 비용 — Step 3 finding §8 정합 |
| race: accept와 cancel 동시 진입 | consume이 FOR UPDATE + (a) invitations FOR UPDATE 둘 다 → 직렬화. 어느 쪽이 먼저 commit인지에 따라 (a) accept 성공 후 cancel = 이미 accepted 409 (b) cancel 성공 후 accept = invitations.canceled_at set + token invalidated → consume이 410. 본 step에서 단위 테스트는 race를 직접 driving하지 않음 — service의 transactional 보장으로 충분 |
| accept 후 새 user의 email_verified_at = now() — 이메일 도달 자체가 인증 증거 | Master §2-10 정합. 기존 user의 email_verified_at은 손대지 않음 (다른 org에서 verify 여부 그대로) |
| `requireVerified` middleware (cross-user write 차단) 도입 시점 | 본 step에서 도입 안 함. Master §304 "이메일 미인증 사용자 cross-user write 차단"은 Phase 3 closure 직전 별도 mini-step 또는 Phase 4+ 검토 |
| seed의 expired invitation (`expired-invitee@acme.test`)을 만료 재발급 테스트에 사용 — race | 단위 테스트가 sequential (test-concurrency=1) + afterEach가 시드 상태 복원 안 함 (시드 자체 변경 못 함). 케이스 3은 admin이 expired-invitee@acme.test로 새 초대 → 옛 시드 invitation을 cancel 처리 + 새 invitation 발급. afterEach가 새 invitation은 prefix sweep으로 정리 가능하나 시드 invitation은 canceled 상태로 남음. 단위 테스트 간 영향이 있을 수 있음 — 본 케이스를 마지막에 배치하거나 별도 cleanup으로 처리 |

---

## 12. 완료 기준 (Step 5 — go/no-go)

- [ ] `server/src/repositories/invitations.ts` (신규)
- [ ] `server/src/services/invitations.ts` (신규) — 5 함수 (createInvitation에 already_member + 23505 매핑, accept에 disabled_at + already_member + users.email ON CONFLICT 흡수, token consume mark 끝부분 배치)
- [ ] **`server/src/services/auth-tokens.ts` 보강** — `findTokenByRaw(client, raw, purpose)` (no lock SELECT) + `lockAndValidateTokenById(client, tokenId, purpose)` (FOR UPDATE + 4 fail 코드 검사) + `markTokenConsumed(client, tokenId)` 헬퍼 3개 추가. Step 2 `consumeToken`은 그대로 유지 (verify/reset에서 계속 사용 — 그쪽은 post-consume 409 경로가 없어 분리할 필요 없음). 본 step 헬퍼 3개는 invitations.ts acceptInvitation에서만 사용. lock 순서를 invitations → auth_tokens로 통일하기 위함 (Codex Step 5 3차 #1)
- [ ] `server/src/routes/invitations.ts` (신규) — 5 endpoint
- [ ] `server.ts`에 `invitationsRoutes` register
- [ ] **`sendTokenError` 공용화** — 현재 routes/auth.ts file-local을 `server/src/routes/_tokenErrorMap.ts` (또는 `services/auth-tokens.ts`)로 옮기고 `export`. routes/auth.ts + routes/invitations.ts 둘 다 import. 회귀 0
- [ ] `server/src/services/auth.ts` 보강 — `createSessionWithToken`을 invitations.ts에서 import 가능하게 export (또는 helper로 재배치). `toPublicAuthUser` / `buildAccessPayload`도 같은 검토
- [ ] `server/src/types/invitation.ts` + `platform/types/invitation.js` + sync registry 추가
- [ ] `server/test/invitation_routes.test.mjs` (신규) — ~25 cases PASS (8-A/8-B/24-A/24-B/24-C 포함)
- [ ] `npm --prefix server run typecheck` PASS
- [ ] `npm --prefix server test` PASS — 신규 ~25 + 회귀 125 = ~150
- [ ] `node test/sync_shared_types.mjs` PASS — `invitation` entity 등록
- [ ] `node test/phase_0_5_e2e.mjs` 16/16 회귀 PASS
- [ ] `node test/phase_2_customers_e2e.mjs` 7/7 회귀 PASS
- [ ] 수동 검증 (§10) 모두 의도대로 동작
- [x] **`PHASE_3_MASTER.md` §2-14 + §3-302 갱신** — invitation `requireFreshRole` 적용 범위를 "생성·재발송·취소" 3종으로 명시 + accept는 명시적으로 제외 (본 plan 갱신 turn에 적용 완료)
- [ ] `docs/plan/phase-3/PHASE_3_STEP_5_FINDINGS.md` 작성

---

## 13. 한 줄 요약

> **1일 동안 5 endpoint (`POST/GET/DELETE /invitations`, `POST /invitations/:id/resend`, `POST /invitations/accept`) 구현. mutation 3개는 Step 4 `requireFreshRole`. accept는 servicePool wrapper + (공용화된) `sendTokenError` — `findTokenByRaw` (no lock SELECT) → `invitations FOR UPDATE` (cancel/resend와 같은 lock 순서) → `lockAndValidateTokenById` (auth_tokens FOR UPDATE + 4 fail 검사) → user lookup (disabled_at 가드) / `ON CONFLICT (email)` INSERT (users.email race 흡수) → already_member 가드 → membership INSERT → invitations.accepted_at → session → `markTokenConsumed` (consume mark 끝부분 — 409 ROLLBACK 시 token 그대로 → 재시도해도 같은 409). POST /invitations도 사전 already_member 가드 + 23505 partial-unique race → `409 invitation_already_pending` 매핑. accept tx에서 teams SELECT 제거 (FK ON DELETE SET NULL 신뢰). 신규 마이그레이션 / 풀 / grant / env 0개.**

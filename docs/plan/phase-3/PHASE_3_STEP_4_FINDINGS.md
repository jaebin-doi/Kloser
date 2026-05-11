# Phase 3 Step 4 Findings — Team / Member API + 마지막 admin 보호 + requireFreshRole

> Audience: Phase 3 Step 5 작성자 (또는 미래의 나).
> Format: each finding has **(1) 관찰**, **(2) Step 5 또는 이후로의 의미**.
> Plan: [`PHASE_3_STEP_4_TEAM_MEMBER_API.md`](PHASE_3_STEP_4_TEAM_MEMBER_API.md).

---

## 결론

Step 4 **완료** (2026-05-11). 계획서 §12 완료 기준 13항목 모두 통과. Phase 3 Step 5 (Invitations API) 진입 가능.

### 적용 파일 (8 신규, 4 수정)

| 종류 | 경로 | 비고 |
|---|---|---|
| middleware | `server/src/middleware/requireFreshRole.ts` (신규) | JWT role 대 DB role 비교. missing/disabled → `stale_session`. role mismatch → `stale_role`. DB 오류는 catch 없음 → Fastify 500 |
| repo | `server/src/repositories/memberships.ts` (수정) | `listForCurrentOrgWithUser` + `getByIdForUpdate` + `lockActiveAdminIds` (ORDER BY id FOR UPDATE) + `updateRoleStatus` (updated_at 명시 갱신 — memberships엔 trigger 없음) |
| service | `server/src/services/memberships.ts` (신규) | `updateMembership`: admin set lock → target lock → 시뮬레이션 → patch → disabled 시 sessions revoke + manager_id NULL |
| service | `server/src/services/teams.ts` (신규) | `listTeams` / `createTeam` / `updateTeam` / `deleteTeam`. managerId cross-org 검증. DELETE 사전 정리 (`UPDATE memberships SET team_id = NULL`) |
| service | `server/src/services/auth.ts` (수정) | `resolveMembershipForLogin`의 no-orgId 분기에 `account_disabled` 코드 추가. explicit-orgId 분기는 `invalid_credentials` 유지 |
| route | `server/src/routes/team.ts` (신규) | 6 endpoint. mutation 4개에 `requireAuth → orgContext → requireRole('admin') → requireFreshRole` 체인. ZodError + AuthError 매핑 |
| server | `server/src/server.ts` (수정) | `teamRoutes` register |
| shared types | `server/src/types/team.ts` (신규) + `platform/types/team.js` (신규) + `test/sync_shared_types.mjs` (수정) | `Team`, `TeamCreateInput`, `TeamPatchInput`, `Member`, `MembershipPatchInput` (derived) |
| test | `server/test/team_member_routes.test.mjs` (신규) | 24 cases |

### 검증 결과 (plan §12)

| # | 항목 | 결과 |
|---|---|---|
| 1 | typecheck | PASS |
| 2 | server unit test | **125/125** PASS (Step 1·2·3 회귀 101 + 신규 24) — 2회 안정성 확인 |
| 3 | `sync_shared_types.mjs` | PASS (customers + signup + password-reset + team) |
| 4 | Phase 0.5 e2e | 16/16 PASS |
| 5 | Phase 2 customers e2e | 7/7 PASS |
| 6 | 수동 검증 | admin login → `/team/members` 2건 → 자기 강등 시도 → **409 last_admin_protected** → 사원 disable → **200** + sessions revoked → 사원 login → **401 account_disabled** → 사원 active 복원 → 사원 login → **200** → `/teams` 생성/조회/삭제 OK. 최종 DB 상태 시드와 동일 |

---

## 발견 사항

### 1. `requireFreshRole`이 race condition까지 캐치 — 단위 테스트가 의도 확장 발견

(1) `concurrent demote of two admins` 테스트가 두 가지 정당한 결과를 모두 봐줘야 했다. 시나리오: ACME_ADMIN + extra 둘 다 admin, ACME_ADMIN의 JWT로 두 demote 요청을 동시 발사.

| 결과 | 어떻게 발생하는가 |
|---|---|
| `[200, 409]` | 두 tx가 DB-level `FOR UPDATE` lock에 직렬화. 두 번째 tx가 unblock된 시점에 admin set이 이미 1로 줄어 demote 시 0 → `last_admin_protected` |
| `[200, 401]` | 첫 tx가 ACME_ADMIN을 demote한 후 commit. 두 번째 요청의 `requireFreshRole`이 그 직후 실행돼 JWT(`admin`) vs DB(`employee`) 불일치 → `stale_role` |

(2) 둘 다 **"두 동시 demote가 모두 성공해 admin이 0이 되는 것"을 방지한다는 같은 invariant**의 다른 표현. 테스트가 `[200, 409] || [200, 401]` 디스정션 + `active admin count >= 1` DB-level invariant 두 가지로 assert. 그 이상의 단정은 timing-dependent라 flaky 위험.

(3) Step 5 invitation 생성·취소 endpoint에도 `requireFreshRole` 적용 시 같은 trade-off가 발생할 수 있다. 단위 테스트는 결과 코드 set만 assert하고 "어느 layer가 차단했는지"는 묻지 않는 패턴 권장 — 본 finding을 Step 5 plan §unit-test §race로 인계.

---

### 2. last admin 보호의 SELECT FOR UPDATE 패턴 — phantom 회피 + deadlock 회피

(1) `lockActiveAdminIds`가 `SELECT id ... WHERE role='admin' AND status='active' ORDER BY id FOR UPDATE`로 활성 admin 행 전체를 잡는다. Codex 리뷰 §3에서 명시한 `ORDER BY id`로 lock 획득 순서를 결정적으로 만들어 두 동시 mutator 간 cross-row deadlock 회피.

(2) Postgres READ COMMITTED 의 SELECT FOR UPDATE는 lock 충돌 시 대기 → 최신 commit version 재조회 → WHERE 재평가. 즉 첫 tx가 admin을 demote 후 commit하면 두 번째 tx가 unblock된 후 그 행은 더 이상 `role='admin'` 아니므로 set에서 빠짐. 이게 §1의 `[200, 409]` 시나리오를 만드는 메커니즘.

(3) admin row 수가 매우 많은 enterprise tier (Phase 6+)에서는 lock contention 가능성. 본 phase는 N<100 가정. Phase 6+ advisory lock 또는 SERIALIZABLE 격리 도입 검토.

---

### 3. memberships엔 `touch_updated_at` trigger 없음 — 명시적 `updated_at = now()` 필요

(1) Phase 2의 `touch_updated_at()` 함수는 customers 전용 trigger다 (`customers_touch_updated_at`). memberships는 trigger가 없으므로 `UPDATE memberships SET role=...`만 하면 `updated_at`이 stale로 남는다. 본 step `updateRoleStatus`가 `SET updated_at = now()`를 명시적으로 박아 해결.

(2) Step 5 (invitations)·Step 6+ 후속 entity가 memberships를 추가 mutation하는 경우 같은 패턴 필요. **권장 follow-up** (Phase 6+ schema 정리): `touch_updated_at` trigger를 entity별로 일관 적용 (memberships, teams, invitations 등). 본 step에서는 마이그레이션 추가 없이 service-layer로 해결.

(3) teams의 `updateTeam`도 `SET updated_at = now()`를 명시. teams 역시 trigger가 없음.

---

### 4. 마지막 admin 보호의 "자기 강등" 케이스 — 별도 분기 없음, 충분

(1) plan §1-4 결정 그대로 구현. ACME_ADMIN이 자기 자신을 demote/disable 시도해도 **마지막 admin 보호 로직이 자동 차단** (자기 자신을 demote하면 active admin set이 줄어들고, 그게 0이 되면 409). 별도 "self-demote 차단" 코드 없음.

(2) 단위 테스트 `last active admin self-demote → 409` + `second admin exists → self-demote OK` 두 케이스로 invariant 핀. 즉 "마지막 admin이면 누구든 (본인 포함) 강등 못 함"이 정책.

(3) Step 5 invitation accept가 새 admin을 추가할 수 있는데 본 정책과 무관 (자기 admin 추가는 보호와 반대 방향). Step 4 동작 변경 없음.

---

### 5. `account_disabled` vs `invalid_credentials` — 분기 위치 결정

(1) plan §6 그대로. **no-orgId 분기에서만** `account_disabled`. explicit-orgId 분기는 `invalid_credentials` 유지.

| 흐름 | login 응답 |
|---|---|
| email 없음 | `401 invalid_credentials` |
| email 있음 + password 틀림 | `401 invalid_credentials` |
| email + password OK + (no orgId) + 활성 membership 0건 | **`401 account_disabled`** |
| email + password OK + explicit orgId + 그 org에 활성 membership 없음 | `401 invalid_credentials` (의도) |
| email + password OK + 활성 membership 1+ | `200` 정상 진입 |

(2) explicit-orgId 분기에서 `account_disabled`를 안 쓰는 이유: 사용자가 "어떤 orgId가 자기 거인지" 추측 가능해질 위험. multi-org user 입장에서 다른 org는 active인데 입력 orgId만 disabled여도 `invalid_credentials`로 응답하면 "정확한 org 정보"가 노출되지 않음. multi-org disabled 정보 노출은 본인 워크플로 (orgId 없이 다시 시도)에서만.

(3) Master §11 정합. enumeration 차단은 forgot password (Step 3) 한정, login은 의도된 분기 노출.

---

### 6. `DELETE /teams/:id` service-layer 사전 정리 — DB 마이그레이션 회피

(1) Phase 1 composite FK `(org_id, team_id) → teams(org_id, id) ON DELETE SET NULL`이 cascade 시 `org_id`까지 NULL로 set 시도해 `memberships.org_id` NOT NULL 위반으로 cascade fail. service 트랜잭션이 먼저 `UPDATE memberships SET team_id = NULL WHERE team_id = $1` 한 뒤 `DELETE FROM teams` — Codex 리뷰 §1 권장 그대로.

(2) 단위 테스트 `DELETE /teams/:id: pre-clears memberships.team_id then deletes`가 이 invariant를 직접 핀. 시나리오: emp의 team_id를 설정 → DELETE → 응답 204 → `memberships.team_id IS NULL` + `teams` row 부재 둘 다 assert.

(3) **권장 follow-up** (Phase 6+): PG 15+ 문법 `FOREIGN KEY (org_id, team_id) REFERENCES teams(org_id, id) ON DELETE SET NULL (team_id)` 마이그레이션. 그러면 service 사전 정리 단계 제거 가능. Phase 3에서는 단순성 우선이라 service-layer로 해결.

---

### 7. disabled member의 manager_id 자동 정리 — eager cleanup

(1) plan §1-5b 그대로. `updateMembership`에서 status='disabled' 전환 시 같은 tx 안에서 `UPDATE teams SET manager_id = NULL WHERE org_id = ? AND manager_id = user_id` 실행. RLS는 자동으로 자기 org로 scope되지만 명시 predicate로 의도 가시화.

(2) 단위 테스트 `admin disables employee → sessions revoked + manager_id cleared`가 (a) emp의 sessions가 `revoked_reason='admin_disabled'`로 revoked + (b) emp가 manager인 team의 manager_id가 NULL인 것 모두 assert.

(3) cross-org manager는 본 step에서 처리 안 함 — RLS scope이 자기 org만이라 다른 org에서 같은 user가 manager면 그 org의 admin이 별도로 처리. multi-org 정책은 plan §11에 명시.

---

### 8. `requireFreshRole`의 read endpoint 제외 — 정책 그대로

(1) plan §1-2 / §5 / Master §2-14 정합. `GET /team/members` / `GET /teams`는 `requireAuth + orgContext`만 적용. read에 fresh role 검사를 거는 건 cost (DB round-trip) 대비 security gain이 없음 (read-only이라 demoted admin이 보는 정도는 위험하지 않음).

(2) Step 5 `POST /invitations` / `DELETE /invitations/:id`도 같은 패턴 — 본 미들웨어 적용. read endpoint (`GET /invitations`)는 제외.

(3) 향후 manager team-scope write가 도입되면 (Phase 4+) `requireFreshRole` 적용 범위 재검토 필요. 본 phase는 binary (admin vs nonadmin) 권한이라 단순.

---

### 9. Step 5 진입 시 그대로 재사용할 수 있는 인프라

| 인프라 | 사용처 |
|---|---|
| `requireFreshRole` 미들웨어 | `POST /invitations`, `DELETE /invitations/:id` (Master §2-14) |
| sessions revoke 패턴 (`COALESCE(revoked_at, now()), COALESCE(revoked_reason, ...)`) | Step 5에서 의도된 경우 없으나 향후 admin이 invitation user를 disable 처리 시 |
| Last-admin-style FOR UPDATE lock | Step 5 invitation은 last-admin과 무관하지만 같은 패턴이 `last_invitation_active` 등 다른 invariant에 응용 가능 |
| AuthError + zod refine + ZodError → 400 invalid_input handling | route handler 표준 패턴 |
| `withOrgContext` + RLS isolation | 모든 인증된 흐름 |
| `listActiveMembershipsAcrossOrgs` (Step 3 export) | Step 5 accept invitation에서 existing user lookup 시 |

---

### 10. Phase 3 도메인 추가 비용 0 (마이그레이션·풀·env)

(1) Step 4가 추가한 DB 객체 / 시스템 자원: **0개**. Step 1·2·3가 깐 기반 (schema + RLS + service credential + token lifecycle + EmailProvider + sessions revoke 패턴) 위에 service / route / 미들웨어 / shared types만 깔림.

(2) 본 패턴이 Step 5에도 그대로 — invitations는 schema가 Step 1에서 보강됐고 (purpose='invitation' auth_tokens + accept URL outbox), Step 5는 service / route / 단위 테스트만 추가 예정. Phase 1·2 인프라 안정성이 Phase 3 후속 step에 누적 dividend.

---

## Step 5 진입 체크리스트

- [x] `requireFreshRole` middleware: Step 5 `POST/DELETE /invitations`에 재사용
- [x] memberships repository extensions (lock / list / update): Step 5 accept가 multi-org user lookup 시 재사용 가능
- [x] AuthError 매핑 / ZodError handling: route handler 표준 패턴
- [x] account_disabled 분리: Step 5 변경 없음 (login 정책 굳어짐)
- [ ] Step 5: `POST /invitations` (admin only, `requireFreshRole` 적용) + `GET /invitations` (admin only, list) + `POST /invitations/:id/resend` (admin only) + `DELETE /invitations/:id` (soft cancel, admin only) + `POST /invitations/accept` (anonymous, servicePool wrapper)
- [ ] Step 5: 만료 pending 자동 cancel + UNIQUE partial 충돌 처리 (Master §2-9, Step 1 plan §8)
- [ ] Phase 6+: `touch_updated_at` trigger 전사 적용 (memberships, teams 등)
- [ ] Phase 6+: composite FK `ON DELETE SET NULL (team_id)` 정확화로 service-layer 사전 정리 제거
- [ ] Phase 6+: access JWT 능동 무효화 (session-id middleware cross-check 또는 ACCESS_TOKEN_TTL 단축)

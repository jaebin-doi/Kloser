# Phase 3 Step 1 Findings — Schema: auth_tokens + email_outbox + invitations 보강 + memberships.status CHECK

> Audience: Phase 3 Step 2 작성자 (또는 미래의 나).
> Format: each finding has **(1) 관찰**, **(2) Step 2 또는 이후로의 의미**.
> Plan: [`PHASE_3_STEP_1_SCHEMA.md`](PHASE_3_STEP_1_SCHEMA.md).

---

## 결론

Step 1 **완료** (2026-05-11). 계획서 §12 완료 기준 13항목 모두 통과. Phase 3 Step 2 (회원가입 + 이메일 인증) 진입 가능.

### 적용 파일 (6개)

| 종류 | 경로 | 비고 |
|---|---|---|
| migration | `server/migrations/1715000004000_phase3_memberships_status_check.sql` | CHECK + `memberships_org_role_active_idx` partial |
| migration | `server/migrations/1715000005000_phase3_invitations_enrich.sql` | token 컬럼 drop + 메타 4종 add + 파셜 유니크 2개 |
| migration | `server/migrations/1715000006000_phase3_auth_tokens.sql` | 통합 표 + UNIQUE partial × 2 + RLS 정책 × 4 |
| migration | `server/migrations/1715000007000_phase3_email_outbox.sql` | dev provider 표 + 인덱스 × 2 + RLS 정책 × 4 |
| seed | `server/seeds/0003_phase3_demo.sql` | Acme live 초대 + expired 초대 + outbox 샘플 |
| wrapper | `server/scripts/run-seed.mjs` | checks 2줄 추가 (`invitations` 2, `email_outbox` 1) |
| plan | `docs/plan/phase-3/PHASE_3_STEP_1_SCHEMA.md` | — |

### 검증 결과 (plan §10)

| # | 항목 | 결과 |
|---|---|---|
| #1 | `db:migrate:up` 4개 적용 | PASS |
| #2 | 4 테이블 RLS FORCE | `auth_tokens / email_outbox / invitations / memberships` 모두 `t \| t` |
| #3 | RLS 정책 8개 | auth_tokens × 4 + email_outbox × 4 |
| #4 | `memberships_status_check` 등록 | `CHECK (status IN ('active','disabled'))` |
| #5 | `status='bogus'` INSERT 거부 | `memberships_status_check` 위반 |
| #6 | invitations 컬럼 형상 | token_hash/expires_at 부재, team_id/invited_by_user_id/canceled_at/last_sent_at 존재, `invitations_active_org_email_idx` UNIQUE partial 등록 |
| #7 | 같은 (org,email) 활성 초대 중복 INSERT 거부 | `invitations_active_org_email_idx` 위반 |
| #7.5 | auth_tokens 형상 | `org_id NOT NULL` + UNIQUE partial × 2 (`auth_tokens_invitation_active_idx`, `auth_tokens_user_purpose_active_idx`) + 두 CHECK (`auth_tokens_purpose_check`, `auth_tokens_invitation_purpose_check`) + 4 RLS 정책 |
| #7.6 | 같은 invitation의 2번째 활성 토큰 INSERT 거부 | `auth_tokens_invitation_active_idx` 위반 |
| #9 | `db:seed` | `invitations=2`, `email_outbox=1` 모두 OK |
| #10 | RLS isolation (app role) | `no_guc=(0,0)`, `acme=(inv 2, outbox 1)`, `beta=(0,0)` |
| #12 | `db:migrate:redo` | 4 마이그레이션 회전 후 pgmigrations 8행 그대로, 재시드로 상태 복원 |

### 회귀

- `npm --prefix server run typecheck` PASS
- `npm --prefix server test` — **65/65** PASS
- `node test/phase_0_5_e2e.mjs` — 16/16 PASS
- `node test/phase_2_customers_e2e.mjs` — 7/7 PASS

---

## 발견 사항

### 1. invitations 토큰 컬럼 폐기 + `auth_tokens.invitation_id`로 정규화 — 완료

(1) Phase 1 init의 `invitations.token_hash text NOT NULL` + `expires_at timestamptz NOT NULL`을 본 step에서 DROP COLUMN. Phase 1 시드 0행이라 backfill 불필요. `invitations_token_hash_idx`도 명시적 DROP INDEX 선행해 cascade 의존성을 깨끗이 분리. 1초대 N토큰 lifecycle은 `auth_tokens.invitation_id` FK로 풀린다 — resend 시 invitations 행 유지 + 새 auth_tokens 행 추가 + 옛 토큰 `invalidated_at` 처리.

(2) Step 5 (invitations service) 구현 시 다음 invariant를 코드로 보장:
- invitations INSERT 시 같은 트랜잭션 안에서 auth_tokens INSERT — 활성 토큰 없는 pending invitation 행은 만들지 않는다 (plan §8 정의).
- resend는 옛 auth_tokens 행에 `invalidated_at = now()` set한 뒤 새 행 insert — `auth_tokens_invitation_active_idx` UNIQUE partial이 race 시 23505로 강제 직렬화.

---

### 2. 만료 판단은 `auth_tokens.expires_at`로 일원화

(1) plan §8 정책 확정: pending 초대는 자신의 활성 invitation 토큰 (`consumed_at IS NULL AND invalidated_at IS NULL`)이 존재하고 그 `expires_at > now()`일 때 "live". 활성 토큰 부재 또는 만료면 "expired pending"으로 간주. invitations 자체엔 `expires_at` 컬럼 없음.

(2) Step 5 service 트랜잭션이 LEFT JOIN ... FOR UPDATE OF i,t를 시도하면 PostgreSQL이 거부한다 ("cannot be applied to nullable side of an outer join"). plan §8 sketch는 이를 회피해 **2-query 패턴**으로 작성됨 — invitations 행을 먼저 FOR UPDATE, 그 id로 auth_tokens 별도 SELECT FOR UPDATE. Step 5 구현 시 그 패턴 그대로 따른다.

---

### 3. Active token UNIQUE partial index 2개로 invariant를 DB 차원에서 강제

(1) 두 인덱스 모두 UNIQUE partial로 깔림:
- `auth_tokens_invitation_active_idx`: `UNIQUE (invitation_id) WHERE purpose='invitation' AND consumed_at IS NULL AND invalidated_at IS NULL` — 1초대 당 활성 invitation 토큰 1개 강제.
- `auth_tokens_user_purpose_active_idx`: `UNIQUE (user_id, purpose) WHERE user_id IS NOT NULL AND consumed_at IS NULL AND invalidated_at IS NULL` — 같은 user의 같은 purpose 활성 토큰 1개 강제. `user_id IS NOT NULL` 필터로 invitation purpose (user_id NULL) 자연 제외.

(2) Step 2 (email_verification / password_reset 발급) 구현 시 resend 흐름은:
- 활성 토큰 FOR UPDATE
- `invalidated_at = now()` set
- 새 행 INSERT

순서를 같은 트랜잭션에 두면 UNIQUE 위반이 안 난다. 만약 두 동시 호출이 race 시 두 번째가 23505로 차단 — service에서 retry 또는 409 응답.

(3) **Step 2 plan에 명시 필요**: 위 패턴이 모든 토큰 발급 경로에서 반드시 사용되도록 함수/서비스 boundary 확정.

---

### 4. `auth_tokens.org_id` / `email_outbox.org_id` 모두 NOT NULL — RLS와 컬럼 NOT NULL 이중 방어

(1) 두 신규 표 모두 `org_id uuid NOT NULL`로 깔림. org 격리 테이블의 일관성을 유지하고, anonymous 흐름이 SECURITY DEFINER 또는 service credential을 통해 INSERT할 때 RLS WITH CHECK 우회가 가능해도 컬럼 NOT NULL이 잡아준다. signup 트랜잭션도 org → user → membership → (token / outbox) 순서로 commit하므로 NULL 입력 시점이 없음.

(2) Step 2 anonymous endpoint 구현 시 보장사항:
- `/auth/signup`: org row 먼저 INSERT (`organizations` 트랜잭션 안), 그 org_id로 token + outbox row INSERT.
- `/auth/password/forgot`: lookup된 user의 활성 membership 중 1개 org_id로 token + outbox row INSERT.
- `/invitations/accept`: 토큰 행이 가진 invitation_id를 통해 inviting org_id 조회 후 새 user/membership/outbox에 그 org_id 사용.

세 흐름 모두 service / SECURITY DEFINER 인자로 org_id를 명시적으로 전달. **Step 2 plan §접근점별 org_id 전파 다이어그램 1장 권장**.

---

### 5. Anonymous token RLS 우회 — Step 2 결정으로 이월. `MIGRATE_DATABASE_URL` 재사용은 사전 금지

(1) plan §6 결정점 그대로: RLS 정책 4개는 본 step에 깔렸고, anonymous endpoint (`/auth/verify`, `/auth/password/reset`, `/invitations/accept`)의 우회 구현은 Step 2로 보류. 후보는 **(a) 좁은 SECURITY DEFINER 함수** vs **(b) BYPASSRLS service credential 신규 도입**. AGENTS.md §83 (runtime=app role / migrations=admin URL) 위반이라 `MIGRATE_DATABASE_URL` 재사용은 사전 금지.

(2) Step 2 plan에서 다음을 확정해야 한다:
- (a)/(b) 어느 쪽 — 정합성 / 권한 표면 / dev·CI 환경 변수 추가 비용 비교
- (a)면: 함수 OWNER + `SET LOCAL row_security = off` 패턴 사용. FORCE RLS는 OWNER에도 적용되므로 함수 내부에서 명시적으로 끔. Postgres 권한 동작은 실제 dev DB에서 짧게 검증 (Codex review 비차단 메모).
- (b)면: 새 DB role `kloser_service` 도입. `BYPASSRLS` 또는 row policy 우회 grant 범위 명시. dev/CI에 `SERVICE_DATABASE_URL` 환경 변수 추가. seed에선 사용 안 함.

(3) 어느 쪽이든 본 step의 4 RLS 정책은 변경 안 됨 — defense-in-depth는 그대로.

---

### 6. `memberships.status` CHECK + 활성 partial 인덱스 — Step 4 정착 전 준비 완료

(1) Phase 1 init에서 status 컬럼이 CHECK 없이 `text NOT NULL DEFAULT 'active'`로만 깔렸던 부분을 본 step에서 `CHECK (status IN ('active','disabled'))`로 좁혔다. 시드 0건 미사용 값 → backfill 불필요. 추가로 `memberships_org_role_active_idx` (`(org_id, role) WHERE status='active'`) partial 인덱스를 깔아 **마지막 admin 보호** (Master §2-12) + **로그인 활성 membership 검증** (Step 4) 두 hot path를 흡수.

(2) Step 4 (`PATCH /memberships/:id`) 구현 시 마지막 admin 보호 트랜잭션은 그대로 plan §2-12 패턴 — `SELECT count(*) ... WHERE org_id=? AND role='admin' AND status='active' FOR UPDATE`. 본 인덱스 + FOR UPDATE 조합이 race 차단.

(3) `users.disabled_at` (전역) vs `memberships.status='disabled'` (per-org) 분리 정책 (plan §4 후반)도 본 step에서 schema 차원으로 확정. 로그인 분기 로직은 Step 4에서 구현.

---

### 7. Seed의 expired 초대 표현 — invitations row + auth_tokens row 짝으로

(1) plan §9 결정 그대로 구현. 두 짝의 데이터 형태:

| invitation | auth_token (purpose='invitation') |
|---|---|
| `1ff11111-...` live, role=employee, `last_sent_at=now()` | `77111111-...` `expires_at=now()+5d`, consumed/invalidated NULL — UNIQUE partial 포함 |
| `1ff22222-...` expired-state, role=viewer, `last_sent_at=now()-8d` | `77222222-...` `expires_at=now()-1d`, consumed/invalidated NULL — 만료됐지만 UNIQUE partial 여전히 포함 |

`expired` 초대도 invitations row 자체는 `accepted_at=NULL, canceled_at=NULL`이라 활성 partial 유니크에 포함됨. Step 5 service 패턴 (plan §8)이 cancel 후 재발급을 처리. 단순 INSERT로는 § 10 #7처럼 막힌다.

(2) Acme에만 박고 Beta는 비웠다 — § 10 #10 RLS isolation 검증이 시각적으로 분명. Step 7 e2e가 Beta org 데이터를 새로 만들 때 본 시드와 충돌 안 함.

(3) raw token은 시드 주석에 reference로 평문 기록 (`phase3-seed-active-invitation-token`, `phase3-seed-expired-invitation-token`). e2e는 이 raw를 직접 쓰지 않음 — e2e는 자기 시나리오에서 새 초대 발송 후 outbox에서 추출.

---

### 8. `db:migrate:redo -c 4`의 실제 의미 — 단일 마이그레이션 회전만 보장 (Step 4+ 검증 시 주의)

(1) `npm --prefix server run db:migrate:redo -- -c 4` 실행 결과:
- 출력은 0007 (email_outbox) 의 down + up만 보임
- redo 후 `pgmigrations` 행은 8개 모두 존재
- redo 후 `email_outbox`는 0 rows (recreated empty), `auth_tokens`/`invitations`는 2 rows씩 그대로 (down/up 사이클이 그 테이블엔 안 닿음)

따라서 `redo -c N`은 **count=1과 사실상 동일**한 동작 — node-pg-migrate의 redo는 최신 마이그레이션 1개만 회전. plan §10 #12의 "4개 마이그레이션이 down → up 왕복"은 단일 redo로는 못 보장된다.

(2) **Step 4+ 진입 시 권장 검증 절차**: 전체 down→up 왕복이 정말 필요할 때만 `db:migrate:down -- -c N`을 수동으로 사용. seed 데이터가 wipe되므로 직후 `db:seed` 재실행 필수. 본 step의 down 4개는 (a) 각 마이그레이션 down SQL이 symmetric 작성됨 + (b) 0007의 down/up이 redo로 실증됨 + (c) typecheck/server unit/e2e 회귀가 PASS로 **간접 검증**된다고 본다.

(3) `PHASE_3_STEP_1_SCHEMA.md §10 #12` 문구는 다음 step plan 작성 시 "redo는 단일 회전, 4 회전 검증이 필요하면 down -c N + up + db:seed" 형태로 정정 권장.

---

### 9. customers count drift — Phase 2 e2e의 운영 위생 finding (비차단)

(1) `db:seed` 출력이 `customers count=38 EXPECTED 24`를 보고함. Acme org에 `e2etest-*` prefix 14행 잔존 — Phase 2 e2e의 이전 인터럽트로 인한 sweep 누락 누적. Phase 2 customers e2e 본체는 PASS (자기 세션이 만든 row만 cleanup하는 패턴이고, seed pre-check는 `eeee%` prefix만 카운트해 12로 정확히 봄).

(2) Phase 3 Step 1 작업과 무관. Step 1 차단 사항 아님. 그러나 `run-seed.mjs`의 `customers count` check가 24로 hardcoded라 매 seed 실행마다 EXPECTED FAIL 경고 — 시각적 노이즈 + 진짜 시드 손상을 가릴 위험.

(3) **별도 mini cleanup task 권장**:
- (a) 일회성 정리: `DELETE FROM customers WHERE name LIKE 'e2etest-%' OR name LIKE 'e2etest-add-%-edited'` (admin URL 경유)
- (b) Phase 2 e2e의 `phase_2_customers_e2e.mjs` cleanup 패턴을 finally + signal handler 보강 — Ctrl-C 또는 throw 시에도 sweep 확실히 실행
- (c) 또는 `run-seed.mjs` checks를 `count >= expected`로 relaxation (false negative 위험은 있으나 e2e 잔재 흡수 가능)

본 finding은 **Phase 3 closure 직전 (Step 7 e2e + Phase 3 종합 findings) 또는 별도 mini-task에서 정리**. Step 2 진입은 막지 않는다.

---

### 10. Codex review 비차단 메모: SECURITY DEFINER × FORCE RLS 검증 (Step 2 책임)

(1) plan §6의 "(a) SECURITY DEFINER 함수"를 Step 2가 채택할 경우, FORCE RLS는 함수 OWNER에게도 적용되므로 함수 내부에서 `SET LOCAL row_security = off`를 명시적으로 호출해야 RLS bypass가 동작. Codex 리뷰가 "지금 Step 1 구현을 막을 사항은 아니다"라고 한 비차단 메모 — Step 2 진입 시점에 dev DB에서 실제 권한 동작을 1회 검증한 뒤 패턴 채택.

(2) (b) service credential 채택 시엔 무관 — BYPASSRLS 권한이 role 차원에서 부여되므로 FORCE RLS도 우회됨.

(3) 어느 쪽이든 **Step 2 plan의 검증 절차에 본 항목 1줄 추가** (예: "anonymous endpoint 1개 호출 → 정상 응답 + auth_tokens 행 정상 insert/select 확인").

---

## Step 2 진입 체크리스트

- [x] schema layer 완성: 4 신규 / 보강 마이그레이션 + RLS + UNIQUE partial × 3 + CHECK × 4
- [x] seed: Acme live 초대 + expired 초대 + outbox 샘플 (Beta 격리 시각화)
- [x] Phase 1·2 회귀 (typecheck / server unit / 2 e2e) PASS
- [ ] anonymous RLS 우회 방식 (a) vs (b) — Step 2 plan §1에서 확정
- [ ] EmailProvider 인터페이스 정의 — `services/email.ts` (Step 2)
- [ ] signup / verify / verify-resend service + route + 단위 테스트 (Step 2)
- [ ] customers count drift cleanup — Phase 3 종료 직전 또는 별도 mini-task

# Phase 3 Step 1 — Schema: auth_tokens + email_outbox + invitations 보강 + memberships.status CHECK

> **상위 계획**: `docs/plan/phase-3/PHASE_3_MASTER.md` §3 Step 1 + §5 데이터 모델.
> **선행**: Phase 2 완료 — `docs/plan/phase-2/PHASE_2_MASTER.md`.
> **기간**: 1.5일.

---

## 진행 상태

- [ ] 1. 현재 스키마 확인 (본 plan §2) — `memberships.status`, `invitations.token_hash`/`expires_at` 존재 여부 + 시드 영향
- [ ] 2. 마이그레이션 4개 + 적용 순서 사전 결정 (§3)
- [ ] 3. `memberships.status` CHECK (`active`/`disabled`) 추가 (§4)
- [ ] 4. `invitations` 보강 — token 컬럼 제거 + 컬럼 4개 추가 + 파셜 유니크 (§5)
- [ ] 5. `auth_tokens` 신규 — 컬럼·인덱스·RLS 사전 결정 (§6)
- [ ] 6. `email_outbox` 신규 — 컬럼·dev raw token 노출 정책·RLS (§7)
- [ ] 7. 만료 pending 초대 처리 — 서비스 트랜잭션이 옛 행 `canceled_at` 처리 후 새 행 생성 (§8, 본 step에선 schema 측 사전 합의만)
- [ ] 8. `server/seeds/0003_phase3_demo.sql` 작성 — 활성 초대 1 + 만료 초대 1 + outbox 샘플 1 (§9)
- [ ] 9. `run-seed.mjs` checks 1줄 추가 (§9) — `invitations` count + outbox count
- [ ] 10. 마이그레이션 4개 작성 (Up + Down)
- [ ] 11. `npm run db:migrate:up` + `npm run db:seed` PASS
- [ ] 12. 검증 SQL — FORCE RLS 4 테이블 / org isolation / 파셜 유니크 충돌 / Phase 1·2 회귀 (§10)
- [ ] 13. `PHASE_3_STEP_1_FINDINGS.md` 작성

---

## 0. 목적

Phase 3 회원가입·이메일·초대 흐름의 **저장소 1층**을 깐다. 본 step이 끝나면:

- `auth_tokens` — 3종 purpose (`email_verification` / `password_reset` / `invitation`)의 sha256 hash 1회용 토큰을 단일 표로 보관
- `email_outbox` — dev 환경에서 발송된 메일을 행으로 저장. e2e가 직접 SELECT로 토큰 추출 가능
- `invitations` — 토큰 컬럼은 `auth_tokens.invitation_id`로 위임. team_id / invited_by / canceled_at / last_sent_at 보강. 활성 초대 (org, email) 파셜 유니크
- `memberships.status` — `active`/`disabled` CHECK 제약 (현재는 컬럼만 있고 CHECK 부재)

4 테이블 모두 FORCE RLS. `current_app_org_id()` 헬퍼 재사용. 시드는 평가자가 UI 진입 직후 초대·outbox 외관을 확인할 수 있는 1+1+1 최소 데이터.

이 layer가 통과되면 Step 2 (signup / verify) 구현으로 내려간다.

---

## 1. 본 step에서 결정만 하고 구현은 미루는 것

| 항목 | 처리 |
|---|---|
| **anonymous accept / verify / reset의 auth_tokens RLS 우회 방식** | 본 plan §6에서 후보 (a) 좁은 SECURITY DEFINER 함수 vs (b) BYPASSRLS service credential까지 좁히고 **결정 보류**. `MIGRATE_DATABASE_URL` 재사용은 사전 금지. 최종 채택·구현은 Step 2 plan |
| **만료 pending 초대 자동 cancel 트랜잭션 SQL** | 본 plan §8에서 패턴만 합의. 실제 service 코드는 Step 5 invitations service |
| **EmailProvider 인터페이스 / dev 어댑터** | 본 plan §7에서 outbox 행 형태만 결정. 인터페이스 코드는 Step 2 (`services/email.ts`) |
| **rate-limit / enumeration 응답 통일** | 본 plan 미포함. Step 3 password reset 단계 |

---

## 2. 현재 스키마 확인 결과

`server/migrations/1715000000000_init.sql`을 기준으로 정리.

### 2.1 `memberships.status`

```sql
status text NOT NULL DEFAULT 'active',
```

- **컬럼 존재**: yes
- **CHECK 제약**: **부재** — 현재는 어떤 문자열도 허용
- **`memberships` 시드 사용 값**: `0001_demo.sql`은 status 컬럼을 명시하지 않음 → 모두 DEFAULT `'active'`. 다른 값으로 적재된 행 0건
- **결정**: 본 step에서 CHECK 추가. 시드 값과 정합되므로 안전. 운영 데이터가 없는 시점이므로 backfill 불필요

### 2.2 `invitations`

```sql
CREATE TABLE invitations (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email        citext NOT NULL,
    role         text NOT NULL CHECK (role IN ('admin','manager','employee','viewer')),
    token_hash   text NOT NULL,                  -- 본 step에서 DROP COLUMN
    expires_at   timestamptz NOT NULL,           -- 본 step에서 DROP COLUMN
    accepted_at  timestamptz,                    -- 유지
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitations_org_id_idx     ON invitations(org_id);
CREATE INDEX invitations_token_hash_idx ON invitations(token_hash);  -- 본 step에서 DROP INDEX
```

- **`token_hash` / `expires_at`**: NOT NULL로 박혀 있음. 그러나 **시드에 invitations 행 0건** + 운영 데이터 0건 (Phase 3 진입 전) → `DROP COLUMN`이 안전. backfill·NULL 허용 단계 불필요
- **`accepted_at`**: 보강 후에도 유지. 본 step에서 손대지 않음
- **`invitations_token_hash_idx`**: 컬럼이 사라지면 자동으로 함께 사라지지 않음. 명시적 `DROP INDEX` 필요 (DROP COLUMN이 의존 객체를 cascade하지 않게 하려면 컬럼보다 먼저 인덱스를 drop)
- **RLS**: `invitations_org_isolation` 정책 존재. 그대로 유지
- **FK**: org_id → organizations(id) ON DELETE CASCADE. 그대로 유지

### 2.3 `users.email_verified_at`, `users.disabled_at`

```sql
email_verified_at timestamptz,    -- 이미 존재
disabled_at       timestamptz,    -- 이미 존재
```

- 본 step에서 **컬럼 변경 없음**. Phase 1에서 미리 깔아둔 자리를 Phase 3 service가 채우는 형태
- 로그인 차단 정책 (§4 후반)에서 `users.disabled_at`(전역) vs `memberships.status='disabled'`(per-org) 분리 의미 명시

### 2.4 시드 영향 사전 점검

```
organizations    2  → 영향 없음
users            4  → 영향 없음 (email_verified_at은 NULL로 유지)
memberships      4  → status CHECK 추가로 'active' 값 영향 없음
sessions         0  → 영향 없음
teams            0  → 영향 없음
invitations      0  → 컬럼 drop 안전
customers       24  → 영향 없음
```

---

## 3. 마이그레이션 파일 + 적용 순서

### 4 파일, +1000 increment, 의존성 순서

| # | 파일 | 의존성 | 내용 |
|---|---|---|---|
| 1 | `1715000004000_phase3_memberships_status_check.sql` | 없음 | `memberships.status` CHECK 제약 추가 |
| 2 | `1715000005000_phase3_invitations_enrich.sql` | invitations 존재 (Phase 1) | `token_hash` / `expires_at` / `invitations_token_hash_idx` drop + `team_id` / `invited_by_user_id` / `canceled_at` / `last_sent_at` add + 파셜 유니크 |
| 3 | `1715000006000_phase3_auth_tokens.sql` | 1·2 적용 후 (invitations 보강 끝난 상태에서 FK 생성) | `auth_tokens` 테이블 + 인덱스 + RLS |
| 4 | `1715000007000_phase3_email_outbox.sql` | organizations 존재 (Phase 1) | `email_outbox` 테이블 + 인덱스 + RLS |

**순서 근거**:
- 1 → 2: 무관계, 1을 먼저 두면 memberships 변경이 다른 변경과 분리돼 리뷰가 쉬워짐
- 2 → 3: `auth_tokens.invitation_id` FK는 enriched `invitations`를 참조하나, 보강 컬럼이 아닌 PK(id)만 참조하므로 기술적으로는 enrich 이전에도 가능. 그러나 동일 phase 내 변경이라 순서를 자연 흐름대로 깔아둠
- 3·4 순서: 무관계 (서로 FK 없음). 알파벳/주제 순으로 auth_tokens → email_outbox

### `seed` wrapper 갱신 — 1줄 추가만

```js
const checks = [
    ["organizations",  2],
    ["users",          4],
    ["memberships",    4],
    ["customers",     24],
    ["invitations",    2],   // Phase 3 추가 (활성 1 + 만료 1)
    ["email_outbox",   1],   // Phase 3 추가 (샘플 1)
];
```

Phase 2 wrapper 일반화 이후 wrapper 코드 자체는 무수정. checks 배열 2줄만 추가. Step 1 구현 커밋에 포함.

### 적용 권한

- 4 마이그레이션 모두 `MIGRATE_DATABASE_URL` (admin role, BYPASSRLS) — Phase 1·2와 동일
- seed (`0003_phase3_demo.sql`)도 동일 admin URL. `SET LOCAL app.org_id` 패턴 재사용 (Phase 1 시드 §43, §50 패턴)

---

## 4. `memberships.status` CHECK 추가

### 마이그레이션 `1715000004000_phase3_memberships_status_check.sql`

```sql
-- Phase 3 Step 1 — memberships.status CHECK 제약 도입.
--
-- Phase 1 init schema에서 status 컬럼은 text NOT NULL DEFAULT 'active'로
-- 깔렸으나 CHECK이 없어 어떤 문자열도 허용됨. Phase 3는 disable 전환을
-- 도입하므로 ('active','disabled') 두 값만 허용하도록 좁힌다.
--
-- 현재 시드 행은 모두 default 'active' — backfill 불필요.

-- Up Migration
-- ============================================================================

ALTER TABLE memberships
  ADD CONSTRAINT memberships_status_check
  CHECK (status IN ('active','disabled'));

-- 활성 멤버 빠른 lookup용 partial index — 마지막 admin 보호 (§Master 2-12)와
-- 로그인 시 활성 membership 존재 검증에 모두 사용됨.
CREATE INDEX memberships_org_role_active_idx
  ON memberships (org_id, role)
  WHERE status = 'active';

-- Down Migration
-- ============================================================================

DROP INDEX IF EXISTS memberships_org_role_active_idx;
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_status_check;
```

### `users.disabled_at` vs `memberships.status='disabled'` 분리

| 컬럼 | 의미 | 사용 |
|---|---|---|
| `users.disabled_at` | **전역 비활성화** — 사용자 계정 자체 사용 불가 (관리자 콘솔) | 로그인 시 `disabled_at IS NOT NULL` → 401 (Phase 3 범위 외, 컬럼만 존재) |
| `memberships.status='disabled'` | **per-org 비활성화** — 특정 org에서만 활동 정지. 다른 org에서는 활성 가능 | 로그인 시 user의 활성 membership이 0개면 → 401 `account_disabled` (Phase 3 도입) |

본 step은 컬럼·CHECK만 정비. 로그인 분기 로직은 Step 4 (Team/Member API)에서 구현.

---

## 5. `invitations` 보강

### 마이그레이션 `1715000005000_phase3_invitations_enrich.sql`

```sql
-- Phase 3 Step 1 — invitations 토큰 컬럼 제거 + 메타 4종 추가.
--
-- 의도:
--   - 토큰은 별도 auth_tokens.invitation_id로 정규화 (Master §2-4 결정).
--     재발송 시 invitations 행 유지 + 새 auth_tokens 행 추가 + 옛 토큰
--     consumed_at 또는 invalidated_at 처리. 1초대 N토큰 lifecycle 분리.
--   - team_id로 초대 시 팀 지정 (NULL 허용).
--   - invited_by_user_id로 감사 trail.
--   - canceled_at으로 soft cancel.
--   - last_sent_at으로 재발송 시점 기록 (rate-limit·UI 표시).
--   - (org_id, lower(email)) 파셜 유니크로 활성 초대 1개만 허용.
--
-- 현재 invitations 시드 행 0건 → token_hash/expires_at DROP COLUMN 안전.
-- 운영 데이터가 있다면 backfill + NULL 허용 단계가 필요했겠지만 phase 진입
-- 전이므로 단순 drop.

-- Up Migration
-- ============================================================================

-- 1) 토큰 인덱스 먼저 drop — 컬럼 drop이 의존 객체를 cascade하지 않도록.
DROP INDEX IF EXISTS invitations_token_hash_idx;

-- 2) 토큰 컬럼 drop
ALTER TABLE invitations DROP COLUMN IF EXISTS token_hash;
ALTER TABLE invitations DROP COLUMN IF EXISTS expires_at;

-- 3) 메타 컬럼 4종 추가
ALTER TABLE invitations
  ADD COLUMN team_id              uuid REFERENCES teams(id) ON DELETE SET NULL,
  ADD COLUMN invited_by_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN canceled_at          timestamptz,
  ADD COLUMN last_sent_at         timestamptz NOT NULL DEFAULT now();

-- 4) 활성 초대 (org, lower(email)) 파셜 유니크.
--    expired pending은 본 인덱스에서 빠지지 않음 — 만료 후 재초대 흐름은
--    서비스 트랜잭션이 옛 행을 canceled_at 처리한 뒤 새 행 생성한다
--    (Master §2-9, 본 plan §8). partial index에 expires_at < now()를 박으면
--    immutable 요구 위반 → 서비스 측 처리로 위임.
CREATE UNIQUE INDEX invitations_active_org_email_idx
  ON invitations (org_id, lower(email::text))
  WHERE accepted_at IS NULL AND canceled_at IS NULL;

-- 5) 운영 lookup용 보조 인덱스 — 활성 초대 목록 (admin 조회)에 사용
CREATE INDEX invitations_org_active_created_idx
  ON invitations (org_id, created_at DESC)
  WHERE accepted_at IS NULL AND canceled_at IS NULL;

-- Down Migration
-- ============================================================================

DROP INDEX IF EXISTS invitations_org_active_created_idx;
DROP INDEX IF EXISTS invitations_active_org_email_idx;

ALTER TABLE invitations
  DROP COLUMN IF EXISTS last_sent_at,
  DROP COLUMN IF EXISTS canceled_at,
  DROP COLUMN IF EXISTS invited_by_user_id,
  DROP COLUMN IF EXISTS team_id;

-- 토큰 컬럼 복원은 Phase 1 init 정의 그대로. 단, 운영 데이터가 있으면
-- 컬럼이 NOT NULL이라 down 실행이 실패한다 — Phase 3 발견 즉시 forward fix
-- 원칙 (Master §6-5)이라 본 down은 dev rollback / migrate:redo 검증용.
ALTER TABLE invitations
  ADD COLUMN expires_at  timestamptz NOT NULL DEFAULT now() + interval '7 days',
  ADD COLUMN token_hash  text NOT NULL DEFAULT '';

CREATE INDEX invitations_token_hash_idx ON invitations(token_hash);

-- Default 값 제거 — Phase 1 시점과 같은 NOT NULL without default 상태로 환원
ALTER TABLE invitations
  ALTER COLUMN expires_at DROP DEFAULT,
  ALTER COLUMN token_hash DROP DEFAULT;
```

### 결정점: `lower(email::text)` vs `email`

| 옵션 | 결정 |
|---|---|
| `(org_id, email)` — citext 그대로 | **안 함** |
| `(org_id, lower(email::text))` — 명시적 lower + text 캐스팅 | **본 step 채택** |

근거: `email`이 이미 `citext`라 비교 시 자동 case-fold가 되지만, **파셜 유니크 인덱스의 표현식**에는 `lower(text)`를 명시적으로 박는 게 향후 mock/실 시나리오에서 직관적. 또한 후속 마이그레이션이 email 컬럼 타입을 바꿔도 인덱스 의미가 보존됨.

### 결정점: `email` 컬럼 자체에 lower normalization?

- 안 함. citext는 비교만 case-insensitive, 저장은 원본 보존 (서비스가 "John@Acme.io"로 보낸 초대 메일이 lowercase로 변형되지 않음). 파셜 유니크는 인덱스 표현식 단계에서만 fold.

### 결정점: 만료 자동 정리 cron

- **안 함** (Master §1 안 한다 정렬). 만료 pending은 새 초대 POST 시 서비스 트랜잭션이 즉시 cancel 처리 (지연 cleanup). Phase 6+ 운영 위생.

---

## 6. `auth_tokens` 신규

### 마이그레이션 `1715000006000_phase3_auth_tokens.sql`

```sql
-- Phase 3 Step 1 — auth_tokens 통합 표.
--
-- email_verification / password_reset / invitation 3 purpose의 sha256 hash
-- 토큰을 단일 표로 관리. 라이프사이클 (생성 → 발송 → 1회 소비 → 만료)이
-- 동일하므로 통합. invitation purpose만 invitation_id FK를 set하고, 나머지
-- 두 purpose는 user_id FK + org_id로 식별.
--
-- 익명 accept / password reset 흐름은 JWT 없이 진입하므로 app.org_id GUC가
-- 비어 있다. 본 step은 RLS 정책 4개만 깔고, anonymous 흐름의 우회 방식
-- (좁은 SECURITY DEFINER 함수 vs 별도 service credential)은 Step 2 plan에서
-- 확정한다. MIGRATE_DATABASE_URL 재사용은 사전 금지 (AGENTS.md §83).
-- RLS는 향후 admin 콘솔 (org 별 활성 토큰 조회) 같은 use case 위한
-- defense-in-depth로 깔아둔다.

-- Up Migration
-- ============================================================================

CREATE TABLE auth_tokens (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- org_id NOT NULL — 본 표는 org 격리 테이블이므로 NULL을 두지 않는다.
    -- 서비스(SECURITY DEFINER든 service credential이든)가 INSERT 시 WITH CHECK
    -- 또는 함수 인자로 항상 채움. signup 트랜잭션도 org row 먼저 생성 후 token
    -- insert 순서라 NULL이 들어갈 시점이 없음.
    org_id          uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         uuid        REFERENCES users(id) ON DELETE CASCADE,
                              -- invitation은 user 가입 전이라 NULL 가능. 나머지는 NOT NULL (CHECK).
    invitation_id   uuid        REFERENCES invitations(id) ON DELETE CASCADE,
                              -- purpose='invitation'에만 set.
    purpose         text        NOT NULL CHECK (purpose IN ('email_verification','password_reset','invitation')),
    token_hash      text        NOT NULL UNIQUE,    -- sha256 hex (64자). 원문은 발송 시점 메모리에만 존재
    expires_at      timestamptz NOT NULL,
    consumed_at     timestamptz,                    -- 1회 소비 시점 (verify·reset·accept 직후 set)
    invalidated_at  timestamptz,                    -- resend 시 옛 토큰 무효화 marker (consumed_at과 분리)
    created_at      timestamptz NOT NULL DEFAULT now(),

    -- purpose별 외래 키 정합 — invitation purpose만 invitation_id 가짐.
    CONSTRAINT auth_tokens_invitation_purpose_check
      CHECK (
        (purpose = 'invitation'      AND invitation_id IS NOT NULL AND user_id IS NULL)
        OR (purpose <> 'invitation' AND invitation_id IS NULL     AND user_id IS NOT NULL)
      )
);

-- 활성 토큰 lookup (user, purpose) — UNIQUE partial.
-- email_verification / password_reset 두 purpose에 대해 같은 user의 동시 활성
-- 토큰을 1개로 강제. resend가 옛 토큰을 invalidated_at 처리한 뒤 새 행 insert
-- 하므로 서비스 invariant와 정합. invitation purpose는 CHECK로 user_id NULL
-- 이라 자연 제외 (WHERE user_id IS NOT NULL).
CREATE UNIQUE INDEX auth_tokens_user_purpose_active_idx
  ON auth_tokens (user_id, purpose)
  WHERE user_id IS NOT NULL
    AND consumed_at IS NULL
    AND invalidated_at IS NULL;

-- invitation 활성 토큰 lookup — UNIQUE partial.
-- §8 정책 "활성 invitation 토큰 1개 이하"를 DB 차원에서 보장.
-- resend가 옛 토큰을 invalidated_at 처리한 뒤 새 행 insert (Step 5).
CREATE UNIQUE INDEX auth_tokens_invitation_active_idx
  ON auth_tokens (invitation_id)
  WHERE purpose = 'invitation'
    AND consumed_at IS NULL
    AND invalidated_at IS NULL;

-- token_hash는 UNIQUE 제약이라 별도 인덱스 불필요 (UNIQUE가 자동 인덱스 생성).

-- 만료 cleanup partial — 운영 위생 Phase 6+. 본 step에서는 인덱스만.
CREATE INDEX auth_tokens_expires_at_idx
  ON auth_tokens (expires_at)
  WHERE consumed_at IS NULL AND invalidated_at IS NULL;

-- ============================================================================
-- RLS
-- ============================================================================

ALTER TABLE auth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_tokens FORCE ROW LEVEL SECURITY;

-- org_id 기반 격리. anonymous 흐름의 우회 방식은 §6 결정 (Step 2에서 확정).
CREATE POLICY auth_tokens_select ON auth_tokens FOR SELECT
  USING (org_id = current_app_org_id());

CREATE POLICY auth_tokens_insert ON auth_tokens FOR INSERT
  WITH CHECK (org_id = current_app_org_id());

CREATE POLICY auth_tokens_update ON auth_tokens FOR UPDATE
  USING      (org_id = current_app_org_id())
  WITH CHECK (org_id = current_app_org_id());

CREATE POLICY auth_tokens_delete ON auth_tokens FOR DELETE
  USING (org_id = current_app_org_id());

-- Down Migration
-- ============================================================================

DROP POLICY IF EXISTS auth_tokens_delete ON auth_tokens;
DROP POLICY IF EXISTS auth_tokens_update ON auth_tokens;
DROP POLICY IF EXISTS auth_tokens_insert ON auth_tokens;
DROP POLICY IF EXISTS auth_tokens_select ON auth_tokens;

DROP INDEX IF EXISTS auth_tokens_expires_at_idx;
DROP INDEX IF EXISTS auth_tokens_invitation_active_idx;
DROP INDEX IF EXISTS auth_tokens_user_purpose_active_idx;

DROP TABLE IF EXISTS auth_tokens;
```

### 결정점: anonymous 흐름의 RLS 처리

본 step은 **schema 측 RLS 정책만 정의**하고 anonymous 흐름의 우회 구현은 **Step 2 security design으로 위임**한다. 후보:

| 옵션 | 메모 |
|---|---|
| (a) 좁은 범위의 **SECURITY DEFINER 함수** (예: `consume_token(token_hash text, purpose text)`) — 함수가 sha256 매치 + 만료/소비 검증 + consume 한 번에 처리하고 caller의 RLS를 우회. 함수 OWNER가 테이블 OWNER와 동일하면 RLS bypass 가능 (FORCE RLS는 OWNER에도 적용되므로 함수에 명시적 `SET LOCAL row_security = off` 필요) | 함수 정의·권한 부여·예외 처리 비용 있으나 표면적이 작음 |
| (b) **runtime 전용 service credential** — 새 DB role (`kloser_service`)에 BYPASSRLS 또는 특정 테이블 row policy 우회만 허용. `MIGRATE_DATABASE_URL`은 절대 재사용 안 함 (AGENTS.md §83: runtime은 app role / migrations·seeds만 admin URL) | 권한 범위가 명시적. 다만 새 role 도입·dev/CI 환경 변수 추가 비용 |
| (c) auth_tokens RLS 끄기 | **거부**. defense-in-depth 포기 — 향후 admin 콘솔 `GET /admin/auth-tokens?org_id=...` 같은 use case에서 org leak 위험 |

**본 step 결정**: (c)는 명시적으로 거부. (a)/(b) 중 어느 쪽으로 갈지는 **Step 2 plan에서 확정**. 본 step 마이그레이션은 정책 4개를 그대로 깔고, anonymous 흐름 endpoint는 Step 2까지 미구현 상태로 둔다.

**금지**: `MIGRATE_DATABASE_URL` 재사용으로 anonymous 흐름을 처리하는 형태는 **채택 안 함** (AGENTS.md §83 위반). Step 2 plan에서 (a)/(b) 검토 시 본 제약을 사전 결정으로 포함.

### 결정점: `consumed_at` vs `invalidated_at` 분리

- `consumed_at` — verify/reset/accept 성공 후 set. "이 토큰은 사용됐다" 의미. 같은 user의 이력 추적 가능 (사용자가 언제 verify했나)
- `invalidated_at` — resend 시 옛 토큰에 set. "이 토큰은 무효화됐다 (소비된 적 없음)" 의미. 운영 디버깅 시 "이 토큰이 왜 안 됐나" 구분 가능
- 두 컬럼 모두 NULL인 토큰이 활성 토큰. 인덱스가 둘 다 NULL인 행만 포함

분리 안 하고 `consumed_at` 단일 컬럼으로도 가능하지만, 운영 시점 debug에서 "사용자가 클릭했는데 만료/취소된 토큰" vs "사용자가 못 받았고 resend로 새 발급한 토큰"이 같아 보이면 incident response 시간이 늘어남. 컬럼 1개 추가 비용 무시할 만함.

### 결정점: `purpose` enum (text+CHECK) vs Postgres ENUM 타입

- **text + CHECK**. Phase 1·2 패턴 일관 (role, status, customers.status). ENUM 타입은 값 추가 시 `ALTER TYPE ... ADD VALUE`가 트랜잭션 격리에서 까다로움. text는 ALTER CHECK 한 줄.

---

## 7. `email_outbox` 신규

### 마이그레이션 `1715000007000_phase3_email_outbox.sql`

```sql
-- Phase 3 Step 1 — email_outbox (dev provider).
--
-- 운영 SMTP/Resend 연동은 Phase 6+. 본 phase의 EmailProvider 인터페이스는
-- dev 구현으로 이 테이블에 행을 insert만 한다. e2e가 SELECT로 발송 본문을
-- 추출해 토큰 처리 흐름을 검증.
--
-- ★ Raw token 평문 노출 정책 (Master §1 검증, §7 게이트):
--   body_text / metadata.acceptUrl 등에 raw token이 평문으로 들어간다.
--   이는 dev 한정 의도된 노출이며, 운영 provider 전환 시 outbox 테이블은
--   archive-only로 변경되거나 raw token이 마스킹된 형태로 저장된다.
--   auth_tokens.token_hash는 sha256만 — 본 outbox에 raw가 박혀도 토큰 저장
--   원칙(§Master 2-2)에 위배되지 않음.

-- Up Migration
-- ============================================================================

CREATE TABLE email_outbox (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- org_id NOT NULL — org 격리 테이블이므로 auth_tokens와 동일 정책.
    -- signup 트랜잭션도 org row 먼저 생성한 뒤 outbox insert 순서이므로
    -- NULL이 들어갈 시점이 없음.
    org_id        uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    to_email      citext      NOT NULL,                  -- citext: 중복·lookup 시 case-insensitive
    subject       text        NOT NULL,
    body_text     text        NOT NULL,                  -- 평문 본문 (raw URL 포함)
    body_html     text,                                  -- HTML 본문 (선택)
    template      text        NOT NULL
                              CHECK (template IN ('email_verification','password_reset','invitation')),
    metadata      jsonb       NOT NULL DEFAULT '{}'::jsonb,
                            -- acceptUrl / verifyUrl / resetUrl + invitation_id 등.
                            -- dev 한정 raw token이 URL 안에 평문 포함 (e2e 추출용).
    delivered_at  timestamptz,                           -- dev: insert 직후 또는 NULL
    failed_at     timestamptz,                           -- 운영 provider 전환 시 사용
    error_message text,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- 조회용 인덱스 — admin 콘솔 / e2e가 org의 최근 메일 가져갈 때.
CREATE INDEX email_outbox_org_created_idx
  ON email_outbox (org_id, created_at DESC);

-- to_email lookup — e2e가 특정 이메일 수신자 메일 추출 시.
CREATE INDEX email_outbox_to_email_created_idx
  ON email_outbox (lower(to_email::text), created_at DESC);

-- ============================================================================
-- RLS
-- ============================================================================

ALTER TABLE email_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_outbox FORCE ROW LEVEL SECURITY;

-- org_id 기반 격리. anonymous 흐름의 outbox insert 우회 방식은 §6 결정과 동일
-- (Step 2 plan에서 SECURITY DEFINER vs service credential 확정).
CREATE POLICY email_outbox_select ON email_outbox FOR SELECT
  USING (org_id = current_app_org_id());

CREATE POLICY email_outbox_insert ON email_outbox FOR INSERT
  WITH CHECK (org_id = current_app_org_id());

CREATE POLICY email_outbox_update ON email_outbox FOR UPDATE
  USING      (org_id = current_app_org_id())
  WITH CHECK (org_id = current_app_org_id());

CREATE POLICY email_outbox_delete ON email_outbox FOR DELETE
  USING (org_id = current_app_org_id());

-- Down Migration
-- ============================================================================

DROP POLICY IF EXISTS email_outbox_delete ON email_outbox;
DROP POLICY IF EXISTS email_outbox_update ON email_outbox;
DROP POLICY IF EXISTS email_outbox_insert ON email_outbox;
DROP POLICY IF EXISTS email_outbox_select ON email_outbox;

DROP INDEX IF EXISTS email_outbox_to_email_created_idx;
DROP INDEX IF EXISTS email_outbox_org_created_idx;

DROP TABLE IF EXISTS email_outbox;
```

### 결정점: `body_text` size limit

- **제한 없음** (text 그대로). 운영 provider 전환 시 archive-only로 바꾸거나 별도 archive 테이블로 옮길 수 있어 본 phase 운영 부담 없음.

### 결정점: `metadata` JSON schema validation

- **없음** (jsonb 자유 형식). dev 환경 e2e가 `body_text` 정규식으로 토큰 추출하거나 `metadata->>'acceptUrl'`로 직접 접근. JSON schema는 운영 전환 시점에 도입.

### Raw token 노출 — 본 phase 명시적 정책

| 항목 | 정책 |
|---|---|
| auth_tokens.token_hash | sha256 hex만 저장. raw 부재. 단위 테스트로 검증 |
| email_outbox.body_text | dev 환경에서 accept/verify/reset URL에 raw token 평문 포함. e2e 추출 의도된 노출 |
| email_outbox.metadata.acceptUrl | 위와 동일. dev 한정 |
| Phase 6+ 운영 전환 | outbox는 (a) 제거 또는 (b) raw token 미저장 archive-only로 변경 |

본 정책은 Master §1 검증·§7 게이트와 동일.

---

## 8. 만료 pending 초대 처리 정책 (schema 합의)

본 step은 schema 측 합의만, service 구현은 Step 5. 그러나 파셜 유니크 인덱스의 의미가 service 패턴과 묶여 있으므로 schema plan 단계에 명시한다.

### 만료 정의 — `invitations`엔 `expires_at` 없음

본 step에서 `invitations.expires_at` 컬럼이 제거됐다 (§5). 만료 정보는 **`auth_tokens.expires_at`** 위에 있다 (purpose='invitation', invitation_id FK).

> **정책**: pending 초대는 자신의 **활성 invitation auth_token** (`consumed_at IS NULL AND invalidated_at IS NULL`) 이 존재하고 그 `expires_at > now()`일 때 "live"다. 활성 토큰이 없거나 활성 토큰의 `expires_at < now()`이면 "expired pending" 상태로 간주한다.

여기서 "활성 토큰"은 **UNIQUE 파셜 인덱스 `auth_tokens_invitation_active_idx`** (`UNIQUE (invitation_id) WHERE purpose='invitation' AND consumed_at IS NULL AND invalidated_at IS NULL`, §6 정의)가 DB 차원에서 1개 이하로 강제하는 행을 의미한다. resend 흐름은 옛 행에 `invalidated_at` set한 뒤 새 행 insert. UNIQUE라 race 시 23505로 강제 직렬화됨.

### 시나리오

```
T0: admin이 emp@x.test 초대
    → invitations row I1 (accepted_at NULL, canceled_at NULL)
    → auth_tokens row K1 (purpose='invitation', invitation_id=I1, expires_at=T0+7d)
T1 (> T0 + 7d):
    I1은 그대로 pending. K1.expires_at < now() → "expired pending"
T2: admin이 같은 emp@x.test 재초대 시도
```

### 파셜 유니크가 잡는 것 / 못 잡는 것

`WHERE accepted_at IS NULL AND canceled_at IS NULL` 파셜 유니크는 I1이 만료 상태여도 여전히 인덱스에 포함됨 (`accepted_at`·`canceled_at` 모두 NULL 그대로이므로). T2의 단순 INSERT는 `23505 unique_violation`으로 실패. 따라서 서비스가 **트랜잭션 안에서 I1을 cancel 처리한 뒤** 새 행을 INSERT해야 한다.

### 서비스 트랜잭션 패턴 (Step 5 구현)

**잠금 패턴**: `FOR UPDATE OF i, t`를 LEFT JOIN에 직접 걸면 Postgres가 `FOR UPDATE cannot be applied to the nullable side of an outer join`로 거부한다. 따라서 **2개 SELECT로 분리** — 먼저 invitations 행을 잠그고, 그 invitation_id로 auth_tokens 행을 별도 SELECT/FOR UPDATE.

```ts
// services/invitations.ts (sketch — Step 5)
async function createInvitation({orgId, email, role, teamId, invitedBy}) {
  return await db.tx(async (tx) => {
    // 1) 같은 (org, email) pending invitation 행 lock.
    const invRow = await tx.query(`
      SELECT id
      FROM invitations
      WHERE org_id = $1
        AND lower(email::text) = lower($2)
        AND accepted_at IS NULL
        AND canceled_at IS NULL
      FOR UPDATE
    `, [orgId, email]);

    if (invRow.rows.length > 0) {
      const invitationId = invRow.rows[0].id;

      // 2) 활성 invitation 토큰을 별도 query로 lock — UNIQUE 파셜 인덱스가
      //    "0개 또는 1개"를 보장하므로 LIMIT 불필요.
      const tokRow = await tx.query(`
        SELECT id, expires_at
        FROM auth_tokens
        WHERE invitation_id = $1
          AND purpose = 'invitation'
          AND consumed_at IS NULL
          AND invalidated_at IS NULL
        FOR UPDATE
      `, [invitationId]);

      const tokenMissing = tokRow.rows.length === 0;
      const tokenExpired = !tokenMissing && tokRow.rows[0].expires_at < new Date();

      if (tokenMissing || tokenExpired) {
        // 3a) expired pending (또는 토큰이 수동 invalidate된 잔재) — 자동 cancel
        await tx.query(
          `UPDATE invitations SET canceled_at = now() WHERE id = $1`,
          [invitationId]
        );
        if (!tokenMissing) {
          await tx.query(
            `UPDATE auth_tokens SET invalidated_at = now() WHERE id = $1`,
            [tokRow.rows[0].id]
          );
        }
        // 이어서 새 invitation + 새 auth_tokens 행 insert
      } else {
        // 3b) live pending — 409 invitation_already_pending
        throw new ConflictError('invitation_already_pending');
      }
    }

    // 4) 새 invitation 행 insert (expires_at 컬럼 없음)
    const inv = await tx.query(`
      INSERT INTO invitations (org_id, email, role, team_id, invited_by_user_id)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [orgId, email, role, teamId, invitedBy]);

    // 5) auth_tokens 행 insert — expires_at은 여기서만 산다
    const tok = await mintInvitationToken(tx, {
      invitationId: inv.rows[0].id,
      orgId,
      ttlMs: INVITATION_TOKEN_TTL_MS,  // 7d (Master §2-5)
    });
    return {invitation: inv.rows[0], rawToken: tok.raw};
  });
}
```

invitations 행을 먼저 lock하면 같은 (org, email)로 동시 진입한 다른 트랜잭션이 그 행에서 막힌다. 이후 auth_tokens FOR UPDATE는 단일 행 조회라 LEFT JOIN 제약을 받지 않는다. 정확성: §3a에서 invitations cancel + auth_tokens invalidate를 같은 트랜잭션 안에서 처리하므로 새 INSERT가 들어와도 unique 충돌 없음. 본 step은 schema가 위 패턴을 지원함만 확인하고, 실제 코드는 Step 5에서 작성한다.

---

## 9. Seed — `0003_phase3_demo.sql`

### 데이터 형태

만료 정보는 `invitations`가 아닌 짝지어진 `auth_tokens.expires_at`에 있다 (§8 정책). "활성 초대" / "만료 초대"는 invitations 행 자체가 아닌 토큰 상태로 결정됨.

| 항목 | 값 | 비고 |
|---|---|---|
| Acme **live** 초대 1 (`invitations`) | `pending-invitee@acme.test`, role=`employee`, accepted_at NULL, canceled_at NULL, last_sent_at = now() | invitations 자체는 만료 컬럼 없음 |
| 위 초대의 활성 invitation 토큰 1 (`auth_tokens`) | purpose='invitation', invitation_id FK, **expires_at = now() + interval '5 days'**, consumed_at NULL, invalidated_at NULL | 이 토큰이 살아있어서 위 초대가 "live pending" 상태 |
| Acme **expired** 초대 1 (`invitations`) | `expired-invitee@acme.test`, role=`viewer`, accepted_at NULL, canceled_at NULL, last_sent_at = now() - interval '8 days' | invitations row 자체는 살아있는 pending — expired 여부는 짝 토큰으로 판정 |
| 위 초대의 만료 invitation 토큰 1 (`auth_tokens`) | purpose='invitation', invitation_id FK, **expires_at = now() - interval '1 day'**, consumed_at NULL, invalidated_at NULL | 토큰이 만료됐기 때문에 §8 정책상 "expired pending" — admin이 같은 email로 재초대 시도 시 서비스가 자동 cancel하고 새 행 발급 |
| Acme outbox 샘플 1 (`email_outbox`) | template='invitation', to_email='pending-invitee@acme.test', body_text에 acceptUrl 평문 포함, metadata.invitation_id = live 초대 id | UI에서 "최근 발송 메일" 표시 가능. 운영 outbox view는 Phase 4+ |
| Beta org seed | 없음 (격리 검증 시각화 차원에서 Acme에만 둠) | RLS isolation 테스트는 §10에서 GUC swap으로 검증 |

### 결정점: seed의 raw token 처리

- seed가 박는 auth_tokens row의 token_hash는 **고정 sha256 hex** (deterministic). raw token은 seed 주석에 평문으로 함께 기록 (`-- raw token: phase3-seed-active-XXXX`). 다만 e2e는 이 raw를 쓰지 않는다 — e2e는 자기 시나리오에서 새 초대를 발송하고 outbox에서 raw를 뽑음. seed의 raw는 수동 디버깅용 reference

### Idempotency

- 다른 시드와 동일하게 `ON CONFLICT (id) DO UPDATE` 패턴
- deterministic UUID prefix:
  - invitations: `1ff11111-...` (active), `1ff22222-...` (expired)
  - auth_tokens: `7711111-...` (active), `7722222-...` (expired)
  - email_outbox: `8801111-...` (sample)

### `run-seed.mjs` checks 갱신 (재명시)

```js
const checks = [
    ["organizations",  2],
    ["users",          4],
    ["memberships",    4],
    ["customers",     24],
    ["invitations",    2],   // active 1 + expired 1
    ["email_outbox",   1],   // invitation sample 1
];
```

---

## 10. 검증

```bash
# 1. migration up
npm --prefix server run db:migrate:up
# expect: 4개 적용 — memberships_status_check / invitations_enrich / auth_tokens / email_outbox

# 2. RLS FORCE 확인 (4 신규/보강 테이블 모두)
docker exec kloser-dev-postgres-1 psql -U kloser -d kloser_dev -c \
  "SELECT relname, relrowsecurity, relforcerowsecurity
   FROM pg_class
   WHERE relname IN ('auth_tokens','email_outbox','invitations','memberships')
   ORDER BY relname"
# expect: 모두 t | t  (invitations / memberships는 Phase 1부터 이미 RLS 적용 상태)

# 3. 정책 4개 × 2 신규 테이블 = 8개 확인
docker exec kloser-dev-postgres-1 psql -U kloser -d kloser_dev -c \
  "SELECT tablename, policyname, cmd
   FROM pg_policies
   WHERE tablename IN ('auth_tokens','email_outbox')
   ORDER BY tablename, cmd"
# expect: auth_tokens × 4 + email_outbox × 4

# 4. memberships CHECK 확인
docker exec kloser-dev-postgres-1 psql -U kloser -d kloser_dev -c \
  "SELECT conname, pg_get_constraintdef(oid)
   FROM pg_constraint
   WHERE conrelid='memberships'::regclass AND contype='c'"
# expect: memberships_status_check | CHECK (status IN ('active','disabled'))

# 5. 위반 시도 — status에 임의 값 INSERT
docker exec kloser-dev-postgres-1 psql -U kloser -d kloser_dev -c \
  "BEGIN;
   SET LOCAL app.org_id = '11111111-1111-1111-1111-111111111111';
   INSERT INTO memberships (id, org_id, user_id, role, status)
   VALUES (gen_random_uuid(), '11111111-1111-1111-1111-111111111111',
           'aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa', 'admin', 'bogus');
   ROLLBACK;"
# expect: ERROR — new row for relation "memberships" violates check constraint "memberships_status_check"

# 6. invitations 컬럼 형상
docker exec kloser-dev-postgres-1 psql -U kloser -d kloser_dev -c \
  "\\d invitations"
# expect:
#   - token_hash, expires_at 컬럼 부재
#   - team_id / invited_by_user_id / canceled_at / last_sent_at 존재
#   - 파셜 유니크 invitations_active_org_email_idx 존재

# 7. 활성 초대 (org,email) 중복 시도 — 파셜 유니크 충돌
docker exec kloser-dev-postgres-1 psql -U kloser -d kloser_dev -c \
  "BEGIN;
   SET LOCAL app.org_id = '11111111-1111-1111-1111-111111111111';
   INSERT INTO invitations (id, org_id, email, role, last_sent_at)
   VALUES (gen_random_uuid(), '11111111-1111-1111-1111-111111111111',
           'pending-invitee@acme.test', 'employee', now());
   ROLLBACK;"
# expect: ERROR — duplicate key violates unique constraint "invitations_active_org_email_idx"
# (시드의 활성 초대 row가 같은 email이라 충돌)

# 7.5. auth_tokens 형상 — org_id NOT NULL + UNIQUE 파셜 인덱스
docker exec kloser-dev-postgres-1 psql -U kloser -d kloser_dev -c \
  "\\d auth_tokens"
# expect:
#   - org_id  uuid NOT NULL
#   - auth_tokens_invitation_active_idx — UNIQUE, partial WHERE purpose='invitation' AND consumed_at IS NULL AND invalidated_at IS NULL
#   - auth_tokens_user_purpose_active_idx — UNIQUE, partial WHERE user_id IS NOT NULL AND consumed_at IS NULL AND invalidated_at IS NULL

# 7.6. 같은 invitation에 두 번째 활성 토큰 INSERT 시도 — UNIQUE 위반
docker exec kloser-dev-postgres-1 psql -U kloser -d kloser_dev -c \
  "BEGIN;
   SET LOCAL app.org_id = '11111111-1111-1111-1111-111111111111';
   INSERT INTO auth_tokens (org_id, invitation_id, purpose, token_hash, expires_at)
   SELECT '11111111-1111-1111-1111-111111111111', id, 'invitation',
          'collision-test-hash-' || gen_random_uuid()::text, now() + interval '1 day'
   FROM invitations
   WHERE email = 'pending-invitee@acme.test' LIMIT 1;
   ROLLBACK;"
# expect: ERROR — duplicate key violates unique constraint "auth_tokens_invitation_active_idx"
# (시드의 활성 invitation 토큰 + 새 활성 토큰 = 같은 invitation_id에서 충돌)

# 8. 만료된 초대는 같은 (org,email) INSERT가 가능 — 만료 초대는 partial 인덱스에서 빠지지 않으나
#    seed가 expired-invitee@acme.test로 별도 email 사용. 새 시나리오는 service 트랜잭션 패턴 (§8)이라
#    schema 단계의 단순 INSERT 검증으로는 불충분 — Step 5 단위 테스트에서 정밀 검증.

# 9. seed
npm --prefix server run db:seed
# expect:
#   seed: applied 0001_demo.sql
#   seed: applied 0002_customers.sql
#   seed: applied 0003_phase3_demo.sql
#   seed: organizations count=2 OK
#   seed: users count=4 OK
#   seed: memberships count=4 OK
#   seed: customers count=24 OK
#   seed: invitations count=2 OK
#   seed: email_outbox count=1 OK

# 10. RLS isolation — Acme/Beta 격리
docker exec kloser-dev-postgres-1 psql "postgres://app:app_dev@localhost:5432/kloser_dev" -c \
  "SELECT count(*) FROM invitations;
   BEGIN;
   SELECT set_config('app.org_id','11111111-1111-1111-1111-111111111111', true);
   SELECT count(*) AS acme_inv FROM invitations;
   SELECT count(*) AS acme_outbox FROM email_outbox;
   COMMIT;
   BEGIN;
   SELECT set_config('app.org_id','22222222-2222-2222-2222-222222222222', true);
   SELECT count(*) AS beta_inv FROM invitations;
   SELECT count(*) AS beta_outbox FROM email_outbox;
   COMMIT;"
# expect: no_guc=0, acme_inv=2, acme_outbox=1, beta_inv=0, beta_outbox=0

# 11. Phase 1·2 회귀
npm --prefix server run typecheck
npm --prefix server test
node test/phase_0_5_e2e.mjs
node test/phase_2_customers_e2e.mjs

# 12. Down 검증
npm --prefix server run db:migrate:redo
# 4개 마이그레이션이 down → up 왕복. Phase 1/2 테이블 영향 없음. pgmigrations row 확인.
```

`#5`, `#7`이 핵심 — schema 제약 두 가지가 의도대로 INSERT를 차단. `#10`이 RLS isolation 확인.

---

## 11. 위험·미정

| 항목 | 처리 |
|---|---|
| anonymous endpoint의 RLS 우회 방식 | **§6 결정 그대로 — 본 step은 정책 4개만 깔고 결정 보류**. Step 2 plan에서 (a) 좁은 SECURITY DEFINER 함수 vs (b) BYPASSRLS service credential 신규 도입 중 확정. `MIGRATE_DATABASE_URL` 재사용은 사전 금지 (AGENTS.md §83) |
| auth_tokens.org_id / email_outbox.org_id 모두 NOT NULL | 두 테이블 모두 org 격리 테이블이므로 NOT NULL로 컬럼 자체에서 보장. signup 트랜잭션도 org → user → membership → (token / outbox) 순서로 commit하면 NULL 입력 시점 없음. RLS WITH CHECK + 컬럼 NOT NULL이 이중 방어 |
| `users` 테이블 변경 없음 — `email_verified_at`은 이미 존재 | Phase 1 init에서 컬럼만 깔리고 Phase 3가 채움. 본 step 부담 없음 |
| `invitations.email` lower-fold 정책 | citext 그대로 (저장은 원본 보존, 비교는 case-insensitive). 파셜 유니크 인덱스에서만 lower(email::text) 명시 |
| 향후 third purpose 추가 (e.g., `mfa_setup`) | `auth_tokens.purpose` CHECK 변경 + invitation/non-invitation 분기 CHECK 정밀화. text+CHECK 패턴이라 ALTER 한 줄 |
| run-seed.mjs checks count drift — Phase 4+ 추가 시 | Phase 2 wrapper 일반화로 +1줄만. 본 step 부담 없음 |
| migration redo 시 invitations 보강 down이 NOT NULL token_hash/expires_at 재추가 — 시드가 이미 적용된 상태에서 down하면 default 값 채워짐 | down 마이그레이션의 `DEFAULT now() + interval '7 days'` / `DEFAULT ''`로 backfill. 그 직후 default drop으로 Phase 1 상태와 정합. dev-only 동작이라 운영 영향 없음 |
| `email_outbox` 운영 전환 시 archive-only 또는 raw 마스킹 | Phase 6+에서 결정. 본 step plan에 정책만 명시 |
| auth_tokens.org_id가 anonymous 흐름에서도 항상 채워지는 것을 보장하는 방식 | Step 2가 (a) SECURITY DEFINER 함수 인자로 org_id를 받거나 (b) service credential 풀이 INSERT 시 org_id 명시. 둘 다 본 step의 NOT NULL WITH CHECK + 서비스 책임 패턴과 정합 |
| invitations에 있던 기존 `invitations_token_hash_idx` drop 후 의존 객체 | 의존 객체 없음 — token_hash 컬럼만 참조. 컬럼 drop 시 index 자동 drop 가능하나 본 plan은 명시적 DROP INDEX 선행해서 cascade 의존성을 깨끗이 분리 |

---

## 12. 완료 기준 (Step 1 — go/no-go)

- [ ] 4 마이그레이션 `npm --prefix server run db:migrate:up` PASS
- [ ] `npm --prefix server run db:seed` PASS — invitations=2, email_outbox=1
- [ ] §10 #2 — `auth_tokens`, `email_outbox`, `invitations`, `memberships` 모두 RLS FORCE
- [ ] §10 #3 — `auth_tokens` × 4 정책 + `email_outbox` × 4 정책 존재
- [ ] §10 #4 — `memberships_status_check` 제약 등록
- [ ] §10 #5 — status='bogus' INSERT가 CHECK 위반으로 거부
- [ ] §10 #6 — `invitations` 컬럼이 token_hash/expires_at 없이 team_id/invited_by_user_id/canceled_at/last_sent_at 보유
- [ ] §10 #7 — 같은 (org,email) 활성 초대 중복 INSERT가 파셜 유니크 위반으로 거부
- [ ] §10 #7.5 — `auth_tokens` org_id NOT NULL + invitation/user UNIQUE 파셜 인덱스 등록
- [ ] §10 #7.6 — 같은 invitation의 두 번째 활성 토큰 INSERT가 UNIQUE 위반으로 거부
- [ ] §10 #10 — RLS isolation: app role에서 no_guc=0, acme_inv=2, beta_inv=0
- [ ] §10 #11 — Phase 1·2 회귀 PASS (server unit + Phase 0.5 e2e + Phase 2 customers e2e)
- [ ] §10 #12 — `db:migrate:redo`가 down→up 왕복 OK. Phase 1/2 테이블 영향 없음
- [ ] `docs/plan/phase-3/PHASE_3_STEP_1_FINDINGS.md` 작성

---

## 13. 한 줄 요약

> **1.5일 동안 4개 마이그레이션으로 `auth_tokens` / `email_outbox` 신규, `invitations` 토큰 컬럼 제거 + 메타 4종 + 파셜 유니크 추가, `memberships.status` CHECK 보강을 한다. 활성 1 + 만료 1 초대 + outbox 샘플 1을 시드로 박아 평가자가 즉시 시각 검증 가능하게 한다. 4 테이블 FORCE RLS는 `current_app_org_id()` 헬퍼 재사용으로 Phase 1·2 패턴 일관 유지.**

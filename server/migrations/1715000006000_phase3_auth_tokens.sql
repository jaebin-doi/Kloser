-- Phase 3 Step 1 — auth_tokens 통합 표.
-- Plan: docs/plan/phase-3/PHASE_3_STEP_1_SCHEMA.md §6.
--
-- email_verification / password_reset / invitation 3 purpose의 sha256 hash
-- 토큰을 단일 표로 관리. 라이프사이클 (생성 → 발송 → 1회 소비 → 만료)이
-- 동일하므로 통합. invitation purpose만 invitation_id FK를 set하고, 나머지
-- 두 purpose는 user_id FK + org_id로 식별.
--
-- 익명 accept / verify / reset 흐름은 JWT 없이 진입하므로 app.org_id GUC가
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
    -- 서비스(SECURITY DEFINER든 service credential이든)가 INSERT 시 항상
    -- 채움. signup 트랜잭션도 org row 먼저 생성 후 token insert 순서라 NULL
    -- 입력 시점이 없음.
    org_id          uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

    -- invitation purpose는 user 가입 전이라 user_id NULL. 나머지는 NOT NULL
    -- (purpose CHECK가 강제).
    user_id         uuid        REFERENCES users(id) ON DELETE CASCADE,

    -- purpose='invitation'에만 set.
    invitation_id   uuid        REFERENCES invitations(id) ON DELETE CASCADE,

    purpose         text        NOT NULL
                              CHECK (purpose IN ('email_verification','password_reset','invitation')),

    -- sha256 hex (64자). 원문은 발송 시점 메모리에만 존재.
    token_hash      text        NOT NULL UNIQUE,

    expires_at      timestamptz NOT NULL,

    -- 1회 소비 시점 (verify·reset·accept 직후 set).
    consumed_at     timestamptz,

    -- resend 시 옛 토큰 무효화 marker. consumed_at과 분리해 운영 디버깅 시
    -- "사용자가 클릭한 토큰"과 "resend로 갈아치워진 토큰"을 구분.
    invalidated_at  timestamptz,

    created_at      timestamptz NOT NULL DEFAULT now(),

    -- purpose별 외래 키 정합 — invitation purpose만 invitation_id를 가짐.
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
-- plan §8 정책 "활성 invitation 토큰 1개 이하"를 DB 차원에서 보장.
-- resend가 옛 토큰을 invalidated_at 처리한 뒤 새 행 insert (Step 5).
CREATE UNIQUE INDEX auth_tokens_invitation_active_idx
  ON auth_tokens (invitation_id)
  WHERE purpose = 'invitation'
    AND consumed_at IS NULL
    AND invalidated_at IS NULL;

-- token_hash는 UNIQUE 제약이라 별도 인덱스 불필요 (UNIQUE가 자동 인덱스 생성).

-- 만료 cleanup 후보 lookup — 운영 위생 Phase 6+. 본 step에서는 인덱스만.
CREATE INDEX auth_tokens_expires_at_idx
  ON auth_tokens (expires_at)
  WHERE consumed_at IS NULL AND invalidated_at IS NULL;

-- ============================================================================
-- RLS
-- ============================================================================

ALTER TABLE auth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_tokens FORCE ROW LEVEL SECURITY;

-- org_id 기반 격리. anonymous 흐름의 우회 방식은 Step 2에서 확정 (plan §6).
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

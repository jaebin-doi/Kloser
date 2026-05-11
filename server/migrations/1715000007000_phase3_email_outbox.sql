-- Phase 3 Step 1 — email_outbox (dev provider).
-- Plan: docs/plan/phase-3/PHASE_3_STEP_1_SCHEMA.md §7.
--
-- 운영 SMTP/Resend 연동은 Phase 6+. 본 phase의 EmailProvider 인터페이스 (Step 2)는
-- dev 구현으로 이 테이블에 행을 insert만 한다. e2e가 SELECT로 발송 본문을
-- 추출해 토큰 처리 흐름을 검증.
--
-- ★ Raw token 평문 노출 정책 (plan §1 검증, Master §7 게이트):
--   body_text / metadata.acceptUrl 등에 raw token이 평문으로 들어간다.
--   이는 dev 한정 의도된 노출이며, 운영 provider 전환 시 outbox 테이블은
--   archive-only로 변경되거나 raw token이 마스킹된 형태로 저장된다.
--   auth_tokens.token_hash는 sha256만 — 본 outbox에 raw가 박혀도 토큰 저장
--   원칙(Master §2-2)에 위배되지 않음.

-- Up Migration
-- ============================================================================

CREATE TABLE email_outbox (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- org_id NOT NULL — org 격리 테이블이므로 auth_tokens와 동일 정책.
    -- signup 트랜잭션도 org row 먼저 생성한 뒤 outbox insert 순서라 NULL
    -- 입력 시점이 없음.
    org_id        uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

    -- citext: 중복·lookup 시 case-insensitive.
    to_email      citext      NOT NULL,

    subject       text        NOT NULL,

    -- 평문 본문. dev 한정 raw token이 URL 안에 평문 포함 (plan §7).
    body_text     text        NOT NULL,
    body_html     text,

    template      text        NOT NULL
                            CHECK (template IN ('email_verification','password_reset','invitation')),

    -- acceptUrl / verifyUrl / resetUrl + invitation_id 등. dev 한정
    -- raw token이 URL 안에 평문 포함 (e2e 추출용).
    metadata      jsonb       NOT NULL DEFAULT '{}'::jsonb,

    -- dev: insert 직후 또는 NULL. 운영 provider 전환 시 점진 채움.
    delivered_at  timestamptz,
    failed_at     timestamptz,
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

-- org_id 기반 격리. anonymous 흐름의 outbox insert 우회 방식은
-- auth_tokens와 동일 — Step 2 plan에서 SECURITY DEFINER vs service credential
-- 확정.
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

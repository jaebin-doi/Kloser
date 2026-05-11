-- Phase 3 Step 1 — memberships.status CHECK 제약 + 활성 멤버 partial index.
-- Plan: docs/plan/phase-3/PHASE_3_STEP_1_SCHEMA.md §4.
--
-- Phase 1 init schema에서 memberships.status는 text NOT NULL DEFAULT 'active'로
-- 깔렸으나 CHECK이 없어 어떤 문자열도 허용됐다. Phase 3는 per-org disable 전환을
-- 도입하므로 ('active','disabled') 두 값만 허용하도록 좁힌다.
--
-- 현재 시드 행은 모두 default 'active' → backfill 불필요. 운영 데이터 0건.

-- Up Migration
-- ============================================================================

ALTER TABLE memberships
  ADD CONSTRAINT memberships_status_check
  CHECK (status IN ('active','disabled'));

-- 활성 멤버 빠른 lookup용 partial index — 마지막 admin 보호 (Master §2-12)와
-- 로그인 시 활성 membership 존재 검증 (Step 4)에 모두 사용됨.
CREATE INDEX memberships_org_role_active_idx
  ON memberships (org_id, role)
  WHERE status = 'active';


-- Down Migration
-- ============================================================================

DROP INDEX IF EXISTS memberships_org_role_active_idx;
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_status_check;

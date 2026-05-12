-- Phase 5 Step 1 — current_app_user_id() helper + app.user_id GUC.
-- Plan: docs/plan/phase-5/PHASE_5_STEP_1_SCHEMA.md §2.8, §10.
-- Master: §1, §2 결정 16, 17.
--
-- Phase 5는 manager team-scope ("자기 팀 통화만 변경") 권한을 service layer에서
-- 처리한다 (RLS 추가 정책 없음). 그러려면 service의 권한 helper가 SQL 안에서
-- "지금 누가 호출했는가"를 알아야 하고, 이를 위해 current_app_user_id()를
-- 도입한다.
--
-- 패턴은 기존 current_app_org_id()와 동일:
--   - app.user_id GUC를 SET LOCAL로 트랜잭션 안에서 set
--   - helper는 NULLIF + cast로 미설정/빈 값을 NULL로 흘려보내 0 row 반환
--
-- 본 migration은 helper function만 신설한다. withOrgContext plugin이 app.user_id를
-- set하도록 갱신하는 작업은 Step 2의 service layer 변경 (코드 layer).
--
-- 본 step은 RLS 정책에 current_app_user_id()를 *사용하지 않는다*. 정책은
-- Phase 4 4종 그대로 유지 — manager team-scope을 RLS로 깔지 않는 §2.8 결정.

-- Up Migration
-- ============================================================================

CREATE OR REPLACE FUNCTION current_app_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;


-- Down Migration
-- ============================================================================

DROP FUNCTION IF EXISTS current_app_user_id();

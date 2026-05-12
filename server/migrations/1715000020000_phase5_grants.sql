-- Phase 5 Step 1 — app role grants for Phase 5 new tables.
-- Plan: docs/plan/phase-5/PHASE_5_STEP_1_SCHEMA.md §12.
-- Master: docs/plan/phase-5/PHASE_5_MASTER.md §1 (schema list).
--
-- Phase 4와 동일 패턴 — 신규 5 테이블에 app role의 CRUD grant 부여.
-- dev init script가 default privilege를 set하지만 명시적 migration으로
-- 계약을 자체 보유한다 (idempotent).
--
-- kloser_service (BYPASSRLS service role)에는 본 migration에서 grant 추가 0건.
-- Phase 5 신규 테이블은 anonymous 흐름이 없으므로 (인증된 사용자 + admin 전용
-- 마스터 관리 + AI 워커는 app role + GUC 컨텍스트로 동작) service role 사용
-- 안 함. Phase 4 §residual 결정 일관.

-- Up Migration
-- ============================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_bases              TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_chunks             TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON org_call_checklist_templates TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON call_checklist_items         TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON call_suggestions             TO app;


-- Down Migration
-- ============================================================================

REVOKE SELECT, INSERT, UPDATE, DELETE ON call_suggestions             FROM app;
REVOKE SELECT, INSERT, UPDATE, DELETE ON call_checklist_items         FROM app;
REVOKE SELECT, INSERT, UPDATE, DELETE ON org_call_checklist_templates FROM app;
REVOKE SELECT, INSERT, UPDATE, DELETE ON knowledge_chunks             FROM app;
REVOKE SELECT, INSERT, UPDATE, DELETE ON knowledge_bases              FROM app;

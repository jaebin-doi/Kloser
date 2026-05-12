-- Phase 4 Step 1 — app role grants for calls persistence tables.
-- Plan: docs/plan/phase-4/PHASE_4_STEP_1_SCHEMA.md §7.
--
-- The dev init script sets default privileges for future tables, but this
-- explicit migration keeps the permission contract self-contained and
-- idempotent for existing databases whose default privileges may predate
-- Phase 4.

-- Up Migration
-- ============================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON calls             TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON transcripts       TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON call_action_items TO app;


-- Down Migration
-- ============================================================================

REVOKE SELECT, INSERT, UPDATE, DELETE ON call_action_items FROM app;
REVOKE SELECT, INSERT, UPDATE, DELETE ON transcripts       FROM app;
REVOKE SELECT, INSERT, UPDATE, DELETE ON calls             FROM app;

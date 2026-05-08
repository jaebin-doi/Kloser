-- Phase 2 Step 1 — customers table.
--
-- First business entity beyond the auth/membership scaffolding from Phase 1.
-- Plan: docs/plan/phase-2/PHASE_2_STEP_1_SCHEMA.md.
--
-- Highlights:
--   - FORCE ROW LEVEL SECURITY with four policies built on the
--     current_app_org_id() helper from 1715000000000_init.sql §148.
--   - Six partial indexes, all WHERE deleted_at IS NULL, so a soft-deleted
--     row never costs a normal SELECT/UPDATE/DELETE.
--   - text + CHECK enums for status (active/review/pending) and plan
--     (Starter/Pro/Enterprise + NULL = unassigned). Mirrors mock UI.
--   - Common touch_updated_at() trigger function introduced here. Phase 4+
--     entities will reuse it — see Down section for the function-drop
--     hand-off rule.

-- Up Migration
-- ============================================================================

CREATE TABLE customers (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

    -- profile
    name                text        NOT NULL,
    company             text,
    email               citext,
    phone               text,

    -- classification
    status              text        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('active', 'review', 'pending')),
    plan                text
                            CHECK (plan IS NULL OR plan IN ('Starter', 'Pro', 'Enterprise')),

    -- relations
    assigned_user_id    uuid        REFERENCES users(id) ON DELETE SET NULL,

    -- timestamps
    last_contacted_at   timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    deleted_at          timestamptz
);

-- Common touch trigger function — sets NEW.updated_at = now() on every UPDATE.
-- Reused by Phase 4+ entities. CREATE OR REPLACE makes it idempotent if the
-- function already exists (e.g., a future entity migration that adds it
-- before this customers migration on a fresh checkout — unlikely but cheap).
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER customers_touch_updated_at
    BEFORE UPDATE ON customers
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Indexes — all partial (`WHERE deleted_at IS NULL`) so soft-deleted rows
-- don't bloat the trees and don't appear in normal scans.
CREATE INDEX customers_org_status_idx
    ON customers (org_id, status)
    WHERE deleted_at IS NULL;

CREATE INDEX customers_org_plan_idx
    ON customers (org_id, plan)
    WHERE deleted_at IS NULL AND plan IS NOT NULL;

CREATE INDEX customers_org_assigned_idx
    ON customers (org_id, assigned_user_id)
    WHERE deleted_at IS NULL;

-- text_pattern_ops gives us prefix matching (`name ILIKE 'kim%'`) which is
-- what mock UI's search input does. Phase 5+ may add pg_trgm for true
-- substring search.
CREATE INDEX customers_org_lower_name_idx
    ON customers (org_id, lower(name) text_pattern_ops)
    WHERE deleted_at IS NULL;

CREATE INDEX customers_org_lower_email_idx
    ON customers (org_id, lower(email::text) text_pattern_ops)
    WHERE deleted_at IS NULL AND email IS NOT NULL;

CREATE INDEX customers_org_lower_company_idx
    ON customers (org_id, lower(company) text_pattern_ops)
    WHERE deleted_at IS NULL AND company IS NOT NULL;

-- RLS — same pattern as Phase 1 init.sql: ENABLE + FORCE so even the
-- table owner is subject to policies. Helper handles missing/blank GUC
-- safely (NULLIF + NULL cast tolerates NULL on policy check failure path).
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;

CREATE POLICY customers_select ON customers FOR SELECT
    USING (org_id = current_app_org_id());

CREATE POLICY customers_insert ON customers FOR INSERT
    WITH CHECK (org_id = current_app_org_id());

CREATE POLICY customers_update ON customers FOR UPDATE
    USING      (org_id = current_app_org_id())
    WITH CHECK (org_id = current_app_org_id());

-- DELETE policy is here for the day a hard-delete path is needed (Phase 4+
-- admin console / GDPR). The runtime soft-delete path uses UPDATE and
-- never hits this policy.
CREATE POLICY customers_delete ON customers FOR DELETE
    USING (org_id = current_app_org_id());


-- Down Migration
-- ============================================================================

DROP TRIGGER IF EXISTS customers_touch_updated_at ON customers;

-- Step 1 is the only entity using touch_updated_at() right now, so we drop
-- the function here. When Phase 4+ adds a second entity that shares this
-- function, that step's migration must do ONE of:
--
--   (A) Move touch_updated_at() into its own migration (e.g.,
--       1715000003000_touch_function.sql). The new migration owns the
--       function's lifecycle; this customers migration's down is then
--       reduced to dropping just the trigger.
--
--   (B) Remove the DROP FUNCTION line below and leave the function in
--       place permanently after first install.
--
-- Whichever is chosen, the change happens at the same time as the first
-- reuse — leaving this down as-is while another entity depends on the
-- function would silently break that entity's trigger when this migration
-- is rolled back.
DROP FUNCTION IF EXISTS touch_updated_at();

DROP POLICY IF EXISTS customers_delete ON customers;
DROP POLICY IF EXISTS customers_update ON customers;
DROP POLICY IF EXISTS customers_insert ON customers;
DROP POLICY IF EXISTS customers_select ON customers;

DROP TABLE IF EXISTS customers;

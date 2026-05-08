-- Phase 2 Step 5 followup — drop `customers.plan`.
--
-- Domain cleanup: `customers.plan` (Starter/Pro/Enterprise) collided
-- with `organizations.plan` (Kloser's own subscription tier). Two
-- semantically different concepts shared the same column name AND
-- value set inside the same database, which is a guaranteed source
-- of confusion as the schema grows.
--
-- Resolution: the customer's relationship to a Kloser subscription
-- plan is not a domain attribute — only the Kloser tenant org carries
-- a plan. Customer rows describe the tenant's leads/contacts; future
-- attributes like lifecycle stage will be added under their own
-- column/CHECK at a later phase.
--
-- Effect:
--   - DROP INDEX customers_org_plan_idx (depends on the plan column)
--   - ALTER TABLE customers DROP COLUMN plan (CHECK constraint
--     follows the column automatically — no separate DROP CONSTRAINT)
--
-- Order matters: indexes that reference the column must drop before
-- the column itself, otherwise PG returns "cannot drop column ...
-- because other objects depend on it" (without CASCADE). We avoid
-- CASCADE so any unexpected dependency (none on this branch) would
-- surface as an error rather than be silently dropped.

-- Up Migration
-- ============================================================================

DROP INDEX IF EXISTS customers_org_plan_idx;
ALTER TABLE customers DROP COLUMN IF EXISTS plan;


-- Down Migration
-- ============================================================================
--
-- Restoring the column re-adds the same definition the original
-- 1715000002000_customers.sql migration installed (text NULL with CHECK
-- on Starter/Pro/Enterprise, partial index keyed on org_id+plan).
-- Existing rows get NULL — historic plan values are not recoverable
-- from this migration alone (intentional: this is a domain decision,
-- not a reversible operational change).

ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS plan text
        CHECK (plan IS NULL OR plan IN ('Starter', 'Pro', 'Enterprise'));

CREATE INDEX IF NOT EXISTS customers_org_plan_idx
    ON customers (org_id, plan)
    WHERE deleted_at IS NULL AND plan IS NOT NULL;

-- Phase 7 Step 9 — billing / subscription caps schema.
--
-- Plan: docs/plan/phase-7/PHASE_7_STEP_9_PLAN.md §3, §4.
-- Master: docs/plan/phase-7/PHASE_7_MASTER.md §3 Step 5+.
--
-- Three surface changes:
--
--   1. organizations.plan CHECK
--      Lock the column to {starter, pro, enterprise}. Existing seed and
--      signup default ('starter') already match. This is the only plan
--      source-of-truth — `customers.plan` was never reintroduced and is
--      out of scope for Phase 7.
--
--   2. organization_billing_profiles table
--      Org-scoped 1:1 metadata table next to `organizations`. Stores
--      billing status / trial / current period / contact email / tax id
--      / opaque external provider ids. Plan itself stays on
--      organizations.plan so the source-of-truth doesn't fork.
--
--      RLS + FORCE RLS so the runtime app role sees only the current
--      org. DELETE is intentionally NOT granted: orgs are cascade-
--      removed via the FK only when the parent organization is deleted
--      (Phase 9+ topic). Billing rows live as long as the org row.
--
--   3. activity_log_action_check expansion
--      Add `billing.profile_updated` for admin profile patches. The DB
--      CHECK / repository union / route allow-list 3-way lockstep
--      (Step 3 plan §3.3) is renewed by DROP + ADD with the full
--      allow-list — Step 4's two retention actions are preserved.
--
-- Out of scope (per plan §2 "안 한다"):
--   - Stripe/Toss SDKs, webhooks, invoice tables.
--   - real payment ledger, tax invoice issuance.
--   - plan self-serve switch route.
--   - usage backfill worker.
--   - `customers.plan` reintroduction.

-- Up Migration
-- ============================================================================

-- (1) Plan CHECK — fail-fast if any seed/test row carries an unknown plan.
--     The repository workflow (AGENTS.md) requires migrations to refuse
--     silent value rewrites; this constraint is the boundary.
ALTER TABLE organizations
  ADD CONSTRAINT organizations_plan_check
    CHECK (plan IN ('starter', 'pro', 'enterprise'));


-- (2) Billing profile table.
CREATE TABLE organization_billing_profiles (
    org_id                   uuid        PRIMARY KEY
                                          REFERENCES organizations(id) ON DELETE CASCADE,

    -- Internal lifecycle. Real provider state will eventually mirror onto
    -- here but until then 'trialing' is the natural default for any newly
    -- onboarded org.
    billing_status           text        NOT NULL DEFAULT 'trialing'
                                          CHECK (billing_status IN ('trialing', 'active', 'past_due', 'canceled')),

    -- Contact / receipt destination. citext so the unique-ish email is
    -- compared case-insensitively when admins re-type it.
    billing_email            citext,

    -- Free-form tax registration id (사업자등록번호 / VAT ID / 등). 64 chars
    -- covers every published format. Treated as semi-sensitive — audit
    -- rows only echo `fields` keys, never the value.
    tax_id                   text,

    current_period_start     timestamptz,
    current_period_end       timestamptz,
    trial_ends_at            timestamptz,

    -- External provider metadata. NULL until a real Stripe/Toss
    -- integration ships. Never echoed to clients via /billing/overview.
    external_provider        text,
    external_customer_id     text,
    external_subscription_id text,

    -- Free-form provider sync metadata bag. Plan §4.3 leaves this
    -- intentionally vague so the eventual provider integration doesn't
    -- need another migration to start landing payloads.
    metadata                 jsonb       NOT NULL DEFAULT '{}'::jsonb,

    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX organization_billing_profiles_org_id_idx
  ON organization_billing_profiles (org_id);


-- RLS — org-scoped. Pattern matches email_outbox / customers / etc.
ALTER TABLE organization_billing_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_billing_profiles FORCE ROW LEVEL SECURITY;

CREATE POLICY organization_billing_profiles_select
  ON organization_billing_profiles FOR SELECT
  USING (org_id = current_app_org_id());

CREATE POLICY organization_billing_profiles_insert
  ON organization_billing_profiles FOR INSERT
  WITH CHECK (org_id = current_app_org_id());

CREATE POLICY organization_billing_profiles_update
  ON organization_billing_profiles FOR UPDATE
  USING      (org_id = current_app_org_id())
  WITH CHECK (org_id = current_app_org_id());

-- DELETE policy is intentionally NOT created. The grants below
-- mirror that — app role gets SELECT / INSERT / UPDATE only.


-- Grants — app role mirrors the policies. Migration role keeps full
-- access (it bypasses RLS).
GRANT SELECT, INSERT, UPDATE ON organization_billing_profiles TO app;


-- (3) Backfill — every existing org gets a default 'trialing' profile.
--     Future signups insert their profile inside the signup transaction
--     (Step 9 service layer) so this backfill catches only the pre-Step-9
--     orgs.
INSERT INTO organization_billing_profiles (org_id, billing_status)
SELECT id, 'trialing'
  FROM organizations
ON CONFLICT (org_id) DO NOTHING;


-- (4) activity_log_action_check — add `billing.profile_updated`.
--     Carries over Step 3 allow-list + Step 4 retention actions, plus
--     the new entry. DROP + ADD because PostgreSQL has no in-place
--     CHECK edit (same pattern as 1715000026000).
ALTER TABLE activity_log
  DROP CONSTRAINT IF EXISTS activity_log_action_check;

ALTER TABLE activity_log
  ADD CONSTRAINT activity_log_action_check
    CHECK (action IN (
      -- auth
      'auth.login',
      'auth.logout',
      'auth.refresh_mfa_required',
      'auth.password_reset_requested',
      'auth.password_reset_completed',
      'auth.email_verified',
      'auth.email_verification_resent',

      -- mfa
      'mfa.login_challenge_issued',
      'mfa.login_verified',
      'mfa.setup_started',
      'mfa.enabled',
      'mfa.disabled',
      'mfa.failed_attempt',
      'mfa.locked',

      -- organization
      'organization.mfa_required_enabled',
      'organization.mfa_required_disabled',

      -- membership
      'membership.role_changed',
      'membership.status_changed',
      'membership.team_changed',

      -- invitation
      'invitation.created',
      'invitation.resent',
      'invitation.cancelled',
      'invitation.accepted',

      -- customer
      'customer.created',
      'customer.updated',
      'customer.deleted',

      -- call
      'call.created',
      'call.ended',
      'call.customer_linked',
      'call.customer_unlinked',
      'call.notes_updated',
      'call.manual_summary_updated',

      -- call_action_item
      'call_action_item.created',
      'call_action_item.status_changed',
      'call_action_item.assignee_changed',
      'call_action_item.deleted',

      -- knowledge
      'knowledge_base.created',
      'knowledge_base.updated',
      'knowledge_base.deleted',
      'knowledge_chunk.replaced',

      -- checklist template
      'checklist_template.created',
      'checklist_template.updated',
      'checklist_template.deleted',

      -- report
      'report.team_viewed',

      -- Phase 7 Step 4 — retention worker aggregate events
      'retention.transcripts_deleted',
      'email_outbox.sending_recovered',

      -- Phase 7 Step 9 — billing profile mutation by admin
      'billing.profile_updated'
    ));


-- Down Migration
-- ============================================================================
-- Reverse only what this migration added.

ALTER TABLE activity_log
  DROP CONSTRAINT IF EXISTS activity_log_action_check;

ALTER TABLE activity_log
  ADD CONSTRAINT activity_log_action_check
    CHECK (action IN (
      'auth.login',
      'auth.logout',
      'auth.refresh_mfa_required',
      'auth.password_reset_requested',
      'auth.password_reset_completed',
      'auth.email_verified',
      'auth.email_verification_resent',
      'mfa.login_challenge_issued',
      'mfa.login_verified',
      'mfa.setup_started',
      'mfa.enabled',
      'mfa.disabled',
      'mfa.failed_attempt',
      'mfa.locked',
      'organization.mfa_required_enabled',
      'organization.mfa_required_disabled',
      'membership.role_changed',
      'membership.status_changed',
      'membership.team_changed',
      'invitation.created',
      'invitation.resent',
      'invitation.cancelled',
      'invitation.accepted',
      'customer.created',
      'customer.updated',
      'customer.deleted',
      'call.created',
      'call.ended',
      'call.customer_linked',
      'call.customer_unlinked',
      'call.notes_updated',
      'call.manual_summary_updated',
      'call_action_item.created',
      'call_action_item.status_changed',
      'call_action_item.assignee_changed',
      'call_action_item.deleted',
      'knowledge_base.created',
      'knowledge_base.updated',
      'knowledge_base.deleted',
      'knowledge_chunk.replaced',
      'checklist_template.created',
      'checklist_template.updated',
      'checklist_template.deleted',
      'report.team_viewed',
      'retention.transcripts_deleted',
      'email_outbox.sending_recovered'
    ));

REVOKE SELECT, INSERT, UPDATE ON organization_billing_profiles FROM app;

DROP POLICY IF EXISTS organization_billing_profiles_update ON organization_billing_profiles;
DROP POLICY IF EXISTS organization_billing_profiles_insert ON organization_billing_profiles;
DROP POLICY IF EXISTS organization_billing_profiles_select ON organization_billing_profiles;

DROP INDEX IF EXISTS organization_billing_profiles_org_id_idx;
DROP TABLE IF EXISTS organization_billing_profiles;

ALTER TABLE organizations
  DROP CONSTRAINT IF EXISTS organizations_plan_check;

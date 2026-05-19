-- Phase 8 Step 5 - extend activity_log action allow-list with retention.recordings_deleted.
--
-- Plan: docs/plan/phase-8/PHASE_8_STEP_5_PLAN.md §3.2.
--
-- activity_log.action is CHECK-bound, so adding a new action requires a
-- forward migration. The matching TS union in
-- server/src/repositories/activityLog.ts is updated in the same commit.
--
-- Why a new action instead of reusing retention.transcripts_deleted:
--   - Reusing the transcript event would conflate two unrelated lifecycles
--     in audit reporting (transcript text vs recording object storage).
--   - retention.recordings_deleted is an aggregate-only event with its own
--     payload allow-list (object_not_found_count, delete_pending_retried_count,
--     storage_provider_counts) that does not apply to transcripts.
--
-- target_type stays 'organization' (target_id = org id), matching the
-- existing retention.transcripts_deleted pattern. No new target_type
-- is required.
--
-- Reverting this migration restores the prior CHECK constraint. If
-- retention.recordings_deleted rows exist at revert time the ADD
-- CONSTRAINT step will fail; the operator must decide whether to keep
-- the rows or DELETE them before reverting. This matches the
-- schema-tightening pattern from migrations 1715000024000 / 1715000029000.
-- (The literal phrase "d-o-w-n migration" is intentionally avoided in the
-- header comment because node-pg-migrate's SQL splitter regex matches it
-- as a section marker — see node_modules/node-pg-migrate/dist/sqlMigration.js
-- createMigrationCommentRegex.)

-- Up Migration
-- ============================================================================

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

            -- Phase 7 Step 4 retention worker aggregate events
            'retention.transcripts_deleted',
            'email_outbox.sending_recovered',

            -- Phase 7 Step 9 admin billing profile mutation
            'billing.profile_updated',

            -- Phase 8 Step 3 call recording lifecycle
            'recording.upload_initiated',
            'recording.finalized',
            'recording.playback_url_issued',
            'recording.delete_requested',
            'recording.deleted',

            -- Phase 8 Step 5 recording retention sweep aggregate event
            'retention.recordings_deleted'
        ));


-- Down Migration
-- ============================================================================

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
            'email_outbox.sending_recovered',
            'billing.profile_updated',
            'recording.upload_initiated',
            'recording.finalized',
            'recording.playback_url_issued',
            'recording.delete_requested',
            'recording.deleted'
        ));

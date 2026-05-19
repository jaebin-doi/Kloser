-- Phase 8 Step 1 - call_recordings metadata schema.
--
-- Plan: docs/plan/phase-8/PHASE_8_STEP_1_PLAN.md.
-- Master: docs/plan/phase-8/PHASE_8_MASTER.md.
--
-- This migration creates only the org-scoped metadata surface for recorded
-- call audio. It does not introduce an object storage adapter, upload route,
-- playback route, frontend UI, or retention worker logic.
--
-- Audio bytes do not live in PostgreSQL. The table stores private object
-- locator metadata that later steps will use to generate short-lived signed
-- URLs after backend authorization.

-- Up Migration
-- ============================================================================

CREATE TABLE call_recordings (
    id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                 uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    call_id                uuid        NOT NULL,

    status                 text        NOT NULL
                                        CHECK (status IN (
                                          'upload_pending',
                                          'uploaded',
                                          'processing',
                                          'available',
                                          'delete_pending',
                                          'deleted',
                                          'failed'
                                        )),

    storage_provider       text        NOT NULL
                                        CHECK (storage_provider IN ('local', 's3', 'minio')),
    storage_bucket         text        CHECK (storage_bucket IS NULL OR length(storage_bucket) > 0),
    object_key             text        NOT NULL CHECK (length(object_key) > 0),
    object_version         text,

    content_type           text        NOT NULL
                                        CHECK (content_type IN (
                                          'audio/webm',
                                          'audio/ogg',
                                          'audio/mpeg',
                                          'audio/mp4',
                                          'audio/wav'
                                        )),
    codec                  text,
    duration_seconds       int         CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
    size_bytes             bigint      CHECK (size_bytes IS NULL OR size_bytes >= 0),
    checksum_sha256        text        CHECK (
                                          checksum_sha256 IS NULL
                                          OR checksum_sha256 ~ '^[0-9a-f]{64}$'
                                        ),

    recorded_at            timestamptz,
    uploaded_at            timestamptz,
    retention_delete_after timestamptz,
    deleted_at             timestamptz,

    error_message          text,
    metadata               jsonb       NOT NULL DEFAULT '{}'::jsonb
                                        CHECK (jsonb_typeof(metadata) = 'object'),

    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),

    -- id is globally unique, but keeping this exact pair makes future child
    -- tables possible without joining through calls.
    UNIQUE (org_id, id),

    -- Object keys are internal locators. They should not collide inside one
    -- tenant even if a retry races the first upload finalization.
    UNIQUE (org_id, object_key),

    CONSTRAINT call_recordings_call_same_org_fk
      FOREIGN KEY (org_id, call_id)
      REFERENCES calls(org_id, id)
      ON DELETE CASCADE,

    CONSTRAINT call_recordings_deleted_status_check
      CHECK (
        (status = 'deleted' AND deleted_at IS NOT NULL)
        OR
        (status <> 'deleted')
      )
);

CREATE TRIGGER call_recordings_touch_updated_at
    BEFORE UPDATE ON call_recordings
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE INDEX call_recordings_org_call_created_idx
  ON call_recordings (org_id, call_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX call_recordings_org_status_idx
  ON call_recordings (org_id, status, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX call_recordings_org_retention_idx
  ON call_recordings (org_id, retention_delete_after, uploaded_at)
  WHERE deleted_at IS NULL
    AND status IN ('uploaded', 'available', 'failed');

-- RLS - same org-scoped FORCE RLS pattern as calls/transcripts/customers.
ALTER TABLE call_recordings ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_recordings FORCE ROW LEVEL SECURITY;

CREATE POLICY call_recordings_select ON call_recordings FOR SELECT
    USING (org_id = current_app_org_id());

CREATE POLICY call_recordings_insert ON call_recordings FOR INSERT
    WITH CHECK (org_id = current_app_org_id());

CREATE POLICY call_recordings_update ON call_recordings FOR UPDATE
    USING      (org_id = current_app_org_id())
    WITH CHECK (org_id = current_app_org_id());

CREATE POLICY call_recordings_delete ON call_recordings FOR DELETE
    USING (org_id = current_app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON call_recordings TO app;


-- Down Migration
-- ============================================================================

REVOKE SELECT, INSERT, UPDATE, DELETE ON call_recordings FROM app;

DROP POLICY IF EXISTS call_recordings_delete ON call_recordings;
DROP POLICY IF EXISTS call_recordings_update ON call_recordings;
DROP POLICY IF EXISTS call_recordings_insert ON call_recordings;
DROP POLICY IF EXISTS call_recordings_select ON call_recordings;

DROP TRIGGER IF EXISTS call_recordings_touch_updated_at ON call_recordings;

DROP TABLE IF EXISTS call_recordings;

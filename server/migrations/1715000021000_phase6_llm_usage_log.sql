-- Phase 6 Step 2 — llm_usage_log (provider call accounting).
-- Plan: docs/plan/phase-6/PHASE_6_STEP_2_PLAN.md §3.
-- Master: docs/plan/phase-6/PHASE_6_MASTER.md §6.
--
-- Per-call record of LLM / embedding / STT provider invocations issued
-- by Phase 6 Step 1 workers + WS suggestion hook (currently mock-backed)
-- and Step 2+ real providers. One row per provider call. Used for cost
-- visibility, latency monitoring, and post-hoc audit of which call /
-- operation triggered which provider request.
--
-- org_id (NOT NULL, denormalized)
--   Mirrors Phase 4/5 pattern — every tenant-scoped table carries its
--   own org_id so RLS policies stay JOIN-free. cascade on org delete.
--
-- call_id (NULL allowed)
--   Most rows attach to a specific call (`call_summary`, `call_suggestion`).
--   `knowledge_embedding` happens at KB admin time and has no call —
--   those rows carry call_id = NULL. STT can also be call-less in future
--   ingest paths. Composite FK enforces same-org parent: a Beta-owned
--   row pointing at an Acme call is rejected at DB level even if a bug
--   in the service layer slipped past withOrgContext.
--
-- ON DELETE SET NULL (call_id)
--   PG15+ partial set-null syntax. When a call is hard-deleted, the
--   usage row must survive (provider was already paid for) — only the
--   call_id column nulls out. org_id stays so the row remains tenant-
--   scoped. Hard delete of calls is not part of Phase 6 normal flow but
--   the FK contract still has to remain sound.
--
-- status enum
--   - succeeded: provider returned a usable response (tokens, model,
--     latency all populated where the provider gave them).
--   - failed:    provider returned a structured error (4xx/5xx) — tokens
--     may be NULL, but latency/error_code captured.
--   - skipped:   adapter short-circuited before hitting the provider
--     (e.g. empty transcript → mock summary returns null fields). Costs
--     nothing but logged so we can see how often we no-op.
--
-- operation enum
--   Single source of truth for the four call sites we expect in Step 2:
--     call_summary       — callSummary.worker.ts after summarizeCall
--     call_suggestion    — ws/calls.ts after suggestForUtterance
--     knowledge_embedding — services/knowledge.ts after embed/embedBatch
--     stt_transcribe     — STT route/service (Step 2 adapter only; first
--                         production audio ingest path picks this up).
--
-- provider enum
--   Includes 'mock' so mock-adapter call sites can still log usage. This
--   keeps the integration test surface honest — usage rows show up the
--   same shape regardless of provider env.
--
-- metadata jsonb
--   Open-ended provider-specific context (e.g. embedding chunk_id,
--   suggestion group_seq, retry attempt counter). Test code uses it to
--   tag rows with a prefix marker for cleanup. NOT NULL DEFAULT '{}'
--   so the column never carries SQL NULL — only JSON object NULL.
--
-- Append-only
--   No UPDATE/DELETE policy in Step 2. Rows are inserted once and only
--   read. A future step that introduces retention sweep will add a
--   DELETE policy with a time-window predicate; until then the table
--   only grows.

-- Up Migration
-- ============================================================================

CREATE TABLE llm_usage_log (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    call_id             uuid,
    provider            text        NOT NULL
                          CHECK (provider IN ('anthropic','openai','clova','mock')),
    operation           text        NOT NULL
                          CHECK (operation IN (
                            'call_summary',
                            'call_suggestion',
                            'knowledge_embedding',
                            'stt_transcribe'
                          )),
    model               text        NOT NULL CHECK (length(model) > 0),
    status              text        NOT NULL
                          CHECK (status IN ('succeeded','failed','skipped')),
    tokens_in           int         CHECK (tokens_in IS NULL OR tokens_in >= 0),
    tokens_out          int         CHECK (tokens_out IS NULL OR tokens_out >= 0),
    latency_ms          int         CHECK (latency_ms IS NULL OR latency_ms >= 0),
    cost_usd_micros     bigint      CHECK (cost_usd_micros IS NULL OR cost_usd_micros >= 0),
    provider_request_id text,
    error_code          text,
    metadata            jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT llm_usage_log_call_same_org_fk
      FOREIGN KEY (org_id, call_id)
      REFERENCES calls(org_id, id)
      ON DELETE SET NULL (call_id)
);

-- Org-scoped time-ordered listing (default operator view).
CREATE INDEX llm_usage_log_org_created_idx
    ON llm_usage_log (org_id, created_at DESC);

-- Filter by provider within an org (cost by vendor).
CREATE INDEX llm_usage_log_org_provider_idx
    ON llm_usage_log (org_id, provider, created_at DESC);

-- Filter by operation within an org (cost by feature).
CREATE INDEX llm_usage_log_org_operation_idx
    ON llm_usage_log (org_id, operation, created_at DESC);

-- Per-call drill-down. Partial — most rows already match the org index,
-- this targets the call detail view directly.
CREATE INDEX llm_usage_log_call_created_idx
    ON llm_usage_log (call_id, created_at DESC)
    WHERE call_id IS NOT NULL;

ALTER TABLE llm_usage_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_usage_log FORCE  ROW LEVEL SECURITY;

CREATE POLICY llm_usage_log_select ON llm_usage_log FOR SELECT
    USING (org_id = current_app_org_id());

CREATE POLICY llm_usage_log_insert ON llm_usage_log FOR INSERT
    WITH CHECK (org_id = current_app_org_id());

-- Step 2 contract: usage rows are append-only. No UPDATE/DELETE policy
-- on purpose — RLS-forced tables with no policy for a verb deny that
-- verb entirely for non-BYPASSRLS roles. A future retention sweep will
-- run as a privileged role (kloser_service or admin) and bypass RLS.

GRANT SELECT, INSERT ON llm_usage_log TO app;


-- Down Migration
-- ============================================================================

REVOKE SELECT, INSERT ON llm_usage_log FROM app;

DROP POLICY IF EXISTS llm_usage_log_insert ON llm_usage_log;
DROP POLICY IF EXISTS llm_usage_log_select ON llm_usage_log;

DROP INDEX IF EXISTS llm_usage_log_call_created_idx;
DROP INDEX IF EXISTS llm_usage_log_org_operation_idx;
DROP INDEX IF EXISTS llm_usage_log_org_provider_idx;
DROP INDEX IF EXISTS llm_usage_log_org_created_idx;

DROP TABLE IF EXISTS llm_usage_log;

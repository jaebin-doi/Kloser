-- Phase 4 Step 1 — calls table.
-- Plan: docs/plan/phase-4/PHASE_4_STEP_1_SCHEMA.md §3.
-- Master: docs/plan/phase-4/PHASE_4_MASTER.md §5.1.
--
-- 첫 번째 Phase 4 영속화 테이블. 통화 세션 단위 row. Phase 0.5 WebSocket
-- 흐름(start_call → text_chunk → end_call)을 거치는 동안 메모리에서 사라지던
-- 데이터를 DB로 옮긴다. transcripts (1715000010000) 와 call_action_items
-- (1715000011000)는 본 테이블의 자식으로 ON DELETE CASCADE.
--
-- Cross-org FK guard:
--   - calls.customer_id is scoped by (org_id, customer_id), not customer_id
--     alone, so an Acme call cannot point at a Beta customer.
--   - calls.agent_user_id is scoped through memberships(org_id, user_id), so
--     the agent must belong to the same org.
--
-- touch_updated_at() 함수는 1715000002000_customers.sql에서 처음 정의됐고
-- 그 migration의 DOWN이 함수를 drop한다. 본 migration은 CREATE OR REPLACE로
-- 재선언(idempotent)해서 fresh DB에서 customers보다 먼저 실행돼도 동작하게
-- 한다. 본 migration의 DOWN은 calls_touch_updated_at trigger만 drop —
-- 함수 자체는 customers migration의 DOWN이 소유한다 (Phase 4 → customers
-- 순서로 reverse migrate되므로 Phase 4 DOWN 시점에는 함수가 살아 있어야
-- customers_touch_updated_at trigger가 계속 동작).

-- Up Migration
-- ============================================================================

-- Composite FK target for calls(org_id, customer_id). customers.id is already
-- globally unique, but PostgreSQL requires an exact UNIQUE/PK on referenced
-- column sets. This extra constraint is logically redundant and makes the
-- org-scoped FK explicit.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'customers_org_id_id_unique'
       AND conrelid = 'customers'::regclass
  ) THEN
    ALTER TABLE customers
      ADD CONSTRAINT customers_org_id_id_unique UNIQUE (org_id, id);
  END IF;
END
$$;

CREATE TABLE calls (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

    -- relations — both nullable so missing FK does not block the call row.
    -- customer_id NULL = 등록 안 된 발신자 (unknown caller). 시간이 지나
    -- 매칭되면 service.linkCustomer(callId, customerId)에서 UPDATE.
    -- agent_user_id NULL = 사용자가 조직을 떠난 경우 ("전 사용자" 표시).
    customer_id         uuid,
    agent_user_id       uuid,

    -- classification — text + CHECK enum, ENUM type 미사용 (Phase 1~3 일관).
    direction           text        NOT NULL
                            CHECK (direction IN ('inbound','outbound','meeting')),
    status              text        NOT NULL
                            CHECK (status IN ('in_progress','ended','missed','dropped')),

    -- timing — duration_seconds는 service.endCall이 같은 트랜잭션에서
    -- EXTRACT(EPOCH FROM (ended_at - started_at))::int로 채움 (plan §1-5).
    started_at          timestamptz NOT NULL DEFAULT now(),
    ended_at            timestamptz,
    duration_seconds    int         CHECK (duration_seconds IS NULL OR duration_seconds >= 0),

    -- content — summary / needs / issues는 분리 컬럼 (plan §1-6).
    -- AI 자동 생성 또는 사용자 수동 입력 둘 다 같은 컬럼 채움. Phase 4
    -- 시점은 NULL이 정상 (Phase 5 실 AI 도입 시점에 채워짐).
    title               text,
    summary             text,
    needs               text,
    issues              text,
    sentiment           text        CHECK (sentiment IS NULL OR sentiment IN ('positive','neutral','cautious','negative')),
    notes               text,

    -- soft delete + timestamps.
    deleted_at          timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    -- id is globally unique, but children use (org_id, id) to enforce
    -- denormalized org_id consistency without JOINs in RLS policies.
    UNIQUE (org_id, id),

    CONSTRAINT calls_customer_same_org_fk
      FOREIGN KEY (org_id, customer_id)
      REFERENCES customers(org_id, id)
      ON DELETE SET NULL (customer_id),

    CONSTRAINT calls_agent_membership_fk
      FOREIGN KEY (org_id, agent_user_id)
      REFERENCES memberships(org_id, user_id)
      ON DELETE SET NULL (agent_user_id)
);

-- touch_updated_at() — 1715000002000_customers.sql에서 정의됨. 본 migration이
-- fresh DB에서 customers보다 먼저 실행돼도 동작하도록 CREATE OR REPLACE
-- (idempotent — 동일 정의 재선언, 함수 본문은 customers와 byte-identical).
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER calls_touch_updated_at
    BEFORE UPDATE ON calls
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Partial indexes — every read query skips soft-deleted rows, so excluding
-- them from the index keeps both index size and write cost down (Phase 2
-- customers 패턴 일관). Plan §3.3.
CREATE INDEX calls_org_started_idx
    ON calls (org_id, started_at DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX calls_org_customer_started_idx
    ON calls (org_id, customer_id, started_at DESC)
    WHERE deleted_at IS NULL AND customer_id IS NOT NULL;

CREATE INDEX calls_org_agent_started_idx
    ON calls (org_id, agent_user_id, started_at DESC)
    WHERE deleted_at IS NULL AND agent_user_id IS NOT NULL;

CREATE INDEX calls_org_status_idx
    ON calls (org_id, status)
    WHERE deleted_at IS NULL;

-- RLS — FORCE so the migration role (kloser) is also subject to policies
-- (Phase 1 init.sql 패턴 일관). app role은 NOSUPERUSER NOBYPASSRLS이므로
-- RLS 정책에 100% 종속.
ALTER TABLE calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE calls FORCE  ROW LEVEL SECURITY;

CREATE POLICY calls_select ON calls FOR SELECT
    USING (org_id = current_app_org_id());

CREATE POLICY calls_insert ON calls FOR INSERT
    WITH CHECK (org_id = current_app_org_id());

CREATE POLICY calls_update ON calls FOR UPDATE
    USING      (org_id = current_app_org_id())
    WITH CHECK (org_id = current_app_org_id());

CREATE POLICY calls_delete ON calls FOR DELETE
    USING (org_id = current_app_org_id());


-- Down Migration
-- ============================================================================

DROP TRIGGER IF EXISTS calls_touch_updated_at ON calls;

-- touch_updated_at() function is NOT dropped here — it's shared with
-- customers (1715000002000) and call_action_items (1715000011000). The
-- customers migration's DOWN owns the function lifecycle and drops it
-- after Phase 4 down runs (reverse-chronological order: 11 → 10 → 9 → ...
-- → 2 customers DOWN drops function).

DROP POLICY IF EXISTS calls_delete ON calls;
DROP POLICY IF EXISTS calls_update ON calls;
DROP POLICY IF EXISTS calls_insert ON calls;
DROP POLICY IF EXISTS calls_select ON calls;

DROP TABLE IF EXISTS calls;

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_org_id_id_unique;

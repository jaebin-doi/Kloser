-- Phase 4 Step 1 — call_action_items table.
-- Plan: docs/plan/phase-4/PHASE_4_STEP_1_SCHEMA.md §5.
-- Master: docs/plan/phase-4/PHASE_4_MASTER.md §5.3.
--
-- 통화 1건당 후속 액션 N개 (1:N). calls의 자식 (ON DELETE CASCADE).
-- "다음 액션" 자체를 jsonb 컬럼에 박지 않고 별도 테이블로 둔 이유는
-- 담당자 / 상태 / 완료 시각이 각자 라이프사이클이기 때문 (master plan §2-7).
--
-- CHECK (status='done' ↔ completed_at NOT NULL)이 status와 시각의 일관성을
-- DB가 강제. service가 잘못된 조합 INSERT 시 23514 (check_violation).
-- 트리거 미사용 — completed_at은 service가 같은 트랜잭션 안에서 set
-- (master plan §2-5와 일관, plan §1-16).
--
-- transcripts와 마찬가지로 org_id는 비정규화. (org_id, call_id)와
-- (org_id, assignee_user_id) composite FKs가 cross-org 오염을 막는다.

-- Up Migration
-- ============================================================================

CREATE TABLE call_action_items (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    call_id           uuid        NOT NULL,

    -- denormalized org_id — RLS 단독 평가용 (transcripts와 동일 패턴).
    org_id            uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

    -- 본문.
    title             text        NOT NULL CHECK (length(title) > 0),
    due_date          date,
    assignee_user_id  uuid,

    -- 상태 머신 — 'open' 기본, 'done'은 완료(completed_at 동시 set),
    -- 'dropped'는 취소 (예: 고객 변심).
    status            text        NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open','done','dropped')),
    completed_at      timestamptz,

    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    -- status='done' ↔ completed_at NOT NULL 일관성을 DB가 강제.
    -- service가 status를 'done'으로 바꾸면서 completed_at을 안 채우거나
    -- 그 반대로 채우면 23514로 INSERT/UPDATE 거부됨.
    CHECK (
        (status = 'done'     AND completed_at IS NOT NULL) OR
        (status <> 'done'    AND completed_at IS NULL)
    ),

    CONSTRAINT call_action_items_call_same_org_fk
      FOREIGN KEY (org_id, call_id)
      REFERENCES calls(org_id, id)
      ON DELETE CASCADE,

    CONSTRAINT call_action_items_assignee_membership_fk
      FOREIGN KEY (org_id, assignee_user_id)
      REFERENCES memberships(org_id, user_id)
      ON DELETE SET NULL (assignee_user_id)
);

-- updated_at 자동 갱신 — touch_updated_at()는 1715000002000_customers.sql에서
-- 정의됐고 calls migration이 CREATE OR REPLACE로 idempotent화 했음.
CREATE TRIGGER call_action_items_touch_updated_at
    BEFORE UPDATE ON call_action_items
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- 인덱스 2개 (plan §5.3).
CREATE INDEX call_action_items_call_idx
    ON call_action_items (call_id);

-- 부분 인덱스 — '나에게 할당된 미완료 액션' (Phase 5+ personal todo).
-- status='open'만 인덱싱해서 크기 절감 + due_date 정렬 cover.
CREATE INDEX call_action_items_assignee_open_idx
    ON call_action_items (org_id, assignee_user_id, due_date)
    WHERE status = 'open';

-- RLS — calls / transcripts와 동일 패턴.
ALTER TABLE call_action_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_action_items FORCE  ROW LEVEL SECURITY;

CREATE POLICY call_action_items_select ON call_action_items FOR SELECT
    USING (org_id = current_app_org_id());

CREATE POLICY call_action_items_insert ON call_action_items FOR INSERT
    WITH CHECK (org_id = current_app_org_id());

CREATE POLICY call_action_items_update ON call_action_items FOR UPDATE
    USING      (org_id = current_app_org_id())
    WITH CHECK (org_id = current_app_org_id());

CREATE POLICY call_action_items_delete ON call_action_items FOR DELETE
    USING (org_id = current_app_org_id());


-- Down Migration
-- ============================================================================

DROP TRIGGER IF EXISTS call_action_items_touch_updated_at ON call_action_items;

-- touch_updated_at() function은 여기서도 drop 안 함 — calls migration과
-- 동일한 이유 (customers migration이 함수 라이프사이클 소유).

DROP POLICY IF EXISTS call_action_items_delete ON call_action_items;
DROP POLICY IF EXISTS call_action_items_update ON call_action_items;
DROP POLICY IF EXISTS call_action_items_insert ON call_action_items;
DROP POLICY IF EXISTS call_action_items_select ON call_action_items;

DROP TABLE IF EXISTS call_action_items;

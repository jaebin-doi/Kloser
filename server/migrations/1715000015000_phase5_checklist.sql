-- Phase 5 Step 1 — org checklist templates + per-call checklist items.
-- Plan: docs/plan/phase-5/PHASE_5_STEP_1_SCHEMA.md §5, §6.
-- Master: docs/plan/phase-5/PHASE_5_MASTER.md §5.3, §5.4.
--
-- Phase 0.5 fixture의 정적 5항목 ('고객 요구사항 청취' 등)을 회사별 마스터로 옮긴다.
-- 통화 시작 시점에 active 템플릿을 fetch해서 통화별 진행 행을 자동 생성하고,
-- live.html 토글이 영속화된다.
--
-- org_call_checklist_templates (회사 단위 마스터)
--   - admin/manager만 mutation (Step 3 route에서 enforce). 본 schema는 모든
--     org 멤버 read 허용.
--   - active=false로 soft inactive — 비활성 항목은 새 통화에 안 깔리지만 과거
--     진행 row는 보존 (cascade는 진행 row를 깨버리니 active 토글 모델).
--
-- call_checklist_items (통화별 진행)
--   - call_id 종속 (cascade) + template_id 종속 (cascade — 마스터를 hard delete
--     하면 진행 행도 사라짐. 일반 운영은 active=false 사용 권장).
--   - (call_id, template_id) UNIQUE — 통화 시작 시 한 번에 깔리는 자연 키.
--   - status='open'/'done' + checked_at 일관성 CHECK (Phase 4 call_action_items
--     패턴 일관).

-- Up Migration
-- ============================================================================

-- org_call_checklist_templates ----------------------------------------------
CREATE TABLE org_call_checklist_templates (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title       text        NOT NULL CHECK (length(title) > 0),
    sort_order  int         NOT NULL DEFAULT 0,
    active      boolean     NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, id)
);

CREATE TRIGGER org_call_checklist_templates_touch_updated_at
    BEFORE UPDATE ON org_call_checklist_templates
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- active 항목만 sort_order 순서 fetch (live.html 통화 시작 시).
CREATE INDEX org_call_checklist_templates_active_idx
    ON org_call_checklist_templates (org_id, sort_order)
    WHERE active = true;

ALTER TABLE org_call_checklist_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_call_checklist_templates FORCE  ROW LEVEL SECURITY;

CREATE POLICY org_call_checklist_templates_select ON org_call_checklist_templates FOR SELECT
    USING (org_id = current_app_org_id());

CREATE POLICY org_call_checklist_templates_insert ON org_call_checklist_templates FOR INSERT
    WITH CHECK (org_id = current_app_org_id());

CREATE POLICY org_call_checklist_templates_update ON org_call_checklist_templates FOR UPDATE
    USING      (org_id = current_app_org_id())
    WITH CHECK (org_id = current_app_org_id());

CREATE POLICY org_call_checklist_templates_delete ON org_call_checklist_templates FOR DELETE
    USING (org_id = current_app_org_id());


-- call_checklist_items -------------------------------------------------------
CREATE TABLE call_checklist_items (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    call_id             uuid        NOT NULL,
    template_id         uuid        NOT NULL,
    org_id              uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    status              text        NOT NULL DEFAULT 'open'
                                  CHECK (status IN ('open','done')),
    checked_at          timestamptz,
    checked_by_user_id  uuid,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    UNIQUE (call_id, template_id),

    -- status / checked_at 일관성 — done이면 timestamp 있어야, open이면 없어야.
    CHECK (
      (status = 'done' AND checked_at IS NOT NULL) OR
      (status = 'open' AND checked_at IS NULL)
    ),

    CONSTRAINT call_checklist_items_call_same_org_fk
      FOREIGN KEY (org_id, call_id)
      REFERENCES calls(org_id, id)
      ON DELETE CASCADE,

    CONSTRAINT call_checklist_items_template_same_org_fk
      FOREIGN KEY (org_id, template_id)
      REFERENCES org_call_checklist_templates(org_id, id)
      ON DELETE CASCADE,

    CONSTRAINT call_checklist_items_checker_membership_fk
      FOREIGN KEY (org_id, checked_by_user_id)
      REFERENCES memberships(org_id, user_id)
      ON DELETE SET NULL (checked_by_user_id)
);

CREATE TRIGGER call_checklist_items_touch_updated_at
    BEFORE UPDATE ON call_checklist_items
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- 1 call의 모든 항목 fetch — UNIQUE (call_id, template_id)가 자동으로
-- (call_id, template_id) 인덱스를 생성하므로 추가 명시 인덱스는 (call_id, status)
-- 같은 일반 read 보조용으로 둔다.
CREATE INDEX call_checklist_items_call_status_idx
    ON call_checklist_items (call_id, status);

ALTER TABLE call_checklist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_checklist_items FORCE  ROW LEVEL SECURITY;

CREATE POLICY call_checklist_items_select ON call_checklist_items FOR SELECT
    USING (org_id = current_app_org_id());

CREATE POLICY call_checklist_items_insert ON call_checklist_items FOR INSERT
    WITH CHECK (org_id = current_app_org_id());

CREATE POLICY call_checklist_items_update ON call_checklist_items FOR UPDATE
    USING      (org_id = current_app_org_id())
    WITH CHECK (org_id = current_app_org_id());

CREATE POLICY call_checklist_items_delete ON call_checklist_items FOR DELETE
    USING (org_id = current_app_org_id());


-- Down Migration
-- ============================================================================

DROP POLICY IF EXISTS call_checklist_items_delete ON call_checklist_items;
DROP POLICY IF EXISTS call_checklist_items_update ON call_checklist_items;
DROP POLICY IF EXISTS call_checklist_items_insert ON call_checklist_items;
DROP POLICY IF EXISTS call_checklist_items_select ON call_checklist_items;
DROP TRIGGER IF EXISTS call_checklist_items_touch_updated_at ON call_checklist_items;
DROP TABLE IF EXISTS call_checklist_items;

DROP POLICY IF EXISTS org_call_checklist_templates_delete ON org_call_checklist_templates;
DROP POLICY IF EXISTS org_call_checklist_templates_update ON org_call_checklist_templates;
DROP POLICY IF EXISTS org_call_checklist_templates_insert ON org_call_checklist_templates;
DROP POLICY IF EXISTS org_call_checklist_templates_select ON org_call_checklist_templates;
DROP TRIGGER IF EXISTS org_call_checklist_templates_touch_updated_at ON org_call_checklist_templates;
DROP TABLE IF EXISTS org_call_checklist_templates;

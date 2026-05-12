-- Phase 5 Step 1 — call_suggestions (AI response suggestions persistence).
-- Plan: docs/plan/phase-5/PHASE_5_STEP_1_SCHEMA.md §7.
-- Master: docs/plan/phase-5/PHASE_5_MASTER.md §5.5.
--
-- Phase 0.5 fixture가 시점별 group으로 푸시하던 suggestion 카드를 영속화한다.
-- 통화 후 calls.html detail 패널이 "어떤 추천이 떴고 사용·기각됐는지" 보여줄 수
-- 있게 한다.
--
-- group_seq + at_ms
--   - group_seq는 같은 통화 안에서 0부터 순차 (Phase 0.5의 aiSequence index와 1:1).
--   - at_ms는 통화 시작 후 경과 ms — 시점 정보 보존.
--
-- (call_id, group_seq, type) UNIQUE
--   - 한 group 안에서 같은 type의 카드가 중복 INSERT 되지 않게 한다.
--     (Phase 0.5 fixture는 1 group = 1~3 type, 모두 다른 type).
--   - LLM 응답이 우연히 같은 type을 두 번 보내도 conflict로 거절.
--
-- dismissed_at / used_at
--   - 둘 다 NULL이면 "추천만 떴고 사용자 행동 없음".
--   - dismissed_at만 set이면 사용자가 닫음.
--   - used_at만 set이면 사용자가 사용 (예: "빠른 응대 멘트 클릭").
--   - 둘 다 set은 금지 (CHECK으로 강제).
--
-- tone / type enum은 Phase 0.5 fixture와 동일. live.html의 toneStyles / toneIcon
-- 맵이 본 enum 값을 그대로 키로 쓴다.

-- Up Migration
-- ============================================================================

CREATE TABLE call_suggestions (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    call_id      uuid        NOT NULL,
    -- denormalized org_id — Phase 4 transcripts 패턴 일관.
    org_id       uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    group_seq    int         NOT NULL CHECK (group_seq >= 0),
    at_ms        int         NOT NULL CHECK (at_ms >= 0),
    tone         text        NOT NULL
                       CHECK (tone IN ('blue','cyan','amber','rose','emerald','slate')),
    type         text        NOT NULL
                       CHECK (type IN ('direction','script','alert','risk','next','kb')),
    title        text        NOT NULL CHECK (length(title) > 0),
    body         text,
    dismissed_at timestamptz,
    used_at      timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),

    UNIQUE (call_id, group_seq, type),

    -- dismissed와 used가 동시에 set 금지. 둘 다 NULL은 정상 (미반응).
    CHECK (
      NOT (dismissed_at IS NOT NULL AND used_at IS NOT NULL)
    ),

    CONSTRAINT call_suggestions_call_same_org_fk
      FOREIGN KEY (org_id, call_id)
      REFERENCES calls(org_id, id)
      ON DELETE CASCADE
);

-- 1 call의 suggestion 시점순 fetch. UNIQUE (call_id, group_seq, type)가 자동으로
-- (call_id, group_seq, type) 인덱스를 생성하므로 (call_id, at_ms) 보조 인덱스를
-- detail panel 시점순 정렬용으로 둔다.
CREATE INDEX call_suggestions_call_at_idx
    ON call_suggestions (call_id, at_ms);

ALTER TABLE call_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_suggestions FORCE  ROW LEVEL SECURITY;

CREATE POLICY call_suggestions_select ON call_suggestions FOR SELECT
    USING (org_id = current_app_org_id());

CREATE POLICY call_suggestions_insert ON call_suggestions FOR INSERT
    WITH CHECK (org_id = current_app_org_id());

CREATE POLICY call_suggestions_update ON call_suggestions FOR UPDATE
    USING      (org_id = current_app_org_id())
    WITH CHECK (org_id = current_app_org_id());

CREATE POLICY call_suggestions_delete ON call_suggestions FOR DELETE
    USING (org_id = current_app_org_id());


-- Down Migration
-- ============================================================================

DROP POLICY IF EXISTS call_suggestions_delete ON call_suggestions;
DROP POLICY IF EXISTS call_suggestions_update ON call_suggestions;
DROP POLICY IF EXISTS call_suggestions_insert ON call_suggestions;
DROP POLICY IF EXISTS call_suggestions_select ON call_suggestions;
DROP TABLE IF EXISTS call_suggestions;

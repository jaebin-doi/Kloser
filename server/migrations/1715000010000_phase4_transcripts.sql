-- Phase 4 Step 1 — transcripts table.
-- Plan: docs/plan/phase-4/PHASE_4_STEP_1_SCHEMA.md §4.
-- Master: docs/plan/phase-4/PHASE_4_MASTER.md §5.2.
--
-- 통화 1건당 발화(utterance) N개. live.html의 STT 출력 스트림이 모이는
-- 곳이고 Phase 5+에서 AI 요약/분석의 입력. calls의 자식 (ON DELETE CASCADE).
--
-- org_id는 비정규화된 컬럼 (결정 plan §2-3 + §4.4):
--   - RLS 정책 평가가 JOIN 없이 transcripts.org_id 단독으로 가능
--   - (org_id, call_id) composite FK가 calls(org_id, id)를 참조해 drift를
--     DB 레벨에서 차단
--
-- updated_at 컬럼이 없다 — 발화는 append-only 모델 (한 번 박히면 수정 안 함).
-- 그래서 touch_updated_at trigger도 없다. created_at만 있음.

-- Up Migration
-- ============================================================================

CREATE TABLE transcripts (
    id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    call_id       uuid         NOT NULL,

    -- denormalized org_id — RLS 단독 평가용. (org_id, call_id) composite
    -- FK below keeps it consistent with calls.org_id.
    org_id        uuid         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

    -- ordering — UNIQUE (call_id, seq) 인덱스가 자동 생성됨 (constraint 하단).
    -- service.appendTranscript가 advisory lock 또는 MAX(seq)+1 패턴으로 발급
    -- (Step 2 plan에서 정밀화). WS persistence는 통화당 단일 클라이언트라
    -- race 가능성 낮음.
    seq           int          NOT NULL CHECK (seq >= 0),

    -- speaker — 'system'은 자동 안내 ("통화 시작 안내" 같은) 도입 여지 (plan §1-12).
    speaker       text         NOT NULL
                       CHECK (speaker IN ('agent','customer','system')),

    -- text — empty string 차단. 빈 발화는 의미 없음.
    text          text         NOT NULL CHECK (length(text) > 0),

    -- timing — STT가 채우는 ms 오프셋 (call started_at 기준). NULL 허용 (fixture·legacy).
    -- end_ms는 start_ms와 동시 존재 + end_ms >= start_ms 일관성 강제.
    start_ms      int          CHECK (start_ms IS NULL OR start_ms >= 0),
    end_ms        int          CHECK (
                       end_ms IS NULL OR
                       (start_ms IS NOT NULL AND end_ms >= start_ms)
                   ),

    -- confidence — STT 신뢰도 0.000~1.000 (plan §1-13).
    -- Phase 0.5 fixture는 1.000 고정. Phase 5 실 STT 도입 시점에 의미 있는 값.
    confidence    numeric(4,3) CHECK (
                       confidence IS NULL OR
                       (confidence >= 0 AND confidence <= 1)
                   ),

    created_at    timestamptz  NOT NULL DEFAULT now(),

    -- 통화 1건 안에서 seq는 유일 — sequence per call.
    -- UNIQUE constraint가 자동으로 (call_id, seq) 인덱스를 만들어
    -- "이 통화의 발화 시간순" read query도 함께 cover한다.
    UNIQUE (call_id, seq),

    CONSTRAINT transcripts_call_same_org_fk
      FOREIGN KEY (org_id, call_id)
      REFERENCES calls(org_id, id)
      ON DELETE CASCADE
);

-- transcripts_org_created_idx — RLS scan helper + 운영 도구.
-- 일상 read는 UNIQUE (call_id, seq) 인덱스로 처리. 본 인덱스는 특정 org의
-- 최근 발화 N건 조회 같은 운영/감사 query용 (plan §4.3).
-- soft delete 컬럼 없음 → 전체 인덱스 (부분 인덱스 아님). 부모 CASCADE라
-- calls 삭제 시 transcripts 행 자체가 사라지므로 deleted_at 컬럼 불필요
-- (결정 plan §2-6).
CREATE INDEX transcripts_org_created_idx
    ON transcripts (org_id, created_at DESC);

-- RLS — calls와 동일 패턴.
ALTER TABLE transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcripts FORCE  ROW LEVEL SECURITY;

CREATE POLICY transcripts_select ON transcripts FOR SELECT
    USING (org_id = current_app_org_id());

CREATE POLICY transcripts_insert ON transcripts FOR INSERT
    WITH CHECK (org_id = current_app_org_id());

CREATE POLICY transcripts_update ON transcripts FOR UPDATE
    USING      (org_id = current_app_org_id())
    WITH CHECK (org_id = current_app_org_id());

CREATE POLICY transcripts_delete ON transcripts FOR DELETE
    USING (org_id = current_app_org_id());


-- Down Migration
-- ============================================================================

DROP POLICY IF EXISTS transcripts_delete ON transcripts;
DROP POLICY IF EXISTS transcripts_update ON transcripts;
DROP POLICY IF EXISTS transcripts_insert ON transcripts;
DROP POLICY IF EXISTS transcripts_select ON transcripts;

DROP TABLE IF EXISTS transcripts;

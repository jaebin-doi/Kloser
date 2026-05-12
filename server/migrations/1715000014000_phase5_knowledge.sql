-- Phase 5 Step 1 — knowledge_bases + knowledge_chunks (RAG infrastructure).
-- Plan: docs/plan/phase-5/PHASE_5_STEP_1_SCHEMA.md §3, §4, §2.3.
-- Master: docs/plan/phase-5/PHASE_5_MASTER.md §5.1, §5.2.
--
-- 회사 가이드 / FAQ를 청크 단위로 영속화하고 LLM 호출에 컨텍스트로 결합한다.
-- 본 step은 schema만. embedding을 채우는 ingest pipeline은 Step 3에서.
--
-- knowledge_bases (문서 메타)
--   - org_id 종속, RLS FORCE.
--   - source_type: 'manual' (텍스트 직접 입력) / 'file' (텍스트 파일 업로드) /
--     'url' (Phase 6+ 웹 크롤). 본 phase에선 manual + file만 처리.
--   - created_by_user_id는 (org_id, user_id) composite FK로 같은 org의 멤버만 가리킬 수 있음.
--   - soft delete (deleted_at) — Phase 2 customers 패턴 일관.
--
-- knowledge_chunks (청크 + 임베딩)
--   - knowledge_base_id 종속, ON DELETE CASCADE.
--   - org_id 비정규화 (Phase 4 transcripts 패턴) — RLS가 JOIN 없이 평가 가능.
--   - (org_id, knowledge_base_id) composite FK로 cross-org drift 차단.
--   - position은 KB 안에서 0부터 순차 — service ingest 시점에 발급.
--   - embedding은 vector(1536) NULL 허용 (OpenAI ada-002 / text-embedding-3-small 차원).
--     INSERT는 텍스트만 + 임베딩은 Step 3 worker가 사후 UPDATE — 큰 ingest를 작은
--     LLM 호출로 분할할 수 있게 한다.
--   - token_count는 LLM context budget 계산에 사용 (운영 cost 추적).
--
-- vector index (ivfflat, cosine_ops, lists=100)
--   - dev 데이터 규모(<10k chunks)에 적합한 기본값. Phase 6+ 운영 규모에서
--     hnsw 또는 lists 재평가.
--   - ivfflat은 부분 인덱스(WHERE embedding IS NOT NULL)를 일부 pgvector
--     버전에서 거절 — 전체 인덱스로 만들고 검색 query 측에서
--     `WHERE embedding IS NOT NULL`을 함께 건다.

-- Up Migration
-- ============================================================================

-- knowledge_bases ------------------------------------------------------------
CREATE TABLE knowledge_bases (
    id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id             uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title              text        NOT NULL CHECK (length(title) > 0),
    source_type        text        NOT NULL
                            CHECK (source_type IN ('manual','file','url')),
    source_uri         text,
    created_by_user_id uuid,
    deleted_at         timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, id),

    CONSTRAINT knowledge_bases_creator_membership_fk
      FOREIGN KEY (org_id, created_by_user_id)
      REFERENCES memberships(org_id, user_id)
      ON DELETE SET NULL (created_by_user_id)
);

-- touch_updated_at trigger — 이미 customers/calls migration에서 정의된 공유 함수 사용.
CREATE TRIGGER knowledge_bases_touch_updated_at
    BEFORE UPDATE ON knowledge_bases
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- list query 인덱스 (settings.html 회사 가이드 목록, 최근 갱신 순).
CREATE INDEX knowledge_bases_org_updated_idx
    ON knowledge_bases (org_id, updated_at DESC)
    WHERE deleted_at IS NULL;

-- RLS — calls 패턴 일관.
ALTER TABLE knowledge_bases ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_bases FORCE  ROW LEVEL SECURITY;

CREATE POLICY knowledge_bases_select ON knowledge_bases FOR SELECT
    USING (org_id = current_app_org_id());

CREATE POLICY knowledge_bases_insert ON knowledge_bases FOR INSERT
    WITH CHECK (org_id = current_app_org_id());

CREATE POLICY knowledge_bases_update ON knowledge_bases FOR UPDATE
    USING      (org_id = current_app_org_id())
    WITH CHECK (org_id = current_app_org_id());

CREATE POLICY knowledge_bases_delete ON knowledge_bases FOR DELETE
    USING (org_id = current_app_org_id());


-- knowledge_chunks -----------------------------------------------------------
CREATE TABLE knowledge_chunks (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    knowledge_base_id uuid        NOT NULL,
    -- denormalized org_id (Phase 4 transcripts 패턴) — RLS가 JOIN 없이 평가.
    org_id            uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    position          int         NOT NULL CHECK (position >= 0),
    text              text        NOT NULL CHECK (length(text) > 0),
    -- OpenAI ada-002 / text-embedding-3-small 호환 1536d. NULL 허용 (사후 채움).
    embedding         vector(1536),
    token_count       int         CHECK (token_count IS NULL OR token_count > 0),
    created_at        timestamptz NOT NULL DEFAULT now(),

    UNIQUE (knowledge_base_id, position),

    CONSTRAINT knowledge_chunks_kb_same_org_fk
      FOREIGN KEY (org_id, knowledge_base_id)
      REFERENCES knowledge_bases(org_id, id)
      ON DELETE CASCADE
);

-- read index — (knowledge_base_id, position)는 UNIQUE에 의해 자동 생성됨.
-- 명시적 추가 인덱스는 RLS scan + 운영 도구용 (특정 org의 chunk 최신순).
CREATE INDEX knowledge_chunks_org_created_idx
    ON knowledge_chunks (org_id, created_at DESC);

-- vector index — ivfflat + cosine. lists=100은 Phase 5 시점 기본값.
-- 부분 인덱스(WHERE embedding IS NOT NULL)는 일부 pgvector 버전에서 거절하므로
-- 전체 인덱스로 두고 service의 search query가 WHERE embedding IS NOT NULL을
-- 함께 건다.
CREATE INDEX knowledge_chunks_embedding_ivfflat_idx
    ON knowledge_chunks
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

-- RLS
ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunks FORCE  ROW LEVEL SECURITY;

CREATE POLICY knowledge_chunks_select ON knowledge_chunks FOR SELECT
    USING (org_id = current_app_org_id());

CREATE POLICY knowledge_chunks_insert ON knowledge_chunks FOR INSERT
    WITH CHECK (org_id = current_app_org_id());

CREATE POLICY knowledge_chunks_update ON knowledge_chunks FOR UPDATE
    USING      (org_id = current_app_org_id())
    WITH CHECK (org_id = current_app_org_id());

CREATE POLICY knowledge_chunks_delete ON knowledge_chunks FOR DELETE
    USING (org_id = current_app_org_id());


-- Down Migration
-- ============================================================================

DROP POLICY IF EXISTS knowledge_chunks_delete ON knowledge_chunks;
DROP POLICY IF EXISTS knowledge_chunks_update ON knowledge_chunks;
DROP POLICY IF EXISTS knowledge_chunks_insert ON knowledge_chunks;
DROP POLICY IF EXISTS knowledge_chunks_select ON knowledge_chunks;
DROP TABLE IF EXISTS knowledge_chunks;

DROP POLICY IF EXISTS knowledge_bases_delete ON knowledge_bases;
DROP POLICY IF EXISTS knowledge_bases_update ON knowledge_bases;
DROP POLICY IF EXISTS knowledge_bases_insert ON knowledge_bases;
DROP POLICY IF EXISTS knowledge_bases_select ON knowledge_bases;
DROP TRIGGER IF EXISTS knowledge_bases_touch_updated_at ON knowledge_bases;
DROP TABLE IF EXISTS knowledge_bases;

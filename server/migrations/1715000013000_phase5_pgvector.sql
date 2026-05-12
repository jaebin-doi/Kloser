-- Phase 5 Step 1 — pgvector extension activation.
-- Plan: docs/plan/phase-5/PHASE_5_STEP_1_SCHEMA.md §2.3.
-- Master: docs/plan/phase-5/PHASE_5_MASTER.md §1 (schema list).
--
-- 본 migration은 `vector` extension만 활성화한다. knowledge_chunks.embedding
-- 컬럼은 다음 migration (1715000014000_phase5_knowledge.sql)에서 도입.
--
-- Docker image: ops/docker-compose.yml은 `pgvector/pgvector:pg16`로 운영한다.
-- 기본 `postgres:16-alpine`은 vector 라이브러리가 없어 `CREATE EXTENSION
-- vector`가 실패하므로 image 교체가 선행 조건이다.
--
-- Down은 의도적으로 extension을 drop하지 않는다 — vector 컬럼을 가진 다른
-- 테이블이 같은 DB에 있을 수 있고 (Phase 6+ 별 트랙), 환경 재현 시 부수효과를
-- 피한다. extension 자체를 강제로 빼야 한다면 운영자가 수동으로
-- `DROP EXTENSION vector` 호출 (단, 종속 객체 cascade 영향 확인 후).

-- Up Migration
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;


-- Down Migration
-- ============================================================================

-- intentionally no-op (see header). Extension은 같은 DB의 다른 트랙도 사용
-- 가능하므로 본 migration의 down은 noop으로 둔다.
SELECT 1;

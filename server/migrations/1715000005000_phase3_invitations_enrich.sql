-- Phase 3 Step 1 — invitations 토큰 컬럼 제거 + 메타 4종 + 파셜 유니크.
-- Plan: docs/plan/phase-3/PHASE_3_STEP_1_SCHEMA.md §5.
--
-- 의도:
--   - 토큰은 별도 auth_tokens.invitation_id로 정규화 (Master §2-4 결정).
--     재발송 시 invitations 행 유지 + 새 auth_tokens 행 추가 + 옛 토큰
--     consumed_at 또는 invalidated_at 처리. 1초대 N토큰 lifecycle 분리.
--   - team_id로 초대 시 팀 지정 (NULL 허용 — 미배정 초대).
--   - invited_by_user_id로 감사 trail.
--   - canceled_at으로 soft cancel.
--   - last_sent_at으로 재발송 시점 기록 (rate-limit·UI 표시).
--   - (org_id, lower(email)) 파셜 유니크로 활성 초대 1개만 허용.
--     만료된 pending은 인덱스에 남는다 — 만료 후 재초대 흐름은 서비스
--     트랜잭션이 옛 행을 canceled_at 처리한 뒤 새 행 insert (plan §8).
--
-- 현재 invitations 시드/운영 행 0건 → token_hash/expires_at DROP COLUMN 안전.

-- Up Migration
-- ============================================================================

-- 1) 토큰 인덱스 먼저 drop — 컬럼 drop이 의존 객체를 cascade하지 않도록.
DROP INDEX IF EXISTS invitations_token_hash_idx;

-- 2) 토큰 컬럼 drop. auth_tokens.invitation_id로 정규화됨.
ALTER TABLE invitations DROP COLUMN IF EXISTS token_hash;
ALTER TABLE invitations DROP COLUMN IF EXISTS expires_at;

-- 3) 메타 컬럼 4종 추가.
ALTER TABLE invitations
  ADD COLUMN team_id              uuid REFERENCES teams(id) ON DELETE SET NULL,
  ADD COLUMN invited_by_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN canceled_at          timestamptz,
  ADD COLUMN last_sent_at         timestamptz NOT NULL DEFAULT now();

-- 4) 활성 초대 (org, lower(email)) 파셜 유니크.
--    expired pending은 본 인덱스에서 빠지지 않음 — 만료 후 재초대 흐름은
--    서비스 트랜잭션이 옛 행을 canceled_at 처리한 뒤 새 행 생성 (plan §8).
--    partial index에 expires_at < now()를 박으면 immutable 요구 위반.
CREATE UNIQUE INDEX invitations_active_org_email_idx
  ON invitations (org_id, lower(email::text))
  WHERE accepted_at IS NULL AND canceled_at IS NULL;

-- 5) 운영 lookup용 보조 인덱스 — 활성 초대 목록 (admin 조회)에 사용.
CREATE INDEX invitations_org_active_created_idx
  ON invitations (org_id, created_at DESC)
  WHERE accepted_at IS NULL AND canceled_at IS NULL;


-- Down Migration
-- ============================================================================
--
-- dev rollback (migrate:redo) 대응. Phase 1 형상 (token_hash/expires_at
-- NOT NULL without default)으로 환원하되, 이미 적재된 시드 행이 있을 수
-- 있어 DEFAULT 값으로 backfill한 뒤 DROP DEFAULT로 표면 정리한다.
-- 운영 환경 forward-only 원칙(Master §6-5)이라 본 down은 dev 검증용.

DROP INDEX IF EXISTS invitations_org_active_created_idx;
DROP INDEX IF EXISTS invitations_active_org_email_idx;

ALTER TABLE invitations
  DROP COLUMN IF EXISTS last_sent_at,
  DROP COLUMN IF EXISTS canceled_at,
  DROP COLUMN IF EXISTS invited_by_user_id,
  DROP COLUMN IF EXISTS team_id;

ALTER TABLE invitations
  ADD COLUMN expires_at  timestamptz NOT NULL DEFAULT now() + interval '7 days',
  ADD COLUMN token_hash  text        NOT NULL DEFAULT '';

CREATE INDEX invitations_token_hash_idx ON invitations(token_hash);

-- Default 제거 — Phase 1 시점과 같은 NOT NULL without default 상태로 환원.
ALTER TABLE invitations
  ALTER COLUMN expires_at DROP DEFAULT,
  ALTER COLUMN token_hash DROP DEFAULT;

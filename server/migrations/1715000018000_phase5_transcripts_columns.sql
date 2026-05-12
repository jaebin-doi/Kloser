-- Phase 5 Step 1 — transcripts 컬럼 2개 추가 (STT 메타).
-- Plan: docs/plan/phase-5/PHASE_5_STEP_1_SCHEMA.md §9, §2.5.
-- Master: docs/plan/phase-5/PHASE_5_MASTER.md §5.7.
--
-- 실 STT (Phase 5 Step 3) 도입 시 어느 provider가 어느 session에서 발화를
-- 적층했는지 추적 가능하게. retry / replay / 디버깅에 사용.
--
-- 둘 다 NULL 허용 (Phase 4 기존 row + Phase 0.5 fixture는 NULL 유지).
--
-- stt_provider enum
--   - 'clova'    — Naver Clova Speech (Phase 5 primary)
--   - 'whisper'  — OpenAI Whisper (대안)
--   - 'manual'   — REST POST /calls/:id/transcript로 사용자 / 운영 도구가 직접 INSERT
--   - 'fixture'  — Phase 0.5 데모 시퀀스 (server fixture)
--
-- stt_session_id
--   - free-form text. Clova session id 또는 자체 발급 UUID. provider별로 형식 다양.

-- Up Migration
-- ============================================================================

ALTER TABLE transcripts
    ADD COLUMN stt_provider    text,
    ADD COLUMN stt_session_id  text;

ALTER TABLE transcripts
    ADD CONSTRAINT transcripts_stt_provider_check
      CHECK (
        stt_provider IS NULL OR
        stt_provider IN ('clova','whisper','manual','fixture')
      );


-- Down Migration
-- ============================================================================

ALTER TABLE transcripts
    DROP CONSTRAINT IF EXISTS transcripts_stt_provider_check;

ALTER TABLE transcripts
    DROP COLUMN IF EXISTS stt_session_id,
    DROP COLUMN IF EXISTS stt_provider;

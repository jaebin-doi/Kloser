-- Phase 5 Step 1 — calls 컬럼 6개 추가 + heartbeat sweep 부분 인덱스.
-- Plan: docs/plan/phase-5/PHASE_5_STEP_1_SCHEMA.md §8.
-- Master: docs/plan/phase-5/PHASE_5_MASTER.md §5.6.
--
-- 통화 메타를 보강. Phase 4 기존 컬럼은 손대지 않고 ADD COLUMN만.
-- 모든 신규 컬럼 NULL 허용 (Phase 4 호환).
--
-- summary_generated_at / summary_source
--   - AI 자동 요약 워커가 endCall 직후 채운다 (Phase 5 §2 결정 8 — graceful
--     degradation: LLM 실패 시 NULL 유지).
--   - source='manual'은 사용자 수동 입력 — AI 워커가 사후에 덮어쓰지 않도록
--     service layer guard에서 사용.
--
-- last_seen_at / dropped_reason
--   - WS heartbeat (20s 주기, Step 3에서 wire)가 last_seen_at 갱신.
--   - sweep cron이 60s cutoff로 status='in_progress' AND last_seen_at < $cutoff
--     를 status='dropped', dropped_reason='server_timeout'으로 마킹.
--   - dropped_reason='browser_disconnect'는 WS disconnect 핸들러가, 'manual'은
--     향후 admin 강제 종료가 set.
--
-- customer_linked_at / customer_linked_by_user_id
--   - live.html customer picker로 통화에 고객을 link한 시각·주체.
--   - 같은 org composite FK로 cross-org 사용자가 link하는 행을 차단.
--
-- 부분 인덱스 calls_in_progress_seen_idx
--   - heartbeat sweep query (`WHERE status='in_progress' AND deleted_at IS NULL
--     AND last_seen_at < $cutoff`)가 이 인덱스만 스캔.

-- Up Migration
-- ============================================================================

ALTER TABLE calls
    ADD COLUMN summary_generated_at        timestamptz,
    ADD COLUMN summary_source              text,
    ADD COLUMN last_seen_at                timestamptz,
    ADD COLUMN dropped_reason              text,
    ADD COLUMN customer_linked_at          timestamptz,
    ADD COLUMN customer_linked_by_user_id  uuid;

ALTER TABLE calls
    ADD CONSTRAINT calls_summary_source_check
      CHECK (summary_source IS NULL OR summary_source IN ('ai','manual'));

ALTER TABLE calls
    ADD CONSTRAINT calls_dropped_reason_check
      CHECK (dropped_reason IS NULL OR dropped_reason IN ('browser_disconnect','server_timeout','manual'));

ALTER TABLE calls
    ADD CONSTRAINT calls_customer_linked_by_membership_fk
      FOREIGN KEY (org_id, customer_linked_by_user_id)
      REFERENCES memberships(org_id, user_id)
      ON DELETE SET NULL (customer_linked_by_user_id);

-- heartbeat sweep 부분 인덱스.
CREATE INDEX calls_in_progress_seen_idx
    ON calls (last_seen_at)
    WHERE status = 'in_progress' AND deleted_at IS NULL;


-- Down Migration
-- ============================================================================

DROP INDEX IF EXISTS calls_in_progress_seen_idx;

ALTER TABLE calls
    DROP CONSTRAINT IF EXISTS calls_customer_linked_by_membership_fk,
    DROP CONSTRAINT IF EXISTS calls_dropped_reason_check,
    DROP CONSTRAINT IF EXISTS calls_summary_source_check;

ALTER TABLE calls
    DROP COLUMN IF EXISTS customer_linked_by_user_id,
    DROP COLUMN IF EXISTS customer_linked_at,
    DROP COLUMN IF EXISTS dropped_reason,
    DROP COLUMN IF EXISTS last_seen_at,
    DROP COLUMN IF EXISTS summary_source,
    DROP COLUMN IF EXISTS summary_generated_at;

-- Phase 3 Step 1 — phase 3 demo seed.
-- Plan: docs/plan/phase-3/PHASE_3_STEP_1_SCHEMA.md §9.
--
-- Acme (org 11111111-...) 한 곳에만 데이터를 박는다:
--   - live invitation 1   + 짝 auth_token 1 (활성, expires_at = now()+5d)
--   - expired invitation 1 + 짝 auth_token 1 (만료, expires_at = now()-1d)
--   - email_outbox 샘플 1 (invitation template, live 초대를 가리킴)
--
-- Beta org에는 두지 않는다 — RLS 격리 검증 (plan §10 #10)이 시각적으로
-- 분명해지도록 의도적으로 비워 둔다.
--
-- 만료 정의: pending 초대는 자신의 활성 invitation 토큰의 expires_at으로 판정
-- 한다 (plan §8 정책). invitations.expires_at 컬럼은 §5에서 제거됐다.
--
-- Deterministic UUID prefix:
--   - invitations.id : 1ff11111-... (live), 1ff22222-... (expired)
--   - auth_tokens.id : 77111111-... (live), 77222222-... (expired)
--   - email_outbox.id: 88011111-... (sample)
--
-- Idempotent: ON CONFLICT (id) DO UPDATE — re-running db:seed refreshes rows.
--
-- ★ Raw token 평문 (dev 디버깅 reference, e2e는 직접 사용 안 함):
--     active : phase3-seed-active-invitation-token
--     expired: phase3-seed-expired-invitation-token
--   sha256 hex가 auth_tokens.token_hash 컬럼에 저장됨. raw는 outbox 본문/
--   metadata에도 평문으로 함께 들어간다 (dev 한정 의도된 노출, plan §7).

BEGIN;

-- ============================================================================
-- invitations (Acme — org 11111111-1111-1111-1111-111111111111)
-- ============================================================================

SET LOCAL app.org_id = '11111111-1111-1111-1111-111111111111';

-- live pending invitation. role=employee. last_sent_at = now().
INSERT INTO invitations (
    id, org_id, email, role,
    accepted_at, canceled_at,
    team_id, invited_by_user_id, last_sent_at, created_at
)
VALUES (
    '1ff11111-1111-1111-1111-111111111111',
    '11111111-1111-1111-1111-111111111111',
    'pending-invitee@acme.test',
    'employee',
    NULL, NULL,
    NULL,
    'aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa',     -- invited by acme admin
    now(),
    now()
)
ON CONFLICT (id) DO UPDATE SET
    org_id             = EXCLUDED.org_id,
    email              = EXCLUDED.email,
    role               = EXCLUDED.role,
    accepted_at        = EXCLUDED.accepted_at,
    canceled_at        = EXCLUDED.canceled_at,
    team_id            = EXCLUDED.team_id,
    invited_by_user_id = EXCLUDED.invited_by_user_id,
    last_sent_at       = EXCLUDED.last_sent_at;

-- expired pending invitation. role=viewer. last_sent_at은 8일 전.
-- invitations.row 자체는 살아있는 pending — expired 여부는 짝 토큰 (아래) 으로
-- 결정됨 (plan §8 정책).
INSERT INTO invitations (
    id, org_id, email, role,
    accepted_at, canceled_at,
    team_id, invited_by_user_id, last_sent_at, created_at
)
VALUES (
    '1ff22222-2222-2222-2222-222222222222',
    '11111111-1111-1111-1111-111111111111',
    'expired-invitee@acme.test',
    'viewer',
    NULL, NULL,
    NULL,
    'aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa',     -- invited by acme admin
    now() - interval '8 days',
    now() - interval '8 days'
)
ON CONFLICT (id) DO UPDATE SET
    org_id             = EXCLUDED.org_id,
    email              = EXCLUDED.email,
    role               = EXCLUDED.role,
    accepted_at        = EXCLUDED.accepted_at,
    canceled_at        = EXCLUDED.canceled_at,
    team_id            = EXCLUDED.team_id,
    invited_by_user_id = EXCLUDED.invited_by_user_id,
    last_sent_at       = EXCLUDED.last_sent_at;

-- ============================================================================
-- auth_tokens — purpose='invitation' 활성·만료 토큰 1+1
-- ============================================================================
-- raw token hashes (sha256 hex of the raw strings in the top comment):
--   active : a7c2edcd6a3f5fc80382e5db7893f54ab4db6ad5f0593cfe68f98466ebeccf21
--   expired: d801cd086393ac15f12a63352269d9972838c64a3af294aca5e74f5c7a99eca7

-- live invitation의 활성 토큰. expires_at = now() + 5d. consumed/invalidated NULL.
INSERT INTO auth_tokens (
    id, org_id, user_id, invitation_id, purpose,
    token_hash, expires_at, consumed_at, invalidated_at, created_at
)
VALUES (
    '77111111-1111-1111-1111-111111111111',
    '11111111-1111-1111-1111-111111111111',
    NULL,                                       -- invitation purpose는 user_id NULL (CHECK)
    '1ff11111-1111-1111-1111-111111111111',
    'invitation',
    'a7c2edcd6a3f5fc80382e5db7893f54ab4db6ad5f0593cfe68f98466ebeccf21',
    now() + interval '5 days',
    NULL, NULL,
    now()
)
ON CONFLICT (id) DO UPDATE SET
    org_id         = EXCLUDED.org_id,
    user_id        = EXCLUDED.user_id,
    invitation_id  = EXCLUDED.invitation_id,
    purpose        = EXCLUDED.purpose,
    token_hash     = EXCLUDED.token_hash,
    expires_at     = EXCLUDED.expires_at,
    consumed_at    = EXCLUDED.consumed_at,
    invalidated_at = EXCLUDED.invalidated_at;

-- expired invitation의 만료 토큰. expires_at = now() - 1d. consumed/invalidated
-- 여전히 NULL — 토큰은 시간으로만 만료된 상태. §8 정책상 expired pending.
INSERT INTO auth_tokens (
    id, org_id, user_id, invitation_id, purpose,
    token_hash, expires_at, consumed_at, invalidated_at, created_at
)
VALUES (
    '77222222-2222-2222-2222-222222222222',
    '11111111-1111-1111-1111-111111111111',
    NULL,
    '1ff22222-2222-2222-2222-222222222222',
    'invitation',
    'd801cd086393ac15f12a63352269d9972838c64a3af294aca5e74f5c7a99eca7',
    now() - interval '1 day',
    NULL, NULL,
    now() - interval '8 days'
)
ON CONFLICT (id) DO UPDATE SET
    org_id         = EXCLUDED.org_id,
    user_id        = EXCLUDED.user_id,
    invitation_id  = EXCLUDED.invitation_id,
    purpose        = EXCLUDED.purpose,
    token_hash     = EXCLUDED.token_hash,
    expires_at     = EXCLUDED.expires_at,
    consumed_at    = EXCLUDED.consumed_at,
    invalidated_at = EXCLUDED.invalidated_at;

-- ============================================================================
-- email_outbox — invitation 발송 샘플 1건 (live 초대 가리킴)
-- ============================================================================
-- body_text/metadata에 raw token 평문 포함 — dev 한정 의도된 노출 (plan §7).

INSERT INTO email_outbox (
    id, org_id, to_email, subject, body_text, body_html, template, metadata,
    delivered_at, failed_at, error_message, created_at
)
VALUES (
    '88011111-1111-1111-1111-111111111111',
    '11111111-1111-1111-1111-111111111111',
    'pending-invitee@acme.test',
    '[Kloser] Acme Sales Inc. 팀에 초대되었습니다',
    E'안녕하세요,\n\n에이스 어드민이 Acme Sales Inc. 팀에 회원님을 초대했습니다.\n\n아래 링크에서 7일 안에 수락해주세요:\nhttps://kloser.local/platform/accept-invitation.html?token=phase3-seed-active-invitation-token\n\n— Kloser',
    NULL,
    'invitation',
    jsonb_build_object(
      'invitation_id', '1ff11111-1111-1111-1111-111111111111',
      'acceptUrl',     'https://kloser.local/platform/accept-invitation.html?token=phase3-seed-active-invitation-token'
    ),
    now(),
    NULL, NULL,
    now()
)
ON CONFLICT (id) DO UPDATE SET
    org_id        = EXCLUDED.org_id,
    to_email      = EXCLUDED.to_email,
    subject       = EXCLUDED.subject,
    body_text     = EXCLUDED.body_text,
    body_html     = EXCLUDED.body_html,
    template      = EXCLUDED.template,
    metadata      = EXCLUDED.metadata,
    delivered_at  = EXCLUDED.delivered_at,
    failed_at     = EXCLUDED.failed_at,
    error_message = EXCLUDED.error_message;

COMMIT;

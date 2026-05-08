-- Phase 2 Step 1 — customers seed.
--
-- Two organizations, twelve customers each = 24 rows.
--   Acme  : matches platform/customers.html mock 1:1 so the live page
--           visually equals the demo immediately after wiring.
--   Beta  : different names / companies so cross-org isolation is
--           visually obvious when an evaluator switches accounts.
--
-- assigned_user_id is NULL for every row — Phase 2 permission policy is
-- org-wide for admin/manager/employee, so a non-NULL seed would suggest
-- a team-scope rule that doesn't exist yet (Phase 3).
--
-- Deterministic UUIDs (eeee-* for Acme rows, ffff-* for Beta rows) so
-- tests can reference specific customer IDs without lookups. Phase 1's
-- 0001_demo.sql already used 'aaaa' for users and 'cccc' for memberships;
-- we reserve 'eeee'/'ffff' here for customers to avoid any collision with
-- prior seed conventions.
--
-- Idempotent: ON CONFLICT (id) DO UPDATE so re-running `npm run db:seed`
-- after editing fixture data (status / contact times) refreshes the rows
-- in place.
--
-- last_contacted_at is set as `now() - interval '...'` so the relative-
-- time labels in the UI ("2시간 전", "어제") look natural without anchor
-- dates becoming stale across machines.
--
-- `plan` column was removed in 1715000003000_drop_customers_plan.sql —
-- it collided with `organizations.plan` (Kloser tenant subscription).
-- Customer/lead rows no longer carry a Kloser plan attribute. Lifecycle
-- staging will be reintroduced under a different name later.

BEGIN;

-- Acme (org 11111111-1111-1111-1111-111111111111) — 12 customers.
-- Mirrors platform/customers.html mock data.
INSERT INTO customers (id, org_id, name, company, email, phone, status, last_contacted_at)
VALUES
    ('eeeeeeee-1111-0001-0001-eeeeeeeeeeee', '11111111-1111-1111-1111-111111111111',
     '김민수', 'Kloser Inc.',  'kim@kloser.com',     '010-1234-5678', 'active',  now() - interval '2 hours'),
    ('eeeeeeee-1111-0002-0002-eeeeeeeeeeee', '11111111-1111-1111-1111-111111111111',
     '이지은', 'DesignCo.',    'lee@designco.kr',    '010-2345-6789', 'review',  now() - interval '5 hours'),
    ('eeeeeeee-1111-0003-0003-eeeeeeeeeeee', '11111111-1111-1111-1111-111111111111',
     '박서준', 'Nexus Lab',    'park@nexuslab.io',   '010-3456-7890', 'active',  now() - interval '6 hours'),
    ('eeeeeeee-1111-0004-0004-eeeeeeeeeeee', '11111111-1111-1111-1111-111111111111',
     '정유진', 'TerraBase',    'jung@terrabase.kr',  '010-4567-8901', 'active',  now() - interval '7 hours'),
    ('eeeeeeee-1111-0005-0005-eeeeeeeeeeee', '11111111-1111-1111-1111-111111111111',
     '최서연', 'OrbitLab',     'choi@orbitlab.com',  '010-5678-9012', 'pending', now() - interval '1 day'),
    ('eeeeeeee-1111-0006-0006-eeeeeeeeeeee', '11111111-1111-1111-1111-111111111111',
     '강지훈', 'SkyNode',      'kang@skynode.kr',    '010-6789-0123', 'active',  now() - interval '1 day 4 hours'),
    ('eeeeeeee-1111-0007-0007-eeeeeeeeeeee', '11111111-1111-1111-1111-111111111111',
     '한수민', 'GridWorks',    'han@gridworks.io',   '010-7890-1234', 'review',  now() - interval '2 days'),
    ('eeeeeeee-1111-0008-0008-eeeeeeeeeeee', '11111111-1111-1111-1111-111111111111',
     '윤서아', 'MapCore',      'yoon@mapcore.kr',    '010-8901-2345', 'active',  now() - interval '2 days 3 hours'),
    ('eeeeeeee-1111-0009-0009-eeeeeeeeeeee', '11111111-1111-1111-1111-111111111111',
     '조성훈', 'DOI',          'cjb@doi-kr.com',     '010-9012-3456', 'active',  now() - interval '3 days'),
    ('eeeeeeee-1111-0010-0010-eeeeeeeeeeee', '11111111-1111-1111-1111-111111111111',
     '신예린', 'DataFlow',     'shin@dataflow.kr',   '010-0123-4567', 'pending', now() - interval '7 days'),
    ('eeeeeeee-1111-0011-0011-eeeeeeeeeeee', '11111111-1111-1111-1111-111111111111',
     '오민재', 'Pulsar',       'oh@pulsar.io',       '010-1357-2468', 'review',  now() - interval '8 days'),
    ('eeeeeeee-1111-0012-0012-eeeeeeeeeeee', '11111111-1111-1111-1111-111111111111',
     '임채영', 'Helix Group',  'lim@helix.co',       '010-2468-1357', 'active',  now() - interval '14 days')
ON CONFLICT (id) DO UPDATE SET
    name              = EXCLUDED.name,
    company           = EXCLUDED.company,
    email             = EXCLUDED.email,
    phone             = EXCLUDED.phone,
    status            = EXCLUDED.status,
    last_contacted_at = EXCLUDED.last_contacted_at,
    updated_at        = now();

-- Beta (org 22222222-2222-2222-2222-222222222222) — 12 customers.
-- Different names + companies to make cross-org isolation visually obvious.
INSERT INTO customers (id, org_id, name, company, email, phone, status, last_contacted_at)
VALUES
    ('ffffffff-2222-0001-0001-ffffffffffff', '22222222-2222-2222-2222-222222222222',
     '정승호', 'Beta Soft',      'jung@betasoft.kr',     '010-1111-2222', 'active',  now() - interval '3 hours'),
    ('ffffffff-2222-0002-0002-ffffffffffff', '22222222-2222-2222-2222-222222222222',
     '이채린', 'Vector Studio',  'lee@vector.io',        '010-2222-3333', 'active',  now() - interval '6 hours'),
    ('ffffffff-2222-0003-0003-ffffffffffff', '22222222-2222-2222-2222-222222222222',
     '박재훈', 'NorthBridge',    'park@northbridge.com', '010-3333-4444', 'pending', now() - interval '12 hours'),
    ('ffffffff-2222-0004-0004-ffffffffffff', '22222222-2222-2222-2222-222222222222',
     '김수아', 'Lumix',          'kim@lumix.kr',         '010-4444-5555', 'review',  now() - interval '18 hours'),
    ('ffffffff-2222-0005-0005-ffffffffffff', '22222222-2222-2222-2222-222222222222',
     '최민준', 'Coral Networks', 'choi@coral.io',        '010-5555-6666', 'active',  now() - interval '1 day 2 hours'),
    ('ffffffff-2222-0006-0006-ffffffffffff', '22222222-2222-2222-2222-222222222222',
     '강하늘', 'PlasmaCore',     'kang@plasmacore.com',  '010-6666-7777', 'active',  now() - interval '1 day 8 hours'),
    ('ffffffff-2222-0007-0007-ffffffffffff', '22222222-2222-2222-2222-222222222222',
     '윤성준', 'Zenith Labs',    'yoon@zenith.kr',       '010-7777-8888', 'review',  now() - interval '2 days'),
    ('ffffffff-2222-0008-0008-ffffffffffff', '22222222-2222-2222-2222-222222222222',
     '한지민', 'Cobalt Group',   'han@cobalt.io',        '010-8888-9999', 'pending', now() - interval '3 days'),
    ('ffffffff-2222-0009-0009-ffffffffffff', '22222222-2222-2222-2222-222222222222',
     '조유나', 'Nimbus Tech',    'jo@nimbus.com',        '010-9999-0000', 'active',  now() - interval '4 days'),
    ('ffffffff-2222-0010-0010-ffffffffffff', '22222222-2222-2222-2222-222222222222',
     '신우진', 'Quartz Inc.',    'shin@quartz.kr',       '010-0000-1111', 'active',  now() - interval '5 days'),
    ('ffffffff-2222-0011-0011-ffffffffffff', '22222222-2222-2222-2222-222222222222',
     '오재민', 'Helio Systems',  'oh@helio.io',          '010-1234-9876', 'review',  now() - interval '9 days'),
    ('ffffffff-2222-0012-0012-ffffffffffff', '22222222-2222-2222-2222-222222222222',
     '임소연', 'Vertex Co.',     'lim@vertex.com',       '010-9876-1234', 'active',  now() - interval '13 days')
ON CONFLICT (id) DO UPDATE SET
    name              = EXCLUDED.name,
    company           = EXCLUDED.company,
    email             = EXCLUDED.email,
    phone             = EXCLUDED.phone,
    status            = EXCLUDED.status,
    last_contacted_at = EXCLUDED.last_contacted_at,
    updated_at        = now();

COMMIT;

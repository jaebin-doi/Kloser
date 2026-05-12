# Phase 4 — Step 1 Findings

> **완료일**: 2026-05-12
> **범위**: schema-only. `calls` / `transcripts` / `call_action_items` 테이블, RLS, 인덱스, app role grants. Demo seed는 후속 step에서 결정한다.

---

## 1. 적용 파일

- 신규 migration (4): `server/migrations/1715000009000_phase4_calls.sql` · `server/migrations/1715000010000_phase4_transcripts.sql` · `server/migrations/1715000011000_phase4_call_action_items.sql` · `server/migrations/1715000012000_phase4_app_grants.sql`
- 수정 문서 (2): `docs/plan/phase-4/PHASE_4_MASTER.md` · `docs/plan/phase-4/PHASE_4_STEP_1_SCHEMA.md`

---

## 2. 핵심 구현

1. `calls`는 org-scoped 통화 세션 root table이다. `org_id` RLS, `deleted_at` soft delete, direction/status/sentiment CHECK, `touch_updated_at()` trigger, 4개 partial index를 둔다.
2. `transcripts`는 append-only 발화 table이다. `updated_at`/trigger를 두지 않고, `UNIQUE (call_id, seq)`로 통화 내 발화 순서를 강제한다.
3. `call_action_items`는 통화 후 액션 table이다. `status='done'`이면 `completed_at IS NOT NULL`, open/dropped이면 `completed_at IS NULL`을 CHECK로 강제한다.
4. `app` role grant는 별도 migration으로 명시했다. dev init의 default privileges에 의존하지 않고 기존 DB에서도 권한 계약이 재현되게 하기 위함이다.

---

## 3. Codex 보강 사항

Claude 초안은 단일-column FK 중심이라 cross-org 오염 여지가 있었다. 최종안은 DB 레벨에서 같은 org 참조를 강제한다.

- `calls.customer_id`: `(org_id, customer_id) REFERENCES customers(org_id, id) ON DELETE SET NULL (customer_id)`
- `calls.agent_user_id`: `(org_id, agent_user_id) REFERENCES memberships(org_id, user_id) ON DELETE SET NULL (agent_user_id)`
- `transcripts.call_id`: `(org_id, call_id) REFERENCES calls(org_id, id) ON DELETE CASCADE`
- `call_action_items.call_id`: `(org_id, call_id) REFERENCES calls(org_id, id) ON DELETE CASCADE`
- `call_action_items.assignee_user_id`: `(org_id, assignee_user_id) REFERENCES memberships(org_id, user_id) ON DELETE SET NULL (assignee_user_id)`

`customers`에는 composite FK target을 위해 `customers_org_id_id_unique UNIQUE (org_id, id)`를 추가했다. `customers.id`는 이미 전역 unique라 논리적으로 중복이지만, PostgreSQL composite FK에는 정확히 일치하는 unique/PK가 필요하다.

---

## 4. 검증

- fresh temp DB `migrate up` PASS
- temp DB `db:seed` PASS
- Phase 4 down 4회 후 up 재적용 PASS
- RLS FORCE: 3/3 table true
- RLS policies: 3 tables x 4 policies = 12
- app grants: 3 tables x 4 privileges = 12
- runtime semantic checks PASS:
  - Beta GUC로 Acme call insert → `42501`
  - Acme call이 Beta customer를 참조 → `23503`
  - Acme call이 Beta agent를 참조 → `23503`
  - transcript org drift → `23503`
  - action item done without completed_at → `23514`
  - action item Beta assignee → `23503`
- `npm --prefix server run typecheck` PASS
- `node test/sync_shared_types.mjs` PASS
- `npm --prefix server test` PASS (155/155)
- `node test/phase_0_5_e2e.mjs` PASS (16/16)
- `node test/phase_3_e2e.mjs` PASS (33 assertions)

`node test/phase_2_customers_e2e.mjs`는 현재 local `kloser_dev`가 seed-only 상태가 아니라 고객 row가 추가로 남아 있어 count 기반 검증이 왜곡될 수 있다. 사용자 데이터일 수 있으므로 임의 삭제하지 않았다.

---

## 5. 인계

- Step 2 repository plan에서 `transcripts.seq` 발급 방식을 결정해야 한다. 후보는 transaction 안의 `MAX(seq)+1`, advisory lock, 또는 별도 per-call counter이다.
- `customers.last_contacted_at` 갱신은 Step 1 schema 변경이 아니라 Step 2/3 service transaction 책임이다.
- Demo seed는 이번 schema-only 작업에서 제외했다. routes/UI가 실제로 요구하는 fixture shape가 확정된 뒤 `0004_phase4_demo.sql`을 설계하는 편이 낫다.

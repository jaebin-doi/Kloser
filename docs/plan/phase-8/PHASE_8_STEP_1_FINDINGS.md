# Phase 8 Step 1 Findings - `call_recordings` Metadata Schema

작성일: 2026-05-18

상위 문서: `PHASE_8_MASTER.md`
계획 문서: `PHASE_8_STEP_1_PLAN.md`

---

## 1. 결과 요약

Phase 8 Step 1은 schema migration only로 닫았다.

신규 migration:

- `server/migrations/1715000028000_phase8_call_recordings.sql`

문서:

- `docs/plan/phase-8/PHASE_8_MASTER.md`
- `docs/plan/phase-8/PHASE_8_STEP_1_PLAN.md`
- `docs/plan/phase-8/PHASE_8_STEP_1_FINDINGS.md`
- `README.md`

Step 1에서는 repository, route, shared type, frontend, storage SDK를 만들지 않았다. Phase Workflow에 맞춰 다음 step에서 repository/RLS tests와 storage adapter boundary를 다룬다.

---

## 2. Schema

새 테이블:

- `call_recordings`

핵심 columns:

- `id`
- `org_id`
- `call_id`
- `status`
- `storage_provider`
- `storage_bucket`
- `object_key`
- `object_version`
- `content_type`
- `codec`
- `duration_seconds`
- `size_bytes`
- `checksum_sha256`
- `recorded_at`
- `uploaded_at`
- `retention_delete_after`
- `deleted_at`
- `error_message`
- `metadata`
- `created_at`
- `updated_at`

중요 constraints:

- `FOREIGN KEY (org_id, call_id) REFERENCES calls(org_id, id) ON DELETE CASCADE`
- `UNIQUE (org_id, id)`
- `UNIQUE (org_id, object_key)`
- `status IN ('upload_pending','uploaded','processing','available','delete_pending','deleted','failed')`
- `storage_provider IN ('local','s3','minio')`
- `content_type IN ('audio/webm','audio/ogg','audio/mpeg','audio/mp4','audio/wav')`
- `checksum_sha256`는 lowercase 64-char hex 또는 NULL
- `metadata`는 JSON object
- `status='deleted'`면 `deleted_at IS NOT NULL`

RLS:

- `ENABLE ROW LEVEL SECURITY`
- `FORCE ROW LEVEL SECURITY`
- SELECT / INSERT / UPDATE / DELETE 모두 `org_id = current_app_org_id()`

Grant:

- `GRANT SELECT, INSERT, UPDATE, DELETE ON call_recordings TO app`

Indexes:

- `call_recordings_org_call_created_idx`
- `call_recordings_org_status_idx`
- `call_recordings_org_retention_idx`

Trigger:

- `call_recordings_touch_updated_at` reuses existing `touch_updated_at()`.

---

## 3. Design Decisions

### 3.1 Metadata only

DB에는 audio bytes, signed URL, provider credentials를 저장하지 않는다. `object_key`는 내부 locator이며 frontend/audit에 그대로 노출하지 않는다.

### 3.2 One call can have multiple recording rows

Step 1에서는 `(org_id, call_id)` partial unique constraint를 두지 않았다.

이유:

- failed upload retry
- replacement upload
- future segmented recording
- deleted/tombstoned history

초기 제품에서 "한 call에 available recording 하나"가 필요하면 Step 3 service layer에서 enforcing한다.

### 3.3 Retention-ready

`retention_delete_after`와 `uploaded_at`을 함께 둔다. Phase 8 Step 5 retention worker는 명시 cutoff가 있으면 `retention_delete_after`, 없으면 `uploaded_at + 90 days` 정책 중 하나를 Step 5 plan에서 확정한다.

### 3.4 DELETE grant 유지

Step 1 table은 DELETE policy/grant를 가진다. 사용자-facing route는 soft delete를 선택할 수 있지만, retention worker는 object delete 후 metadata hard delete가 필요할 수 있다. 실제 삭제 방식은 Step 5에서 확정한다.

---

## 4. Verification

실행:

```powershell
npm --prefix server run db:migrate:up
npm --prefix server run typecheck
node test/sync_shared_types.mjs
npx tsx --test test/dashboard_routes.test.mjs
npm --prefix server test
git diff --check
```

결과:

- migration applied: PASS
- typecheck: PASS
- shared type sync: PASS, 변경 없음
- dashboard routes targeted rerun: PASS, 8/8
- full server test: PASS, 772 total / 769 pass / 3 skipped / 0 fail
- diff check: PASS

추가 RLS smoke (app role, transaction rollback):

```text
rls=true, force=true
bare_count=0
insert_visible_acme=1
beta_visible_count=0
wrong_org_insert=23503
```

해석:

- table has RLS + FORCE RLS.
- app role without `app.org_id` sees zero rows.
- Acme org context can insert/read its own temporary recording row.
- Beta org context cannot see Acme's row.
- Beta org + Acme call id raw insert fails through the composite FK (`23503`).

참고: 첫 full run은 `dashboard_routes.test.mjs` 4건이 실패했다. 원인은 Step 1 코드가 아니라 이전 테스트/브라우저 세션에서 남은 Acme today call 1건(title/customer 없음)이 dashboard 집계를 오염시킨 것. 해당 정확한 row만 삭제한 뒤 dashboard 단위와 full test 모두 PASS. 최종 확인 시 같은 패턴의 today title/customer 없는 Acme call 잔재는 0건이었다.

---

## 5. Not Implemented

계획대로 미구현:

- repository helpers
- repository tests
- storage adapter
- S3/MinIO/local disk provider config
- upload/finalize/playback routes
- shared browser types
- frontend playback UI
- activity_log recording actions
- retention worker recording module
- audio consent/legal UX

---

## 6. Next Step

Phase 8 Step 2:

- `server/src/repositories/callRecordings.ts`
- repository tests proving RLS/cross-org behavior permanently, not just smoke.
- storage adapter boundary:
  - local/mock provider for dev/test
  - S3-compatible provider shape for MinIO/S3
  - env validation and fail-fast rules

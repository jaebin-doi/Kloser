# Phase 8 Step 1 Plan - `call_recordings` Metadata Schema

작성일: 2026-05-18

상위 문서: `PHASE_8_MASTER.md`

Phase 8은 call recording audio storage + playback을 연다. 다만 Phase Workflow에 따라 첫 구현 단위는 **schema migration only**다. S3/MinIO adapter, upload URL signing, playback route, frontend는 Step 2 이후로 분리한다.

---

## 1. Current State

### 1.1 이미 있는 것

- `calls`
  - `server/migrations/1715000009000_phase4_calls.sql`
  - `UNIQUE (org_id, id)`
  - `customer_id` / `agent_user_id` same-org FK guard
  - FORCE RLS with `current_app_org_id()`
  - soft delete via `deleted_at`
- `transcripts`
  - `server/migrations/1715000010000_phase4_transcripts.sql`
  - `(org_id, call_id)` composite FK -> `calls(org_id, id)`
  - FORCE RLS
  - hard-delete cascade from `calls`
- retention worker
  - Phase 7 Step 4 handles transcript text expiration and email outbox stuck-sending recovery.
  - `call_recordings` was explicitly not applicable because no table/object storage existed.

### 1.2 없는 것

- `call_recordings` table.
- object storage adapter.
- upload/finalize/playback routes.
- recording UI.
- recording retention module.

`server/README.md` and older handoff notes mention recording columns as future work, but actual migrations show no `call_recordings` table. Step 1 must treat the table as new.

---

## 2. Scope

### 한다

1. Create migration:
   - `server/migrations/1715000028000_phase8_call_recordings.sql`

2. Create `call_recordings` table:
   - org-scoped metadata table.
   - references `calls` by `(org_id, call_id)`.
   - stores object locator metadata, not audio bytes.
   - stores upload/playback lifecycle state.
   - stores retention cutoff metadata.

3. Add RLS:
   - `ENABLE ROW LEVEL SECURITY`
   - `FORCE ROW LEVEL SECURITY`
   - SELECT / INSERT / UPDATE / DELETE policies using `current_app_org_id()`.

4. Add grants:
   - `GRANT SELECT, INSERT, UPDATE, DELETE ON call_recordings TO app`.

5. Add indexes:
   - call detail lookup.
   - retention sweep lookup.
   - object key uniqueness.
   - status lookup for operational queries.

6. Add schema-only verification:
   - migration up/down.
   - direct SQL sanity checks if needed.
   - no TS/runtime code changes required in Step 1.

### 안 한다

- No S3/MinIO SDK install.
- No storage adapter.
- No repository.
- No route.
- No shared types.
- No frontend.
- No retention worker logic.
- No activity_log action expansion yet.
- No audio body in DB.
- No public URL storage.

---

## 3. Proposed Schema

### 3.1 Migration file

```text
server/migrations/1715000028000_phase8_call_recordings.sql
```

### 3.2 Table shape

```sql
CREATE TABLE call_recordings (
    id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                 uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    call_id                uuid        NOT NULL,

    status                 text        NOT NULL
                                        CHECK (status IN (
                                          'upload_pending',
                                          'uploaded',
                                          'processing',
                                          'available',
                                          'delete_pending',
                                          'deleted',
                                          'failed'
                                        )),

    storage_provider       text        NOT NULL
                                        CHECK (storage_provider IN ('local', 's3', 'minio')),
    storage_bucket         text,
    object_key             text        NOT NULL,
    object_version         text,

    content_type           text        NOT NULL
                                        CHECK (content_type IN (
                                          'audio/webm',
                                          'audio/ogg',
                                          'audio/mpeg',
                                          'audio/mp4',
                                          'audio/wav'
                                        )),
    codec                  text,
    duration_seconds       int         CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
    size_bytes             bigint      CHECK (size_bytes IS NULL OR size_bytes >= 0),
    checksum_sha256        text,

    recorded_at            timestamptz,
    uploaded_at            timestamptz,
    retention_delete_after timestamptz,
    deleted_at             timestamptz,

    error_message          text,
    metadata               jsonb       NOT NULL DEFAULT '{}'::jsonb,

    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),

    UNIQUE (org_id, id),
    UNIQUE (org_id, object_key),

    CONSTRAINT call_recordings_call_same_org_fk
      FOREIGN KEY (org_id, call_id)
      REFERENCES calls(org_id, id)
      ON DELETE CASCADE,

    CONSTRAINT call_recordings_deleted_status_check
      CHECK (
        (status = 'deleted' AND deleted_at IS NOT NULL)
        OR
        (status <> 'deleted')
      )
);
```

### 3.3 Column decisions

| Column | Decision |
|---|---|
| `org_id` | Denormalized for RLS and composite FK consistency. |
| `call_id` | Child of `calls`; cross-org drift blocked by `(org_id, call_id)` FK. |
| `status` | Lifecycle is explicit so upload failures and async processing can be represented. |
| `storage_provider` | `local`, `s3`, `minio` only. Step 2 chooses runtime default/env. |
| `storage_bucket` | nullable so local provider can use filesystem root without bucket semantics. |
| `object_key` | internal locator. Never expose directly to frontend/audit. |
| `object_version` | optional S3 versioning support without another migration. |
| `content_type` | allow-list common audio containers only. Extend by migration if needed. |
| `codec` | free-form because browsers/providers vary (`opus`, `mp3`, `pcm_s16le`, etc.). |
| `duration_seconds` | integer seconds for reports/retention. More precise alignment can use future columns. |
| `size_bytes` | bigint to avoid integer overflow on long recordings. |
| `checksum_sha256` | optional integrity check. Route can enforce length/hex later. |
| `recorded_at` | when capture started or completed, distinct from upload time. |
| `uploaded_at` | basis for default 90-day retention if explicit cutoff is absent. |
| `retention_delete_after` | future per-org override or legal-hold-aware cutoff. |
| `deleted_at` | tombstone state for UI/audit. Hard delete policy is deferred to retention step. |
| `metadata` | provider-specific safe metadata. No secrets, no raw signed URL. |

### 3.4 One recording vs multiple

Step 1 should **not** add a partial unique constraint on `(org_id, call_id)` yet.

Reason:

- upload retry, replacement, failed upload, and future segmented recording all become awkward if the schema hard-limits one row per call.
- Step 3 route can enforce "one available recording per call" at service level if product wants that v1 behavior.
- UI can initially select the latest `available` row while still preserving failed/deleted rows for audit/debug.

### 3.5 Retention index

Retention worker needs efficient per-org scans:

```sql
CREATE INDEX call_recordings_org_retention_idx
  ON call_recordings (org_id, retention_delete_after, uploaded_at)
  WHERE deleted_at IS NULL
    AND status IN ('uploaded', 'available', 'failed');
```

If Step 5 decides to hard delete metadata immediately after object delete, this index still covers candidate selection. If it tombstones first, `deleted_at IS NULL` keeps already-deleted rows out.

### 3.6 Lookup indexes

```sql
CREATE INDEX call_recordings_org_call_created_idx
  ON call_recordings (org_id, call_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX call_recordings_org_status_idx
  ON call_recordings (org_id, status, created_at DESC)
  WHERE deleted_at IS NULL;
```

`UNIQUE (org_id, object_key)` prevents accidental duplicate object locators inside one tenant. It does not leak cross-org existence because route/service never exposes conflict detail for cross-org keys.

### 3.7 `updated_at`

Reuse existing `touch_updated_at()` trigger function.

```sql
CREATE TRIGGER call_recordings_touch_updated_at
    BEFORE UPDATE ON call_recordings
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
```

The migration must not drop `touch_updated_at()` in DOWN. It is shared by earlier tables.

---

## 4. RLS / Grants

Pattern matches `calls`, `transcripts`, `customers`, and `organization_billing_profiles`.

```sql
ALTER TABLE call_recordings ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_recordings FORCE ROW LEVEL SECURITY;

CREATE POLICY call_recordings_select ON call_recordings FOR SELECT
    USING (org_id = current_app_org_id());

CREATE POLICY call_recordings_insert ON call_recordings FOR INSERT
    WITH CHECK (org_id = current_app_org_id());

CREATE POLICY call_recordings_update ON call_recordings FOR UPDATE
    USING      (org_id = current_app_org_id())
    WITH CHECK (org_id = current_app_org_id());

CREATE POLICY call_recordings_delete ON call_recordings FOR DELETE
    USING (org_id = current_app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON call_recordings TO app;
```

DELETE is granted because retention and eventual user/admin delete need an app-role path. The route layer can still soft-delete first; the retention worker can hard-delete after object deletion.

---

## 5. Down Migration

Down order:

1. Drop trigger.
2. Drop policies.
3. Drop table.

Do not drop `touch_updated_at()`.

---

## 6. Verification Plan

Minimum Step 1 commands:

```powershell
npm --prefix server run db:migrate:up
npm --prefix server run typecheck
node test/sync_shared_types.mjs
git diff --check
```

Optional SQL sanity checks after migration:

```sql
-- app role without org context should see zero rows because FORCE RLS applies.
SELECT count(*) FROM call_recordings;

-- table exists with RLS forced.
SELECT relrowsecurity, relforcerowsecurity
FROM pg_class
WHERE relname = 'call_recordings';
```

Step 1 has no shared type changes, so `sync_shared_types` should remain unchanged.

Repository-level RLS tests are Step 2, not Step 1. If Step 1 implementation adds a minimal migration smoke test, keep it SQL/schema-only and do not create repository helpers yet.

---

## 7. Risks / Decisions

- **Content type allow-list may be too narrow.** Start with browser/common formats. Add more by migration when a real recorder proves the need.
- **No legal consent workflow.** This is product/legal policy, not schema mechanics. Add before broad production rollout if required.
- **No encryption-at-rest column.** S3/MinIO/server disk encryption is storage configuration. Per-object encryption metadata can live in `metadata` later if needed.
- **No signed URL in DB.** Signed URLs expire and should be generated on demand.
- **No object delete in Step 1.** The table enables later retention, but object lifecycle starts only after storage adapter exists.
- **No one-recording-per-call constraint.** Service route can enforce a stricter product rule later without schema surgery.

---

## 8. Deliverables

Step 1 implementation should leave these files changed:

- `server/migrations/1715000028000_phase8_call_recordings.sql`
- `docs/plan/phase-8/PHASE_8_STEP_1_FINDINGS.md`
- `docs/plan/phase-8/PHASE_8_MASTER.md`
- `README.md`

No frontend/backend runtime code should change in Step 1 unless migration tooling requires it.

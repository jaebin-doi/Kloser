# Phase 7 Step 1 Plan — SMTP / Resend real email adapter

> 작성일: 2026-05-14
> 상위 문서: `PHASE_7_MASTER.md`
> 선행 문서: `docs/plan/phase-6/PHASE_7_HANDOFF.md`
> 범위: Phase 3 verify/reset/invite email flow를 dev outbox-only에서 real provider-capable delivery로 확장.

---

## 1. Current State

현재 `server/src/services/email.ts`는 `DevOutboxEmailProvider` 하나만 가진다.

- 세 flow: email verification, invitation, password reset.
- 호출자는 auth/invitation transaction 안에서 `emailProvider.send*Email({ client, ... })`를 호출한다.
- provider는 같은 transaction client로 `email_outbox` row를 INSERT한다.
- `body_text`와 `metadata.verifyUrl/resetUrl/acceptUrl`에는 raw token이 평문으로 들어간다.
- dev/e2e는 이 outbox row를 읽어 token을 추출한다.
- migration `1715000007000_phase3_email_outbox.sql`은 운영 provider 전환 시 raw token을 mask/strip해야 한다고 명시한다.

따라서 Step 1의 핵심은 단순히 Resend SDK를 붙이는 것이 아니다. 운영 모드에서 raw token을 평문 archive로 남기지 않으면서, transaction rollback과 provider retry를 안전하게 처리해야 한다.

---

## 2. Decisions

### 2.1 Delivery model

**결정**: request transaction 안에서 외부 email provider를 호출하지 않는다.

이유:
- signup/invite/reset transaction이 rollback되면 이미 발송된 메일을 되돌릴 수 없다.
- provider latency/failure가 auth route latency와 availability를 직접 흔든다.
- Phase 6에서 이미 BullMQ + worker process가 도입됐다.

대신 `email_outbox`를 transactional outbox로 사용한다.

- dev provider: 기존처럼 row를 즉시 `delivered` 상태로 INSERT하고 raw URL을 metadata에 남긴다. 기존 e2e 호환을 유지한다.
- real provider: row를 `pending`으로 INSERT한다. worker가 due row를 lease하고 provider로 발송한 뒤 `delivered` 또는 retry/dead-letter 상태로 갱신한다.

### 2.2 Raw token policy

**결정**: 운영 provider mode에서는 raw token 또는 raw URL을 `body_text`/`metadata` archive에 평문으로 저장하지 않는다.

Retry를 위해 worker가 한동안 raw URL을 복원할 수는 있어야 한다. 따라서 real provider mode는 pending row에만 encrypted sensitive payload를 저장한다.

- `sensitive_payload_encrypted` 계열 컬럼을 추가한다.
- payload에는 발송에 필요한 raw URL 또는 raw token이 들어간다.
- delivery success 후에는 sensitive payload를 NULL로 scrub한다.
- terminal dead-letter에서도 token expiry 이후에는 scrub 대상이다. Step 1에서는 dead-letter 즉시 scrub을 기본값으로 둔다. 재시도는 provider 오류에 대한 3회 안에서만 수행한다.
- `body_text`/`body_html`/`metadata`에는 redacted URL만 남긴다. 예: `...?token=[redacted]`.

If encryption env is missing while `EMAIL_PROVIDER=resend`, boot must fail. Silent dev fallback is not allowed.

### 2.3 Provider choice

**결정**: Step 1의 실 provider는 Resend를 1차로 구현한다.

Env:

```text
EMAIL_PROVIDER=dev_outbox | resend
EMAIL_FROM="Kloser <no-reply@example.com>"
RESEND_API_KEY=...
EMAIL_OUTBOX_ENCRYPTION_KEY=base64-32-byte-key
PUBLIC_APP_ORIGIN=https://app.example.com
```

`smtp`는 interface-compatible placeholder만 남기고 구현하지 않는다. 자체 SMTP는 deliverability 준비(SPF/DKIM/DMARC, bounce handling)가 커서 Resend 이후 별도 step으로 판단한다.

### 2.4 Worker trigger

**결정**: worker는 repeatable scan + row lease 방식으로 pending email을 처리한다.

이유:
- 현재 emailProvider는 transaction client만 받으므로 commit 이후 enqueue hook이 없다.
- transaction 안에서 BullMQ enqueue를 해도 rollback과 queue side effect가 분리된다.
- polling/lease 방식은 DB row commit 이후에만 보이므로 transaction 경계가 명확하다.

운영 기본값:

```text
KLOSER_EMAIL_DELIVERY_INTERVAL_SEC=10
KLOSER_EMAIL_MAX_ATTEMPTS=3
```

---

## 3. Schema Plan

새 migration: `server/migrations/<ts>_phase7_email_delivery.sql`

### 3.1 Columns

Add to `email_outbox`:

```sql
status text NOT NULL DEFAULT 'delivered'
  CHECK (status IN ('pending','sending','delivered','failed','dead_lettered')),
provider text NOT NULL DEFAULT 'dev_outbox'
  CHECK (provider IN ('dev_outbox','resend')),
provider_message_id text,
attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
last_attempt_at timestamptz,
next_attempt_at timestamptz,
dead_lettered_at timestamptz,
locked_at timestamptz,
lock_token uuid,
sensitive_payload_ciphertext text,
sensitive_payload_iv text,
sensitive_payload_tag text,
sensitive_payload_key_version integer NOT NULL DEFAULT 1
```

`delivered_at`, `failed_at`, `error_message`, `created_at` already exist and should be reused.

Backfill:

- existing rows with `failed_at IS NOT NULL` -> `status='failed'`, `provider='dev_outbox'`.
- existing rows with `delivered_at IS NOT NULL` -> `status='delivered'`, `provider='dev_outbox'`.
- existing rows with neither -> `status='pending'`, `provider='dev_outbox'`.

### 3.2 Indexes

```sql
CREATE INDEX email_outbox_due_idx
  ON email_outbox (next_attempt_at, created_at)
  WHERE status IN ('pending','failed');

CREATE INDEX email_outbox_provider_message_idx
  ON email_outbox (provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE INDEX email_outbox_dead_letter_idx
  ON email_outbox (org_id, dead_lettered_at DESC)
  WHERE status = 'dead_lettered';
```

### 3.3 RLS and grants

Existing RLS policies can remain org-scoped.

Check grants:
- runtime app role already has table grants through the Phase 3 app grants path.
- `kloser_service` currently has SELECT/INSERT/UPDATE on `email_outbox`. Keep it, because anonymous verify/reset/invite flows still use service pool where appropriate.
- worker uses app role + `withOrgContext` for updates.

### 3.4 Migration acceptance

- `npm --prefix server run db:migrate:up` succeeds.
- existing Phase 3 e2e still extracts dev raw URLs from old-compatible metadata when `EMAIL_PROVIDER=dev_outbox`.
- no shared type changes in schema-only commit unless a route response is introduced later.

---

## 4. Repo + Unit Test Plan

Add `server/src/repositories/emailOutbox.ts`.

Required operations:

- `insertDeliveredDevEmail(client, row)` — current dev behavior, status `delivered`, provider `dev_outbox`.
- `insertPendingEmail(client, row)` — real provider pending row with redacted archive fields + encrypted sensitive payload.
- `leaseDueEmail(client, now, lockToken)` — one row per transaction, `FOR UPDATE SKIP LOCKED`, status due, sets `sending`, `locked_at`, `lock_token`.
- `markDelivered(client, id, providerMessageId)`.
- `markRetryableFailure(client, id, error, nextAttemptAt)`.
- `markDeadLetter(client, id, error)`.
- `scrubSensitivePayload(client, id)`.

Unit tests:

- dev insert remains readable by org and invisible cross-org.
- pending rows are leased once under concurrent lease attempts.
- retry increments `attempt_count` and sets `next_attempt_at`.
- max attempts transitions to `dead_lettered`.
- delivered/dead-letter rows have sensitive payload scrubbed.
- cross-org update attempts return 0/404-like behavior under RLS.

---

## 5. Service / Adapter Plan

### 5.1 Email provider resolver

Refactor `server/src/services/email.ts` into:

- shared payload types and body builders.
- `DevOutboxEmailProvider`.
- `QueuedEmailProvider` for real providers.
- resolver based on `EMAIL_PROVIDER`.

Current callers should keep the same high-level `sendVerificationEmail`, `sendInvitationEmail`, `sendPasswordResetEmail` calls.

Payload types need one addition:

- `tokenId` from `mintToken(...)` result.

This gives archive metadata a stable non-sensitive pointer to `auth_tokens.id` while raw token remains encrypted-only for pending delivery.

### 5.2 Encryption helper

Add `server/src/services/emailSensitivePayload.ts` or equivalent.

Requirements:

- AES-256-GCM with a 32-byte base64 key from `EMAIL_OUTBOX_ENCRYPTION_KEY`.
- fail-fast if provider is real and key is missing/invalid.
- tests cover encrypt/decrypt round trip and wrong key/tag failure.

### 5.3 Resend adapter

Add `server/src/adapters/email/resend.ts`.

Adapter interface:

```ts
interface EmailDeliveryAdapter {
  send(input: {
    toEmail: string;
    subject: string;
    text: string;
    html?: string | null;
    template: EmailTemplate;
  }): Promise<{ providerMessageId: string }>;
}
```

Implementation notes:

- Use `fetch` or official SDK only after checking dependency impact.
- Do not add provider SDK if native `fetch` is enough.
- Missing `RESEND_API_KEY` / `EMAIL_FROM` when selected is boot failure.
- Do not call Resend in normal tests. Use fake adapter.

### 5.4 Worker

Add:

- `server/src/workers/emailDelivery.worker.ts`
- queue name `email-delivery` or repeatable scan helper in `server/src/queue`.

Worker behavior:

1. list/lease due pending email rows.
2. decrypt sensitive payload.
3. render real body with raw URL in memory.
4. call adapter.
5. mark delivered, scrub sensitive payload.
6. on retryable failure, increment attempt and set exponential backoff.
7. after max attempts, mark dead-letter and scrub sensitive payload.

Worker must be part of `server/src/workers/index.ts` alongside call-summary and heartbeat-sweep.

---

## 6. Route / Shared Type Impact

No user-facing API is required in Step 1.

Existing routes affected indirectly:

- `/auth/signup`
- `/auth/verify/resend` if present in route surface
- `/auth/password/forgot`
- `/invitations`
- `/invitations/:id/resend`

No `platform/types/*` changes unless Step 1 adds an admin outbox status endpoint. It should not.

---

## 7. Frontend Impact

No frontend page change is required for Step 1.

Existing pages continue to receive links:

- `platform/verify.html`
- `platform/reset-password.html`
- `platform/accept-invitation.html`

If email copy changes, keep URLs consistent with `PUBLIC_APP_ORIGIN`.

---

## 8. Tests / E2E

### Required checks

```powershell
npm --prefix server run typecheck
npm --prefix server test
node test/sync_shared_types.mjs
node test/phase_3_e2e.mjs
```

### New tests

Add `server/test/phase7_email_delivery.test.mjs`.

Cover:

- dev provider inserts delivered outbox row with raw URL for e2e compatibility.
- queued provider inserts pending row with redacted archive fields and encrypted payload.
- worker fake adapter marks delivered and scrubs sensitive payload.
- worker fake adapter retries and then dead-letters after max attempts.
- provider env fail-fast cases.
- cross-org RLS isolation for outbox rows.

### Optional e2e

`test/phase_7_email_e2e.mjs` is optional if route tests already exercise the full auth/invite flows with fake delivery. If added, force fake adapter and never hit Resend network.

---

## 9. Documentation / Ops

Update in the implementation/finding commit:

- `server/.env.example`
- `server/README.md`
- root `README.md` status block if Step 1 closes
- `docs/plan/phase-7/PHASE_7_STEP_1_FINDINGS.md`

Ops notes to include:

- Resend domain verification requires SPF/DKIM/DMARC outside this repo.
- `EMAIL_FROM` domain must match verified sender/domain.
- Real provider tests are opt-in only and require an explicit env guard.

---

## 10. Completion Criteria

Step 1 is complete when:

- [ ] schema migration is forward-only and backfills existing outbox rows.
- [ ] dev/e2e outbox behavior remains compatible with Phase 3 e2e.
- [ ] real provider mode queues pending email, worker sends via adapter, and marks delivered.
- [ ] raw token is not stored in archive fields in real provider mode.
- [ ] sensitive payload is scrubbed after delivered/dead-letter.
- [ ] retry/dead-letter behavior is deterministic and tested.
- [ ] missing real-provider env fails fast.
- [ ] `npm --prefix server run typecheck` PASS.
- [ ] `npm --prefix server test` PASS.
- [ ] `node test/sync_shared_types.mjs` PASS.
- [ ] `node test/phase_3_e2e.mjs` PASS.
- [ ] findings document written and `PHASE_7_MASTER.md` Step 1 checked.

---

## 11. Next Implementation Order

1. Schema migration for email delivery fields.
2. `emailOutbox` repository + unit tests.
3. sensitive payload encryption helper + tests.
4. provider resolver refactor while keeping dev behavior.
5. queued provider + worker with fake adapter tests.
6. Resend adapter.
7. route regression and Phase 3 e2e.
8. findings + docs closeout.


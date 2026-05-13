/* llm_usage_log repository — Phase 6 Step 2.
 *
 * Append-only record of provider invocations. The Step 2 plan separates
 * adapter / service / wiring concerns into later commits — this file
 * only owns the raw SQL surface. Service-level orchestration (recording
 * usage from a worker, swallowing logging failures so the user flow
 * still completes) lives in `services/llmUsage.ts` in a follow-up commit.
 *
 * All helpers run on a PoolClient handed in by the caller. The caller is
 * responsible for opening `withOrgContext(orgId)` — RLS FORCE on this
 * table means a missing GUC silently returns/filters 0 rows, which would
 * mask bugs if the repo opened its own context. Same pattern as Phase 4
 * calls and Phase 5 call_suggestions.
 *
 * Append-only: this file deliberately ships no UPDATE / DELETE helpers
 * in Step 2. The migration has no UPDATE/DELETE RLS policy, so even if
 * someone added a helper the app role would be denied at the DB.
 */
import type { PoolClient } from "pg";

export type LlmUsageProvider = "anthropic" | "openai" | "clova" | "mock";

export type LlmUsageOperation =
  | "call_summary"
  | "call_suggestion"
  | "knowledge_embedding"
  | "stt_transcribe";

export type LlmUsageStatus = "succeeded" | "failed" | "skipped";

export interface LlmUsageLog {
  id: string;
  org_id: string;
  call_id: string | null;
  provider: LlmUsageProvider;
  operation: LlmUsageOperation;
  model: string;
  status: LlmUsageStatus;
  tokens_in: number | null;
  tokens_out: number | null;
  latency_ms: number | null;
  cost_usd_micros: number | null;
  provider_request_id: string | null;
  error_code: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface LlmUsageInsertInput {
  call_id?: string | null;
  provider: LlmUsageProvider;
  operation: LlmUsageOperation;
  model: string;
  status: LlmUsageStatus;
  tokens_in?: number | null;
  tokens_out?: number | null;
  latency_ms?: number | null;
  cost_usd_micros?: number | null;
  provider_request_id?: string | null;
  error_code?: string | null;
  metadata?: Record<string, unknown> | null;
}

const USAGE_COLUMNS =
  "id, org_id, call_id, provider, operation, model, status," +
  " tokens_in, tokens_out, latency_ms, cost_usd_micros," +
  " provider_request_id, error_code, metadata, created_at";

// Insert one usage row. org_id is derived from the GUC via the INSERT
// policy WITH CHECK clause; passing actorOrgId explicitly lets the
// migration's composite FK enforce same-org for the call_id branch even
// when the caller forgot to scope correctly. Returns the inserted row.
export async function insertInCurrentOrg(
  client: PoolClient,
  actorOrgId: string,
  input: LlmUsageInsertInput,
): Promise<LlmUsageLog> {
  const r = await client.query<LlmUsageLog>(
    `INSERT INTO llm_usage_log (
        org_id, call_id, provider, operation, model, status,
        tokens_in, tokens_out, latency_ms, cost_usd_micros,
        provider_request_id, error_code, metadata
     ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12, COALESCE($13::jsonb, '{}'::jsonb)
     )
     RETURNING ${USAGE_COLUMNS}`,
    [
      actorOrgId,
      input.call_id ?? null,
      input.provider,
      input.operation,
      input.model,
      input.status,
      input.tokens_in ?? null,
      input.tokens_out ?? null,
      input.latency_ms ?? null,
      input.cost_usd_micros ?? null,
      input.provider_request_id ?? null,
      input.error_code ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );
  return r.rows[0]!;
}

// Test / diagnostic helper. Returns rows for a single call, newest first
// (matches the partial index `llm_usage_log_call_created_idx`). RLS
// still scopes to the current org GUC, so a Beta context cannot read
// rows that happen to share a call_id with Acme (the FK guarantees that
// can't happen, but RLS is the second wall).
export async function listForCallInCurrentOrg(
  client: PoolClient,
  callId: string,
): Promise<LlmUsageLog[]> {
  const r = await client.query<LlmUsageLog>(
    `SELECT ${USAGE_COLUMNS} FROM llm_usage_log
      WHERE call_id = $1
      ORDER BY created_at DESC, id DESC`,
    [callId],
  );
  return r.rows;
}

// Test / diagnostic helper for prefix-scoped cleanup verification.
// Returns rows whose metadata->>'test_tag' starts with a given prefix.
// Org-scoped via RLS. Not used by production service code.
export async function listForCurrentOrgByTestTagPrefix(
  client: PoolClient,
  prefix: string,
): Promise<LlmUsageLog[]> {
  const r = await client.query<LlmUsageLog>(
    `SELECT ${USAGE_COLUMNS} FROM llm_usage_log
      WHERE metadata->>'test_tag' LIKE $1
      ORDER BY created_at DESC, id DESC`,
    [`${prefix}%`],
  );
  return r.rows;
}

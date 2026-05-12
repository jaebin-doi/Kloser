/* transcripts repository — Phase 4 Step 2.
 *
 * transcripts is an append-only child of calls. The Step 1 migration:
 *   - denormalises org_id (no JOIN at RLS evaluation time)
 *   - enforces (org_id, call_id) composite FK against calls(org_id, id),
 *     so the application cannot mismatch org and call by accident
 *   - UNIQUE (call_id, seq) makes seq the per-call ordering key
 *
 * seq allocation runs inside a transaction the caller has already
 * started via app.withOrgContext. The repository:
 *   1. locks the target calls row FOR UPDATE (via calls.lockByIdInCurrentOrg
 *      from the service, OR an inline FOR UPDATE in append),
 *   2. reads COALESCE(MAX(seq)+1, 0) for that call,
 *   3. INSERTs.
 * Concurrent appends to the same call therefore serialise on the calls
 * row lock; appends against different calls remain independent.
 *
 * Cross-org reads return null instead of throwing — the service maps
 * that to a 404 outcome. Direct drift inserts (mismatched org_id +
 * call_id) raise 23503 because of the composite FK.
 */
import type { PoolClient } from "pg";

// ---------- entity + input types ---------- //

export type TranscriptSpeaker = "agent" | "customer" | "system";
export type TranscriptSttProvider =
  | "clova"
  | "whisper"
  | "manual"
  | "fixture";

export interface Transcript {
  id: string;
  call_id: string;
  org_id: string;
  seq: number;
  speaker: TranscriptSpeaker;
  text: string;
  start_ms: number | null;
  end_ms: number | null;
  confidence: number | null;
  created_at: Date;
  // Phase 5 Step 1 — transcripts columns migration.
  stt_provider: TranscriptSttProvider | null;
  stt_session_id: string | null;
}

export interface TranscriptAppendInput {
  speaker: TranscriptSpeaker;
  text: string;
  start_ms?: number | null;
  end_ms?: number | null;
  confidence?: number | null;
  stt_provider?: TranscriptSttProvider | null;
  stt_session_id?: string | null;
}

const TRANSCRIPT_COLUMNS =
  "id, call_id, org_id, seq, speaker, text, start_ms, end_ms," +
  " confidence::float8 AS confidence, created_at," +
  " stt_provider, stt_session_id";

// ---------- helpers ---------- //

// Confirm the call exists in the current org (RLS will hide other orgs)
// and is not soft-deleted, and lock it FOR UPDATE so concurrent appends
// against the same call serialise. Returns { id, org_id } so callers can
// stamp the denormalised transcripts.org_id without re-reading.
async function lockCallForAppend(
  client: PoolClient,
  callId: string,
): Promise<{ id: string; org_id: string } | null> {
  const r = await client.query<{ id: string; org_id: string }>(
    `SELECT id, org_id FROM calls
      WHERE id = $1 AND deleted_at IS NULL
      FOR UPDATE`,
    [callId],
  );
  return r.rows[0] ?? null;
}

// ---------- write ---------- //

export async function appendForCallInCurrentOrg(
  client: PoolClient,
  callId: string,
  input: TranscriptAppendInput,
): Promise<Transcript | null> {
  const call = await lockCallForAppend(client, callId);
  if (!call) return null;

  const nextSeqRow = await client.query<{ next_seq: number }>(
    `SELECT COALESCE(MAX(seq) + 1, 0)::int AS next_seq
       FROM transcripts
      WHERE call_id = $1`,
    [callId],
  );
  const nextSeq = nextSeqRow.rows[0]?.next_seq ?? 0;

  const r = await client.query<Transcript>(
    `INSERT INTO transcripts (
        org_id, call_id, seq, speaker, text, start_ms, end_ms, confidence,
        stt_provider, stt_session_id
     ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
     )
     RETURNING ${TRANSCRIPT_COLUMNS}`,
    [
      call.org_id,
      callId,
      nextSeq,
      input.speaker,
      input.text,
      input.start_ms ?? null,
      input.end_ms ?? null,
      input.confidence ?? null,
      input.stt_provider ?? null,
      input.stt_session_id ?? null,
    ],
  );
  return r.rows[0]!;
}

// ---------- read ---------- //

// Returns null when the call does not exist in this org. Empty array
// when the call exists but has no transcripts yet (distinct from "call
// missing"). Service layer typically translates null → 404 and [] → 200.
export async function listByCallInCurrentOrg(
  client: PoolClient,
  callId: string,
): Promise<Transcript[] | null> {
  const callRow = await client.query<{ id: string }>(
    `SELECT id FROM calls
      WHERE id = $1 AND deleted_at IS NULL`,
    [callId],
  );
  if (callRow.rows.length === 0) return null;

  const r = await client.query<Transcript>(
    `SELECT ${TRANSCRIPT_COLUMNS} FROM transcripts
      WHERE call_id = $1
      ORDER BY seq ASC`,
    [callId],
  );
  return r.rows;
}

export async function countByCallInCurrentOrg(
  client: PoolClient,
  callId: string,
): Promise<number | null> {
  const callRow = await client.query<{ id: string }>(
    `SELECT id FROM calls
      WHERE id = $1 AND deleted_at IS NULL`,
    [callId],
  );
  if (callRow.rows.length === 0) return null;

  const r = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM transcripts WHERE call_id = $1`,
    [callId],
  );
  return r.rows[0]?.n ?? 0;
}

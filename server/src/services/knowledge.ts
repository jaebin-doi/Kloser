/* Knowledge service — Phase 5 Step 2.
 *
 * Wraps knowledge_bases / knowledge_chunks repositories with
 * withOrgContext transactions. Step 2 does NOT enforce role here:
 * Step 3 route handlers will gate /knowledge-bases to admin. The
 * service contract today is "transaction + org context + repo glue".
 *
 * Out of scope:
 *   - calling an embedding provider (OpenAI/Claude). Embeddings come
 *     in as number[] from the caller (real adapter in Step 3, fixtures
 *     in tests).
 *   - role enforcement, HTTP mapping.
 */
import type { FastifyInstance } from "fastify";
import * as kbRepo from "../repositories/knowledgeBases.js";
import * as chunkRepo from "../repositories/knowledgeChunks.js";
import type {
  KnowledgeBase,
  KnowledgeBaseCreateInput,
  KnowledgeBaseListOptions,
  KnowledgeBasePatchInput,
} from "../repositories/knowledgeBases.js";
import type {
  KnowledgeChunk,
  KnowledgeChunkInput,
  KnowledgeChunkSearchOptions,
  KnowledgeChunkSearchResult,
} from "../repositories/knowledgeChunks.js";
import {
  recordKnowledgeBaseCreated,
  recordKnowledgeBaseDeleted,
  recordKnowledgeBaseUpdated,
} from "./activityLog.js";
import {
  assertPlanAllows,
  assertPlanAllowsAbsolute,
  lockCurrentOrgForPlanLimit,
} from "./billing.js";

export async function listKnowledgeBases(
  app: FastifyInstance,
  actorOrgId: string,
  opts: KnowledgeBaseListOptions,
): Promise<KnowledgeBase[]> {
  return app.withOrgContext(actorOrgId, (client) =>
    kbRepo.listForCurrentOrg(client, opts),
  );
}

export async function getKnowledgeBase(
  app: FastifyInstance,
  actorOrgId: string,
  id: string,
): Promise<KnowledgeBase | null> {
  return app.withOrgContext(actorOrgId, (client) =>
    kbRepo.getByIdInCurrentOrg(client, id),
  );
}

export async function createKnowledgeBase(
  app: FastifyInstance,
  actorOrgId: string,
  actorUserId: string,
  input: KnowledgeBaseCreateInput,
): Promise<KnowledgeBase> {
  return app.withOrgContext(actorOrgId, async (client) => {
    // Phase 7 Step 9 — knowledge_bases cap. Same locking + count pattern
    // as customers/calls. assertPlanAllows runs inside this transaction
    // so a 403 rolls the KB INSERT + audit row back together.
    await assertPlanAllows(client, {
      limitKey: "knowledge_bases",
      increment: 1,
    });
    const created = await kbRepo.insertInCurrentOrg(client, actorOrgId, input);
    // Phase 7 Step 3 — audit. Same transaction as the INSERT so an
    // audit-row failure rolls the create back together.
    await recordKnowledgeBaseCreated(client, {
      orgId:           actorOrgId,
      actorUserId,
      knowledgeBaseId: created.id,
    });
    return created;
  });
}

export async function patchKnowledgeBase(
  app: FastifyInstance,
  actorOrgId: string,
  actorUserId: string,
  id: string,
  input: KnowledgeBasePatchInput,
): Promise<KnowledgeBase | null> {
  return app.withOrgContext(actorOrgId, async (client) => {
    const updated = await kbRepo.patchInCurrentOrg(client, id, input);
    if (!updated) return null;
    // Phase 7 Step 3 — audit names the patched fields only, never
    // their values. Title / source_uri can carry sensitive playbook
    // text the admin pasted in.
    const fields = Object.keys(input).filter(
      (k) => (input as Record<string, unknown>)[k] !== undefined,
    );
    if (fields.length > 0) {
      await recordKnowledgeBaseUpdated(client, {
        orgId:           actorOrgId,
        actorUserId,
        knowledgeBaseId: updated.id,
        fields,
      });
    }
    return updated;
  });
}

export async function softDeleteKnowledgeBase(
  app: FastifyInstance,
  actorOrgId: string,
  actorUserId: string,
  id: string,
): Promise<boolean> {
  return app.withOrgContext(actorOrgId, async (client) => {
    const ok = await kbRepo.softDeleteByIdInCurrentOrg(client, id);
    // Only audit a real delete — repeat / cross-org / already-deleted
    // returns false and produces no audit noise.
    if (ok) {
      await recordKnowledgeBaseDeleted(client, {
        orgId:           actorOrgId,
        actorUserId,
        knowledgeBaseId: id,
      });
    }
    return ok;
  });
}

// Replace all chunks for a knowledge base. Returns null when the parent
// KB is missing/cross-org/soft-deleted. Embedding dimension validation
// happens inside the repository's toVectorLiteral before SQL.
export async function replaceKnowledgeChunks(
  app: FastifyInstance,
  actorOrgId: string,
  knowledgeBaseId: string,
  chunks: KnowledgeChunkInput[],
): Promise<KnowledgeChunk[] | null> {
  return app.withOrgContext(actorOrgId, async (client) => {
    // Phase 7 Step 9 — knowledge_chunks cap. Replace is an absolute set
    // operation (delete-then-insert) so the post-write total is just
    // the count of incoming chunks across *all* the org's KBs minus the
    // existing chunks in this KB plus the new ones. The simpler invariant
    // is "post-replace total chunks for org ≤ cap". We compute that
    // ahead of the replace via assertPlanAllowsAbsolute so a rejection
    // happens before the destructive DELETE.
    //
    // post-replace total = current_total_chunks_in_org
    //                    - current_chunks_in_this_kb
    //                    + chunks.length
    //
    // Lock before computing totals. If two admins replace chunks in two
    // different KBs concurrently, counting before the org-level lock
    // would let both transactions base their target on the same stale
    // total and overshoot the cap after both commits.
    await lockCurrentOrgForPlanLimit(client);
    const totals = await client.query<{ org_total: number; kb_total: number }>(
      `SELECT
         (SELECT count(*)::int
            FROM knowledge_chunks c
            JOIN knowledge_bases kb ON kb.id = c.knowledge_base_id
                                   AND kb.deleted_at IS NULL) AS org_total,
         (SELECT count(*)::int
            FROM knowledge_chunks c
           WHERE c.knowledge_base_id = $1) AS kb_total`,
      [knowledgeBaseId],
    );
    const orgTotal = totals.rows[0]?.org_total ?? 0;
    const kbTotal = totals.rows[0]?.kb_total ?? 0;
    const postReplaceTotal = orgTotal - kbTotal + chunks.length;
    await assertPlanAllowsAbsolute(client, {
      limitKey: "knowledge_chunks",
      targetTotal: postReplaceTotal,
    });
    return chunkRepo.replaceForKnowledgeBaseInCurrentOrg(
      client,
      actorOrgId,
      knowledgeBaseId,
      chunks,
    );
  });
}

export async function listKnowledgeChunks(
  app: FastifyInstance,
  actorOrgId: string,
  knowledgeBaseId: string,
): Promise<KnowledgeChunk[] | null> {
  return app.withOrgContext(actorOrgId, (client) =>
    chunkRepo.listByKnowledgeBaseInCurrentOrg(client, knowledgeBaseId),
  );
}

export async function updateChunkEmbedding(
  app: FastifyInstance,
  actorOrgId: string,
  chunkId: string,
  embedding: number[],
  tokenCount: number | null,
): Promise<KnowledgeChunk | null> {
  return app.withOrgContext(actorOrgId, (client) =>
    chunkRepo.updateEmbeddingInCurrentOrg(
      client,
      chunkId,
      embedding,
      tokenCount,
    ),
  );
}

export async function searchKnowledge(
  app: FastifyInstance,
  actorOrgId: string,
  queryEmbedding: number[],
  opts: KnowledgeChunkSearchOptions,
): Promise<KnowledgeChunkSearchResult[]> {
  return app.withOrgContext(actorOrgId, (client) =>
    chunkRepo.searchSimilarInCurrentOrg(client, queryEmbedding, opts),
  );
}

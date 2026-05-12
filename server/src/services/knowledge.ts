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
  input: KnowledgeBaseCreateInput,
): Promise<KnowledgeBase> {
  return app.withOrgContext(actorOrgId, (client) =>
    kbRepo.insertInCurrentOrg(client, actorOrgId, input),
  );
}

export async function patchKnowledgeBase(
  app: FastifyInstance,
  actorOrgId: string,
  id: string,
  input: KnowledgeBasePatchInput,
): Promise<KnowledgeBase | null> {
  return app.withOrgContext(actorOrgId, (client) =>
    kbRepo.patchInCurrentOrg(client, id, input),
  );
}

export async function softDeleteKnowledgeBase(
  app: FastifyInstance,
  actorOrgId: string,
  id: string,
): Promise<boolean> {
  return app.withOrgContext(actorOrgId, (client) =>
    kbRepo.softDeleteByIdInCurrentOrg(client, id),
  );
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
  return app.withOrgContext(actorOrgId, (client) =>
    chunkRepo.replaceForKnowledgeBaseInCurrentOrg(
      client,
      actorOrgId,
      knowledgeBaseId,
      chunks,
    ),
  );
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

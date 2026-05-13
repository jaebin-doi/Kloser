/* /knowledge-bases/* routes — Phase 5 Step 3.
 *
 * Plan: docs/plan/phase-5/PHASE_5_STEP_3_ROUTES.md §2.3.
 *
 * Surface (7 endpoints):
 *
 *   GET    /knowledge-bases                       — list (any signed-in)
 *   POST   /knowledge-bases                       — create (admin)
 *   GET    /knowledge-bases/:id                   — detail + chunks (any signed-in)
 *   PATCH  /knowledge-bases/:id                   — patch (admin)
 *   DELETE /knowledge-bases/:id                   — soft delete (admin)
 *   POST   /knowledge-bases/:id/chunks/replace    — replace all chunks (admin)
 *   POST   /knowledge-bases/search                — vector search (any signed-in)
 *
 * Role: read endpoints stay open to any same-org signed-in user (so the
 * frontend can show the org's playbook in the suggestion sidebar). All
 * write operations are admin-only — knowledge is a per-org policy
 * artefact and lower roles must not edit it.
 *
 * Errors: ZodError → 400 invalid_input. InvalidEmbeddingError → 400
 * invalid_embedding. 23503 → 400 invalid_reference. 42501 → 500
 * rls_violation. Service nulls (missing/cross-org/soft-deleted) → 404.
 */
import type { FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { orgContext } from "../middleware/orgContext.js";
import { requireRole } from "../middleware/role.js";
import { requireFreshRole } from "../middleware/requireFreshRole.js";
import { requireVerified } from "../middleware/requireVerified.js";
import { AuthError } from "../services/auth.js";
import * as knowledgeService from "../services/knowledge.js";
import {
  KnowledgeBaseCreateInput,
  KnowledgeBasePatchInput,
} from "../types/knowledgeBase.js";
import {
  KnowledgeChunkReplaceInput,
  KnowledgeChunkSearchQuery,
} from "../types/knowledgeChunk.js";
import { InvalidEmbeddingError } from "../repositories/knowledgeChunks.js";
import { resolveEmbeddingAdapter } from "../adapters/index.js";
import type { EmbeddingAdapter } from "../adapters/index.js";
import * as llmUsageService from "../services/llmUsage.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UuidParam = z.object({
  id: z.string().regex(UUID_RE, "invalid uuid"),
});

const ListQuery = z.object({
  limit: z.preprocess((v) => {
    if (v === undefined || v === null || v === "") return 50;
    const n = typeof v === "number" ? v : Number.parseInt(String(v), 10);
    if (!Number.isFinite(n)) return 50;
    if (n < 1) return 1;
    if (n > 200) return 200;
    return Math.floor(n);
  }, z.number().int().min(1).max(200)),
  offset: z.preprocess((v) => {
    if (v === undefined || v === null || v === "") return 0;
    const n = typeof v === "number" ? v : Number.parseInt(String(v), 10);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.floor(n);
  }, z.number().int().min(0)),
});

export interface KnowledgeBaseRoutesOptions {
  embedding?: EmbeddingAdapter;
}

async function knowledgeBaseRoutes(
  app: FastifyInstance,
  opts: KnowledgeBaseRoutesOptions = {},
) {
  const embedding = opts.embedding ?? resolveEmbeddingAdapter();

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply
        .code(400)
        .send({ error: "invalid_input", issues: err.flatten() });
    }
    if (err instanceof InvalidEmbeddingError) {
      return reply.code(400).send({ error: "invalid_embedding" });
    }
    if (err instanceof AuthError) {
      const body: Record<string, unknown> = {
        error: err.message,
        code: err.code,
      };
      if (err.details && typeof err.details === "object") {
        Object.assign(body, err.details as Record<string, unknown>);
      }
      return reply.code(err.statusCode).send(body);
    }
    const pgCode = (err as { code?: string } | null)?.code;
    if (pgCode === "23503") {
      return reply.code(400).send({ error: "invalid_reference" });
    }
    if (pgCode === "23505") {
      return reply.code(409).send({ error: "conflict" });
    }
    if (pgCode === "23514") {
      return reply.code(400).send({ error: "invalid_state_transition" });
    }
    if (pgCode === "42501") {
      return reply.code(500).send({ error: "rls_violation" });
    }
    reply.send(err);
  });

  // -------------------------------------------------------------- //
  // GET /knowledge-bases
  // -------------------------------------------------------------- //
  app.get(
    "/knowledge-bases",
    { preHandler: [requireAuth, orgContext] },
    async (request, reply) => {
      const { limit, offset } = ListQuery.parse(request.query);
      const items = await knowledgeService.listKnowledgeBases(
        app,
        request.orgId!,
        { limit, offset },
      );
      return reply.code(200).send({ items });
    },
  );

  // -------------------------------------------------------------- //
  // POST /knowledge-bases (admin)
  // -------------------------------------------------------------- //
  app.post(
    "/knowledge-bases",
    {
      preHandler: [
        requireAuth,
        orgContext,
        requireVerified,
        requireRole("admin"),
        requireFreshRole,
      ],
    },
    async (request, reply) => {
      const input = KnowledgeBaseCreateInput.parse(request.body);
      const kb = await knowledgeService.createKnowledgeBase(
        app,
        request.orgId!,
        { ...input, created_by_user_id: request.user!.id },
      );
      return reply.code(201).send({ knowledge_base: kb });
    },
  );

  // -------------------------------------------------------------- //
  // GET /knowledge-bases/:id  (detail + chunks)
  // -------------------------------------------------------------- //
  app.get(
    "/knowledge-bases/:id",
    { preHandler: [requireAuth, orgContext] },
    async (request, reply) => {
      const { id } = UuidParam.parse(request.params);
      const kb = await knowledgeService.getKnowledgeBase(
        app,
        request.orgId!,
        id,
      );
      if (!kb) return reply.code(404).send({ error: "not_found" });
      const chunks = await knowledgeService.listKnowledgeChunks(
        app,
        request.orgId!,
        id,
      );
      return reply.code(200).send({ knowledge_base: kb, chunks: chunks ?? [] });
    },
  );

  // -------------------------------------------------------------- //
  // PATCH /knowledge-bases/:id (admin)
  // -------------------------------------------------------------- //
  app.patch(
    "/knowledge-bases/:id",
    {
      preHandler: [
        requireAuth,
        orgContext,
        requireVerified,
        requireRole("admin"),
        requireFreshRole,
      ],
    },
    async (request, reply) => {
      const { id } = UuidParam.parse(request.params);
      const input = KnowledgeBasePatchInput.parse(request.body);
      const kb = await knowledgeService.patchKnowledgeBase(
        app,
        request.orgId!,
        id,
        input,
      );
      if (!kb) return reply.code(404).send({ error: "not_found" });
      return reply.code(200).send({ knowledge_base: kb });
    },
  );

  // -------------------------------------------------------------- //
  // DELETE /knowledge-bases/:id (admin, soft)
  // -------------------------------------------------------------- //
  app.delete(
    "/knowledge-bases/:id",
    {
      preHandler: [
        requireAuth,
        orgContext,
        requireVerified,
        requireRole("admin"),
        requireFreshRole,
      ],
    },
    async (request, reply) => {
      const { id } = UuidParam.parse(request.params);
      const ok = await knowledgeService.softDeleteKnowledgeBase(
        app,
        request.orgId!,
        id,
      );
      if (!ok) return reply.code(404).send({ error: "not_found" });
      return reply.code(204).send();
    },
  );

  // -------------------------------------------------------------- //
  // POST /knowledge-bases/:id/chunks/replace (admin)
  //   Replaces all chunks for the KB. Each chunk gets a fresh
  //   embedding via the configured EmbeddingAdapter; tests inject the
  //   mock adapter so they stay deterministic.
  // -------------------------------------------------------------- //
  app.post(
    "/knowledge-bases/:id/chunks/replace",
    {
      preHandler: [
        requireAuth,
        orgContext,
        requireVerified,
        requireRole("admin"),
        requireFreshRole,
      ],
    },
    async (request, reply) => {
      const { id } = UuidParam.parse(request.params);
      const { chunks } = KnowledgeChunkReplaceInput.parse(request.body);

      // If a chunk lacks an embedding, ask the adapter for one. Caller
      // can also pre-compute and pass embedding inline (kept for tests
      // that want to assert a specific vector). Phase 6 Step 2 records
      // one llm_usage_log row per *adapter call* — precomputed chunks
      // are skipped because no provider call happened for them. We
      // preserve original chunk order via index tracking so search
      // ranking and chunk row order stay stable.
      const enriched = await Promise.all(
        chunks.map(async (c, idx) => {
          if (c.embedding) return c;
          const result = await embedding.embed(c.text);
          if (result.usage) {
            await llmUsageService.recordProviderUsage(
              app,
              request.orgId!,
              null,
              result.usage,
              {
                metadata: {
                  source: "route:knowledge.chunks.replace",
                  knowledge_base_id: id,
                  chunk_index: idx,
                },
              },
            );
          }
          return { ...c, embedding: result.value };
        }),
      );

      const result = await knowledgeService.replaceKnowledgeChunks(
        app,
        request.orgId!,
        id,
        enriched,
      );
      if (result === null) return reply.code(404).send({ error: "not_found" });
      return reply.code(200).send({ chunks: result });
    },
  );

  // -------------------------------------------------------------- //
  // POST /knowledge-bases/search
  //   Body: { query: string, limit?: number }
  //   Embeds the query via the configured adapter and returns the top
  //   matches across all KBs in the caller's org.
  // -------------------------------------------------------------- //
  app.post(
    "/knowledge-bases/search",
    { preHandler: [requireAuth, orgContext] },
    async (request, reply) => {
      const { query, limit } = KnowledgeChunkSearchQuery.parse(request.body);
      const embedResult = await embedding.embed(query);
      if (embedResult.usage) {
        await llmUsageService.recordProviderUsage(
          app,
          request.orgId!,
          null,
          embedResult.usage,
          {
            metadata: {
              source: "route:knowledge.search",
              query_length: query.length,
            },
          },
        );
      }
      const vec = embedResult.value;
      const items = await knowledgeService.searchKnowledge(
        app,
        request.orgId!,
        vec,
        { limit: limit ?? 5 },
      );
      return reply.code(200).send({ items });
    },
  );
}

export default knowledgeBaseRoutes;

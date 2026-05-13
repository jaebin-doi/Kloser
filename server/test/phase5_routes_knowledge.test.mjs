/* Phase 5 Step 3 — /knowledge-bases/* REST routes.
 *
 * Plan: docs/plan/phase-5/PHASE_5_STEP_3_ROUTES.md §2.3, §5.3.
 *
 * Covers:
 *   - role matrix on KB CRUD (admin write, all read)
 *   - cross-org → 404
 *   - chunk replace ingests embeddings via mock adapter
 *   - vector search returns nearest result first
 *   - invalid embedding dimension → 400 invalid_embedding
 *
 * Test data is namespaced by FIXTURE_PREFIX so cleanup is deterministic.
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import pg from "pg";
import authPlugin from "../src/plugins/auth.js";
import dbPlugin from "../src/plugins/db.js";
import authRoutes from "../src/routes/auth.js";
import knowledgeBasesRoutes from "../src/routes/knowledgeBases.js";
import { createMockEmbeddingAdapter } from "../src/adapters/embedding/mock.js";
import {
    ORG_ACME,
    ORG_BETA,
    createFixtureUsers,
    destroyFixtureUsers,
    mintToken,
    authedInject,
    FIXTURE_PREFIX,
} from "./_phase5Fixture.mjs";

let app;
const embedding = createMockEmbeddingAdapter();
// Captured at module load. Used to scope llm_usage_log cleanup to this
// suite's runtime so we never delete rows another concurrent run wrote.
const SUITE_START_ISO = new Date(Date.now() - 1000).toISOString();

before(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    await app.register(dbPlugin);
    await app.register(authRoutes);
    await app.register(knowledgeBasesRoutes, { embedding });
    await createFixtureUsers(app);
});

after(async () => {
    if (app) {
        // Phase 6 Step 2 wiring: knowledge route now writes one
        // llm_usage_log row per provider call. The table is app-role
        // append-only, so cleanup must run via the admin migration URL.
        // Scoped to rows whose metadata pins them to this suite (one of
        // the knowledge wiring sources + a KB created with FIXTURE_PREFIX).
        if (process.env.MIGRATE_DATABASE_URL) {
            const adminClient = new pg.Client({
                connectionString: process.env.MIGRATE_DATABASE_URL,
            });
            try {
                await adminClient.connect();
                await adminClient.query(
                    `DELETE FROM llm_usage_log
                       WHERE metadata->>'source' IN (
                                'route:knowledge.chunks.replace',
                                'route:knowledge.search'
                             )
                         AND created_at >= $1`,
                    [SUITE_START_ISO],
                );
            } catch (_e) { /* defensive: never break test teardown */ }
            finally {
                try { await adminClient.end(); } catch (_e2) {}
            }
        }

        // sweep KBs created by this suite (chunks cascade).
        for (const orgId of [ORG_ACME, ORG_BETA]) {
            await app.withOrgContext(orgId, async (client) => {
                await client.query(
                    `DELETE FROM knowledge_chunks
                       WHERE knowledge_base_id IN (
                         SELECT id FROM knowledge_bases WHERE title LIKE $1
                       )`,
                    [`${FIXTURE_PREFIX}%`],
                );
                await client.query(
                    `DELETE FROM knowledge_bases WHERE title LIKE $1`,
                    [`${FIXTURE_PREFIX}%`],
                );
            });
        }
        await destroyFixtureUsers(app);
        await app.pg.query(`DELETE FROM sessions`);
        await app.close();
    }
});

afterEach(async () => {
    await app.pg.query(`DELETE FROM sessions`);
});

async function createKb(token, body) {
    const r = await authedInject(app, token, {
        method: "POST",
        url: "/knowledge-bases",
        headers: { "content-type": "application/json" },
        payload: body,
    });
    assert.equal(r.statusCode, 201, `create kb: ${r.statusCode} ${r.body}`);
    return r.json().knowledge_base;
}

// ============================================================
//                       READ surface
// ============================================================

test("GET /knowledge-bases is open to all signed-in same-org users", async () => {
    const adminToken = mintToken(app, "acmeAdmin");
    const empToken = mintToken(app, "acmeEmp");
    const viewerToken = mintToken(app, "viewerNoTeam");

    await createKb(adminToken, {
        title: `${FIXTURE_PREFIX}readable-kb`,
        source_type: "manual",
    });

    for (const tok of [adminToken, empToken, viewerToken]) {
        const r = await authedInject(app, tok, {
            method: "GET",
            url: "/knowledge-bases",
        });
        assert.equal(r.statusCode, 200);
        assert.ok(
            r.json().items.some((kb) => kb.title === `${FIXTURE_PREFIX}readable-kb`),
        );
    }
});

test("GET /knowledge-bases scopes results to caller's org", async () => {
    const acmeToken = mintToken(app, "acmeAdmin");
    const betaToken = mintToken(app, "betaAdmin");

    const acmeKb = await createKb(acmeToken, {
        title: `${FIXTURE_PREFIX}acme-only`,
        source_type: "manual",
    });
    const betaList = await authedInject(app, betaToken, {
        method: "GET",
        url: "/knowledge-bases",
    });
    assert.equal(betaList.statusCode, 200);
    assert.equal(
        betaList.json().items.find((kb) => kb.id === acmeKb.id),
        undefined,
        "Beta admin should not see Acme KBs",
    );
});

// ============================================================
//                       WRITE surface (admin-only)
// ============================================================

test("POST /knowledge-bases as employee → 403", async () => {
    const token = mintToken(app, "acmeEmp");
    const r = await authedInject(app, token, {
        method: "POST",
        url: "/knowledge-bases",
        headers: { "content-type": "application/json" },
        payload: {
            title: `${FIXTURE_PREFIX}should-fail`,
            source_type: "manual",
        },
    });
    assert.equal(r.statusCode, 403);
});

test("POST /knowledge-bases as manager → 403 (admin-only)", async () => {
    const token = mintToken(app, "managerTeamA");
    const r = await authedInject(app, token, {
        method: "POST",
        url: "/knowledge-bases",
        headers: { "content-type": "application/json" },
        payload: {
            title: `${FIXTURE_PREFIX}manager-blocked`,
            source_type: "manual",
        },
    });
    assert.equal(r.statusCode, 403);
});

test("POST /knowledge-bases as admin stamps created_by_user_id", async () => {
    const token = mintToken(app, "acmeAdmin");
    const kb = await createKb(token, {
        title: `${FIXTURE_PREFIX}admin-created`,
        source_type: "manual",
    });
    assert.equal(kb.org_id, ORG_ACME);
    assert.ok(kb.created_by_user_id, "creator should be set");
});

test("PATCH /knowledge-bases/:id cross-org → 404", async () => {
    const acmeToken = mintToken(app, "acmeAdmin");
    const betaToken = mintToken(app, "betaAdmin");

    const kb = await createKb(acmeToken, {
        title: `${FIXTURE_PREFIX}xorg-patch`,
        source_type: "manual",
    });
    const r = await authedInject(app, betaToken, {
        method: "PATCH",
        url: `/knowledge-bases/${kb.id}`,
        headers: { "content-type": "application/json" },
        payload: { title: "should not stick" },
    });
    assert.equal(r.statusCode, 404);
});

test("DELETE /knowledge-bases/:id (admin) soft-deletes and removes from list", async () => {
    const token = mintToken(app, "acmeAdmin");
    const kb = await createKb(token, {
        title: `${FIXTURE_PREFIX}soft-delete-target`,
        source_type: "manual",
    });
    const d = await authedInject(app, token, {
        method: "DELETE",
        url: `/knowledge-bases/${kb.id}`,
    });
    assert.equal(d.statusCode, 204);

    const list = await authedInject(app, token, {
        method: "GET",
        url: "/knowledge-bases",
    });
    assert.equal(
        list.json().items.find((row) => row.id === kb.id),
        undefined,
    );
});

// ============================================================
//                       Chunk replace + search
// ============================================================

test("POST /knowledge-bases/:id/chunks/replace embeds and stores chunks", async () => {
    const token = mintToken(app, "acmeAdmin");
    const kb = await createKb(token, {
        title: `${FIXTURE_PREFIX}chunks-target`,
        source_type: "manual",
    });
    const r = await authedInject(app, token, {
        method: "POST",
        url: `/knowledge-bases/${kb.id}/chunks/replace`,
        headers: { "content-type": "application/json" },
        payload: {
            chunks: [
                { position: 0, text: "Kloser는 영업 보조 SaaS 입니다." },
                { position: 1, text: "고객 통화 중 AI가 응대 멘트를 추천합니다." },
            ],
        },
    });
    assert.equal(r.statusCode, 200, r.body);
    const chunks = r.json().chunks;
    assert.equal(chunks.length, 2);
    for (const c of chunks) {
        // pgvector stores as text "[v1,v2,...]"; sanity-check it starts with '['.
        assert.ok(typeof c.embedding === "string");
        assert.ok(c.embedding.startsWith("["));
    }
});

test("POST /knowledge-bases/:id/chunks/replace rejects bad embedding dimension", async () => {
    const token = mintToken(app, "acmeAdmin");
    const kb = await createKb(token, {
        title: `${FIXTURE_PREFIX}bad-dim`,
        source_type: "manual",
    });
    const r = await authedInject(app, token, {
        method: "POST",
        url: `/knowledge-bases/${kb.id}/chunks/replace`,
        headers: { "content-type": "application/json" },
        payload: {
            chunks: [
                {
                    position: 0,
                    text: "wrong-dim",
                    embedding: [0.1, 0.2, 0.3], // length 3, not 1536
                },
            ],
        },
    });
    // zod rejects length !== 1536 at the route boundary → 400 invalid_input.
    assert.equal(r.statusCode, 400);
});

test("POST /knowledge-bases/search returns nearest match first", async () => {
    const token = mintToken(app, "acmeAdmin");
    const kb = await createKb(token, {
        title: `${FIXTURE_PREFIX}search-target`,
        source_type: "manual",
    });
    await authedInject(app, token, {
        method: "POST",
        url: `/knowledge-bases/${kb.id}/chunks/replace`,
        headers: { "content-type": "application/json" },
        payload: {
            chunks: [
                { position: 0, text: "고객 통화 중 AI 응대 멘트 추천" },
                { position: 1, text: "전혀 무관한 토픽: 우주 탐사선" },
            ],
        },
    });
    const r = await authedInject(app, token, {
        method: "POST",
        url: "/knowledge-bases/search",
        headers: { "content-type": "application/json" },
        payload: { query: "고객 통화 중 AI 응대 멘트 추천", limit: 5 },
    });
    assert.equal(r.statusCode, 200);
    const items = r.json().items;
    assert.ok(items.length >= 1);
    // The exact-match text should be the nearest (distance 0).
    assert.equal(items[0].text, "고객 통화 중 AI 응대 멘트 추천");
    assert.ok(items[0].distance <= items[items.length - 1].distance);
});

// ============================================================
//                Phase 6 Step 2 — usage logging wiring
// ============================================================

// Read llm_usage_log rows tagged for this suite (admin role bypasses
// FORCE RLS so we can see Acme + Beta in one query). Scoped by
// SUITE_START_ISO so concurrent test runs don't bleed.
async function readKnowledgeUsageRows(filter = {}) {
    if (!process.env.MIGRATE_DATABASE_URL) {
        throw new Error("MIGRATE_DATABASE_URL is required for usage assertions");
    }
    const client = new pg.Client({
        connectionString: process.env.MIGRATE_DATABASE_URL,
    });
    await client.connect();
    try {
        const conditions = [
            `created_at >= $1`,
            `metadata->>'source' IN ('route:knowledge.chunks.replace','route:knowledge.search')`,
        ];
        const params = [SUITE_START_ISO];
        if (filter.knowledgeBaseId) {
            params.push(filter.knowledgeBaseId);
            conditions.push(`metadata->>'knowledge_base_id' = $${params.length}`);
        }
        if (filter.source) {
            params.push(filter.source);
            conditions.push(`metadata->>'source' = $${params.length}`);
        }
        const r = await client.query(
            `SELECT id, org_id, call_id, provider, operation, model, status,
                    tokens_in, tokens_out, cost_usd_micros, metadata, created_at
               FROM llm_usage_log
              WHERE ${conditions.join(" AND ")}
              ORDER BY created_at ASC, id ASC`,
            params,
        );
        return r.rows;
    } finally {
        await client.end();
    }
}

test("chunks/replace records one usage row only for chunks without a precomputed embedding", async () => {
    const token = mintToken(app, "acmeAdmin");
    const kb = await createKb(token, {
        title: `${FIXTURE_PREFIX}wiring-mixed-replace`,
        source_type: "manual",
    });

    // Precompute a 1536-dim vector deterministically using the same
    // mock adapter the route would call. This lets us hand the chunk a
    // valid embedding without paying for a provider call — the route
    // must NOT log usage for this chunk.
    const precomputed = (await embedding.embed("precomputed text")).value;

    const r = await authedInject(app, token, {
        method: "POST",
        url: `/knowledge-bases/${kb.id}/chunks/replace`,
        headers: { "content-type": "application/json" },
        payload: {
            chunks: [
                { position: 0, text: "precomputed text", embedding: precomputed },
                { position: 1, text: "freshly embedded text 1" },
                { position: 2, text: "freshly embedded text 2" },
            ],
        },
    });
    assert.equal(r.statusCode, 200, r.body);

    const rows = await readKnowledgeUsageRows({ knowledgeBaseId: kb.id });
    assert.equal(
        rows.length,
        2,
        `expected exactly 2 usage rows (one per provider call), got ${rows.length}`,
    );
    for (const row of rows) {
        assert.equal(row.operation, "knowledge_embedding");
        assert.equal(row.provider, "mock");
        assert.equal(row.status, "succeeded");
        assert.equal(row.call_id, null, "knowledge embedding usage has no call");
        assert.equal(row.metadata.source, "route:knowledge.chunks.replace");
        assert.equal(row.metadata.knowledge_base_id, kb.id);
        assert.ok(
            row.metadata.chunk_index === 1 || row.metadata.chunk_index === 2,
            `chunk_index should point at the non-precomputed positions, got ${row.metadata.chunk_index}`,
        );
    }
});

test("search still succeeds when usage logging fails (malformed usage envelope)", async () => {
    const token = mintToken(app, "acmeAdmin");
    const kb = await createKb(token, {
        title: `${FIXTURE_PREFIX}wiring-search-broken-usage`,
        source_type: "manual",
    });
    await authedInject(app, token, {
        method: "POST",
        url: `/knowledge-bases/${kb.id}/chunks/replace`,
        headers: { "content-type": "application/json" },
        payload: {
            chunks: [{ position: 0, text: "broken-usage seed body" }],
        },
    });

    // Temporarily swap `embedding.embed` to return a malformed usage
    // envelope. The status='invalid_status' value violates the
    // llm_usage_log CHECK constraint, so the INSERT throws inside
    // services/llmUsage.recordProviderUsage. That service swallows the
    // error and returns null; the route layer never sees the failure.
    const realEmbed = embedding.embed.bind(embedding);
    embedding.embed = async (text) => {
        const real = await realEmbed(text);
        return {
            value: real.value,
            usage: {
                ...real.usage,
                // CHECK (status IN ('succeeded','failed','skipped')) — this
                // will trip the constraint deliberately.
                status: "invalid_status",
            },
        };
    };

    try {
        const r = await authedInject(app, token, {
            method: "POST",
            url: "/knowledge-bases/search",
            headers: { "content-type": "application/json" },
            payload: { query: "broken-usage seed body", limit: 3 },
        });
        // Search still returns 200 — logging failure is non-blocking.
        assert.equal(r.statusCode, 200, r.body);
        const items = r.json().items;
        assert.ok(items.length >= 1, "search should still return results");
    } finally {
        embedding.embed = realEmbed;
    }
});

test("search records one usage row for the query embedding", async () => {
    const token = mintToken(app, "acmeAdmin");
    // Seed at least one chunk so the result set is non-empty.
    const kb = await createKb(token, {
        title: `${FIXTURE_PREFIX}wiring-search-seed`,
        source_type: "manual",
    });
    await authedInject(app, token, {
        method: "POST",
        url: `/knowledge-bases/${kb.id}/chunks/replace`,
        headers: { "content-type": "application/json" },
        payload: {
            chunks: [{ position: 0, text: "wiring search seed body" }],
        },
    });

    // Drain rows produced by the seed call so the next assertion only
    // sees the search row.
    const before = await readKnowledgeUsageRows({
        source: "route:knowledge.search",
    });

    const r = await authedInject(app, token, {
        method: "POST",
        url: "/knowledge-bases/search",
        headers: { "content-type": "application/json" },
        payload: { query: "wiring search seed body", limit: 3 },
    });
    assert.equal(r.statusCode, 200);

    const after = await readKnowledgeUsageRows({
        source: "route:knowledge.search",
    });
    assert.equal(
        after.length - before.length,
        1,
        `search should log exactly one usage row; before=${before.length} after=${after.length}`,
    );
    const row = after[after.length - 1];
    assert.equal(row.operation, "knowledge_embedding");
    assert.equal(row.provider, "mock");
    assert.equal(row.status, "succeeded");
    assert.equal(row.call_id, null);
    assert.equal(row.metadata.source, "route:knowledge.search");
    assert.equal(row.metadata.query_length, "wiring search seed body".length);
});

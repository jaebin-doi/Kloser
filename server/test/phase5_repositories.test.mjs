/* Phase 5 Step 2 — repository tests for the new tables and the Phase 5
 * columns on calls / transcripts.
 *
 * Scope (Step 2 plan §6.2):
 *   - knowledge_bases / knowledge_chunks
 *       RLS, cross-org isolation, soft delete, vector helper rejection,
 *       cosine search ordering, NULL-embedding filter.
 *   - org_call_checklist_templates + call_checklist_items
 *       active-only listing, idempotent initialize, status CHECK.
 *   - call_suggestions
 *       unique (call_id, group_seq, type), used/dismissed CHECK.
 *   - calls heartbeat / sweep / customer linkage / AI vs manual summary.
 *   - transcripts STT metadata.
 *
 * Cleanup pattern: each test that inserts rows wraps work in try/finally
 * and hard-deletes by the row's id (cascade does the rest). Test rows
 * use the `phase5test-` text marker so a final sweep catches any leaks.
 * Seeded users/customers/memberships are never deleted.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import dbPlugin from "../src/plugins/db.js";
import * as calls from "../src/repositories/calls.js";
import * as transcripts from "../src/repositories/transcripts.js";
import * as kbRepo from "../src/repositories/knowledgeBases.js";
import * as chunkRepo from "../src/repositories/knowledgeChunks.js";
import * as templatesRepo from "../src/repositories/callChecklistTemplates.js";
import * as itemsRepo from "../src/repositories/callChecklistItems.js";
import * as suggestionsRepo from "../src/repositories/callSuggestions.js";
import { InvalidEmbeddingError } from "../src/repositories/knowledgeChunks.js";

const ORG_ACME = "11111111-1111-1111-1111-111111111111";
const ORG_BETA = "22222222-2222-2222-2222-222222222222";

const USER_ACME_ADMIN = "aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa";
const USER_ACME_EMP   = "aaaaaaaa-0002-0002-0002-aaaaaaaaaaaa";
const USER_BETA_ADMIN = "bbbbbbbb-0001-0001-0001-bbbbbbbbbbbb";

const CUSTOMER_ACME_KIM  = "eeeeeeee-1111-0001-0001-eeeeeeeeeeee";
const CUSTOMER_BETA_JUNG = "ffffffff-2222-0001-0001-ffffffffffff";

const PREFIX = "phase5test-";

let app;

before(async () => {
    app = Fastify({ logger: false });
    await app.register(dbPlugin);
});

after(async () => {
    // Defensive sweep — child tables first.
    for (const orgId of [ORG_ACME, ORG_BETA]) {
        await app.withOrgContext(orgId, async (client) => {
            await client.query(
                `DELETE FROM call_suggestions WHERE title LIKE $1`,
                [`${PREFIX}%`],
            );
            await client.query(
                `DELETE FROM call_checklist_items
                   WHERE call_id IN (
                       SELECT id FROM calls WHERE title LIKE $1
                   )`,
                [`${PREFIX}%`],
            );
            await client.query(
                `DELETE FROM transcripts
                   WHERE call_id IN (
                       SELECT id FROM calls WHERE title LIKE $1
                   )`,
                [`${PREFIX}%`],
            );
            await client.query(
                `DELETE FROM calls WHERE title LIKE $1`,
                [`${PREFIX}%`],
            );
            await client.query(
                `DELETE FROM knowledge_chunks
                   WHERE knowledge_base_id IN (
                       SELECT id FROM knowledge_bases WHERE title LIKE $1
                   )`,
                [`${PREFIX}%`],
            );
            await client.query(
                `DELETE FROM knowledge_bases WHERE title LIKE $1`,
                [`${PREFIX}%`],
            );
            await client.query(
                `DELETE FROM org_call_checklist_templates WHERE title LIKE $1`,
                [`${PREFIX}%`],
            );
        });
    }
    await app.close();
});

// ---------- helpers ---------- //

async function insertCallRaw(orgId, fields = {}) {
    return app.withOrgContext(orgId, async (client) => {
        const r = await client.query(
            `INSERT INTO calls (
                org_id, customer_id, agent_user_id, direction, status,
                title, started_at, last_seen_at
             ) VALUES ($1, $2, $3, $4, COALESCE($5,'in_progress'), $6, $7, $8)
             RETURNING id, org_id, status, last_seen_at, started_at, agent_user_id`,
            [
                orgId,
                fields.customer_id ?? null,
                fields.agent_user_id ?? null,
                fields.direction ?? "inbound",
                fields.status ?? null,
                fields.title ?? `${PREFIX}default`,
                fields.started_at ?? new Date(),
                fields.last_seen_at ?? null,
            ],
        );
        return r.rows[0];
    });
}

async function hardDeleteCall(orgId, id) {
    await app.withOrgContext(orgId, async (client) => {
        await client.query("DELETE FROM calls WHERE id = $1", [id]);
    });
}

function makeEmbedding(dim, seed = 0) {
    const arr = new Array(dim);
    for (let i = 0; i < dim; i += 1) {
        arr[i] = Math.sin(i + seed) * 0.001;
    }
    return arr;
}

// =============================================================
//                    KNOWLEDGE
// =============================================================

test("knowledge_bases / knowledge_chunks: bare pool sees 0", async () => {
    const kbs = await app.pg.query(
        "SELECT count(*)::int AS n FROM knowledge_bases",
    );
    assert.equal(kbs.rows[0].n, 0);
    const chunks = await app.pg.query(
        "SELECT count(*)::int AS n FROM knowledge_chunks",
    );
    assert.equal(chunks.rows[0].n, 0);
});

test("Acme: insert + list + get knowledge_base round-trip", async () => {
    const kb = await app.withOrgContext(ORG_ACME, (client) =>
        kbRepo.insertInCurrentOrg(client, ORG_ACME, {
            title: `${PREFIX}kb-roundtrip`,
            source_type: "manual",
            source_uri: null,
            created_by_user_id: USER_ACME_ADMIN,
        }),
    );
    try {
        assert.equal(kb.org_id, ORG_ACME);
        assert.equal(kb.source_type, "manual");
        assert.equal(kb.created_by_user_id, USER_ACME_ADMIN);

        const fetched = await app.withOrgContext(ORG_ACME, (client) =>
            kbRepo.getByIdInCurrentOrg(client, kb.id),
        );
        assert.ok(fetched);
        assert.equal(fetched.id, kb.id);

        const list = await app.withOrgContext(ORG_ACME, (client) =>
            kbRepo.listForCurrentOrg(client, { limit: 100, offset: 0 }),
        );
        assert.ok(list.find((row) => row.id === kb.id));
    } finally {
        await app.withOrgContext(ORG_ACME, (client) =>
            kbRepo.softDeleteByIdInCurrentOrg(client, kb.id),
        );
        // Hard-delete for clean leak (soft-delete leaves the row).
        await app.withOrgContext(ORG_ACME, async (client) => {
            await client.query("DELETE FROM knowledge_bases WHERE id = $1", [
                kb.id,
            ]);
        });
    }
});

test("Beta cannot see Acme knowledge_base", async () => {
    const kb = await app.withOrgContext(ORG_ACME, (client) =>
        kbRepo.insertInCurrentOrg(client, ORG_ACME, {
            title: `${PREFIX}kb-cross-org`,
            source_type: "manual",
        }),
    );
    try {
        const fromBeta = await app.withOrgContext(ORG_BETA, (client) =>
            kbRepo.getByIdInCurrentOrg(client, kb.id),
        );
        assert.equal(fromBeta, null);

        const list = await app.withOrgContext(ORG_BETA, (client) =>
            kbRepo.listForCurrentOrg(client, { limit: 100, offset: 0 }),
        );
        assert.equal(list.find((row) => row.id === kb.id), undefined);
    } finally {
        await app.withOrgContext(ORG_ACME, async (client) => {
            await client.query("DELETE FROM knowledge_bases WHERE id = $1", [
                kb.id,
            ]);
        });
    }
});

test("Acme context + insertInCurrentOrg(client, ORG_BETA, ...) raises 42501", async () => {
    await assert.rejects(
        app.withOrgContext(ORG_ACME, (client) =>
            kbRepo.insertInCurrentOrg(client, ORG_BETA, {
                title: `${PREFIX}kb-rls-violation`,
                source_type: "manual",
            }),
        ),
        (err) => err.code === "42501",
    );
});

test("knowledge_base wrong-org created_by_user_id raises 23503", async () => {
    await assert.rejects(
        app.withOrgContext(ORG_ACME, (client) =>
            kbRepo.insertInCurrentOrg(client, ORG_ACME, {
                title: `${PREFIX}kb-cross-creator`,
                source_type: "manual",
                created_by_user_id: USER_BETA_ADMIN,
            }),
        ),
        (err) => err.code === "23503",
    );
});

test("knowledge_base soft delete hides from list/get", async () => {
    const kb = await app.withOrgContext(ORG_ACME, (client) =>
        kbRepo.insertInCurrentOrg(client, ORG_ACME, {
            title: `${PREFIX}kb-soft-delete`,
            source_type: "manual",
        }),
    );
    try {
        const deleted = await app.withOrgContext(ORG_ACME, (client) =>
            kbRepo.softDeleteByIdInCurrentOrg(client, kb.id),
        );
        assert.equal(deleted, true);

        const fetched = await app.withOrgContext(ORG_ACME, (client) =>
            kbRepo.getByIdInCurrentOrg(client, kb.id),
        );
        assert.equal(fetched, null);
    } finally {
        await app.withOrgContext(ORG_ACME, async (client) => {
            await client.query("DELETE FROM knowledge_bases WHERE id = $1", [
                kb.id,
            ]);
        });
    }
});

test("knowledge_chunks: toVectorLiteral rejects wrong dimension before SQL", async () => {
    assert.throws(
        () => chunkRepo.toVectorLiteral([1, 2, 3]),
        (err) => err instanceof InvalidEmbeddingError,
    );
});

test("replace chunks creates positions 0..N", async () => {
    const kb = await app.withOrgContext(ORG_ACME, (client) =>
        kbRepo.insertInCurrentOrg(client, ORG_ACME, {
            title: `${PREFIX}kb-chunks`,
            source_type: "manual",
        }),
    );
    try {
        const chunks = await app.withOrgContext(ORG_ACME, (client) =>
            chunkRepo.replaceForKnowledgeBaseInCurrentOrg(
                client,
                ORG_ACME,
                kb.id,
                [
                    { position: 0, text: `${PREFIX}chunk-0` },
                    { position: 1, text: `${PREFIX}chunk-1` },
                    { position: 2, text: `${PREFIX}chunk-2` },
                ],
            ),
        );
        assert.ok(Array.isArray(chunks));
        assert.equal(chunks.length, 3);
        assert.deepEqual(
            chunks.map((c) => c.position),
            [0, 1, 2],
        );
        assert.equal(chunks[0].embedding, null);

        const listed = await app.withOrgContext(ORG_ACME, (client) =>
            chunkRepo.listByKnowledgeBaseInCurrentOrg(client, kb.id),
        );
        assert.ok(listed);
        assert.equal(listed.length, 3);
        assert.deepEqual(
            listed.map((c) => c.text),
            [`${PREFIX}chunk-0`, `${PREFIX}chunk-1`, `${PREFIX}chunk-2`],
        );
    } finally {
        await app.withOrgContext(ORG_ACME, async (client) => {
            await client.query("DELETE FROM knowledge_bases WHERE id = $1", [
                kb.id,
            ]);
        });
    }
});

test("replace chunks against cross-org KB returns null", async () => {
    const kb = await app.withOrgContext(ORG_ACME, (client) =>
        kbRepo.insertInCurrentOrg(client, ORG_ACME, {
            title: `${PREFIX}kb-cross-replace`,
            source_type: "manual",
        }),
    );
    try {
        const result = await app.withOrgContext(ORG_BETA, (client) =>
            chunkRepo.replaceForKnowledgeBaseInCurrentOrg(
                client,
                ORG_BETA,
                kb.id,
                [{ position: 0, text: `${PREFIX}cross` }],
            ),
        );
        assert.equal(result, null);
    } finally {
        await app.withOrgContext(ORG_ACME, async (client) => {
            await client.query("DELETE FROM knowledge_bases WHERE id = $1", [
                kb.id,
            ]);
        });
    }
});

test("vector search ignores NULL embeddings and returns nearest first", async () => {
    const kb = await app.withOrgContext(ORG_ACME, (client) =>
        kbRepo.insertInCurrentOrg(client, ORG_ACME, {
            title: `${PREFIX}kb-search`,
            source_type: "manual",
        }),
    );
    try {
        const baseEmbedding = makeEmbedding(1536, 0);
        const farEmbedding = makeEmbedding(1536, 100);
        await app.withOrgContext(ORG_ACME, (client) =>
            chunkRepo.replaceForKnowledgeBaseInCurrentOrg(
                client,
                ORG_ACME,
                kb.id,
                [
                    {
                        position: 0,
                        text: `${PREFIX}near`,
                        embedding: baseEmbedding,
                    },
                    {
                        position: 1,
                        text: `${PREFIX}far`,
                        embedding: farEmbedding,
                    },
                    {
                        position: 2,
                        text: `${PREFIX}no-embedding`,
                        embedding: null,
                    },
                ],
            ),
        );

        const results = await app.withOrgContext(ORG_ACME, (client) =>
            chunkRepo.searchSimilarInCurrentOrg(client, baseEmbedding, {
                limit: 10,
            }),
        );
        // Only chunks with non-null embedding (2 of 3).
        assert.equal(results.length, 2);
        assert.equal(results[0].text, `${PREFIX}near`);
        assert.ok(
            results[0].distance <= results[1].distance,
            "nearest result should sort first",
        );
        assert.ok(
            !results.find((r) => r.text === `${PREFIX}no-embedding`),
            "null-embedding chunks must be excluded from search",
        );
    } finally {
        await app.withOrgContext(ORG_ACME, async (client) => {
            await client.query("DELETE FROM knowledge_bases WHERE id = $1", [
                kb.id,
            ]);
        });
    }
});

// =============================================================
//                    CHECKLIST
// =============================================================

test("templates list/listActive sorted by sort_order; inactive excluded from active list", async () => {
    const tA = await app.withOrgContext(ORG_ACME, (client) =>
        templatesRepo.insertInCurrentOrg(client, ORG_ACME, {
            title: `${PREFIX}tmpl-a`,
            sort_order: 10,
            active: true,
        }),
    );
    const tB = await app.withOrgContext(ORG_ACME, (client) =>
        templatesRepo.insertInCurrentOrg(client, ORG_ACME, {
            title: `${PREFIX}tmpl-b`,
            sort_order: 5,
            active: true,
        }),
    );
    const tC = await app.withOrgContext(ORG_ACME, (client) =>
        templatesRepo.insertInCurrentOrg(client, ORG_ACME, {
            title: `${PREFIX}tmpl-c`,
            sort_order: 1,
            active: false,
        }),
    );
    try {
        const active = await app.withOrgContext(ORG_ACME, (client) =>
            templatesRepo.listActiveForCurrentOrg(client),
        );
        const activeMine = active.filter((t) => t.title.startsWith(PREFIX));
        assert.deepEqual(
            activeMine.map((t) => t.title),
            [`${PREFIX}tmpl-b`, `${PREFIX}tmpl-a`],
        );
    } finally {
        await app.withOrgContext(ORG_ACME, async (client) => {
            await client.query(
                `DELETE FROM org_call_checklist_templates WHERE id = ANY($1::uuid[])`,
                [[tA.id, tB.id, tC.id]],
            );
        });
    }
});

test("initializeForCall creates one item per active template; idempotent", async () => {
    const tA = await app.withOrgContext(ORG_ACME, (client) =>
        templatesRepo.insertInCurrentOrg(client, ORG_ACME, {
            title: `${PREFIX}init-tmpl-a`,
            sort_order: 1,
        }),
    );
    const tB = await app.withOrgContext(ORG_ACME, (client) =>
        templatesRepo.insertInCurrentOrg(client, ORG_ACME, {
            title: `${PREFIX}init-tmpl-b`,
            sort_order: 2,
        }),
    );
    const call = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}init-call`,
        agent_user_id: USER_ACME_ADMIN,
    });
    try {
        const first = await app.withOrgContext(ORG_ACME, (client) =>
            itemsRepo.initializeForCallInCurrentOrg(client, call.id),
        );
        const minePrefix = first.filter((it) =>
            [tA.id, tB.id].includes(it.template_id),
        );
        assert.equal(minePrefix.length, 2);

        // Run again — no duplicates.
        const second = await app.withOrgContext(ORG_ACME, (client) =>
            itemsRepo.initializeForCallInCurrentOrg(client, call.id),
        );
        const minePrefix2 = second.filter((it) =>
            [tA.id, tB.id].includes(it.template_id),
        );
        assert.equal(minePrefix2.length, 2);
        assert.deepEqual(
            minePrefix.map((i) => i.id).sort(),
            minePrefix2.map((i) => i.id).sort(),
        );
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
        await app.withOrgContext(ORG_ACME, async (client) => {
            await client.query(
                `DELETE FROM org_call_checklist_templates WHERE id = ANY($1::uuid[])`,
                [[tA.id, tB.id]],
            );
        });
    }
});

test("initializeForCall on cross-org call returns null", async () => {
    const call = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}cross-init`,
    });
    try {
        const result = await app.withOrgContext(ORG_BETA, (client) =>
            itemsRepo.initializeForCallInCurrentOrg(client, call.id),
        );
        assert.equal(result, null);
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

test("markStatus done sets checked_at + checked_by_user_id; open clears both", async () => {
    const tmpl = await app.withOrgContext(ORG_ACME, (client) =>
        templatesRepo.insertInCurrentOrg(client, ORG_ACME, {
            title: `${PREFIX}mark-tmpl`,
        }),
    );
    const call = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}mark-call`,
        agent_user_id: USER_ACME_ADMIN,
    });
    try {
        const inited = await app.withOrgContext(ORG_ACME, (client) =>
            itemsRepo.initializeForCallInCurrentOrg(client, call.id),
        );
        const mine = inited.find((it) => it.template_id === tmpl.id);
        assert.ok(mine);

        const done = await app.withOrgContext(ORG_ACME, (client) =>
            itemsRepo.markStatusInCurrentOrg(
                client,
                mine.id,
                "done",
                USER_ACME_ADMIN,
            ),
        );
        assert.equal(done.status, "done");
        assert.ok(done.checked_at instanceof Date);
        assert.equal(done.checked_by_user_id, USER_ACME_ADMIN);

        const reopened = await app.withOrgContext(ORG_ACME, (client) =>
            itemsRepo.markStatusInCurrentOrg(client, mine.id, "open", null),
        );
        assert.equal(reopened.status, "open");
        assert.equal(reopened.checked_at, null);
        assert.equal(reopened.checked_by_user_id, null);
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
        await app.withOrgContext(ORG_ACME, async (client) => {
            await client.query(
                `DELETE FROM org_call_checklist_templates WHERE id = $1`,
                [tmpl.id],
            );
        });
    }
});

test("raw INSERT with status='done' but checked_at NULL violates CHECK 23514", async () => {
    const tmpl = await app.withOrgContext(ORG_ACME, (client) =>
        templatesRepo.insertInCurrentOrg(client, ORG_ACME, {
            title: `${PREFIX}check-tmpl`,
        }),
    );
    const call = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}check-call`,
    });
    try {
        await assert.rejects(
            app.withOrgContext(ORG_ACME, async (client) => {
                await client.query(
                    `INSERT INTO call_checklist_items (org_id, call_id, template_id, status, checked_at)
                     VALUES ($1, $2, $3, 'done', NULL)`,
                    [ORG_ACME, call.id, tmpl.id],
                );
            }),
            (err) => err.code === "23514",
        );
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
        await app.withOrgContext(ORG_ACME, async (client) => {
            await client.query(
                `DELETE FROM org_call_checklist_templates WHERE id = $1`,
                [tmpl.id],
            );
        });
    }
});

// =============================================================
//                    SUGGESTIONS
// =============================================================

test("insertGroupForCall returns rows sorted by group/at/type; list mirrors", async () => {
    const call = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}sugg-call`,
    });
    try {
        const inserted = await app.withOrgContext(ORG_ACME, (client) =>
            suggestionsRepo.insertGroupForCallInCurrentOrg(client, call.id, [
                {
                    group_seq: 0,
                    at_ms: 1000,
                    tone: "blue",
                    type: "direction",
                    title: `${PREFIX}sg-0-direction`,
                },
                {
                    group_seq: 0,
                    at_ms: 1000,
                    tone: "amber",
                    type: "alert",
                    title: `${PREFIX}sg-0-alert`,
                },
            ]),
        );
        assert.equal(inserted.length, 2);

        const listed = await app.withOrgContext(ORG_ACME, (client) =>
            suggestionsRepo.listByCallInCurrentOrg(client, call.id),
        );
        assert.ok(listed);
        // sorted by group_seq, at_ms, type
        assert.deepEqual(
            listed.map((s) => s.type),
            ["alert", "direction"],
        );
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

test("duplicate (call_id, group_seq, type) raises 23505", async () => {
    const call = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}sugg-dup`,
    });
    try {
        await app.withOrgContext(ORG_ACME, (client) =>
            suggestionsRepo.insertGroupForCallInCurrentOrg(client, call.id, [
                {
                    group_seq: 0,
                    at_ms: 1000,
                    tone: "blue",
                    type: "direction",
                    title: `${PREFIX}dup-1`,
                },
            ]),
        );
        await assert.rejects(
            app.withOrgContext(ORG_ACME, (client) =>
                suggestionsRepo.insertGroupForCallInCurrentOrg(client, call.id, [
                    {
                        group_seq: 0,
                        at_ms: 2000,
                        tone: "cyan",
                        type: "direction",
                        title: `${PREFIX}dup-2`,
                    },
                ]),
            ),
            (err) => err.code === "23505",
        );
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

test("raw UPDATE setting both dismissed_at and used_at violates CHECK 23514", async () => {
    const call = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}sugg-check`,
    });
    try {
        const inserted = await app.withOrgContext(ORG_ACME, (client) =>
            suggestionsRepo.insertGroupForCallInCurrentOrg(client, call.id, [
                {
                    group_seq: 0,
                    at_ms: 1000,
                    tone: "blue",
                    type: "direction",
                    title: `${PREFIX}check-sugg`,
                },
            ]),
        );
        const s = inserted[0];
        await assert.rejects(
            app.withOrgContext(ORG_ACME, async (client) => {
                await client.query(
                    `UPDATE call_suggestions
                        SET dismissed_at = now(), used_at = now()
                      WHERE id = $1`,
                    [s.id],
                );
            }),
            (err) => err.code === "23514",
        );
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

test("list suggestions by cross-org call returns null", async () => {
    const call = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}sugg-cross`,
    });
    try {
        const result = await app.withOrgContext(ORG_BETA, (client) =>
            suggestionsRepo.listByCallInCurrentOrg(client, call.id),
        );
        assert.equal(result, null);
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

test("markUsed sets used_at; markDismissed sets dismissed_at", async () => {
    const call = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}sugg-marks`,
    });
    try {
        const inserted = await app.withOrgContext(ORG_ACME, (client) =>
            suggestionsRepo.insertGroupForCallInCurrentOrg(client, call.id, [
                {
                    group_seq: 0,
                    at_ms: 0,
                    tone: "blue",
                    type: "direction",
                    title: `${PREFIX}mark-used`,
                },
                {
                    group_seq: 0,
                    at_ms: 0,
                    tone: "blue",
                    type: "script",
                    title: `${PREFIX}mark-dismiss`,
                },
            ]),
        );
        const [a, b] = inserted;

        const usedAt = new Date();
        const used = await app.withOrgContext(ORG_ACME, (client) =>
            suggestionsRepo.markUsedInCurrentOrg(client, a.id, usedAt),
        );
        assert.ok(used);
        assert.ok(used.used_at instanceof Date);

        const dismissedAt = new Date();
        const dismissed = await app.withOrgContext(ORG_ACME, (client) =>
            suggestionsRepo.markDismissedInCurrentOrg(client, b.id, dismissedAt),
        );
        assert.ok(dismissed);
        assert.ok(dismissed.dismissed_at instanceof Date);
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

// =============================================================
//                    CALLS HEARTBEAT / SWEEP / LINKAGE / SUMMARY
// =============================================================

test("touchHeartbeat updates last_seen_at on in_progress; returns null for ended", async () => {
    const live = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}heartbeat-live`,
        status: "in_progress",
    });
    const ended = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}heartbeat-ended`,
        status: "ended",
    });
    try {
        const seenAt = new Date();
        const touched = await app.withOrgContext(ORG_ACME, (client) =>
            calls.touchHeartbeatInCurrentOrg(client, live.id, seenAt),
        );
        assert.ok(touched);
        assert.equal(
            new Date(touched.last_seen_at).getTime(),
            seenAt.getTime(),
        );

        const noTouch = await app.withOrgContext(ORG_ACME, (client) =>
            calls.touchHeartbeatInCurrentOrg(client, ended.id, seenAt),
        );
        assert.equal(noTouch, null);
    } finally {
        await hardDeleteCall(ORG_ACME, live.id);
        await hardDeleteCall(ORG_ACME, ended.id);
    }
});

test("markDroppedTimedOut marks only stale in_progress with non-null last_seen_at", async () => {
    const past = new Date(Date.now() - 5 * 60_000);
    const future = new Date(Date.now() + 60_000);
    const stale = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}sweep-stale`,
        status: "in_progress",
        last_seen_at: past,
    });
    const fresh = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}sweep-fresh`,
        status: "in_progress",
        last_seen_at: future,
    });
    const unheartbeated = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}sweep-no-hb`,
        status: "in_progress",
        last_seen_at: null,
    });
    const alreadyEnded = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}sweep-ended`,
        status: "ended",
        last_seen_at: past,
    });
    try {
        const cutoff = new Date(Date.now() - 60_000);
        const updated = await app.withOrgContext(ORG_ACME, (client) =>
            calls.markDroppedTimedOutInCurrentOrg(client, cutoff, new Date()),
        );
        // We expect at least our stale row; could be more if other tests
        // left rows behind, but never less.
        assert.ok(updated >= 1, `expected >= 1 dropped, got ${updated}`);

        const staleAfter = await app.withOrgContext(ORG_ACME, (client) =>
            calls.getByIdInCurrentOrg(client, stale.id),
        );
        assert.equal(staleAfter.status, "dropped");
        assert.equal(staleAfter.dropped_reason, "server_timeout");

        const freshAfter = await app.withOrgContext(ORG_ACME, (client) =>
            calls.getByIdInCurrentOrg(client, fresh.id),
        );
        assert.equal(freshAfter.status, "in_progress");

        const noHbAfter = await app.withOrgContext(ORG_ACME, (client) =>
            calls.getByIdInCurrentOrg(client, unheartbeated.id),
        );
        assert.equal(noHbAfter.status, "in_progress");

        const endedAfter = await app.withOrgContext(ORG_ACME, (client) =>
            calls.getByIdInCurrentOrg(client, alreadyEnded.id),
        );
        assert.equal(endedAfter.status, "ended");
    } finally {
        await hardDeleteCall(ORG_ACME, stale.id);
        await hardDeleteCall(ORG_ACME, fresh.id);
        await hardDeleteCall(ORG_ACME, unheartbeated.id);
        await hardDeleteCall(ORG_ACME, alreadyEnded.id);
    }
});

test("linkCustomer same-org binds; wrong-org customer raises 23503", async () => {
    const call = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}link-call`,
    });
    try {
        const linked = await app.withOrgContext(ORG_ACME, (client) =>
            calls.linkCustomerInCurrentOrg(
                client,
                call.id,
                CUSTOMER_ACME_KIM,
                USER_ACME_ADMIN,
                new Date(),
            ),
        );
        assert.ok(linked);
        assert.equal(linked.customer_id, CUSTOMER_ACME_KIM);
        assert.equal(linked.customer_linked_by_user_id, USER_ACME_ADMIN);
        assert.ok(linked.customer_linked_at instanceof Date);

        await assert.rejects(
            app.withOrgContext(ORG_ACME, (client) =>
                calls.linkCustomerInCurrentOrg(
                    client,
                    call.id,
                    CUSTOMER_BETA_JUNG,
                    USER_ACME_ADMIN,
                    new Date(),
                ),
            ),
            (err) => err.code === "23503",
        );

        // Unlink (customerId = null) leaves linked_at / by stamped.
        const unlinked = await app.withOrgContext(ORG_ACME, (client) =>
            calls.linkCustomerInCurrentOrg(
                client,
                call.id,
                null,
                USER_ACME_ADMIN,
                new Date(),
            ),
        );
        assert.equal(unlinked.customer_id, null);
        assert.equal(unlinked.customer_linked_by_user_id, USER_ACME_ADMIN);
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

test("updateAiSummary fills empty + replaces AI; cannot overwrite manual", async () => {
    const call = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}summary-call`,
        agent_user_id: USER_ACME_ADMIN,
    });
    try {
        // 1) AI can fill empty summary
        const first = await app.withOrgContext(ORG_ACME, (client) =>
            calls.updateAiSummaryInCurrentOrg(
                client,
                call.id,
                {
                    summary: "ai v1",
                    needs: null,
                    issues: null,
                    sentiment: "positive",
                },
                new Date(),
            ),
        );
        assert.ok(first);
        assert.equal(first.summary_source, "ai");
        assert.equal(first.summary, "ai v1");

        // 2) AI replaces previous AI
        const second = await app.withOrgContext(ORG_ACME, (client) =>
            calls.updateAiSummaryInCurrentOrg(
                client,
                call.id,
                {
                    summary: "ai v2",
                    needs: null,
                    issues: null,
                    sentiment: "neutral",
                },
                new Date(),
            ),
        );
        assert.equal(second.summary, "ai v2");

        // 3) Manual writes set source='manual'
        const manual = await app.withOrgContext(ORG_ACME, (client) =>
            calls.updateManualSummaryInCurrentOrg(client, call.id, {
                summary: "user hand-edit",
                needs: null,
                issues: null,
                sentiment: null,
            }),
        );
        assert.equal(manual.summary_source, "manual");
        assert.equal(manual.summary, "user hand-edit");

        // 4) AI cannot overwrite manual
        const aiBlocked = await app.withOrgContext(ORG_ACME, (client) =>
            calls.updateAiSummaryInCurrentOrg(
                client,
                call.id,
                {
                    summary: "ai v3 (should be ignored)",
                    needs: null,
                    issues: null,
                    sentiment: null,
                },
                new Date(),
            ),
        );
        assert.equal(aiBlocked, null);

        const reread = await app.withOrgContext(ORG_ACME, (client) =>
            calls.getByIdInCurrentOrg(client, call.id),
        );
        assert.equal(reread.summary, "user hand-edit");
        assert.equal(reread.summary_source, "manual");
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

test("transcript append stores stt_provider and stt_session_id", async () => {
    const call = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}stt-call`,
    });
    try {
        const tr = await app.withOrgContext(ORG_ACME, (client) =>
            transcripts.appendForCallInCurrentOrg(client, call.id, {
                speaker: "agent",
                text: `${PREFIX}stt-utterance`,
                stt_provider: "clova",
                stt_session_id: `${PREFIX}session-abc`,
            }),
        );
        assert.ok(tr);
        assert.equal(tr.stt_provider, "clova");
        assert.equal(tr.stt_session_id, `${PREFIX}session-abc`);

        const trNoStt = await app.withOrgContext(ORG_ACME, (client) =>
            transcripts.appendForCallInCurrentOrg(client, call.id, {
                speaker: "system",
                text: `${PREFIX}no-stt`,
            }),
        );
        assert.equal(trNoStt.stt_provider, null);
        assert.equal(trNoStt.stt_session_id, null);
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

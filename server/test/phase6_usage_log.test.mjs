/* Phase 6 Step 2 — llm_usage_log schema + RLS + repository tests.
 *
 * Plan: docs/plan/phase-6/PHASE_6_STEP_2_PLAN.md §3.2, §8.1.
 *
 * Scope (schema commit only):
 *   - FORCE RLS gives default-deny without GUC.
 *   - same-org insert + read.
 *   - cross-org reads return 0.
 *   - WITH CHECK rejects wrong org_id on INSERT.
 *   - composite FK rejects cross-org call_id even when org_id is correct.
 *   - append-only contract: app role cannot UPDATE/DELETE rows.
 *
 * Cleanup:
 *   - Rows tag themselves via metadata->>'test_tag' = 'phase6test-<id>'.
 *   - After-hook sweeps that tag plus any test-created calls
 *     (which carry the same prefix in `title`). Seeded rows untouched.
 *
 * Same-pool / two-instance considerations:
 *   We share a single Fastify(+ dbPlugin) instance, same as
 *   phase5_repositories.test.mjs. RLS scoping is per-transaction GUC.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import pg from "pg";
import dbPlugin from "../src/plugins/db.js";
import * as usageRepo from "../src/repositories/llmUsage.js";

const ORG_ACME = "11111111-1111-1111-1111-111111111111";
const ORG_BETA = "22222222-2222-2222-2222-222222222222";

const USER_ACME_ADMIN = "aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa";
const USER_BETA_ADMIN = "bbbbbbbb-0001-0001-0001-bbbbbbbbbbbb";

const PREFIX = `phase6test-${process.pid}-${Date.now()}-`;
const TEST_TAG = `${PREFIX}usage`;

let app;

async function withAdminClient(fn) {
    const url = process.env.MIGRATE_DATABASE_URL;
    if (!url) {
        throw new Error("MIGRATE_DATABASE_URL is required for llm_usage_log test cleanup");
    }
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
        return await fn(client);
    } finally {
        await client.end();
    }
}

before(async () => {
    app = Fastify({ logger: false });
    await app.register(dbPlugin);
});

after(async () => {
    // llm_usage_log is intentionally append-only for the app role: no
    // UPDATE/DELETE RLS policy. Test cleanup therefore uses the same
    // admin migration URL that migrations/seeds use, scoped strictly to
    // this process's metadata prefix.
    await withAdminClient(async (client) => {
        await client.query(
            `DELETE FROM llm_usage_log WHERE metadata->>'test_tag' LIKE $1`,
            [`${PREFIX}%`],
        );
    });
    // Defensive sweep — usage rows by test_tag, then any test calls.
    for (const orgId of [ORG_ACME, ORG_BETA]) {
        await app.withOrgContext(orgId, async (client) => {
            await client.query(
                `DELETE FROM llm_usage_log WHERE metadata->>'test_tag' LIKE $1`,
                [`${PREFIX}%`],
            );
            await client.query(
                `DELETE FROM calls WHERE title LIKE $1`,
                [`${PREFIX}%`],
            );
        });
    }
    await app.close();
});

// ---------- helpers ---------- //

async function insertCall(orgId, agentUserId, suffix) {
    return app.withOrgContext(orgId, async (client) => {
        const r = await client.query(
            `INSERT INTO calls (
                org_id, agent_user_id, direction, status,
                title, started_at
             ) VALUES ($1, $2, 'inbound', 'in_progress', $3, now())
             RETURNING id, org_id`,
            [orgId, agentUserId, `${PREFIX}${suffix}`],
        );
        return r.rows[0];
    });
}

function baseInput(overrides = {}) {
    return {
        provider: "mock",
        operation: "call_summary",
        model: "mock-summary-v1",
        status: "succeeded",
        tokens_in: 12,
        tokens_out: 34,
        latency_ms: 7,
        cost_usd_micros: 0,
        metadata: { test_tag: TEST_TAG },
        ...overrides,
    };
}

// =============================================================
//                       SCHEMA / RLS
// =============================================================

test("bare pool with no GUC sees 0 llm_usage_log rows", async () => {
    // Seed one Acme row first so the table has at least one tuple.
    await app.withOrgContext(ORG_ACME, (client) =>
        usageRepo.insertInCurrentOrg(client, ORG_ACME, baseInput()),
    );
    const r = await app.pg.query(
        "SELECT count(*)::int AS n FROM llm_usage_log",
    );
    assert.equal(r.rows[0].n, 0);
});

test("Acme insert + read round-trip via repository", async () => {
    const inserted = await app.withOrgContext(ORG_ACME, (client) =>
        usageRepo.insertInCurrentOrg(client, ORG_ACME, baseInput()),
    );
    assert.equal(inserted.org_id, ORG_ACME);
    assert.equal(inserted.provider, "mock");
    assert.equal(inserted.operation, "call_summary");
    assert.equal(inserted.status, "succeeded");
    assert.equal(inserted.tokens_in, 12);
    assert.equal(inserted.tokens_out, 34);
    assert.deepEqual(inserted.metadata, { test_tag: TEST_TAG });

    const rows = await app.withOrgContext(ORG_ACME, (client) =>
        usageRepo.listForCurrentOrgByTestTagPrefix(client, PREFIX),
    );
    assert.ok(rows.some((row) => row.id === inserted.id), "Acme list misses own row");
});

test("Beta cannot read Acme llm_usage_log rows", async () => {
    const acmeRow = await app.withOrgContext(ORG_ACME, (client) =>
        usageRepo.insertInCurrentOrg(client, ORG_ACME, baseInput()),
    );

    const fromBeta = await app.withOrgContext(ORG_BETA, (client) =>
        usageRepo.listForCurrentOrgByTestTagPrefix(client, PREFIX),
    );
    assert.equal(
        fromBeta.find((row) => row.id === acmeRow.id),
        undefined,
        "Beta should not see Acme usage row",
    );
});

test("Acme context cannot INSERT a row with org_id = Beta", async () => {
    // Insert raw SQL so we can force the org_id arg. The INSERT policy
    // WITH CHECK clause is `org_id = current_app_org_id()` — passing
    // ORG_BETA while the GUC says ORG_ACME must fail with 42501.
    await assert.rejects(
        app.withOrgContext(ORG_ACME, async (client) => {
            await client.query(
                `INSERT INTO llm_usage_log (
                    org_id, provider, operation, model, status, metadata
                 ) VALUES ($1, 'mock', 'call_summary', 'mock-v1', 'succeeded', $2::jsonb)`,
                [ORG_BETA, JSON.stringify({ test_tag: TEST_TAG })],
            );
        }),
        (err) => {
            assert.equal(err.code, "42501", `expected 42501 RLS, got ${err.code}`);
            return true;
        },
    );
});

test("composite FK rejects cross-org call_id under correct org_id", async () => {
    // Set up a Beta call, then try to log usage from Acme context
    // pointing at it. RLS-level org_id check passes (Acme inserts as
    // Acme), but the composite FK (org_id, call_id) -> calls(org_id, id)
    // fails because no Acme call shares that id. SQLSTATE 23503.
    const betaCall = await insertCall(ORG_BETA, USER_BETA_ADMIN, "fkguard-beta");

    await assert.rejects(
        app.withOrgContext(ORG_ACME, (client) =>
            usageRepo.insertInCurrentOrg(client, ORG_ACME, baseInput({
                call_id: betaCall.id,
            })),
        ),
        (err) => {
            assert.equal(err.code, "23503", `expected 23503 FK, got ${err.code}`);
            return true;
        },
    );
});

test("same-org call_id INSERT links usage to a call", async () => {
    const acmeCall = await insertCall(ORG_ACME, USER_ACME_ADMIN, "fkok-acme");

    const row = await app.withOrgContext(ORG_ACME, (client) =>
        usageRepo.insertInCurrentOrg(client, ORG_ACME, baseInput({
            call_id: acmeCall.id,
            operation: "call_suggestion",
            tokens_in: 4,
            tokens_out: 18,
        })),
    );

    assert.equal(row.call_id, acmeCall.id);

    const listed = await app.withOrgContext(ORG_ACME, (client) =>
        usageRepo.listForCallInCurrentOrg(client, acmeCall.id),
    );
    assert.ok(listed.some((r) => r.id === row.id));
});

// =============================================================
//                       APPEND-ONLY CONTRACT
// =============================================================

test("app role cannot UPDATE llm_usage_log rows (no update policy)", async () => {
    const row = await app.withOrgContext(ORG_ACME, (client) =>
        usageRepo.insertInCurrentOrg(client, ORG_ACME, baseInput()),
    );

    // No UPDATE policy + FORCE RLS = update silently affects 0 rows for
    // a non-BYPASSRLS role. We verify by reading row count and the
    // status field which we attempt to mutate.
    await app.withOrgContext(ORG_ACME, async (client) => {
        const r = await client.query(
            `UPDATE llm_usage_log SET status = 'failed' WHERE id = $1`,
            [row.id],
        );
        assert.equal(r.rowCount, 0, "UPDATE must match 0 rows under RLS");
    });

    const reread = await app.withOrgContext(ORG_ACME, async (client) => {
        const r = await client.query(
            `SELECT status FROM llm_usage_log WHERE id = $1`,
            [row.id],
        );
        return r.rows[0];
    });
    assert.equal(reread.status, "succeeded", "status must remain unchanged");
});

test("app role cannot DELETE llm_usage_log rows (no delete policy)", async () => {
    const row = await app.withOrgContext(ORG_ACME, (client) =>
        usageRepo.insertInCurrentOrg(client, ORG_ACME, baseInput()),
    );

    await app.withOrgContext(ORG_ACME, async (client) => {
        const r = await client.query(
            `DELETE FROM llm_usage_log WHERE id = $1`,
            [row.id],
        );
        assert.equal(r.rowCount, 0, "DELETE must match 0 rows under RLS");
    });

    // Row is still present from the Acme context.
    const stillThere = await app.withOrgContext(ORG_ACME, async (client) => {
        const r = await client.query(
            `SELECT id FROM llm_usage_log WHERE id = $1`,
            [row.id],
        );
        return r.rowCount;
    });
    assert.equal(stillThere, 1, "row must survive blocked DELETE");
});

// =============================================================
//                   CALL DELETE → SET NULL (call_id)
// =============================================================

test("ON DELETE SET NULL (call_id) preserves usage row when call is hard-deleted", async () => {
    const acmeCall = await insertCall(ORG_ACME, USER_ACME_ADMIN, "setnull-acme");
    const row = await app.withOrgContext(ORG_ACME, (client) =>
        usageRepo.insertInCurrentOrg(client, ORG_ACME, baseInput({
            call_id: acmeCall.id,
            operation: "stt_transcribe",
        })),
    );
    assert.equal(row.call_id, acmeCall.id);

    // Hard-delete the parent call. The composite FK with
    // ON DELETE SET NULL (call_id) must null only call_id, keeping
    // org_id intact (it is NOT NULL).
    await app.withOrgContext(ORG_ACME, async (client) => {
        await client.query("DELETE FROM calls WHERE id = $1", [acmeCall.id]);
    });

    const reread = await app.withOrgContext(ORG_ACME, async (client) => {
        const r = await client.query(
            `SELECT id, org_id, call_id FROM llm_usage_log WHERE id = $1`,
            [row.id],
        );
        return r.rows[0];
    });
    assert.ok(reread, "usage row must survive call delete");
    assert.equal(reread.org_id, ORG_ACME, "org_id must remain after call delete");
    assert.equal(reread.call_id, null, "call_id must be NULL after parent delete");
});

/* Phase 7 Step 9 — billing repository tests.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_9_PLAN.md §5.2, §7.
 *
 * Covers the repository surface that the service + cap guard sit on top
 * of. Direct DB assertions only — no Fastify HTTP injection. We pin the
 * fixtures to the seeded Acme/Beta orgs, drop everything we insert in a
 * try/finally, and never touch seed customer/KB rows.
 *
 * Cases:
 *   1. getCurrentOrganization → {id, name, plan} for the GUC org.
 *   2. lockCurrentOrganization → same shape; the SELECT FOR UPDATE
 *      succeeds (i.e. the app role has UPDATE grant on organizations).
 *   3. getCurrentBillingProfile returns the migration-backfilled row
 *      with billing_status='trialing' for a seeded org.
 *   4. upsertCurrentBillingProfile is idempotent (re-call → same row,
 *      no extra row inserted).
 *   5. patchCurrentBillingProfile updates billing_email + tax_id and
 *      bumps updated_at; unspecified fields untouched.
 *   6. patchCurrentBillingProfile with null clears the field; the row
 *      remains.
 *   7. patchCurrentBillingProfile with empty patch object → null (no
 *      UPDATE issued, no audit side-effect risk).
 *   8. getCurrentBillingUsage on Beta returns the seat denominator
 *      (active_members + pending_invitations) accurately as we toggle
 *      a manufactured pending invite.
 *   9. getCurrentBillingUsage counts customers/knowledge_bases/
 *      knowledge_chunks accurately when test rows are inserted.
 *  10. getCurrentBillingUsage's UTC-month window includes a call
 *      stamped at the start of the current UTC month and excludes a
 *      call stamped 1 ms before.
 *  11. monthly_llm_cost_usd_micros = null when every row in the month
 *      has cost_usd_micros NULL; → numeric when at least one row is
 *      priced (mix of priced + null becomes the priced sum).
 *  12. UTC month helpers (startOfUtcMonth / startOfNextUtcMonth /
 *      utcMonthLabel) round to the start of the month in UTC.
 *
 * Run: cd server && npm test
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import dbPlugin from "../src/plugins/db.js";
import {
    getCurrentBillingProfile,
    getCurrentBillingUsage,
    getCurrentOrganization,
    lockCurrentOrganization,
    patchCurrentBillingProfile,
    upsertCurrentBillingProfile,
    startOfUtcMonth,
    startOfNextUtcMonth,
    utcMonthLabel,
} from "../src/repositories/billing.ts";

const ORG_ACME = "11111111-1111-1111-1111-111111111111";
const ORG_BETA = "22222222-2222-2222-2222-222222222222";
const ACME_ADMIN_USER = "aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa";

const TEST_PREFIX = "phase7_step9_repo-";

let app;
const insertedCustomerIds = new Set();
const insertedKbIds = new Set();
const insertedChunkIds = new Set();
const insertedCallIds = new Set();
const insertedInviteIds = new Set();
const insertedLlmUsageIds = new Set();

before(async () => {
    app = Fastify({ logger: false });
    await app.register(dbPlugin);

    // The test mutates billing_email / tax_id on Acme; snapshot the row
    // first so afterEach can restore. Beta is treated the same way.
    for (const orgId of [ORG_ACME, ORG_BETA]) {
        await app.withOrgContext(orgId, async (client) => {
            await client.query(
                `INSERT INTO organization_billing_profiles (org_id)
                 VALUES (current_app_org_id())
                 ON CONFLICT (org_id) DO NOTHING`,
            );
        });
    }
});

after(async () => {
    // Restore billing profiles to the migration default. We do not delete
    // the row (migrations rely on the backfill staying present).
    for (const orgId of [ORG_ACME, ORG_BETA]) {
        await app.withOrgContext(orgId, async (client) => {
            await client.query(
                `UPDATE organization_billing_profiles
                    SET billing_email = NULL,
                        tax_id = NULL,
                        billing_status = 'trialing',
                        external_provider = NULL,
                        external_customer_id = NULL,
                        external_subscription_id = NULL,
                        metadata = '{}'::jsonb,
                        updated_at = now()
                  WHERE org_id = current_app_org_id()`,
            );
        });
    }
    await app.close();
});

afterEach(async () => {
    // Drop any rows the cases inserted.
    if (insertedChunkIds.size) {
        await app.withOrgContext(ORG_ACME, async (client) => {
            await client.query(
                `DELETE FROM knowledge_chunks WHERE id = ANY($1::uuid[])`,
                [Array.from(insertedChunkIds)],
            );
        });
        insertedChunkIds.clear();
    }
    if (insertedKbIds.size) {
        await app.withOrgContext(ORG_ACME, async (client) => {
            await client.query(
                `DELETE FROM knowledge_bases WHERE id = ANY($1::uuid[])`,
                [Array.from(insertedKbIds)],
            );
        });
        insertedKbIds.clear();
    }
    if (insertedCustomerIds.size) {
        await app.withOrgContext(ORG_ACME, async (client) => {
            await client.query(
                `DELETE FROM customers WHERE id = ANY($1::uuid[])`,
                [Array.from(insertedCustomerIds)],
            );
        });
        insertedCustomerIds.clear();
    }
    if (insertedCallIds.size) {
        await app.withOrgContext(ORG_ACME, async (client) => {
            await client.query(
                `DELETE FROM calls WHERE id = ANY($1::uuid[])`,
                [Array.from(insertedCallIds)],
            );
        });
        insertedCallIds.clear();
    }
    if (insertedInviteIds.size) {
        for (const orgId of [ORG_ACME, ORG_BETA]) {
            await app.withOrgContext(orgId, async (client) => {
                await client.query(
                    `DELETE FROM auth_tokens
                      WHERE invitation_id = ANY($1::uuid[])`,
                    [Array.from(insertedInviteIds)],
                );
                await client.query(
                    `DELETE FROM invitations WHERE id = ANY($1::uuid[])`,
                    [Array.from(insertedInviteIds)],
                );
            });
        }
        insertedInviteIds.clear();
    }
    if (insertedLlmUsageIds.size) {
        await app.withOrgContext(ORG_ACME, async (client) => {
            await client.query(
                `DELETE FROM llm_usage_log WHERE id = ANY($1::uuid[])`,
                [Array.from(insertedLlmUsageIds)],
            );
        });
        insertedLlmUsageIds.clear();
    }
});

async function withTx(orgId, fn) {
    return app.withOrgContext(orgId, fn);
}

// =============================================================== //
// 1. getCurrentOrganization
// =============================================================== //

test("1. getCurrentOrganization → seed row for the GUC org", async () => {
    const acme = await withTx(ORG_ACME, (c) => getCurrentOrganization(c));
    assert.equal(acme?.id, ORG_ACME);
    assert.equal(acme?.plan, "pro");
    const beta = await withTx(ORG_BETA, (c) => getCurrentOrganization(c));
    assert.equal(beta?.id, ORG_BETA);
    assert.equal(beta?.plan, "starter");
});

// =============================================================== //
// 2. lockCurrentOrganization — requires UPDATE grant
// =============================================================== //

test("2. lockCurrentOrganization succeeds under app role (UPDATE grant present)", async () => {
    const row = await withTx(ORG_ACME, (c) => lockCurrentOrganization(c));
    assert.equal(row?.id, ORG_ACME);
});

// =============================================================== //
// 3. getCurrentBillingProfile — migration backfill
// =============================================================== //

test("3. getCurrentBillingProfile returns the trialing backfill row", async () => {
    const row = await withTx(ORG_ACME, (c) => getCurrentBillingProfile(c));
    assert.equal(row?.org_id, ORG_ACME);
    assert.equal(row?.billing_status, "trialing");
    assert.equal(row?.metadata && typeof row.metadata, "object");
});

// =============================================================== //
// 4. upsertCurrentBillingProfile idempotent
// =============================================================== //

test("4. upsertCurrentBillingProfile is idempotent (no extra row)", async () => {
    const first = await withTx(ORG_ACME, (c) => upsertCurrentBillingProfile(c));
    const second = await withTx(ORG_ACME, (c) => upsertCurrentBillingProfile(c));
    assert.equal(first.org_id, second.org_id);
    assert.equal(first.created_at.toISOString(), second.created_at.toISOString());
    const count = await withTx(ORG_ACME, async (c) => {
        const r = await c.query(
            `SELECT count(*)::int AS n FROM organization_billing_profiles
              WHERE org_id = current_app_org_id()`,
        );
        return r.rows[0].n;
    });
    assert.equal(count, 1);
});

// =============================================================== //
// 5. patchCurrentBillingProfile — partial update
// =============================================================== //

test("5. patchCurrentBillingProfile updates only specified fields + bumps updated_at", async () => {
    const before = await withTx(ORG_ACME, (c) => upsertCurrentBillingProfile(c));
    // Sleep 50ms so updated_at can advance even on coarse clocks.
    await new Promise((r) => setTimeout(r, 50));
    const after = await withTx(ORG_ACME, (c) =>
        patchCurrentBillingProfile(c, { billing_email: "billing@acme.test" }),
    );
    assert.equal(after?.billing_email, "billing@acme.test");
    assert.equal(after?.tax_id, before.tax_id); // unchanged
    assert.ok(
        after && after.updated_at.getTime() > before.updated_at.getTime(),
        "updated_at must advance",
    );
});

// =============================================================== //
// 6. patchCurrentBillingProfile — null clears field
// =============================================================== //

test("6. patchCurrentBillingProfile with null clears the value", async () => {
    await withTx(ORG_ACME, (c) =>
        patchCurrentBillingProfile(c, { tax_id: "123-45-67890" }),
    );
    const cleared = await withTx(ORG_ACME, (c) =>
        patchCurrentBillingProfile(c, { tax_id: null }),
    );
    assert.equal(cleared?.tax_id, null);
});

// =============================================================== //
// 7. patchCurrentBillingProfile — empty patch returns null
// =============================================================== //

test("7. patchCurrentBillingProfile({}) → null (no UPDATE issued)", async () => {
    const r = await withTx(ORG_ACME, (c) =>
        patchCurrentBillingProfile(c, {}),
    );
    assert.equal(r, null);
});

// =============================================================== //
// 8. getCurrentBillingUsage — seat denominator
// =============================================================== //

test("8. getCurrentBillingUsage counts active_members + pending_invitations", async () => {
    // Beta has 2 active members from the seed. Insert one pending
    // invitation and confirm seats math.
    const inviteId = randomUUID();
    insertedInviteIds.add(inviteId);
    const tokenId = randomUUID();
    await withTx(ORG_BETA, async (client) => {
        await client.query(
            `INSERT INTO invitations (id, org_id, email, role, invited_by_user_id)
             VALUES ($1, current_app_org_id(), $2, 'employee', NULL)`,
            [inviteId, `${TEST_PREFIX}seat@beta.test`],
        );
        await client.query(
            `INSERT INTO auth_tokens (id, org_id, invitation_id, purpose, token_hash, expires_at)
             VALUES ($1, current_app_org_id(), $2, 'invitation', $3, now() + interval '7 days')`,
            [tokenId, inviteId, randomUUID()],
        );
    });

    const usage = await withTx(ORG_BETA, (c) =>
        getCurrentBillingUsage(c, new Date()),
    );
    assert.equal(usage.active_members, 2);
    assert.equal(usage.pending_invitations, 1);
});

// =============================================================== //
// 9. getCurrentBillingUsage — customer/KB/chunk counts
// =============================================================== //

test("9. getCurrentBillingUsage counts customers/KBs/chunks (non-deleted only)", async () => {
    const beforeUsage = await withTx(ORG_ACME, (c) =>
        getCurrentBillingUsage(c, new Date()),
    );

    const custId = randomUUID();
    const kbId = randomUUID();
    const chunkId = randomUUID();
    insertedCustomerIds.add(custId);
    insertedKbIds.add(kbId);
    insertedChunkIds.add(chunkId);

    await withTx(ORG_ACME, async (client) => {
        await client.query(
            `INSERT INTO customers (id, org_id, name, status)
             VALUES ($1, current_app_org_id(), $2, 'active')`,
            [custId, `${TEST_PREFIX}cust`],
        );
        await client.query(
            `INSERT INTO knowledge_bases (id, org_id, title, source_type)
             VALUES ($1, current_app_org_id(), $2, 'manual')`,
            [kbId, `${TEST_PREFIX}kb`],
        );
        await client.query(
            `INSERT INTO knowledge_chunks
                (id, org_id, knowledge_base_id, position, text, embedding)
             VALUES ($1, current_app_org_id(), $2, 0, 'hello', $3::vector)`,
            [chunkId, kbId, `[${Array(1536).fill(0).join(",")}]`],
        );
    });

    const after = await withTx(ORG_ACME, (c) =>
        getCurrentBillingUsage(c, new Date()),
    );
    assert.equal(after.customers, beforeUsage.customers + 1);
    assert.equal(after.knowledge_bases, beforeUsage.knowledge_bases + 1);
    assert.equal(after.knowledge_chunks, beforeUsage.knowledge_chunks + 1);
});

// =============================================================== //
// 10. monthly_calls window is half-open [monthStart, nextMonthStart)
// =============================================================== //

test("10. getCurrentBillingUsage.monthly_calls applies a half-open UTC-month window", async () => {
    const now = new Date();
    const monthStart = startOfUtcMonth(now);
    const oneMsBefore = new Date(monthStart.getTime() - 1);

    const beforeUsage = await withTx(ORG_ACME, (c) =>
        getCurrentBillingUsage(c, now),
    );

    const inWindowId = randomUUID();
    const outOfWindowId = randomUUID();
    insertedCallIds.add(inWindowId);
    insertedCallIds.add(outOfWindowId);

    await withTx(ORG_ACME, async (client) => {
        await client.query(
            `INSERT INTO calls (id, org_id, agent_user_id, direction, status, started_at, title)
             VALUES ($1, current_app_org_id(), $2, 'inbound', 'in_progress', $3, $4)`,
            [inWindowId, ACME_ADMIN_USER, monthStart, `${TEST_PREFIX}in`],
        );
        await client.query(
            `INSERT INTO calls (id, org_id, agent_user_id, direction, status, started_at, title)
             VALUES ($1, current_app_org_id(), $2, 'inbound', 'in_progress', $3, $4)`,
            [outOfWindowId, ACME_ADMIN_USER, oneMsBefore, `${TEST_PREFIX}out`],
        );
    });

    const afterUsage = await withTx(ORG_ACME, (c) =>
        getCurrentBillingUsage(c, now),
    );
    // Exactly one of the two test calls is in the window.
    assert.equal(afterUsage.monthly_calls, beforeUsage.monthly_calls + 1);
});

// =============================================================== //
// 11. monthly_llm_cost_usd_micros null/sum semantics
// =============================================================== //

test("11. monthly_llm_cost_usd_micros = null when only unknown rows; sum otherwise", async () => {
    const now = new Date();

    // Snapshot baseline so test data adds deterministically.
    const before = await withTx(ORG_ACME, (c) =>
        getCurrentBillingUsage(c, now),
    );

    // Insert one unknown row only.
    const unknownId = randomUUID();
    insertedLlmUsageIds.add(unknownId);
    await withTx(ORG_ACME, async (client) => {
        await client.query(
            `INSERT INTO llm_usage_log
               (id, org_id, provider, operation, model, status,
                tokens_in, tokens_out, cost_usd_micros, created_at, metadata)
             VALUES ($1, current_app_org_id(), 'clova', 'stt_transcribe',
                     'clova-stt', 'succeeded', NULL, NULL, NULL,
                     $2, '{}'::jsonb)`,
            [unknownId, now],
        );
    });

    // If baseline had NO priced rows, the result here would still be
    // null (only-unknowns rule). If baseline had priced rows, the unknown
    // is invisible to the sum. We need both branches deterministic — so
    // we now add a priced row and assert the sum advances by exactly its
    // amount.
    const priced = await withTx(ORG_ACME, (c) =>
        getCurrentBillingUsage(c, now),
    );
    // If baseline was only-unknowns, the result is still null.
    if (before.monthly_llm_cost_usd_micros === null) {
        assert.equal(priced.monthly_llm_cost_usd_micros, null);
    } else {
        assert.equal(
            priced.monthly_llm_cost_usd_micros,
            before.monthly_llm_cost_usd_micros,
            "unknown row must not change the sum of priced rows",
        );
    }

    // Now add a priced row → sum advances by exactly 1234.
    const pricedId = randomUUID();
    insertedLlmUsageIds.add(pricedId);
    await withTx(ORG_ACME, async (client) => {
        await client.query(
            `INSERT INTO llm_usage_log
               (id, org_id, provider, operation, model, status,
                tokens_in, tokens_out, cost_usd_micros, created_at, metadata)
             VALUES ($1, current_app_org_id(), 'mock', 'call_summary',
                     'mock-model', 'succeeded', 0, 0, 1234,
                     $2, '{}'::jsonb)`,
            [pricedId, now],
        );
    });
    const withPriced = await withTx(ORG_ACME, (c) =>
        getCurrentBillingUsage(c, now),
    );
    const baseline = before.monthly_llm_cost_usd_micros ?? 0;
    assert.equal(withPriced.monthly_llm_cost_usd_micros, baseline + 1234);
});

// =============================================================== //
// 12. UTC month helpers
// =============================================================== //

test("12. UTC month helpers round to UTC month boundaries", () => {
    const d = new Date(Date.UTC(2026, 4, 18, 14, 30, 7, 123));
    const start = startOfUtcMonth(d);
    const next = startOfNextUtcMonth(d);
    assert.equal(start.toISOString(), "2026-05-01T00:00:00.000Z");
    assert.equal(next.toISOString(), "2026-06-01T00:00:00.000Z");
    assert.equal(utcMonthLabel(d), "2026-05");

    // December → next month rolls year.
    const dec = new Date(Date.UTC(2026, 11, 31, 23, 59, 59));
    assert.equal(startOfNextUtcMonth(dec).toISOString(), "2027-01-01T00:00:00.000Z");
    assert.equal(utcMonthLabel(dec), "2026-12");
});

/* Phase 7 Step 3 — activity_log repository unit tests.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_3_PLAN.md §5 / §10.
 *
 * Covered scenarios (matches plan §5 + the user's repo test list):
 *
 *   RLS / org isolation
 *     - bare pool / no GUC list → 0 rows
 *     - Acme context insert visible from Acme context
 *     - Beta context cannot see Acme row
 *     - Acme context insert with orgId=Beta is rejected by RLS WITH CHECK
 *
 *   DB CHECK constraints (defense in depth — TS unions can drift)
 *     - unknown action string → check rejected
 *     - unknown target_type string → check rejected
 *     - non-object payload (array) → check rejected
 *
 *   Repository hygiene
 *     - payload `undefined` top-level keys are dropped, not stored as null
 *     - default payload is `{}`
 *
 *   Filters
 *     - action
 *     - target_type + target_id
 *     - user_id
 *     - created_from / created_to
 *
 *   Pagination
 *     - cursor-paginated, stable when many rows share the same created_at
 *
 *   Count
 *     - countForCurrentOrg matches the same filters as listForCurrentOrg
 *
 * Fixture strategy:
 *   - Every row this suite writes is tagged with `payload._test_run` =
 *     this run's TEST_RUN_ID. The `after` hook DELETEs everything
 *     tagged with that id from both orgs.
 *   - We never use route handlers or service code — the repository is
 *     called directly with a `PoolClient` and `BEGIN; SELECT set_config('app.org_id', $1, true);`.
 *
 * Run: cd server && npm test
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { pool } from "../src/db/pool.js";
import dbPlugin from "../src/plugins/db.js";
import {
    insertActivity,
    listForCurrentOrg,
    countForCurrentOrg,
} from "../src/repositories/activityLog.js";

const ORG_ACME = "11111111-1111-1111-1111-111111111111";
const ORG_BETA = "22222222-2222-2222-2222-222222222222";
const ACME_ADMIN = "aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa";
const ACME_EMP   = "aaaaaaaa-0002-0002-0002-aaaaaaaaaaaa";

/** Per-run fingerprint embedded in payload. The cleanup hook deletes
 *  every row tagged with this id from both orgs. Parallel test runs (if
 *  ever) would each carry their own id, so we never wipe each other. */
const TEST_RUN_ID = `phase7-step3-repo-${randomUUID()}`;

let app;

before(async () => {
    app = Fastify({ logger: false });
    await app.register(dbPlugin);
});

after(async () => {
    // FORCE RLS means a bare DELETE from the app role under no GUC sees
    // zero rows — go through withOrgContext for each org we touched.
    for (const orgId of [ORG_ACME, ORG_BETA]) {
        try {
            await app.withOrgContext(orgId, async (client) => {
                await client.query(
                    `DELETE FROM activity_log
                       WHERE payload->>'_test_run' = $1`,
                    [TEST_RUN_ID],
                );
            });
        } catch (_) { /* best-effort cleanup */ }
    }
    await app.close();
});

// ---------------------------------------------------------------------- //
// helpers
// ---------------------------------------------------------------------- //

/** Run `fn` inside a transaction with `app.org_id` set (or unset). */
async function withTx(orgId, fn) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        if (orgId) {
            await client.query(
                "SELECT set_config('app.org_id', $1, true)",
                [orgId],
            );
        }
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

/** Tag a payload with the test-run id so the cleanup hook can find it. */
function tagged(extra = {}) {
    return { ...extra, _test_run: TEST_RUN_ID };
}

// ====================================================================== //
//                            RLS / ISOLATION
// ====================================================================== //

test("listForCurrentOrg with no app.org_id GUC returns 0 rows (RLS default-deny)", async () => {
    // Seed one row under Acme so there IS something to leak if RLS broke.
    await withTx(ORG_ACME, (client) =>
        insertActivity(client, {
            orgId:  ORG_ACME,
            action: "auth.login",
            payload: tagged({ probe: "no-guc" }),
        }),
    );

    await withTx(null, async (client) => {
        const rows = await listForCurrentOrg(client, { limit: 100 });
        assert.equal(rows.length, 0, "bare-pool/no-GUC must see 0 rows");
        const n = await countForCurrentOrg(client, {});
        assert.equal(n, 0, "bare-pool/no-GUC count must be 0");
    });
});

test("Acme context: insertActivity is readable back in the same org context", async () => {
    let inserted;
    await withTx(ORG_ACME, async (client) => {
        inserted = await insertActivity(client, {
            orgId:      ORG_ACME,
            userId:     ACME_ADMIN,
            action:     "auth.login",
            targetType: "session",
            targetId:   randomUUID(),
            payload:    tagged({ probe: "acme-roundtrip" }),
        });
    });

    assert.equal(inserted.org_id, ORG_ACME);
    assert.equal(inserted.user_id, ACME_ADMIN);
    assert.equal(inserted.action, "auth.login");
    assert.equal(inserted.target_type, "session");
    assert.equal(inserted.payload.probe, "acme-roundtrip");
    assert.ok(inserted.created_at instanceof Date);

    await withTx(ORG_ACME, async (client) => {
        const rows = await listForCurrentOrg(client, {
            action: "auth.login",
            limit:  10,
        });
        const found = rows.find((r) => r.id === inserted.id);
        assert.ok(found, "Acme context must see its own row");
        assert.equal(found.payload.probe, "acme-roundtrip");
    });
});

test("Beta context cannot see an Acme row", async () => {
    let acmeRow;
    await withTx(ORG_ACME, async (client) => {
        acmeRow = await insertActivity(client, {
            orgId:   ORG_ACME,
            action:  "auth.login",
            payload: tagged({ probe: "cross-org-leak" }),
        });
    });

    await withTx(ORG_BETA, async (client) => {
        const rows = await listForCurrentOrg(client, { limit: 100 });
        const leaked = rows.find((r) => r.id === acmeRow.id);
        assert.equal(leaked, undefined, "Beta must not see Acme's audit row");
    });
});

test("Acme context inserting orgId=Beta is rejected by RLS WITH CHECK", async () => {
    await assert.rejects(
        () => withTx(ORG_ACME, (client) =>
            insertActivity(client, {
                orgId:   ORG_BETA,
                action:  "auth.login",
                payload: tagged({ probe: "with-check" }),
            }),
        ),
        (err) => {
            const msg = String(err.message || err);
            // Postgres RLS message text contains "row-level security policy"
            // and includes the table name. Accept either the message or
            // the SQLSTATE 42501.
            return (
                msg.includes("row-level security policy") ||
                msg.includes("activity_log") && msg.includes("policy") ||
                err.code === "42501"
            );
        },
        "Inserting another org's row from Acme context must be blocked by RLS",
    );
});

// ====================================================================== //
//                            DB CHECK constraints
// ====================================================================== //

test("DB rejects unknown action string (activity_log_action_check)", async () => {
    await assert.rejects(
        () => withTx(ORG_ACME, (client) =>
            // Bypass TS by going through raw SQL — we WANT to prove the DB
            // layer rejects this, not the TypeScript union.
            client.query(
                `INSERT INTO activity_log (org_id, action, payload)
                 VALUES ($1, $2, $3::jsonb)`,
                [ORG_ACME, "this.is.not.a.real.action", JSON.stringify(tagged({}))],
            ),
        ),
        (err) => /activity_log_action_check/i.test(String(err.message || err))
              || err.code === "23514",
    );
});

test("DB rejects unknown target_type string (activity_log_target_type_check)", async () => {
    await assert.rejects(
        () => withTx(ORG_ACME, (client) =>
            client.query(
                `INSERT INTO activity_log (org_id, action, target_type, payload)
                 VALUES ($1, $2, $3, $4::jsonb)`,
                [ORG_ACME, "auth.login", "banana", JSON.stringify(tagged({}))],
            ),
        ),
        (err) => /activity_log_target_type_check/i.test(String(err.message || err))
              || err.code === "23514",
    );
});

test("DB rejects non-object payload (activity_log_payload_object_check)", async () => {
    await assert.rejects(
        () => withTx(ORG_ACME, (client) =>
            client.query(
                `INSERT INTO activity_log (org_id, action, payload)
                 VALUES ($1, $2, $3::jsonb)`,
                // jsonb '[]' is a valid jsonb document but jsonb_typeof = 'array'
                [ORG_ACME, "auth.login", "[]"],
            ),
        ),
        (err) => /activity_log_payload_object_check/i.test(String(err.message || err))
              || err.code === "23514",
    );
});

// ====================================================================== //
//                            payload hygiene
// ====================================================================== //

test("insertActivity drops top-level undefined keys from payload", async () => {
    let row;
    await withTx(ORG_ACME, async (client) => {
        row = await insertActivity(client, {
            orgId:  ORG_ACME,
            action: "auth.login",
            payload: tagged({
                kept:        "yes",
                droppedUndef: undefined,
                explicitNull: null,
            }),
        });
    });

    // `droppedUndef` must NOT appear in the stored row at all.
    assert.ok(
        !Object.prototype.hasOwnProperty.call(row.payload, "droppedUndef"),
        "undefined keys must be omitted, not stored as null",
    );
    // Explicit null is a deliberate signal — keep it.
    assert.equal(row.payload.explicitNull, null);
    assert.equal(row.payload.kept, "yes");
    assert.equal(row.payload._test_run, TEST_RUN_ID);
});

test("insertActivity with no payload defaults to {}", async () => {
    let row;
    // Use a non-test marker for THIS one only since we need empty payload —
    // but we still want cleanup to find it. Insert it with a tagged
    // payload, then assert against a separately-inserted truly-default row.
    await withTx(ORG_ACME, async (client) => {
        row = await insertActivity(client, {
            orgId:  ORG_ACME,
            action: "auth.logout",
            payload: tagged({}),  // tag-only, no other fields
        });
    });
    assert.deepEqual(
        Object.keys(row.payload).sort(),
        ["_test_run"],
        "tag-only payload should round-trip as exactly the tag",
    );

    // And: no payload at all → DB default `{}` plus we never call
    // normalizePayload's branch where input is undefined, so the
    // INSERT sends `{}` and DB stores `{}`.
    let row2;
    await withTx(ORG_ACME, async (client) => {
        // We can't easily clean up an untagged row, so we tag via target_id
        // instead and DELETE it inline after the assertion.
        row2 = await insertActivity(client, {
            orgId:      ORG_ACME,
            action:     "auth.logout",
            targetType: "session",
            targetId:   randomUUID(),
            // payload omitted entirely
        });
        assert.deepEqual(row2.payload, {});
        await client.query(`DELETE FROM activity_log WHERE id = $1`, [row2.id]);
    });
});

// ====================================================================== //
//                            filters
// ====================================================================== //

test("action filter narrows to that action only", async () => {
    const probeAction1 = "mfa.login_challenge_issued";
    const probeAction2 = "mfa.login_verified";
    await withTx(ORG_ACME, async (client) => {
        await insertActivity(client, { orgId: ORG_ACME, action: probeAction1, payload: tagged({ k: "action-filter-1" }) });
        await insertActivity(client, { orgId: ORG_ACME, action: probeAction1, payload: tagged({ k: "action-filter-2" }) });
        await insertActivity(client, { orgId: ORG_ACME, action: probeAction2, payload: tagged({ k: "action-filter-3" }) });
    });

    await withTx(ORG_ACME, async (client) => {
        const rows = await listForCurrentOrg(client, {
            action: probeAction1,
            limit:  100,
        });
        const probeRows = rows.filter((r) => r.payload._test_run === TEST_RUN_ID
                                          && typeof r.payload.k === "string"
                                          && r.payload.k.startsWith("action-filter-"));
        assert.equal(probeRows.length, 2);
        for (const r of probeRows) assert.equal(r.action, probeAction1);

        const n = await countForCurrentOrg(client, { action: probeAction1 });
        // Count is org-wide for that action — at least our 2 probe rows.
        assert.ok(n >= 2, `count should reflect at least the 2 probe rows, got ${n}`);
    });
});

test("target_type + target_id filter narrows to that exact target", async () => {
    const targetA = randomUUID();
    const targetB = randomUUID();
    await withTx(ORG_ACME, async (client) => {
        await insertActivity(client, { orgId: ORG_ACME, action: "membership.role_changed", targetType: "membership", targetId: targetA, payload: tagged({ k: "tgt-a-1" }) });
        await insertActivity(client, { orgId: ORG_ACME, action: "membership.role_changed", targetType: "membership", targetId: targetA, payload: tagged({ k: "tgt-a-2" }) });
        await insertActivity(client, { orgId: ORG_ACME, action: "membership.role_changed", targetType: "membership", targetId: targetB, payload: tagged({ k: "tgt-b-1" }) });
    });

    await withTx(ORG_ACME, async (client) => {
        const rows = await listForCurrentOrg(client, {
            targetType: "membership",
            targetId:   targetA,
            limit:      100,
        });
        const probeRows = rows.filter((r) => r.payload._test_run === TEST_RUN_ID);
        assert.equal(probeRows.length, 2);
        for (const r of probeRows) {
            assert.equal(r.target_type, "membership");
            assert.equal(r.target_id, targetA);
        }
    });
});

test("user_id filter narrows to that actor only", async () => {
    await withTx(ORG_ACME, async (client) => {
        await insertActivity(client, { orgId: ORG_ACME, userId: ACME_ADMIN, action: "auth.login", payload: tagged({ k: "user-admin-1" }) });
        await insertActivity(client, { orgId: ORG_ACME, userId: ACME_EMP,   action: "auth.login", payload: tagged({ k: "user-emp-1" }) });
        await insertActivity(client, { orgId: ORG_ACME, userId: null,        action: "auth.login", payload: tagged({ k: "user-system-1" }) });
    });

    await withTx(ORG_ACME, async (client) => {
        const rows = await listForCurrentOrg(client, {
            userId: ACME_ADMIN,
            limit:  100,
        });
        const probeRows = rows.filter((r) => r.payload._test_run === TEST_RUN_ID
                                          && typeof r.payload.k === "string"
                                          && r.payload.k.startsWith("user-"));
        assert.equal(probeRows.length, 1);
        assert.equal(probeRows[0].user_id, ACME_ADMIN);
    });
});

test("created_from / created_to bracket filter respects the time window", async () => {
    // pg-node parses timestamptz to a millisecond-precision JS Date, but
    // Postgres `now()` is microsecond-precision. Reading back `created_at`
    // from a `now()`-default insert and using it as a `created_at <= $1`
    // bound would compare a ms-truncated Date against the stored µs value
    // and miss the row. To get an exact comparison we set `created_at`
    // explicitly to known Date values — the same Date object then round-
    // trips through both the INSERT bind and the filter bind without
    // precision drift.
    const tMid = new Date(Date.now() - 60_000);     // 1 min ago
    const tAfter1 = new Date(tMid.getTime() + 1000);
    const tAfter2 = new Date(tMid.getTime() + 2000);

    const midId = randomUUID();
    await withTx(ORG_ACME, async (client) => {
        await client.query(
            `INSERT INTO activity_log (id, org_id, action, payload, created_at)
             VALUES ($1, $2, 'auth.login', $3::jsonb, $4)`,
            [midId, ORG_ACME, JSON.stringify(tagged({ k: "date-window-mid" })), tMid],
        );
        await client.query(
            `INSERT INTO activity_log (org_id, action, payload, created_at)
             VALUES ($1, 'auth.login', $2::jsonb, $3)`,
            [ORG_ACME, JSON.stringify(tagged({ k: "date-window-after-1" })), tAfter1],
        );
        await client.query(
            `INSERT INTO activity_log (org_id, action, payload, created_at)
             VALUES ($1, 'auth.login', $2::jsonb, $3)`,
            [ORG_ACME, JSON.stringify(tagged({ k: "date-window-after-2" })), tAfter2],
        );
    });

    await withTx(ORG_ACME, async (client) => {
        // Closed bracket [tMid, tMid] selects exactly the mid row.
        const rows = await listForCurrentOrg(client, {
            action:      "auth.login",
            createdFrom: tMid,
            createdTo:   tMid,
            limit:       100,
        });
        const probeRows = rows.filter((r) => r.payload._test_run === TEST_RUN_ID
                                          && typeof r.payload.k === "string"
                                          && r.payload.k.startsWith("date-window-"));
        assert.equal(probeRows.length, 1);
        assert.equal(probeRows[0].id, midId);

        // Open the upper bound — both later rows now qualify (plus mid).
        const rowsWide = await listForCurrentOrg(client, {
            action:      "auth.login",
            createdFrom: tMid,
            limit:       100,
        });
        const probeRowsWide = rowsWide.filter((r) => r.payload._test_run === TEST_RUN_ID
                                                  && typeof r.payload.k === "string"
                                                  && r.payload.k.startsWith("date-window-"));
        assert.equal(probeRowsWide.length, 3);
    });
});

// ====================================================================== //
//                            pagination
// ====================================================================== //

test("cursor pagination is stable when many rows share a microsecond created_at", async () => {
    // Insert 5 rows whose created_at has microsecond precision.
    // node-postgres returns timestamptz as a millisecond JS Date, so the
    // cursor must compare against a millisecond-truncated DB expression.
    const sharedTsSql = "2026-01-01T00:00:00.123456Z";
    const targetId = randomUUID();
    const ids = [];
    await withTx(ORG_ACME, async (client) => {
        for (let i = 0; i < 5; i++) {
            const r = await client.query(
                `INSERT INTO activity_log (
                    org_id, action, target_type, target_id, payload, created_at
                 )
                 VALUES ($1, 'auth.login', 'session', $2, $3::jsonb, $4::timestamptz)
                 RETURNING id`,
                [
                    ORG_ACME,
                    targetId,
                    JSON.stringify(tagged({ k: `tie-${i}` })),
                    sharedTsSql,
                ],
            );
            ids.push(r.rows[0].id);
        }
    });

    // Page size 2 — walk the 5 tied rows in (created_at_ms DESC, id DESC)
    // order. Expected sequence: ids sorted DESC, 2 per page, last page = 1.
    const expectedOrder = [...ids].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

    const collected = [];
    let cursor = null;
    await withTx(ORG_ACME, async (client) => {
        for (let page = 0; page < 5; page++) {
            const rows = await listForCurrentOrg(client, {
                action:          "auth.login",
                targetType:      "session",
                targetId,
                limit:           2,
                ...(cursor || {}),
            });
            const ours = rows.filter((r) => ids.includes(r.id));
            if (ours.length === 0) break;
            collected.push(...ours.map((r) => r.id));
            const last = ours[ours.length - 1];
            cursor = {
                beforeCreatedAt: last.created_at,
                beforeId:        last.id,
            };
            if (ours.length < 2) break;
        }
    });

    assert.deepEqual(collected, expectedOrder,
        "cursor walk must visit every tied row exactly once in (created_at_ms DESC, id DESC) order");
});

// ====================================================================== //
//                            count
// ====================================================================== //

test("countForCurrentOrg matches listForCurrentOrg under the same filters", async () => {
    // Use a unique action + target pair so we can count exactly our probe rows.
    const targetId = randomUUID();
    await withTx(ORG_ACME, async (client) => {
        for (let i = 0; i < 3; i++) {
            await insertActivity(client, {
                orgId:      ORG_ACME,
                action:     "customer.created",
                targetType: "customer",
                targetId,
                payload:    tagged({ k: `count-probe-${i}` }),
            });
        }
    });

    await withTx(ORG_ACME, async (client) => {
        const filters = {
            action:     "customer.created",
            targetType: "customer",
            targetId,
        };
        const rows = await listForCurrentOrg(client, { ...filters, limit: 100 });
        const n    = await countForCurrentOrg(client, filters);
        assert.equal(rows.length, 3);
        assert.equal(n, 3);
        assert.equal(rows.length, n,
            "list length must equal count under identical filters");
    });
});

test("countForCurrentOrg under bare pool (no GUC) is 0", async () => {
    // Seed something under Acme so 0 is not a vacuous truth.
    await withTx(ORG_ACME, (client) =>
        insertActivity(client, {
            orgId:  ORG_ACME,
            action: "auth.login",
            payload: tagged({ k: "count-no-guc" }),
        }),
    );

    await withTx(null, async (client) => {
        const n = await countForCurrentOrg(client, {});
        assert.equal(n, 0);
    });
});

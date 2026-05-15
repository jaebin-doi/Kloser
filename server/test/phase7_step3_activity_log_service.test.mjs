/* Phase 7 Step 3 — activity_log service + sanitizer unit tests.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_3_PLAN.md §6 / §10.
 *
 * Covered scenarios (mirrors the implementer brief):
 *
 *   recordActivity
 *     - sanitizes and inserts a row visible in the same org context
 *     - sanitizer error throws before any SQL
 *     - DB error bubbles up so caller can rollback
 *     - participates in the caller's transaction rollback
 *     - RLS org isolation still enforced via the repository
 *
 *   sanitizer
 *     - rejects non-plain-object payload
 *     - forbidden top-level key (`token` / `secret` / `password` /
 *       `ciphertext` / `key` / `raw`) → throws
 *     - forbidden nested object key → throws
 *     - forbidden array-item key → throws
 *     - safe key `auth_token_id` allowed
 *     - long string truncated at PAYLOAD_STRING_MAX
 *     - undefined values removed (top-level and nested)
 *     - Date normalised to ISO string
 *     - rejects Buffer / function / symbol / bigint / NaN / Infinity
 *     - error message does not echo sensitive value
 *
 *   tryRecordActivity
 *     - returns true on success
 *     - returns false on sanitizer failure without throwing
 *     - returns false on DB failure (RLS) without poisoning outer tx
 *
 *   helpers
 *     - recordMfaEnabled / recordMfaDisabled / recordOrgMfaRequiredChanged
 *       / recordMembershipRoleChanged each produce the expected
 *       action / target / payload shape
 *
 * Fixture strategy:
 *   - Same TEST_RUN_ID-tagged payloads + after-hook DELETE pattern as
 *     phase7_step3_activity_log_repo.test.mjs.
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
    listForCurrentOrg,
} from "../src/repositories/activityLog.js";
import {
    ActivityPayloadSanitizeError,
    PAYLOAD_STRING_MAX,
    recordActivity,
    recordMembershipRoleChanged,
    recordMfaDisabled,
    recordMfaEnabled,
    recordOrgMfaRequiredChanged,
    sanitizeActivityPayload,
    tryRecordActivity,
} from "../src/services/activityLog.js";

const ORG_ACME = "11111111-1111-1111-1111-111111111111";
const ORG_BETA = "22222222-2222-2222-2222-222222222222";
const ACME_ADMIN = "aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa";
const ACME_EMP   = "aaaaaaaa-0002-0002-0002-aaaaaaaaaaaa";

const TEST_RUN_ID = `phase7-step3-svc-${randomUUID()}`;

let app;

before(async () => {
    app = Fastify({ logger: false });
    await app.register(dbPlugin);
});

after(async () => {
    for (const orgId of [ORG_ACME, ORG_BETA]) {
        try {
            await app.withOrgContext(orgId, async (client) => {
                await client.query(
                    `DELETE FROM activity_log
                       WHERE payload->>'_test_run' = $1`,
                    [TEST_RUN_ID],
                );
            });
        } catch (_) { /* best-effort */ }
    }
    await app.close();
});

// ---------------------------------------------------------------------- //
// helpers
// ---------------------------------------------------------------------- //

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

/** Same withTx but the outer fn ALWAYS rolls back. Lets us prove that
 *  recordActivity's INSERT is undone when the caller throws. */
async function withTxRollback(orgId, fn) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        if (orgId) {
            await client.query(
                "SELECT set_config('app.org_id', $1, true)",
                [orgId],
            );
        }
        try {
            return await fn(client);
        } finally {
            await client.query("ROLLBACK").catch(() => {});
        }
    } finally {
        client.release();
    }
}

function tagged(extra = {}) {
    return { ...extra, _test_run: TEST_RUN_ID };
}

// ====================================================================== //
//                     recordActivity — happy path + tx
// ====================================================================== //

test("recordActivity inserts a sanitized row visible in the same org context", async () => {
    const targetId = randomUUID();
    await withTx(ORG_ACME, (client) =>
        recordActivity(client, {
            orgId:       ORG_ACME,
            actorUserId: ACME_ADMIN,
            action:      "auth.login",
            targetType:  "session",
            targetId,
            payload: tagged({
                method: "password",
                attemptCount: 1,
                lastLogin: new Date("2026-05-15T01:23:45.000Z"),
                droppedUndef: undefined,
            }),
        }),
    );

    await withTx(ORG_ACME, async (client) => {
        const rows = await listForCurrentOrg(client, {
            action:     "auth.login",
            targetType: "session",
            targetId,
            limit:      10,
        });
        assert.equal(rows.length, 1);
        const r = rows[0];
        assert.equal(r.org_id, ORG_ACME);
        assert.equal(r.user_id, ACME_ADMIN);
        assert.equal(r.target_type, "session");
        assert.equal(r.target_id, targetId);
        assert.equal(r.payload.method, "password");
        assert.equal(r.payload.attemptCount, 1);
        // Date normalised to ISO string
        assert.equal(r.payload.lastLogin, "2026-05-15T01:23:45.000Z");
        // undefined dropped
        assert.ok(!("droppedUndef" in r.payload));
    });
});

test("recordActivity is rolled back when the caller's transaction throws", async () => {
    const targetId = randomUUID();
    let recordedId;

    await assert.rejects(
        () => withTx(ORG_ACME, async (client) => {
            await recordActivity(client, {
                orgId:       ORG_ACME,
                actorUserId: ACME_ADMIN,
                action:      "membership.role_changed",
                targetType:  "membership",
                targetId,
                payload:     tagged({ from_role: "employee", to_role: "manager" }),
            });
            // Grab the just-inserted id for the post-rollback check.
            const r = await client.query(
                `SELECT id FROM activity_log WHERE target_id = $1 AND payload->>'_test_run' = $2`,
                [targetId, TEST_RUN_ID],
            );
            recordedId = r.rows[0]?.id;
            assert.ok(recordedId, "row must be visible inside the tx before rollback");
            throw new Error("caller_intentional_rollback");
        }),
        /caller_intentional_rollback/,
    );

    // After rollback, the row must not be visible from any context.
    await withTx(ORG_ACME, async (client) => {
        const r = await client.query(
            `SELECT id FROM activity_log WHERE id = $1`,
            [recordedId],
        );
        assert.equal(r.rows.length, 0,
            "recordActivity must be undone by the caller's rollback");
    });
});

test("recordActivity respects RLS — orgId=Beta from Acme context is rejected", async () => {
    await assert.rejects(
        () => withTx(ORG_ACME, (client) =>
            recordActivity(client, {
                orgId:   ORG_BETA,
                action:  "auth.login",
                payload: tagged({ probe: "svc-rls" }),
            }),
        ),
        (err) => {
            const msg = String(err.message || err);
            return msg.includes("row-level security policy") || err.code === "42501";
        },
    );
});

// ====================================================================== //
//                     sanitizer — pure-function tests
// ====================================================================== //

test("sanitizer rejects non-plain-object payload (array)", () => {
    assert.throws(
        () => sanitizeActivityPayload([1, 2, 3]),
        (err) => err instanceof ActivityPayloadSanitizeError
              && err.code === "non_object_payload",
    );
});

test("sanitizer rejects non-plain-object payload (string)", () => {
    assert.throws(
        () => sanitizeActivityPayload("oops"),
        (err) => err instanceof ActivityPayloadSanitizeError
              && err.code === "non_object_payload",
    );
});

test("sanitizer treats null / undefined payload as {}", () => {
    assert.deepEqual(sanitizeActivityPayload(null), {});
    assert.deepEqual(sanitizeActivityPayload(undefined), {});
});

test("sanitizer rejects forbidden top-level keys (token / secret / password / ciphertext / key / raw)", () => {
    for (const key of ["token", "secret", "password", "ciphertext", "key", "raw"]) {
        assert.throws(
            () => sanitizeActivityPayload({ [key]: "anything" }),
            (err) => err instanceof ActivityPayloadSanitizeError
                  && err.code === "forbidden_key"
                  && err.path === `payload.${key}`,
            `${key} must be rejected`,
        );
    }
});

test("sanitizer rejects camelCase + snake_case forbidden composite keys", () => {
    // word-split matches whole words: `csrfToken` → ['csrf','token']
    assert.throws(() => sanitizeActivityPayload({ csrfToken: "x" }),
        (err) => err instanceof ActivityPayloadSanitizeError && err.code === "forbidden_key");
    assert.throws(() => sanitizeActivityPayload({ provider_api_key: "x" }),
        (err) => err instanceof ActivityPayloadSanitizeError && err.code === "forbidden_key");
    assert.throws(() => sanitizeActivityPayload({ mfa_secret_iv: "x" }),
        (err) => err instanceof ActivityPayloadSanitizeError && err.code === "forbidden_key");
    assert.throws(() => sanitizeActivityPayload({ rawValue: "x" }),
        (err) => err instanceof ActivityPayloadSanitizeError && err.code === "forbidden_key");
});

test("sanitizer rejects forbidden nested object key", () => {
    assert.throws(
        () => sanitizeActivityPayload({ data: { secret: "shh" } }),
        (err) => err instanceof ActivityPayloadSanitizeError
              && err.code === "forbidden_key"
              && err.path === "payload.data.secret",
    );
});

test("sanitizer rejects forbidden key inside array item", () => {
    assert.throws(
        () => sanitizeActivityPayload({
            items: [{ id: "ok" }, { password: "nope" }],
        }),
        (err) => err instanceof ActivityPayloadSanitizeError
              && err.code === "forbidden_key"
              && err.path === "payload.items[1].password",
    );
});

test("sanitizer allows the safe key auth_token_id (exact match)", () => {
    const out = sanitizeActivityPayload({ auth_token_id: "abc-123" });
    assert.deepEqual(out, { auth_token_id: "abc-123" });
});

test("sanitizer does NOT allow token_id even though token alone is forbidden — caller must use auth_token_id", () => {
    assert.throws(
        () => sanitizeActivityPayload({ token_id: "abc" }),
        (err) => err instanceof ActivityPayloadSanitizeError
              && err.code === "forbidden_key",
    );
});

test("sanitizer truncates long strings at PAYLOAD_STRING_MAX", () => {
    const huge = "a".repeat(PAYLOAD_STRING_MAX + 1000);
    const out = sanitizeActivityPayload({ note: huge });
    assert.equal(out.note.length, PAYLOAD_STRING_MAX);
    assert.equal(out.note, "a".repeat(PAYLOAD_STRING_MAX));
});

test("sanitizer drops undefined values at every depth", () => {
    const out = sanitizeActivityPayload({
        a: undefined,
        b: 1,
        c: { d: undefined, e: 2 },
        f: [1, undefined, 3],
    });
    assert.deepEqual(out, { b: 1, c: { e: 2 }, f: [1, 3] });
});

test("sanitizer normalises Date to ISO string at any depth", () => {
    const d = new Date("2026-05-15T01:23:45.000Z");
    const out = sanitizeActivityPayload({
        when: d,
        meta: { last: d },
        log: [{ at: d }],
    });
    assert.equal(out.when, "2026-05-15T01:23:45.000Z");
    assert.equal(out.meta.last, "2026-05-15T01:23:45.000Z");
    assert.equal(out.log[0].at, "2026-05-15T01:23:45.000Z");
});

test("sanitizer rejects Buffer / function / symbol / bigint / NaN / Infinity", () => {
    const cases = [
        { label: "Buffer",   payload: { v: Buffer.from("x") } },
        { label: "function", payload: { v: () => 1 } },
        { label: "symbol",   payload: { v: Symbol("x") } },
        { label: "bigint",   payload: { v: 1n } },
        { label: "NaN",      payload: { v: Number.NaN } },
        { label: "Infinity", payload: { v: Number.POSITIVE_INFINITY } },
    ];
    for (const c of cases) {
        assert.throws(
            () => sanitizeActivityPayload(c.payload),
            (err) => err instanceof ActivityPayloadSanitizeError,
            `${c.label} must be rejected`,
        );
    }
});

test("sanitizer error messages do not echo the sensitive value", () => {
    const sensitive = "this-is-a-super-secret-do-not-leak";
    try {
        sanitizeActivityPayload({ secret: sensitive });
        assert.fail("sanitizer should have thrown");
    } catch (err) {
        assert.ok(err instanceof ActivityPayloadSanitizeError);
        assert.ok(!String(err.message).includes(sensitive),
            "error message must not contain the sensitive value");
    }

    const sensitiveNested = "another-leaky-secret-payload-fragment";
    try {
        sanitizeActivityPayload({ data: { items: [{ password: sensitiveNested }] } });
        assert.fail("sanitizer should have thrown");
    } catch (err) {
        assert.ok(!String(err.message).includes(sensitiveNested),
            "nested-path error must not echo the sensitive value");
    }
});

// ====================================================================== //
//                     tryRecordActivity
// ====================================================================== //

test("tryRecordActivity returns true on success and writes the row", async () => {
    const targetId = randomUUID();
    let result;
    await withTx(ORG_ACME, async (client) => {
        result = await tryRecordActivity(client, {
            orgId:       ORG_ACME,
            actorUserId: ACME_ADMIN,
            action:      "report.team_viewed",
            targetType:  "report",
            targetId,
            payload:     tagged({ probe: "try-success" }),
        });
    });
    assert.equal(result, true);

    await withTx(ORG_ACME, async (client) => {
        const rows = await listForCurrentOrg(client, {
            action:     "report.team_viewed",
            targetType: "report",
            targetId,
            limit:      10,
        });
        assert.equal(rows.length, 1);
    });
});

test("tryRecordActivity returns false on sanitizer failure without throwing", async () => {
    let result;
    await withTx(ORG_ACME, async (client) => {
        result = await tryRecordActivity(client, {
            orgId:       ORG_ACME,
            actorUserId: ACME_ADMIN,
            action:      "report.team_viewed",
            // forbidden top-level key — sanitizer rejects before any SQL.
            payload:     tagged({ token: "leaky" }),
        });
    });
    assert.equal(result, false);
});

test("tryRecordActivity returns false on DB failure without poisoning the outer transaction", async () => {
    // Force a DB-level failure by passing orgId=Beta from inside Acme
    // context — RLS WITH CHECK rejects.
    const sentinel = randomUUID();
    let tryResult;
    await withTx(ORG_ACME, async (client) => {
        tryResult = await tryRecordActivity(client, {
            orgId:       ORG_BETA,  // wrong org → RLS rejects
            actorUserId: ACME_ADMIN,
            action:      "report.team_viewed",
            payload:     tagged({ probe: "try-rls-fail" }),
        });
        assert.equal(tryResult, false);

        // The outer tx must still be alive — record a successful sentinel
        // row to prove the savepoint isolated the failure.
        await recordActivity(client, {
            orgId:       ORG_ACME,
            actorUserId: ACME_ADMIN,
            action:      "auth.login",
            payload:     tagged({ sentinel }),
        });
    });

    // Sentinel row committed → outer tx was not poisoned.
    await withTx(ORG_ACME, async (client) => {
        const r = await client.query(
            `SELECT count(*)::int AS n FROM activity_log
              WHERE payload->>'sentinel' = $1`,
            [sentinel],
        );
        assert.equal(r.rows[0].n, 1,
            "sentinel row must have committed despite earlier tryRecordActivity failure");
    });
});

// ====================================================================== //
//                     helpers — shape assertions
// ====================================================================== //

test("recordMfaEnabled writes action=mfa.enabled with method in payload", async () => {
    const targetUserId = randomUUID();
    await withTx(ORG_ACME, (client) =>
        recordMfaEnabled(client, {
            orgId:        ORG_ACME,
            actorUserId:  ACME_ADMIN,
            targetUserId,
            method:       "totp",
        }),
    );

    await withTx(ORG_ACME, async (client) => {
        // We need TEST_RUN_ID tagging so cleanup works — directly query
        // the just-inserted row by target.
        const r = await client.query(
            `SELECT * FROM activity_log
              WHERE action = 'mfa.enabled' AND target_id = $1`,
            [targetUserId],
        );
        assert.equal(r.rows.length, 1);
        const row = r.rows[0];
        assert.equal(row.action, "mfa.enabled");
        assert.equal(row.target_type, "user");
        assert.equal(row.target_id, targetUserId);
        assert.equal(row.user_id, ACME_ADMIN);
        assert.equal(row.payload.method, "totp");
        // Tag it for cleanup since the helper takes no payload.
        await client.query(
            `UPDATE activity_log
                SET payload = payload || jsonb_build_object('_test_run', $2::text)
              WHERE id = $1`,
            [row.id, TEST_RUN_ID],
        );
    });
});

test("recordMfaDisabled writes action=mfa.disabled with method in payload", async () => {
    const targetUserId = randomUUID();
    await withTx(ORG_ACME, (client) =>
        recordMfaDisabled(client, {
            orgId:        ORG_ACME,
            actorUserId:  ACME_ADMIN,
            targetUserId,
            method:       "totp",
        }),
    );

    await withTx(ORG_ACME, async (client) => {
        const r = await client.query(
            `SELECT * FROM activity_log
              WHERE action = 'mfa.disabled' AND target_id = $1`,
            [targetUserId],
        );
        assert.equal(r.rows.length, 1);
        const row = r.rows[0];
        assert.equal(row.target_type, "user");
        assert.equal(row.payload.method, "totp");
        await client.query(
            `UPDATE activity_log
                SET payload = payload || jsonb_build_object('_test_run', $2::text)
              WHERE id = $1`,
            [row.id, TEST_RUN_ID],
        );
    });
});

test("recordOrgMfaRequiredChanged picks enabled vs disabled action and stamps count", async () => {
    await withTx(ORG_ACME, async (client) => {
        await recordOrgMfaRequiredChanged(client, {
            orgId:                  ORG_ACME,
            actorUserId:            ACME_ADMIN,
            required:               true,
            membersWithoutMfaCount: 3,
        });
        await recordOrgMfaRequiredChanged(client, {
            orgId:                  ORG_ACME,
            actorUserId:            ACME_ADMIN,
            required:               false,
        });
    });

    await withTx(ORG_ACME, async (client) => {
        const enabled = await client.query(
            `SELECT * FROM activity_log
              WHERE action = 'organization.mfa_required_enabled'
                AND target_id = $1
              ORDER BY created_at DESC LIMIT 1`,
            [ORG_ACME],
        );
        assert.equal(enabled.rows.length, 1);
        assert.equal(enabled.rows[0].target_type, "organization");
        assert.equal(enabled.rows[0].user_id, ACME_ADMIN);
        assert.equal(enabled.rows[0].payload.members_without_mfa_count, 3);

        const disabled = await client.query(
            `SELECT * FROM activity_log
              WHERE action = 'organization.mfa_required_disabled'
                AND target_id = $1
              ORDER BY created_at DESC LIMIT 1`,
            [ORG_ACME],
        );
        assert.equal(disabled.rows.length, 1);
        assert.equal(disabled.rows[0].target_type, "organization");
        // Count not provided → key absent (sanitizer did not synthesize null)
        assert.ok(!("members_without_mfa_count" in disabled.rows[0].payload));

        // Cleanup-tag both rows.
        for (const row of [enabled.rows[0], disabled.rows[0]]) {
            await client.query(
                `UPDATE activity_log
                    SET payload = payload || jsonb_build_object('_test_run', $2::text)
                  WHERE id = $1`,
                [row.id, TEST_RUN_ID],
            );
        }
    });
});

test("recordMembershipRoleChanged writes from_role / to_role in payload", async () => {
    const membershipId = randomUUID();
    await withTx(ORG_ACME, (client) =>
        recordMembershipRoleChanged(client, {
            orgId:        ORG_ACME,
            actorUserId:  ACME_ADMIN,
            membershipId,
            fromRole:     "employee",
            toRole:       "manager",
        }),
    );

    await withTx(ORG_ACME, async (client) => {
        const r = await client.query(
            `SELECT * FROM activity_log
              WHERE action = 'membership.role_changed'
                AND target_id = $1`,
            [membershipId],
        );
        assert.equal(r.rows.length, 1);
        const row = r.rows[0];
        assert.equal(row.target_type, "membership");
        assert.equal(row.user_id, ACME_ADMIN);
        assert.equal(row.payload.from_role, "employee");
        assert.equal(row.payload.to_role, "manager");
        await client.query(
            `UPDATE activity_log
                SET payload = payload || jsonb_build_object('_test_run', $2::text)
              WHERE id = $1`,
            [row.id, TEST_RUN_ID],
        );
    });
});

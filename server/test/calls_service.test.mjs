/* Phase 4 Step 2 — service tests for calls.endCall and friends.
 *
 * Step 2 plan §5.2 contracts:
 *   - endCall sets status=ended, ended_at, duration_seconds in one go
 *   - customer_id present → customers.last_contacted_at advances
 *   - older endedAt (or NULL last_contacted_at) → monotonic, never goes
 *     backwards
 *   - customer_id NULL → customer is not touched
 *   - cross-org call id → null
 *   - rollback: an in-transaction throw after calls.endByIdInCurrentOrg
 *     leaves the call un-ended (proves the withOrgContext wrapper used
 *     by endCall really is atomic; an explicit endCall throw-point is
 *     not exposed by the service surface)
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import dbPlugin from "../src/plugins/db.js";
import * as calls from "../src/repositories/calls.js";
import * as callsService from "../src/services/calls.js";

const ORG_ACME = "11111111-1111-1111-1111-111111111111";
const ORG_BETA = "22222222-2222-2222-2222-222222222222";

const CUSTOMER_ACME_KIM = "eeeeeeee-1111-0001-0001-eeeeeeeeeeee";

let app;

before(async () => {
    app = Fastify({ logger: false });
    await app.register(dbPlugin);
});

after(async () => {
    await app.close();
});

async function hardDeleteCall(orgId, id) {
    await app.withOrgContext(orgId, async (client) => {
        await client.query("DELETE FROM calls WHERE id = $1", [id]);
    });
}

async function readCustomerLastContact(orgId, customerId) {
    return app.withOrgContext(orgId, async (client) => {
        const r = await client.query(
            `SELECT last_contacted_at FROM customers WHERE id = $1`,
            [customerId],
        );
        return r.rows[0]?.last_contacted_at ?? null;
    });
}

async function setCustomerLastContact(orgId, customerId, value) {
    await app.withOrgContext(orgId, async (client) => {
        await client.query(
            `UPDATE customers SET last_contacted_at = $1 WHERE id = $2`,
            [value, customerId],
        );
    });
}

// ---------- 1. endCall: status / ended_at / duration_seconds ---------- //

test("endCall sets status=ended, ended_at, duration_seconds", async () => {
    // Stamp started_at 60s into the past so duration_seconds is observable.
    const startedAt = new Date(Date.now() - 60_000);
    const created = await app.withOrgContext(ORG_ACME, async (client) => {
        const r = await client.query(
            `INSERT INTO calls (org_id, customer_id, direction, status, started_at)
             VALUES ($1, $2, 'inbound', 'in_progress', $3)
             RETURNING id`,
            [ORG_ACME, CUSTOMER_ACME_KIM, startedAt],
        );
        return r.rows[0];
    });

    try {
        const endedAt = new Date();
        const ended = await callsService.endCall(app, ORG_ACME, created.id, {
            endedAt,
        });
        assert.ok(ended);
        assert.equal(ended.status, "ended");
        assert.ok(ended.ended_at instanceof Date);
        assert.equal(ended.ended_at.getTime(), endedAt.getTime());
        assert.ok(
            ended.duration_seconds !== null && ended.duration_seconds >= 55,
            `expected duration_seconds >= 55, got ${ended.duration_seconds}`,
        );
    } finally {
        await hardDeleteCall(ORG_ACME, created.id);
    }
});

// ---------- 2. endCall: customer.last_contacted_at advances ---------- //

test("endCall advances customers.last_contacted_at for the linked customer", async () => {
    const originalContact = await readCustomerLastContact(
        ORG_ACME,
        CUSTOMER_ACME_KIM,
    );

    try {
        const created = await app.withOrgContext(ORG_ACME, (client) =>
            calls.insertInCurrentOrg(client, ORG_ACME, {
                customer_id: CUSTOMER_ACME_KIM,
                direction: "inbound",
            }),
        );
        try {
            // Force the customer's last_contacted_at well into the past so
            // we can observe a clean advance regardless of seed timing.
            await setCustomerLastContact(
                ORG_ACME,
                CUSTOMER_ACME_KIM,
                new Date("2020-01-01T00:00:00Z"),
            );

            const endedAt = new Date();
            await callsService.endCall(app, ORG_ACME, created.id, { endedAt });

            const newContact = await readCustomerLastContact(
                ORG_ACME,
                CUSTOMER_ACME_KIM,
            );
            assert.ok(newContact instanceof Date);
            assert.equal(newContact.getTime(), endedAt.getTime());
        } finally {
            await hardDeleteCall(ORG_ACME, created.id);
        }
    } finally {
        // Always restore the seed timestamp so subsequent tests / other
        // suites see the seed-defined value, not whatever we wrote.
        await setCustomerLastContact(
            ORG_ACME,
            CUSTOMER_ACME_KIM,
            originalContact,
        );
    }
});

// ---------- 3. endCall: last_contacted_at is monotonic (never moves back) ---------- //

test("endCall keeps customers.last_contacted_at monotonic with older endedAt", async () => {
    const originalContact = await readCustomerLastContact(
        ORG_ACME,
        CUSTOMER_ACME_KIM,
    );

    try {
        // Stamp the customer at a recent fixed point so we can ask for an
        // older endedAt and observe the GREATEST behavior.
        const recent = new Date("2030-01-01T00:00:00Z");
        await setCustomerLastContact(ORG_ACME, CUSTOMER_ACME_KIM, recent);

        const created = await app.withOrgContext(ORG_ACME, (client) =>
            calls.insertInCurrentOrg(client, ORG_ACME, {
                customer_id: CUSTOMER_ACME_KIM,
                direction: "inbound",
            }),
        );
        try {
            const olderEndedAt = new Date("2025-06-01T00:00:00Z");
            const ended = await callsService.endCall(
                app,
                ORG_ACME,
                created.id,
                { endedAt: olderEndedAt },
            );
            assert.ok(ended);

            const after = await readCustomerLastContact(
                ORG_ACME,
                CUSTOMER_ACME_KIM,
            );
            // GREATEST(recent, older) === recent → timestamp must not regress.
            assert.equal(after.getTime(), recent.getTime());
        } finally {
            await hardDeleteCall(ORG_ACME, created.id);
        }
    } finally {
        await setCustomerLastContact(
            ORG_ACME,
            CUSTOMER_ACME_KIM,
            originalContact,
        );
    }
});

// ---------- 4. endCall: customer_id NULL skips customer update ---------- //

test("endCall with customer_id NULL leaves customers untouched", async () => {
    // We pick CUSTOMER_ACME_KIM only to assert "untouched". The call we
    // create has customer_id NULL, so the customer should not move.
    const originalContact = await readCustomerLastContact(
        ORG_ACME,
        CUSTOMER_ACME_KIM,
    );

    const created = await app.withOrgContext(ORG_ACME, (client) =>
        calls.insertInCurrentOrg(client, ORG_ACME, {
            customer_id: null,
            direction: "inbound",
        }),
    );
    try {
        await callsService.endCall(app, ORG_ACME, created.id, {
            endedAt: new Date(),
        });

        const after = await readCustomerLastContact(
            ORG_ACME,
            CUSTOMER_ACME_KIM,
        );
        const originalTime =
            originalContact instanceof Date ? originalContact.getTime() : null;
        const afterTime = after instanceof Date ? after.getTime() : null;
        assert.equal(afterTime, originalTime);
    } finally {
        await hardDeleteCall(ORG_ACME, created.id);
    }
});

// ---------- 5. endCall: cross-org id → null ---------- //

test("endCall against a cross-org call returns null and does not end it", async () => {
    const acmeCall = await app.withOrgContext(ORG_ACME, (client) =>
        calls.insertInCurrentOrg(client, ORG_ACME, { direction: "inbound" }),
    );
    try {
        const result = await callsService.endCall(
            app,
            ORG_BETA,
            acmeCall.id,
            { endedAt: new Date() },
        );
        assert.equal(result, null);

        // Confirm Acme call is still in_progress.
        const stillThere = await callsService.getCallById(
            app,
            ORG_ACME,
            acmeCall.id,
        );
        assert.ok(stillThere);
        assert.equal(stillThere.status, "in_progress");
        assert.equal(stillThere.ended_at, null);
    } finally {
        await hardDeleteCall(ORG_ACME, acmeCall.id);
    }
});

// ---------- 6. Transaction atomicity: throw inside withOrgContext rolls back the call update ---------- //
//
// service.endCall has no test-only throw point — it wraps everything in
// app.withOrgContext, which is the same primitive every other service
// uses. So we prove the wrap by reproducing endCall's two-step shape
// inline and forcing the second step to throw. If withOrgContext truly
// commits all-or-nothing, the call must still be in_progress afterwards.

test("withOrgContext rollback: throw after endByIdInCurrentOrg leaves call unmodified", async () => {
    const created = await app.withOrgContext(ORG_ACME, (client) =>
        calls.insertInCurrentOrg(client, ORG_ACME, { direction: "inbound" }),
    );
    try {
        await assert.rejects(
            app.withOrgContext(ORG_ACME, async (client) => {
                const ended = await calls.endByIdInCurrentOrg(
                    client,
                    created.id,
                    new Date(),
                    "ended",
                );
                assert.ok(ended); // update went through inside this txn
                throw new Error("simulated post-update failure");
            }),
            (err) => err instanceof Error && err.message.includes("simulated"),
        );

        // After the throw + rollback, the call must still be in_progress.
        const stillThere = await callsService.getCallById(
            app,
            ORG_ACME,
            created.id,
        );
        assert.ok(stillThere);
        assert.equal(
            stillThere.status,
            "in_progress",
            "rollback failed: status leaked across aborted transaction",
        );
        assert.equal(stillThere.ended_at, null);
        assert.equal(stillThere.duration_seconds, null);
    } finally {
        await hardDeleteCall(ORG_ACME, created.id);
    }
});

// ---------- 7. createCall / listCalls / getCallById quick happy path ---------- //

test("createCall + listCalls + getCallById round-trip", async () => {
    const created = await callsService.createCall(app, ORG_ACME, {
        direction: "outbound",
        title: "phase4-svc-test/roundtrip",
    });
    try {
        assert.equal(created.org_id, ORG_ACME);

        const list = await callsService.listCalls(app, ORG_ACME, {
            limit: 100,
            offset: 0,
        });
        assert.ok(list.items.find((c) => c.id === created.id));
        assert.ok(list.total >= 1);

        const byId = await callsService.getCallById(app, ORG_ACME, created.id);
        assert.ok(byId);
        assert.equal(byId.id, created.id);
    } finally {
        await hardDeleteCall(ORG_ACME, created.id);
    }
});

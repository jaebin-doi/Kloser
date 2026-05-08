/* RLS isolation + repository smokes — Phase 1 Step 2 §9.
 *
 * Lives under server/test/ so node_modules resolution finds fastify, pg,
 * dotenv, etc. directly.
 *
 * Connects to the same dev database as Step 1 seed (org acme + beta,
 * 2 memberships per org). Uses the runtime `app` role via DATABASE_URL,
 * which is the only configuration where these tests are meaningful —
 * the admin role would BYPASSRLS and report false-positives.
 *
 * Run:
 *   cd server && npx tsx --test test/rls_isolation.test.mjs
 *
 * Pre-req: ops/docker-compose.yml is up, migrate + seed have run, the
 * `app` role exists (ops/postgres/init/01_app_role.sql applied).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import dbPlugin from "../src/plugins/db.js";
import * as memberships from "../src/repositories/memberships.js";
import * as organizations from "../src/repositories/organizations.js";
import * as users from "../src/repositories/users.js";

const ORG_ACME   = "11111111-1111-1111-1111-111111111111";
const ORG_BETA = "22222222-2222-2222-2222-222222222222";

let app;

before(async () => {
    app = Fastify({ logger: false });
    await app.register(dbPlugin);
});

after(async () => {
    await app.close();
});

test("default-deny: no GUC → memberships query returns 0 rows", async () => {
    // Bare pool query (no withOrgContext, no GUC). app role + RLS forced
    // means the policy `org_id = current_app_org_id()` evaluates to
    // `org_id = NULL`, which never matches → 0 rows.
    const r = await app.pg.query("SELECT count(*)::int AS n FROM memberships");
    assert.equal(r.rows[0].n, 0);
});

test("scoped to ORG_ACME → memberships.listForCurrentOrg returns 2 rows, all org_id=acme", async () => {
    const rows = await app.withOrgContext(ORG_ACME, (client) =>
        memberships.listForCurrentOrg(client),
    );
    assert.equal(rows.length, 2);
    for (const m of rows) {
        assert.equal(m.org_id, ORG_ACME);
    }
});

test("scoped to ORG_BETA → memberships.listForCurrentOrg returns 2 rows, all org_id=beta", async () => {
    const rows = await app.withOrgContext(ORG_BETA, (client) =>
        memberships.listForCurrentOrg(client),
    );
    assert.equal(rows.length, 2);
    for (const m of rows) {
        assert.equal(m.org_id, ORG_BETA);
    }
});

test("WITH CHECK violation: insert membership with mismatched org_id throws", async () => {
    // Inside ACME context, try to insert a membership pointing at BETA.
    // The policy WITH CHECK clause must reject this with row-level
    // security violation (Postgres SQLSTATE 42501).
    await assert.rejects(
        app.withOrgContext(ORG_ACME, async (client) => {
            await client.query(
                `INSERT INTO memberships (org_id, user_id, role)
                 VALUES ($1, gen_random_uuid(), 'employee')`,
                [ORG_BETA],
            );
        }),
        (err) => {
            // pg surfaces the error.code from Postgres. "row violates
            // row-level security policy" → 42501.
            assert.equal(err.code, "42501", `expected 42501, got ${err.code}`);
            return true;
        },
    );
});

test("organizations.getCurrentOrg returns the active org and only that one", async () => {
    const acme = await app.withOrgContext(ORG_ACME, (client) =>
        organizations.getCurrentOrg(client),
    );
    assert.ok(acme, "expected an org row");
    assert.equal(acme.id, ORG_ACME);

    const beta = await app.withOrgContext(ORG_BETA, (client) =>
        organizations.getCurrentOrg(client),
    );
    assert.ok(beta, "expected an org row");
    assert.equal(beta.id, ORG_BETA);
});

test("users.listForCurrentOrg only returns users joined via memberships in current org", async () => {
    const acmeUsers = await app.withOrgContext(ORG_ACME, (client) =>
        users.listForCurrentOrg(client),
    );
    assert.equal(acmeUsers.length, 2);
    const acmeEmails = acmeUsers.map((u) => u.email).sort();
    assert.deepEqual(acmeEmails, ["admin@acme.test", "emp@acme.test"]);

    const betaUsers = await app.withOrgContext(ORG_BETA, (client) =>
        users.listForCurrentOrg(client),
    );
    assert.equal(betaUsers.length, 2);
    const betaEmails = betaUsers.map((u) => u.email).sort();
    assert.deepEqual(betaEmails, ["admin@beta.test", "emp@beta.test"]);
});

test("users.getByIdInCurrentOrg returns the user when membership matches, null otherwise", async () => {
    // Pick acme's admin user id from inside the acme context.
    const acmeAdmin = await app.withOrgContext(ORG_ACME, async (client) => {
        const list = await users.listForCurrentOrg(client);
        return list.find((u) => u.email === "admin@acme.test");
    });
    assert.ok(acmeAdmin, "seed missing admin@acme.test");

    // Same user is visible inside acme context.
    const visible = await app.withOrgContext(ORG_ACME, (client) =>
        users.getByIdInCurrentOrg(client, acmeAdmin.id),
    );
    assert.ok(visible);
    assert.equal(visible.id, acmeAdmin.id);

    // Same user id is NOT visible inside beta context (different org).
    const hidden = await app.withOrgContext(ORG_BETA, (client) =>
        users.getByIdInCurrentOrg(client, acmeAdmin.id),
    );
    assert.equal(hidden, null, "acme admin should be invisible to beta");
});

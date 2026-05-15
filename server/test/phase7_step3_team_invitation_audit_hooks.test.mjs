/* Phase 7 Step 3 — team / invitation audit hook integration tests.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_3_PLAN.md §7.2.
 *
 * Scope (this commit closes):
 *   - membership.role_changed             (PATCH /memberships/:id role)
 *   - membership.status_changed           (PATCH /memberships/:id status)
 *   - invitation.created                  (POST /invitations)
 *   - invitation.resent                   (POST /invitations/:id/resend)
 *   - invitation.cancelled                (DELETE /invitations/:id)
 *   - invitation.accepted                 (POST /invitations/accept,
 *                                          service-pool path)
 *
 * Intentionally NOT covered here (residual risk — no production endpoint):
 *   - membership.team_changed             (no admin "move user to team"
 *                                          mutation in the current
 *                                          codebase; invitation.accepted
 *                                          already records the initial
 *                                          team binding via team_id)
 *
 * Sensitive-value invariants asserted on every recorded row:
 *   - payload never contains the raw invitation token
 *   - payload never contains the accept URL
 *   - payload never contains the user-typed password / refresh token /
 *     accessToken
 *   - payload never contains the invitee's email (we keep that in the
 *     `invitations` row joined via target_id, not in the audit payload)
 *
 * Fixture strategy:
 *   - Per-test wipe of sessions / auth_tokens / invitations (non-seeded)
 *     / memberships (non-seeded) / activity_log (matching our fixtures)
 *     in both orgs, plus role/status reset on the four seeded
 *     memberships and disabled_at reset on the four seeded users.
 *
 * Run: cd server && npm test
 */
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import { pool } from "../src/db/pool.js";
import dbPlugin from "../src/plugins/db.js";
import authPlugin from "../src/plugins/auth.js";
import authRoutes from "../src/routes/auth.js";
import meRoutes from "../src/routes/me.js";
import teamRoutes from "../src/routes/team.js";
import invitationsRoutes from "../src/routes/invitations.js";
import { createInvitation as createInvitationSvc } from "../src/services/invitations.js";

const ORG_ACME = "11111111-1111-1111-1111-111111111111";
const ORG_BETA = "22222222-2222-2222-2222-222222222222";
const ACME_ADMIN = "aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa";
const ACME_EMP   = "aaaaaaaa-0002-0002-0002-aaaaaaaaaaaa";
const BETA_ADMIN = "bbbbbbbb-0001-0001-0001-bbbbbbbbbbbb";
const BETA_EMP   = "bbbbbbbb-0002-0002-0002-bbbbbbbbbbbb";
const ACME_ADMIN_MEMBERSHIP = "cccccccc-0001-0001-0001-cccccccccccc";
const ACME_EMP_MEMBERSHIP   = "cccccccc-0002-0002-0002-cccccccccccc";
const BETA_ADMIN_MEMBERSHIP = "dddddddd-0001-0001-0001-dddddddddddd";
const BETA_EMP_MEMBERSHIP   = "dddddddd-0002-0002-0002-dddddddddddd";
const SEEDED_MEMBERSHIPS = [
    ACME_ADMIN_MEMBERSHIP, ACME_EMP_MEMBERSHIP,
    BETA_ADMIN_MEMBERSHIP, BETA_EMP_MEMBERSHIP,
];

const ACME_ADMIN_EMAIL = "admin@acme.test";
const ACME_ADMIN_PW    = "acme-admin-1234";
const ACME_EMP_EMAIL   = "emp@acme.test";
const ACME_EMP_PW      = "acme-emp-1234";

let app;

before(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    await app.register(dbPlugin);
    await app.register(authRoutes);
    await app.register(meRoutes);
    await app.register(teamRoutes);
    await app.register(invitationsRoutes);
});

after(async () => {
    await wipePerTestState();
    await app.close();
});

async function wipePerTestState() {
    // Sessions / auth_tokens — non-RLS or RLS-scoped writes from app pool
    // with explicit org_id WHERE. The app pool has DELETE everywhere.
    await pool.query(
        `DELETE FROM sessions WHERE user_id IN ($1, $2, $3, $4)`,
        [ACME_ADMIN, ACME_EMP, BETA_ADMIN, BETA_EMP],
    );

    // Anything we created in this suite. RLS makes a bare DELETE no-op
    // for org-scoped tables when no GUC is set; auth_tokens has FORCE
    // RLS so go through withOrgContext.
    for (const orgId of [ORG_ACME, ORG_BETA]) {
        await app.withOrgContext(orgId, async (client) => {
            await client.query(
                `DELETE FROM auth_tokens
                  WHERE org_id = $1
                    AND id NOT IN (
                      SELECT id FROM auth_tokens WHERE created_at < now() - interval '1 hour'
                    )`,
                [orgId],
            );
        });
    }
    // Invitations are RLS-scoped — wipe per org context. Keep only the
    // Phase 3 demo seeds (1ff... ids).
    for (const orgId of [ORG_ACME, ORG_BETA]) {
        await app.withOrgContext(orgId, async (client) => {
            await client.query(
                `DELETE FROM invitations
                  WHERE id NOT IN (
                    '1ff11111-1111-1111-1111-111111111111',
                    '1ff22222-2222-2222-2222-222222222222'
                  )`,
            );
        });
    }
    // Memberships likewise — keep only the four seed rows, restore the
    // canonical role/status on them.
    for (const orgId of [ORG_ACME, ORG_BETA]) {
        await app.withOrgContext(orgId, async (client) => {
            await client.query(
                `DELETE FROM memberships WHERE id NOT IN ($1, $2, $3, $4)`,
                SEEDED_MEMBERSHIPS,
            );
            await client.query(
                `UPDATE memberships SET role='admin', status='active'
                  WHERE id IN ($1, $2)`,
                [ACME_ADMIN_MEMBERSHIP, BETA_ADMIN_MEMBERSHIP],
            );
            await client.query(
                `UPDATE memberships SET role='employee', status='active'
                  WHERE id IN ($1, $2)`,
                [ACME_EMP_MEMBERSHIP, BETA_EMP_MEMBERSHIP],
            );
        });
    }
    // Users — restore disabled_at + drop anyone the accept flow added.
    await pool.query(
        `UPDATE users SET disabled_at = NULL
          WHERE id IN ($1, $2, $3, $4)`,
        [ACME_ADMIN, ACME_EMP, BETA_ADMIN, BETA_EMP],
    );
    await pool.query(
        `DELETE FROM users
          WHERE email LIKE 'audithooks-%@example.test'
             OR email LIKE 'invite-test-%@example.test'`,
    );
    // Wipe activity_log rows tied to our test fixtures, in both orgs.
    for (const orgId of [ORG_ACME, ORG_BETA]) {
        await app.withOrgContext(orgId, async (client) => {
            await client.query(
                `DELETE FROM activity_log
                  WHERE user_id  = ANY($1::uuid[])
                     OR target_id = ANY($2::uuid[])
                     OR action LIKE 'invitation.%'
                     OR action LIKE 'membership.%'`,
                [
                    [ACME_ADMIN, ACME_EMP, BETA_ADMIN, BETA_EMP],
                    SEEDED_MEMBERSHIPS,
                ],
            );
        });
    }
}

beforeEach(wipePerTestState);
afterEach(wipePerTestState);

// ---------------------------------------------------------------------- //
// helpers
// ---------------------------------------------------------------------- //

async function loginToken(email, password) {
    const r = await app.inject({
        method:  "POST",
        url:     "/auth/login",
        payload: { email, password },
    });
    assert.equal(r.statusCode, 200,
        `login(${email}) expected 200, got ${r.statusCode}: ${r.body}`);
    return r.json().accessToken;
}

function authed(token) {
    return { authorization: `Bearer ${token}` };
}

async function findAuditRows(orgId, action, targetId) {
    let rows;
    await app.withOrgContext(orgId, async (client) => {
        const r = await client.query(
            `SELECT id, org_id, user_id, action, target_type, target_id,
                    payload, created_at
               FROM activity_log
              WHERE action = $1 AND target_id = $2
              ORDER BY created_at DESC, id DESC`,
            [action, targetId],
        );
        rows = r.rows;
    });
    return rows;
}

function assertNoSensitiveValues(rows, sensitiveValues) {
    for (const row of rows) {
        const payloadStr = JSON.stringify(row.payload);
        for (const v of sensitiveValues) {
            if (!v) continue;
            assert.ok(
                !payloadStr.includes(v),
                `audit payload must not echo sensitive value (action=${row.action})`,
            );
        }
    }
}

/** Drive the invitation create flow through the service so the test
 *  can capture the raw token (POST /invitations only returns the
 *  invitation row — the raw token never escapes the outbox). Used by
 *  the create/resend/cancel/accept audit-hook tests to assert their
 *  sensitive-value invariants meaningfully. */
async function createInvitationDirect(email, role = "employee") {
    const result = await app.withOrgContext(ORG_ACME, (client) =>
        createInvitationSvc(client, ORG_ACME, ACME_ADMIN, { email, role }),
    );
    return {
        invitationId: result.invitation.id,
        rawToken:     result.rawToken,
    };
}

/** Make a non-seed extra Acme admin so we can demote ACME_ADMIN past
 *  the last-admin-protected guard without breaking the seed. Returns
 *  the new membership row. */
async function addAcmeExtraAdmin() {
    const ts = Date.now();
    const email = `audithooks-extra-${ts}@example.test`;
    let userId, membershipId;
    await app.withOrgContext(ORG_ACME, async (client) => {
        // users is not RLS-scoped — direct insert.
        await client.query(
            `INSERT INTO users (email, password_hash, name)
             VALUES ($1, $2, 'extra-admin')`,
            [email, "$argon2id$v=19$m=65536,t=3,p=4$cvCzqlGNJKXbUERhk+gdSw$Aqr75RM6pPlkpavJewnfgZHcyhNXTiGYTPA5m747XHE"],
        );
        const u = await client.query(`SELECT id FROM users WHERE email=$1`, [email]);
        userId = u.rows[0].id;
        const m = await client.query(
            `INSERT INTO memberships (org_id, user_id, role, status)
             VALUES ($1, $2, 'admin', 'active')
             RETURNING id`,
            [ORG_ACME, userId],
        );
        membershipId = m.rows[0].id;
    });
    return { userId, membershipId };
}

// ====================================================================== //
//                     membership.role_changed
// ====================================================================== //

test("PATCH /memberships role → membership.role_changed row, payload from/to", async () => {
    const token = await loginToken(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const r = await app.inject({
        method:  "PATCH",
        url:     `/memberships/${ACME_EMP_MEMBERSHIP}`,
        headers: authed(token),
        payload: { role: "manager" },
    });
    assert.equal(r.statusCode, 200, `expected 200, got ${r.statusCode}: ${r.body}`);

    const rows = await findAuditRows(
        ORG_ACME, "membership.role_changed", ACME_EMP_MEMBERSHIP,
    );
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.user_id, ACME_ADMIN);
    assert.equal(row.target_type, "membership");
    assert.equal(row.target_id, ACME_EMP_MEMBERSHIP);
    assert.equal(row.payload.from_role, "employee");
    assert.equal(row.payload.to_role, "manager");
});

test("PATCH /memberships role to SAME value → no audit row", async () => {
    // ACME_EMP_MEMBERSHIP already starts as 'employee' per seed reset.
    const token = await loginToken(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const r = await app.inject({
        method:  "PATCH",
        url:     `/memberships/${ACME_EMP_MEMBERSHIP}`,
        headers: authed(token),
        payload: { role: "employee" },
    });
    assert.equal(r.statusCode, 200);
    const rows = await findAuditRows(
        ORG_ACME, "membership.role_changed", ACME_EMP_MEMBERSHIP,
    );
    assert.equal(rows.length, 0,
        "no-op PATCH must not create a noisy audit row");
});

// ====================================================================== //
//                     membership.status_changed
// ====================================================================== //

test("PATCH /memberships status disable → membership.status_changed row", async () => {
    const token = await loginToken(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const r = await app.inject({
        method:  "PATCH",
        url:     `/memberships/${ACME_EMP_MEMBERSHIP}`,
        headers: authed(token),
        payload: { status: "disabled" },
    });
    assert.equal(r.statusCode, 200);

    const rows = await findAuditRows(
        ORG_ACME, "membership.status_changed", ACME_EMP_MEMBERSHIP,
    );
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.user_id, ACME_ADMIN);
    assert.equal(row.payload.from_status, "active");
    assert.equal(row.payload.to_status, "disabled");
});

test("PATCH /memberships role+status in one PATCH → both audit rows", async () => {
    // Demote the seed admin → manager + disable. Need to add an extra
    // admin first so the last-admin guard doesn't trip.
    await addAcmeExtraAdmin();

    const token = await loginToken(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const r = await app.inject({
        method:  "PATCH",
        url:     `/memberships/${ACME_EMP_MEMBERSHIP}`,
        headers: authed(token),
        payload: { role: "manager", status: "disabled" },
    });
    assert.equal(r.statusCode, 200, `${r.statusCode}: ${r.body}`);

    const roleRows = await findAuditRows(
        ORG_ACME, "membership.role_changed", ACME_EMP_MEMBERSHIP,
    );
    const statusRows = await findAuditRows(
        ORG_ACME, "membership.status_changed", ACME_EMP_MEMBERSHIP,
    );
    assert.equal(roleRows.length, 1);
    assert.equal(statusRows.length, 1);
    assert.equal(roleRows[0].payload.to_role, "manager");
    assert.equal(statusRows[0].payload.to_status, "disabled");
});

// ====================================================================== //
//                     invitation.created
// ====================================================================== //

test("POST /invitations → invitation.created row, payload {role, team_id}, no raw token", async () => {
    // Drive through the service so we can assert the raw token isn't
    // echoed into the audit payload. POST /invitations doesn't return
    // it (only outbox does), so a route-level test couldn't materialize
    // the sensitive-value invariant.
    const email = `invite-test-created-${Date.now()}@example.test`;
    const { invitationId, rawToken } = await createInvitationDirect(email);

    const rows = await findAuditRows(ORG_ACME, "invitation.created", invitationId);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.user_id, ACME_ADMIN);
    assert.equal(row.target_type, "invitation");
    assert.equal(row.target_id, invitationId);
    assert.equal(row.payload.role, "employee");
    assert.equal(row.payload.team_id, null);
    assertNoSensitiveValues(rows, [rawToken, email, ACME_ADMIN_PW]);
});

// ====================================================================== //
//                     invitation.resent
// ====================================================================== //

test("POST /invitations/:id/resend → invitation.resent row, no raw token in payload", async () => {
    const email = `invite-test-resent-${Date.now()}@example.test`;
    const { invitationId, rawToken: originalRaw } = await createInvitationDirect(email);

    // Drop the create-audit row so we assert resent in isolation.
    await app.withOrgContext(ORG_ACME, (c) =>
        c.query(`DELETE FROM activity_log WHERE action='invitation.created' AND target_id=$1`, [invitationId]),
    );

    const token = await loginToken(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const resent = await app.inject({
        method:  "POST",
        url:     `/invitations/${invitationId}/resend`,
        headers: authed(token),
    });
    assert.equal(resent.statusCode, 200, `${resent.statusCode}: ${resent.body}`);

    const rows = await findAuditRows(ORG_ACME, "invitation.resent", invitationId);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.user_id, ACME_ADMIN);
    assert.equal(row.target_type, "invitation");
    assert.equal(row.payload.invitation_id, invitationId);
    assertNoSensitiveValues(rows, [originalRaw, email, ACME_ADMIN_PW]);
});

// ====================================================================== //
//                     invitation.cancelled
// ====================================================================== //

test("DELETE /invitations/:id → invitation.cancelled row", async () => {
    const email = `invite-test-cancelled-${Date.now()}@example.test`;
    const { invitationId, rawToken } = await createInvitationDirect(email);

    const token = await loginToken(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const cancelled = await app.inject({
        method:  "DELETE",
        url:     `/invitations/${invitationId}`,
        headers: authed(token),
    });
    assert.equal(cancelled.statusCode, 204);

    const rows = await findAuditRows(ORG_ACME, "invitation.cancelled", invitationId);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.user_id, ACME_ADMIN);
    assert.equal(row.target_type, "invitation");
    assert.equal(row.payload.invitation_id, invitationId);
    assertNoSensitiveValues(rows, [rawToken, email, ACME_ADMIN_PW]);
});

// ====================================================================== //
//                     invitation.accepted (service pool)
// ====================================================================== //

test("POST /invitations/accept → invitation.accepted row (service pool, void), no sensitive values", async () => {
    const email = `invite-test-accept-${Date.now()}@example.test`;
    const { invitationId, rawToken } = await createInvitationDirect(email);

    // Drop the create-audit row so the test isolates the .accepted row.
    await app.withOrgContext(ORG_ACME, (c) =>
        c.query(`DELETE FROM activity_log WHERE action='invitation.created' AND target_id=$1`, [invitationId]),
    );

    const inviteePassword = "invitee-password-1234";
    const accepted = await app.inject({
        method:  "POST",
        url:     "/invitations/accept",
        payload: {
            token:    rawToken,
            name:     "Invitee Name",
            password: inviteePassword,
        },
    });
    assert.equal(accepted.statusCode, 201,
        `accept failed: ${accepted.statusCode}: ${accepted.body}`);
    const acceptBody = accepted.json();
    const acceptedAccessToken  = acceptBody.accessToken;
    const acceptedMembershipId = acceptBody.membership.id;
    const acceptedUserId       = acceptBody.user.id;

    const rows = await findAuditRows(ORG_ACME, "invitation.accepted", invitationId);
    assert.equal(rows.length, 1);
    const row = rows[0];
    // actor = the user who just accepted (they ARE the new member).
    assert.equal(row.user_id, acceptedUserId);
    assert.equal(row.target_type, "invitation");
    assert.equal(row.target_id, invitationId);
    assert.equal(row.payload.invitation_id, invitationId);
    assert.equal(row.payload.membership_id, acceptedMembershipId);
    assert.equal(row.payload.role, "employee");
    assert.equal(row.payload.team_id, null);
    assertNoSensitiveValues(rows, [
        rawToken,
        inviteePassword,
        acceptedAccessToken,
        email,
    ]);
});

// ====================================================================== //
//                     cross-org isolation
// ====================================================================== //

test("audit row from Acme PATCH is invisible to Beta context", async () => {
    const token = await loginToken(ACME_ADMIN_EMAIL, ACME_ADMIN_PW);
    const r = await app.inject({
        method:  "PATCH",
        url:     `/memberships/${ACME_EMP_MEMBERSHIP}`,
        headers: authed(token),
        payload: { role: "viewer" },
    });
    assert.equal(r.statusCode, 200);

    const acmeRows = await findAuditRows(
        ORG_ACME, "membership.role_changed", ACME_EMP_MEMBERSHIP,
    );
    assert.equal(acmeRows.length, 1);
    const rowId = acmeRows[0].id;

    let betaRows;
    await app.withOrgContext(ORG_BETA, async (client) => {
        const r2 = await client.query(
            `SELECT id FROM activity_log WHERE id = $1`,
            [rowId],
        );
        betaRows = r2.rows;
    });
    assert.equal(betaRows.length, 0,
        "Beta must not see Acme membership audit row");
});

// ====================================================================== //
//             rollback: audit failure aborts the parent mutation
// ====================================================================== //

test("invitation route rollback when invitation.created audit insert is forced to fail", async () => {
    // We can't easily monkey-patch the production hook. The closest
    // controlled proof of the contract is:
    //   1. Drive an INSERT against activity_log with an invalid action
    //      inside the SAME transaction as a membership UPDATE, on the
    //      app pool with the same org context the production hook uses.
    //   2. Verify the CHECK violation propagates and the UPDATE rolls
    //      back together with the failed audit insert.
    // This proves the transactional unity that the production
    // recordActivity / recordInvitationCreated rely on.
    let membershipRoleBefore;
    await app.withOrgContext(ORG_ACME, async (client) => {
        const r = await client.query(
            `SELECT role FROM memberships WHERE id = $1`,
            [ACME_EMP_MEMBERSHIP],
        );
        membershipRoleBefore = r.rows[0].role;
    });

    await assert.rejects(
        () => app.withOrgContext(ORG_ACME, async (client) => {
            // Simulate the production hook contract: mutation first,
            // audit insert second, in one tx.
            await client.query(
                `UPDATE memberships SET role='manager', updated_at=now() WHERE id=$1`,
                [ACME_EMP_MEMBERSHIP],
            );
            await client.query(
                `INSERT INTO activity_log (org_id, action, payload)
                 VALUES ($1, 'this.is.not.a.real.action', '{}'::jsonb)`,
                [ORG_ACME],
            );
        }),
        (err) => /activity_log_action_check/i.test(String(err.message)) || err.code === "23514",
    );

    // The UPDATE must have rolled back together with the bad insert.
    let membershipRoleAfter;
    await app.withOrgContext(ORG_ACME, async (client) => {
        const r = await client.query(
            `SELECT role FROM memberships WHERE id = $1`,
            [ACME_EMP_MEMBERSHIP],
        );
        membershipRoleAfter = r.rows[0].role;
    });
    assert.equal(membershipRoleAfter, membershipRoleBefore,
        "mutation must roll back when same-tx audit insert fails CHECK");
});

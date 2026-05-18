/* /invitations/* — Phase 3 Step 5 §9.
 *
 * Coverage (~26 cases) — see PHASE_3_STEP_5_INVITATION_API.md §9:
 *   - POST   /invitations               201 / dup-pending 409 / expired
 *                                       auto-cancel reissue / role 403 /
 *                                       stale_role 401 / invalid_team 400 /
 *                                       valid teamId 201 / body 400 /
 *                                       already_member (active|disabled)
 *   - GET    /invitations               admin list / employee 403
 *   - POST   /invitations/:id/resend    happy path / old token → 410 /
 *                                       finalized 409 / cross-org 404
 *   - DELETE /invitations/:id           happy path / old token → 410 /
 *                                       finalized 409 / cross-org 404
 *   - POST   /invitations/accept        new user 201 / existing multi-org
 *                                       200 / /me works / dup token 410 /
 *                                       unknown 410 / expired seed 410 /
 *                                       canceled 410 / disabled+retry 409
 *                                       /  already_member + retry 409 /
 *                                       concurrent multi-org race / 400
 *
 * Pre-req: docker compose up + migrate (through 0008) + service role +
 * seeded Acme/Beta + Phase 3 demo seed (0003).
 *
 * Run:  cd server && npm test
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import authPlugin from "../src/plugins/auth.js";
import dbPlugin from "../src/plugins/db.js";
import authRoutes from "../src/routes/auth.js";
import invitationsRoutes from "../src/routes/invitations.js";
import meRoutes from "../src/routes/me.js";
import teamRoutes from "../src/routes/team.js";
import { hashPassword } from "../src/services/auth.js";
import { closeServicePool, getServicePool } from "../src/db/servicePool.js";

const ACME_ID = "11111111-1111-1111-1111-111111111111";
const BETA_ID = "22222222-2222-2222-2222-222222222222";
const ACME_ADMIN_USER       = "aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa";
const ACME_EMP_USER         = "aaaaaaaa-0002-0002-0002-aaaaaaaaaaaa";
const BETA_ADMIN_USER       = "bbbbbbbb-0001-0001-0001-bbbbbbbbbbbb";
const BETA_EMP_USER         = "bbbbbbbb-0002-0002-0002-bbbbbbbbbbbb";
const ACME_ADMIN_MEMBERSHIP = "cccccccc-0001-0001-0001-cccccccccccc";
const ACME_EMP_MEMBERSHIP   = "cccccccc-0002-0002-0002-cccccccccccc";
const BETA_ADMIN_MEMBERSHIP = "dddddddd-0001-0001-0001-dddddddddddd";
const BETA_EMP_MEMBERSHIP   = "dddddddd-0002-0002-0002-dddddddddddd";
const SEEDED_MEMBERSHIPS = [
    ACME_ADMIN_MEMBERSHIP, ACME_EMP_MEMBERSHIP,
    BETA_ADMIN_MEMBERSHIP, BETA_EMP_MEMBERSHIP,
];

// Phase 3 demo seed (0003_phase3_demo.sql)
const SEED_INV_LIVE    = "1ff11111-1111-1111-1111-111111111111";
const SEED_INV_EXPIRED = "1ff22222-2222-2222-2222-222222222222";
const SEED_TOK_LIVE    = "77111111-1111-1111-1111-111111111111";
const SEED_TOK_EXPIRED = "77222222-2222-2222-2222-222222222222";
const SEED_OUTBOX      = "88011111-1111-1111-1111-111111111111";
const SEEDED_INV_IDS   = [SEED_INV_LIVE, SEED_INV_EXPIRED];
const SEEDED_TOK_IDS   = [SEED_TOK_LIVE, SEED_TOK_EXPIRED];
const SEED_INV_EMAIL_LIVE    = "pending-invitee@acme.test";
const SEED_INV_EMAIL_EXPIRED = "expired-invitee@acme.test";

const ACME_ADMIN_PW = "acme-admin-1234";
const ACME_EMP_PW   = "acme-emp-1234";
const BETA_ADMIN_PW = "beta-admin-1234";

let app;
const svc = () => getServicePool();

before(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    await app.register(dbPlugin);
    await app.register(authRoutes);
    await app.register(meRoutes);
    await app.register(teamRoutes);
    await app.register(invitationsRoutes);

    // Phase 7 Step 9 — these tests exercise invitation flows, not plan caps.
    // Beta seed = starter (seat cap 2) and already has 2 active memberships,
    // so any test that creates a 3rd Beta invitation would trip the cap.
    // Upgrade both seeded orgs to enterprise (null caps) for the suite and
    // restore the seed plans in after().
    await app.pg.query(
        `UPDATE organizations SET plan='enterprise' WHERE id IN ($1, $2)`,
        [ACME_ID, BETA_ID],
    );
});

after(async () => {
    await app.pg.query(
        `UPDATE organizations SET plan = CASE id
            WHEN $1 THEN 'pro'
            WHEN $2 THEN 'starter' END
          WHERE id IN ($1, $2)`,
        [ACME_ID, BETA_ID],
    );
    await closeServicePool();
    await app.close();
});

afterEach(async () => {
    // Cleanup strategy:
    //   - app pool (NOT kloser_service): has DELETE on all tables, but
    //     RLS scopes deletes to the current GUC. Use withOrgContext per
    //     org. kloser_service migration 0008 grants SELECT/INSERT/UPDATE
    //     only — no DELETE — so the service pool would 42501 here.
    //   - RLS-scoped reads use the service pool via svc() in tests.

    // 1) Sessions are NOT RLS-scoped → app pool directly.
    await app.pg.query("DELETE FROM sessions");

    // 2~4) Org-scoped tables: scope to each org's RLS context, delete
    //      everything not seeded.
    for (const orgId of [ACME_ID, BETA_ID]) {
        await app.withOrgContext(orgId, async (client) => {
            await client.query(
                `DELETE FROM auth_tokens
                  WHERE purpose = 'invitation' AND id NOT IN ($1, $2)`,
                SEEDED_TOK_IDS,
            );
            // Non-invitation tokens (signup-verification, password reset)
            // dangle on test users — clear via user_id-scoped delete inside
            // the same RLS context (token row's org_id = current org).
            await client.query(
                `DELETE FROM auth_tokens
                  WHERE purpose <> 'invitation' AND user_id IS NOT NULL`,
            );
            await client.query(
                `DELETE FROM invitations WHERE id NOT IN ($1, $2)`,
                SEEDED_INV_IDS,
            );
            await client.query(
                `DELETE FROM email_outbox WHERE id <> $1`,
                [SEED_OUTBOX],
            );
        });
    }

    // 5) Restore seeded invitation rows + paired tokens to pristine state.
    //    Seeded data lives in Acme — scope the UPDATEs to that org.
    await app.withOrgContext(ACME_ID, async (client) => {
        await client.query(
            `UPDATE invitations
                SET accepted_at = NULL, canceled_at = NULL,
                    last_sent_at = CASE id
                      WHEN $1 THEN now()
                      ELSE          now() - interval '8 days' END
              WHERE id IN ($1, $2)`,
            [SEED_INV_LIVE, SEED_INV_EXPIRED],
        );
        await client.query(
            `UPDATE auth_tokens
                SET consumed_at = NULL, invalidated_at = NULL,
                    expires_at = CASE id
                      WHEN $1 THEN now() + interval '5 days'
                      ELSE          now() - interval '1 day' END
              WHERE id IN ($1, $2)`,
            [SEED_TOK_LIVE, SEED_TOK_EXPIRED],
        );
    });

    // 6) Delete users created during tests (invitetest-prefix). Cascades
    //    to memberships in test orgs (none currently) + sessions (already
    //    cleared) + auth_tokens.user_id rows.
    await app.pg.query(
        `DELETE FROM users WHERE email LIKE 'invitetest-%@example.test'`,
    );

    // 7) Restore Acme/Beta state: seeded users' disabled_at NULL, seeded
    //    memberships role/status, drop any extra memberships, drop teams.
    await app.pg.query(
        `UPDATE users SET disabled_at = NULL
          WHERE id IN ($1, $2, $3, $4)`,
        [ACME_ADMIN_USER, ACME_EMP_USER, BETA_ADMIN_USER, BETA_EMP_USER],
    );
    for (const orgId of [ACME_ID, BETA_ID]) {
        await app.withOrgContext(orgId, async (client) => {
            await client.query(
                `DELETE FROM memberships
                  WHERE id NOT IN ($1, $2, $3, $4)`,
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
            await client.query(`DELETE FROM teams`);
        });
    }
});

// -------------------------------------------------------------- //
// Helpers
// -------------------------------------------------------------- //

async function login(email, password, orgId) {
    return app.inject({
        method: "POST", url: "/auth/login",
        payload: { email, password, ...(orgId ? { orgId } : {}) },
    });
}

async function acmeAdminToken() {
    const r = await login("admin@acme.test", ACME_ADMIN_PW);
    assert.equal(r.statusCode, 200);
    return r.json().accessToken;
}

async function acmeEmpToken() {
    const r = await login("emp@acme.test", ACME_EMP_PW);
    assert.equal(r.statusCode, 200);
    return r.json().accessToken;
}

async function betaAdminToken() {
    const r = await login("admin@beta.test", BETA_ADMIN_PW);
    assert.equal(r.statusCode, 200);
    return r.json().accessToken;
}

function authed(token) {
    return { authorization: `Bearer ${token}` };
}

let __serial = 0;
function uniqueEmail(suffix = "") {
    __serial += 1;
    return `invitetest-${suffix || "x"}-${Date.now()}-${__serial}-${Math.random().toString(36).slice(2,6)}@example.test`;
}

/** Pull the most recent invitation raw token from email_outbox metadata
 *  for the given email. metadata.acceptUrl carries `?token=<raw>` (dev). */
async function rawInvitationTokenFor(email) {
    const r = await svc().query(
        `SELECT metadata FROM email_outbox
          WHERE to_email = $1 AND template = 'invitation'
          ORDER BY created_at DESC LIMIT 1`,
        [email],
    );
    assert.ok(r.rows[0], `no invitation email in outbox for ${email}`);
    const accept = r.rows[0].metadata?.acceptUrl;
    assert.ok(accept, "outbox metadata missing acceptUrl");
    const m = /[?&]token=([^&\s]+)/.exec(accept);
    assert.ok(m, "acceptUrl missing token");
    return decodeURIComponent(m[1]);
}

async function createInvite(tok, payload) {
    return app.inject({
        method: "POST", url: "/invitations",
        headers: authed(tok), payload,
    });
}

// =============================================================== //
// POST /invitations
// =============================================================== //

test("POST /invitations: admin invites → 201 with full Invitation shape", async () => {
    const tok = await acmeAdminToken();
    const email = uniqueEmail("create");
    const r = await createInvite(tok, { email, role: "employee" });
    assert.equal(r.statusCode, 201, r.body);
    const inv = r.json().invitation;
    assert.equal(inv.email, email);
    assert.equal(inv.role, "employee");
    assert.equal(inv.org_id, ACME_ID);
    assert.equal(inv.team_id, null);
    assert.equal(inv.invited_by_user_id, ACME_ADMIN_USER);
    assert.ok(inv.invited_by_name);
    assert.ok(inv.token_expires_at);
    assert.ok(inv.last_sent_at);

    // DB: one invitation, one active token, one outbox row.
    const inviteRow = await svc().query(
        `SELECT id, accepted_at, canceled_at FROM invitations
          WHERE org_id = $1 AND email = $2`,
        [ACME_ID, email]);
    assert.equal(inviteRow.rows.length, 1);
    assert.equal(inviteRow.rows[0].accepted_at, null);
    assert.equal(inviteRow.rows[0].canceled_at, null);

    const tokenRow = await svc().query(
        `SELECT consumed_at, invalidated_at FROM auth_tokens
          WHERE invitation_id = $1`,
        [inviteRow.rows[0].id]);
    assert.equal(tokenRow.rows.length, 1);
    assert.equal(tokenRow.rows[0].consumed_at, null);
    assert.equal(tokenRow.rows[0].invalidated_at, null);

    const outbox = await svc().query(
        `SELECT id FROM email_outbox
          WHERE to_email = $1 AND template = 'invitation'`,
        [email]);
    assert.equal(outbox.rows.length, 1);
});

test("POST /invitations: duplicate live pending → 409 invitation_already_pending", async () => {
    const tok = await acmeAdminToken();
    const email = uniqueEmail("dup");
    const r1 = await createInvite(tok, { email, role: "viewer" });
    assert.equal(r1.statusCode, 201);
    const r2 = await createInvite(tok, { email, role: "manager" });
    assert.equal(r2.statusCode, 409, r2.body);
    assert.equal(r2.json().code, "invitation_already_pending");
});

test("POST /invitations: expired pending → auto-cancel + reissue 201", async () => {
    const tok = await acmeAdminToken();
    // Re-invite the seeded expired-invitee email. Service detects the
    // expired token, cancels the old invitation, mints a new one.
    const r = await createInvite(tok, {
        email: SEED_INV_EMAIL_EXPIRED,
        role: "employee",
    });
    assert.equal(r.statusCode, 201, r.body);

    // Seeded invitation row is now canceled.
    const old = await svc().query(
        `SELECT canceled_at FROM invitations WHERE id = $1`,
        [SEED_INV_EXPIRED]);
    assert.ok(old.rows[0].canceled_at, "seeded expired invitation should be canceled");

    // Seeded token row is invalidated.
    const oldTok = await svc().query(
        `SELECT invalidated_at FROM auth_tokens WHERE id = $1`,
        [SEED_TOK_EXPIRED]);
    assert.ok(oldTok.rows[0].invalidated_at, "seeded expired token should be invalidated");

    // New invitation exists with a fresh active token.
    const fresh = await svc().query(
        `SELECT id FROM invitations
          WHERE org_id = $1 AND email = $2
            AND accepted_at IS NULL AND canceled_at IS NULL`,
        [ACME_ID, SEED_INV_EMAIL_EXPIRED]);
    assert.equal(fresh.rows.length, 1);
});

test("POST /invitations: employee → 403 forbidden", async () => {
    const tok = await acmeEmpToken();
    const r = await createInvite(tok, {
        email: uniqueEmail("emp-attempt"),
        role: "viewer",
    });
    assert.equal(r.statusCode, 403, r.body);
});

test("POST /invitations: stale_role admin (demoted then act) → 401 stale_role", async () => {
    const tok = await acmeAdminToken();
    // Demote admin via direct SQL (bypass admin protection in test).
    // BUT memberships has UNIQUE active-admin row protection only via
    // service — at SQL level we can demote freely. Add a backup admin
    // first so /auth/login itself doesn't break later tests.
    await app.withOrgContext(ACME_ID, async (client) => {
        await client.query(
            `UPDATE memberships SET role='viewer' WHERE id = $1`,
            [ACME_ADMIN_MEMBERSHIP]);
    });
    const r = await createInvite(tok, {
        email: uniqueEmail("stale"),
        role: "employee",
    });
    assert.equal(r.statusCode, 401, r.body);
    assert.equal(r.json().code, "stale_role");
});

test("POST /invitations: teamId from different org → 400 invalid_team", async () => {
    const tok = await acmeAdminToken();
    // Make a Beta team and try to use its id from Acme.
    let betaTeamId;
    await app.withOrgContext(BETA_ID, async (client) => {
        const r = await client.query(
            `INSERT INTO teams (org_id, name) VALUES ($1, $2) RETURNING id`,
            [BETA_ID, "beta-team-x"]);
        betaTeamId = r.rows[0].id;
    });
    const r = await createInvite(tok, {
        email: uniqueEmail("xorg"),
        role: "viewer",
        teamId: betaTeamId,
    });
    assert.equal(r.statusCode, 400, r.body);
    assert.equal(r.json().code, "invalid_team");
});

test("POST /invitations: teamId from same org → 201 with team_id set", async () => {
    const adminTok = await acmeAdminToken();
    const teamCreate = await app.inject({
        method: "POST", url: "/teams", headers: authed(adminTok),
        payload: { name: "team-invite-x" },
    });
    assert.equal(teamCreate.statusCode, 201);
    const teamId = teamCreate.json().team.id;

    const r = await createInvite(adminTok, {
        email: uniqueEmail("team"),
        role: "employee",
        teamId,
    });
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json().invitation.team_id, teamId);
});

test("POST /invitations: empty body → 400 invalid_input", async () => {
    const tok = await acmeAdminToken();
    const r = await createInvite(tok, {});
    assert.equal(r.statusCode, 400, r.body);
});

test("POST /invitations: already active member → 409 already_member", async () => {
    const tok = await acmeAdminToken();
    const r = await createInvite(tok, {
        email: "emp@acme.test",
        role: "viewer",
    });
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().code, "already_member");
});

test("POST /invitations: already disabled member → 409 already_member", async () => {
    const tok = await acmeAdminToken();
    await app.withOrgContext(ACME_ID, async (client) => {
        await client.query(
            `UPDATE memberships SET status='disabled' WHERE id = $1`,
            [ACME_EMP_MEMBERSHIP]);
    });
    const r = await createInvite(tok, {
        email: "emp@acme.test",
        role: "viewer",
    });
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().code, "already_member");
});

// =============================================================== //
// GET /invitations
// =============================================================== //

test("GET /invitations: admin sees active pending (seed + freshly created)", async () => {
    const tok = await acmeAdminToken();
    const email = uniqueEmail("list");
    const c = await createInvite(tok, { email, role: "viewer" });
    assert.equal(c.statusCode, 201);

    const r = await app.inject({
        method: "GET", url: "/invitations",
        headers: authed(tok),
    });
    assert.equal(r.statusCode, 200);
    const emails = r.json().invitations.map((i) => i.email).sort();
    assert.ok(emails.includes(email));
    assert.ok(emails.includes(SEED_INV_EMAIL_LIVE),
        `seed pending-invitee should appear: ${JSON.stringify(emails)}`);
    assert.ok(!emails.includes(SEED_INV_EMAIL_EXPIRED),
        "expired seed should be excluded from list");
});

test("GET /invitations: employee → 403", async () => {
    const tok = await acmeEmpToken();
    const r = await app.inject({
        method: "GET", url: "/invitations",
        headers: authed(tok),
    });
    assert.equal(r.statusCode, 403, r.body);
});

// =============================================================== //
// POST /invitations/:id/resend
// =============================================================== //

test("POST /invitations/:id/resend: invalidates old token + mints new one", async () => {
    const tok = await acmeAdminToken();
    const email = uniqueEmail("resend");
    const c = await createInvite(tok, { email, role: "viewer" });
    const id = c.json().invitation.id;
    const oldRaw = await rawInvitationTokenFor(email);

    const r = await app.inject({
        method: "POST", url: `/invitations/${id}/resend`,
        headers: authed(tok),
    });
    assert.equal(r.statusCode, 200, r.body);

    // 2 outbox rows for this email; old token row invalidated; new token active.
    const outbox = await svc().query(
        `SELECT id FROM email_outbox WHERE to_email = $1`, [email]);
    assert.equal(outbox.rows.length, 2);

    const tokRows = await svc().query(
        `SELECT consumed_at, invalidated_at, expires_at FROM auth_tokens
          WHERE invitation_id = $1 ORDER BY created_at`,
        [id]);
    assert.equal(tokRows.rows.length, 2);
    assert.ok(tokRows.rows[0].invalidated_at, "old token should be invalidated");
    assert.equal(tokRows.rows[1].invalidated_at, null);
    assert.equal(tokRows.rows[1].consumed_at, null);

    // Old raw token now → accept fails 410.
    const acc = await app.inject({
        method: "POST", url: "/invitations/accept",
        payload: { token: oldRaw, name: "Old", password: "invitetest-pw-12345" },
    });
    assert.equal(acc.statusCode, 410, acc.body);
});

test("POST /invitations/:id/resend: finalized (already accepted) → 409", async () => {
    const tok = await acmeAdminToken();
    const email = uniqueEmail("finalized-resend");
    const c = await createInvite(tok, { email, role: "viewer" });
    const id = c.json().invitation.id;

    // Manually mark accepted to skip the full accept flow's session shape.
    await svc().query(
        `UPDATE invitations SET accepted_at = now() WHERE id = $1`, [id]);

    const r = await app.inject({
        method: "POST", url: `/invitations/${id}/resend`,
        headers: authed(tok),
    });
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().code, "invitation_already_finalized");
});

test("POST /invitations/:id/resend: cross-org id → 404 not_found", async () => {
    const tok = await betaAdminToken();
    const r = await app.inject({
        method: "POST", url: `/invitations/${SEED_INV_LIVE}/resend`,
        headers: authed(tok),
    });
    assert.equal(r.statusCode, 404, r.body);
});

// =============================================================== //
// DELETE /invitations/:id
// =============================================================== //

test("DELETE /invitations/:id: soft cancel + token invalidated → 204", async () => {
    const tok = await acmeAdminToken();
    const email = uniqueEmail("cancel");
    const c = await createInvite(tok, { email, role: "viewer" });
    const id = c.json().invitation.id;
    const raw = await rawInvitationTokenFor(email);

    const r = await app.inject({
        method: "DELETE", url: `/invitations/${id}`,
        headers: authed(tok),
    });
    assert.equal(r.statusCode, 204, r.body);

    const inv = await svc().query(
        `SELECT canceled_at FROM invitations WHERE id = $1`, [id]);
    assert.ok(inv.rows[0].canceled_at);
    const t = await svc().query(
        `SELECT invalidated_at FROM auth_tokens WHERE invitation_id = $1`, [id]);
    assert.ok(t.rows[0].invalidated_at);

    // Old raw token → 410.
    const acc = await app.inject({
        method: "POST", url: "/invitations/accept",
        payload: { token: raw, name: "Late", password: "invitetest-pw-12345" },
    });
    assert.equal(acc.statusCode, 410, acc.body);
});

test("DELETE /invitations/:id: already finalized → 409", async () => {
    const tok = await acmeAdminToken();
    const email = uniqueEmail("dup-cancel");
    const c = await createInvite(tok, { email, role: "viewer" });
    const id = c.json().invitation.id;
    await svc().query(
        `UPDATE invitations SET canceled_at = now() WHERE id = $1`, [id]);
    const r = await app.inject({
        method: "DELETE", url: `/invitations/${id}`,
        headers: authed(tok),
    });
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().code, "invitation_already_finalized");
});

test("DELETE /invitations/:id: cross-org → 404", async () => {
    const tok = await betaAdminToken();
    const r = await app.inject({
        method: "DELETE", url: `/invitations/${SEED_INV_LIVE}`,
        headers: authed(tok),
    });
    assert.equal(r.statusCode, 404, r.body);
});

// =============================================================== //
// POST /invitations/accept
// =============================================================== //

test("POST /invitations/accept: new user → 201 + refresh cookie + access token + DB state", async () => {
    const tok = await acmeAdminToken();
    const email = uniqueEmail("accept-new");
    const c = await createInvite(tok, { email, role: "manager" });
    const id = c.json().invitation.id;
    const raw = await rawInvitationTokenFor(email);

    const r = await app.inject({
        method: "POST", url: "/invitations/accept",
        payload: { token: raw, name: "Accept New", password: "invitetest-pw-12345" },
    });
    assert.equal(r.statusCode, 201, r.body);
    const body = r.json();
    assert.ok(body.accessToken);
    assert.equal(body.user.email, email);
    assert.equal(body.organization.id, ACME_ID);
    assert.equal(body.membership.role, "manager");
    const setCookie = r.headers["set-cookie"];
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join(";") : setCookie;
    assert.ok(cookieHeader && cookieHeader.includes("kloser_refresh="));

    // DB state.
    const u = await app.pg.query(
        `SELECT id, email_verified_at FROM users WHERE email = $1`, [email]);
    assert.equal(u.rows.length, 1);
    assert.ok(u.rows[0].email_verified_at, "email_verified_at should be set");
    const userId = u.rows[0].id;

    const inv = await svc().query(
        `SELECT accepted_at FROM invitations WHERE id = $1`, [id]);
    assert.ok(inv.rows[0].accepted_at);
    const t = await svc().query(
        `SELECT consumed_at FROM auth_tokens WHERE invitation_id = $1`, [id]);
    assert.ok(t.rows[0].consumed_at);
    const m = await app.withOrgContext(ACME_ID, async (client) => {
        const x = await client.query(
            `SELECT id, role, status FROM memberships
              WHERE org_id = $1 AND user_id = $2`,
            [ACME_ID, userId]);
        return x.rows[0];
    });
    assert.equal(m.role, "manager");
    assert.equal(m.status, "active");
});

test("POST /invitations/accept: existing user multi-org → 200 + password not overwritten", async () => {
    // emp@acme.test already exists. Beta admin invites them to Beta.
    const betaTok = await betaAdminToken();
    const c = await createInvite(betaTok, {
        email: "emp@acme.test",
        role: "viewer",
    });
    assert.equal(c.statusCode, 201);
    const raw = await rawInvitationTokenFor("emp@acme.test");

    const r = await app.inject({
        method: "POST", url: "/invitations/accept",
        payload: {
            token: raw,
            name: "should be ignored",
            password: "definitely-not-the-acme-password",
        },
    });
    assert.equal(r.statusCode, 200, r.body);
    const body = r.json();
    assert.equal(body.organization.id, BETA_ID);
    assert.equal(body.membership.role, "viewer");

    // Original Acme login still works → password not overwritten.
    const oldLogin = await login("emp@acme.test", ACME_EMP_PW, ACME_ID);
    assert.equal(oldLogin.statusCode, 200, oldLogin.body);

    // The provided fake password should NOT work.
    const wrongLogin = await login(
        "emp@acme.test", "definitely-not-the-acme-password", ACME_ID);
    assert.equal(wrongLogin.statusCode, 401);
});

test("POST /invitations/accept: /me with new access token returns expected org+role", async () => {
    const tok = await acmeAdminToken();
    const email = uniqueEmail("me");
    await createInvite(tok, { email, role: "employee" });
    const raw = await rawInvitationTokenFor(email);
    const accept = await app.inject({
        method: "POST", url: "/invitations/accept",
        payload: { token: raw, name: "Me Test", password: "invitetest-pw-12345" },
    });
    assert.equal(accept.statusCode, 201);
    const accessToken = accept.json().accessToken;

    const me = await app.inject({
        method: "GET", url: "/me",
        headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(me.statusCode, 200, me.body);
    assert.equal(me.json().user.email, email);
    assert.equal(me.json().organization.id, ACME_ID);
    assert.equal(me.json().membership.role, "employee");
});

test("POST /invitations/accept: same token twice → second 410", async () => {
    const tok = await acmeAdminToken();
    const email = uniqueEmail("dup-accept");
    await createInvite(tok, { email, role: "viewer" });
    const raw = await rawInvitationTokenFor(email);
    const r1 = await app.inject({
        method: "POST", url: "/invitations/accept",
        payload: { token: raw, name: "First", password: "invitetest-pw-12345" },
    });
    assert.equal(r1.statusCode, 201);
    const r2 = await app.inject({
        method: "POST", url: "/invitations/accept",
        payload: { token: raw, name: "Second", password: "invitetest-pw-12345" },
    });
    assert.equal(r2.statusCode, 410, r2.body);
});

test("POST /invitations/accept: unknown token → 410", async () => {
    const r = await app.inject({
        method: "POST", url: "/invitations/accept",
        payload: { token: "no-such-token-anywhere", name: "X", password: "invitetest-pw-12345" },
    });
    assert.equal(r.statusCode, 410, r.body);
});

test("POST /invitations/accept: expired seed token → 410", async () => {
    const r = await app.inject({
        method: "POST", url: "/invitations/accept",
        payload: {
            token: "phase3-seed-expired-invitation-token",
            name: "Old",
            password: "invitetest-pw-12345",
        },
    });
    assert.equal(r.statusCode, 410, r.body);
});

test("POST /invitations/accept: canceled invitation token → 410", async () => {
    const tok = await acmeAdminToken();
    const email = uniqueEmail("canceled");
    const c = await createInvite(tok, { email, role: "viewer" });
    const id = c.json().invitation.id;
    const raw = await rawInvitationTokenFor(email);
    const del = await app.inject({
        method: "DELETE", url: `/invitations/${id}`,
        headers: authed(tok),
    });
    assert.equal(del.statusCode, 204);

    const r = await app.inject({
        method: "POST", url: "/invitations/accept",
        payload: { token: raw, name: "Late", password: "invitetest-pw-12345" },
    });
    assert.equal(r.statusCode, 410, r.body);
});

test("POST /invitations/accept: disabled user → 409 account_disabled + retry same 409 + token NOT consumed", async () => {
    // Existing acme emp user, disable globally (users.disabled_at), then
    // Beta admin invites the same email.
    const betaTok = await betaAdminToken();
    const c = await createInvite(betaTok, {
        email: "emp@acme.test",
        role: "viewer",
    });
    assert.equal(c.statusCode, 201);
    const raw = await rawInvitationTokenFor("emp@acme.test");

    await app.pg.query(
        `UPDATE users SET disabled_at = now() WHERE id = $1`,
        [ACME_EMP_USER]);

    const r1 = await app.inject({
        method: "POST", url: "/invitations/accept",
        payload: { token: raw, name: "Disabled", password: "invitetest-pw-12345" },
    });
    assert.equal(r1.statusCode, 409, r1.body);
    assert.equal(r1.json().code, "account_disabled");

    // Token still active (consumed_at NULL) → retry yields same 409.
    const tokRow = await svc().query(
        `SELECT consumed_at FROM auth_tokens
          WHERE invitation_id = $1`,
        [c.json().invitation.id]);
    assert.equal(tokRow.rows[0].consumed_at, null,
        "token should NOT be consumed after 409 rollback");

    const r2 = await app.inject({
        method: "POST", url: "/invitations/accept",
        payload: { token: raw, name: "Disabled2", password: "invitetest-pw-12345" },
    });
    assert.equal(r2.statusCode, 409, r2.body);
    assert.equal(r2.json().code, "account_disabled");
});

test("POST /invitations/accept: already-member race → 409 + retry same 409 + token NOT consumed", async () => {
    // Beta admin invites someone, then we manually add a membership for
    // the same user before the user accepts. Simulates a race.
    const betaTok = await betaAdminToken();
    // Use acme admin user — they already have an Acme membership. Invite
    // them to Beta and then race-insert a Beta membership directly.
    const c = await createInvite(betaTok, {
        email: "admin@acme.test",
        role: "employee",
    });
    assert.equal(c.statusCode, 201);
    const id = c.json().invitation.id;
    const raw = await rawInvitationTokenFor("admin@acme.test");

    // Pre-INSERT a Beta membership for the acme admin user.
    await app.withOrgContext(BETA_ID, async (client) => {
        await client.query(
            `INSERT INTO memberships (org_id, user_id, role)
             VALUES ($1, $2, 'viewer')`,
            [BETA_ID, ACME_ADMIN_USER]);
    });

    const r1 = await app.inject({
        method: "POST", url: "/invitations/accept",
        payload: { token: raw, name: "Race", password: "invitetest-pw-12345" },
    });
    assert.equal(r1.statusCode, 409, r1.body);
    assert.equal(r1.json().code, "already_member");

    const tokRow = await svc().query(
        `SELECT consumed_at FROM auth_tokens WHERE invitation_id = $1`,
        [id]);
    assert.equal(tokRow.rows[0].consumed_at, null,
        "token should NOT be consumed after 409 rollback");

    const r2 = await app.inject({
        method: "POST", url: "/invitations/accept",
        payload: { token: raw, name: "Race2", password: "invitetest-pw-12345" },
    });
    assert.equal(r2.statusCode, 409, r2.body);
    assert.equal(r2.json().code, "already_member");
});

test("POST /invitations/accept: concurrent multi-org same new email → both succeed", async () => {
    const acmeTok = await acmeAdminToken();
    const betaTok = await betaAdminToken();
    const email = uniqueEmail("multiorg");
    // Create two invitations for the same new email, one per org.
    const cA = await createInvite(acmeTok, { email, role: "employee" });
    const cB = await createInvite(betaTok, { email, role: "viewer" });
    assert.equal(cA.statusCode, 201);
    assert.equal(cB.statusCode, 201);

    // Pull the raw tokens (different outbox rows).
    const rawA = await (async () => {
        const r = await svc().query(
            `SELECT metadata FROM email_outbox
              WHERE to_email = $1 AND template = 'invitation'
                AND org_id = $2
              ORDER BY created_at DESC LIMIT 1`,
            [email, ACME_ID]);
        return decodeURIComponent(/[?&]token=([^&\s]+)/.exec(r.rows[0].metadata.acceptUrl)[1]);
    })();
    const rawB = await (async () => {
        const r = await svc().query(
            `SELECT metadata FROM email_outbox
              WHERE to_email = $1 AND template = 'invitation'
                AND org_id = $2
              ORDER BY created_at DESC LIMIT 1`,
            [email, BETA_ID]);
        return decodeURIComponent(/[?&]token=([^&\s]+)/.exec(r.rows[0].metadata.acceptUrl)[1]);
    })();

    // Fire both accepts concurrently.
    const [rA, rB] = await Promise.all([
        app.inject({
            method: "POST", url: "/invitations/accept",
            payload: { token: rawA, name: "Multi", password: "invitetest-pw-12345" },
        }),
        app.inject({
            method: "POST", url: "/invitations/accept",
            payload: { token: rawB, name: "Multi", password: "invitetest-pw-12345" },
        }),
    ]);
    assert.ok([200, 201].includes(rA.statusCode), `rA: ${rA.statusCode} ${rA.body}`);
    assert.ok([200, 201].includes(rB.statusCode), `rB: ${rB.statusCode} ${rB.body}`);

    // DB: exactly one users row + two memberships (one per org).
    const u = await app.pg.query(
        `SELECT id FROM users WHERE email = $1`, [email]);
    assert.equal(u.rows.length, 1);
    const userId = u.rows[0].id;

    const acmeM = await app.withOrgContext(ACME_ID, async (client) => {
        const x = await client.query(
            `SELECT id FROM memberships WHERE org_id = $1 AND user_id = $2`,
            [ACME_ID, userId]);
        return x.rows.length;
    });
    const betaM = await app.withOrgContext(BETA_ID, async (client) => {
        const x = await client.query(
            `SELECT id FROM memberships WHERE org_id = $1 AND user_id = $2`,
            [BETA_ID, userId]);
        return x.rows.length;
    });
    assert.equal(acmeM, 1);
    assert.equal(betaM, 1);
});

test("POST /invitations/accept: short password → 400 invalid_input", async () => {
    const r = await app.inject({
        method: "POST", url: "/invitations/accept",
        payload: { token: "anything", name: "X", password: "short1" },
    });
    assert.equal(r.statusCode, 400, r.body);
});

test("POST /invitations/accept: missing fields → 400 invalid_input", async () => {
    const r = await app.inject({
        method: "POST", url: "/invitations/accept",
        payload: {},
    });
    assert.equal(r.statusCode, 400, r.body);
});

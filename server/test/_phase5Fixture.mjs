/* Phase 5 route/WS test fixture helper.
 *
 * Provides ephemeral phase5test users + 2 teams in Acme so route tests
 * can exercise the manager team-scope path without touching the seed
 * memberships. Mirrors the user set from server/test/phase5_services.test.mjs
 * but adds:
 *   - email_verified_at stamp (writer chain requires verified)
 *   - resolveMembershipIds(): map of user_id → membership_id
 *   - mintToken(app, userKey): JWT signed with app.jwt.sign() carrying
 *     the matching membership_id + role
 *
 * Cleanup deletes ONLY the phase5test users / memberships / teams. The
 * seed rows are never touched. Call createFixtureUsers() in `before`
 * and destroyFixtureUsers() in `after`.
 */
import { randomUUID } from "node:crypto";

export const ORG_ACME = "11111111-1111-1111-1111-111111111111";
export const ORG_BETA = "22222222-2222-2222-2222-222222222222";

// seed users (already in DB).
export const USER_ACME_ADMIN = "aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa";
export const USER_ACME_EMP   = "aaaaaaaa-0002-0002-0002-aaaaaaaaaaaa";
export const USER_BETA_ADMIN = "bbbbbbbb-0001-0001-0001-bbbbbbbbbbbb";
export const USER_BETA_EMP   = "bbbbbbbb-0002-0002-0002-bbbbbbbbbbbb";
export const MEMBERSHIP_ACME_ADMIN = "cccccccc-0001-0001-0001-cccccccccccc";
export const MEMBERSHIP_ACME_EMP   = "cccccccc-0002-0002-0002-cccccccccccc";

export const CUSTOMER_ACME_KIM  = "eeeeeeee-1111-0001-0001-eeeeeeeeeeee";
export const CUSTOMER_BETA_JUNG = "ffffffff-2222-0001-0001-ffffffffffff";

// ephemeral phase5test ids (stable so re-runs are idempotent).
export const TEAM_A_ID            = "99990001-aaaa-aaaa-aaaa-000000000001";
export const TEAM_B_ID            = "99990001-aaaa-aaaa-aaaa-000000000002";
export const USER_MANAGER_TEAM_A  = "99990002-aaaa-aaaa-aaaa-000000000001";
export const USER_EMPLOYEE_TEAM_A = "99990002-aaaa-aaaa-aaaa-000000000002";
export const USER_EMPLOYEE_TEAM_B = "99990002-aaaa-aaaa-aaaa-000000000003";
export const USER_VIEWER_NO_TEAM  = "99990002-aaaa-aaaa-aaaa-000000000004";
export const USER_MANAGER_NO_TEAM = "99990002-aaaa-aaaa-aaaa-000000000005";

const PREFIX = "phase5routetest-";

// Membership ids — resolved after seeding.
const MEMBERSHIP_BY_USER = new Map();

export async function createFixtureUsers(app) {
    await app.pg.query(
        `INSERT INTO users (id, email, password_hash, name, email_verified_at)
         VALUES
            ($1, $6, 'phase5test-pwd', 'phase5test-mgr-a',     now()),
            ($2, $7, 'phase5test-pwd', 'phase5test-emp-a',     now()),
            ($3, $8, 'phase5test-pwd', 'phase5test-emp-b',     now()),
            ($4, $9, 'phase5test-pwd', 'phase5test-viewer',    now()),
            ($5, $10,'phase5test-pwd', 'phase5test-mgr-noteam',now())
         ON CONFLICT (id) DO UPDATE SET email_verified_at = EXCLUDED.email_verified_at`,
        [
            USER_MANAGER_TEAM_A,
            USER_EMPLOYEE_TEAM_A,
            USER_EMPLOYEE_TEAM_B,
            USER_VIEWER_NO_TEAM,
            USER_MANAGER_NO_TEAM,
            `${PREFIX}mgr-a@acme.test`,
            `${PREFIX}emp-a@acme.test`,
            `${PREFIX}emp-b@acme.test`,
            `${PREFIX}viewer@acme.test`,
            `${PREFIX}mgr-noteam@acme.test`,
        ],
    );

    await app.withOrgContext(ORG_ACME, async (client) => {
        await client.query(
            `INSERT INTO teams (id, org_id, name)
             VALUES ($1, $3, $4), ($2, $3, $5)
             ON CONFLICT (id) DO NOTHING`,
            [
                TEAM_A_ID,
                TEAM_B_ID,
                ORG_ACME,
                `${PREFIX}team-a`,
                `${PREFIX}team-b`,
            ],
        );
        await client.query(
            `INSERT INTO memberships (org_id, user_id, role, team_id, status)
             VALUES
                ($1, $2, 'manager',  $7, 'active'),
                ($1, $3, 'employee', $7, 'active'),
                ($1, $4, 'employee', $8, 'active'),
                ($1, $5, 'viewer',   NULL, 'active'),
                ($1, $6, 'manager',  NULL, 'active')
             ON CONFLICT (org_id, user_id) DO NOTHING`,
            [
                ORG_ACME,
                USER_MANAGER_TEAM_A,
                USER_EMPLOYEE_TEAM_A,
                USER_EMPLOYEE_TEAM_B,
                USER_VIEWER_NO_TEAM,
                USER_MANAGER_NO_TEAM,
                TEAM_A_ID,
                TEAM_B_ID,
            ],
        );

        const m = await client.query(
            `SELECT id, user_id, role FROM memberships
              WHERE user_id = ANY($1::uuid[])`,
            [[
                USER_MANAGER_TEAM_A,
                USER_EMPLOYEE_TEAM_A,
                USER_EMPLOYEE_TEAM_B,
                USER_VIEWER_NO_TEAM,
                USER_MANAGER_NO_TEAM,
            ]],
        );
        MEMBERSHIP_BY_USER.clear();
        for (const row of m.rows) {
            MEMBERSHIP_BY_USER.set(row.user_id, { id: row.id, role: row.role });
        }
    });
}

export async function destroyFixtureUsers(app) {
    await app.withOrgContext(ORG_ACME, async (client) => {
        await client.query(
            `DELETE FROM memberships WHERE user_id = ANY($1::uuid[])`,
            [[
                USER_MANAGER_TEAM_A,
                USER_EMPLOYEE_TEAM_A,
                USER_EMPLOYEE_TEAM_B,
                USER_VIEWER_NO_TEAM,
                USER_MANAGER_NO_TEAM,
            ]],
        );
        await client.query(
            `DELETE FROM teams WHERE id = ANY($1::uuid[])`,
            [[TEAM_A_ID, TEAM_B_ID]],
        );
    });
    await app.pg.query(
        `DELETE FROM users WHERE id = ANY($1::uuid[])`,
        [[
            USER_MANAGER_TEAM_A,
            USER_EMPLOYEE_TEAM_A,
            USER_EMPLOYEE_TEAM_B,
            USER_VIEWER_NO_TEAM,
            USER_MANAGER_NO_TEAM,
        ]],
    );
}

// Map well-known user keys to {id, role, membershipId, orgId}. The
// seed users (acmeAdmin / acmeEmp / betaAdmin / betaEmp) read their
// memberships from the seed-known UUIDs. The phase5test users come
// from MEMBERSHIP_BY_USER, populated by createFixtureUsers().
export function actorFor(userKey) {
    switch (userKey) {
        case "acmeAdmin":
            return {
                id: USER_ACME_ADMIN,
                role: "admin",
                membershipId: MEMBERSHIP_ACME_ADMIN,
                orgId: ORG_ACME,
            };
        case "acmeEmp":
            return {
                id: USER_ACME_EMP,
                role: "employee",
                membershipId: MEMBERSHIP_ACME_EMP,
                orgId: ORG_ACME,
            };
        case "betaAdmin":
            // membership id resolved at runtime — seed defines it but
            // tests rarely need it directly. Re-query if needed.
            return {
                id: USER_BETA_ADMIN,
                role: "admin",
                membershipId: "dddddddd-0001-0001-0001-dddddddddddd",
                orgId: ORG_BETA,
            };
        case "betaEmp":
            return {
                id: USER_BETA_EMP,
                role: "employee",
                membershipId: "dddddddd-0002-0002-0002-dddddddddddd",
                orgId: ORG_BETA,
            };
        case "managerTeamA":
        case "employeeTeamA":
        case "employeeTeamB":
        case "viewerNoTeam":
        case "managerNoTeam": {
            const userId = {
                managerTeamA: USER_MANAGER_TEAM_A,
                employeeTeamA: USER_EMPLOYEE_TEAM_A,
                employeeTeamB: USER_EMPLOYEE_TEAM_B,
                viewerNoTeam: USER_VIEWER_NO_TEAM,
                managerNoTeam: USER_MANAGER_NO_TEAM,
            }[userKey];
            const m = MEMBERSHIP_BY_USER.get(userId);
            if (!m) {
                throw new Error(
                    `actorFor(${userKey}): membership not resolved — did you call createFixtureUsers?`,
                );
            }
            return {
                id: userId,
                role: m.role,
                membershipId: m.id,
                orgId: ORG_ACME,
            };
        }
        default:
            throw new Error(`actorFor: unknown user key '${userKey}'`);
    }
}

// Mint an access token for the given user key. requireFreshRole reads
// memberships.role and compares against the JWT's role, so this must
// reflect the live row.
export function mintToken(app, userKey) {
    const actor = actorFor(userKey);
    const payload = {
        sub: actor.id,
        orgId: actor.orgId,
        membershipId: actor.membershipId,
        role: actor.role,
        sid: randomUUID(),
    };
    return app.jwt.sign(payload);
}

export function authedInject(app, token, opts) {
    return app.inject({
        ...opts,
        headers: {
            ...(opts.headers || {}),
            authorization: `Bearer ${token}`,
        },
    });
}

// Insert a call directly into the DB without going through routes. Useful
// when a test needs to set agent_user_id, last_seen_at, started_at, or
// duration_seconds precisely. Phase 7 Step 7 wires duration_seconds /
// ended_at through so aggregate-metric tests (avg_duration_seconds)
// can verify the SQL math instead of silently AVG'ing over nulls.
export async function insertCallRaw(app, orgId, fields = {}) {
    return app.withOrgContext(orgId, async (client) => {
        const r = await client.query(
            `INSERT INTO calls (
                org_id, customer_id, agent_user_id, direction, status, title,
                started_at, last_seen_at, ended_at, duration_seconds,
                summary, summary_source
             ) VALUES ($1, $2, $3, $4, COALESCE($5,'in_progress'), $6, $7, $8, $9, $10, $11, $12)
             RETURNING *`,
            [
                orgId,
                fields.customer_id ?? null,
                fields.agent_user_id ?? null,
                fields.direction ?? "inbound",
                fields.status ?? null,
                fields.title ?? `${PREFIX}default`,
                fields.started_at ?? new Date(),
                fields.last_seen_at ?? null,
                fields.ended_at ?? null,
                fields.duration_seconds ?? null,
                fields.summary ?? null,
                fields.summary_source ?? null,
            ],
        );
        return r.rows[0];
    });
}

export const FIXTURE_PREFIX = PREFIX;

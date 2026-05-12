/* Phase 5 Step 2 — service tests: permission helper + transaction glue.
 *
 * Step 2 plan §6.3 contracts:
 *   - assertCanMutateCall(admin/manager/employee/viewer × ownership×team)
 *   - checklist mark / suggestion use+dismiss / customer link / manual
 *     summary all go through assertCanMutateCall
 *   - AI summary cannot overwrite summary_source='manual'
 *   - heartbeat sweep ignores ended/missed/dropped
 *   - withOrgContext rolls back inner failures (re-using existing endCall
 *     atomicity coverage is not required — we test the new helpers).
 *
 * Test users:
 *   The 4 seeded users (admin@acme, emp@acme, admin@beta, emp@beta) have
 *   admin / employee / admin / employee roles. To exercise manager team
 *   scope we mint 4 ephemeral phase5test users + 2 teams in Acme. After
 *   the suite we DELETE the ephemeral memberships, teams, and users —
 *   but never the seeded rows.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import dbPlugin from "../src/plugins/db.js";
import * as calls from "../src/repositories/calls.js";
import * as itemsRepo from "../src/repositories/callChecklistItems.js";
import * as templatesRepo from "../src/repositories/callChecklistTemplates.js";
import * as suggestionsRepo from "../src/repositories/callSuggestions.js";
import {
    assertCanMutateCall,
    PermissionError,
} from "../src/services/callPermissions.js";
import * as callChecklistService from "../src/services/callChecklist.js";
import * as callSuggestionService from "../src/services/callSuggestions.js";
import * as customerLinkageService from "../src/services/customerLinkage.js";
import * as callSummaryService from "../src/services/callSummary.js";
import * as callHeartbeatService from "../src/services/callHeartbeat.js";
import { SuggestionStateError } from "../src/services/callSuggestions.js";

const ORG_ACME = "11111111-1111-1111-1111-111111111111";
const ORG_BETA = "22222222-2222-2222-2222-222222222222";

const USER_ACME_ADMIN = "aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa";
const USER_ACME_EMP   = "aaaaaaaa-0002-0002-0002-aaaaaaaaaaaa";

const CUSTOMER_ACME_KIM  = "eeeeeeee-1111-0001-0001-eeeeeeeeeeee";
const CUSTOMER_BETA_JUNG = "ffffffff-2222-0001-0001-ffffffffffff";

const PREFIX = "phase5test-";

// Ephemeral test users created in setup. Keep IDs stable so cleanup is
// idempotent across re-runs (ON CONFLICT in seed pattern).
const TEAM_A_ID                  = "99990001-aaaa-aaaa-aaaa-000000000001";
const TEAM_B_ID                  = "99990001-aaaa-aaaa-aaaa-000000000002";
const USER_MANAGER_TEAM_A        = "99990002-aaaa-aaaa-aaaa-000000000001";
const USER_EMPLOYEE_TEAM_A       = "99990002-aaaa-aaaa-aaaa-000000000002";
const USER_EMPLOYEE_TEAM_B       = "99990002-aaaa-aaaa-aaaa-000000000003";
const USER_VIEWER_NO_TEAM        = "99990002-aaaa-aaaa-aaaa-000000000004";
const USER_MANAGER_NO_TEAM       = "99990002-aaaa-aaaa-aaaa-000000000005";

let app;

before(async () => {
    app = Fastify({ logger: false });
    await app.register(dbPlugin);

    // Seed phase5test users + teams + memberships. All in Acme.
    // Done outside withOrgContext via app.pg because the runtime app role
    // cannot bypass RLS to insert into users — but inserts into orgs-only
    // tables that need RLS go through withOrgContext.
    //
    // users table has no RLS, so a bare-pool INSERT is fine. Same for the
    // (org_id, ...) tables — we set the GUC via withOrgContext.
    await app.pg.query(
        `INSERT INTO users (id, email, password_hash, name)
         VALUES
            ($1, $6, 'phase5test-pwd', 'phase5test-mgr-a'),
            ($2, $7, 'phase5test-pwd', 'phase5test-emp-a'),
            ($3, $8, 'phase5test-pwd', 'phase5test-emp-b'),
            ($4, $9, 'phase5test-pwd', 'phase5test-viewer'),
            ($5, $10,'phase5test-pwd', 'phase5test-mgr-noteam')
         ON CONFLICT (id) DO NOTHING`,
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
    });
});

after(async () => {
    // child rows first — same prefix sweep as repositories suite.
    for (const orgId of [ORG_ACME, ORG_BETA]) {
        await app.withOrgContext(orgId, async (client) => {
            await client.query(
                `DELETE FROM call_suggestions WHERE title LIKE $1`,
                [`${PREFIX}%`],
            );
            await client.query(
                `DELETE FROM call_checklist_items
                   WHERE call_id IN (SELECT id FROM calls WHERE title LIKE $1)`,
                [`${PREFIX}%`],
            );
            await client.query(
                `DELETE FROM transcripts
                   WHERE call_id IN (SELECT id FROM calls WHERE title LIKE $1)`,
                [`${PREFIX}%`],
            );
            await client.query(
                `DELETE FROM calls WHERE title LIKE $1`,
                [`${PREFIX}%`],
            );
            await client.query(
                `DELETE FROM org_call_checklist_templates WHERE title LIKE $1`,
                [`${PREFIX}%`],
            );
        });
    }
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
    await app.close();
});

// ---------- helpers ---------- //

async function insertCallRaw(orgId, fields = {}) {
    return app.withOrgContext(orgId, async (client) => {
        const r = await client.query(
            `INSERT INTO calls (
                org_id, customer_id, agent_user_id, direction, status, title,
                started_at, last_seen_at
             ) VALUES ($1, $2, $3, $4, COALESCE($5,'in_progress'), $6, $7, $8)
             RETURNING id, agent_user_id, status, started_at, last_seen_at`,
            [
                orgId,
                fields.customer_id ?? null,
                fields.agent_user_id ?? null,
                fields.direction ?? "inbound",
                fields.status ?? null,
                fields.title ?? `${PREFIX}svc-default`,
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

// =============================================================
//                    PERMISSION HELPER
// =============================================================

test("admin can mutate any same-org call", async () => {
    const call = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}perm-admin`,
        agent_user_id: USER_EMPLOYEE_TEAM_B,
    });
    try {
        await app.withOrgContext(ORG_ACME, async (client) => {
            await assertCanMutateCall(
                client,
                { id: USER_ACME_ADMIN, orgId: ORG_ACME, role: "admin" },
                { agent_user_id: call.agent_user_id },
            );
        });
        // No throw = pass.
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

test("viewer cannot mutate", async () => {
    await app.withOrgContext(ORG_ACME, async (client) => {
        await assert.rejects(
            assertCanMutateCall(
                client,
                { id: USER_VIEWER_NO_TEAM, orgId: ORG_ACME, role: "viewer" },
                { agent_user_id: USER_ACME_ADMIN },
            ),
            (err) => err instanceof PermissionError,
        );
    });
});

test("employee can mutate own call but not another agent's", async () => {
    const ownCall = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}perm-emp-own`,
        agent_user_id: USER_ACME_EMP,
    });
    const otherCall = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}perm-emp-other`,
        agent_user_id: USER_ACME_ADMIN,
    });
    try {
        await app.withOrgContext(ORG_ACME, async (client) => {
            await assertCanMutateCall(
                client,
                { id: USER_ACME_EMP, orgId: ORG_ACME, role: "employee" },
                { agent_user_id: ownCall.agent_user_id },
            );
            await assert.rejects(
                assertCanMutateCall(
                    client,
                    { id: USER_ACME_EMP, orgId: ORG_ACME, role: "employee" },
                    { agent_user_id: otherCall.agent_user_id },
                ),
                (err) => err instanceof PermissionError,
            );
        });
    } finally {
        await hardDeleteCall(ORG_ACME, ownCall.id);
        await hardDeleteCall(ORG_ACME, otherCall.id);
    }
});

test("manager same-team can mutate; different-team and unassigned denied", async () => {
    const sameTeamCall = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}perm-mgr-same`,
        agent_user_id: USER_EMPLOYEE_TEAM_A,
    });
    const otherTeamCall = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}perm-mgr-other`,
        agent_user_id: USER_EMPLOYEE_TEAM_B,
    });
    const unassignedCall = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}perm-mgr-unass`,
    });
    try {
        await app.withOrgContext(ORG_ACME, async (client) => {
            await assertCanMutateCall(
                client,
                {
                    id: USER_MANAGER_TEAM_A,
                    orgId: ORG_ACME,
                    role: "manager",
                },
                { agent_user_id: sameTeamCall.agent_user_id },
            );
            await assert.rejects(
                assertCanMutateCall(
                    client,
                    {
                        id: USER_MANAGER_TEAM_A,
                        orgId: ORG_ACME,
                        role: "manager",
                    },
                    { agent_user_id: otherTeamCall.agent_user_id },
                ),
                (err) => err instanceof PermissionError,
            );
            await assert.rejects(
                assertCanMutateCall(
                    client,
                    {
                        id: USER_MANAGER_TEAM_A,
                        orgId: ORG_ACME,
                        role: "manager",
                    },
                    { agent_user_id: null },
                ),
                (err) => err instanceof PermissionError,
            );
        });
    } finally {
        await hardDeleteCall(ORG_ACME, sameTeamCall.id);
        await hardDeleteCall(ORG_ACME, otherTeamCall.id);
        await hardDeleteCall(ORG_ACME, unassignedCall.id);
    }
});

test("manager with NULL team_id cannot mutate anyone else's call", async () => {
    const someoneElse = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}perm-mgr-null`,
        agent_user_id: USER_EMPLOYEE_TEAM_A,
    });
    try {
        await app.withOrgContext(ORG_ACME, async (client) => {
            await assert.rejects(
                assertCanMutateCall(
                    client,
                    {
                        id: USER_MANAGER_NO_TEAM,
                        orgId: ORG_ACME,
                        role: "manager",
                    },
                    { agent_user_id: someoneElse.agent_user_id },
                ),
                (err) => err instanceof PermissionError,
            );
        });
    } finally {
        await hardDeleteCall(ORG_ACME, someoneElse.id);
    }
});

// =============================================================
//                    SERVICE TRANSACTIONS
// =============================================================

test("markChecklistItem enforces permission helper", async () => {
    const tmpl = await app.withOrgContext(ORG_ACME, (client) =>
        templatesRepo.insertInCurrentOrg(client, ORG_ACME, {
            title: `${PREFIX}svc-tmpl`,
        }),
    );
    const call = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}svc-check`,
        agent_user_id: USER_EMPLOYEE_TEAM_A,
    });
    try {
        const inited = await app.withOrgContext(ORG_ACME, (client) =>
            itemsRepo.initializeForCallInCurrentOrg(client, call.id),
        );
        const mine = inited.find((it) => it.template_id === tmpl.id);
        assert.ok(mine);

        // employee NOT owning the call is denied
        await assert.rejects(
            callChecklistService.markChecklistItem(
                app,
                { id: USER_ACME_EMP, orgId: ORG_ACME, role: "employee" },
                mine.id,
                "done",
            ),
            (err) => err instanceof PermissionError,
        );

        // manager same team is allowed
        const done = await callChecklistService.markChecklistItem(
            app,
            { id: USER_MANAGER_TEAM_A, orgId: ORG_ACME, role: "manager" },
            mine.id,
            "done",
        );
        assert.ok(done);
        assert.equal(done.status, "done");
        assert.equal(done.checked_by_user_id, USER_MANAGER_TEAM_A);
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

test("useSuggestion / dismissSuggestion enforce permission and refuse double-action", async () => {
    const call = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}svc-sugg`,
        agent_user_id: USER_EMPLOYEE_TEAM_A,
    });
    try {
        const inserted = await app.withOrgContext(ORG_ACME, (client) =>
            suggestionsRepo.insertGroupForCallInCurrentOrg(client, call.id, [
                {
                    group_seq: 0,
                    at_ms: 0,
                    tone: "blue",
                    type: "direction",
                    title: `${PREFIX}svc-sugg-1`,
                },
                {
                    group_seq: 0,
                    at_ms: 0,
                    tone: "amber",
                    type: "alert",
                    title: `${PREFIX}svc-sugg-2`,
                },
            ]),
        );
        const [a, b] = inserted;

        // employee not owning → denied
        await assert.rejects(
            callSuggestionService.useSuggestion(
                app,
                { id: USER_ACME_EMP, orgId: ORG_ACME, role: "employee" },
                a.id,
            ),
            (err) => err instanceof PermissionError,
        );

        // manager same team can use
        const used = await callSuggestionService.useSuggestion(
            app,
            { id: USER_MANAGER_TEAM_A, orgId: ORG_ACME, role: "manager" },
            a.id,
        );
        assert.ok(used);
        assert.ok(used.used_at instanceof Date);

        // re-use after use → SuggestionStateError
        await assert.rejects(
            callSuggestionService.useSuggestion(
                app,
                { id: USER_MANAGER_TEAM_A, orgId: ORG_ACME, role: "manager" },
                a.id,
            ),
            (err) => err instanceof SuggestionStateError,
        );

        // dismiss the other one, then try to use it → state conflict
        await callSuggestionService.dismissSuggestion(
            app,
            { id: USER_MANAGER_TEAM_A, orgId: ORG_ACME, role: "manager" },
            b.id,
        );
        await assert.rejects(
            callSuggestionService.useSuggestion(
                app,
                { id: USER_MANAGER_TEAM_A, orgId: ORG_ACME, role: "manager" },
                b.id,
            ),
            (err) => err instanceof SuggestionStateError,
        );
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

test("linkCustomerToCall enforces permission; rejects wrong-org customer", async () => {
    const call = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}svc-link`,
        agent_user_id: USER_EMPLOYEE_TEAM_A,
    });
    try {
        // employee not owning → denied
        await assert.rejects(
            customerLinkageService.linkCustomerToCall(
                app,
                { id: USER_ACME_EMP, orgId: ORG_ACME, role: "employee" },
                call.id,
                CUSTOMER_ACME_KIM,
            ),
            (err) => err instanceof PermissionError,
        );

        // manager same team can link same-org customer
        const linked = await customerLinkageService.linkCustomerToCall(
            app,
            { id: USER_MANAGER_TEAM_A, orgId: ORG_ACME, role: "manager" },
            call.id,
            CUSTOMER_ACME_KIM,
        );
        assert.ok(linked);
        assert.equal(linked.customer_id, CUSTOMER_ACME_KIM);

        // wrong-org customer → 23503 surfaces from FK
        await assert.rejects(
            customerLinkageService.linkCustomerToCall(
                app,
                { id: USER_MANAGER_TEAM_A, orgId: ORG_ACME, role: "manager" },
                call.id,
                CUSTOMER_BETA_JUNG,
            ),
            (err) => err.code === "23503",
        );
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

test("applyManualSummary enforces permission; AI cannot overwrite manual", async () => {
    const call = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}svc-summary`,
        agent_user_id: USER_EMPLOYEE_TEAM_A,
    });
    try {
        // employee not owning → denied
        await assert.rejects(
            callSummaryService.applyManualSummary(
                app,
                { id: USER_ACME_EMP, orgId: ORG_ACME, role: "employee" },
                call.id,
                {
                    summary: "should not happen",
                    needs: null,
                    issues: null,
                    sentiment: null,
                },
            ),
            (err) => err instanceof PermissionError,
        );

        // manager writes manual summary
        const manual = await callSummaryService.applyManualSummary(
            app,
            { id: USER_MANAGER_TEAM_A, orgId: ORG_ACME, role: "manager" },
            call.id,
            {
                summary: "manual edit by manager",
                needs: null,
                issues: null,
                sentiment: "neutral",
            },
        );
        assert.equal(manual.summary_source, "manual");

        // AI worker push is no-op (returns null) because source='manual'
        const aiResult = await callSummaryService.applyAiSummary(
            app,
            ORG_ACME,
            call.id,
            {
                summary: "ai trying to overwrite",
                needs: null,
                issues: null,
                sentiment: "positive",
            },
        );
        assert.equal(aiResult, null);

        const reread = await app.withOrgContext(ORG_ACME, (client) =>
            calls.getByIdInCurrentOrg(client, call.id),
        );
        assert.equal(reread.summary, "manual edit by manager");
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

test("heartbeat service ignores ended/missed/dropped calls", async () => {
    const live = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}svc-hb-live`,
        status: "in_progress",
    });
    const ended = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}svc-hb-ended`,
        status: "ended",
    });
    const missed = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}svc-hb-missed`,
        status: "missed",
    });
    const dropped = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}svc-hb-dropped`,
        status: "dropped",
    });
    try {
        const touched = await callHeartbeatService.touchCallHeartbeat(
            app,
            ORG_ACME,
            live.id,
        );
        assert.ok(touched);
        assert.ok(touched.last_seen_at instanceof Date);

        for (const id of [ended.id, missed.id, dropped.id]) {
            const r = await callHeartbeatService.touchCallHeartbeat(
                app,
                ORG_ACME,
                id,
            );
            assert.equal(r, null);
        }
    } finally {
        await hardDeleteCall(ORG_ACME, live.id);
        await hardDeleteCall(ORG_ACME, ended.id);
        await hardDeleteCall(ORG_ACME, missed.id);
        await hardDeleteCall(ORG_ACME, dropped.id);
    }
});

test("markTimedOutCallsDropped: dropped calls have ended_at + duration_seconds set", async () => {
    const startedAt = new Date(Date.now() - 5 * 60_000);
    const past = new Date(Date.now() - 2 * 60_000);
    const stale = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}svc-sweep`,
        status: "in_progress",
        started_at: startedAt,
        last_seen_at: past,
    });
    try {
        const cutoff = new Date(Date.now() - 60_000);
        const droppedAt = new Date();
        const n = await callHeartbeatService.markTimedOutCallsDropped(
            app,
            ORG_ACME,
            cutoff,
            droppedAt,
        );
        assert.ok(n >= 1);

        const after = await app.withOrgContext(ORG_ACME, (client) =>
            calls.getByIdInCurrentOrg(client, stale.id),
        );
        assert.equal(after.status, "dropped");
        assert.equal(after.dropped_reason, "server_timeout");
        assert.ok(after.ended_at instanceof Date);
        assert.ok(
            after.duration_seconds !== null && after.duration_seconds >= 0,
            `expected duration_seconds >= 0, got ${after.duration_seconds}`,
        );
    } finally {
        await hardDeleteCall(ORG_ACME, stale.id);
    }
});

test("withOrgContext rolls back on inner failure (no partial write)", async () => {
    const call = await insertCallRaw(ORG_ACME, {
        title: `${PREFIX}svc-rollback`,
        agent_user_id: USER_ACME_ADMIN,
    });
    try {
        const probeNotes = `${PREFIX}rollback-notes-${randomUUID()}`;
        await assert.rejects(
            app.withOrgContext(ORG_ACME, async (client) => {
                await client.query(
                    `UPDATE calls SET notes = $1 WHERE id = $2`,
                    [probeNotes, call.id],
                );
                throw new Error("phase5test-force-rollback");
            }),
            (err) => err.message === "phase5test-force-rollback",
        );

        const reread = await app.withOrgContext(ORG_ACME, (client) =>
            calls.getByIdInCurrentOrg(client, call.id),
        );
        assert.notEqual(
            reread.notes,
            probeNotes,
            "rollback should have discarded the notes write",
        );
    } finally {
        await hardDeleteCall(ORG_ACME, call.id);
    }
});

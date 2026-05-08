/* orgContext middleware — Phase 1 Step 2 §7.
 *
 * Lives under server/test/ so node_modules resolution finds fastify et al.
 * directly. Run via tsx so the .ts source imports resolve:
 *
 *   cd server && npx tsx --test test/orgContext.test.mjs
 *
 * Three contracts:
 *   - missing X-Org-Id           → 401
 *   - present but not a UUID     → 400
 *   - valid UUID                 → handler runs, request.orgId is set
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { orgContext } from "../src/middleware/orgContext.js";

function buildApp() {
    const app = Fastify({ logger: false });
    app.addHook("preHandler", orgContext);
    app.get("/probe", async (request) => ({ orgId: request.orgId }));
    return app;
}

test("missing X-Org-Id → 401", async () => {
    const app = buildApp();
    const r = await app.inject({ method: "GET", url: "/probe" });
    assert.equal(r.statusCode, 401);
    assert.deepEqual(r.json(), { error: "missing X-Org-Id" });
    await app.close();
});

test("malformed X-Org-Id → 400", async () => {
    const app = buildApp();
    const cases = ["", "not-a-uuid", "11111111-1111-1111-1111", "'; DROP TABLE x;--"];
    for (const value of cases) {
        const r = await app.inject({
            method: "GET",
            url: "/probe",
            headers: { "x-org-id": value },
        });
        // Empty header is treated as missing → 401 (header undefined). Bad
        // format strings → 400. Both are "rejection at the edge".
        if (value === "") {
            assert.equal(r.statusCode, 401, `empty header: ${value}`);
        } else {
            assert.equal(r.statusCode, 400, `case: ${value}`);
            assert.equal(r.json().error, "X-Org-Id is not a valid UUID");
        }
    }
    await app.close();
});

test("valid UUID → 200, request.orgId is the same value", async () => {
    const app = buildApp();
    const orgId = "11111111-1111-1111-1111-111111111111";
    const r = await app.inject({
        method: "GET",
        url: "/probe",
        headers: { "x-org-id": orgId },
    });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { orgId });
    await app.close();
});

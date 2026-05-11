/* Auth tokens service tests — Phase 3 Step 2 §10.
 *
 * Covers the low-level service (mintToken / invalidateActiveTokens /
 * consumeToken) and the transactional invariant the verify wrapper relies on
 * (consumeToken participates in the caller's transaction, so a ROLLBACK
 * undoes consumed_at).
 *
 * Pre-req: docker compose up + migrate (through 0008) + init/02_service_role.sql
 * applied. server/.env has SERVICE_DATABASE_URL set.
 *
 * Run:  cd server && npm test
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import { pool } from "../src/db/pool.js";
import { getServicePool, closeServicePool } from "../src/db/servicePool.js";
import {
    consumeToken,
    invalidateActiveTokens,
    mintToken,
    sha256Hex,
    TTL_EMAIL_VERIFICATION_MS,
} from "../src/services/auth-tokens.js";
import { AuthError } from "../src/services/auth.js";

const ACME_ID  = "11111111-1111-1111-1111-111111111111";
const ACME_EMP = "aaaaaaaa-0002-0002-0002-aaaaaaaaaaaa";

/** Mint a fresh email_verification token for the seeded Acme employee.
 *  Returns { rawToken, tokenId } so the caller can drive subsequent
 *  consume / invalidate / re-mint scenarios. */
async function mintForAcmeEmp(overrides = {}) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.org_id', $1, true)", [ACME_ID]);
        const result = await mintToken({
            client,
            orgId:    ACME_ID,
            userId:   ACME_EMP,
            purpose:  "email_verification",
            ttlMs:    TTL_EMAIL_VERIFICATION_MS,
            ...overrides,
        });
        await client.query("COMMIT");
        return result;
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

after(async () => {
    await closeServicePool();
    await pool.end();
});

afterEach(async () => {
    // Mark every active row left over from the test as invalidated. This
    // sidesteps the UNIQUE partial (auth_tokens_user_purpose_active_idx)
    // so the next test's mintToken succeeds. We don't DELETE because the
    // runtime service role intentionally lacks DELETE on auth_tokens —
    // adding that grant just for tests would widen the BYPASSRLS surface
    // for no runtime benefit. UPDATE is granted; invalidate is identical
    // to a DELETE for the UNIQUE partial's purposes.
    await getServicePool().query(
        `UPDATE auth_tokens
            SET invalidated_at = now()
          WHERE user_id        = $1
            AND purpose        = 'email_verification'
            AND consumed_at    IS NULL
            AND invalidated_at IS NULL`,
        [ACME_EMP],
    );
    // Reset email_verified_at if a test set it. users is not RLS-scoped.
    await pool.query(
        `UPDATE users SET email_verified_at = NULL WHERE id = $1`,
        [ACME_EMP],
    );
});

// ------------------------------------------------------------------ //
// mintToken
// ------------------------------------------------------------------ //

test("mintToken stores sha256(raw) only — raw not in DB", async () => {
    const { rawToken, tokenId } = await mintForAcmeEmp();
    const expectedHash = sha256Hex(rawToken);
    // auth_tokens has FORCE RLS — read back via servicePool (BYPASSRLS) so
    // we don't need to drag a GUC into every assertion.
    const r = await getServicePool().query(
        `SELECT token_hash FROM auth_tokens WHERE id = $1`,
        [tokenId],
    );
    assert.equal(r.rows[0].token_hash, expectedHash);
    assert.notEqual(r.rows[0].token_hash, rawToken);

    // Also: no auth_tokens row contains the raw token in any column.
    const leak = await getServicePool().query(
        `SELECT 1 FROM auth_tokens WHERE token_hash = $1 OR id::text = $1 LIMIT 1`,
        [rawToken],
    );
    assert.equal(leak.rows.length, 0, "raw token must not appear in any column");
});

test("mintToken twice for same (user, purpose) without invalidate → 23505", async () => {
    await mintForAcmeEmp();
    let err = null;
    try {
        await mintForAcmeEmp();
    } catch (e) {
        err = e;
    }
    assert.ok(err, "second mint should fail");
    assert.equal(err.code, "23505",
        "expected unique violation on auth_tokens_user_purpose_active_idx");
});

test("invalidateActiveTokens then mintToken → both rows coexist (old invalidated)", async () => {
    const first = await mintForAcmeEmp();

    // Invalidate inside its own transaction.
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.org_id', $1, true)", [ACME_ID]);
        const touched = await invalidateActiveTokens({
            client,
            userId:  ACME_EMP,
            purpose: "email_verification",
        });
        await client.query("COMMIT");
        assert.equal(touched, 1, "invalidate should touch exactly one row");
    } finally {
        client.release();
    }

    const second = await mintForAcmeEmp();
    assert.notEqual(first.tokenId, second.tokenId);

    // Scope to the two IDs we just minted — afterEach invalidates but does
    // not DELETE leftover rows (runtime service role intentionally lacks
    // DELETE on auth_tokens, see afterEach comment), so prior runs may
    // leave invalidated rows for the same seeded user in the table.
    const both = await getServicePool().query(
        `SELECT id, consumed_at, invalidated_at
           FROM auth_tokens WHERE id IN ($1, $2)
          ORDER BY created_at`,
        [first.tokenId, second.tokenId],
    );
    assert.equal(both.rows.length, 2);
    assert.ok(both.rows[0].invalidated_at, "first row should be invalidated");
    assert.equal(both.rows[1].invalidated_at, null, "second row stays active");
});

// ------------------------------------------------------------------ //
// consumeToken
// ------------------------------------------------------------------ //

test("consumeToken happy path → returns row + sets consumed_at", async () => {
    const { rawToken, tokenId } = await mintForAcmeEmp();

    const svc = getServicePool();
    const client = await svc.connect();
    try {
        await client.query("BEGIN");
        const consumed = await consumeToken(client, rawToken, "email_verification");
        await client.query("COMMIT");
        assert.equal(consumed.id, tokenId);
        assert.equal(consumed.userId, ACME_EMP);
        assert.equal(consumed.orgId, ACME_ID);
    } finally {
        client.release();
    }

    const r = await getServicePool().query(
        `SELECT consumed_at FROM auth_tokens WHERE id = $1`, [tokenId],
    );
    assert.ok(r.rows[0].consumed_at, "consumed_at should be set");
});

test("consumeToken second time → 410 token_already_used", async () => {
    const { rawToken } = await mintForAcmeEmp();
    const svc = getServicePool();

    // First consume — commit.
    await runInServiceTx(async (c) => {
        await consumeToken(c, rawToken, "email_verification");
    });

    // Second consume — expect AuthError(410 token_already_used).
    let err = null;
    try {
        await runInServiceTx(async (c) => {
            await consumeToken(c, rawToken, "email_verification");
        });
    } catch (e) {
        err = e;
    }
    assert.ok(err instanceof AuthError, "should throw AuthError");
    assert.equal(err.statusCode, 410);
    assert.equal(err.code, "token_already_used");
});

test("consumeToken invalidated token → 410 token_invalidated", async () => {
    const { rawToken, tokenId } = await mintForAcmeEmp();
    await getServicePool().query(
        `UPDATE auth_tokens SET invalidated_at = now() WHERE id = $1`,
        [tokenId],
    );

    let err = null;
    try {
        await runInServiceTx(async (c) => {
            await consumeToken(c, rawToken, "email_verification");
        });
    } catch (e) {
        err = e;
    }
    assert.ok(err instanceof AuthError);
    assert.equal(err.code, "token_invalidated");
});

test("consumeToken expired token → 410 token_expired", async () => {
    const { rawToken, tokenId } = await mintForAcmeEmp();
    await getServicePool().query(
        `UPDATE auth_tokens SET expires_at = now() - interval '1 minute' WHERE id = $1`,
        [tokenId],
    );

    let err = null;
    try {
        await runInServiceTx(async (c) => {
            await consumeToken(c, rawToken, "email_verification");
        });
    } catch (e) {
        err = e;
    }
    assert.ok(err instanceof AuthError);
    assert.equal(err.code, "token_expired");
});

test("consumeToken with unknown hash → 404 token_not_found", async () => {
    let err = null;
    try {
        await runInServiceTx(async (c) => {
            await consumeToken(c, "not-a-real-token", "email_verification");
        });
    } catch (e) {
        err = e;
    }
    assert.ok(err instanceof AuthError);
    assert.equal(err.statusCode, 404);
    assert.equal(err.code, "token_not_found");
});

test("consumeToken participates in caller's transaction — ROLLBACK undoes consumed_at", async () => {
    const { rawToken, tokenId } = await mintForAcmeEmp();
    const svc = getServicePool();
    const client = await svc.connect();
    try {
        await client.query("BEGIN");
        await consumeToken(client, rawToken, "email_verification");
        // Caller rolls back instead of committing — simulating verifyEmail's
        // catch path when the downstream user UPDATE fails.
        await client.query("ROLLBACK");
    } finally {
        client.release();
    }

    const r = await getServicePool().query(
        `SELECT consumed_at FROM auth_tokens WHERE id = $1`, [tokenId],
    );
    assert.equal(r.rows[0].consumed_at, null,
        "consumed_at must be NULL after caller ROLLBACK");

    // And the token is still consumable — re-run the happy path.
    await runInServiceTx(async (c) => {
        const consumed = await consumeToken(c, rawToken, "email_verification");
        assert.equal(consumed.id, tokenId);
    });
});

// ------------------------------------------------------------------ //
// servicePool BYPASSRLS smoke test
// ------------------------------------------------------------------ //

test("servicePool selects auth_tokens without app.org_id GUC", async () => {
    await mintForAcmeEmp();
    const svc = getServicePool();
    const r = await svc.query(
        `SELECT count(*)::int AS n FROM auth_tokens WHERE user_id = $1`,
        [ACME_EMP],
    );
    assert.ok(r.rows[0].n >= 1,
        "service role should see the token without any GUC set");
});

// ------------------------------------------------------------------ //
// Helpers
// ------------------------------------------------------------------ //

async function runInServiceTx(fn) {
    const svc = getServicePool();
    const client = await svc.connect();
    try {
        await client.query("BEGIN");
        await fn(client);
        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

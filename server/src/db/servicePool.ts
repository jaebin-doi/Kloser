/* Service-role connection pool — BYPASSRLS, anonymous endpoints only.
 *
 * Phase 3 Step 2. Plan: docs/plan/phase-3/PHASE_3_STEP_2_SIGNUP_VERIFY.md §2.
 *
 * Used by three anonymous endpoints whose only server-side identity is a
 * raw token bearer:
 *
 *   POST /auth/verify            (Step 2)
 *   POST /auth/password/reset    (Step 3)
 *   POST /invitations/accept     (Step 5)
 *
 * Anonymous /auth/password/forgot does NOT use this pool — it looks the
 * user up by email, derives org_id from their active membership, and runs
 * under the regular app pool + setOrgContext pattern. The plan §1 Pool
 * usage table is the authoritative list.
 *
 * NEVER imported by:
 *   - routes/* directly
 *   - any authenticated service path (those use pool + withOrgContext)
 *   - migrations (those use MIGRATE_DATABASE_URL)
 *
 * Code review rule: a new import of this module requires explicit sign-off.
 *
 * Lazy init — getServicePool() touches process.env only on first call. This
 * keeps existing tests (which never invoke an anonymous endpoint) free of
 * a SERVICE_DATABASE_URL requirement at boot.
 */
import { Pool, type PoolConfig } from "pg";

let _pool: Pool | null = null;

export function getServicePool(): Pool {
  if (_pool) return _pool;

  const url = process.env.SERVICE_DATABASE_URL;
  if (!url) {
    throw new Error(
      "SERVICE_DATABASE_URL is required for anonymous endpoints " +
      "(verify / password-reset / invitation-accept). Add it to server/.env " +
      "— see docs/plan/phase-3/PHASE_3_STEP_2_SIGNUP_VERIFY.md §2.",
    );
  }

  const config: PoolConfig = {
    connectionString: url,
    max: 5,                          // anonymous traffic is bursty, low-volume
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  };
  _pool = new Pool(config);
  _pool.on("error", (err) => {
    console.error("[db:service] idle client error:", err.message);
  });
  return _pool;
}

// For test teardown — drops the lazily-created pool so subsequent
// process.env mutations (or test runs) can re-init cleanly.
export async function closeServicePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

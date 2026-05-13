/* organizations repository — Phase 6 Step 1.
 *
 * `organizations` has NO row-level security and is treated as system
 * metadata. The Phase 6 workers need to enumerate all org ids so that
 * the heartbeat sweep cron can run a per-org `withOrgContext` loop.
 *
 * This module is **worker-internal**. Do not import it from
 * `server/src/routes/**` or expose it through any Fastify route. The
 * service layer also has no business reading the full org list — every
 * user-facing endpoint operates within `current_app_org_id()` and trusts
 * RLS to scope queries. Surfacing this through a public API would
 * sidestep that boundary.
 *
 * The `app` role has SELECT grant on `organizations` (init grant). The
 * worker connects with the same pool as the rest of the server so the
 * grant is honored without any role escalation.
 */
import type { PoolClient } from "pg";

export interface OrgIdRow {
  id: string;
}

export async function listAllOrgIds(client: PoolClient): Promise<string[]> {
  const r = await client.query<OrgIdRow>(
    `SELECT id FROM organizations ORDER BY id`,
  );
  return r.rows.map((row) => row.id);
}

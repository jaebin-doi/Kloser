/* Fastify plugin: DB pool + per-org transaction helper.
 *
 * Decorates the app with:
 *
 *   app.pg                                   — the runtime Pool (app role).
 *   app.withOrgContext(orgId, fn)            — open a transaction, set
 *                                              app.org_id GUC for the
 *                                              duration, run fn(client),
 *                                              commit (or roll back on
 *                                              throw), always release.
 *   app.withOrgContext(orgId, userId, fn)    — same, plus app.user_id GUC.
 *                                              Phase 5 introduced this
 *                                              overload so service helpers
 *                                              (e.g. manager team-scope
 *                                              checks) can read the actor
 *                                              id inside SQL via
 *                                              current_app_user_id().
 *
 * Routes never touch app.pg directly. They go through withOrgContext so
 * RLS is guaranteed to apply against the right org. Both GUCs are set
 * inside the transaction (set_config(..., true) = SET LOCAL semantics),
 * so a leaked client cannot carry one org's context into another request.
 */
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";

export interface WithOrgContext {
  <T>(orgId: string, fn: (client: PoolClient) => Promise<T>): Promise<T>;
  <T>(
    orgId: string,
    userId: string | null,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T>;
}

declare module "fastify" {
  interface FastifyInstance {
    pg: typeof pool;
    withOrgContext: WithOrgContext;
  }
}

const dbPlugin = fp(
  async (app: FastifyInstance) => {
    app.decorate("pg", pool);

    const withOrgContext = (async (
      orgId: string,
      userIdOrFn:
        | string
        | null
        | ((client: PoolClient) => Promise<unknown>),
      maybeFn?: (client: PoolClient) => Promise<unknown>,
    ) => {
      // Two-arg form: (orgId, fn). Three-arg form: (orgId, userId, fn).
      // userId === null means "explicitly no actor id" (e.g. background
      // sweep) — we still pick the three-arg branch but skip the GUC set.
      const isTwoArg = typeof userIdOrFn === "function";
      const userId = isTwoArg
        ? undefined
        : (userIdOrFn as string | null);
      const fn = isTwoArg
        ? (userIdOrFn as (client: PoolClient) => Promise<unknown>)
        : maybeFn!;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // set_config(..., true) is the parameterised, transaction-local
        // form of SET LOCAL. Goes through prepared-statement parameters,
        // which closes the SQL-injection vector that a string-built
        // SET LOCAL app.org_id = '...' would leave open.
        await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
        if (userId !== undefined && userId !== null) {
          await client.query("SELECT set_config('app.user_id', $1, true)", [
            userId,
          ]);
        }
        const result = await fn(client);
        await client.query("COMMIT");
        client.release();
        return result;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
          client.release();
        } catch (rollbackErr) {
          // ROLLBACK threw — the connection is in an unknown state.
          // release(truthy) tells pg to destroy this client rather than
          // returning it to the pool, so a poisoned connection can't be
          // handed to the next request.
          client.release(rollbackErr as Error);
        }
        throw err;
      }
    }) as WithOrgContext;

    app.decorate("withOrgContext", withOrgContext);

    app.addHook("onClose", async () => {
      await pool.end();
    });
  },
  { name: "db" },
);

export default dbPlugin;

/* Fastify plugin: DB pool + per-org transaction helper.
 *
 * Decorates the app with:
 *
 *   app.pg                            — the runtime Pool (app role).
 *   app.withOrgContext(orgId, fn)     — open a transaction, set
 *                                       app.org_id GUC for the duration,
 *                                       run fn(client), commit (or roll
 *                                       back on throw), always release.
 *
 * Routes never touch app.pg directly. They go through withOrgContext so
 * RLS is guaranteed to apply against the right org. The GUC is set inside
 * the transaction (SET LOCAL semantics), so a leaked client cannot carry
 * one org's context into another request.
 */
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";

export type WithOrgContext = <T>(
  orgId: string,
  fn: (client: PoolClient) => Promise<T>,
) => Promise<T>;

declare module "fastify" {
  interface FastifyInstance {
    pg: typeof pool;
    withOrgContext: WithOrgContext;
  }
}

const dbPlugin = fp(
  async (app: FastifyInstance) => {
    app.decorate("pg", pool);

    const withOrgContext: WithOrgContext = async (orgId, fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // set_config(..., true) is the parameterised, transaction-local
        // form of SET LOCAL. Goes through prepared-statement parameters,
        // which closes the SQL-injection vector that a string-built
        // SET LOCAL app.org_id = '...' would leave open.
        await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
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
    };

    app.decorate("withOrgContext", withOrgContext);

    app.addHook("onClose", async () => {
      await pool.end();
    });
  },
  { name: "db" },
);

export default dbPlugin;

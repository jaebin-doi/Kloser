/* PostgreSQL connection pool.
 *
 * Phase 1 Step 1: defined but not yet wired into the Fastify app. Step 2
 * registers a `@fastify/postgres`-style plugin that exposes this pool and
 * injects `SET LOCAL app.org_id` in the auth middleware.
 *
 * The connection string defaults are dev-only. Production reads
 * DATABASE_URL from the environment and never falls back.
 */
import { Pool, type PoolConfig } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL && process.env.NODE_ENV === "production") {
  throw new Error("DATABASE_URL is required in production");
}

const config: PoolConfig = {
  connectionString:
    DATABASE_URL ?? "postgres://kloser:kloser_dev@localhost:5432/kloser_dev",
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
};

export const pool = new Pool(config);

pool.on("error", (err) => {
  // Catch idle-client errors so we don't crash the server when a connection
  // dies mid-idle (e.g., postgres restarted).
  console.error("[db] idle client error:", err.message);
});

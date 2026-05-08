/* PostgreSQL runtime connection pool.
 *
 * DATABASE_URL is intentionally the only source — no dev fallback. The Step 1
 * fallback (`postgres://kloser:...`) was admin credentials, which would have
 * silently bypassed RLS if dotenv ever failed to load. The right fix is to
 * fail loudly here and force callers to supply DATABASE_URL via .env.
 *
 * DATABASE_URL must point at the `app` role (NOSUPERUSER NOBYPASSRLS). The
 * admin role is reachable only via MIGRATE_DATABASE_URL through the migration
 * wrapper — never through this pool.
 */
import { Pool, type PoolConfig } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required. Copy server/.env.example to server/.env" +
    " (DATABASE_URL must point at the runtime `app` role)."
  );
}

const config: PoolConfig = {
  connectionString: DATABASE_URL,
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

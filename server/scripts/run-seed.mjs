/* Apply every `seeds/*.sql` against $MIGRATE_DATABASE_URL in filename order.
 * Used as `npm run db:seed`.
 *
 * Seeds need the admin role: they bypass RLS and may need to insert across
 * orgs in a single connection. Step 2 split DATABASE_URL (runtime, app role)
 * from MIGRATE_DATABASE_URL (migrations + seeds, admin role) — this script
 * uses the latter, never the former.
 *
 * Phase 1 (Step 1) seeded only 0001_demo.sql, so this wrapper hardcoded that
 * filename. Phase 2 Step 1 generalizes it: drop a new `seeds/000N_<name>.sql`
 * file in and add a `(table, expected)` row below to keep `db:seed` honest.
 *
 * Why a script instead of `psql -f`? Windows dev boxes often don't have
 * `psql` on PATH, but they have node. This script uses pg directly so the
 * same command works everywhere.
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const seedDir    = path.resolve(__dirname, "..", "seeds");

const MIGRATE_DATABASE_URL = process.env.MIGRATE_DATABASE_URL;
if (!MIGRATE_DATABASE_URL) {
    console.error(
        "MIGRATE_DATABASE_URL is not set. Seeds require an admin role" +
        " (NOT the runtime app role). Copy server/.env.example to server/.env" +
        " and fill MIGRATE_DATABASE_URL."
    );
    process.exit(2);
}

// Sort by filename — the `0001_`/`0002_` prefix gives a stable apply order
// so a new entity seed always runs after the org/users it depends on.
const seedFiles = (await readdir(seedDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

if (seedFiles.length === 0) {
    console.error("seed: no .sql files in", seedDir);
    process.exit(2);
}

const client = new pg.Client({ connectionString: MIGRATE_DATABASE_URL });
await client.connect();

try {
    for (const f of seedFiles) {
        const sql = await readFile(path.join(seedDir, f), "utf8");
        await client.query(sql);
        console.log("seed: applied", f);
    }

    // Count assertions — a seed file may have been skipped (ON CONFLICT) on
    // the wrong row by mistake, or a future contributor may have added an
    // extra entity without bumping the expected count. Either way, a wrong
    // count is a fast, loud failure here rather than a silent surprise in
    // a downstream test.
    const checks = [
        ["organizations",  2],
        ["users",          4],
        ["memberships",    4],
        ["customers",     24],
    ];
    for (const [table, expected] of checks) {
        const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
        const actual = rows[0]?.n ?? -1;
        const ok = actual === expected;
        console.log(`seed: ${table} count=${actual} ${ok ? "OK" : `EXPECTED ${expected}`}`);
        if (!ok) process.exitCode = 1;
    }
} finally {
    await client.end();
}

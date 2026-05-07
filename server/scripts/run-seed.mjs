/* Run the latest demo seed file against $MIGRATE_DATABASE_URL.
 * Used as `npm run db:seed`. Phase 1 Step 1 — only one seed for now.
 *
 * Seeds need the admin role: they bypass RLS and may need to insert across
 * orgs in a single connection. Step 2 split DATABASE_URL (runtime, app role)
 * from MIGRATE_DATABASE_URL (migrations + seeds, admin role) — this script
 * uses the latter, never the former.
 *
 * Why a script instead of `psql -f`? Windows dev boxes often don't have
 * `psql` on PATH, but they have node. This script uses pg directly so the
 * same command works everywhere.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const SEED_FILE = "seeds/0001_demo.sql";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const seedPath   = path.resolve(__dirname, "..", SEED_FILE);

const MIGRATE_DATABASE_URL = process.env.MIGRATE_DATABASE_URL;
if (!MIGRATE_DATABASE_URL) {
    console.error(
        "MIGRATE_DATABASE_URL is not set. Seeds require an admin role" +
        " (NOT the runtime app role). Copy server/.env.example to server/.env" +
        " and fill MIGRATE_DATABASE_URL."
    );
    process.exit(2);
}

const sql = await readFile(seedPath, "utf8");

const client = new pg.Client({ connectionString: MIGRATE_DATABASE_URL });
await client.connect();

try {
    await client.query(sql);
    console.log("seed: applied", SEED_FILE);

    const checks = [
        ["organizations", 2],
        ["users",         4],
        ["memberships",   4],
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

/* Run the latest demo seed file against $DATABASE_URL.
 * Used as `npm run db:seed`. Phase 1 Step 1 — only one seed for now.
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

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    console.error("DATABASE_URL is not set. Copy server/.env.example to server/.env first.");
    process.exit(2);
}

const sql = await readFile(seedPath, "utf8");

const client = new pg.Client({ connectionString: DATABASE_URL });
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

/* node-pg-migrate wrapper.
 *
 * The runtime DATABASE_URL points at the `app` role (NOSUPERUSER NOBYPASSRLS),
 * which has no DDL privileges. node-pg-migrate would fail mid-migration if it
 * picked that up by accident. So we route migrations through their own URL —
 * MIGRATE_DATABASE_URL — and only when this wrapper is on the call path.
 *
 * Used by every `db:migrate:*` script. Pass-through usage:
 *   node scripts/migrate.mjs up    -m migrations -j sql
 *   node scripts/migrate.mjs down  -m migrations -j sql
 *   node scripts/migrate.mjs create <name> -m migrations -j sql
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";

dotenv.config();

const MIGRATE_DATABASE_URL = process.env.MIGRATE_DATABASE_URL;
if (!MIGRATE_DATABASE_URL) {
    console.error(
        "MIGRATE_DATABASE_URL is not set. Migrations require an admin role" +
        " (NOT the runtime app role). Copy server/.env.example to server/.env" +
        " and fill MIGRATE_DATABASE_URL."
    );
    process.exit(2);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// On Windows the .bin shim is a .cmd file, which spawn() refuses to launch
// directly (EINVAL since Node 18) and shell:true would trip DEP0190.
// Cleanest path: invoke the package's underlying JS entry through `node`
// itself, no shell needed. Works the same on Linux/macOS.
const pkgRoot   = path.resolve(__dirname, "..", "node_modules", "node-pg-migrate");
const cliJsPath = path.join(pkgRoot, "bin", "node-pg-migrate.js");

const child = spawn(process.execPath, [cliJsPath, ...process.argv.slice(2)], {
    cwd: path.resolve(__dirname, ".."),
    stdio: "inherit",
    env: {
        ...process.env,
        // node-pg-migrate reads DATABASE_URL. We override it for this child
        // only — the parent shell keeps whatever value it had.
        DATABASE_URL: MIGRATE_DATABASE_URL,
    },
});

child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else        process.exit(code ?? 0);
});

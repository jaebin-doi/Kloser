/* sync_shared_types.mjs — Phase 2 Step 3 §6.
 *
 * Diffs the field set of each registered entity between
 *   - server/src/types/<entity>.ts          (zod source-of-truth)
 *   - platform/types/<entity>.js            (JSDoc browser mirror)
 *
 * Sync target schemas must keep the convention from
 * `docs/plan/phase-2/PHASE_2_STEP_3_SHARED_TYPES.md` §6:
 *   `export const <TypeName> = z.object({ ... });` — top-level literal,
 *   no `.extend / .merge / .partial / satisfies`.
 *
 * Browser side typedef blocks must use:
 *   /**
 *    * @typedef {Object} <TypeName>
 *    * @property {<type>} [<name>] | <name>
 *    *\/
 *
 * Run: node test/sync_shared_types.mjs
 *
 * Adding a new entity in Phase 3+:
 *   1. Author server/src/types/<entity>.ts under the convention above.
 *   2. Author platform/types/<entity>.js mirroring the same field names.
 *   3. Append one entry to ENTITY_REGISTRY below — nothing else changes.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const ENTITY_REGISTRY = [
    {
        name: "customers",
        server: "server/src/types/customers.ts",
        browser: "platform/types/customers.js",
        // Sync targets — all four are top-level z.object literals on the
        // server side. CustomerPatchBase / CustomerPatch are derived
        // (.partial(), .refine()) and intentionally out of scope.
        types: ["Customer", "CustomerCreateInput", "CustomerListQuery", "CustomerStats"],
    },
    {
        name: "signup",
        server: "server/src/types/signup.ts",
        browser: "platform/types/signup.js",
        types: ["SignupInput", "VerifyEmailInput"],
    },
    {
        name: "password-reset",
        server: "server/src/types/password-reset.ts",
        browser: "platform/types/password-reset.js",
        types: ["ForgotPasswordInput", "ResetPasswordInput"],
    },
    {
        name: "team",
        server: "server/src/types/team.ts",
        browser: "platform/types/team.js",
        // MembershipPatchInput uses .refine() and is intentionally out
        // of sync scope (same convention as customers' CustomerPatch).
        types: ["Team", "TeamCreateInput", "TeamPatchInput", "Member"],
    },
    {
        name: "invitation",
        server: "server/src/types/invitation.ts",
        browser: "platform/types/invitation.js",
        types: ["Invitation", "InvitationCreateInput", "InvitationAcceptInput"],
    },
];

// ---------- parsers ---------- //

function parseServer(text) {
    const result = new Map();
    const lines = text.split(/\r?\n/);
    const startRe = /^export\s+const\s+(\w+)\s*=\s*z\.object\(\{\s*$/;
    const endRe = /^\s*\}\s*\)\s*;?\s*$/;
    const fieldRe = /^\s*(\w+)\s*:/;

    for (let i = 0; i < lines.length; i++) {
        const start = lines[i].match(startRe);
        if (!start) continue;
        const typeName = start[1];
        const fields = new Set();
        let j = i + 1;
        while (j < lines.length && !endRe.test(lines[j])) {
            const line = lines[j];
            const trimmed = line.trim();
            // Skip blank lines and comments
            if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
                j++;
                continue;
            }
            const fm = line.match(fieldRe);
            if (fm) fields.add(fm[1]);
            j++;
        }
        result.set(typeName, fields);
        i = j;
    }
    return result;
}

function parseBrowser(text) {
    const result = new Map();
    // Each typedef sits inside its own /** ... */ block.
    const blockRe = /\/\*\*([\s\S]*?)\*\//g;
    const typedefRe = /@typedef\s+\{Object\}\s+(\w+)/;
    // @property {<type>} [name] OR @property {<type>} name. Brackets denote optional.
    const propRe = /@property\s+\{[^}]*\}\s+\[?([A-Za-z_]\w*)\]?/g;

    let m;
    while ((m = blockRe.exec(text)) !== null) {
        const block = m[1];
        const typedefMatch = block.match(typedefRe);
        if (!typedefMatch) continue;
        const typeName = typedefMatch[1];
        const fields = new Set();
        let p;
        propRe.lastIndex = 0;
        while ((p = propRe.exec(block)) !== null) {
            fields.add(p[1]);
        }
        result.set(typeName, fields);
    }
    return result;
}

// ---------- diff ---------- //

function setDiff(a, b) {
    const out = [];
    for (const v of a) if (!b.has(v)) out.push(v);
    return out.sort();
}

async function checkEntity(entity) {
    const serverPath = path.join(REPO_ROOT, entity.server);
    const browserPath = path.join(REPO_ROOT, entity.browser);
    const [serverText, browserText] = await Promise.all([
        readFile(serverPath, "utf8"),
        readFile(browserPath, "utf8"),
    ]);
    const serverFields = parseServer(serverText);
    const browserFields = parseBrowser(browserText);

    const failures = [];
    for (const typeName of entity.types) {
        const sLeft = serverFields.get(typeName);
        const sRight = browserFields.get(typeName);
        if (!sLeft) {
            failures.push(
                `${typeName}: server type not found in ${entity.server} ` +
                `(check convention: top-level "export const ${typeName} = z.object({ ... });")`,
            );
            continue;
        }
        if (!sRight) {
            failures.push(
                `${typeName}: browser typedef not found in ${entity.browser} ` +
                `(check convention: "@typedef {Object} ${typeName}")`,
            );
            continue;
        }
        const missing = setDiff(sLeft, sRight);
        const extra = setDiff(sRight, sLeft);
        if (missing.length || extra.length) {
            const lines = [`${typeName}:`];
            if (missing.length) lines.push(`  server has but browser missing: ${missing.join(", ")}`);
            if (extra.length) lines.push(`  browser has but server missing: ${extra.join(", ")}`);
            failures.push(lines.join("\n"));
        }
    }
    return failures;
}

// ---------- main ---------- //

let totalFailures = 0;
for (const entity of ENTITY_REGISTRY) {
    const failures = await checkEntity(entity);
    if (failures.length) {
        process.stderr.write(`sync_shared_types: FAIL — ${entity.name}\n`);
        for (const f of failures) {
            process.stderr.write(f + "\n");
        }
        totalFailures += failures.length;
    } else {
        process.stdout.write(
            `sync_shared_types: ${entity.name} OK (${entity.types.join(", ")})\n`,
        );
    }
}

if (totalFailures > 0) {
    process.stderr.write(`sync_shared_types: ${totalFailures} difference(s) found\n`);
    process.exitCode = 1;
} else {
    process.stdout.write("sync_shared_types: PASS\n");
}

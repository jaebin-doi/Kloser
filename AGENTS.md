# AGENTS.md

Guidance for AI coding agents working in this repository.

## Role

This project is usually developed with Claude CLI as the primary implementer and Codex as reviewer/validator. Treat the repository as a shared working tree:

- Do not overwrite or revert user edits unless explicitly asked.
- Before changing files, inspect `git status --short --branch`.
- Keep implementation changes small, reviewable, and aligned with existing plans under `docs/plan/`.
- When a task is review-only, lead with concrete findings and file references.

## Project Shape

Kloser is a static HTML frontend plus a Fastify/PostgreSQL backend.

- Frontend pages live in `platform/`.
- Shared frontend helpers live in `platform/_shared.js`, `platform/api.js`, and `platform/ws.js`.
- Backend code lives in `server/src/`.
- Database migrations live in `server/migrations/`.
- Seed data lives in `server/seeds/`.
- Phase plans and findings live in `docs/plan/`.

Per-phase status (current branch, what's done, what's next) is intentionally NOT tracked here — it rots too fast. Check `git status`, the most recent `docs/plan/phase-*/PHASE_*_MASTER.md`, and the latest findings file instead.

## Safety Rules

- Never run destructive git commands such as `git reset --hard` or `git checkout -- <file>` unless the user explicitly asks.
- Do not include unrelated dirty files in commits.
- If unrelated user edits exist, leave them untouched and mention them in the final report.
- Prefer forward migrations over rewriting already-shared migrations unless the user explicitly asks for history surgery.
- Do not add generated screenshots or transient test artifacts unless the task requires them.

## Common Commands

Backend validation:

```powershell
npm --prefix server run typecheck
npm --prefix server test
node test/sync_shared_types.mjs
```

Database:

```powershell
npm --prefix server run db:migrate:up
npm --prefix server run db:seed
```

Existing live-stream e2e:

```powershell
node test/phase_0_5_e2e.mjs
```

Local run:

```powershell
docker compose -f ops/docker-compose.yml up -d
cd server
npm run dev
```

In another terminal from the repository root:

```powershell
python -m http.server 8765
```

## Backend Conventions

- Routes should use `requireAuth` and `orgContext` before touching org-scoped data.
- All org-scoped database work should go through `app.withOrgContext(orgId, fn)` so RLS uses the transaction-local `app.org_id`.
- Do not trust request bodies for `org_id`.
- Runtime code should use the app role; migrations and seeds use the admin migration URL.
- Keep RLS behavior opaque to callers: cross-org row access should look like `404 not_found`, not `403 exists elsewhere`.
- Customer UUID validation currently uses the repository's permissive 8-4-4-4-12 hex regex. Do not replace it with strict `z.string().uuid()` unless seed UUIDs and tests are migrated too.
- `customers.plan` was intentionally removed and must not be reintroduced. `organizations.plan` is the Kloser subscription tier; customers are tenant-owned leads/contacts.

## Phase Workflow

Each new phase closes in this order. Do not skip ahead.

1. **Schema migration** — table, columns, FKs, RLS policies, indexes. Standalone commit.
2. **Repo + unit tests** — typed accessors, RLS scoping via `app.withOrgContext`, cross-org isolation proven in `server/test/`. Standalone commit.
3. **Route layer** — Fastify handlers, request/response schemas, shared types (`server/src/types/<entity>.ts` zod source + `platform/types/<entity>.js` JSDoc mirror + `test/sync_shared_types.mjs` registry entry), route tests.
4. **Frontend** — the matching `platform/<page>.html` is touched only after 1-3 are green.

Reason: backend (RLS, withOrgContext, edge cases) is the part the project has trained itself to do tightly; starting from UI invites ad-hoc API shapes that don't survive RLS, and demo data that papers over missing columns. Schema-first front-loads the unknowns.

If the user asks to "start Phase N" without specifying the layer, default to step 1 (migration) and confirm before going further.

## Frontend Conventions

- Static pages are classic HTML + vanilla JS. Do not introduce a bundler unless the plan explicitly calls for it.
- Use `platform/api.js` helpers for authenticated REST calls.
- On cold page load, refresh access token first; redirect to login if refresh fails.
- After customer POST/PATCH/DELETE, prefer reloading list + stats from the server (`loadAll`) over optimistic local mutation. This keeps filters, sorting, and stats consistent.
- Keep UI changes consistent with existing dense SaaS dashboard styling.

### Mock vs real data

Frontend is mid-migration from static prototype to real multi-tenant SaaS. Some pages are wired to live API, others still render demo fixtures, and the sidebar user block is currently hard-coded. When working in any frontend file:

- Identify each data field as `(API)` or `(demo)` before editing. If replacing demo with real, say so; if leaving demo, say so.
- In status reports, label any user-facing value mentioned with `(API)` or `(demo)` so the reader doesn't have to ask.
- The demo→real boundary should shrink each phase, not stay flat. Prefer wiring `/me` + real endpoints over copying static names when seeding a new page.

### innerHTML XSS gate

Every `.innerHTML = ...`, `insertAdjacentHTML`, or template literal assigned to `.innerHTML` is an XSS gate. For each interpolation, classify:

- **Constant** (SVG paths, layout chrome, page-author strings): safe.
- **Server-returned field** (customer name, email, transcript text, invite display_name, org name): not safe — escape, use `textContent`, or DOMPurify-sanitize. Server values can carry malicious HTML from upstream imports (CSV uploads, CRM sync) even when they look "internal".
- **User-typed input** (form values, search terms): same — escape or `textContent`.

When adding or touching such a construction, do the check before submitting. `customers.html` and `team.html` already define a local `escapeHtml(str)` — reuse it within those files, or copy the same shape into a new page. Critical paths in team / customers / live are defended; the demo pages (dashboard / calls / newsletter / daily) have not been audited yet and should be treated as pre-flagged risk.

## Documentation Rules

- Plan files are both design record and handoff material. If implementation changes a contract, update the relevant plan/findings document in the same commit or a follow-up cleanup commit.
- For completed work, update checkboxes only when the implementation and verification are actually done.
- Preserve historical notes when useful, but make the current model unambiguous.
- Older `PHASE_*_STEP_*.md` plan files with stale `[ ]` checkboxes are historical drafts. The current source of truth for each phase is its `PHASE_*_MASTER.md` plus the latest findings file — don't try to "complete" the old step plans retroactively.

## Commit/Push Discipline

Before committing:

```powershell
git status --short --branch
git diff --stat
```

Codex owns git write operations for this repository. Claude should not run
`git add`, `git commit`, `git push`, `git merge`, `git rebase`, or branch
integration commands unless the user explicitly overrides this rule for a
specific operation.

When Codex commits, commit only files in the task scope:

```powershell
git add -- <paths>
git commit -m "<concise imperative summary>"
```

Before Codex pushes:

```powershell
git status --short --branch
git log --oneline --decorate -n 5
```

Codex approval includes Codex-side commit + push authorization. After Claude
finishes implementation, Claude should report the changed files and validation
results; Codex reviews the scope and performs the commit/push when OK.

Still stop before committing/pushing when:

- unrelated dirty files are present and cannot be cleanly excluded,
- tests or required validation fail,
- the implementation scope differs from the user's request,
- secrets, oversized binaries, or transient artifacts are staged,
- a product/security policy decision is still unresolved.

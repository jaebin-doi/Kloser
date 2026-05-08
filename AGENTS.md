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

Important current branch context:

- Branch: `feature/phase-2-customers-crud`
- Phase 1 is complete.
- Phase 2 Step 1-5 are complete.
- Phase 2 Step 6 is pending: customers e2e + final Phase 2 findings.
- `customers.plan` was intentionally removed. Do not reintroduce a customer-level `plan` field. `organizations.plan` is the Kloser subscription tier; customers are tenant-owned leads/contacts.

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

## Frontend Conventions

- Static pages are classic HTML + vanilla JS. Do not introduce a bundler unless the plan explicitly calls for it.
- Use `platform/api.js` helpers for authenticated REST calls.
- On cold page load, refresh access token first; redirect to login if refresh fails.
- After customer POST/PATCH/DELETE, prefer reloading list + stats from the server (`loadAll`) over optimistic local mutation. This keeps filters, sorting, and stats consistent.
- Keep UI changes consistent with existing dense SaaS dashboard styling.

## Documentation Rules

- Plan files are both design record and handoff material. If implementation changes a contract, update the relevant plan/findings document in the same commit or a follow-up cleanup commit.
- For completed work, update checkboxes only when the implementation and verification are actually done.
- Preserve historical notes when useful, but make the current model unambiguous.
- For Phase 2, the final source of truth for `customers.plan` removal is `docs/plan/PHASE_2_STEP_5_FINDINGS.md`.

## Commit/Push Discipline

Before committing:

```powershell
git status --short --branch
git diff --stat
```

Commit only files in the task scope:

```powershell
git add -- <paths>
git commit -m "<concise imperative summary>"
```

Before pushing:

```powershell
git status --short --branch
git log --oneline --decorate -n 5
```

Push only after explicit approval, unless the user has directly asked to commit and push.

# Kloser server (Phase 6 complete)

> **Status**:
> - **Phase 0.5 spike** complete (live stream pipeline verified, RTT 1ms, e2e PASS).
> - **Phase 1 complete** (Steps 1~5): docker-compose + RLS FORCE migrations, `app` role with `SET LOCAL app.org_id` context, Argon2id + Bearer access JWT + HttpOnly refresh cookie + family-rotation + grace window, `platform/api.js` memory-token fetch wrapper, WS handshake JWT auth, Caddy single-origin reverse proxy. Details under `docs/plan/phase-1/`.
> - **Phase 2 complete** (Steps 1~6): `customers` schema + RLS + Acme/Beta 24 seed, `customersRepo` + `customersService`, REST `/customers` (list/stats/get/create/patch/delete), shared types via `test/sync_shared_types.mjs`, `platform/customers.html` real API CRUD with URL query sync, `customers.plan` domain cleanup, `phase_2_customers_e2e` 7-scenario regression. Details under `docs/plan/phase-2/`.
> - **Phase 3 complete** (Steps 1~7): `auth_tokens` (unified purpose) + `email_outbox` (dev provider) + `invitations` enrich + `memberships.status` CHECK + service-role grants. Self-service signup with one-transaction org/user/admin/verification-token mint, email verify, password reset (sha256-only `auth_tokens.token_hash`, revoke-all-sessions on success), team invite (anonymous accept with multi-org membership reuse, 7-day TTL, resend/cancel + 410-Gone on stale tokens), team CRUD + member role/status patch with last-admin protection (`lockActiveAdminIds`), `requireFreshRole` middleware for admin-only mutations, enumeration parity on `/auth/password/forgot`, sidebar profile + logout popover wired to `/me`. `phase_3_e2e` 6-scenario / 33-assertion regression. Details under `docs/plan/phase-3/`.
> - **Phase 4 complete** (Steps 1~5): three new tables `calls` / `transcripts` / `call_action_items` with FORCE RLS + partial indexes + composite FK to `customers(org_id, id)` and `memberships(org_id, user_id)`. `endCall` service transaction (calls status / ended_at / duration_seconds + `customers.last_contacted_at = GREATEST(...)` in one go). REST `/calls` (11 endpoints) + `/dashboard/summary`. WebSocket persistence hook for `start_call` / `text_chunk` / `end_call`. `requireVerified` middleware applied to every Phase 4 mutation. Browser side: `calls.html` / `dashboard.html` / `live.html` all wired to real API. `phase_4_e2e` 8-scenario regression. Details under `docs/plan/phase-4/`.
> - **Phase 5 complete** (Steps 1~5): knowledge base (`knowledge_documents` + RAG embeddings) + checklist + suggestion persistence + customer selection in live flow + manager team-scope mutation (`assertCanMutateCall`) + call detail panels wired to real API. `phase_5_e2e` 5-scenario regression. Details under `docs/plan/phase-5/`.
> - **Phase 6 complete** (Steps 1~5): BullMQ + Redis worker infrastructure with `callSummary` queue (enqueued from `endCall` post-commit hook), 60s heartbeat sweep worker (`status='in_progress' AND last_seen_at < now() - 60s` → `dropped/server_timeout`), WS `text_chunk` hook persists into `call_suggestions` + emits `suggestion` event with server id. Real provider adapters: `adapters/llm/anthropic.ts`, `adapters/embedding/openai.ts`, `adapters/stt/clova.ts` — provider env unset/`mock` uses mock; selecting a real provider without required keys fails fast. New `llm_usage_log` table (FORCE RLS, append-only — no UPDATE/DELETE policy) + `services/llmUsage.ts` `recordProviderUsage` helper wired into worker finished hooks and WS suggestion path. `DELETE /call-action-items/:id` (hard delete, `assertCanMutateCall`) + `calls.html` row delete button. `GET /reports/team-summary?team_id=<uuid>` + `services/teamReports.ts` (admin org-wide / manager own-team / 403 for other same-org / 404 cross-org) + `platform/reports.html` (KPI cards + recent 10 calls table, all server fields escaped). Shared types **15 entities** (`teamReport` added). `phase_6_e2e` 7-scenario regression + cleanup sweep. Details under `docs/plan/phase-6/`.
> - **Verification baseline**: `npm --prefix server test` **384 total / 381 pass / 3 skipped / 0 fail** (3 skipped = Phase 6 Step 2 real-provider opt-in, `E2E_ALLOW_REAL_PROVIDERS` not set) + `node test/sync_shared_types.mjs` **15 entities** + `node test/phase_0_5_e2e.mjs` 16/16 + `node test/phase_2_customers_e2e.mjs` 7/7 + `node test/phase_3_e2e.mjs` 33-assertion + `node test/phase_4_e2e.mjs` 8-scenario + `node test/phase_5_e2e.mjs` 5-scenario + `node test/phase_6_e2e.mjs` 7-scenario + cleanup sweep all PASS. Phase 7 is next (SMTP / MFA / activity_log / retention enforce / cost model price map / billing — operational launch gates, see `docs/plan/phase-6/PHASE_7_HANDOFF.md`).
> - Master plans: `docs/plan/phase-{1,2,3,4,5,6}/PHASE_{n}_MASTER.md`. User guides: `docs/USER_GUIDE_PHASE_{1,2,3,4,6}.md`. Visual guides: `docs/product/PHASE_{1,2,3,4}_FOUNDATIONS.html`.

## What this provides

- Fastify HTTP server on `:32173` (default; override via `PORT`) with `/health`
- Socket.io namespace `/calls` (handshake JWT auth):
  - **client → server**: `start_call`, `text_chunk`, `end_call`, `heartbeat` (snake_case)
  - **server → client**: `transcript`, `suggestion` (server-id'd, persisted), `sentiment`, `error`
- WebSocket persistence (Phase 4+): `start_call` inserts a `calls` row, `text_chunk` appends a `transcripts` row before echoing **and** triggers a Phase 6 LLM suggestion that persists into `call_suggestions` before fanning out the `suggestion` event with the server id. `end_call` runs `service.endCall` which marks the call ended and bumps `customers.last_contacted_at` in the same transaction, then best-effort enqueues a `callSummary` BullMQ job for AI summary generation.
- Worker (Phase 6, `server/src/workers/index.ts`):
  - **callSummary** consumer — picks `{ orgId, callId }` jobs, calls LLM (mock or real Anthropic) inside `withOrgContext`, UPDATEs `calls.summary / needs / issues / sentiment` with SQL guard `WHERE summary_source IS DISTINCT FROM 'manual'`, then logs to `llm_usage_log`.
  - **heartbeatSweep** cron — every interval, scans all orgs and marks stale `in_progress` calls (no heartbeat in 60s) as `dropped / server_timeout` with `ended_at` + `duration_seconds`.
- Provider adapters (Phase 6 Step 2): `adapters/llm/anthropic.ts`, `adapters/embedding/openai.ts`, `adapters/stt/clova.ts`. Resolver uses mock when `LLM_PROVIDER` / `EMBEDDING_PROVIDER` / `STT_PROVIDER` are unset, empty, or `mock`; it picks a real adapter only when the provider name matches and required env keys are present. Real provider selected with missing keys is fail-fast, not silent mock fallback. Every provider call is recorded in `llm_usage_log` with `provider` / `model` / `operation` / `tokens_in` / `tokens_out` / `latency_ms` (cost map deferred to Phase 7+).
- REST surface:
  - Auth/me: `/auth/{signup,login,refresh,logout,verify,password/forgot,password/reset}` + `/me`
  - Customers (Phase 2): `/customers` (list / stats / get / create / patch / delete)
  - Team + invitations (Phase 3): `/teams` (list / create / patch / delete), `/teams/:id/members`, `/memberships/:id`, `/invitations` (create / resend / cancel / accept)
  - Calls + dashboard (Phase 4): `/calls` (11 endpoints) + `/dashboard/summary`
  - Knowledge base + checklist + suggestions (Phase 5): `/knowledge/*`, `/calls/:id/checklist*`, `/calls/:id/suggestions`
  - Phase 6: `DELETE /call-action-items/:id` (hard delete, `assertCanMutateCall`) + `GET /reports/team-summary?team_id=<uuid>` (admin org-wide / manager own-team)
- All mutation endpoints gate through `requireAuth → orgContext → requireVerified (Phase 4+) → requireRole → requireFreshRole` (added by phase).
- Shared types: server zod source-of-truth under `src/types/*` mirrors `platform/types/*.js` JSDoc, validated by `test/sync_shared_types.mjs` for **15 entities** (customers / signup / password-reset / team / invitation / call / transcript / actionItem / dashboard / knowledge / checklist / suggestion / customerSelect / heartbeat / teamReport).

## Run

```bash
# 1. Install deps (first time only)
cd server
npm install

# 2. Start the API + WebSocket server (tsx watch — picks up file changes)
npm run dev
# logs: kloser-server listening on :32173
#       [ws/calls] namespace registered at /calls
```

In a second terminal, serve the static platform pages on `:8765`. Per
`test/README.md` the canonical command is `python -m http.server 8765`,
but if Python is not installed (e.g. fresh Windows) use:

```bash
# from project root
npx http-server . -p 8765 --silent
```

Then open <http://localhost:8765/platform/live.html>.

Phase 1 Step 4 added an auth gate: a fresh visit with no token bounces
to `/platform/login.html?returnUrl=/platform/live.html`. Use any of the
seeded credentials documented in `seeds/0001_demo.sql` (e.g.
`admin@acme.test` / `acme-admin-1234` — the dev fixture box on
login.html shows all 4 pairs on localhost). After login the page
redirects back and connects to `http://localhost:32173/calls` over an
authenticated WebSocket, and you should see:

1. The agent greeting transcript at t=0
2. Customer/agent transcripts every 4–5s
3. AI suggestion cards swap at t=5s, 14s, 23s, 36.5s
4. Sentiment badge transitions: 관심 → 망설임 → 재고려

## Verify

```bash
# (servers running) — full regression baseline used to gate every phase
npm --prefix server run typecheck
node test/sync_shared_types.mjs          # 15 entities
npm --prefix server test                 # 384 total / 381 pass / 3 skipped / 0 fail
node test/phase_0_5_e2e.mjs              # 16 assertion — Phase 1 live regression
node test/phase_2_customers_e2e.mjs      # 7 scenarios — Phase 2 regression + leftover sweep
node test/phase_3_e2e.mjs                # 6 scenarios / 33 assertion — Phase 3 regression
node test/phase_4_e2e.mjs                # 8 scenarios + cleanup sweep — Phase 4 closeout
node test/phase_5_e2e.mjs                # 5 scenarios + cleanup sweep — Phase 5 closeout
node test/phase_6_e2e.mjs                # 7 scenarios + cleanup sweep — Phase 6 closeout
```

The Phase 6 e2e forces `LLM_PROVIDER=mock` / `EMBEDDING_PROVIDER=mock` / `STT_PROVIDER=mock` and uses inline worker draining (`server/scripts/phase6E2eDrain.ts`) — no separate `dev:worker` process is required to run it.

Each Playwright e2e writes a screenshot artifact next to itself (`test/phase_*_e2e.png`) for visual evidence of the final state.

## Run (Caddy single-origin variant — Phase 1 Step 5)

For a prod-equivalent dev setup where static, REST, and WS all live
on `https://localhost` behind a self-signed cert (so cookie Secure
behavior, same-origin fetch, and proxy WS upgrades are exercised
end-to-end):

1. Install Caddy v2 — `scoop install caddy` on Windows,
   `brew install caddy` on macOS, `apt install caddy` on Debian.
2. Trust the local CA once: `caddy trust`. The browser will warn on
   the first visit until this is done.
3. Launch from project root with the static-root env set:
   ```powershell
   # PowerShell
   $env:KLOSER_STATIC_ROOT = (Resolve-Path .).Path
   caddy run --config ops/Caddyfile.dev
   ```
   ```bash
   # bash
   KLOSER_STATIC_ROOT=$(pwd) caddy run --config ops/Caddyfile.dev
   ```
4. Open `https://localhost/platform/live.html`. No HTML edits are
   needed — `platform/api.js` auto-detects the `https://localhost`
   origin and switches to relative URLs (`/auth/*`, `/socket.io/*`)
   that Caddy proxies to Fastify.

Verify the variant with the same e2e suite:

```powershell
$env:KLOSER_E2E_BASE_URL = 'https://localhost'
node test/phase_0_5_e2e.mjs
Remove-Item Env:KLOSER_E2E_BASE_URL
```

```bash
KLOSER_E2E_BASE_URL=https://localhost node test/phase_0_5_e2e.mjs
```

| 비교 | split-origin (default) | Caddy single-origin |
|---|---|---|
| 정적 | `http://localhost:8765` (http-server) | `https://localhost` (Caddy) |
| API | `http://localhost:32173` (Fastify) | `https://localhost/auth/*` (Caddy → :32173) |
| WS | `http://localhost:32173/calls` | `https://localhost/socket.io/*` (Caddy → :32173) |
| TLS | none | `tls internal` (self-signed) |
| Cookie `Secure` flag | false (HTTP) | can be true (HTTPS) |
| `api.js` base URL | `http://localhost:32173` (default) | `""` auto-detected on `https://localhost` |
| When to use | 일상 dev / e2e baseline | prod 등가 검증 / TLS 동작 확인 |

The same script writes `test/phase_0_5_e2e.png` for visual evidence.

## Layout

```text
server/
├── package.json           # fastify, socket.io, pg, dotenv, @fastify/{jwt,cookie}, argon2
├── tsconfig.json          # ES2022 / NodeNext / strict
├── .env.example           # DATABASE_URL(app), MIGRATE_DATABASE_URL(admin), SERVICE_DATABASE_URL, REDIS_URL, JWT_SECRET
├── migrations/            # node-pg-migrate (forward-only)
│   ├── 1715000000000_init.sql                       # base tables + RLS FORCE (Phase 1)
│   ├── 1715000001000_auth_sessions.sql              # sessions enrich for family rotation (Phase 1 Step 3)
│   ├── 1715000002000_customers.sql                  # customers + RLS + indexes (Phase 2)
│   ├── 1715000003000_drop_customers_plan.sql        # remove customers.plan (Phase 2 cleanup)
│   ├── 1715000004000_phase3_memberships_status_check.sql   # active/disabled CHECK (Phase 3)
│   ├── 1715000005000_phase3_invitations_enrich.sql         # team_id / invited_by / canceled_at / last_sent_at
│   ├── 1715000006000_phase3_auth_tokens.sql                # unified auth_tokens (verify/reset/invite)
│   ├── 1715000007000_phase3_email_outbox.sql               # dev email_outbox (raw URL kept for e2e only)
│   ├── 1715000008000_phase3_service_grants.sql             # kloser_service SELECT/INSERT/UPDATE grants
│   ├── 1715000009000_phase4_calls.sql                      # calls + RLS + partial indexes + composite FK
│   ├── 1715000010000_phase4_transcripts.sql                # transcripts + RLS + (call_id, seq) UNIQUE
│   ├── 1715000011000_phase4_call_action_items.sql          # call_action_items + RLS
│   └── 1715000012000_phase4_app_grants.sql                 # app role CRUD grants for Phase 4 tables
├── seeds/
│   ├── 0001_demo.sql       # 2 orgs × (admin + employee) — Argon2id hashes
│   ├── 0002_customers.sql  # Acme 12 + Beta 12 (24 rows)
│   └── 0003_phase3_demo.sql# additional Phase 3 fixtures
├── scripts/
│   ├── migrate.mjs         # routes node-pg-migrate through MIGRATE_DATABASE_URL
│   └── run-seed.mjs        # routes seed through MIGRATE_DATABASE_URL
├── test/                   # tsx --test --test-concurrency=1 (212/212 PASS)
│   ├── auth.test.mjs                       # Phase 1 — auth core
│   ├── rls_isolation.test.mjs              # Phase 1 — RLS context isolation
│   ├── orgContext.test.mjs                 # Phase 1 — withOrgContext helper
│   ├── ws_auth.test.mjs                    # Phase 1 — WS handshake auth
│   ├── customers_repo.test.mjs             # Phase 2 — repo + RLS
│   ├── customers_routes.test.mjs           # Phase 2 — REST routes
│   ├── invitations_*.test.mjs              # Phase 3 — invite create/accept/resend/cancel
│   ├── team_routes.test.mjs                # Phase 3 — team CRUD + memberships patch + last-admin lock
│   ├── auth_password_reset.test.mjs        # Phase 3 — forgot/reset + revoke-all-sessions
│   ├── signup_verify.test.mjs              # Phase 3 — signup transaction + verify
│   ├── calls_repo.test.mjs                 # Phase 4 — calls repository
│   ├── transcripts_repo.test.mjs           # Phase 4 — transcripts repository
│   ├── call_action_items_repo.test.mjs     # Phase 4 — action items repository
│   ├── calls_service.test.mjs              # Phase 4 — endCall transaction + last_contacted_at update
│   ├── calls_routes.test.mjs               # Phase 4 — REST routes (incl. permission matrix)
│   ├── dashboard_routes.test.mjs           # Phase 4 — /dashboard/summary
│   └── ws_persistence.test.mjs             # Phase 4 — WS hook persists calls/transcripts
└── src/
    ├── server.ts                           # Fastify entry — plugins, routes, WS, error handler
    ├── config/authEnv.ts                   # JWT_SECRET fail-fast + TTLs + cookieSecure
    ├── db/pool.ts                          # pg Pool — DATABASE_URL required, no fallback
    ├── plugins/
    │   ├── auth.ts                         # @fastify/cookie + @fastify/jwt (HS256) + signAccessToken
    │   └── db.ts                           # app.pg + app.withOrgContext(orgId, fn)
    ├── middleware/
    │   ├── auth.ts                         # requireAuth — Bearer parse + jwtVerify
    │   ├── orgContext.ts                   # SET LOCAL app.org_id (JWT-priority)
    │   ├── role.ts                         # requireRole(...roles)
    │   ├── requireFreshRole.ts             # admin-only mutation guard (Phase 3)
    │   └── requireVerified.ts              # email-verified guard for Phase 4 mutations
    ├── services/
    │   ├── auth.ts                         # signup/login/refresh/logout + AuthError
    │   ├── auth-tokens.ts                  # verify/reset/invite token mint + consume
    │   ├── customers.ts                    # Phase 2 service
    │   ├── invitations.ts                  # Phase 3 invite create/accept/resend/cancel
    │   ├── memberships.ts                  # Phase 3 role/status patch + last-admin lock
    │   ├── teams.ts                        # Phase 3 team CRUD
    │   ├── email.ts                        # EmailProvider (dev outbox)
    │   └── calls.ts                        # Phase 4 endCall transaction + appendTranscript
    ├── repositories/
    │   ├── customers.ts                    # Phase 2
    │   ├── calls.ts                        # Phase 4
    │   ├── transcripts.ts                  # Phase 4 — seq-aware append + range read
    │   ├── callActionItems.ts              # Phase 4 — CRUD + parent-call lookup for permission
    │   └── ... (sessions, memberships, teams, invitations, auth_tokens, email_outbox)
    ├── routes/
    │   ├── auth.ts        # /auth/* (signup/login/refresh/logout/verify/password)
    │   ├── me.ts          # GET /me
    │   ├── customers.ts   # Phase 2 — 6 endpoints
    │   ├── team.ts        # Phase 3 — teams + memberships
    │   ├── invitations.ts # Phase 3 — invite CRUD + anonymous accept
    │   ├── calls.ts       # Phase 4 — 11 endpoints (calls + action items)
    │   └── dashboard.ts   # Phase 4 — /dashboard/summary
    ├── ws/
    │   └── calls.ts        # /calls namespace — handshake auth + persistence hook
    ├── types/              # zod source-of-truth for shared types (9 entities)
    │   ├── customers.ts | signup.ts | password-reset.ts | team.ts | invitation.ts
    │   └── call.ts | transcript.ts | actionItem.ts | dashboard.ts
    └── fixtures/
        └── demo-call.ts    # conversation + aiSequence (with sentiment)
```

## Not done on purpose

Phase 7+ scope, intentionally not yet implemented (full priority list in `docs/plan/phase-6/PHASE_7_HANDOFF.md`):

- **Real SMTP / Resend** — Phase 3 dev `email_outbox` (raw token kept in metadata for e2e extraction) stays for now. Production provider lands in Phase 7; outbox becomes archive-only.
- **MFA / WebAuthn / session hardening** — password + JWT only today; TOTP first, WebAuthn second.
- **activity_log + audit log** — schema slot exists; population not wired. Phase 7.
- **Retention enforce cron** — `transcripts` 3-year / `call_recordings` 90-day enforcement not running. Phase 7.
- **`llm_usage_log.cost_usd_micros`** — column exists, all rows NULL today. Phase 7 cost-accuracy commit introduces the model→price map plus daily cap.
- **Role-based sidebar nav visibility** — `platform/reports.html` link is currently visible to every role (backend 403 blocks employee/viewer). Phase 7 menu polish.
- **Report date-window / agent drilldown** — `GET /reports/team-summary` returns full-history team KPI only; per-day/per-agent slicing is Phase 7.
- **Billing / subscription caps** — `organizations.plan` column exists; no cap enforcement and no Stripe/Toss integration.
- **Demo-to-real frontend cleanup** — `dashboard.html` market-trend / To-Do / team-activity widgets, plus `newsletter.html` and `daily.html`, remain `(demo)` labelled. Phase 7+ UX.
- **`call_recordings` audio storage** — schema columns exist; S3/MinIO adapter, encoding, signed URL playback all deferred.
- **Enterprise SSO (Keycloak)** + **multilingual transcripts** + **`organizations.timezone`** — Phase 8+.

## Endpoints / events reference

```text
GET  /health                                   → { ok, version, uptimeSec }

# Phase 1 — auth core
POST /auth/signup                              → { accessToken, user }; sets refresh cookie (creates org + admin in one tx)
POST /auth/login                               → { accessToken, user }; sets refresh cookie
                                                 400 + availableOrgs[] when multi-org and orgId missing
POST /auth/refresh                             → { accessToken }; rotates refresh cookie (30s grace)
POST /auth/logout                              → { ok: true }; clears refresh cookie
GET  /me                                       → { user, organization, membership }; requires Bearer

# Phase 3 — self-service (anonymous flows use kloser_service BYPASSRLS pool)
POST /auth/verify                              → 200 (token-once; URL token stripped client-side)
POST /auth/password/forgot                     → 200 (enumeration parity — always 200)
POST /auth/password/reset                      → 200; revokes all active refresh sessions on success
POST /invitations                              → 201 (admin only, requireFreshRole)
POST /invitations/:id/resend                   → 200 (admin)
DELETE /invitations/:id                        → 204 (admin)
POST /invitations/accept                       → 200/201 (anonymous, token + name + password)

# Phase 2 — customers
GET    /customers / /customers/stats / /customers/:id
POST   /customers
PATCH  /customers/:id
DELETE /customers/:id                          (soft delete)

# Phase 3 — team / memberships
GET    /teams / /teams/:id/members
POST   /teams
PATCH  /teams/:id / /memberships/:id (role/status — last-admin protection via lockActiveAdminIds)
DELETE /teams/:id

# Phase 4 — calls + dashboard (all mutations gated by requireVerified)
GET    /calls                                  → list with q / status / customerId / agentUserId / limit / offset
POST   /calls                                  → 201 { call } (employee auto-bound to self as agent)
GET    /calls/:id                              → 200 { call }
POST   /calls/:id/notes                        → 200 { call }
POST   /calls/:id/end                          → 200 { call }; bumps customers.last_contacted_at in tx
GET    /calls/:id/transcript                   → 200 { items[] }
POST   /calls/:id/transcript                   → 201 { transcript } (server-assigned seq)
GET    /calls/:id/action-items                 → 200 { items[] }
POST   /calls/:id/action-items                 → 201 { action_item }
POST   /call-action-items/:id/status           → 200 { action_item } (open / done / dropped)
POST   /call-action-items/:id/assignee         → 200 { action_item }
GET    /dashboard/summary                      → 200 { today_calls, response_rate, avg_duration_seconds,
                                                          active_calls, recent_calls[] }

# Phase 5 — knowledge / checklist / suggestion / customer selection
GET    /knowledge                              → 200 { items[] }
POST   /knowledge                              → 201 { document } (admin/manager)
PATCH  /knowledge/:id                          → 200 { document }
DELETE /knowledge/:id                          → 204
GET    /calls/:id/checklist                    → 200 { items[] }
POST   /calls/:id/checklist/initialize         → 201 { items[] } (denied for viewer)
POST   /call-checklist-items/:id/toggle        → 200 { item }
GET    /calls/:id/suggestions                  → 200 { items[] }

# Phase 6 — action item delete + manager team report
DELETE /call-action-items/:id                  → 204; hard delete with assertCanMutateCall
GET    /reports/team-summary?team_id=<uuid?>   → 200 { scope, team_id, team_name, generated_at,
                                                          total_calls, ended_calls, missed_calls, dropped_calls,
                                                          active_calls, response_rate, avg_duration_seconds,
                                                          recent_calls[] }
                                                   manager: own team only (other same-org → 403, cross-org → 404)
                                                   admin: any team_id or omit for org-wide scope

# WebSocket — /calls namespace (handshake JWT)
WS   /calls   (auth: { token: <Bearer access JWT> }, NO userId query)
     handshake connect_error (data.code):
       missing_token | expired_token | invalid_token
     ── connect (logged server-side; socket.data.user populated from JWT)
     C2S start_call({ customerId? })           → ack { callId }  (Phase 4 persists calls row)
     C2S text_chunk({ seq, text, clientSentAt })  (Phase 4 persists transcripts row, then echoes)
     C2S end_call()                            → ack { ok: true }  (Phase 4 endCall transaction)
     S2C transcript { seq, who, text, clientSentAt?, serverSentAt }
     S2C suggestion { at, suggestions[] }
     S2C sentiment  { mood, interest, stage }
     S2C error      { code, message }
                    codes: no_active_call, BAD_PAYLOAD, call_not_found, persistence_failed
```

## Phase 1 DB / RLS Developer Guide

Phase 1 uses two PostgreSQL roles on purpose:

- `DATABASE_URL` is the runtime app connection. It must use the `app` role.
  This role is `NOSUPERUSER NOBYPASSRLS`, so Row-Level Security applies to
  user-facing queries.
- `MIGRATE_DATABASE_URL` is for migrations and seeds only. It uses the admin
  `kloser` role created by Docker's `POSTGRES_USER`. That role can bypass RLS
  and must not be used by runtime code.

Never point runtime code at `MIGRATE_DATABASE_URL`. If a library reads
`DATABASE_URL` automatically, it should land on the safe `app` role.

```bash
# 0. environment
cp ../.env.example ../.env          # project-root compose values
cp .env.example .env                # DATABASE_URL, MIGRATE_DATABASE_URL, REDIS_URL

# 1. infra
docker compose -f ../ops/docker-compose.yml up -d

# 2. app role bootstrap
# New Docker volumes run this automatically from:
#   ops/postgres/init/01_app_role.sql
#
# Existing Docker volumes do not re-run /docker-entrypoint-initdb.d scripts.
# If the volume already existed before Step 2, apply it once manually:
docker exec -i kloser-dev-postgres-1 \
  psql -U kloser -d kloser_dev -f /docker-entrypoint-initdb.d/01_app_role.sql

# Verify runtime role attributes:
docker exec kloser-dev-postgres-1 psql -U kloser -d kloser_dev -c \
  "SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname='app'"
# expect: app | f | f | t

# Verify runtime cannot touch migration metadata:
docker exec kloser-dev-postgres-1 psql "postgres://app:app_dev@localhost:5432/kloser_dev" -c \
  "SELECT count(*) FROM pgmigrations"
# expect: permission denied

# 3. migrations
# Uses MIGRATE_DATABASE_URL through scripts/migrate.mjs.
npm run db:migrate:up
# expect: Migrations complete! or "No migrations to run"

# 4. seed
# Uses MIGRATE_DATABASE_URL through scripts/run-seed.mjs.
npm run db:seed
# expect: organizations count=2 OK, users count=4 OK, memberships count=4 OK

# 5. verify RLS flags on the four org-scoped tables
docker exec kloser-dev-postgres-1 psql -U kloser -d kloser_dev -c \
  "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class \
   WHERE relname IN ('memberships','teams','invitations','activity_log') \
   ORDER BY relname"
# expect: all four with t/t

# 6. verify RLS behavior with the runtime app role
docker exec kloser-dev-postgres-1 psql "postgres://app:app_dev@localhost:5432/kloser_dev" -c \
  "SELECT count(*) AS no_guc FROM memberships; \
   BEGIN; \
   SELECT set_config('app.org_id','11111111-1111-1111-1111-111111111111', true); \
   SELECT count(*) AS org1 FROM memberships; \
   COMMIT;"
# expect: no_guc = 0, org1 = 2
```

If `MIGRATE_DATABASE_URL` is missing, `npm run db:migrate:*` and
`npm run db:seed` should fail immediately with a clear error. That is
intentional: migrations and seeds require admin privileges, while runtime code
must stay on the RLS-enforced app role.

Step 2 continues by plugging this into Fastify with a transaction helper that
sets `app.org_id` using `SET LOCAL` / `set_config(..., true)`.

## Phase 0.5 cleanup pointer (resolved)

`src/__test_client.ts` was the Phase 0.5 throwaway — removed at the Phase 1 Step 1 commit. The canonical smoke is `test/phase_0_5_e2e.mjs`.

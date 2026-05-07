# Kloser server (Phase 0.5 spike + Phase 1 in progress)

> **Status**:
> - **Phase 0.5 spike** complete (live stream pipeline verified, 14/14 e2e PASS, RTT 1ms).
> - **Phase 1 Step 1** complete: DB infrastructure (compose, migration, seed, runtime verification).
> - **Phase 1 Step 2** complete: runtime `app` role + RLS SET LOCAL context + isolation tests (10/10 PASS, e2e regression PASS).
> - **Phase 1 Step 3** complete: Argon2id + Bearer access JWT + HttpOnly refresh cookie (Path=/auth) + sessions rotation with family reuse detection + role guard + prod X-Org-Id strict reject. 29/29 unit (auth 19 + rls 7 + orgContext 3) + 14/14 e2e PASS. See `docs/plan/PHASE_1_STEP_3_AUTH_CORE.md` / `docs/plan/PHASE_1_STEP_3_FINDINGS.md`.
> - **Phase 1 Step 4** complete: `platform/api.js` fetch wrapper (memory access token + single in-flight refresh + retry-once + login redirect) + `platform/login.html` + `platform/live.html` auth gate + DOMPurify suggestion sanitize + WS handshake JWT auth (`auth.token` slot, `userId` query removed) + `text_chunk` before `start_call` invariant. 37/37 unit (29 + WS auth 8) + 16/16 e2e PASS (login pre-step + 14 prior + auth reject 2). See `docs/plan/PHASE_1_STEP_4_CLIENT_WIRING.md` / `docs/plan/PHASE_1_STEP_4_FINDINGS.md`.
> - **Phase 1 Step 5** next: Caddy reverse proxy draft + ops notes.
> - See `docs/plan/PHASE_0_5_LIVE_SPIKE.md`, `docs/plan/PHASE_1_MASTER.md`, `docs/plan/PHASE_1_STEP_1_DB_INFRA.md`, `docs/plan/PHASE_1_STEP_2_RLS_CONTEXT.md`, `docs/plan/PHASE_1_STEP_2_FINDINGS.md`, `docs/plan/PHASE_1_STEP_3_AUTH_CORE.md`, `docs/plan/PHASE_1_STEP_3_FINDINGS.md`, `docs/plan/PHASE_1_STEP_4_CLIENT_WIRING.md`, `docs/plan/PHASE_1_STEP_4_FINDINGS.md`.

## What this provides

- Fastify HTTP server on `:3001` with `/health`
- Socket.io namespace `/calls`:
  - **client → server**: `start_call`, `text_chunk`, `end_call` (snake_case, per `BACKEND_PLAN.md` §6)
  - **server → client**: `transcript`, `suggestion`, `sentiment`, `error`
- On `start_call`, the server schedules the legacy demo conversation
  + AI suggestion sequence + sentiment changes via `setTimeout`. The
  fixture lives in `src/fixtures/demo-call.ts` and was lifted from the
  former client-side `live.html` mock so visual parity is preserved.
- `text_chunk` is echoed back as `transcript` with the original
  `clientSentAt` round-tripped — this is what the client uses to
  measure RTT.

## Run

```bash
# 1. Install deps (first time only)
cd server
npm install

# 2. Start the API + WebSocket server (tsx watch — picks up file changes)
npm run dev
# logs: kloser-server listening on :3001
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
redirects back and connects to `http://localhost:3001/calls` over an
authenticated WebSocket, and you should see:

1. The agent greeting transcript at t=0
2. Customer/agent transcripts every 4–5s
3. AI suggestion cards swap at t=5s, 14s, 23s, 36.5s
4. Sentiment badge transitions: 관심 → 망설임 → 재고려

## Verify

```bash
# (servers running) — Playwright e2e
node test/phase_0_5_e2e.mjs
# expect: 16 PASS lines + "E2E PASSED"
#   (login pre-step + 14 prior cases + 2 WS auth-reject cases)
```

The same script writes `test/phase_0_5_e2e.png` for visual evidence.

## Layout

```text
server/
├── package.json           # fastify, socket.io, pg, dotenv, @fastify/{jwt,cookie}, argon2
├── tsconfig.json          # ES2022 / NodeNext / strict
├── .env.example           # DATABASE_URL(app), MIGRATE_DATABASE_URL(admin), REDIS_URL, JWT_SECRET
├── migrations/            # node-pg-migrate
│   ├── 1715000000000_init.sql        # 7 tables + RLS FORCE ENABLE (Step 1)
│   └── 1715000001000_auth_sessions.sql  # sessions enriched: org_id, membership_id,
│                                        # token_family_id, replaced_by_session_id (Step 3)
├── seeds/
│   └── 0001_demo.sql       # 2 orgs × (admin + employee), Argon2id hashes
├── scripts/
│   ├── migrate.mjs         # routes node-pg-migrate through MIGRATE_DATABASE_URL
│   └── run-seed.mjs        # routes seed through MIGRATE_DATABASE_URL
├── test/                   # tsx --test --test-concurrency=1
│   ├── auth.test.mjs              # 19 cases (Step 3)
│   ├── rls_isolation.test.mjs     # 7 cases (Step 2)
│   ├── orgContext.test.mjs        # 3 cases (Step 3)
│   └── ws_auth.test.mjs           # 8 cases (Step 4 §1.7)
└── src/
    ├── server.ts          # Fastify entry — registers plugins, routes, WS namespace
    ├── config/
    │   └── authEnv.ts      # JWT_SECRET fail-fast + TTLs + cookieSecure flag (Step 3)
    ├── db/
    │   └── pool.ts         # pg Pool — DATABASE_URL required, no fallback
    ├── plugins/
    │   ├── auth.ts         # @fastify/cookie + @fastify/jwt (HS256) + signAccessToken (Step 3)
    │   └── db.ts           # app.pg + app.withOrgContext(orgId, fn) (Step 2)
    ├── middleware/
    │   ├── auth.ts         # requireAuth — Bearer parse + jwtVerify + AuthenticatedUser
    │   ├── orgContext.ts   # SET LOCAL app.org_id (JWT-priority; prod rejects X-Org-Id)
    │   └── role.ts         # requireRole(...roles)
    ├── services/
    │   └── auth.ts         # signup/login/refresh/logout (Argon2id + family rotation + grace)
    ├── repositories/       # RLS-aware (memberships, sessions, etc.)
    ├── routes/
    │   ├── auth.ts         # signup/login/refresh/logout
    │   └── me.ts           # GET /me
    ├── ws/
    │   └── calls.ts        # /calls namespace — handshake JWT auth + invariants (Step 4)
    └── fixtures/
        └── demo-call.ts    # conversation + aiSequence (with sentiment)
```

(Phase 0.5 throwaway `__test_client.ts` removed at Phase 1 kickoff per the cleanup pointer.)

## Not done on purpose

These are deferred to later Phase 1 steps or beyond and intentionally not yet implemented:

- DB-backed call/transcript persistence — Phase 1 step 1·2 set up postgres + RLS but call data still lives in-memory; Phase 4 wires the real storage.
- Per-organization rooms in WS — single socket = single call
- Runtime payload validation — only minimal shape checks beyond the Phase 0.5 spike (BAD_PAYLOAD on `text_chunk` shape, `no_active_call` if `text_chunk` precedes `start_call`)
- Real STT / LLM — Phase 5 of the broader plan
- Reverse proxy / TLS — `localhost` plaintext only (Step 5)
- Shared types between server and browser — deferred to Phase 2 (no build step on the static pages today). See `docs/plan/PHASE_1_STEP_4_FINDINGS.md` §10.

## Endpoints / events reference

```text
GET  /health                                   → { ok, version, uptimeSec }

POST /auth/signup                              → { accessToken, user }; sets refresh cookie
POST /auth/login                               → { accessToken, user }; sets refresh cookie
                                                 400 + availableOrgs[] when multi-org and orgId missing
POST /auth/refresh                             → { accessToken }; rotates refresh cookie (30s grace window)
POST /auth/logout                              → { ok: true }; clears refresh cookie
GET  /me                                       → { user }; requires Bearer access token

WS   /calls   (auth: { token: <Bearer access JWT> }, NO userId query)
     handshake connect_error (data.code):
       missing_token | expired_token | invalid_token
     ── connect (logged server-side; socket.data.user populated from JWT)
     C2S start_call({ customerId? })           → ack { callId }
     C2S text_chunk({ seq, text, clientSentAt })  (no ack — server emits transcript)
     C2S end_call()                            → ack { ok: true }
     S2C transcript { seq, who, text, clientSentAt?, serverSentAt }
     S2C suggestion { at, suggestions[] }
     S2C sentiment  { mood, interest, stage }
     S2C error      { code, message }    (codes: no_active_call, BAD_PAYLOAD)
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

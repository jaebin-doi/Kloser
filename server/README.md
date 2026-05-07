# Kloser server (Phase 0.5 spike + Phase 1 in progress)

> **Status**:
> - **Phase 0.5 spike** complete (live stream pipeline verified, 14/14 e2e PASS, RTT 1ms).
> - **Phase 1 Step 1** complete: DB infrastructure (compose, migration, seed, runtime verification).
> - **Phase 1 Step 2** in progress: runtime `app` role + RLS context.
> - See `docs/PHASE_0_5_LIVE_SPIKE.md`, `docs/PHASE_1_MASTER.md`, `docs/PHASE_1_STEP_1_DB_INFRA.md`, `docs/PHASE_1_STEP_2_RLS_CONTEXT.md`.

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

The page connects to `http://localhost:3001/calls` and you should see:

1. The agent greeting transcript at t=0
2. Customer/agent transcripts every 4–5s
3. AI suggestion cards swap at t=5s, 14s, 23s, 36.5s
4. Sentiment badge transitions: 관심 → 망설임 → 재고려

## Verify

```bash
# (servers running) — Playwright e2e
node test/phase_0_5_e2e.mjs
# expect: 12 PASS lines + "E2E PASSED"
```

The same script writes `test/phase_0_5_e2e.png` for visual evidence.

## Layout

```text
server/
├── package.json           # fastify, socket.io, pg, dotenv, node-pg-migrate, tsx, ts
├── tsconfig.json          # ES2022 / NodeNext / strict
├── .env.example           # DATABASE_URL(app), MIGRATE_DATABASE_URL(admin), REDIS_URL
├── migrations/            # 🆕 Phase 1 — node-pg-migrate
│   └── 1715000000000_init.sql   # 7 tables + RLS FORCE ENABLE
├── seeds/                 # 🆕 Phase 1
│   └── 0001_demo.sql       # 2 orgs × (admin + employee)
├── scripts/               # 🆕 Phase 1
│   ├── migrate.mjs         # routes node-pg-migrate through MIGRATE_DATABASE_URL
│   └── run-seed.mjs        # routes seed through MIGRATE_DATABASE_URL
└── src/
    ├── server.ts          # Fastify entry — health endpoint + io.attach
    ├── db/                # 🆕 Phase 1
    │   └── pool.ts         # pg Pool (Step 2 wires into a fastify plugin)
    ├── ws/
    │   └── calls.ts       # /calls namespace handler
    └── fixtures/
        └── demo-call.ts   # conversation + aiSequence (with sentiment)
```

(Phase 0.5 throwaway `__test_client.ts` removed at Phase 1 kickoff per the cleanup pointer.)

## Not done on purpose

These are deferred to Phase 1+ and intentionally not implemented:

- Authentication / JWT — `userId` query param is accepted as-is
- Persistence — no DB, no migrations, transcripts live only in-memory
- Per-organization rooms — single socket = single call
- Runtime payload validation — only minimal shape checks
- Real STT / LLM — Phase 5 of the broader plan
- Reverse proxy / TLS — `localhost` plaintext only
- Sanitization of suggestion HTML — fixture is the only source for
  spike scope (`<b>`, `<br>` are intentional). Phase 1 must add
  DOMPurify or a markup whitelist before any user-authored content
  hits the suggestion pipe. Transcript text was already switched to
  `textContent` on the client.

## Endpoints / events reference

```text
GET  /health                                   → { ok, version, uptimeSec }

WS   /calls?userId=<string>
     ── connect (logged server-side)
     C2S start_call({ customerId? })           → ack { callId }
     C2S text_chunk({ seq, text, clientSentAt })  (no ack — server emits transcript)
     C2S end_call()                            → ack { ok: true }
     S2C transcript { seq, who, text, clientSentAt?, serverSentAt }
     S2C suggestion { at, suggestions[] }
     S2C sentiment  { mood, interest, stage }
     S2C error      { code, message }
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

# Kloser server (Phase 0.5 spike)

> **Status**: throwaway scaffold for the live-stream risk-removal spike.
> See `docs/PHASE_0_5_LIVE_SPIKE.md` for scope.
> Phase 1 will rewrite or significantly restructure most of this code:
> auth, persistence, multi-tenant rooms, runtime validation, and shared
> types are all intentionally absent.

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
├── package.json           # fastify, socket.io, tsx, typescript
├── tsconfig.json          # ES2022 / NodeNext / strict
└── src/
    ├── server.ts          # Fastify entry — health endpoint + io.attach
    ├── ws/
    │   └── calls.ts       # /calls namespace handler
    ├── fixtures/
    │   └── demo-call.ts   # conversation + aiSequence (with sentiment)
    └── __test_client.ts   # throwaway Node CLI smoke (Phase 0.5 only)
```

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

## Cleanup pointer

`src/__test_client.ts` is throwaway — delete during the Phase 1 kickoff
once the e2e Playwright script (`test/phase_0_5_e2e.mjs`) is the canonical
smoke check.

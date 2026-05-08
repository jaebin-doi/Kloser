/* Auth env contract — Phase 1 Step 3.
 *
 * Loaded once at boot via import side-effect: it validates JWT_SECRET
 * and exports a typed snapshot of every auth/cookie env. server.ts
 * imports this module (early, after dotenv) so a missing JWT_SECRET
 * fails the process before any request is served.
 *
 * Plan: docs/plan/phase-1/PHASE_1_STEP_3_AUTH_CORE.md §1 sub-step 3.
 *
 * Decisions that show up in this file:
 *   - HS256 with a single JWT_SECRET (Step 3 risk table).
 *   - ACCESS_TOKEN_TTL / REFRESH_TOKEN_TTL accept jsonwebtoken/ms
 *     duration strings ("15m", "30d") and are passed through verbatim.
 *   - REFRESH_GRACE_WINDOW_SECONDS is integer seconds — used inside SQL
 *     comparisons, hence numeric.
 *   - COOKIE_SECURE=false in dev (plaintext localhost), true behind
 *     HTTPS/reverse proxy in prod.
 */

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret.length < 32) {
  // Length floor catches the "I forgot to fill this in" case where the
  // env was set to "" or a placeholder shorter than the dev default.
  throw new Error(
    "JWT_SECRET is required and must be at least 32 chars. Copy" +
    " server/.env.example to server/.env and replace the dev value" +
    " with a strong secret in prod (e.g. `openssl rand -base64 48`).",
  );
}

const graceRaw = process.env.REFRESH_GRACE_WINDOW_SECONDS ?? "30";
const graceSeconds = Number.parseInt(graceRaw, 10);
if (!Number.isFinite(graceSeconds) || graceSeconds < 0) {
  throw new Error(
    `REFRESH_GRACE_WINDOW_SECONDS must be a non-negative integer; got ${graceRaw}`,
  );
}

export const authEnv = {
  jwtSecret,
  accessTokenTtl:  process.env.ACCESS_TOKEN_TTL  ?? "15m",
  refreshTokenTtl: process.env.REFRESH_TOKEN_TTL ?? "30d",
  refreshGraceWindowSeconds: graceSeconds,
  cookieSecure: process.env.COOKIE_SECURE === "true",
  isProd: process.env.NODE_ENV === "production",
} as const;

export type AuthEnv = typeof authEnv;

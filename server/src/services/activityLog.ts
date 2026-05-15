/* activity_log service — Phase 7 Step 3.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_3_PLAN.md §6.
 *
 * This layer sits between the repository (mechanical SQL + RLS) and the
 * audit hooks that will land in later commits. Two responsibilities:
 *
 *   1. Sanitize the payload before any write.
 *      - Reject non-plain objects.
 *      - Reject forbidden key names (token / secret / password / ciphertext
 *        / key / raw) anywhere in the payload tree — including nested
 *        objects and array items.
 *      - Allow a small exact-match safe list (`auth_token_id`) because
 *        the substring rule would catch it under "token".
 *      - Drop top-level / nested `undefined` values.
 *      - Convert `Date` to an ISO string.
 *      - Truncate long strings to PAYLOAD_STRING_MAX chars.
 *      - Reject Buffer / function / symbol / bigint / NaN / Infinity —
 *        none of these have a stable JSON shape and most carry
 *        sensitive-value risk (Buffer especially: ciphertext, hashes,
 *        binary tokens).
 *
 *   2. Provide two call shapes for the hook layer:
 *
 *        recordActivity(client, input): Promise<void>
 *           throw-on-failure. Use inside the same transaction as the
 *           mutation. Sanitizer error → throws SanitizeError(400-ish).
 *           DB error (RLS / CHECK) → bubbles up so the caller rolls back.
 *
 *        tryRecordActivity(client, input): Promise<boolean>
 *           best-effort. Wraps the insert in a SAVEPOINT so a DB-level
 *           failure does NOT poison the outer transaction. Returns false
 *           on any failure (sanitizer or DB). Reserved for genuinely
 *           low-risk reads such as `report.team_viewed`. Per plan, do
 *           NOT spray console logs from this path in Step 3.
 *
 * Sensitive-value hygiene: SanitizeError messages describe the offending
 * path and rule only (e.g., `payload.data.secret`). They never echo
 * payload values, original strings, or secret/token-like content.
 */
import type { PoolClient } from "pg";
import {
  insertActivity,
  insertActivityVoid,
  type ActivityAction,
  type ActivityTargetType,
} from "../repositories/activityLog.js";

// Re-export so hook callers depend on one module.
export type { ActivityAction, ActivityTargetType };

// ============================================================ //
// Constants
// ============================================================ //

/** Maximum string length permitted anywhere in a payload value before
 *  truncation. Audit values should be short identifiers / labels /
 *  enum names — long blobs (transcripts, prompts, raw bodies) are
 *  forbidden by policy. The cap is also a defense-in-depth ceiling
 *  against a caller accidentally embedding an oversized blob. */
export const PAYLOAD_STRING_MAX = 500;

/** Case-insensitive whole-word tokens that mark a payload key as
 *  sensitive. A key is split on `_` and camelCase boundaries, lower-
 *  cased, and matched part-by-part against this set. Substring match
 *  on the raw key would over-block (`drawer` contains `raw`), so the
 *  word-split approach is both stricter (catches `apiKey`, `csrf_token`)
 *  and narrower (doesn't trip on incidental substrings). */
const FORBIDDEN_KEY_TOKENS = new Set([
  "token",
  "secret",
  "password",
  "ciphertext",
  "key",
  "raw",
]);

/** Exact-match exceptions to the forbidden-key rule. Plan §6 calls out
 *  `auth_token_id` specifically — the id of an `auth_tokens` row is
 *  safe to record (it's an opaque uuid, not a credential). Token-id
 *  short form (`token_id`) is deliberately NOT exempt; callers should
 *  prefer the prefixed form so the audience of the audit payload can
 *  tell which token model the id refers to. */
const SAFE_KEY_EXACT = new Set([
  "auth_token_id",
]);

// ============================================================ //
// Errors
// ============================================================ //

export class ActivityPayloadSanitizeError extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string, message: string) {
    super(message);
    this.name = "ActivityPayloadSanitizeError";
    this.code = code;
    this.path = path;
  }
}

// ============================================================ //
// Sanitizer
// ============================================================ //

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  // Reject class instances (Map, Set, Buffer, Date, custom classes, etc.)
  // by requiring the prototype be Object.prototype or null. Date is then
  // handled specially upstream of this check.
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Split `csrfToken` / `auth_token_id` into ['csrf', 'token'] / ['auth',
 *  'token', 'id']. Used to test individual word parts against the
 *  forbidden-token set. Empty parts (e.g. leading `_`) are filtered out. */
function splitKeyToWords(key: string): string[] {
  // Convert camelCase to snake_case-style boundaries, then split.
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return normalized
    .split("_")
    .map((s) => s.toLowerCase())
    .filter((s) => s.length > 0);
}

function isForbiddenKey(key: string): boolean {
  if (SAFE_KEY_EXACT.has(key)) return false;
  for (const word of splitKeyToWords(key)) {
    if (FORBIDDEN_KEY_TOKENS.has(word)) return true;
  }
  return false;
}

/** Recursively sanitize one value. `path` is the dotted/bracketed key
 *  path used in error messages only. Returns the sanitized value, or
 *  the `MISSING` sentinel when the value should be omitted from its
 *  parent (currently only `undefined`). */
const MISSING = Symbol("payload-omit");
type SanitizeResult = unknown | typeof MISSING;

function sanitizeValue(value: unknown, path: string): SanitizeResult {
  // undefined → omit (top-level callers also handle this).
  if (value === undefined) return MISSING;

  // null and primitives.
  if (value === null) return null;

  const t = typeof value;

  // bigint / function / symbol — explicitly rejected.
  if (t === "bigint" || t === "function" || t === "symbol") {
    throw new ActivityPayloadSanitizeError(
      "unsupported_value_type",
      path,
      `audit payload contains an unsupported value type at ${path}`,
    );
  }

  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new ActivityPayloadSanitizeError(
        "non_finite_number",
        path,
        `audit payload contains a non-finite number at ${path}`,
      );
    }
    return value;
  }

  if (t === "boolean") return value;

  if (t === "string") {
    const s = value as string;
    return s.length > PAYLOAD_STRING_MAX ? s.slice(0, PAYLOAD_STRING_MAX) : s;
  }

  // Reject Buffer up-front — instanceof works for Node Buffers + every
  // TypedArray. Buffers commonly carry encrypted bytes / hashes / raw
  // tokens, which is exactly what the sanitizer must keep out.
  if (
    typeof Buffer !== "undefined" && Buffer.isBuffer(value)
    || ArrayBuffer.isView(value)
    || value instanceof ArrayBuffer
  ) {
    throw new ActivityPayloadSanitizeError(
      "unsupported_value_type",
      path,
      `audit payload contains a binary value at ${path}`,
    );
  }

  // Date → ISO string. Done before isPlainObject() because Date has a
  // non-Object prototype.
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new ActivityPayloadSanitizeError(
        "invalid_date",
        path,
        `audit payload contains an invalid Date at ${path}`,
      );
    }
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      const v = sanitizeValue(value[i], `${path}[${i}]`);
      // Drop undefined entries to keep array indexing predictable. The
      // alternative (storing `null`) would silently change array length
      // semantics for callers that read by index.
      if (v !== MISSING) out.push(v);
    }
    return out;
  }

  if (isPlainObject(value)) {
    return sanitizeObject(value, path);
  }

  // Anything else — Map, Set, class instance with a non-Object prototype,
  // etc. Refuse rather than guess at a JSON shape.
  throw new ActivityPayloadSanitizeError(
    "unsupported_value_type",
    path,
    `audit payload contains an unsupported object type at ${path}`,
  );
}

function sanitizeObject(
  obj: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const childPath = path === "payload"
      ? `payload.${key}`
      : `${path}.${key}`;

    if (isForbiddenKey(key)) {
      throw new ActivityPayloadSanitizeError(
        "forbidden_key",
        childPath,
        `audit payload contains a forbidden key at ${childPath}`,
      );
    }

    const v = sanitizeValue(obj[key], childPath);
    if (v !== MISSING) {
      out[key] = v;
    }
  }
  return out;
}

/** Entry point. Returns a fresh object that satisfies the audit payload
 *  contract or throws ActivityPayloadSanitizeError. */
export function sanitizeActivityPayload(
  payload: unknown,
): Record<string, unknown> {
  if (payload === undefined || payload === null) return {};
  if (!isPlainObject(payload)) {
    throw new ActivityPayloadSanitizeError(
      "non_object_payload",
      "payload",
      "audit payload must be a plain object",
    );
  }
  return sanitizeObject(payload, "payload");
}

// ============================================================ //
// recordActivity / tryRecordActivity
// ============================================================ //

export interface RecordActivityInput {
  orgId:        string;
  actorUserId?: string | null;
  action:       ActivityAction;
  targetType?:  ActivityTargetType | null;
  targetId?:    string | null;
  payload?:     Record<string, unknown>;
}

/** Insert one audit row in the caller's transaction.
 *
 * Sanitizer failure → throws ActivityPayloadSanitizeError BEFORE any SQL
 * runs, so the outer transaction is untouched and the caller can choose
 * to surface as 500 (programmer error — sensitive value leaked into
 * payload) or 400 if the audit input came from user data.
 *
 * DB failure (RLS WITH CHECK, action CHECK, target_type CHECK,
 * payload_object CHECK, FK) → repository throws and the outer
 * transaction is left in a failed state. The caller must rollback.
 * That is the contract for high-risk mutations: audit failure aborts
 * the whole unit of work.
 */
export async function recordActivity(
  client: PoolClient,
  input: RecordActivityInput,
): Promise<void> {
  const safePayload = sanitizeActivityPayload(input.payload);
  await insertActivity(client, {
    orgId:      input.orgId,
    userId:     input.actorUserId ?? null,
    action:     input.action,
    targetType: input.targetType ?? null,
    targetId:   input.targetId ?? null,
    payload:    safePayload,
  });
}

/** Same contract as `recordActivity`, but for service-pool transactions
 *  whose role has INSERT-only privilege on `activity_log`.
 *
 *  The `kloser_service` runtime role (migration `1715000025000_phase7_
 *  activity_log_service_insert_grant.sql`) is intentionally granted
 *  INSERT only — no SELECT/UPDATE/DELETE — per plan §3.2. PostgreSQL
 *  evaluates `INSERT ... RETURNING` against SELECT as well, so the
 *  app-pool `recordActivity()` path (which uses `insertActivity()` with
 *  RETURNING) fails with `permission denied for table activity_log`
 *  even for permitted INSERTs.
 *
 *  `recordActivityVoid()` is the service-pool entry point:
 *    - same sanitizer (sanitizeActivityPayload), same forbidden-key /
 *      truncation / Date-normalisation rules,
 *    - same transactional contract — sanitizer error throws before any
 *      SQL, DB failure bubbles up so the caller's servicePool
 *      transaction rolls back,
 *    - calls `insertActivityVoid()` (no RETURNING) so INSERT-only
 *      privilege is enough.
 *
 *  Use from anonymous login-time MFA flows in `services/auth.ts`
 *  (verifyLoginMfa / setupLoginMfaChallenge / confirmLoginMfaChallenge).
 *  App-pool callers should keep using `recordActivity()`.
 */
export async function recordActivityVoid(
  client: PoolClient,
  input: RecordActivityInput,
): Promise<void> {
  const safePayload = sanitizeActivityPayload(input.payload);
  await insertActivityVoid(client, {
    orgId:      input.orgId,
    userId:     input.actorUserId ?? null,
    action:     input.action,
    targetType: input.targetType ?? null,
    targetId:   input.targetId ?? null,
    payload:    safePayload,
  });
}

/** Best-effort variant — never throws, returns boolean.
 *
 * Wraps the INSERT in a SAVEPOINT so a DB-level failure (RLS reject,
 * CHECK violation, FK miss) does NOT leave the outer transaction in
 * a failed state. The savepoint is released on success or rolled back
 * to on failure; either way the caller's transaction remains usable.
 *
 * Reserved for genuinely low-risk reads where it is OK to lose an
 * audit row rather than abort the user's request (plan §6, §7.4 —
 * `report.team_viewed`). DO NOT use for security-sensitive events.
 *
 * Step 3 policy: no console logging from this path. If observability
 * is needed later, surface a metrics counter / lint warning instead
 * of stderr noise.
 */
export async function tryRecordActivity(
  client: PoolClient,
  input: RecordActivityInput,
): Promise<boolean> {
  let safePayload: Record<string, unknown>;
  try {
    safePayload = sanitizeActivityPayload(input.payload);
  } catch (_err) {
    return false;
  }

  // SAVEPOINT lets us localise any DB-level failure (RLS, CHECK, FK)
  // without poisoning the caller's transaction. A unique-ish name
  // avoids collision when tryRecordActivity is called twice in the
  // same transaction.
  const sp = `activity_log_try_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  try {
    await client.query(`SAVEPOINT ${sp}`);
  } catch (_err) {
    return false;
  }

  try {
    await insertActivity(client, {
      orgId:      input.orgId,
      userId:     input.actorUserId ?? null,
      action:     input.action,
      targetType: input.targetType ?? null,
      targetId:   input.targetId ?? null,
      payload:    safePayload,
    });
    await client.query(`RELEASE SAVEPOINT ${sp}`);
    return true;
  } catch (_err) {
    // ROLLBACK TO SAVEPOINT keeps the outer transaction alive. PostgreSQL
    // keeps the savepoint defined after rollback, so release it as well to
    // avoid accumulating savepoints in a long-running caller transaction.
    // If cleanup fails, the caller's transaction is already in trouble and
    // this best-effort helper still returns false.
    try {
      await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      await client.query(`RELEASE SAVEPOINT ${sp}`);
    } catch (_) { /* empty */ }
    return false;
  }
}

// ============================================================ //
// Event-specific helpers
//
// Keep this list small for Step 3 — only the security / org / member-
// ship hooks that the next commit will wire. Adding new helpers should
// be paired with their hook in the same commit so unused helpers don't
// rot in the tree.
// ============================================================ //

export type MfaMethod = "totp" | "webauthn" | "recovery_code";

export interface RecordMfaEnabledInput {
  orgId:        string;
  actorUserId:  string;
  targetUserId: string;
  method:       MfaMethod;
}

/** mfa.enabled — user finished MFA enrollment.
 *
 * The actor is usually the same user as the target (self-enrollment).
 * If an admin one day forces MFA enrollment on someone else, the actor
 * is the admin and target is the affected user — the row distinguishes
 * the two via user_id (actor) vs target_id (subject).
 */
export async function recordMfaEnabled(
  client: PoolClient,
  input: RecordMfaEnabledInput,
): Promise<void> {
  await recordActivity(client, {
    orgId:       input.orgId,
    actorUserId: input.actorUserId,
    action:      "mfa.enabled",
    targetType:  "user",
    targetId:    input.targetUserId,
    payload:     { method: input.method },
  });
}

export interface RecordMfaDisabledInput {
  orgId:        string;
  actorUserId:  string;
  targetUserId: string;
  method:       MfaMethod;
}

/** mfa.disabled — user removed their MFA factor. */
export async function recordMfaDisabled(
  client: PoolClient,
  input: RecordMfaDisabledInput,
): Promise<void> {
  await recordActivity(client, {
    orgId:       input.orgId,
    actorUserId: input.actorUserId,
    action:      "mfa.disabled",
    targetType:  "user",
    targetId:    input.targetUserId,
    payload:     { method: input.method },
  });
}

export interface RecordOrgMfaRequiredChangedInput {
  orgId:                    string;
  actorUserId:              string;
  required:                 boolean;
  membersWithoutMfaCount?:  number;
}

/** organization.mfa_required_enabled / disabled — admin flipped the
 *  org-wide toggle. `members_without_mfa_count` is recorded when the
 *  service already computed it for the response, so the audit row
 *  captures the operational impact at the moment of the change. */
export async function recordOrgMfaRequiredChanged(
  client: PoolClient,
  input: RecordOrgMfaRequiredChangedInput,
): Promise<void> {
  const payload: Record<string, unknown> = {};
  if (typeof input.membersWithoutMfaCount === "number") {
    payload.members_without_mfa_count = input.membersWithoutMfaCount;
  }
  await recordActivity(client, {
    orgId:       input.orgId,
    actorUserId: input.actorUserId,
    action: input.required
      ? "organization.mfa_required_enabled"
      : "organization.mfa_required_disabled",
    targetType:  "organization",
    targetId:    input.orgId,
    payload,
  });
}

export type MembershipRole = "admin" | "manager" | "employee" | "viewer";

export interface RecordMembershipRoleChangedInput {
  orgId:        string;
  actorUserId:  string;
  membershipId: string;
  fromRole:     MembershipRole;
  toRole:       MembershipRole;
}

/** membership.role_changed — admin promoted/demoted another member.
 *
 * payload carries the before/after role names. The target user's id
 * is intentionally NOT in the payload — the target_id (membership)
 * is the canonical pointer; recipients of the audit feed dereference
 * memberships → users themselves.
 */
export async function recordMembershipRoleChanged(
  client: PoolClient,
  input: RecordMembershipRoleChangedInput,
): Promise<void> {
  await recordActivity(client, {
    orgId:       input.orgId,
    actorUserId: input.actorUserId,
    action:      "membership.role_changed",
    targetType:  "membership",
    targetId:    input.membershipId,
    payload: {
      from_role: input.fromRole,
      to_role:   input.toRole,
    },
  });
}

/* Recording storage adapter boundary — Phase 8 Step 2.
 *
 * Plan: docs/plan/phase-8/PHASE_8_STEP_2_PLAN.md §4.
 *
 * The adapter owns object storage operations. The repository
 * (callRecordings.ts) owns DB metadata. The two never share state — the
 * route/service layer (Phase 8 Step 3) glues them together with the
 * recording row id as the join key.
 *
 * Three providers are resolvable from env:
 *
 *   RECORDING_STORAGE_PROVIDER = local | s3 | minio
 *
 *     local  — filesystem-backed provider with strict object-key
 *              path-traversal protection. Default in dev/test. No
 *              network. Used by repository/storage tests and the local
 *              run path.
 *
 *     s3     — AWS S3-compatible bucket. Step 2 validates the full env
 *              contract and returns a sentinel adapter whose put/get/
 *              url methods throw a typed `not_implemented_step_2` error.
 *              The real client lands in Step 3 alongside the upload/
 *              finalize/playback routes, which is the first caller.
 *
 *     minio  — MinIO. Same sentinel pattern, but additionally requires
 *              RECORDING_STORAGE_ENDPOINT.
 *
 * Sensitive-value policy (plan §4 / §8):
 *
 *   - error messages, error names, and thrown classes never echo
 *     `bucket`, `objectKey`, signed URL contents, request body bytes,
 *     access key id, secret access key, session token, or endpoint URL.
 *
 *   - missing-env messages enumerate missing keys by NAME only.
 *
 *   - unknown provider messages echo the supported set, not the raw
 *     provided value (it might be a leaked secret pasted by mistake).
 *
 *   - storage operation errors carry a stable machine `code` so the
 *     route layer can map to HTTP status without parsing the message.
 *
 * Signed URLs are short-lived and bounded:
 *
 *   - playback default 5 min, upload default 10 min, hard cap 15 min.
 *   - adapters reject `expiresInSeconds <= 0` or > 900.
 *   - the URL itself never appears in audit/log/error messages.
 *
 * `RECORDING_STORAGE_PUBLIC_BASE_URL` (local provider) returns a URL
 * shape only for contract testing. There is no route serving it in
 * Step 2; Step 3 owns playback URL exposure.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  RecordingContentType,
  RecordingStorageProvider,
} from "../repositories/callRecordings.js";

// ============================================================ //
// Error classes
// ============================================================ //

// Misconfiguration discovered at boot (missing env, unknown provider,
// bad TTL). Surfaces should treat this as fatal-at-boot, not a runtime
// 4xx. We do not echo any values that came from process.env.
export class RecordingStorageConfigError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RecordingStorageConfigError";
    this.code = code;
  }
}

// Invalid caller input that the adapter refused before touching
// storage (empty bucket where bucket is required, traversal in object
// key, ttl out of range, body too large). 4xx-class at the route layer.
export class RecordingStorageInputError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RecordingStorageInputError";
    this.code = code;
  }
}

// Operation against the storage backend failed (not found, transient
// upstream, permanent provider error). The route layer maps `code` to
// HTTP. Messages avoid object_key/bucket/body content; pass a short
// stable string only.
export class RecordingStorageOperationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RecordingStorageOperationError";
    this.code = code;
  }
}

// ============================================================ //
// Adapter interface
// ============================================================ //

export interface RecordingObjectRef {
  bucket: string | null;
  objectKey: string;
}

export interface SignedStorageUrl {
  url: string;
  method: "GET" | "PUT";
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface CreateRecordingUploadUrlInput extends RecordingObjectRef {
  contentType: RecordingContentType;
  expiresInSeconds: number;
  checksumSha256?: string | null;
  sizeBytes?: number | null;
}

export interface CreateRecordingReadUrlInput extends RecordingObjectRef {
  expiresInSeconds: number;
  responseContentType?: RecordingContentType | null;
}

export interface PutRecordingObjectInput extends RecordingObjectRef {
  contentType: RecordingContentType;
  body: Buffer | Uint8Array;
  checksumSha256?: string | null;
}

export interface PutRecordingObjectResult {
  objectVersion: string | null;
  sizeBytes: number;
  checksumSha256: string | null;
}

export interface DeleteRecordingObjectInput extends RecordingObjectRef {
  objectVersion?: string | null;
}

export interface RecordingStorageAdapter {
  provider: RecordingStorageProvider;
  createUploadUrl(
    input: CreateRecordingUploadUrlInput,
  ): Promise<SignedStorageUrl>;
  createReadUrl(input: CreateRecordingReadUrlInput): Promise<SignedStorageUrl>;
  putObject(input: PutRecordingObjectInput): Promise<PutRecordingObjectResult>;
  deleteObject(input: DeleteRecordingObjectInput): Promise<void>;
}

// ============================================================ //
// TTL policy
// ============================================================ //

export const RECORDING_UPLOAD_TTL_DEFAULT_SECONDS = 600;
export const RECORDING_READ_TTL_DEFAULT_SECONDS = 300;
export const RECORDING_URL_TTL_MAX_SECONDS = 900;

function assertTtl(expiresInSeconds: number): void {
  if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
    throw new RecordingStorageInputError(
      "ttl_invalid",
      "expiresInSeconds must be a positive number",
    );
  }
  if (expiresInSeconds > RECORDING_URL_TTL_MAX_SECONDS) {
    throw new RecordingStorageInputError(
      "ttl_too_long",
      `expiresInSeconds must be <= ${RECORDING_URL_TTL_MAX_SECONDS}`,
    );
  }
}

// ============================================================ //
// Object key contract
// ============================================================ //

const CONTENT_TYPE_EXT: Record<RecordingContentType, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
};

export function buildRecordingObjectKey(input: {
  orgId: string;
  callId: string;
  recordingId: string;
  contentType: RecordingContentType;
  now: Date;
}): string {
  if (!isUuidish(input.orgId)) {
    throw new RecordingStorageInputError(
      "object_key_input_invalid",
      "orgId must be a uuid",
    );
  }
  if (!isUuidish(input.callId)) {
    throw new RecordingStorageInputError(
      "object_key_input_invalid",
      "callId must be a uuid",
    );
  }
  if (!isUuidish(input.recordingId)) {
    throw new RecordingStorageInputError(
      "object_key_input_invalid",
      "recordingId must be a uuid",
    );
  }
  const ext = CONTENT_TYPE_EXT[input.contentType];
  if (!ext) {
    throw new RecordingStorageInputError(
      "object_key_input_invalid",
      "unsupported contentType",
    );
  }
  // ISO 8601 basic format (no separators), keeps the trailing 'Z'. Safe
  // in S3 object keys and unambiguous when scanning audit / listings.
  const stamp = input.now.toISOString().replace(/[-:.]/g, "");
  return `orgs/${input.orgId}/calls/${input.callId}/recordings/${input.recordingId}/${stamp}-original.${ext}`;
}

// Permissive uuid check identical to the customers repository (see
// AGENTS.md). Tightening to strict zod uuid would require migrating
// seed UUIDs and is out of scope here.
function isUuidish(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    s,
  );
}

// ============================================================ //
// Object key safety
// ============================================================ //

const OBJECT_KEY_MAX_LENGTH = 1024;

// Validate before any filesystem or signed-URL operation. We reject:
//   - empty
//   - absolute paths and Windows drive prefixes (`/foo`, `C:\foo`)
//   - `..` segments (path traversal)
//   - explicit url-encoded traversal (`%2e%2e`)
//   - backslashes (treat as path separator on Windows)
//   - control characters
//   - keys longer than OBJECT_KEY_MAX_LENGTH
// Error messages do NOT echo the offending key.
function assertSafeObjectKey(objectKey: string): void {
  if (typeof objectKey !== "string" || objectKey.length === 0) {
    throw new RecordingStorageInputError(
      "object_key_empty",
      "objectKey must be a non-empty string",
    );
  }
  if (objectKey.length > OBJECT_KEY_MAX_LENGTH) {
    throw new RecordingStorageInputError(
      "object_key_too_long",
      `objectKey must be <= ${OBJECT_KEY_MAX_LENGTH} chars`,
    );
  }
  if (/[\u0000-\u001f\u007f]/.test(objectKey)) {
    throw new RecordingStorageInputError(
      "object_key_invalid",
      "objectKey must not contain control characters",
    );
  }
  if (objectKey.includes("\\")) {
    throw new RecordingStorageInputError(
      "object_key_invalid",
      "objectKey must not contain backslashes",
    );
  }
  if (/^([a-zA-Z]:)?[\\/]/.test(objectKey)) {
    throw new RecordingStorageInputError(
      "object_key_invalid",
      "objectKey must be relative",
    );
  }
  const lowered = objectKey.toLowerCase();
  if (lowered.includes("%2e%2e")) {
    throw new RecordingStorageInputError(
      "object_key_invalid",
      "objectKey must not contain encoded traversal",
    );
  }
  for (const segment of objectKey.split("/")) {
    if (segment === "..") {
      throw new RecordingStorageInputError(
        "object_key_invalid",
        "objectKey must not contain '..' segments",
      );
    }
    if (segment === "" && objectKey !== segment) {
      // empty segment from double-slash like `a//b` — disallow so the
      // path resolves predictably across providers
      throw new RecordingStorageInputError(
        "object_key_invalid",
        "objectKey must not contain empty path segments",
      );
    }
  }
}

// ============================================================ //
// Local filesystem provider
// ============================================================ //

export interface LocalRecordingStorageConfig {
  rootDir: string;
  publicBaseUrl: string | null;
  // Allows tests to freeze `Date.now()`. Default is `Date.now`.
  now?: () => number;
}

class LocalRecordingStorageAdapter implements RecordingStorageAdapter {
  readonly provider = "local" as const;
  private readonly rootDir: string;
  private readonly publicBaseUrl: string | null;
  private readonly now: () => number;

  constructor(config: LocalRecordingStorageConfig) {
    if (!config.rootDir || config.rootDir.trim() === "") {
      throw new RecordingStorageConfigError(
        "local_root_missing",
        "local provider requires rootDir",
      );
    }
    this.rootDir = path.resolve(config.rootDir);
    this.publicBaseUrl = config.publicBaseUrl?.trim() || null;
    this.now = config.now ?? Date.now;
  }

  // resolveAbsolutePath enforces that the resolved filesystem path stays
  // inside rootDir even after path.resolve normalization. This is the
  // second layer behind assertSafeObjectKey — the first layer rejects
  // the malicious shapes, this one defends against any escape that
  // slipped through.
  private resolveAbsolutePath(objectKey: string): string {
    assertSafeObjectKey(objectKey);
    const absolute = path.resolve(this.rootDir, objectKey);
    const rel = path.relative(this.rootDir, absolute);
    if (
      rel === ".." ||
      rel.startsWith(`..${path.sep}`) ||
      path.isAbsolute(rel)
    ) {
      throw new RecordingStorageInputError(
        "object_key_traversal",
        "objectKey resolved outside storage root",
      );
    }
    return absolute;
  }

  async createUploadUrl(
    input: CreateRecordingUploadUrlInput,
  ): Promise<SignedStorageUrl> {
    assertTtl(input.expiresInSeconds);
    assertSafeObjectKey(input.objectKey);
    return {
      url: this.buildLocalUrl(input.objectKey, input.expiresInSeconds, "PUT"),
      method: "PUT",
      headers: { "Content-Type": input.contentType },
      expiresAt: new Date(this.now() + input.expiresInSeconds * 1000),
    };
  }

  async createReadUrl(
    input: CreateRecordingReadUrlInput,
  ): Promise<SignedStorageUrl> {
    assertTtl(input.expiresInSeconds);
    assertSafeObjectKey(input.objectKey);
    return {
      url: this.buildLocalUrl(input.objectKey, input.expiresInSeconds, "GET"),
      method: "GET",
      headers: {},
      expiresAt: new Date(this.now() + input.expiresInSeconds * 1000),
    };
  }

  async putObject(
    input: PutRecordingObjectInput,
  ): Promise<PutRecordingObjectResult> {
    const absolute = this.resolveAbsolutePath(input.objectKey);
    const body = Buffer.isBuffer(input.body)
      ? input.body
      : Buffer.from(input.body);
    if (input.checksumSha256) {
      const actual = createHash("sha256").update(body).digest("hex");
      if (actual !== input.checksumSha256.toLowerCase()) {
        throw new RecordingStorageInputError(
          "checksum_mismatch",
          "body checksum did not match the provided checksumSha256",
        );
      }
    }
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, body);
    const checksum = createHash("sha256").update(body).digest("hex");
    return {
      objectVersion: null,
      sizeBytes: body.length,
      checksumSha256: checksum,
    };
  }

  async deleteObject(input: DeleteRecordingObjectInput): Promise<void> {
    const absolute = this.resolveAbsolutePath(input.objectKey);
    try {
      await rm(absolute, { force: false });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new RecordingStorageOperationError(
          "storage_object_not_found",
          "object not found",
        );
      }
      throw new RecordingStorageOperationError(
        "storage_delete_failed",
        "object delete failed",
      );
    }
  }

  // Internal helper used by put/delete tests; not part of the public
  // adapter interface (production reads happen through signed URLs).
  async _readForTest(objectKey: string): Promise<Buffer> {
    const absolute = this.resolveAbsolutePath(objectKey);
    try {
      return await readFile(absolute);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new RecordingStorageOperationError(
          "storage_object_not_found",
          "object not found",
        );
      }
      throw err;
    }
  }

  async _existsForTest(objectKey: string): Promise<boolean> {
    const absolute = this.resolveAbsolutePath(objectKey);
    try {
      await stat(absolute);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  private buildLocalUrl(
    objectKey: string,
    expiresInSeconds: number,
    _method: "GET" | "PUT",
  ): string {
    const expires = Math.floor(this.now() / 1000) + expiresInSeconds;
    const base = this.publicBaseUrl ?? "http://localhost.invalid/recordings";
    const trimmed = base.replace(/\/+$/, "");
    return `${trimmed}/${encodeURI(objectKey)}?expires=${expires}`;
  }
}

// ============================================================ //
// S3-compatible config + sentinel adapter
// ============================================================ //

export interface S3CompatibleRecordingStorageConfig {
  provider: "s3" | "minio";
  bucket: string;
  region: string;
  endpoint: string | null;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string | null;
  forcePathStyle: boolean;
}

const S3_BASE_REQUIRED = [
  ["bucket", "RECORDING_STORAGE_BUCKET"],
  ["region", "RECORDING_STORAGE_REGION"],
  ["accessKeyId", "RECORDING_STORAGE_ACCESS_KEY_ID"],
  ["secretAccessKey", "RECORDING_STORAGE_SECRET_ACCESS_KEY"],
] as const;

// Throws RecordingStorageConfigError("missing_env", "<KEY1>, <KEY2>")
// where <KEY*> are env var NAMES only — never their values.
export function readS3CompatibleConfigFromEnv(
  provider: "s3" | "minio",
  env: NodeJS.ProcessEnv = process.env,
): S3CompatibleRecordingStorageConfig {
  const missing: string[] = [];
  const get = (key: string): string | null => {
    const raw = env[key];
    return raw && raw.trim() !== "" ? raw.trim() : null;
  };

  const bucket = get("RECORDING_STORAGE_BUCKET");
  const region = get("RECORDING_STORAGE_REGION");
  const accessKeyId = get("RECORDING_STORAGE_ACCESS_KEY_ID");
  const secretAccessKey = get("RECORDING_STORAGE_SECRET_ACCESS_KEY");
  const endpoint = get("RECORDING_STORAGE_ENDPOINT");
  const sessionToken = get("RECORDING_STORAGE_SESSION_TOKEN");

  if (!bucket) missing.push("RECORDING_STORAGE_BUCKET");
  if (!region) missing.push("RECORDING_STORAGE_REGION");
  if (!accessKeyId) missing.push("RECORDING_STORAGE_ACCESS_KEY_ID");
  if (!secretAccessKey) missing.push("RECORDING_STORAGE_SECRET_ACCESS_KEY");
  if (provider === "minio" && !endpoint) {
    missing.push("RECORDING_STORAGE_ENDPOINT");
  }
  if (missing.length > 0) {
    throw new RecordingStorageConfigError(
      "missing_env",
      `RECORDING_STORAGE_PROVIDER=${provider} requires env: ${missing.join(", ")}`,
    );
  }

  // forcePathStyle: explicit override, else default true for minio, false for s3.
  const forcePathStyleRaw = get("RECORDING_STORAGE_FORCE_PATH_STYLE");
  const forcePathStyle =
    forcePathStyleRaw === null
      ? provider === "minio"
      : forcePathStyleRaw.toLowerCase() === "true";

  return {
    provider,
    bucket: bucket!,
    region: region!,
    endpoint: endpoint,
    accessKeyId: accessKeyId!,
    secretAccessKey: secretAccessKey!,
    sessionToken,
    forcePathStyle,
  };
}

// Sentinel adapter. Step 2 closes env validation and the boundary; the
// actual presigner / SDK landing happens in Step 3 alongside the route
// that needs it. Method calls throw a stable code that callers can
// detect and the cap test asserts. Bucket / object key / credential
// values are never echoed.
class S3CompatibleSentinelAdapter implements RecordingStorageAdapter {
  readonly provider: "s3" | "minio";
  // Held for the Step 3 client landing. Validated already by
  // readS3CompatibleConfigFromEnv. Marked readonly to keep an audit-only
  // call from mutating.
  readonly config: S3CompatibleRecordingStorageConfig;

  constructor(config: S3CompatibleRecordingStorageConfig) {
    this.provider = config.provider;
    this.config = config;
  }

  async createUploadUrl(): Promise<SignedStorageUrl> {
    throw S3CompatibleSentinelAdapter.unimplemented("createUploadUrl");
  }
  async createReadUrl(): Promise<SignedStorageUrl> {
    throw S3CompatibleSentinelAdapter.unimplemented("createReadUrl");
  }
  async putObject(): Promise<PutRecordingObjectResult> {
    throw S3CompatibleSentinelAdapter.unimplemented("putObject");
  }
  async deleteObject(): Promise<void> {
    throw S3CompatibleSentinelAdapter.unimplemented("deleteObject");
  }

  private static unimplemented(method: string): RecordingStorageOperationError {
    return new RecordingStorageOperationError(
      "not_implemented_step_2",
      `S3-compatible adapter '${method}' is not implemented in Phase 8 Step 2; routes/SDK arrive in Step 3.`,
    );
  }
}

// ============================================================ //
// Resolver
// ============================================================ //

const SUPPORTED_PROVIDERS = ["local", "s3", "minio"] as const;

function readProvider(env: NodeJS.ProcessEnv): RecordingStorageProvider | null {
  const raw = env.RECORDING_STORAGE_PROVIDER;
  if (!raw || raw.trim() === "") return null;
  const provider = raw.trim().toLowerCase();
  if (!SUPPORTED_PROVIDERS.includes(provider as RecordingStorageProvider)) {
    // Do NOT echo the raw value — it could be a pasted secret.
    throw new RecordingStorageConfigError(
      "provider_unknown",
      `RECORDING_STORAGE_PROVIDER is not one of: ${SUPPORTED_PROVIDERS.join(", ")}`,
    );
  }
  return provider as RecordingStorageProvider;
}

export interface ResolveRecordingStorageOptions {
  env?: NodeJS.ProcessEnv;
}

export function resolveRecordingStorageAdapter(
  options: ResolveRecordingStorageOptions = {},
): RecordingStorageAdapter {
  const env = options.env ?? process.env;
  const provider = readProvider(env);
  const nodeEnv = (env.NODE_ENV ?? "").trim().toLowerCase();

  if (provider === null) {
    if (nodeEnv === "production") {
      throw new RecordingStorageConfigError(
        "missing_env",
        "RECORDING_STORAGE_PROVIDER must be set in production",
      );
    }
    // Dev/test default: local provider rooted at .data/recordings under
    // the cwd. Tests usually inject an explicit rootDir so we never
    // touch a developer's actual filesystem location at import time.
    return new LocalRecordingStorageAdapter({
      rootDir:
        (env.RECORDING_STORAGE_LOCAL_ROOT ?? "").trim() || ".data/recordings",
      publicBaseUrl:
        (env.RECORDING_STORAGE_PUBLIC_BASE_URL ?? "").trim() || null,
    });
  }

  if (provider === "local") {
    return new LocalRecordingStorageAdapter({
      rootDir:
        (env.RECORDING_STORAGE_LOCAL_ROOT ?? "").trim() || ".data/recordings",
      publicBaseUrl:
        (env.RECORDING_STORAGE_PUBLIC_BASE_URL ?? "").trim() || null,
    });
  }

  const config = readS3CompatibleConfigFromEnv(provider, env);
  return new S3CompatibleSentinelAdapter(config);
}

// ============================================================ //
// Factories (test-friendly)
// ============================================================ //

export function createLocalRecordingStorageAdapter(
  config: LocalRecordingStorageConfig,
): RecordingStorageAdapter {
  return new LocalRecordingStorageAdapter(config);
}

export function createS3CompatibleSentinelAdapter(
  config: S3CompatibleRecordingStorageConfig,
): RecordingStorageAdapter {
  return new S3CompatibleSentinelAdapter(config);
}

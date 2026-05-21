/* Dev-only local recording storage URL handler — Phase 9 Step 6.
 *
 * Plan: docs/plan/phase-9/PHASE_9_STEP_6_PLAN.md §3.2 / §6.1.
 *
 * Phase 8 LocalRecordingStorageAdapter returns signed URL shapes like
 * `<RECORDING_STORAGE_PUBLIC_BASE_URL>/<objectKey>?expires=<unix>` but
 * there is no HTTP handler that actually serves them. Step 6 manual E2E
 * requires the desktop archive bridge to PUT and then play back through
 * the same backend that minted the URL, so this module fills that gap
 * for the local provider only.
 *
 * Activation rules (Plan §6.1):
 *   - `NODE_ENV !== "production"`
 *   - `RECORDING_STORAGE_PROVIDER` unset OR `local`
 *   - `RECORDING_STORAGE_PUBLIC_BASE_URL` resolves to the dev base path
 *     (defaults to `/dev-recordings` when not configured)
 *   - `app.recordingStorage.provider === "local"` so duck-typing
 *     `readObject` is safe.
 *
 * Production must NEVER serve these routes. Boot fail-fast in production
 * also forbids missing RECORDING_STORAGE_PROVIDER, so the plugin would
 * never even reach this `register()` call without the env being local.
 *
 * Security policy:
 *   - signed URL bodies, object keys, raw audio bytes, and storage error
 *     internals never appear in logs / audit / response bodies beyond
 *     stable short messages.
 *   - `expires` query is hard-required and compared to server clock; no
 *     skew tolerance beyond a small clamp (we own both producer and
 *     consumer locally).
 *   - object key traversal goes through `assertSafeObjectKey` +
 *     `resolveAbsolutePath` two-stage defense from the adapter.
 *
 * Wire shape served:
 *   PUT  /dev-recordings/<objectKey>?expires=<unix>
 *        Content-Type: audio/wav (or other audio/*)
 *        body: raw bytes (capped by RECORDING_UPLOAD_MAX_BYTES)
 *        200 OK, empty body on success.
 *   GET  /dev-recordings/<objectKey>?expires=<unix>
 *        200 OK with Content-Type: audio/wav (or stored type)
 *        404 on missing object.
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";

import {
  RecordingStorageInputError,
  RecordingStorageOperationError,
} from "../adapters/recordingStorage.js";
import type { RecordingContentType } from "../repositories/callRecordings.js";

interface LocalAdapterDuck {
  provider: "local";
  readObject(objectKey: string): Promise<Buffer>;
  putObject(input: {
    bucket: string | null;
    objectKey: string;
    contentType: RecordingContentType;
    body: Buffer;
    checksumSha256?: string | null;
  }): Promise<{ sizeBytes: number; checksumSha256: string | null }>;
}

function isLocalAdapter(a: unknown): a is LocalAdapterDuck {
  return (
    typeof a === "object" &&
    a !== null &&
    (a as { provider?: string }).provider === "local" &&
    typeof (a as { readObject?: unknown }).readObject === "function" &&
    typeof (a as { putObject?: unknown }).putObject === "function"
  );
}

/** parse env to decide whether to register the dev handler at all. */
export interface DevRecordingStorageBootOptions {
  env?: NodeJS.ProcessEnv;
  /** Override Date.now for deterministic tests. */
  now?: () => number;
}

interface DevHandlerConfig {
  mountPath: string;
  maxBytes: number;
  now: () => number;
}

function readMaxBytes(env: NodeJS.ProcessEnv): number {
  const raw = env.RECORDING_UPLOAD_MAX_BYTES;
  if (raw && raw.trim() !== "") {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 250 * 1024 * 1024;
}

/**
 * mountPath은 `RECORDING_STORAGE_PUBLIC_BASE_URL`의 pathname을 따른다.
 * 미설정이면 `/dev-recordings`. host/scheme는 무시 (라우트는 같은
 * Fastify 인스턴스에 등록되므로 path만 필요).
 */
function readMountPath(env: NodeJS.ProcessEnv): string {
  const raw = (env.RECORDING_STORAGE_PUBLIC_BASE_URL ?? "").trim();
  if (raw === "") return "/dev-recordings";
  try {
    const u = new URL(raw);
    let p = u.pathname || "/";
    p = p.replace(/\/+$/, "");
    return p === "" ? "/" : p;
  } catch {
    // Not a URL — treat the raw string as a path prefix.
    let p = raw.startsWith("/") ? raw : `/${raw}`;
    p = p.replace(/\/+$/, "");
    return p === "" ? "/" : p;
  }
}

function shouldActivate(env: NodeJS.ProcessEnv): boolean {
  const nodeEnv = (env.NODE_ENV ?? "").trim().toLowerCase();
  if (nodeEnv === "production") return false;
  const provider = (env.RECORDING_STORAGE_PROVIDER ?? "").trim().toLowerCase();
  if (provider === "s3" || provider === "minio") return false;
  return true; // unset or "local"
}

/**
 * Fastify plugin factory. Returns a plugin that conditionally registers
 * the PUT/GET handlers. We expose the factory rather than a fixed plugin
 * so tests can pass a stub env + frozen clock.
 */
export function createDevRecordingStorageRoutes(
  opts: DevRecordingStorageBootOptions = {},
): FastifyPluginAsync {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;

  return async function devRecordingStorageRoutes(app: FastifyInstance) {
    if (!shouldActivate(env)) return;

    const adapter = (app as { recordingStorage?: unknown }).recordingStorage;
    if (!isLocalAdapter(adapter)) return;

    const config: DevHandlerConfig = {
      mountPath: readMountPath(env),
      maxBytes: readMaxBytes(env),
      now,
    };

    app.log.info(
      { mountPath: config.mountPath, maxBytes: config.maxBytes },
      "[dev-recordings] handler enabled (NOT for production)",
    );

    registerHandlers(app, adapter, config);
  };
}

function registerHandlers(
  app: FastifyInstance,
  adapter: LocalAdapterDuck,
  config: DevHandlerConfig,
): void {
  // Accept binary body up to maxBytes. We set the JSON parser bodyLimit
  // via addContentTypeParser for audio/*. The default JSON parser would
  // reject audio/wav anyway, so this is the explicit gate.
  app.addContentTypeParser(
    /^audio\//,
    { parseAs: "buffer", bodyLimit: config.maxBytes },
    (_req, body, done) => {
      done(null, body);
    },
  );

  // PUT — accept signed upload.
  app.put(`${config.mountPath}/*`, async (request, reply) => {
    if (containsEncodedSeparator(request.url)) {
      reply.code(400);
      return { error: "object_key_invalid" };
    }
    const objectKey = extractObjectKey(request.url, config.mountPath);
    const expiresOk = checkExpires(request.url, config.now);
    if (!expiresOk) {
      reply.code(403);
      return { error: "signed_url_expired" };
    }
    const rawContentType = ((request.headers["content-type"] ?? "")
      .toString()
      .split(";")[0] ?? "")
      .trim()
      .toLowerCase();
    if (!rawContentType.startsWith("audio/")) {
      reply.code(400);
      return { error: "invalid_content_type" };
    }
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      reply.code(400);
      return { error: "empty_body" };
    }
    try {
      await adapter.putObject({
        bucket: null,
        objectKey,
        contentType: rawContentType as RecordingContentType,
        body,
      });
      reply.code(200);
      return { ok: true };
    } catch (err) {
      return mapAdapterError(err, reply);
    }
  });

  // GET — serve uploaded object back as audio.
  app.get(`${config.mountPath}/*`, async (request, reply) => {
    if (containsEncodedSeparator(request.url)) {
      reply.code(400);
      return { error: "object_key_invalid" };
    }
    const objectKey = extractObjectKey(request.url, config.mountPath);
    const expiresOk = checkExpires(request.url, config.now);
    if (!expiresOk) {
      reply.code(403);
      return { error: "signed_url_expired" };
    }
    try {
      const body = await adapter.readObject(objectKey);
      reply.header(
        "Content-Type",
        guessContentTypeFromKey(objectKey) ?? "audio/wav",
      );
      reply.header("Content-Length", body.length.toString());
      reply.header("Cache-Control", "no-store");
      return reply.send(body);
    } catch (err) {
      return mapAdapterError(err, reply);
    }
  });
}

/**
 * Reject any URL whose path contains percent-encoded path separators
 * (`%2F`, `%5C`) or percent-encoded traversal dots (`%2E%2E`). HTTP
 * parsing layers below us decode these, after which a literal `..` in
 * the resulting path could collapse and silently re-map the object key
 * to a different stored object than the signed URL specified. We
 * pre-empt that semantic mismatch before routing or extraction touches
 * the URL.
 */
function containsEncodedSeparator(rawUrl: string): boolean {
  const qIdx = rawUrl.indexOf("?");
  const pathname = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
  const lower = pathname.toLowerCase();
  return (
    lower.includes("%2f") ||
    lower.includes("%5c") ||
    lower.includes("%2e%2e")
  );
}

function extractObjectKey(rawUrl: string, mountPath: string): string {
  // Fastify request.url includes pathname + query. We strip the mount
  // prefix and the query, then decode percent-encoding to recover the
  // object key the adapter signed.
  const qIdx = rawUrl.indexOf("?");
  const pathname = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
  let rest = pathname.startsWith(mountPath)
    ? pathname.slice(mountPath.length)
    : pathname;
  if (rest.startsWith("/")) rest = rest.slice(1);
  // decodeURI for safety — `assertSafeObjectKey` in adapter will then
  // reject control / backslash / traversal even if percent-encoded.
  try {
    return decodeURI(rest);
  } catch {
    // malformed escape — let the adapter's safe-key check reject it.
    return rest;
  }
}

function checkExpires(rawUrl: string, now: () => number): boolean {
  const qIdx = rawUrl.indexOf("?");
  if (qIdx < 0) return false;
  const params = new URLSearchParams(rawUrl.slice(qIdx + 1));
  const expRaw = params.get("expires");
  if (!expRaw) return false;
  const exp = Number.parseInt(expRaw, 10);
  if (!Number.isFinite(exp) || exp <= 0) return false;
  const nowSec = Math.floor(now() / 1000);
  return exp >= nowSec;
}

function guessContentTypeFromKey(objectKey: string): string | null {
  const lower = objectKey.toLowerCase();
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".webm")) return "audio/webm";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  return null;
}

function mapAdapterError(
  err: unknown,
  reply: { code: (code: number) => unknown },
): { error: string } {
  if (err instanceof RecordingStorageInputError) {
    reply.code(400);
    // err.code은 안전한 stable label만 echo — adapter는 raw value 미포함.
    return { error: err.code };
  }
  if (err instanceof RecordingStorageOperationError) {
    if (err.code === "storage_object_not_found") {
      reply.code(404);
      return { error: err.code };
    }
    reply.code(502);
    return { error: err.code };
  }
  reply.code(500);
  return { error: "storage_unexpected" };
}

const devRecordingStorageRoutes = createDevRecordingStorageRoutes();
export default devRecordingStorageRoutes;

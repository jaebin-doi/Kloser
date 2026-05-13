/* ioredis connection — Phase 6 Step 1.
 *
 * Single shared connection for both the queue producer (server) and the
 * consumer (worker entry). BullMQ accepts an existing ioredis instance;
 * we hand it the same one so config (REDIS_URL) is sourced from a single
 * place.
 *
 * BullMQ has a hard requirement that blocking clients (Worker, QueueEvents)
 * disable `maxRetriesPerRequest` and `enableReadyCheck`. The plain Queue
 * client does NOT have that constraint, but using one shared connection
 * across producers and consumers means we adopt the strictest options.
 *
 * Lifecycle:
 *   - Lazy: the connection is created on first import access.
 *   - Callers (worker entry, tests) call `closeRedis()` on shutdown.
 *   - Module is internal-only — not exported through any Fastify route.
 */
import { Redis } from "ioredis";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

let connection: Redis | null = null;

export function getRedisConnection(): Redis {
  if (connection) return connection;
  const conn = new Redis(REDIS_URL, {
    // BullMQ Worker / QueueEvents requirements.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    // ioredis will buffer commands until ready; that's fine for the
    // producer side. Keep retries reasonable so a dead Redis surfaces
    // quickly instead of hanging the API.
    retryStrategy: (times: number) => Math.min(times * 200, 2000),
  });
  conn.on("error", (err: Error) => {
    // ioredis emits 'error' on transient connect failures; log once
    // per emission and let it keep retrying. A persistently dead Redis
    // surfaces as queue enqueue errors at the call site, which our
    // endCall hook catches with .catch().
    console.error("[queue/redis] connection error:", err.message);
  });
  // unref() the underlying TCP socket as soon as it's available so a
  // dangling producer connection cannot keep the Node event loop alive
  // (e.g. tsx --test would otherwise hang forever after endCall opened
  // this lazily). The API/worker processes always have their own
  // long-lived handles — HTTP server in API, BullMQ Worker connection
  // in worker entry — that keep the loop alive on their own. We rely
  // on `closeRedis()` for graceful shutdown.
  conn.on("connect", () => {
    // `stream` is the underlying net.Socket once connected.
    const stream = (conn as unknown as { stream?: { unref?: () => void } }).stream;
    stream?.unref?.();
  });
  connection = conn;
  return conn;
}

export async function closeRedis(): Promise<void> {
  if (!connection) return;
  try {
    await connection.quit();
  } catch (_err) {
    // .disconnect() forces a close if .quit() hangs (e.g. server is
    // already gone). Either way we stop further usage.
    connection.disconnect();
  }
  connection = null;
}

export const REDIS_URL_FOR_DEBUG = REDIS_URL;

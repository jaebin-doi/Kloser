/* Fastify plugin: recording storage adapter decorator — Phase 8 Step 3.
 *
 * Plan: docs/plan/phase-8/PHASE_8_STEP_3_PLAN.md §4.3.
 *
 * Decorates the app with:
 *
 *   app.recordingStorage   — the resolved RecordingStorageAdapter for
 *                            this process. Routes / services read this
 *                            decorator instead of resolving from env on
 *                            every request, so:
 *                              - S3Client connection pooling sticks
 *                              - misconfiguration fails at boot, not on
 *                                the first upload
 *                              - tests can replace the decorator with a
 *                                local adapter rooted at a temp dir
 *
 * Test injection pattern:
 *
 *   const adapter = createLocalRecordingStorageAdapter({ rootDir, ... });
 *   app.decorate("recordingStorage", adapter);
 *   // (do NOT register this plugin — the decorator already exists)
 *
 * Boot fail-fast policy:
 *
 *   resolveRecordingStorageAdapter throws on missing env / unknown
 *   provider. That throw propagates out of `app.register`, which kills
 *   the boot. No "silent fallback to local in prod" path exists.
 */
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import {
  resolveRecordingStorageAdapter,
  type RecordingStorageAdapter,
} from "../adapters/recordingStorage.js";

declare module "fastify" {
  interface FastifyInstance {
    recordingStorage: RecordingStorageAdapter;
  }
}

const recordingStoragePlugin = fp(
  async (app: FastifyInstance) => {
    // If a test already attached a decorator (e.g. via app.decorate
    // before register), skip resolving from env so the test adapter wins.
    if ((app as unknown as { recordingStorage?: unknown }).recordingStorage) {
      return;
    }
    const adapter = resolveRecordingStorageAdapter();
    app.decorate("recordingStorage", adapter);
  },
  { name: "recordingStorage" },
);

export default recordingStoragePlugin;

/* /calls/:id/recordings/* routes — Phase 8 Step 3.
 *
 * Plan: docs/plan/phase-8/PHASE_8_STEP_3_PLAN.md §2.
 *
 * Endpoints:
 *
 *   POST   /calls/:id/recordings/upload
 *   POST   /calls/:id/recordings/:recordingId/finalize
 *   GET    /calls/:id/recordings
 *   GET    /calls/:id/recordings/:recordingId/playback-url
 *   DELETE /calls/:id/recordings/:recordingId
 *
 * preHandler matrix:
 *   read         → requireAuth + orgContext
 *   mutation     → requireAuth + orgContext + requireVerified
 *                  + requireRole("admin","manager","employee")
 *                  + requireFreshRole
 *
 * Cross-org / missing parent / missing recording / status mismatch all
 * collapse to 404 not_found so a client cannot probe for the existence
 * of recordings in other orgs or under other calls. Same-org role
 * denials surface as 403 forbidden.
 *
 * Response bodies never include:
 *   - object_key, storage_bucket, storage_provider, object_version
 *   - checksum_sha256, internal metadata
 *   - provider credentials, raw SDK errors
 *
 * Audit hooks live inside the service. The route layer only translates
 * service errors → HTTP vocabulary.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { orgContext } from "../middleware/orgContext.js";
import { requireRole } from "../middleware/role.js";
import { requireFreshRole } from "../middleware/requireFreshRole.js";
import { requireVerified } from "../middleware/requireVerified.js";
import { PermissionError, type Actor } from "../services/callPermissions.js";
import {
  CallRecordingFinalizeInput,
  CallRecordingUploadInput,
} from "../types/callRecording.js";
import * as recordingsService from "../services/callRecordings.js";
import {
  RecordingNotFoundError,
  RecordingInvalidStateError,
  RecordingTooLargeError,
} from "../services/callRecordings.js";
import {
  RecordingStorageConfigError,
  RecordingStorageInputError,
  RecordingStorageOperationError,
} from "../adapters/recordingStorage.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UuidParam = z.object({
  id: z.string().regex(UUID_RE, "invalid uuid"),
});
const UuidPair = z.object({
  id: z.string().regex(UUID_RE, "invalid uuid"),
  recordingId: z.string().regex(UUID_RE, "invalid uuid"),
});

type WriterRole = "admin" | "manager" | "employee";
const WRITER_ROLES: WriterRole[] = ["admin", "manager", "employee"];

function actorFrom(request: FastifyRequest): Actor {
  const user = request.user!;
  return { id: user.id, orgId: user.orgId, role: user.role };
}

async function callRecordingsRoutes(app: FastifyInstance) {
  // ---------- plugin-scoped error vocabulary ---------- //
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply
        .code(400)
        .send({ error: "invalid_input", issues: err.flatten() });
    }
    if (err instanceof RecordingTooLargeError) {
      return reply.code(413).send({
        error: "recording_too_large",
        attempted: err.attempted,
        limit: err.limit,
      });
    }
    if (err instanceof RecordingInvalidStateError) {
      return reply
        .code(409)
        .send({ error: "invalid_recording_state", current_status: err.currentStatus });
    }
    if (err instanceof RecordingNotFoundError) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (err instanceof PermissionError) {
      return reply.code(403).send({ error: "forbidden" });
    }
    if (err instanceof RecordingStorageInputError) {
      // Adapter-rejected caller input (bad ttl / bad object key shape).
      // Surface as 400; the adapter's `code` is stable but not exposed
      // verbatim to clients.
      return reply.code(400).send({ error: "invalid_recording_input" });
    }
    if (err instanceof RecordingStorageConfigError) {
      // Misconfigured storage provider at boot. Should not happen at
      // request time because the plugin fails fast — defense in depth.
      return reply
        .code(503)
        .send({ error: "recording_storage_unavailable" });
    }
    if (err instanceof RecordingStorageOperationError) {
      if (err.code === "storage_object_not_found") {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.code(502).send({ error: "recording_storage_failed" });
    }
    const pgCode = (err as { code?: string } | null)?.code;
    if (pgCode === "23503") {
      return reply.code(400).send({ error: "invalid_reference" });
    }
    if (pgCode === "23505") {
      return reply.code(409).send({ error: "recording_conflict" });
    }
    if (pgCode === "23514") {
      return reply.code(400).send({ error: "invalid_state_transition" });
    }
    if (pgCode === "42501") {
      return reply.code(500).send({ error: "rls_violation" });
    }
    reply.send(err);
  });

  // -------------------------------------------------------------- //
  // POST /calls/:id/recordings/upload — initiate
  // -------------------------------------------------------------- //
  app.post(
    "/calls/:id/recordings/upload",
    {
      preHandler: [
        requireAuth,
        orgContext,
        requireVerified,
        requireRole(...WRITER_ROLES),
        requireFreshRole,
      ],
    },
    async (request, reply) => {
      const { id } = UuidParam.parse(request.params);
      const input = CallRecordingUploadInput.parse(request.body);
      const result = await recordingsService.initiateRecordingUpload(
        app,
        actorFrom(request),
        id,
        input,
      );
      return reply.code(201).send(result);
    },
  );

  // -------------------------------------------------------------- //
  // POST /calls/:id/recordings/:recordingId/finalize
  // -------------------------------------------------------------- //
  app.post(
    "/calls/:id/recordings/:recordingId/finalize",
    {
      preHandler: [
        requireAuth,
        orgContext,
        requireVerified,
        requireRole(...WRITER_ROLES),
        requireFreshRole,
      ],
    },
    async (request, reply) => {
      const { id, recordingId } = UuidPair.parse(request.params);
      const input = CallRecordingFinalizeInput.parse(request.body ?? {});
      const result = await recordingsService.finalizeRecordingUpload(
        app,
        actorFrom(request),
        id,
        recordingId,
        input,
      );
      return reply.code(200).send(result);
    },
  );

  // -------------------------------------------------------------- //
  // GET /calls/:id/recordings — list
  // -------------------------------------------------------------- //
  app.get(
    "/calls/:id/recordings",
    { preHandler: [requireAuth, orgContext] },
    async (request, reply) => {
      const { id } = UuidParam.parse(request.params);
      const result = await recordingsService.listCallRecordings(
        app,
        request.orgId!,
        id,
      );
      if (!result) return reply.code(404).send({ error: "not_found" });
      return reply.code(200).send(result);
    },
  );

  // -------------------------------------------------------------- //
  // GET /calls/:id/recordings/:recordingId/playback-url
  // -------------------------------------------------------------- //
  app.get(
    "/calls/:id/recordings/:recordingId/playback-url",
    { preHandler: [requireAuth, orgContext] },
    async (request, reply) => {
      const { id, recordingId } = UuidPair.parse(request.params);
      const result = await recordingsService.createRecordingPlaybackUrl(
        app,
        request.orgId!,
        request.user!.id,
        id,
        recordingId,
      );
      return reply.code(200).send(result);
    },
  );

  // -------------------------------------------------------------- //
  // DELETE /calls/:id/recordings/:recordingId
  // -------------------------------------------------------------- //
  app.delete(
    "/calls/:id/recordings/:recordingId",
    {
      preHandler: [
        requireAuth,
        orgContext,
        requireVerified,
        requireRole(...WRITER_ROLES),
        requireFreshRole,
      ],
    },
    async (request, reply) => {
      const { id, recordingId } = UuidPair.parse(request.params);
      await recordingsService.deleteRecording(
        app,
        actorFrom(request),
        id,
        recordingId,
      );
      return reply.code(204).send();
    },
  );
}

export default callRecordingsRoutes;

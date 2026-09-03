// Routes idempotent sync operation ingestion, conflict listing, and explicit conflict resolution.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { syncOperationSchema, type CanvasObject } from "@aurora/shared";
import type { AuroraEnv } from "../env.js";
import { invalid, notFound } from "../errors.js";
import { query, withTransaction } from "../db/pool.js";
import { requireSessionPreHandler } from "../auth/sessions.js";
import { broadcastToOwner } from "./ws.js";
import {
  deleteObject,
  loadObjectForUpdate,
  touchNote,
  upsertObject,
} from "../canvas/objects.js";
import { ingestOperations } from "./ingest.js";
import type { DeleteMarker } from "./classify.js";

const ingestBodySchema = z.object({
  operations: z.array(syncOperationSchema).min(1),
});

const resolveBodySchema = z.object({
  resolution: z.enum(["base", "incoming"]),
});

const conflictIdParamsSchema = z.object({ id: z.string().uuid() });

// incoming_object may hold a delete marker for delete-conflicts.
type ConflictListRow = {
  id: string;
  note_id: string;
  object_id: string;
  base_object: CanvasObject | null;
  incoming_object: CanvasObject | DeleteMarker;
  created_at: Date;
};

export function registerSyncRoutes(app: FastifyInstance, env: AuroraEnv): void {
  const preHandler = requireSessionPreHandler(env);

  app.post("/api/sync/operations", { preHandler }, async (request) => {
    const { operations } = ingestBodySchema.parse(request.body);
    const acks = await ingestOperations(request.ownerId!, operations);
    return { acks, serverTimestamp: new Date().toISOString() };
  });

  app.get("/api/sync/conflicts", { preHandler }, async (request) => {
    const result = await query<ConflictListRow>(
      `SELECT id, note_id, object_id, base_object, incoming_object, created_at
       FROM conflicts
       WHERE owner_id = $1 AND resolved_at IS NULL
       ORDER BY created_at
       LIMIT 200`,
      [request.ownerId!],
    );
    return {
      conflicts: result.rows.map((row) => ({
        id: row.id,
        noteId: row.note_id,
        objectId: row.object_id,
        baseObject: row.base_object,
        incomingObject: row.incoming_object,
        createdAt: row.created_at.toISOString(),
      })),
      serverTimestamp: new Date().toISOString(),
    };
  });

  // Explicit resolution: base keeps the server version; incoming re-applies the client version
  // (or performs the pending delete). Resolutions broadcast so other devices converge.
  app.post(
    "/api/sync/conflicts/:id/resolve",
    { preHandler },
    async (request) => {
      const { id } = conflictIdParamsSchema.parse(request.params);
      const { resolution } = resolveBodySchema.parse(request.body);
      const outcome = await withTransaction(async (client) => {
        const conflictRow = await client.query<{
          id: string;
          owner_id: string;
          note_id: string;
          object_id: string;
          resolved_at: Date | null;
          incoming_object: CanvasObject | DeleteMarker;
          base_object: CanvasObject | null;
        }>(
          `SELECT id, owner_id, note_id, object_id, resolved_at, incoming_object, base_object
         FROM conflicts WHERE id = $1 AND owner_id = $2 FOR UPDATE`,
          [id, request.ownerId!],
        );
        const row = conflictRow.rows[0];
        if (!row) throw notFound("Conflict");
        if (row.resolved_at) throw invalid("Conflict is already resolved");

        const current = await loadObjectForUpdate(
          client,
          row.owner_id,
          row.object_id,
        );
        const incomingIsDelete =
          "deleted" in row.incoming_object &&
          row.incoming_object.deleted === true;

        let resolvedObject: CanvasObject | undefined = current ?? undefined;
        if (resolution === "incoming" && !incomingIsDelete) {
          const incoming = row.incoming_object as CanvasObject;
          const revision = current ? current.revision + 1 : 0;
          resolvedObject = await upsertObject(
            client,
            row.owner_id,
            incoming,
            revision,
          );
        } else if (resolution === "incoming" && incomingIsDelete) {
          await deleteObject(client, row.owner_id, row.object_id);
          resolvedObject = undefined;
        }

        await markConflictResolved(client, row.owner_id, id);
        await touchNote(client, row.owner_id, row.note_id);
        return {
          ownerId: row.owner_id,
          noteId: row.note_id,
          objectId: row.object_id,
          incomingIsDelete,
          resolvedObject,
        };
      });

      broadcastToOwner(outcome.ownerId, {
        type: "objects-changed",
        noteId: outcome.noteId,
        objects: outcome.resolvedObject ? [outcome.resolvedObject] : [],
        deletedObjectIds:
          resolution === "incoming" && outcome.incomingIsDelete
            ? [outcome.objectId]
            : [],
        originOperationId: id,
        serverTimestamp: new Date().toISOString(),
      });
      return { resolved: true, object: outcome.resolvedObject ?? null };
    },
  );
}

async function markConflictResolved(
  client: import("pg").PoolClient,
  ownerId: string,
  conflictId: string,
): Promise<void> {
  await client.query(
    "UPDATE conflicts SET resolved_at = now() WHERE owner_id = $1 AND id = $2",
    [ownerId, conflictId],
  );
}

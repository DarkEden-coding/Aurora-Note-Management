// Ingests a batch in client order, assigning authoritative revisions and recording conflicts.
import type { CanvasObject, SyncAck, SyncOperation } from "@aurora/shared";
import type { PoolClient } from "pg";
import { conflict, forbidden, invalid, notFound } from "../errors.js";
import { withTransaction } from "../db/pool.js";
import {
  deleteObject,
  loadObjectForUpdate,
  lockNotesForCanvasWrite,
  upsertObject,
} from "../canvas/objects.js";
import {
  classifyOperation,
  toConflictRecord,
  type DeleteMarker,
} from "./classify.js";
import { broadcastToOwner } from "./ws.js";

type OperationRow = {
  id: string;
  owner_id: string;
  note_id: string;
  object_id: string;
  status: "applied" | "conflict";
  conflict_id: string | null;
  result_revision: number | null;
};

function ack(
  op: SyncOperation,
  status: SyncAck["status"],
  fields: Pick<SyncAck, "object" | "conflictId" | "resultRevision">,
): SyncAck {
  return {
    operationId: op.id,
    status,
    ...fields,
    serverTimestamp: new Date().toISOString(),
  };
}

export async function ingestOperations(
  ownerId: string,
  operations: SyncOperation[],
  legacyOrdering = false,
): Promise<SyncAck[]> {
  const { acks, changes } = await withTransaction(async (client) => {
    // Serialize batches for an owner, including concurrent creates and retries.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [ownerId],
    );
    const noteIds = [...new Set(operations.map((op) => op.noteId))];
    const notes = await lockNotesForCanvasWrite(client, ownerId, noteIds);
    if (notes.length !== noteIds.length) throw notFound("Note");
    if (notes.some((note) => note.trashed_at)) {
      throw conflict("Note is in trash; restore it before syncing operations");
    }

    const existing = await client.query<OperationRow>(
      `SELECT id, owner_id, note_id, object_id, status, conflict_id, result_revision
       FROM operations WHERE id = ANY($1::uuid[])`,
      [operations.map((op) => op.id)],
    );
    const recorded = new Map(existing.rows.map((row) => [row.id, row]));

    const pageIds = operations.flatMap((op) =>
      op.mutation.type === "upsert" && op.mutation.object.pageId
        ? [op.mutation.object.pageId]
        : [],
    );
    const pages = new Map<string, string>();
    if (pageIds.length > 0) {
      const result = await client.query<{ id: string; note_id: string }>(
        "SELECT id, note_id FROM pages WHERE owner_id = $1 AND id = ANY($2::uuid[])",
        [ownerId, pageIds],
      );
      for (const page of result.rows) pages.set(page.id, page.note_id);
    }

    const acks: SyncAck[] = [];
    const currentObjects = new Map<string, CanvasObject | null>();
    const noteEdits = new Map<string, number>();
    const changes = new Map<
      string,
      { operationId: string; objects: Map<string, CanvasObject | null> }
    >();
    for (const op of operations) {
      if (!currentObjects.has(op.objectId)) {
        currentObjects.set(
          op.objectId,
          await loadObjectForUpdate(client, ownerId, op.objectId),
        );
      }
      const current = currentObjects.get(op.objectId) ?? null;
      const duplicate = recorded.get(op.id);
      if (duplicate) {
        if (duplicate.owner_id !== ownerId) throw forbidden("Operation");
        if (
          duplicate.note_id !== op.noteId ||
          duplicate.object_id !== op.objectId
        ) {
          throw invalid(
            "Operation ID was already used for a different canvas object",
          );
        }
        acks.push(
          ack(op, duplicate.status === "applied" ? "duplicate" : "conflict", {
            object: current ?? undefined,
            conflictId: duplicate.conflict_id ?? undefined,
            resultRevision: duplicate.result_revision ?? undefined,
          }),
        );
        continue;
      }

      if (current && current.noteId !== op.noteId) {
        throw forbidden("Canvas object does not belong to this note");
      }
      if (op.mutation.type === "upsert") {
        const incoming = op.mutation.object;
        if (incoming.id !== op.objectId || incoming.noteId !== op.noteId) {
          throw invalid("Operation and embedded object IDs must match");
        }
        if (incoming.ownerId !== ownerId) {
          throw forbidden(
            "Canvas object owner does not match the request owner",
          );
        }
        if (incoming.pageId && pages.get(incoming.pageId) !== op.noteId) {
          throw invalid("Canvas object page must belong to the operation note");
        }
      }

      const fixesLegacyPrediction =
        legacyOrdering &&
        op.baseRevision === 1 &&
        current?.revision === 0 &&
        current.createdAt === current.updatedAt &&
        (await wasCreatedByThisDevice(client, ownerId, op));
      let result: SyncAck;
      if (classifyOperation(current, op) === "apply" || fixesLegacyPrediction) {
        let object: CanvasObject | null = null;
        if (op.mutation.type === "upsert") {
          object = await upsertObject(
            client,
            ownerId,
            op.mutation.object,
            current ? current.revision + 1 : 0,
          );
        } else if (current) {
          await deleteObject(client, ownerId, op.objectId);
        }
        currentObjects.set(op.objectId, object);
        if (object || current)
          noteEdits.set(op.noteId, (noteEdits.get(op.noteId) ?? 0) + 1);
        result = ack(op, "applied", {
          object: object ?? undefined,
          resultRevision: object?.revision ?? 0,
        });
        let change = changes.get(op.noteId);
        if (!change) {
          change = { operationId: op.id, objects: new Map() };
          changes.set(op.noteId, change);
        }
        change.objects.set(op.objectId, object);
      } else {
        const conflictId = await insertConflictRow(
          client,
          ownerId,
          op,
          toConflictRecord(current, op),
        );
        noteEdits.set(op.noteId, (noteEdits.get(op.noteId) ?? 0) + 1);
        result = ack(op, "conflict", {
          object: current ?? undefined,
          conflictId,
        });
      }
      const status = result.status === "conflict" ? "conflict" : "applied";
      const conflictId = result.conflictId ?? null;
      const revision = result.resultRevision ?? null;
      await insertOperationRow(
        client,
        ownerId,
        op,
        status,
        conflictId,
        revision,
      );
      recorded.set(op.id, {
        id: op.id,
        owner_id: ownerId,
        note_id: op.noteId,
        object_id: op.objectId,
        status,
        conflict_id: conflictId,
        result_revision: revision,
      });
      acks.push(result);
    }

    if (noteEdits.size > 0) {
      await client.query(
        `UPDATE notes SET updated_at = now(), revision = notes.revision + edits.count
         FROM unnest($2::uuid[], $3::int[]) AS edits(id, count)
         WHERE notes.owner_id = $1 AND notes.id = edits.id`,
        [ownerId, [...noteEdits.keys()], [...noteEdits.values()]],
      );
    }
    return { acks, changes };
  });

  for (const [noteId, change] of changes) {
    broadcastToOwner(ownerId, {
      type: "objects-changed",
      noteId,
      objects: [...change.objects.values()].filter((object) => object !== null),
      deletedObjectIds: [...change.objects]
        .filter(([, object]) => object === null)
        .map(([id]) => id),
      originOperationId: change.operationId,
      serverTimestamp: new Date().toISOString(),
    });
  }
  return acks;
}

// Old clients predict creation at revision 1. Repair that prediction only when
// the ledger proves this device created the unchanged object before this edit.
async function wasCreatedByThisDevice(
  client: PoolClient,
  ownerId: string,
  op: SyncOperation,
): Promise<boolean> {
  const { rows } = await client.query<{ matches: boolean }>(
    `SELECT count(*) = 1 AND bool_and(
       previous.device_id = $4 AND previous.base_revision = 0
       AND (previous.result_revision = 0 OR previous.result_revision IS NULL)
       AND previous.client_timestamp <= $5
     ) AS matches
     FROM canvas_objects AS current
     JOIN operations AS previous
       ON previous.owner_id = current.owner_id
       AND previous.note_id = current.note_id
       AND previous.object_id = current.id
       AND previous.created_at = current.created_at
       AND previous.status = 'applied'
     WHERE current.owner_id = $1 AND current.note_id = $2 AND current.id = $3
       AND current.revision = 0 AND current.updated_at = current.created_at`,
    [ownerId, op.noteId, op.objectId, op.deviceId, op.clientTimestamp],
  );
  return rows[0]?.matches === true;
}

async function insertOperationRow(
  client: PoolClient,
  ownerId: string,
  op: SyncOperation,
  status: "applied" | "conflict",
  conflictId: string | null,
  resultRevision: number | null,
): Promise<void> {
  await client.query(
    `INSERT INTO operations (id, owner_id, device_id, note_id, object_id, base_revision, client_timestamp, status, conflict_id, result_revision)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      op.id,
      ownerId,
      op.deviceId,
      op.noteId,
      op.objectId,
      op.baseRevision,
      op.clientTimestamp,
      status,
      conflictId,
      resultRevision,
    ],
  );
}

async function insertConflictRow(
  client: PoolClient,
  ownerId: string,
  op: SyncOperation,
  record: ReturnType<typeof toConflictRecord>,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO conflicts (owner_id, note_id, object_id, base_object, incoming_object)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      ownerId,
      op.noteId,
      record.objectId,
      JSON.stringify(record.baseObject),
      JSON.stringify(record.incomingObject),
    ],
  );
  return result.rows[0]!.id;
}

export type { DeleteMarker };

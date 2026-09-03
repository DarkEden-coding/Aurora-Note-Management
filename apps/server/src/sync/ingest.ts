// Ingests client sync operations idempotently, assigning authoritative revisions and recording conflicts.
import type { CanvasObject, SyncAck, SyncOperation } from "@aurora/shared";
import { conflict, forbidden, invalid, notFound } from "../errors.js";
import { query, withTransaction } from "../db/pool.js";
import {
  deleteObject,
  loadObjectForUpdate,
  mapCanvasObject,
  touchNote,
  upsertObject,
  type CanvasObjectRow,
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
};

function ack(
  op: SyncOperation,
  status: SyncAck["status"],
  object?: CanvasObject,
  conflictId?: string,
): SyncAck {
  return {
    operationId: op.id,
    status,
    object,
    conflictId,
    serverTimestamp: new Date().toISOString(),
  };
}

// Every operation's note must exist and sit outside trash in the owner scope.
export async function ensureNoteOwned(
  ownerId: string,
  noteId: string,
): Promise<void> {
  const result = await query<{ owner_id: string; trashed_at: Date | null }>(
    "SELECT owner_id, trashed_at FROM notes WHERE owner_id = $1 AND id = $2",
    [ownerId, noteId],
  );
  if (!result.rows[0]) throw notFound("Note");
  if (result.rows[0].trashed_at) {
    throw conflict("Note is in trash; restore it before syncing operations");
  }
}

export async function ingestOperations(
  ownerId: string,
  operations: SyncOperation[],
): Promise<SyncAck[]> {
  // Validate ownership for each distinct note so a batch cannot smuggle foreign note IDs.
  const checkedNotes = new Set<string>();
  for (const op of operations) {
    if (!checkedNotes.has(op.noteId)) {
      await ensureNoteOwned(ownerId, op.noteId);
      checkedNotes.add(op.noteId);
    }
  }
  const acks: SyncAck[] = [];
  for (const op of operations) {
    acks.push(await ingestOperation(ownerId, op));
  }
  return acks;
}

// Duplicate ingestion re-acks the recorded outcome without mutating state again.
async function reackDuplicate(
  op: SyncOperation,
  ownerId: string,
): Promise<SyncAck> {
  const recorded = await query<OperationRow>(
    "SELECT id, owner_id, note_id, object_id, status, conflict_id FROM operations WHERE id = $1 AND owner_id = $2",
    [op.id, ownerId],
  );
  const row = recorded.rows[0];
  if (!row) throw notFound("Operation");
  const object = await loadCurrentObject(ownerId, op.objectId);
  if (row.status === "applied") {
    return ack(op, "duplicate", object ?? undefined);
  }
  return ack(op, "conflict", object ?? undefined, row.conflict_id ?? undefined);
}

async function loadCurrentObject(
  ownerId: string,
  objectId: string,
): Promise<CanvasObject | null> {
  const result = await query<CanvasObjectRow>(
    `SELECT id, owner_id, note_id, page_id, kind, x, y, width, height, rotation,
            z_index, locked, group_id, payload, revision, created_at, updated_at
     FROM canvas_objects WHERE owner_id = $1 AND id = $2`,
    [ownerId, objectId],
  );
  const row = result.rows[0];
  return row ? mapCanvasObject(row) : null;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}

export async function ingestOperation(
  ownerId: string,
  op: SyncOperation,
): Promise<SyncAck> {
  const duplicateCheck = await query<OperationRow>(
    "SELECT id, owner_id, note_id, object_id, status, conflict_id FROM operations WHERE id = $1",
    [op.id],
  );
  if (duplicateCheck.rows[0]) {
    if (duplicateCheck.rows[0].owner_id !== ownerId)
      throw forbidden("Operation");
    return reackDuplicate(op, ownerId);
  }

  try {
    const result = await withTransaction(async (client) => {
      const current = await loadObjectForUpdate(client, ownerId, op.objectId);
      if (current && current.noteId !== op.noteId) {
        throw forbidden("Canvas object does not belong to this note");
      }
      if (op.mutation.type === "upsert") {
        const incoming = op.mutation.object;
        if (incoming.id !== op.objectId || incoming.noteId !== op.noteId) {
          throw invalid("Operation and embedded object IDs must match");
        }
        if (incoming.ownerId !== ownerId) {
          throw forbidden("Canvas object owner does not match the session");
        }
        if (incoming.pageId) {
          const page = await client.query<{ id: string }>(
            `SELECT id FROM pages
             WHERE id = $1 AND owner_id = $2 AND note_id = $3`,
            [incoming.pageId, ownerId, op.noteId],
          );
          if (!page.rows[0]) {
            throw invalid(
              "Canvas object page must belong to the operation note",
            );
          }
        }
      }
      const status = classifyOperation(current, op);

      if (status === "apply") {
        if (op.mutation.type === "upsert") {
          const revision = current ? current.revision + 1 : 0;
          const applied = await upsertObject(
            client,
            ownerId,
            op.mutation.object,
            revision,
          );
          await insertOperationRow(client, ownerId, op, "applied", null);
          await touchNote(client, ownerId, op.noteId);
          return ack(op, "applied", applied);
        }
        const existed = await deleteObject(client, ownerId, op.objectId);
        await insertOperationRow(client, ownerId, op, "applied", null);
        if (existed) {
          await touchNote(client, ownerId, op.noteId);
        }
        return ack(op, "applied");
      }

      // Conflict: keep complete base and incoming versions; the owner resolves explicitly later.
      const conflictRecord = toConflictRecord(current, op);
      const conflictId = await insertConflictRow(
        client,
        ownerId,
        op,
        conflictRecord,
      );
      await insertOperationRow(client, ownerId, op, "conflict", conflictId);
      await touchNote(client, ownerId, op.noteId);
      return ack(op, "conflict", current ?? undefined, conflictId);
    });
    // Broadcast after commit so other devices converge within the sync latency budget.
    if (result.status === "applied") {
      broadcastToOwner(ownerId, {
        type: "objects-changed",
        noteId: op.noteId,
        objects: result.object ? [result.object] : [],
        deletedObjectIds:
          op.mutation.type === "delete" && !result.object ? [op.objectId] : [],
        originOperationId: op.id,
        serverTimestamp: result.serverTimestamp,
      });
    }
    return result;
  } catch (error) {
    // A concurrent delivery of the same operation ID hit the operations primary key;
    // treat it as the duplicate it is instead of failing the batch.
    if (isUniqueViolation(error)) {
      return reackDuplicate(op, ownerId);
    }
    throw error;
  }
}

async function insertOperationRow(
  client: import("pg").PoolClient,
  ownerId: string,
  op: SyncOperation,
  status: "applied" | "conflict",
  conflictId: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO operations (id, owner_id, device_id, note_id, object_id, base_revision, client_timestamp, status, conflict_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
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
    ],
  );
}

async function insertConflictRow(
  client: import("pg").PoolClient,
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

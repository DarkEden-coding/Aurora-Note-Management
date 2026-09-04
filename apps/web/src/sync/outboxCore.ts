// This module holds Aurora's pure outbox logic — batch selection, retry backoff, and acknowledgement reduction — with no IndexedDB or network dependency so it can be unit-tested directly and is used by the durable outbox.
import type { CanvasObject, SyncAck, SyncOperation } from "@aurora/shared";
import type { OutboxRow } from "./db.js";

export const OUTBOX_BATCH_SIZE = 50;
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 5 * 60 * 1_000;

export interface ServerChanges {
  objects: CanvasObject[];
  deletedObjectIds: string[];
}

/** Keep server snapshots away from objects that still have unsynced local work. */
export function filterChangesForPendingOperations(
  changes: ServerChanges,
  rows: OutboxRow[],
): ServerChanges {
  const pendingObjectIds = new Set(rows.map((row) => row.op.objectId));
  return {
    objects: changes.objects.filter(
      (object) => !pendingObjectIds.has(object.id),
    ),
    deletedObjectIds: changes.deletedObjectIds.filter(
      (objectId) => !pendingObjectIds.has(objectId),
    ),
  };
}

export interface PreservedDraft {
  object: CanvasObject;
  updatedRow?: OutboxRow;
}

/** Apply an acknowledged revision to a newer local draft without replacing its content. */
export function preserveLocalDraft(
  authoritative: CanvasObject,
  rows: OutboxRow[],
  acknowledgedOperationId: string,
): PreservedDraft {
  const draftRow = rows
    .filter(
      (row) =>
        row.id !== acknowledgedOperationId &&
        row.op.objectId === authoritative.id &&
        row.op.mutation.type === "upsert",
    )
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!draftRow || draftRow.op.mutation.type !== "upsert") {
    return { object: authoritative };
  }

  const object = {
    ...draftRow.op.mutation.object,
    ownerId: authoritative.ownerId,
    noteId: authoritative.noteId,
    revision: authoritative.revision,
    createdAt: authoritative.createdAt,
  };
  return {
    object,
    updatedRow: {
      ...draftRow,
      op: {
        ...draftRow.op,
        baseRevision: Math.max(
          draftRow.op.baseRevision,
          authoritative.revision,
        ),
        mutation: { type: "upsert", object },
      },
    },
  };
}

/** Capped exponential backoff: 1s, 2s, 4s, ... up to the cap. */
export function computeBackoffMs(attempt: number): number {
  const clamped = Math.max(1, Math.floor(attempt));
  return Math.min(BACKOFF_BASE_MS * 2 ** (clamped - 1), BACKOFF_CAP_MS);
}

/** Operations ordered by enqueue time whose next retry is due at `now`. */
export function selectDueBatch(rows: OutboxRow[], now: number): OutboxRow[] {
  return rows
    .filter((row) => row.status !== "conflict" && row.nextAttemptAt <= now)
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, OUTBOX_BATCH_SIZE);
}

/** Record a failed flush attempt: bump attempts and schedule the next retry. */
export function markAttemptFailed(
  row: OutboxRow,
  now: number,
  error: string,
): OutboxRow {
  const attempts = row.attempts + 1;
  return {
    ...row,
    attempts,
    lastError: error,
    status: "failed",
    nextAttemptAt: now + computeBackoffMs(attempts),
  };
}

export interface AckReduction {
  /** Outbox rows that remain after applying the acknowledgement. */
  remaining: OutboxRow[];
  /** Operations that were durably acknowledged and may be dropped. */
  ackedIds: string[];
}

/**
 * Apply one server acknowledgement to the queue. Applied and duplicate
 * operations leave the outbox (their revision is stored locally first by the
 * caller, per the durability rule). A conflict row stays parked with status
 * "conflict" until the user resolves it.
 */
export function applyAck(rows: OutboxRow[], ack: SyncAck): AckReduction {
  const target = rows.find((row) => row.id === ack.operationId);
  if (!target) return { remaining: rows, ackedIds: [] };

  if (ack.status === "conflict") {
    return {
      remaining: rows.map((row) =>
        row.id === target.id
          ? {
              ...row,
              status: "conflict",
              lastError: "conflict",
              nextAttemptAt: Number.MAX_SAFE_INTEGER,
            }
          : row,
      ),
      ackedIds: [],
    };
  }

  return {
    remaining: rows.filter((row) => row.id !== ack.operationId),
    ackedIds: [ack.operationId],
  };
}

/** Build a sync operation payload for one object mutation. */
export function buildOperation(params: {
  operationId: string;
  deviceId: string;
  noteId: string;
  objectId: string;
  baseRevision: number;
  mutation: SyncOperation["mutation"];
  clientTimestamp?: string;
}): SyncOperation {
  return {
    id: params.operationId,
    deviceId: params.deviceId,
    noteId: params.noteId,
    objectId: params.objectId,
    baseRevision: params.baseRevision,
    clientTimestamp: params.clientTimestamp ?? new Date().toISOString(),
    mutation: params.mutation,
  };
}

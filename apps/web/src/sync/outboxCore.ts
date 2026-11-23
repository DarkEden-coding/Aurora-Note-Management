// Queue ordering, retry backoff, and revision reconciliation without storage or HTTP.
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

/** Give a waiting edit the exact revision produced by its predecessor. */
export function rebaseOperation(
  op: SyncOperation,
  revision: number,
  createdAt?: string,
): SyncOperation {
  return {
    ...op,
    baseRevision: revision,
    mutation:
      op.mutation.type === "upsert"
        ? {
            type: "upsert",
            object: {
              ...op.mutation.object,
              revision,
              createdAt: createdAt ?? op.mutation.object.createdAt,
            },
          }
        : op.mutation,
  };
}

export function acknowledgedRevision(
  op: SyncOperation,
  ack: SyncAck,
): number | undefined {
  if (ack.status === "conflict") return undefined;
  if (op.mutation.type === "delete") return 0;
  if (ack.resultRevision !== undefined) return ack.resultRevision;
  // Older ledgers only return the current object. A later revision is not ours.
  const revision = ack.object?.revision;
  if (
    ack.status === "duplicate" &&
    revision !== undefined &&
    revision > op.baseRevision + 1
  ) {
    return undefined;
  }
  return revision;
}

export function queueMutation(
  op: SyncOperation,
  previous: OutboxRow | undefined,
  now: number,
): OutboxRow {
  if (previous && !previous.sent && previous.attempts === 0) {
    return {
      ...previous,
      op: { ...op, id: previous.id, baseRevision: previous.op.baseRevision },
    };
  }
  return {
    id: op.id,
    objectId: op.objectId,
    op,
    createdAt: previous ? Math.max(now, previous.createdAt + 1) : now,
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
    status: "pending",
  };
}

/** A retrying head must block later edits to the same object. */
export function isDueObjectHead(
  row: OutboxRow,
  now: number,
  seen: Set<string>,
): boolean {
  if (row.status === "conflict" || seen.has(row.op.objectId)) return false;
  seen.add(row.op.objectId);
  return row.nextAttemptAt <= now;
}

/** Capped exponential backoff: 1s, 2s, 4s, ... up to the cap. */
export function computeBackoffMs(attempt: number): number {
  const clamped = Math.max(1, Math.floor(attempt));
  return Math.min(BACKOFF_BASE_MS * 2 ** (clamped - 1), BACKOFF_CAP_MS);
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

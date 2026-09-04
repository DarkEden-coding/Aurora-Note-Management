// This module is Aurora's durable outbox: it persists operations to IndexedDB before any network attempt, flushes due batches over HTTP, applies acknowledgements only after storing the resulting revision locally, and exposes enqueueing for feature modules (the canvas feature calls enqueueObjectMutation).
import type { CanvasObject, SyncOperation } from "@aurora/shared";
import { ApiError, apiPost } from "../lib/http.js";
import { db } from "./db.js";
import {
  applyAck,
  markAttemptFailed,
  preserveLocalDraft,
  selectDueBatch,
} from "./outboxCore.js";

interface AckBatchResponse {
  acks: import("@aurora/shared").SyncAck[];
}

const inFlightByObject = new Map<string, SyncOperation>();

/** Persist one operation durably before any network transmission. */
export async function enqueueOperation(op: SyncOperation): Promise<void> {
  await db.outbox.put({
    id: op.id,
    op,
    createdAt: Date.now(),
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
    status: "pending",
  });
}

/**
 * Enqueue an object upsert or delete for the canvas feature. The caller
 * supplies the local (already-cached) object so the acknowledged revision can
 * be written to the local cache, satisfying the durability rule that an
 * operation leaves the outbox only after its revision is stored locally.
 */
export function enqueueObjectMutation(params: {
  op: SyncOperation;
  upsertedObject?: CanvasObject;
}): Promise<void> {
  const key = `${params.op.noteId}:${params.op.objectId}`;
  const previous = enqueueChains.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => enqueueObjectMutationNow(params));
  enqueueChains.set(key, next);
  return next.finally(() => {
    if (enqueueChains.get(key) === next) enqueueChains.delete(key);
  });
}

const enqueueChains = new Map<string, Promise<void>>();

async function enqueueObjectMutationNow(params: {
  op: SyncOperation;
  upsertedObject?: CanvasObject;
}): Promise<void> {
  const inFlightIds = new Set(
    [...inFlightByObject.values()].map((operation) => operation.id),
  );
  const queued = (await db.outbox.toArray())
    .filter(
      (row) =>
        row.op.noteId === params.op.noteId &&
        row.op.objectId === params.op.objectId &&
        row.status !== "conflict" &&
        !inFlightIds.has(row.id),
    )
    .sort((a, b) => a.createdAt - b.createdAt)[0];
  const inFlight = inFlightByObject.get(params.op.objectId);
  const operation: SyncOperation = queued
    ? {
        ...params.op,
        id: queued.op.id,
        baseRevision: queued.op.baseRevision,
      }
    : inFlight
      ? { ...params.op, baseRevision: inFlight.baseRevision + 1 }
      : params.op;

  if (queued) {
    await db.outbox.put({
      ...queued,
      op: operation,
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
      status: "pending",
    });
  } else {
    await enqueueOperation(operation);
  }

  if (operation.mutation.type === "upsert" && params.upsertedObject) {
    await db.objects.put(params.upsertedObject);
  } else if (operation.mutation.type === "delete") {
    await db.objects.delete(operation.objectId);
  }
}

async function storeAckedRevision(
  op: SyncOperation,
  ack: import("@aurora/shared").SyncAck,
): Promise<CanvasObject | null> {
  const pendingEnqueue = enqueueChains.get(`${op.noteId}:${op.objectId}`);
  if (pendingEnqueue) await pendingEnqueue.catch(() => undefined);

  if (ack.object) {
    const preserved = preserveLocalDraft(
      ack.object,
      await db.outbox.toArray(),
      op.id,
    );
    if (preserved.updatedRow) await db.outbox.put(preserved.updatedRow);
    await db.objects.put(preserved.object);
    await db.notes.update(op.noteId, { revision: ack.object.revision });
    return preserved.object;
  }
  if (op.mutation.type === "upsert") {
    // Server did not echo the object; store the sent version so outbox removal still has local state.
    await db.objects.put(op.mutation.object);
    return op.mutation.object;
  }
  await db.objects.delete(op.objectId);
  return null;
}

/**
 * Persists a server-reported conflict into the local conflict list so the
 * ConflictDialog can present both complete versions and resolve explicitly.
 */
async function recordServerConflict(
  op: SyncOperation,
  ack: import("@aurora/shared").SyncAck,
): Promise<void> {
  await db.conflicts.put({
    id: ack.conflictId ?? op.id,
    noteId: op.noteId,
    objectId: op.objectId,
    localObject:
      op.mutation.type === "upsert"
        ? op.mutation.object
        : {
            deleted: true,
            baseRevision: op.baseRevision,
            clientTimestamp: op.clientTimestamp,
          },
    serverObject: ack.object ?? null,
    createdAt: Date.now(),
  });
}

export interface AcknowledgedChange {
  noteId: string;
  objects: CanvasObject[];
  deletedObjectIds: string[];
}

/** Flush every due operation batch until the queue is drained or the network fails. */
export async function flushOutbox(): Promise<{
  sent: number;
  remaining: number;
  changes: AcknowledgedChange[];
}> {
  let sent = 0;
  const changes: AcknowledgedChange[] = [];

  for (;;) {
    const rows = await db.outbox.toArray();
    const batch = selectDueBatch(rows, Date.now());
    if (batch.length === 0) break;

    const operations: SyncOperation[] = batch.map((row) => row.op);
    for (const operation of operations) {
      inFlightByObject.set(operation.objectId, operation);
    }
    let acks: AckBatchResponse["acks"];
    try {
      acks = (
        await apiPost<AckBatchResponse>("/api/sync/operations", { operations })
      ).acks;
    } catch (error) {
      const message =
        error instanceof ApiError ? `HTTP ${error.status}` : "network error";
      await db.outbox.bulkPut(
        batch.map((row) => markAttemptFailed(row, Date.now(), message)),
      );
      for (const operation of operations) {
        inFlightByObject.delete(operation.objectId);
      }
      break;
    }

    const ackedOps = new Map<string, SyncOperation>(
      operations.map((op) => [op.id, op]),
    );
    let remainingRows = batch;
    const conflictOpIds = new Set<string>();
    for (const ack of acks) {
      const op = ackedOps.get(ack.operationId);
      if (!op) continue;
      if (ack.status === "applied" || ack.status === "duplicate") {
        // Durability rule: only store the revision, then remove from the outbox.
        const object = await storeAckedRevision(op, ack);
        changes.push({
          noteId: op.noteId,
          objects: object ? [object] : [],
          deletedObjectIds: object ? [] : [op.objectId],
        });
      }
      if (ack.status === "conflict") {
        // The server recorded the conflict and consumed this operation; surface it
        // in the local conflict list and drop the parked outbox row.
        await recordServerConflict(op, ack);
        conflictOpIds.add(op.id);
      }
      const reduction = applyAck(remainingRows, ack);
      remainingRows = reduction.remaining;
      if (reduction.ackedIds.length > 0) sent += reduction.ackedIds.length;
    }
    if (conflictOpIds.size > 0) {
      remainingRows = remainingRows.filter((row) => !conflictOpIds.has(row.id));
      await db.outbox.bulkDelete([...conflictOpIds]);
    }

    // Persist back the survivors (with any conflict parking / retry scheduling).
    await db.outbox.bulkPut(remainingRows);
    const ackedRowIds = batch
      .filter((row) => !remainingRows.some((r) => r.id === row.id))
      .map((row) => row.id);
    if (ackedRowIds.length > 0) await db.outbox.bulkDelete(ackedRowIds);
    for (const operation of operations) {
      inFlightByObject.delete(operation.objectId);
    }
    if (acks.length === 0) break; // Server returned nothing; avoid a hot loop.
  }

  const remaining = await db.outbox.count();
  return { sent, remaining, changes };
}

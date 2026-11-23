// Stores canvas edits and drains the durable IndexedDB outbox.
import {
  SYNC_REQUEST_BODY_LIMIT,
  type CanvasObject,
  type SyncAck,
  type SyncOperation,
} from "@aurora/shared";
import { ApiError, apiPost } from "../lib/http.js";
import { db, type ConflictRow, type OutboxRow } from "./db.js";
import {
  acknowledgedRevision,
  isDueObjectHead,
  markAttemptFailed,
  OUTBOX_BATCH_SIZE,
  queueMutation,
  rebaseOperation,
} from "./outboxCore.js";

interface AckBatchResponse {
  acks: SyncAck[];
}

const pendingEnqueues = new Map<Promise<void>, Set<string>>();
// A gesture can still hold its original object when its earlier edit is acknowledged.
const localRevisions = new Map<string, { from: number; to: number }>();

export function enqueueObjectMutations(
  operations: SyncOperation[],
): Promise<void> {
  if (operations.length === 0) return Promise.resolve();
  const pending = db.transaction("rw", db.outbox, db.objects, async () => {
    const latest = new Map<string, OutboxRow>();
    const rows = await rowsForObjects(operations.map((op) => op.objectId));
    for (const row of rows) latest.set(row.op.objectId, row);

    const updatedRows = new Map<string, OutboxRow>();
    const objects = new Map<string, CanvasObject>();
    const deletes = new Set<string>();
    for (let op of operations) {
      const previous = latest.get(op.objectId);
      const local = localRevisions.get(op.objectId);
      if (
        !previous &&
        local &&
        op.baseRevision >= local.from &&
        op.baseRevision < local.to
      ) {
        op = rebaseOperation(op, local.to);
      }
      const row = queueMutation(op, previous, Date.now());
      latest.set(op.objectId, row);
      updatedRows.set(row.id, row);
      if (row.op.mutation.type === "upsert") {
        objects.set(op.objectId, row.op.mutation.object);
        deletes.delete(op.objectId);
      } else {
        objects.delete(op.objectId);
        deletes.add(op.objectId);
      }
    }
    await db.outbox.bulkPut([...updatedRows.values()]);
    await db.objects.bulkPut([...objects.values()]);
    await db.objects.bulkDelete([...deletes]);
  });
  pendingEnqueues.set(pending, new Set(operations.map((op) => op.noteId)));
  return pending.finally(() => pendingEnqueues.delete(pending));
}

async function rowsForObjects(objectIds: string[]): Promise<OutboxRow[]> {
  return (
    await db.outbox.where("objectId").anyOf(objectIds).sortBy("createdAt")
  ).filter((row) => row.status !== "conflict");
}

/** Wait until in-process edits for this note have reached the durable outbox. */
export async function waitForPendingEnqueues(noteId: string): Promise<void> {
  await Promise.all(
    [...pendingEnqueues]
      .filter(([, noteIds]) => noteIds.has(noteId))
      .map(([pending]) => pending),
  );
}

export function countPendingNoteOperations(noteId: string): Promise<number> {
  return db.outbox
    .filter((row) => row.op.noteId === noteId && row.status !== "conflict")
    .count();
}

export async function makeNoteOperationsDue(noteId: string): Promise<void> {
  await db.outbox
    .filter((row) => row.op.noteId === noteId && row.status !== "conflict")
    .modify({ nextAttemptAt: 0 });
}

export interface AcknowledgedChange {
  noteId: string;
  objects: CanvasObject[];
  deletedObjectIds: string[];
  acknowledgement: true;
}

async function claimBatch(): Promise<OutboxRow[]> {
  return db.transaction("rw", db.outbox, async () => {
    const seen = new Set<string>();
    const now = Date.now();
    const due = await db.outbox
      .orderBy("createdAt")
      .filter((row) => isDueObjectHead(row, now, seen))
      .limit(OUTBOX_BATCH_SIZE)
      .toArray();
    const batch: OutboxRow[] = [];
    const encoder = new TextEncoder();
    let bytes = '{"orderedEdits":true,"operations":[]}'.length;
    for (const row of due) {
      bytes +=
        encoder.encode(JSON.stringify(row.op)).byteLength +
        (batch.length > 0 ? 1 : 0);
      // Send an oversized individual operation on its own so other edits can drain.
      if (batch.length > 0 && bytes > SYNC_REQUEST_BODY_LIMIT) break;
      batch.push({ ...row, sent: true });
    }
    // Once sent, the operation ID and payload must survive an uncertain response.
    await db.outbox.bulkPut(batch);
    return batch;
  });
}

async function storeAcknowledgements(
  batch: OutboxRow[],
  acknowledgements: SyncAck[],
): Promise<AcknowledgedChange[]> {
  const acks = new Map(acknowledgements.map((ack) => [ack.operationId, ack]));
  const changes = new Map<string, AcknowledgedChange>();
  const revisions = new Map<string, { from: number; to: number } | null>();
  const noteRevisions = new Map<string, number>();
  await db.transaction(
    "rw",
    [db.outbox, db.objects, db.notes, db.conflicts],
    async () => {
      const queued = await rowsForObjects(batch.map((row) => row.op.objectId));
      const batchIds = new Set(batch.map((row) => row.id));
      const present = new Set(queued.map((row) => row.id));
      const successors = new Map<string, OutboxRow[]>();
      for (const row of queued) {
        if (batchIds.has(row.id)) continue;
        const later = successors.get(row.op.objectId) ?? [];
        later.push(row);
        successors.set(row.op.objectId, later);
      }
      const completed: string[] = [];
      const updated: OutboxRow[] = [];
      const conflicts: ConflictRow[] = [];
      for (const row of batch) {
        if (!present.has(row.id)) continue;
        const { op } = row;
        const ack = acks.get(op.id);
        if (!ack) {
          updated.push(
            markAttemptFailed(row, Date.now(), "Missing acknowledgement"),
          );
          continue;
        }
        completed.push(row.id);
        const later = successors.get(op.objectId) ?? [];
        const next = later[0];
        const revision = acknowledgedRevision(op, ack);
        if (ack.status === "conflict") {
          conflicts.push({
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
          revisions.set(op.objectId, null);
          continue;
        }
        if (ack.object) {
          noteRevisions.set(
            op.noteId,
            Math.max(noteRevisions.get(op.noteId) ?? 0, ack.object.revision),
          );
        }
        if (op.mutation.type === "upsert" && revision !== undefined) {
          const previous = localRevisions.get(op.objectId);
          revisions.set(op.objectId, {
            from:
              previous?.to === op.baseRevision
                ? previous.from
                : op.baseRevision,
            to: revision,
          });
        } else {
          revisions.set(op.objectId, null);
        }

        let draft = later.at(-1)?.op;
        if (
          next &&
          !next.sent &&
          next.attempts === 0 &&
          revision !== undefined
        ) {
          const rebased = rebaseOperation(
            next.op,
            revision,
            op.mutation.type === "upsert" ? ack.object?.createdAt : undefined,
          );
          updated.push({ ...next, op: rebased });
          if (draft?.id === next.id) draft = rebased;
        }
        const object = draft
          ? draft.mutation.type === "upsert"
            ? draft.mutation.object
            : null
          : (ack.object ?? null);
        let change = changes.get(op.noteId);
        if (!change) {
          change = {
            noteId: op.noteId,
            objects: [],
            deletedObjectIds: [],
            acknowledgement: true,
          };
          changes.set(op.noteId, change);
        }
        if (object) change.objects.push(object);
        else change.deletedObjectIds.push(op.objectId);
      }
      const noteChanges = [...changes.values()];
      await db.objects.bulkPut(noteChanges.flatMap((change) => change.objects));
      await db.objects.bulkDelete(
        noteChanges.flatMap((change) => change.deletedObjectIds),
      );
      const notes = await db.notes.bulkGet([...noteRevisions.keys()]);
      await db.notes.bulkPut(
        notes.flatMap((note) => {
          if (!note) return [];
          const revision = noteRevisions.get(note.id) ?? 0;
          return revision > note.revision ? [{ ...note, revision }] : [];
        }),
      );
      await db.conflicts.bulkPut(conflicts);
      await db.outbox.bulkPut(updated);
      await db.outbox.bulkDelete(completed);
      for (const [id, revision] of revisions) {
        if (revision) localRevisions.set(id, revision);
        else localRevisions.delete(id);
      }
    },
  );
  return [...changes.values()];
}

async function drainOutbox(
  onChanges: (changes: AcknowledgedChange[]) => void,
): Promise<void> {
  for (;;) {
    const batch = await claimBatch();
    if (batch.length === 0) return;
    let acks: SyncAck[];
    try {
      ({ acks } = await apiPost<AckBatchResponse>("/api/sync/operations", {
        orderedEdits: true,
        operations: batch.map((row) => row.op),
      }));
    } catch (error) {
      const message =
        error instanceof ApiError ? `HTTP ${error.status}` : "network error";
      await db.transaction("rw", db.outbox, async () => {
        const rows = await db.outbox.bulkGet(batch.map((row) => row.id));
        await db.outbox.bulkPut(
          rows.flatMap((row) =>
            row ? [markAttemptFailed(row, Date.now(), message)] : [],
          ),
        );
      });
      return;
    }
    onChanges(await storeAcknowledgements(batch, acks));
  }
}

/** A single tab drains the shared outbox so two tabs cannot send a successor out of order. */
export async function flushOutbox(
  onChanges: (changes: AcknowledgedChange[]) => void,
): Promise<void> {
  if (navigator.locks) {
    await navigator.locks.request("aurora-outbox", () =>
      drainOutbox(onChanges),
    );
  } else {
    await drainOutbox(onChanges);
  }
}

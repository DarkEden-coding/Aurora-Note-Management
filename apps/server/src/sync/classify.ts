// Pure sync classification rules: decide whether an operation applies or conflicts, without any I/O.
import type { CanvasObject, SyncOperation } from "@aurora/shared";

export type OperationStatus = "apply" | "conflict";

// Rules:
// - Unknown object with baseRevision 0 (create) applies.
// - Unknown object with baseRevision > 0 conflicts: the client claims knowledge of an object that does not exist.
// - Known object applies only when the client base revision matches the authoritative revision.
export function classifyOperation(
  current: CanvasObject | null,
  op: SyncOperation,
): OperationStatus {
  if (!current) {
    return op.baseRevision === 0 ? "apply" : "conflict";
  }
  return current.revision === op.baseRevision ? "apply" : "conflict";
}

// Conflict records keep complete server and client object versions for explicit resolution later.
export type ConflictRecordInput = {
  objectId: string;
  baseObject: CanvasObject | null;
  incomingObject: CanvasObject | DeleteMarker;
};

export type DeleteMarker = {
  deleted: true;
  baseRevision: number;
  clientTimestamp: string;
};

export function toDeleteMarker(op: SyncOperation): DeleteMarker {
  return {
    deleted: true,
    baseRevision: op.baseRevision,
    clientTimestamp: op.clientTimestamp,
  };
}

export function toConflictRecord(
  current: CanvasObject | null,
  op: SyncOperation,
): ConflictRecordInput {
  const incomingObject =
    op.mutation.type === "upsert" ? op.mutation.object : toDeleteMarker(op);
  return {
    objectId: op.objectId,
    baseObject: current,
    incomingObject,
  };
}

// Unit tests for Aurora's pure sync classification rules: apply versus conflict decisions.
import { describe, expect, it } from "vitest";
import type { CanvasObject, SyncOperation } from "@aurora/shared";
import { classifyOperation, toConflictRecord } from "../src/sync/classify.js";

const objectId = "11111111-1111-1111-1111-111111111111";
const noteId = "22222222-2222-2222-2222-222222222222";
const deviceId = "33333333-3333-3333-3333-333333333333";
const opId = "44444444-4444-4444-4444-444444444444";

function makeObject(revision: number): CanvasObject {
  return {
    id: objectId,
    ownerId: "55555555-5555-5555-5555-555555555555",
    noteId,
    pageId: null,
    kind: "sticky-note",
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    rotation: 0,
    zIndex: 0,
    locked: false,
    groupId: null,
    payload: { text: "hello" },
    revision,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
}

function makeUpsertOp(
  baseRevision: number,
  object: CanvasObject,
): SyncOperation {
  return {
    id: opId,
    deviceId,
    noteId,
    objectId,
    baseRevision,
    clientTimestamp: "2025-01-02T00:00:00.000Z",
    mutation: { type: "upsert", object },
  };
}

function makeDeleteOp(baseRevision: number): SyncOperation {
  return {
    id: opId,
    deviceId,
    noteId,
    objectId,
    baseRevision,
    clientTimestamp: "2025-01-02T00:00:00.000Z",
    mutation: { type: "delete" },
  };
}

describe("classifyOperation", () => {
  it("applies a create (baseRevision 0) for an unknown object", () => {
    expect(classifyOperation(null, makeUpsertOp(0, makeObject(0)))).toBe(
      "apply",
    );
    expect(classifyOperation(null, makeDeleteOp(0))).toBe("apply");
  });

  it("conflicts when a client claims knowledge of a nonexistent object", () => {
    expect(classifyOperation(null, makeUpsertOp(3, makeObject(0)))).toBe(
      "conflict",
    );
  });

  it("applies when the base revision matches the authoritative revision", () => {
    expect(
      classifyOperation(makeObject(4), makeUpsertOp(4, makeObject(0))),
    ).toBe("apply");
  });

  it("conflicts on stale base revisions", () => {
    expect(
      classifyOperation(makeObject(7), makeUpsertOp(5, makeObject(0))),
    ).toBe("conflict");
    expect(classifyOperation(makeObject(7), makeDeleteOp(5))).toBe("conflict");
  });
});

describe("toConflictRecord", () => {
  it("keeps the complete incoming object for upsert conflicts", () => {
    const current = makeObject(7);
    const incoming = makeObject(0);
    const op = makeUpsertOp(5, incoming);
    const record = toConflictRecord(current, op);
    expect(record.objectId).toBe(objectId);
    expect(record.baseObject).toEqual(current);
    expect(record.incomingObject).toEqual(incoming);
  });

  it("records a delete marker for delete conflicts", () => {
    const record = toConflictRecord(makeObject(7), makeDeleteOp(5));
    expect(record.incomingObject).toEqual({
      deleted: true,
      baseRevision: 5,
      clientTimestamp: "2025-01-02T00:00:00.000Z",
    });
  });
});

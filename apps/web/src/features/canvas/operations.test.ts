// Focused tests for SyncOperation factories: operation shape, idempotent identity fields, and the delete mutation contract.
import { describe, expect, it } from "vitest";
import type { CanvasObject } from "@aurora/shared";
import { makeCanvasObject } from "./objects";
import {
  getDeviceId,
  makeDeleteOperation,
  makeUpsertOperation,
  newId,
} from "./operations";

const NOTE_ID = "00000000-0000-4000-8000-00000000b001";
const DEVICE_ID = "00000000-0000-4000-8000-00000000d001";
const OWNER_ID = "00000000-0000-4000-8000-00000000a001";

const OBJECT: CanvasObject = makeCanvasObject({
  id: "00000000-0000-4000-8000-00000000c001",
  ownerId: OWNER_ID,
  noteId: NOTE_ID,
  kind: "rectangle",
  bounds: { x: 0, y: 0, width: 10, height: 10 },
  zIndex: 1,
  revision: 4,
  payload: {},
});

describe("operation factories", () => {
  it("builds upsert operations with contract identity fields", () => {
    const op = makeUpsertOperation(OBJECT, NOTE_ID, DEVICE_ID);
    expect(op.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(op.deviceId).toBe(DEVICE_ID);
    expect(op.noteId).toBe(NOTE_ID);
    expect(op.objectId).toBe(OBJECT.id);
    expect(op.baseRevision).toBe(4);
    expect(op.clientTimestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(op.mutation).toEqual({ type: "upsert", object: OBJECT });
  });

  it("builds delete operations without carrying the object", () => {
    const op = makeDeleteOperation(OBJECT.id, 4, NOTE_ID, DEVICE_ID);
    expect(op.mutation).toEqual({ type: "delete" });
    expect(op.objectId).toBe(OBJECT.id);
    expect(op.baseRevision).toBe(4);
  });

  it("generates unique ids", () => {
    expect(newId()).not.toBe(newId());
  });

  it("falls back to a random device id when localStorage is unavailable", () => {
    const id = getDeviceId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

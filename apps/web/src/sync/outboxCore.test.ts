// These Vitest checks cover Aurora's pure outbox logic — retry backoff, due-batch selection, and acknowledgement reduction — without IndexedDB or network.
import { describe, expect, it } from "vitest";
import type { CanvasObject, SyncAck, SyncOperation } from "@aurora/shared";
import {
  applyAck,
  buildOperation,
  computeBackoffMs,
  filterChangesForPendingOperations,
  markAttemptFailed,
  OUTBOX_BATCH_SIZE,
  preserveLocalDraft,
  selectDueBatch,
} from "./outboxCore.js";
import type { OutboxRow } from "./db.js";

function makeObject(id: string, revision: number, text: string): CanvasObject {
  return {
    id,
    ownerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    noteId: "22222222-2222-4222-8222-222222222222",
    pageId: null,
    kind: "rich-text",
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    rotation: 0,
    zIndex: 1,
    locked: false,
    groupId: null,
    payload: { text },
    revision,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:01.000Z",
  };
}

function makeOp(id: string, createdAt: number): SyncOperation {
  return buildOperation({
    operationId: id,
    deviceId: "11111111-1111-4111-8111-111111111111",
    noteId: "22222222-2222-4222-8222-222222222222",
    objectId: "33333333-3333-4333-8333-333333333333",
    baseRevision: 3,
    mutation: { type: "delete" },
    clientTimestamp: new Date(createdAt).toISOString(),
  });
}

function makeRow(id: string, overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id,
    op: makeOp(id, 1_000),
    createdAt: 1_000,
    attempts: 0,
    nextAttemptAt: 1_000,
    lastError: null,
    status: "pending",
    ...overrides,
  };
}

describe("server change reconciliation", () => {
  it("keeps pending local objects while allowing unrelated remote changes", () => {
    const localId = "33333333-3333-4333-8333-333333333333";
    const remoteId = "44444444-4444-4444-8444-444444444444";
    const changes = filterChangesForPendingOperations(
      {
        objects: [
          makeObject(localId, 4, "stale server text"),
          makeObject(remoteId, 1, "remote drawing"),
        ],
        deletedObjectIds: [localId, remoteId],
      },
      [makeRow("pending")],
    );

    expect(changes.objects.map((object) => object.id)).toEqual([remoteId]);
    expect(changes.deletedObjectIds).toEqual([remoteId]);
  });

  it("advances a newer draft revision without replacing its content", () => {
    const objectId = "33333333-3333-4333-8333-333333333333";
    const draft = makeRow("newer", {
      createdAt: 2_000,
      op: {
        ...makeOp("newer", 2_000),
        baseRevision: 4,
        mutation: {
          type: "upsert",
          object: makeObject(objectId, 3, "latest local text"),
        },
      },
    });

    const result = preserveLocalDraft(
      makeObject(objectId, 4, "older acknowledged text"),
      [draft],
      "acknowledged",
    );

    expect(result.object.payload).toEqual({ text: "latest local text" });
    expect(result.object.revision).toBe(4);
    expect(result.updatedRow?.op.baseRevision).toBe(4);
    expect(result.updatedRow?.op.mutation).toEqual({
      type: "upsert",
      object: result.object,
    });
  });
});

describe("computeBackoffMs", () => {
  it("doubles from the base and caps", () => {
    expect(computeBackoffMs(1)).toBe(1_000);
    expect(computeBackoffMs(2)).toBe(2_000);
    expect(computeBackoffMs(3)).toBe(4_000);
    expect(computeBackoffMs(6)).toBe(32_000);
  });

  it("never exceeds the cap regardless of attempt count", () => {
    expect(computeBackoffMs(50)).toBe(5 * 60 * 1_000);
  });
});

describe("selectDueBatch", () => {
  it("returns only due rows in enqueue order and respects the batch size", () => {
    const rows = [
      makeRow("a", { createdAt: 3 }),
      makeRow("b", { createdAt: 1 }),
      makeRow("c", { createdAt: 2, nextAttemptAt: 5_000 }),
      makeRow("d", { createdAt: 4, status: "conflict" }),
      ...Array.from({ length: OUTBOX_BATCH_SIZE }, (_, i) =>
        makeRow(`filler-${i}`, { createdAt: 10 + i }),
      ),
    ];
    const due = selectDueBatch(rows, 2_000);
    expect(due.length).toBe(OUTBOX_BATCH_SIZE);
    expect(due[0]!.id).toBe("b");
    expect(due[1]!.id).toBe("a");
    expect(due.some((row) => row.id === "c")).toBe(false);
    expect(due.some((row) => row.id === "d")).toBe(false);
  });
});

describe("markAttemptFailed", () => {
  it("increments attempts and schedules the next retry with backoff", () => {
    const row = makeRow("x", { attempts: 2 });
    const updated = markAttemptFailed(row, 10_000, "network down");
    expect(updated.attempts).toBe(3);
    expect(updated.status).toBe("failed");
    expect(updated.lastError).toBe("network down");
    expect(updated.nextAttemptAt).toBe(14_000);
  });
});

describe("applyAck", () => {
  it("drops the operation when it was applied", () => {
    const rows = [makeRow("a"), makeRow("b")];
    const ack: SyncAck = {
      operationId: "a",
      status: "applied",
      serverTimestamp: new Date().toISOString(),
    };
    const result = applyAck(rows, ack);
    expect(result.ackedIds).toEqual(["a"]);
    expect(result.remaining.map((row) => row.id)).toEqual(["b"]);
  });

  it("drops the operation when it was a duplicate (idempotent replay)", () => {
    const rows = [makeRow("a")];
    const ack: SyncAck = {
      operationId: "a",
      status: "duplicate",
      serverTimestamp: new Date().toISOString(),
    };
    expect(applyAck(rows, ack).remaining).toEqual([]);
  });

  it("parks the operation instead of retrying when it conflicts", () => {
    const rows = [makeRow("a")];
    const ack: SyncAck = {
      operationId: "a",
      status: "conflict",
      conflictId: "44444444-4444-4444-8444-444444444444",
      serverTimestamp: new Date().toISOString(),
    };
    const result = applyAck(rows, ack);
    expect(result.ackedIds).toEqual([]);
    expect(result.remaining[0]!.status).toBe("conflict");
    expect(selectDueBatch(result.remaining, Number.MAX_SAFE_INTEGER)).toEqual(
      [],
    );
  });

  it("leaves the queue untouched for unknown operation IDs", () => {
    const rows = [makeRow("a")];
    const ack: SyncAck = {
      operationId: "99999999-9999-4999-8999-999999999999",
      status: "applied",
      serverTimestamp: new Date().toISOString(),
    };
    const result = applyAck(rows, ack);
    expect(result.ackedIds).toEqual([]);
    expect(result.remaining).toHaveLength(1);
  });
});

// These Vitest checks cover Aurora's pure outbox logic — retry backoff, due-ordering and revision reconciliation — without IndexedDB or network.
import { describe, expect, it } from "vitest";
import type { CanvasObject, SyncAck, SyncOperation } from "@aurora/shared";
import {
  acknowledgedRevision,
  buildOperation,
  computeBackoffMs,
  filterChangesForPendingOperations,
  markAttemptFailed,
  isDueObjectHead,
  queueMutation,
  rebaseOperation,
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
});

describe("queued object edits", () => {
  const objectId = makeOp("add", 1000).objectId;
  const create: SyncOperation = {
    ...makeOp("add", 1000),
    baseRevision: 0,
    mutation: {
      type: "upsert",
      object: makeObject(objectId, 0, "first stroke"),
    },
  };

  it("sends an erase after the create with the server's actual revision zero", () => {
    const head = { ...queueMutation(create, undefined, 1000), sent: true };
    const erase = queueMutation(
      { ...makeOp("erase", 1000), baseRevision: 1 },
      head,
      1000,
    );
    expect(erase.id).toBe("erase");
    expect(erase.createdAt).toBeGreaterThan(head.createdAt);

    const revision = acknowledgedRevision(create, {
      operationId: create.id,
      status: "applied",
      object: makeObject(objectId, 0, "first stroke"),
      resultRevision: 0,
      serverTimestamp: create.clientTimestamp,
    });
    expect(revision).toBe(0);
    expect(rebaseOperation(erase.op, revision!)).toMatchObject({
      baseRevision: 0,
      mutation: { type: "delete" },
    });
  });

  it("keeps later edits behind a retrying head and allows other objects through", () => {
    const head = makeRow("head", { nextAttemptAt: 2000, sent: true });
    const successor = makeRow("successor", { createdAt: 1001 });
    const unrelated = makeRow("other", {
      op: { ...makeOp("other", 1002), objectId: "other-object" },
    });
    const seen = new Set<string>();
    expect(
      [head, successor, unrelated].filter((row) =>
        isDueObjectHead(row, 1000, seen),
      ),
    ).toEqual([unrelated]);
  });

  it("coalesces unsent changes while preserving the first edit's base and ID", () => {
    const first = queueMutation(create, undefined, 1000);
    const move = {
      ...create,
      id: "move",
      baseRevision: 1,
      mutation: { type: "upsert", object: makeObject(objectId, 1, "moved") },
    } satisfies SyncOperation;
    expect(queueMutation(move, first, 1001)).toMatchObject({
      id: create.id,
      createdAt: 1000,
      op: { id: create.id, baseRevision: 0, mutation: move.mutation },
    });
  });

  it("rebases undo of a sent delete to zero and retains the draft content", () => {
    const erase = makeOp("erase", 1000);
    const revision = acknowledgedRevision(erase, {
      operationId: erase.id,
      status: "duplicate",
      resultRevision: 0,
      serverTimestamp: erase.clientTimestamp,
    });
    const restored = rebaseOperation(
      {
        ...create,
        baseRevision: 3,
        mutation: {
          type: "upsert",
          object: makeObject(objectId, 3, "restored"),
        },
      },
      revision!,
    );
    expect(restored).toMatchObject({
      baseRevision: 0,
      mutation: { object: { revision: 0, payload: { text: "restored" } } },
    });
  });

  it("uses the original revision on retry even if another device has edited the object", () => {
    const laterServerObject = makeObject(objectId, 3, "other device edit");
    const ack: SyncAck = {
      operationId: create.id,
      status: "duplicate",
      object: laterServerObject,
      resultRevision: 0,
      serverTimestamp: create.clientTimestamp,
    };
    expect(acknowledgedRevision(create, ack)).toBe(0);
    expect(
      acknowledgedRevision(create, { ...ack, status: "conflict" }),
    ).toBeUndefined();
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

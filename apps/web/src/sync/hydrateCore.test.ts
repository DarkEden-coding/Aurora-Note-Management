// Covers hydration ordering, revision merging, and safe regional deletion.
import { describe, expect, it } from "vitest";
import type { CanvasObject } from "@aurora/shared";
import {
  HydrationGenerations,
  newerHydratedObjects,
  safeMissingObjectIds,
} from "./hydrateCore.js";

function object(id: string, revision: number, x = 0): CanvasObject {
  return {
    id,
    ownerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    noteId: "22222222-2222-4222-8222-222222222222",
    pageId: null,
    kind: "rich-text",
    bounds: { x, y: 0, width: 20, height: 20 },
    rotation: 0,
    zIndex: 1,
    locked: false,
    groupId: null,
    payload: { text: id },
    revision,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
}

describe("hydration race reconciliation", () => {
  it("allows only the newest request generation for each note", () => {
    const generations = new HydrationGenerations();
    const slow = generations.begin("note-a");
    const latest = generations.begin("note-a");
    const otherNote = generations.begin("note-b");

    expect(generations.isCurrent("note-a", slow)).toBe(false);
    expect(generations.isCurrent("note-a", latest)).toBe(true);
    expect(generations.isCurrent("note-b", otherNote)).toBe(true);
  });

  it("does not replace an equal or newer cached revision", () => {
    const stale = object("stale", 2);
    const equal = object("equal", 3);
    const fresh = object("fresh", 5);

    expect(
      newerHydratedObjects(
        [stale, equal, fresh],
        [object("stale", 4), object("equal", 3), object("fresh", 4)],
      ).map((item) => item.id),
    ).toEqual(["fresh"]);
  });

  it("does not delete objects created or revised while the request was in flight", () => {
    const unchanged = object("unchanged", 2);
    const revised = object("revised", 4);
    const newlyReceived = object("new", 1);
    const queued = object("queued", 2);

    expect(
      safeMissingObjectIds({
        cached: [unchanged, revised, newlyReceived, queued],
        returnedIds: new Set(),
        queuedIds: new Set(["queued"]),
        startRevisions: new Map([
          ["unchanged", 2],
          ["revised", 3],
          ["queued", 2],
        ]),
        viewport: { x: -10, y: -10, width: 100, height: 100 },
      }),
    ).toEqual(["unchanged"]);
  });
});

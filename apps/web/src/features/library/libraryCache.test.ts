// Verifies conversion and partitioning of cached library notes.
import { describe, expect, it } from "vitest";
import type { LibraryTree } from "./types.js";
import { partitionCachedNotes, toCachedNote } from "./libraryCache.js";

const background = {
  pattern: "dot-grid" as const,
  color: "#111111",
  patternColor: "#333333",
  spacing: 24,
};

function treeNote(trashed: boolean): LibraryTree["notes"][number] {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    folderId: "33333333-3333-4333-8333-333333333333",
    title: "Offline note",
    kind: "canvas",
    canvasMode: "infinite",
    background,
    favorite: false,
    trashed,
    archived: false,
    revision: 2,
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
}

describe("offline library cache", () => {
  it("keeps note container identifiers and local recent metadata", () => {
    const cached = toCachedNote(treeNote(false), {
      ...toCachedNote(treeNote(false)),
      lastOpenedAt: "2025-02-01T00:00:00.000Z",
    });

    expect(cached.projectId).toBe("22222222-2222-4222-8222-222222222222");
    expect(cached.folderId).toBe("33333333-3333-4333-8333-333333333333");
    expect(cached.lastOpenedAt).toBe("2025-02-01T00:00:00.000Z");
  });

  it("keeps trashed notes available separately for recovery", () => {
    const active = toCachedNote(treeNote(false));
    const trashed = toCachedNote({
      ...treeNote(true),
      id: "44444444-4444-4444-8444-444444444444",
    });

    expect(partitionCachedNotes([active, trashed])).toEqual({
      active: [active],
      trashed: [trashed],
    });
  });
});

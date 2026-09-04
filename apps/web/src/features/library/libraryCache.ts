// Pure conversion helpers for the offline library snapshot.
import type { LibraryTree } from "./types.js";
import type { CachedNote } from "../../sync/db.js";

export function toCachedNote(
  note: LibraryTree["notes"][number],
  previous?: CachedNote,
): CachedNote {
  return {
    id: note.id,
    projectId: note.projectId,
    folderId: note.folderId,
    title: note.title,
    kind: note.kind,
    canvasMode: note.canvasMode,
    background: note.background,
    favorite: note.favorite,
    trashed: note.trashed,
    archived: note.archived,
    updatedAt: note.updatedAt,
    lastOpenedAt: previous?.lastOpenedAt ?? null,
    revision: note.revision,
  };
}

export function partitionCachedNotes(notes: readonly CachedNote[]): {
  active: CachedNote[];
  trashed: CachedNote[];
} {
  return {
    active: notes.filter((note) => !note.trashed),
    trashed: notes.filter((note) => note.trashed),
  };
}

// This module is the library HTTP surface: tree loading via GET /api/library plus
// project/folder/note mutations against the prefixed REST routes. Every response is
// unwrapped and mapped with the shared contract so client and server shapes match.
import { api, apiPatch, apiPost } from "../../lib/http.js";
import type {
  CanvasMode,
  LibraryFolder,
  LibraryNote,
  LibraryProject,
  LibraryTree,
  NoteKind,
} from "@aurora/shared";
import type {
  LibraryFolder as ClientFolder,
  LibraryNote as ClientNote,
  LibraryProject as ClientProject,
} from "./types.js";

// ---- Server row shapes (JSON bodies of the REST routes) --------------------

interface ProjectJson {
  id: string;
  name: string;
  sortOrder: number;
}

interface FolderJson {
  id: string;
  projectId: string;
  parentId: string | null;
  name: string;
}

interface NoteJson {
  id: string;
  projectId: string;
  folderId: string | null;
  title: string;
  kind: NoteKind;
  canvasMode: CanvasMode;
  favorite: boolean;
  archivedAt: string | null;
  trashedAt: string | null;
  revision: number;
  updatedAt: string;
}

function toProject(json: ProjectJson): ClientProject {
  return { id: json.id, name: json.name, order: json.sortOrder };
}

function toFolder(json: FolderJson): ClientFolder {
  return {
    id: json.id,
    projectId: json.projectId,
    parentId: json.parentId,
    name: json.name,
  };
}

function toNote(json: NoteJson): ClientNote {
  return {
    id: json.id,
    projectId: json.projectId,
    folderId: json.folderId,
    title: json.title,
    kind: json.kind,
    canvasMode: json.canvasMode,
    favorite: json.favorite,
    trashed: json.trashedAt !== null,
    archived: json.archivedAt !== null,
    revision: json.revision,
    updatedAt: json.updatedAt,
  };
}

export function fetchLibrary(): Promise<LibraryTree> {
  return api<LibraryTree>("/api/library");
}

export async function createProject(name: string): Promise<ClientProject> {
  const { project } = await apiPost<{ project: ProjectJson }>("/api/projects", {
    name,
  });
  return toProject(project);
}

export async function createFolder(
  projectId: string,
  parentId: string | null,
  name: string,
): Promise<ClientFolder> {
  const { folder } = await apiPost<{ folder: FolderJson }>(
    `/api/projects/${projectId}/folders`,
    {
      name,
      ...(parentId ? { parentId } : {}),
    },
  );
  return toFolder(folder);
}

export async function createNote(
  projectId: string,
  folderId: string | null,
  title: string,
): Promise<ClientNote> {
  const { note } = await apiPost<{ note: NoteJson }>("/api/notes", {
    projectId,
    ...(folderId ? { folderId } : {}),
    ...(title ? { title } : {}),
  });
  return toNote(note);
}

export type NotePatch = Partial<
  Pick<ClientNote, "title" | "favorite" | "trashed" | "archived" | "folderId">
>;

/**
 * Applies a note patch through the dedicated state routes the server exposes
 * (favorite/unfavorite, trash/restore, archive/unarchive, PATCH for title/folder).
 * The state routes return the full server note so local caches stay consistent.
 */
export async function updateNote(
  noteId: string,
  patch: NotePatch,
): Promise<ClientNote> {
  let latest: ClientNote | null = null;
  const apply = async (
    run: () => Promise<{ note: NoteJson }>,
  ): Promise<void> => {
    const { note } = await run();
    latest = toNote(note);
  };
  if (patch.title !== undefined || patch.folderId !== undefined) {
    await apply(() =>
      apiPatch<{ note: NoteJson }>(`/api/notes/${noteId}`, {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.folderId !== undefined ? { folderId: patch.folderId } : {}),
      }),
    );
  }
  if (patch.favorite !== undefined) {
    await apply(() =>
      apiPost<{ note: NoteJson }>(
        `/api/notes/${noteId}/${patch.favorite ? "favorite" : "unfavorite"}`,
        {},
      ),
    );
  }
  if (patch.trashed !== undefined) {
    await apply(() =>
      apiPost<{ note: NoteJson }>(
        `/api/notes/${noteId}/${patch.trashed ? "trash" : "restore"}`,
        {},
      ),
    );
  }
  if (patch.archived !== undefined) {
    await apply(() =>
      apiPost<{ note: NoteJson }>(
        `/api/notes/${noteId}/${patch.archived ? "archive" : "unarchive"}`,
        {},
      ),
    );
  }
  if (latest === null) {
    throw new Error(`updateNote called with an empty patch for ${noteId}`);
  }
  return latest;
}

/** Permanent delete: the first DELETE moves a live note to trash, a second purges it. */
export async function deleteNoteForever(noteId: string): Promise<void> {
  await api(`/api/notes/${noteId}`, { method: "DELETE" });
}

// Aggregates the owner's whole library (projects, folders, notes) into the shared
// GET /api/library tree contract. This is the single hydration endpoint the web
// sidebar loads; note bodies and canvas objects stay behind regional routes.
import type { LibraryNote, LibraryTree } from "@aurora/shared";
import { query } from "../db/pool.js";
import { mapProject, type ProjectRow } from "./projects.js";
import { mapFolder, type FolderRow } from "./folders.js";
import { mapNote, type NoteRow } from "./map.js";

export async function getLibraryTree(ownerId: string): Promise<LibraryTree> {
  const [projects, folders, notes] = await Promise.all([
    query<ProjectRow>(
      `SELECT id, owner_id, name, color, sort_order, is_favorite, archived_at, created_at, updated_at
       FROM projects WHERE owner_id = $1 ORDER BY sort_order, created_at`,
      [ownerId],
    ),
    query<FolderRow>(
      `SELECT id, owner_id, project_id, parent_id, name, sort_order, created_at, updated_at
       FROM folders WHERE owner_id = $1 ORDER BY project_id, parent_id NULLS FIRST, sort_order, created_at`,
      [ownerId],
    ),
    query<NoteRow>(
      `SELECT id, owner_id, project_id, folder_id, title, kind, canvas_mode, background,
              favorite, archived_at, trashed_at, revision, created_at, updated_at
       FROM notes WHERE owner_id = $1 ORDER BY updated_at DESC`,
      [ownerId],
    ),
  ]);

  return {
    projects: projects.rows.map((row) => {
      const project = mapProject(row);
      return { id: project.id, name: project.name, order: project.sortOrder };
    }),
    folders: folders.rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      parentId: row.parent_id,
      name: row.name,
    })),
    notes: notes.rows.map((row): LibraryNote => {
      const note = mapNote(row);
      return {
        id: note.id,
        projectId: note.projectId,
        folderId: note.folderId,
        title: note.title,
        kind: note.kind,
        canvasMode: note.canvasMode,
        favorite: note.favorite,
        trashed: note.trashedAt !== null,
        archived: note.archivedAt !== null,
        revision: note.revision,
        updatedAt: note.updatedAt,
      };
    }),
  };
}

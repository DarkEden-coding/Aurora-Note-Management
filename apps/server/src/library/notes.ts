// Provides owner-scoped note CRUD, archive/favorite/trash state, and live note link resolution.
import { conflict, forbidden, notFound } from "../errors.js";
import { query } from "../db/pool.js";
import {
  DEFAULT_BACKGROUND,
  mapNote,
  mapPage,
  mergeBackground,
  type NoteJson,
  type NoteRow,
  type PageJson,
  type PageRow,
} from "./map.js";
import {
  backgroundSchema,
  type Background,
  type CanvasMode,
} from "@aurora/shared";

const NOTE_SELECT = `
  SELECT id, owner_id, project_id, folder_id, title, kind, canvas_mode, background,
         favorite, archived_at, trashed_at, revision, created_at, updated_at
  FROM notes
`;

function noteUpdateAssignments(): string[] {
  return ["updated_at = now()", "revision = revision + 1"];
}

export async function ensureNote(
  ownerId: string,
  noteId: string,
): Promise<NoteRow> {
  const result = await query<NoteRow>(
    `${NOTE_SELECT} WHERE owner_id = $1 AND id = $2`,
    [ownerId, noteId],
  );
  const row = result.rows[0];
  if (!row) throw notFound("Note");
  return row;
}

export async function listNotes(
  ownerId: string,
  filters: {
    projectId?: string | undefined;
    folderId?: string | undefined;
    favorite?: boolean | undefined;
    archived?: boolean | undefined;
    trashed?: boolean | undefined;
    kind?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
  },
): Promise<NoteJson[]> {
  const conditions = ["owner_id = $1"];
  const params: unknown[] = [ownerId];
  if (filters.projectId) {
    params.push(filters.projectId);
    conditions.push(`project_id = $${params.length}`);
  }
  if (filters.folderId) {
    params.push(filters.folderId);
    conditions.push(`folder_id = $${params.length}`);
  }
  if (filters.favorite !== undefined) {
    params.push(filters.favorite);
    conditions.push(`favorite = $${params.length}`);
  }
  if (filters.trashed) {
    conditions.push("trashed_at IS NOT NULL");
  } else {
    conditions.push("trashed_at IS NULL");
  }
  conditions.push(
    filters.archived ? "archived_at IS NOT NULL" : "archived_at IS NULL",
  );
  if (filters.kind) {
    params.push(filters.kind);
    conditions.push(`kind = $${params.length}`);
  }
  const limit = filters.limit ?? 100;
  params.push(limit);
  const offset = filters.offset ?? 0;
  params.push(offset);
  const result = await query<NoteRow>(
    `${NOTE_SELECT} WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return result.rows.map(mapNote);
}

export async function createNote(
  ownerId: string,
  input: {
    projectId: string;
    folderId?: string | undefined;
    title?: string | undefined;
    kind?: "canvas" | "pdf" | undefined;
    canvasMode?: CanvasMode | undefined;
    background?: Background | undefined;
  },
): Promise<NoteJson> {
  if (input.folderId) {
    const folder = await query<{ project_id: string }>(
      "SELECT project_id FROM folders WHERE owner_id = $1 AND id = $2",
      [ownerId, input.folderId],
    );
    if (!folder.rows[0]) throw notFound("Folder");
    if (folder.rows[0].project_id !== input.projectId) {
      throw conflict("Folder belongs to a different project");
    }
  }
  const background: Background = input.background
    ? backgroundSchema.parse(input.background)
    : DEFAULT_BACKGROUND;
  const result = await query<NoteRow>(
    `INSERT INTO notes (owner_id, project_id, folder_id, title, kind, canvas_mode, background)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, owner_id, project_id, folder_id, title, kind, canvas_mode, background,
               favorite, archived_at, trashed_at, revision, created_at, updated_at`,
    [
      ownerId,
      input.projectId,
      input.folderId ?? null,
      input.title ?? "Untitled note",
      input.kind ?? "canvas",
      input.canvasMode ?? "infinite",
      JSON.stringify(background),
    ],
  );
  return mapNote(result.rows[0]!);
}

export async function getNoteWithPages(
  ownerId: string,
  noteId: string,
): Promise<{ note: NoteJson; pages: PageJson[] }> {
  const note = await ensureNote(ownerId, noteId);
  const pages = await query<PageRow>(
    `SELECT id, owner_id, note_id, page_index, width, height, background, created_at, updated_at
     FROM pages WHERE owner_id = $1 AND note_id = $2 ORDER BY page_index`,
    [ownerId, noteId],
  );
  return { note: mapNote(note), pages: pages.rows.map(mapPage) };
}

export async function updateNote(
  ownerId: string,
  noteId: string,
  patch: {
    title?: string | undefined;
    folderId?: string | null | undefined;
    background?: Background | undefined;
    canvasMode?: CanvasMode | undefined;
  },
): Promise<NoteJson> {
  const note = await ensureNote(ownerId, noteId);
  let folderId = note.folder_id;
  if (patch.folderId !== undefined) {
    if (patch.folderId) {
      const folder = await query<{ project_id: string }>(
        "SELECT project_id FROM folders WHERE owner_id = $1 AND id = $2",
        [ownerId, patch.folderId],
      );
      if (!folder.rows[0]) throw notFound("Folder");
      if (folder.rows[0].project_id !== note.project_id) {
        throw conflict("Folder belongs to a different project");
      }
    }
    folderId = patch.folderId;
  }
  const background = patch.background
    ? backgroundSchema.parse(patch.background)
    : mergeBackground(note.background);
  const result = await query<NoteRow>(
    `UPDATE notes SET folder_id = $3, title = COALESCE($4, title), background = $5,
       canvas_mode = COALESCE($6, canvas_mode), ${noteUpdateAssignments().join(", ")}
     WHERE owner_id = $1 AND id = $2
     RETURNING id, owner_id, project_id, folder_id, title, kind, canvas_mode, background,
               favorite, archived_at, trashed_at, revision, created_at, updated_at`,
    [
      ownerId,
      noteId,
      folderId,
      patch.title ?? null,
      JSON.stringify(background),
      patch.canvasMode ?? null,
    ],
  );
  return mapNote(result.rows[0]!);
}

export async function setNoteArchived(
  ownerId: string,
  noteId: string,
  archived: boolean,
): Promise<NoteJson> {
  await ensureNote(ownerId, noteId);
  const result = await query<NoteRow>(
    `UPDATE notes SET archived_at = ${archived ? "now()" : "NULL"}, ${noteUpdateAssignments().join(", ")}
     WHERE owner_id = $1 AND id = $2
     RETURNING id, owner_id, project_id, folder_id, title, kind, canvas_mode, background,
               favorite, archived_at, trashed_at, revision, created_at, updated_at`,
    [ownerId, noteId],
  );
  return mapNote(result.rows[0]!);
}

export async function setNoteFavorite(
  ownerId: string,
  noteId: string,
  favorite: boolean,
): Promise<NoteJson> {
  await ensureNote(ownerId, noteId);
  const result = await query<NoteRow>(
    `UPDATE notes SET favorite = $3, ${noteUpdateAssignments().join(", ")}
     WHERE owner_id = $1 AND id = $2
     RETURNING id, owner_id, project_id, folder_id, title, kind, canvas_mode, background,
               favorite, archived_at, trashed_at, revision, created_at, updated_at`,
    [ownerId, noteId, favorite],
  );
  return mapNote(result.rows[0]!);
}

export async function setNoteTrashed(
  ownerId: string,
  noteId: string,
  trashed: boolean,
): Promise<NoteJson> {
  await ensureNote(ownerId, noteId);
  const result = await query<NoteRow>(
    `UPDATE notes SET trashed_at = ${trashed ? "now()" : "NULL"}, ${noteUpdateAssignments().join(", ")}
     WHERE owner_id = $1 AND id = $2
     RETURNING id, owner_id, project_id, folder_id, title, kind, canvas_mode, background,
               favorite, archived_at, trashed_at, revision, created_at, updated_at`,
    [ownerId, noteId],
  );
  return mapNote(result.rows[0]!);
}

// DELETE moves the note to trash first; a second DELETE performs the permanent delete.
export async function deleteNote(
  ownerId: string,
  noteId: string,
): Promise<{ trashed: boolean; deleted: boolean }> {
  const note = await ensureNote(ownerId, noteId);
  if (!note.trashed_at) {
    await setNoteTrashed(ownerId, noteId, true);
    return { trashed: true, deleted: false };
  }
  await query("DELETE FROM notes WHERE owner_id = $1 AND id = $2", [
    ownerId,
    noteId,
  ]);
  return { trashed: false, deleted: true };
}

export type NoteLinkRow = {
  id: string;
  owner_id: string;
  source_note_id: string;
  target_note_id: string;
  target_page_index: number | null;
  target_note_title: string;
  target_note_trashed_at: Date | null;
  target_note_deleted: boolean;
  target_page_count: number;
};

export function mapNoteLink(row: NoteLinkRow): {
  id: string;
  sourceNoteId: string;
  targetNoteId: string;
  targetPageIndex: number | null;
  targetNoteTitle: string;
  targetNoteState: "live" | "trashed" | "deleted";
  targetPageCount: number;
} {
  const targetNoteState: "live" | "trashed" | "deleted" =
    row.target_note_deleted
      ? "deleted"
      : row.target_note_trashed_at
        ? "trashed"
        : "live";
  return {
    id: row.id,
    sourceNoteId: row.source_note_id,
    targetNoteId: row.target_note_id,
    targetPageIndex:
      row.target_page_index === null ? null : Number(row.target_page_index),
    targetNoteTitle: row.target_note_title,
    targetNoteState,
    targetPageCount: Number(row.target_page_count),
  };
}

export async function listNoteLinks(ownerId: string, noteId: string) {
  await ensureNote(ownerId, noteId);
  const result = await query<NoteLinkRow>(
    `SELECT l.id, l.owner_id, l.source_note_id, l.target_note_id, l.target_page_index,
            t.title AS target_note_title, t.trashed_at AS target_note_trashed_at,
            (t.id IS NULL) AS target_note_deleted,
            (SELECT count(*) FROM pages p WHERE p.owner_id = l.owner_id AND p.note_id = l.target_note_id) AS target_page_count
     FROM note_links l
     LEFT JOIN notes t ON t.owner_id = l.owner_id AND t.id = l.target_note_id
     WHERE l.owner_id = $1 AND l.source_note_id = $2
     ORDER BY l.created_at`,
    [ownerId, noteId],
  );
  return result.rows.map(mapNoteLink);
}

export async function createNoteLink(
  ownerId: string,
  noteId: string,
  input: { targetNoteId: string; targetPageIndex?: number | undefined },
) {
  if (input.targetNoteId === noteId) {
    throw conflict("Note cannot link to itself");
  }
  await ensureNote(ownerId, noteId);
  const target = await ensureNote(ownerId, input.targetNoteId);
  if (target.owner_id !== ownerId) throw forbidden("Target note");
  const result = await query<{ id: string }>(
    `INSERT INTO note_links (owner_id, source_note_id, target_note_id, target_page_index)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [ownerId, noteId, input.targetNoteId, input.targetPageIndex ?? null],
  );
  if (!result.rows[0]) {
    throw conflict("Note link already exists");
  }
  return { created: true, id: result.rows[0].id };
}

export async function deleteNoteLink(
  ownerId: string,
  noteId: string,
  linkId: string,
) {
  const result = await query<{ id: string }>(
    "DELETE FROM note_links WHERE owner_id = $1 AND source_note_id = $2 AND id = $3 RETURNING id",
    [ownerId, noteId, linkId],
  );
  if (!result.rows[0]) throw notFound("Note link");
  return { deleted: true };
}

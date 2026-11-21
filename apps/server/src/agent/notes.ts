// Agent-facing note flows for the MCP tools: list, read (page text + rendered page images), search, and additive edits.
import crypto from "node:crypto";
import type { Bounds, CanvasMode, CanvasObject } from "@aurora/shared";
import { conflict, notFound } from "../errors.js";
import { getPool, query, withTransaction } from "../db/pool.js";
import { mapCanvasObject, queryRegionalObjects } from "../canvas/objects.js";
import { objectText, textToDoc } from "../canvas/text.js";
import {
  createNote,
  createPageBelow,
  getNoteWithPages,
  listNotes,
  updateNote,
} from "../library/notes.js";
import type { NoteJson } from "../library/map.js";
import { listFolders } from "../library/folders.js";
import { listProjects } from "../library/projects.js";
import { broadcastToOwner } from "../sync/ws.js";
import {
  findLocation,
  folderPathById,
  resolveLocation,
} from "../practice/location.js";
import { markToObjects, practiceTagOf, type Mark } from "../practice/marks.js";
import { PAGE_HEIGHT, PAGE_WIDTH, boundsIntersect } from "../practice/page.js";
import { renderPagePng } from "../practice/render.js";
import { broadcastObjectChanges, writeObjects } from "../practice/publish.js";
import { listQuestions, loadSessionByNote } from "../practice/store.js";
import {
  canvasTiles,
  pagedNotePages,
  pageWorldFrame,
  toPageBounds,
  type NotePage,
} from "./pages.js";

// Typed text kinds; their payload text is searchable and returned by notes_read.
const TEXT_KINDS = ["rich-text", "sticky-note", "practice-card"];
// Searchable text of one canvas_objects row (alias o): sticky text, card HTML, and every Tiptap text node.
const OBJECT_TEXT_SQL = `concat_ws(' ', o.payload ->> 'text', o.payload ->> 'html',
  jsonb_path_query_array(o.payload -> 'doc', 'lax $.**.text')::text)`;
// Agent-typed text sits above existing content, like practice marks.
const AGENT_Z_INDEX = 100_000;
const TEXT_LINE_HEIGHT = 24;

export type PageImageOptions = { scale: number };

function broadcastLibraryChanged(ownerId: string): void {
  broadcastToOwner(ownerId, {
    type: "library-changed",
    serverTimestamp: new Date().toISOString(),
  });
}

/** Project names and folder paths for the owner, to label notes for the agent. */
async function locationLabels(ownerId: string) {
  const projects = await listProjects(ownerId, true);
  const folderPaths = new Map<string, string>();
  for (const project of projects) {
    const paths = folderPathById(await listFolders(ownerId, project.id));
    for (const [id, path] of paths) folderPaths.set(id, path);
  }
  const projectNames = new Map(projects.map((p) => [p.id, p.name]));
  return (note: {
    projectId: string;
    folderId: string | null;
  }): { project: string; folder: string | null } => ({
    project: projectNames.get(note.projectId) ?? "",
    folder: note.folderId ? (folderPaths.get(note.folderId) ?? null) : null,
  });
}

function noteSummary(
  note: NoteJson,
  label: { project: string; folder: string | null },
) {
  return {
    id: note.id,
    title: note.title,
    ...label,
    kind: note.kind,
    canvasMode: note.canvasMode,
    favorite: note.favorite,
    archived: note.archivedAt !== null,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

export async function listNotesForAgent(
  ownerId: string,
  filters: {
    project?: string | undefined;
    folder?: string | undefined;
    archived: boolean;
    limit: number;
    offset: number;
  },
) {
  const location = filters.project
    ? await findLocation(ownerId, {
        project: filters.project,
        folder: filters.folder,
      })
    : null;
  if (!location && filters.folder) {
    throw conflict("Pass project together with folder");
  }
  const notes = await listNotes(ownerId, {
    projectId: location?.projectId,
    folderId: location?.folderId ?? undefined,
    archived: filters.archived,
    limit: filters.limit,
    offset: filters.offset,
  });
  // Without a folder the project's notes in every folder are listed; with one, only that folder's.
  const label = await locationLabels(ownerId);
  return notes.map((note) => noteSummary(note, label(note)));
}

/** Bounds of every object in the note (no payloads, so large ink notes stay cheap). */
async function contentBoxes(
  ownerId: string,
  noteId: string,
): Promise<Bounds[]> {
  const result = await query<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>(
    "SELECT x, y, width, height FROM canvas_objects WHERE owner_id = $1 AND note_id = $2",
    [ownerId, noteId],
  );
  return result.rows.map((row) => ({
    x: Number(row.x),
    y: Number(row.y),
    width: Number(row.width),
    height: Number(row.height),
  }));
}

/** The note's pages: real pages for paged notes, content tiles for other canvases. */
async function notePages(
  ownerId: string,
  noteId: string,
): Promise<{ note: NoteJson; pages: NotePage[]; boxes: Bounds[] }> {
  const { note, pages } = await getNoteWithPages(ownerId, noteId);
  const boxes = await contentBoxes(ownerId, noteId);
  return {
    note,
    boxes,
    pages:
      note.canvasMode === "paged"
        ? pagedNotePages(pages.length, boxes)
        : canvasTiles(boxes),
  };
}

function pageAt(pages: NotePage[], index: number): NotePage {
  const page = pages[index];
  if (!page) {
    throw notFound(`Page ${index} (the note has ${pages.length} pages)`);
  }
  return page;
}

async function pageObjects(
  ownerId: string,
  noteId: string,
  page: NotePage,
): Promise<CanvasObject[]> {
  const result = await queryRegionalObjects(ownerId, {
    noteId,
    viewport: pageWorldFrame(page),
  });
  return result.objects;
}

async function renderNotePage(
  objects: CanvasObject[],
  page: NotePage,
  options: PageImageOptions,
): Promise<Buffer> {
  return renderPagePng(
    objects,
    { pageIndex: page.index, attempt: 1, frame: pageWorldFrame(page) },
    { scale: options.scale },
  );
}

async function textObjects(
  ownerId: string,
  noteId: string,
): Promise<CanvasObject[]> {
  const result = await query<Parameters<typeof mapCanvasObject>[0]>(
    `SELECT id, owner_id, note_id, page_id, kind, x, y, width, height, rotation,
            z_index, locked, group_id, payload, revision, created_at, updated_at
     FROM canvas_objects
     WHERE owner_id = $1 AND note_id = $2 AND kind = ANY($3)
     ORDER BY y, x`,
    [ownerId, noteId, TEXT_KINDS],
  );
  return result.rows.map(mapCanvasObject);
}

/** Who wrote an object: the user, or the agent's practice/annotation marks. */
function authorOf(object: CanvasObject): "user" | "agent" {
  return practiceTagOf(object) ? "agent" : "user";
}

export async function readNote(
  ownerId: string,
  noteId: string,
  input: { pages?: number[] | undefined; image: PageImageOptions },
) {
  const { note, pages, boxes } = await notePages(ownerId, noteId);
  const label = (await locationLabels(ownerId))(note);
  const texts = await textObjects(ownerId, noteId);
  const session = await loadSessionByNote(getPool(), ownerId, noteId);
  const questions = session ? await listQuestions(getPool(), session.id) : [];

  const pageInfo = pages.map((page) => {
    const frame = pageWorldFrame(page);
    // Each text object is listed on the page that holds its top-left corner.
    const pageTexts = texts.filter((object) =>
      boundsIntersect(
        { x: object.bounds.x, y: object.bounds.y, width: 1, height: 1 },
        frame,
      ),
    );
    return {
      index: page.index,
      origin: page.origin,
      objectCount: boxes.filter((box) => boundsIntersect(box, frame)).length,
      practiceQuestionId:
        questions.find(
          (q) => q.page_index === page.index && note.canvasMode === "paged",
        )?.id ?? null,
      text: pageTexts
        .map((object) => ({
          kind: object.kind,
          author: authorOf(object),
          ...toPageBounds(page, object.bounds),
          text: objectText(object) ?? "",
        }))
        .filter((item) => item.text.length > 0),
    };
  });

  const wanted = input.pages ?? pages.slice(0, 3).map((page) => page.index);
  const images: { pageIndex: number; png: Buffer }[] = [];
  for (const index of wanted) {
    const page = pageAt(pages, index);
    const objects = await pageObjects(ownerId, noteId, page);
    images.push({
      pageIndex: index,
      png: await renderNotePage(objects, page, input.image),
    });
  }

  return {
    meta: {
      note: noteSummary(note, label),
      pageSize: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
      pageCount: pages.length,
      practiceSessionId: session?.id ?? null,
      ...(note.kind === "pdf"
        ? {
            pdfNote:
              "The PDF's own pages are not drawn in the images; only ink and objects placed on the note are.",
          }
        : {}),
      pages: pageInfo,
      images: images.map((image) => ({
        pageIndex: image.pageIndex,
        scale: input.image.scale,
      })),
    },
    images: images.map((image) => image.png),
  };
}

/** Escapes LIKE wildcards so the query matches literally. */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function snippet(text: string, needle: string): string {
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  const start = Math.max(0, at - 60);
  const end = Math.min(text.length, (at < 0 ? 0 : at) + needle.length + 60);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`;
}

/** Case-insensitive substring search over note titles and typed text (not handwriting). */
export async function searchNotes(ownerId: string, q: string, limit: number) {
  const pattern = likePattern(q);
  const notes = await query<Parameters<typeof mapNoteRow>[0]>(
    `SELECT n.id, n.title, n.project_id, n.folder_id, n.kind, n.canvas_mode, n.updated_at,
            (n.title ILIKE $2) AS title_match
     FROM notes n
     WHERE n.owner_id = $1 AND n.trashed_at IS NULL
       AND (n.title ILIKE $2 OR EXISTS (
         SELECT 1 FROM canvas_objects o
         WHERE o.owner_id = n.owner_id AND o.note_id = n.id
           AND o.kind = ANY($3) AND ${OBJECT_TEXT_SQL} ILIKE $2))
     ORDER BY title_match DESC, n.updated_at DESC
     LIMIT $4`,
    [ownerId, pattern, TEXT_KINDS, limit],
  );
  const ids = notes.rows.map((row) => row.id);
  const matches = await query<Parameters<typeof mapCanvasObject>[0]>(
    `SELECT o.id, o.owner_id, o.note_id, o.page_id, o.kind, o.x, o.y, o.width, o.height,
            o.rotation, o.z_index, o.locked, o.group_id, o.payload, o.revision,
            o.created_at, o.updated_at
     FROM canvas_objects o
     WHERE o.owner_id = $1 AND o.note_id = ANY($2) AND o.kind = ANY($3)
       AND ${OBJECT_TEXT_SQL} ILIKE $4
     ORDER BY o.y, o.x`,
    [ownerId, ids, TEXT_KINDS, pattern],
  );
  const objects = matches.rows.map(mapCanvasObject);
  const label = await locationLabels(ownerId);
  return notes.rows.map((row) => {
    const note = mapNoteRow(row);
    return {
      ...note,
      ...label(note),
      titleMatch: row.title_match,
      matches: objects
        .filter((object) => object.noteId === row.id)
        .slice(0, 5)
        .map((object) => ({
          kind: object.kind,
          snippet: snippet(objectText(object) ?? "", q),
        })),
    };
  });
}

function mapNoteRow(row: {
  id: string;
  title: string;
  project_id: string;
  folder_id: string | null;
  kind: string;
  canvas_mode: string;
  updated_at: Date;
  title_match: boolean;
}) {
  return {
    id: row.id,
    title: row.title,
    projectId: row.project_id,
    folderId: row.folder_id,
    kind: row.kind,
    canvasMode: row.canvas_mode,
    updatedAt: row.updated_at.toISOString(),
  };
}

// ---- Additive edits ---------------------------------------------------------

export async function createNoteForAgent(
  ownerId: string,
  input: {
    title: string;
    project: string;
    folder?: string | undefined;
    canvasMode: CanvasMode;
  },
) {
  const location = await resolveLocation(ownerId, input);
  const note = await createNote(ownerId, {
    projectId: location.projectId,
    folderId: location.folderId ?? undefined,
    title: input.title,
    canvasMode: input.canvasMode,
  });
  broadcastLibraryChanged(ownerId);
  return noteSummary(note, (await locationLabels(ownerId))(note));
}

export async function renameNote(
  ownerId: string,
  noteId: string,
  title: string,
) {
  const note = await updateNote(ownerId, noteId, { title });
  broadcastLibraryChanged(ownerId);
  return noteSummary(note, (await locationLabels(ownerId))(note));
}

/** Appends a page at the end of a paged note, as the app's "add page below" on the last page does. */
export async function appendPage(ownerId: string, noteId: string) {
  const { note, pages } = await getNoteWithPages(ownerId, noteId);
  if (note.canvasMode !== "paged") throw conflict("Note is not in page mode");
  const result = await createPageBelow(ownerId, noteId, pages.length - 1);
  broadcastObjectChanges(
    ownerId,
    { noteId, objects: result.shiftedObjects, deletedObjectIds: [] },
    `page-insert:${result.page.id}`,
  );
  broadcastLibraryChanged(ownerId);
  return { pageIndex: result.page.pageIndex, pageCount: result.pageCount };
}

export type TextBlock = {
  x: number;
  y: number;
  width: number;
  height?: number | undefined;
  text: string;
};

function textBlockObject(
  ownerId: string,
  noteId: string,
  page: NotePage,
  block: TextBlock,
): CanvasObject {
  const now = new Date().toISOString();
  const height =
    block.height ?? block.text.split("\n").length * TEXT_LINE_HEIGHT + 16;
  return {
    id: crypto.randomUUID(),
    ownerId,
    noteId,
    pageId: null,
    kind: "rich-text",
    bounds: {
      x: page.origin.x + block.x,
      y: page.origin.y + block.y,
      width: block.width,
      height,
    },
    rotation: 0,
    zIndex: AGENT_Z_INDEX,
    locked: false,
    groupId: null,
    payload: { doc: textToDoc(block.text) },
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Builds red marks/comments (tagged like practice marks, but unlocked so the user can move or
 * delete them) and typed text boxes for one page.
 */
export function annotationObjects(
  ownerId: string,
  noteId: string,
  page: NotePage,
  marks: Mark[],
  texts: TextBlock[],
): CanvasObject[] {
  const ctx = { ownerId, noteId, pageIndex: page.index, origin: page.origin };
  return [
    ...marks
      .flatMap((mark) => markToObjects(ctx, mark, null, 1))
      .map((object) => ({ ...object, locked: false })),
    ...texts.map((block) => textBlockObject(ownerId, noteId, page, block)),
  ];
}

export async function annotatePage(
  ownerId: string,
  input: {
    noteId: string;
    pageIndex: number;
    marks: Mark[];
    texts: TextBlock[];
    dryRun: boolean;
    image: PageImageOptions;
  },
) {
  const { note, pages } = await notePages(ownerId, input.noteId);
  if (note.trashedAt) throw conflict("Note is in the trash");
  const page = pageAt(pages, input.pageIndex);
  const inserts = annotationObjects(
    ownerId,
    note.id,
    page,
    input.marks,
    input.texts,
  );
  if (inserts.length === 0) throw conflict("Nothing to add");
  const existing = await pageObjects(ownerId, note.id, page);
  if (!input.dryRun) {
    const changes = await withTransaction((client) =>
      writeObjects(client, ownerId, note.id, inserts),
    );
    broadcastObjectChanges(ownerId, changes, `agent:${crypto.randomUUID()}`);
  }
  return {
    meta: {
      dryRun: input.dryRun,
      noteId: note.id,
      pageIndex: page.index,
      origin: page.origin,
      objectIds: input.dryRun ? [] : inserts.map((object) => object.id),
    },
    image: await renderNotePage([...existing, ...inserts], page, input.image),
  };
}

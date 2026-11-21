// Agent edits to existing objects: read object details, edit (move/resize/text/style), delete by id, and restyle a whole note.
import crypto from "node:crypto";
import type pg from "pg";
import type { CanvasObject } from "@aurora/shared";
import { conflict, notFound } from "../errors.js";
import { withTransaction } from "../db/pool.js";
import { loadObjectForUpdate } from "../canvas/objects.js";
import { createSnapshot } from "../history/snapshots.js";
import { broadcastObjectChanges, writeObjects } from "../practice/publish.js";
import {
  applicableStyle,
  applyStyle,
  authorOf,
  describeObject,
  editObject,
  type ObjectEdit,
  type ObjectStyle,
} from "./objects.js";
import { pageOf, type NotePage } from "./pages.js";
import { decodeAgentImage, storeAgentImage } from "./images.js";
import { PAGE_WIDTH } from "../practice/page.js";
import {
  noteObjects,
  notePages,
  pageAt,
  pageObjects,
  renderNotePage,
  type PageImageOptions,
} from "./notes.js";

// Page images returned with an edit, at most this many.
const MAX_EDIT_IMAGES = 3;

async function editableNote(ownerId: string, noteId: string) {
  const { note, pages } = await notePages(ownerId, noteId);
  if (note.trashedAt) throw conflict("Note is in the trash");
  return { note, pages };
}

/** Locks the note's objects with these ids; every id must exist in the note. */
async function lockObjects(
  client: pg.PoolClient,
  ownerId: string,
  noteId: string,
  ids: string[],
): Promise<CanvasObject[]> {
  const objects: CanvasObject[] = [];
  const missing: string[] = [];
  for (const id of new Set(ids)) {
    const object = await loadObjectForUpdate(client, ownerId, id);
    if (object?.noteId === noteId) objects.push(object);
    else missing.push(id);
  }
  if (missing.length > 0) {
    throw notFound(`Objects not in this note: ${missing.join(", ")}`);
  }
  return objects;
}

/** Saves changed objects in one transaction (unless dryRun) and tells the user's devices. */
async function commit(
  ownerId: string,
  noteId: string,
  ids: string[],
  dryRun: boolean,
  change: (objects: CanvasObject[]) => CanvasObject[],
): Promise<{ before: CanvasObject[]; after: CanvasObject[] }> {
  const result = await withTransaction(async (client) => {
    const before = await lockObjects(client, ownerId, noteId, ids);
    const after = change(before);
    if (!dryRun) await writeObjects(client, ownerId, noteId, after);
    return { before, after };
  });
  if (!dryRun) {
    broadcastObjectChanges(
      ownerId,
      { noteId, objects: result.after, deletedObjectIds: [] },
      `agent:${crypto.randomUUID()}`,
    );
  }
  return result;
}

async function pageImages(
  ownerId: string,
  noteId: string,
  pages: NotePage[],
  image: PageImageOptions,
): Promise<Buffer[]> {
  const images: Buffer[] = [];
  for (const page of pages.slice(0, MAX_EDIT_IMAGES)) {
    const objects = await pageObjects(ownerId, noteId, page);
    images.push(await renderNotePage(ownerId, objects, page, image));
  }
  return images;
}

/** Full details of chosen objects: by id, or everything on a page (handwriting included). */
export async function getObjects(
  ownerId: string,
  input: {
    noteId: string;
    ids?: string[] | undefined;
    pageIndex?: number | undefined;
  },
) {
  if (!input.ids && input.pageIndex === undefined) {
    throw conflict("Pass ids or pageIndex");
  }
  const { pages } = await notePages(ownerId, input.noteId);
  const page =
    input.pageIndex === undefined ? null : pageAt(pages, input.pageIndex);
  const objects = await noteObjects(ownerId, input.noteId, {
    includeInk: true,
    ...(input.ids ? { ids: input.ids } : {}),
  });
  return objects
    .map((object) => ({ object, page: pageOf(pages, object.bounds) }))
    .filter((item) => page === null || item.page === page)
    .map((item) => describeObject(item.object, item.page));
}

/** Decodes every replacement picture (so bad data fails before anything is saved) and stores it unless dryRun. */
async function storeEditImages(
  ownerId: string,
  input: { edits: ObjectEdit[]; dryRun: boolean; image: PageImageOptions },
): Promise<Map<string, string>> {
  const fileIds = new Map<string, string>();
  for (const edit of input.edits) {
    if (edit.image === undefined) continue;
    const decoded = decodeAgentImage(edit.image, edit.width ?? PAGE_WIDTH);
    if (input.dryRun) continue;
    fileIds.set(
      edit.id,
      await storeAgentImage(ownerId, input.image.uploadDir, decoded),
    );
  }
  return fileIds;
}

export async function editObjects(
  ownerId: string,
  input: {
    noteId: string;
    edits: ObjectEdit[];
    dryRun: boolean;
    image: PageImageOptions;
  },
) {
  const { note, pages } = await editableNote(ownerId, input.noteId);
  const byId = new Map(input.edits.map((edit) => [edit.id, edit]));
  if (byId.size !== input.edits.length) {
    throw conflict("Each object can be edited once per call");
  }
  const imageFileIds = await storeEditImages(ownerId, input);
  const { after } = await commit(
    ownerId,
    note.id,
    [...byId.keys()],
    input.dryRun,
    (objects) =>
      objects.map((object) => {
        const edit = byId.get(object.id)!;
        const page = pageOf(pages, object.bounds);
        const target =
          edit.pageIndex === undefined ? page : pageAt(pages, edit.pageIndex);
        return editObject(
          object,
          page,
          target,
          edit,
          imageFileIds.get(edit.id),
        );
      }),
  );
  const touched = [
    ...new Set(after.map((object) => pageOf(pages, object.bounds))),
  ];
  return {
    meta: {
      dryRun: input.dryRun,
      noteId: note.id,
      objects: after.map((object) =>
        describeObject(object, pageOf(pages, object.bounds)),
      ),
      images: touched
        .slice(0, MAX_EDIT_IMAGES)
        .map((page) => ({ pageIndex: page.index })),
    },
    // Dry runs show the saved page; the meta shows where the edits would go.
    images: await pageImages(ownerId, note.id, touched, input.image),
  };
}

/**
 * Deletes objects by explicit id only. Before deleting it saves a snapshot of the note (the app's
 * restore point), so the deletion can be undone by restoring it.
 */
export async function deleteObjects(
  ownerId: string,
  input: { noteId: string; ids: string[]; dryRun: boolean },
) {
  const { note, pages } = await editableNote(ownerId, input.noteId);
  const found = await noteObjects(ownerId, note.id, {
    includeInk: true,
    ids: input.ids,
  });
  const missing = input.ids.filter((id) => !found.some((o) => o.id === id));
  if (missing.length > 0) {
    throw notFound(`Objects not in this note: ${missing.join(", ")}`);
  }
  const listed = found.map((object) =>
    describeObject(object, pageOf(pages, object.bounds)),
  );
  if (input.dryRun) return { dryRun: true, deleted: listed, snapshotId: null };

  const snapshot = await createSnapshot(
    ownerId,
    note.id,
    `Before agent deleted ${found.length} object${found.length === 1 ? "" : "s"}`,
  );
  const changes = await withTransaction((client) =>
    writeObjects(client, ownerId, note.id, [], input.ids),
  );
  broadcastObjectChanges(ownerId, changes, `agent:${crypto.randomUUID()}`);
  return {
    dryRun: false,
    deleted: listed.filter((item) =>
      changes.deletedObjectIds.includes(item.id),
    ),
    snapshotId: snapshot.id,
  };
}

export type RestyleTarget = "text" | "marks";

/** Whether a note-wide restyle touches this object. User handwriting and shapes never match. */
function restyleMatches(
  object: CanvasObject,
  targets: RestyleTarget[],
  author: "agent" | "any",
): boolean {
  const agent = authorOf(object) === "agent";
  const isText =
    object.kind === "rich-text" ||
    (object.kind === "practice-card" && object.payload.variant === "label");
  if (isText) return targets.includes("text") && (agent || author === "any");
  const isMark = ["stroke", "line", "arrow", "rectangle", "ellipse"].includes(
    object.kind,
  );
  return targets.includes("marks") && isMark && agent;
}

/** Applies one style to every matching object in a note (only the fields each object can take). */
export async function restyleNote(
  ownerId: string,
  input: {
    noteId: string;
    style: ObjectStyle;
    targets: RestyleTarget[];
    author: "agent" | "any";
    dryRun: boolean;
  },
) {
  const { note } = await editableNote(ownerId, input.noteId);
  const matches = (
    await noteObjects(ownerId, note.id, { includeInk: false })
  ).filter(
    (object) =>
      restyleMatches(object, input.targets, input.author) &&
      Object.keys(applicableStyle(object, input.style)).length > 0,
  );
  const ids = matches.map((object) => object.id);
  if (ids.length > 0 && !input.dryRun && input.author === "any") {
    // The user's own text formatting changes, so keep a restore point.
    await createSnapshot(ownerId, note.id, "Before agent restyled the note");
  }
  const { after } = await commit(
    ownerId,
    note.id,
    ids,
    input.dryRun,
    (objects) =>
      objects.map((object) =>
        applyStyle(object, applicableStyle(object, input.style)),
      ),
  );
  return { dryRun: input.dryRun, noteId: note.id, changed: after.length, ids };
}

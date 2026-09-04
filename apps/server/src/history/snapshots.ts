// 30-day note snapshots: create from live state, list, and restore as fresh authoritative revisions.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CanvasObject } from "@aurora/shared";
import type { AuroraEnv } from "../env.js";
import { invalid, notFound } from "../errors.js";
import { query, withTransaction } from "../db/pool.js";
import { requireSessionPreHandler } from "../auth/sessions.js";
import { broadcastToOwner } from "../sync/ws.js";
import {
  mapCanvasObject,
  touchNote,
  upsertObject,
  type CanvasObjectRow,
} from "../canvas/objects.js";
import {
  mapNote,
  mergeBackground,
  type NoteJson,
  type NoteRow,
  type PageJson,
  type PageRow,
} from "../library/map.js";
import { ensureNote } from "../library/notes.js";

// Snapshot summary; server-local until promoted into @aurora/shared contracts.
export type SnapshotSummary = {
  id: string;
  ownerId: string;
  noteId: string;
  label: string;
  objectCount: number;
  createdAt: string;
};

export type SnapshotPayload = {
  note: NoteJson;
  pages: PageJson[];
  objects: CanvasObject[];
};

/** Returns a revision newer than both the deleted/cached object and note watermark. */
export function nextRestoredObjectRevision(
  previousRevision: number | undefined,
  noteRevision: number,
): number {
  return Math.max(previousRevision ?? -1, noteRevision) + 1;
}

type SnapshotRow = {
  id: string;
  owner_id: string;
  note_id: string;
  label: string;
  object_count: number;
  payload: SnapshotPayload;
  created_at: Date;
};

export function mapSnapshot(
  row: Omit<SnapshotRow, "payload">,
): SnapshotSummary {
  return {
    id: row.id,
    ownerId: row.owner_id,
    noteId: row.note_id,
    label: row.label,
    objectCount: Number(row.object_count),
    createdAt: row.created_at.toISOString(),
  };
}

const SNAPSHOT_SELECT = `
  SELECT id, owner_id, note_id, label, object_count, payload, created_at
  FROM snapshots
`;

export async function createSnapshot(
  ownerId: string,
  noteId: string,
  label: string,
): Promise<SnapshotSummary> {
  await ensureNote(ownerId, noteId);
  return withTransaction(async (client) => {
    const note = await client.query<NoteRow>(
      `SELECT id, owner_id, project_id, folder_id, title, kind, canvas_mode, background,
              favorite, archived_at, trashed_at, revision, pdf_file_id, created_at, updated_at
       FROM notes WHERE owner_id = $1 AND id = $2 FOR UPDATE`,
      [ownerId, noteId],
    );
    const noteRow = note.rows[0]!;
    const pages = await client.query<PageRow>(
      `SELECT id, owner_id, note_id, page_index, width, height, background, created_at, updated_at
       FROM pages WHERE owner_id = $1 AND note_id = $2 ORDER BY page_index`,
      [ownerId, noteId],
    );
    const objects = await client.query<CanvasObjectRow>(
      `SELECT id, owner_id, note_id, page_id, kind, x, y, width, height, rotation,
              z_index, locked, group_id, payload, revision, created_at, updated_at
       FROM canvas_objects WHERE owner_id = $1 AND note_id = $2 ORDER BY z_index`,
      [ownerId, noteId],
    );
    const payload: SnapshotPayload = {
      note: mapNote(noteRow),
      pages: pages.rows.map((row) => ({
        id: row.id,
        ownerId: row.owner_id,
        noteId: row.note_id,
        pageIndex: Number(row.page_index),
        width: Number(row.width),
        height: Number(row.height),
        background: mergeBackground(row.background),
      })),
      objects: objects.rows.map(mapCanvasObject),
    };
    const inserted = await client.query<SnapshotRow>(
      `INSERT INTO snapshots (owner_id, note_id, label, object_count, payload)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, owner_id, note_id, label, object_count, payload, created_at`,
      [ownerId, noteId, label, payload.objects.length, JSON.stringify(payload)],
    );
    const row = inserted.rows[0]!;
    await touchNote(client, ownerId, noteId);
    return mapSnapshot(row);
  });
}

export async function listSnapshots(
  ownerId: string,
  noteId: string,
): Promise<SnapshotSummary[]> {
  await ensureNote(ownerId, noteId);
  const result = await query<Omit<SnapshotRow, "payload">>(
    `${SNAPSHOT_SELECT} WHERE owner_id = $1 AND note_id = $2 ORDER BY created_at DESC LIMIT 100`,
    [ownerId, noteId],
  );
  return result.rows.map(mapSnapshot);
}

export async function getSnapshot(
  ownerId: string,
  snapshotId: string,
): Promise<SnapshotRow> {
  const result = await query<SnapshotRow>(
    `${SNAPSHOT_SELECT} WHERE owner_id = $1 AND id = $2`,
    [ownerId, snapshotId],
  );
  const row = result.rows[0];
  if (!row) throw notFound("Snapshot");
  return row;
}

// Restore every entity captured by the snapshot in one transaction. Canvas objects
// receive fresh monotonic revisions, while note metadata and pages return to the
// captured values. Any FK failure rolls the entire restore back.
export async function restoreSnapshot(
  ownerId: string,
  snapshotId: string,
): Promise<{ note: NoteJson; pages: PageJson[]; objects: CanvasObject[] }> {
  const snapshot = await getSnapshot(ownerId, snapshotId);
  const payload = snapshot.payload;
  const restored = await withTransaction(async (client) => {
    const lockedNote = await client.query<{
      id: string;
      pdf_file_id: string | null;
      revision: number;
    }>(
      "SELECT id, pdf_file_id, revision FROM notes WHERE owner_id = $1 AND id = $2 FOR UPDATE",
      [ownerId, snapshot.note_id],
    );
    if (!lockedNote.rows[0]) throw notFound("Note");
    if (
      payload.note.id !== snapshot.note_id ||
      payload.note.ownerId !== ownerId ||
      payload.pages.some(
        (page) => page.ownerId !== ownerId || page.noteId !== snapshot.note_id,
      ) ||
      payload.objects.some(
        (object) =>
          object.ownerId !== ownerId || object.noteId !== snapshot.note_id,
      )
    ) {
      throw invalid("Snapshot payload ownership does not match its note");
    }

    const liveObjects = await client.query<{ id: string; revision: number }>(
      `SELECT id, revision FROM canvas_objects
       WHERE owner_id = $1 AND note_id = $2 FOR UPDATE`,
      [ownerId, snapshot.note_id],
    );
    const previousRevisions = new Map(
      liveObjects.rows.map((row) => [row.id, Number(row.revision)]),
    );
    const snapshotIds = new Set(payload.objects.map((object) => object.id));
    const deletedObjectIds = liveObjects.rows
      .filter((row) => !snapshotIds.has(row.id))
      .map((row) => row.id);

    // Replacing children avoids page-index uniqueness conflicts when pages were
    // reordered after the snapshot. It is safe because this transaction owns the note.
    await client.query(
      "DELETE FROM canvas_objects WHERE owner_id = $1 AND note_id = $2",
      [ownerId, snapshot.note_id],
    );
    await client.query(
      "DELETE FROM pages WHERE owner_id = $1 AND note_id = $2",
      [ownerId, snapshot.note_id],
    );

    const pages: PageJson[] = [];
    for (const page of payload.pages) {
      const inserted = await client.query<PageRow>(
        `INSERT INTO pages
           (id, owner_id, note_id, page_index, width, height, background)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, owner_id, note_id, page_index, width, height, background,
                   created_at, updated_at`,
        [
          page.id,
          ownerId,
          snapshot.note_id,
          page.pageIndex,
          page.width,
          page.height,
          JSON.stringify(page.background),
        ],
      );
      const row = inserted.rows[0]!;
      pages.push({
        id: row.id,
        ownerId: row.owner_id,
        noteId: row.note_id,
        pageIndex: Number(row.page_index),
        width: Number(row.width),
        height: Number(row.height),
        background: mergeBackground(row.background),
      });
    }

    const pageIds = new Set(payload.pages.map((page) => page.id));
    const objects: CanvasObject[] = [];
    for (const object of payload.objects) {
      if (object.pageId && !pageIds.has(object.pageId)) {
        throw invalid("Snapshot object refers to a page outside the snapshot");
      }
      objects.push(
        await upsertObject(
          client,
          ownerId,
          object,
          nextRestoredObjectRevision(
            previousRevisions.get(object.id),
            Number(lockedNote.rows[0].revision),
          ),
        ),
      );
    }

    const note = await client.query<NoteRow>(
      `UPDATE notes SET
         project_id = $3, folder_id = $4, title = $5, kind = $6,
         canvas_mode = $7, background = $8, favorite = $9,
         archived_at = $10, trashed_at = $11, pdf_file_id = $12,
         revision = revision + 1, updated_at = now()
       WHERE owner_id = $1 AND id = $2
       RETURNING id, owner_id, project_id, folder_id, title, kind, canvas_mode,
                 background, favorite, archived_at, trashed_at, revision,
                 pdf_file_id, created_at, updated_at`,
      [
        ownerId,
        snapshot.note_id,
        payload.note.projectId,
        payload.note.folderId,
        payload.note.title,
        payload.note.kind,
        payload.note.canvasMode,
        JSON.stringify(payload.note.background),
        payload.note.favorite,
        payload.note.archivedAt,
        payload.note.trashedAt,
        // Snapshots written before schema version 2 did not capture this field;
        // preserve the live PDF attachment rather than silently clearing it.
        Object.hasOwn(payload.note, "pdfFileId")
          ? payload.note.pdfFileId
          : lockedNote.rows[0].pdf_file_id,
      ],
    );
    return { note: mapNote(note.rows[0]!), pages, objects, deletedObjectIds };
  });

  broadcastToOwner(ownerId, {
    type: "objects-changed",
    noteId: snapshot.note_id,
    objects: restored.objects,
    deletedObjectIds: restored.deletedObjectIds,
    originOperationId: snapshotId,
    serverTimestamp: new Date().toISOString(),
  });
  return {
    note: restored.note,
    pages: restored.pages,
    objects: restored.objects,
  };
}

const createSnapshotBodySchema = z.object({
  label: z.string().max(120).default(""),
});
const idParamSchema = z.object({ id: z.string().uuid() });
const snapshotIdParamSchema = z.object({ snapshotId: z.string().uuid() });

export function registerSnapshotRoutes(
  app: FastifyInstance,
  env: AuroraEnv,
): void {
  const preHandler = requireSessionPreHandler(env);

  app.post("/api/notes/:id/snapshots", { preHandler }, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    const { label } = createSnapshotBodySchema.parse(request.body);
    return { snapshot: await createSnapshot(request.ownerId!, id, label) };
  });

  app.get("/api/notes/:id/snapshots", { preHandler }, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return { snapshots: await listSnapshots(request.ownerId!, id) };
  });

  app.get("/api/snapshots/:snapshotId", { preHandler }, async (request) => {
    const { snapshotId } = snapshotIdParamSchema.parse(request.params);
    const snapshot = await getSnapshot(request.ownerId!, snapshotId);
    return {
      snapshot: mapSnapshot(snapshot),
      payload: snapshot.payload,
    };
  });

  app.post(
    "/api/snapshots/:snapshotId/restore",
    { preHandler },
    async (request) => {
      const { snapshotId } = snapshotIdParamSchema.parse(request.params);
      return restoreSnapshot(request.ownerId!, snapshotId);
    },
  );

  // Current note revision watermark used by clients to decide hydration.
  app.get(
    "/api/notes/:noteId/objects/revision",
    { preHandler },
    async (request) => {
      const { noteId } = z
        .object({ noteId: z.string().uuid() })
        .parse(request.params);
      const result = await query<{ revision: number }>(
        "SELECT revision FROM notes WHERE owner_id = $1 AND id = $2",
        [request.ownerId!, noteId],
      );
      if (!result.rows[0]) throw notFound("Note");
      return {
        noteId,
        revision: Number(result.rows[0].revision),
        serverTimestamp: new Date().toISOString(),
      };
    },
  );
}

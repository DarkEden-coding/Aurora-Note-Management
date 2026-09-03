// 30-day note snapshots: create from live state, list, and restore as fresh authoritative revisions.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CanvasObject } from "@aurora/shared";
import type { AuroraEnv } from "../env.js";
import { notFound } from "../errors.js";
import { query, withTransaction } from "../db/pool.js";
import { requireSessionPreHandler } from "../auth/sessions.js";
import { broadcastToOwner } from "../sync/ws.js";
import {
  loadObjectForUpdate,
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
              favorite, archived_at, trashed_at, revision, created_at, updated_at
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

// Restore strategy: snapshot objects become current truth with fresh monotonic revisions; objects
// added since the snapshot are removed so the note matches the recorded state exactly.
export async function restoreSnapshot(
  ownerId: string,
  snapshotId: string,
): Promise<{ note: NoteJson; objects: CanvasObject[] }> {
  const snapshot = await getSnapshot(ownerId, snapshotId);
  const payload = snapshot.payload;
  const restored = await withTransaction(async (client) => {
    await client.query(
      "SELECT id FROM notes WHERE owner_id = $1 AND id = $2 FOR UPDATE",
      [ownerId, snapshot.note_id],
    );
    const live = await client.query<{ id: string }>(
      "SELECT id FROM canvas_objects WHERE owner_id = $1 AND note_id = $2",
      [ownerId, snapshot.note_id],
    );
    const snapshotIds = new Set(payload.objects.map((object) => object.id));
    const objects: CanvasObject[] = [];
    for (const object of payload.objects) {
      const current = await loadObjectForUpdate(client, ownerId, object.id);
      objects.push(
        await upsertObject(
          client,
          ownerId,
          object,
          current ? current.revision + 1 : 0,
        ),
      );
    }
    const deletedObjectIds = live.rows
      .filter((row) => !snapshotIds.has(row.id))
      .map((row) => row.id);
    if (deletedObjectIds.length > 0) {
      await client.query(
        "DELETE FROM canvas_objects WHERE owner_id = $1 AND id = ANY($2::uuid[])",
        [ownerId, deletedObjectIds],
      );
    }
    await touchNote(client, ownerId, snapshot.note_id);
    const note = await client.query<NoteRow>(
      `SELECT id, owner_id, project_id, folder_id, title, kind, canvas_mode, background,
              favorite, archived_at, trashed_at, revision, created_at, updated_at
       FROM notes WHERE owner_id = $1 AND id = $2`,
      [ownerId, snapshot.note_id],
    );
    return { note: mapNote(note.rows[0]!), objects, deletedObjectIds };
  });

  broadcastToOwner(ownerId, {
    type: "objects-changed",
    noteId: snapshot.note_id,
    objects: restored.objects,
    deletedObjectIds: restored.deletedObjectIds,
    originOperationId: snapshotId,
    serverTimestamp: new Date().toISOString(),
  });
  return { note: restored.note, objects: restored.objects };
}

// Snapshots follow the same 30-day retention window as other history.
export async function pruneExpiredSnapshots(
  retentionDays: number,
): Promise<number> {
  const result = await query<{ id: string }>(
    `DELETE FROM snapshots WHERE created_at < now() - ($1 || ' days')::interval RETURNING id`,
    [String(retentionDays)],
  );
  return result.rows.length;
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

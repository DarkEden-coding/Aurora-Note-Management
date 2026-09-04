// Provides owner-scoped regional canvas reads and authoritative object mutations.
// Database rows store flat bounds columns; the wire contract (@aurora/shared) carries
// a `bounds` object, so every mapping goes through this module.
import pg from "pg";
import type { CanvasObject, RegionalObjectQuery } from "@aurora/shared";
import { forbidden, invalid } from "../errors.js";
import { query } from "../db/pool.js";

// Regional read response; server-local until promoted into @aurora/shared contracts.
export type RegionalObjectQueryResult = {
  objects: CanvasObject[];
  truncated: boolean;
  serverTimestamp: string;
};

export type CanvasObjectRow = {
  id: string;
  owner_id: string;
  note_id: string;
  page_id: string | null;
  kind: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  z_index: number;
  locked: boolean;
  group_id: string | null;
  payload: unknown;
  revision: number;
  created_at: Date;
  updated_at: Date;
};

export function mapCanvasObject(row: CanvasObjectRow): CanvasObject {
  return {
    id: row.id,
    ownerId: row.owner_id,
    noteId: row.note_id,
    pageId: row.page_id,
    kind: row.kind as CanvasObject["kind"],
    bounds: {
      x: Number(row.x),
      y: Number(row.y),
      width: Number(row.width),
      height: Number(row.height),
    },
    rotation: Number(row.rotation),
    zIndex: Number(row.z_index),
    locked: row.locked,
    groupId: row.group_id,
    payload: (row.payload ?? {}) as CanvasObject["payload"],
    revision: Number(row.revision),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const CANVAS_OBJECT_SELECT = `
  SELECT id, owner_id, note_id, page_id, kind, x, y, width, height, rotation,
         z_index, locked, group_id, payload, revision, created_at, updated_at
  FROM canvas_objects
`;

// Regional reads are bounds-overlap limited and hard-capped to protect the owner scope.
const REGIONAL_READ_LIMIT = 2000;

export async function queryRegionalObjects(
  ownerId: string,
  q: RegionalObjectQuery,
): Promise<RegionalObjectQueryResult> {
  const conditions = [
    "owner_id = $1",
    "note_id = $2",
    // Bounds overlap: object region intersects the requested viewport region.
    "x < $3::double precision + $5::double precision",
    "x + width > $3::double precision",
    "y < $4::double precision + $6::double precision",
    "y + height > $4::double precision",
  ];
  const params: unknown[] = [
    ownerId,
    q.noteId,
    q.viewport.x,
    q.viewport.y,
    q.viewport.width,
    q.viewport.height,
  ];
  if (q.pageId !== undefined && q.pageId !== null) {
    params.push(q.pageId);
    conditions.push(`page_id = $${params.length}`);
  }
  if (q.sinceRevision !== undefined) {
    params.push(q.sinceRevision);
    conditions.push(`revision > $${params.length}`);
  }
  const result = await query<CanvasObjectRow>(
    `${CANVAS_OBJECT_SELECT} WHERE ${conditions.join(" AND ")} ORDER BY z_index, id LIMIT ${REGIONAL_READ_LIMIT}`,
    params,
  );
  const rows = result.rows.map(mapCanvasObject);
  return {
    objects: rows,
    truncated: rows.length >= REGIONAL_READ_LIMIT,
    serverTimestamp: new Date().toISOString(),
  };
}

export async function loadObjectForUpdate(
  client: pg.PoolClient,
  ownerId: string,
  objectId: string,
): Promise<CanvasObject | null> {
  const result = await client.query<CanvasObjectRow>(
    `${CANVAS_OBJECT_SELECT} WHERE owner_id = $1 AND id = $2 FOR UPDATE`,
    [ownerId, objectId],
  );
  const row = result.rows[0];
  return row ? mapCanvasObject(row) : null;
}

const UUID_PATTERN =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";
const FILE_URL_PATTERN = new RegExp(`/api/files/(${UUID_PATTERN})(?:[?#]|$)`);
const UUID_EXACT_PATTERN = new RegExp(`^${UUID_PATTERN}$`);

export function localFileIdFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as { fileId?: unknown; src?: unknown };
  if (
    typeof value.fileId === "string" &&
    UUID_EXACT_PATTERN.test(value.fileId)
  ) {
    return value.fileId;
  }
  if (typeof value.src !== "string") return null;
  return FILE_URL_PATTERN.exec(value.src)?.[1] ?? null;
}

// Authoritative single-object upsert: the server assigns the revision (monotonic) and
// timestamps; incoming objects arrive in the shared wire shape with a `bounds` object.
export async function upsertObject(
  client: pg.PoolClient,
  ownerId: string,
  incoming: CanvasObject,
  revision: number,
): Promise<CanvasObject> {
  const localFileId = localFileIdFromPayload(incoming.payload);
  if (localFileId) {
    const file = await client.query<{ sha256: string }>(
      "SELECT sha256 FROM files WHERE owner_id = $1 AND id = $2",
      [ownerId, localFileId],
    );
    const digest = file.rows[0]?.sha256;
    if (!digest) throw invalid("Canvas object refers to a missing upload");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 1096110671))",
      [digest],
    );
    const stillPresent = await client.query<{ id: string }>(
      "SELECT id FROM files WHERE owner_id = $1 AND id = $2",
      [ownerId, localFileId],
    );
    if (!stillPresent.rows[0]) {
      throw invalid("Canvas object refers to a missing upload");
    }
  }

  const result = await client.query<CanvasObjectRow>(
    `INSERT INTO canvas_objects
       (id, owner_id, note_id, page_id, kind, x, y, width, height, rotation, z_index, locked, group_id, payload, revision, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now(), now())
     ON CONFLICT (id) DO UPDATE SET
       note_id = EXCLUDED.note_id,
       page_id = EXCLUDED.page_id,
       kind = EXCLUDED.kind,
       x = EXCLUDED.x,
       y = EXCLUDED.y,
       width = EXCLUDED.width,
       height = EXCLUDED.height,
       rotation = EXCLUDED.rotation,
       z_index = EXCLUDED.z_index,
       locked = EXCLUDED.locked,
       group_id = EXCLUDED.group_id,
       payload = EXCLUDED.payload,
       revision = EXCLUDED.revision,
       updated_at = now()
     -- UUIDs are global. A collision must never turn an owner-scoped insert into
     -- an update of another owner's row.
     WHERE canvas_objects.owner_id = EXCLUDED.owner_id
     RETURNING id, owner_id, note_id, page_id, kind, x, y, width, height, rotation,
               z_index, locked, group_id, payload, revision, created_at, updated_at`,
    [
      incoming.id,
      ownerId,
      incoming.noteId,
      incoming.pageId,
      incoming.kind,
      incoming.bounds.x,
      incoming.bounds.y,
      incoming.bounds.width,
      incoming.bounds.height,
      incoming.rotation,
      incoming.zIndex,
      incoming.locked,
      incoming.groupId,
      JSON.stringify(incoming.payload),
      revision,
    ],
  );
  const row = result.rows[0];
  if (!row) throw forbidden("Canvas object");
  return mapCanvasObject(row);
}

export async function deleteObject(
  client: pg.PoolClient,
  ownerId: string,
  objectId: string,
): Promise<boolean> {
  const result = await client.query<{ id: string }>(
    "DELETE FROM canvas_objects WHERE owner_id = $1 AND id = $2 RETURNING id",
    [ownerId, objectId],
  );
  return result.rows.length > 0;
}

export async function touchNote(
  client: pg.PoolClient,
  ownerId: string,
  noteId: string,
): Promise<void> {
  await client.query(
    "UPDATE notes SET updated_at = now(), revision = revision + 1 WHERE owner_id = $1 AND id = $2",
    [ownerId, noteId],
  );
}

// Ownership guard used by canvas read routes; a note outside the owner scope is forbidden.
export async function ensureNoteReadable(
  ownerId: string,
  noteId: string,
): Promise<void> {
  const result = await query<{ owner_id: string }>(
    "SELECT owner_id FROM notes WHERE owner_id = $1 AND id = $2",
    [ownerId, noteId],
  );
  if (!result.rows[0]) throw forbidden("Note");
}

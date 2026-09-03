// Builds newline-delimited JSON backups of the owner's entire Aurora dataset.
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { AuroraEnv } from "../env.js";
import { query } from "../db/pool.js";
import { requireSessionPreHandler } from "../auth/sessions.js";
import { mapCanvasObject, type CanvasObjectRow } from "../canvas/objects.js";
import {
  mapNote,
  mapPage,
  type NoteRow,
  type PageRow,
} from "../library/map.js";
import { mapFile, type FileRow } from "../files/store.js";

export const BACKUP_SCHEMA_VERSION = 1;

export type BackupManifest = {
  type: "manifest";
  schemaVersion: number;
  ownerId: string;
  exportedAt: string;
};

export type BackupEnd = {
  type: "end";
  counts: {
    projects: number;
    folders: number;
    notes: number;
    pages: number;
    objects: number;
    files: number;
  };
  exportedAt: string;
};

export type BackupLine =
  | BackupManifest
  | { type: "project"; data: unknown }
  | { type: "folder"; data: unknown }
  | { type: "note"; data: unknown }
  | { type: "page"; data: unknown }
  | { type: "object"; data: unknown }
  | { type: "file"; data: unknown }
  | BackupEnd;

// Streams manifest first, then every entity as NDJSON, then an end line with counts.
export async function* buildBackup(ownerId: string): AsyncGenerator<string> {
  const manifest: BackupManifest = {
    type: "manifest",
    schemaVersion: BACKUP_SCHEMA_VERSION,
    ownerId,
    exportedAt: new Date().toISOString(),
  };
  yield `${JSON.stringify(manifest)}\n`;

  const projects = await query<{
    id: string;
    owner_id: string;
    name: string;
    color: string;
    sort_order: number;
    is_favorite: boolean;
    archived_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, owner_id, name, color, sort_order, is_favorite, archived_at, created_at, updated_at
     FROM projects WHERE owner_id = $1 ORDER BY created_at`,
    [ownerId],
  );
  const counts = {
    projects: 0,
    folders: 0,
    notes: 0,
    pages: 0,
    objects: 0,
    files: 0,
  };
  for (const row of projects.rows) {
    counts.projects += 1;
    yield `${JSON.stringify({
      type: "project",
      data: {
        id: row.id,
        ownerId: row.owner_id,
        name: row.name,
        color: row.color,
        sortOrder: Number(row.sort_order),
        isFavorite: row.is_favorite,
        archivedAt: row.archived_at ? row.archived_at.toISOString() : null,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      },
    })}\n`;
  }

  const folders = await query<{
    id: string;
    owner_id: string;
    project_id: string;
    parent_id: string | null;
    name: string;
    sort_order: number;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, owner_id, project_id, parent_id, name, sort_order, created_at, updated_at
     FROM folders WHERE owner_id = $1 ORDER BY created_at`,
    [ownerId],
  );
  for (const row of folders.rows) {
    counts.folders += 1;
    yield `${JSON.stringify({
      type: "folder",
      data: {
        id: row.id,
        ownerId: row.owner_id,
        projectId: row.project_id,
        parentId: row.parent_id,
        name: row.name,
        sortOrder: Number(row.sort_order),
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      },
    })}\n`;
  }

  const notes = await query<NoteRow>(
    `SELECT id, owner_id, project_id, folder_id, title, kind, canvas_mode, background,
            favorite, archived_at, trashed_at, revision, created_at, updated_at
     FROM notes WHERE owner_id = $1 ORDER BY created_at`,
    [ownerId],
  );
  for (const row of notes.rows) {
    counts.notes += 1;
    const note = mapNote(row);
    yield `${JSON.stringify({ type: "note", data: note })}\n`;
  }

  const pages = await query<PageRow>(
    `SELECT id, owner_id, note_id, page_index, width, height, background, created_at, updated_at
     FROM pages WHERE owner_id = $1 ORDER BY note_id, page_index`,
    [ownerId],
  );
  for (const row of pages.rows) {
    counts.pages += 1;
    yield `${JSON.stringify({ type: "page", data: mapPage(row) })}\n`;
  }

  const objects = await query<CanvasObjectRow>(
    `SELECT id, owner_id, note_id, page_id, kind, x, y, width, height, rotation,
            z_index, locked, group_id, payload, revision, created_at, updated_at
     FROM canvas_objects WHERE owner_id = $1 ORDER BY note_id, z_index`,
    [ownerId],
  );
  for (const row of objects.rows) {
    counts.objects += 1;
    // Canvas objects serialize in the shared wire shape (bounds object), matching sync traffic.
    yield `${JSON.stringify({ type: "object", data: mapCanvasObject(row) })}\n`;
  }

  const files = await query<FileRow>(
    `SELECT id, owner_id, sha256, size, mime_type, original_name, created_at
     FROM files WHERE owner_id = $1 ORDER BY created_at`,
    [ownerId],
  );
  for (const row of files.rows) {
    counts.files += 1;
    yield `${JSON.stringify({ type: "file", data: mapFile(row) })}\n`;
  }

  const end: BackupEnd = {
    type: "end",
    counts,
    exportedAt: new Date().toISOString(),
  };
  yield `${JSON.stringify(end)}\n`;
}

export function backupStream(ownerId: string): Readable {
  return Readable.from(buildBackup(ownerId));
}

export function registerBackupRoutes(
  app: FastifyInstance,
  env: AuroraEnv,
): void {
  const preHandler = requireSessionPreHandler(env);

  app.get("/api/backup", { preHandler }, async (request, reply) => {
    const stream = backupStream(request.ownerId!);
    return reply
      .status(200)
      .header("content-type", "application/x-ndjson")
      .header(
        "content-disposition",
        `attachment; filename="aurora-backup-${new Date().toISOString().slice(0, 10)}.ndjson"`,
      )
      .send(stream);
  });
}

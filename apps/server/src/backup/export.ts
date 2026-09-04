// Streams a consistent, metadata-only export of an owner's relational dataset.
// This is intentionally not called a backup: uploaded bytes and an importer are not included.
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { AuroraEnv } from "../env.js";
import { getPool } from "../db/pool.js";
import { requireSessionPreHandler } from "../auth/sessions.js";
import { mapCanvasObject, type CanvasObjectRow } from "../canvas/objects.js";
import {
  mapNote,
  mapPage,
  type NoteRow,
  type PageRow,
} from "../library/map.js";
import { mapFile, type FileRow } from "../files/store.js";

export const EXPORT_SCHEMA_VERSION = 2;

export type ExportManifest = {
  type: "manifest";
  schemaVersion: number;
  exportKind: "metadata-only";
  recoverableBackup: false;
  includesFileBytes: false;
  ownerId: string;
  exportedAt: string;
};

export type ExportCounts = {
  projects: number;
  folders: number;
  notes: number;
  pages: number;
  objects: number;
  files: number;
  noteLinks: number;
  snapshots: number;
};

export type ExportEnd = {
  type: "end";
  counts: ExportCounts;
  exportedAt: string;
};

export type ExportLine =
  | ExportManifest
  | { type: "project"; data: unknown }
  | { type: "folder"; data: unknown }
  | { type: "note"; data: unknown }
  | { type: "page"; data: unknown }
  | { type: "object"; data: unknown }
  | { type: "file-metadata"; data: unknown }
  | { type: "note-link"; data: unknown }
  | { type: "snapshot"; data: unknown }
  | ExportEnd;

export async function* buildMetadataExport(
  ownerId: string,
): AsyncGenerator<string> {
  const client = await getPool().connect();
  let transactionOpen = false;
  try {
    // Every relation below observes one PostgreSQL snapshot even while the HTTP
    // stream is consumed slowly and concurrent edits continue.
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionOpen = true;
    const exportedAt = new Date().toISOString();
    const manifest: ExportManifest = {
      type: "manifest",
      schemaVersion: EXPORT_SCHEMA_VERSION,
      exportKind: "metadata-only",
      recoverableBackup: false,
      includesFileBytes: false,
      ownerId,
      exportedAt,
    };
    yield `${JSON.stringify(manifest)}\n`;

    const counts: ExportCounts = {
      projects: 0,
      folders: 0,
      notes: 0,
      pages: 0,
      objects: 0,
      files: 0,
      noteLinks: 0,
      snapshots: 0,
    };

    const projects = await client.query<{
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
          archivedAt: row.archived_at?.toISOString() ?? null,
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
        },
      })}\n`;
    }

    const folders = await client.query<{
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

    const notes = await client.query<NoteRow>(
      `SELECT id, owner_id, project_id, folder_id, title, kind, canvas_mode, background,
              favorite, archived_at, trashed_at, revision, pdf_file_id, created_at, updated_at
       FROM notes WHERE owner_id = $1 ORDER BY created_at`,
      [ownerId],
    );
    for (const row of notes.rows) {
      counts.notes += 1;
      yield `${JSON.stringify({ type: "note", data: mapNote(row) })}\n`;
    }

    const pages = await client.query<PageRow>(
      `SELECT id, owner_id, note_id, page_index, width, height, background, created_at, updated_at
       FROM pages WHERE owner_id = $1 ORDER BY note_id, page_index`,
      [ownerId],
    );
    for (const row of pages.rows) {
      counts.pages += 1;
      yield `${JSON.stringify({ type: "page", data: mapPage(row) })}\n`;
    }

    const objects = await client.query<CanvasObjectRow>(
      `SELECT id, owner_id, note_id, page_id, kind, x, y, width, height, rotation,
              z_index, locked, group_id, payload, revision, created_at, updated_at
       FROM canvas_objects WHERE owner_id = $1 ORDER BY note_id, z_index`,
      [ownerId],
    );
    for (const row of objects.rows) {
      counts.objects += 1;
      yield `${JSON.stringify({ type: "object", data: mapCanvasObject(row) })}\n`;
    }

    const files = await client.query<FileRow>(
      `SELECT id, owner_id, sha256, size, mime_type, original_name, created_at
       FROM files WHERE owner_id = $1 ORDER BY created_at`,
      [ownerId],
    );
    for (const row of files.rows) {
      counts.files += 1;
      yield `${JSON.stringify({ type: "file-metadata", data: mapFile(row) })}\n`;
    }

    const links = await client.query<{
      id: string;
      owner_id: string;
      source_note_id: string;
      target_note_id: string;
      target_page_index: number | null;
      created_at: Date;
    }>(
      `SELECT id, owner_id, source_note_id, target_note_id, target_page_index, created_at
       FROM note_links WHERE owner_id = $1 ORDER BY created_at`,
      [ownerId],
    );
    for (const row of links.rows) {
      counts.noteLinks += 1;
      yield `${JSON.stringify({
        type: "note-link",
        data: {
          id: row.id,
          ownerId: row.owner_id,
          sourceNoteId: row.source_note_id,
          targetNoteId: row.target_note_id,
          targetPageIndex: row.target_page_index,
          createdAt: row.created_at.toISOString(),
        },
      })}\n`;
    }

    const snapshots = await client.query<{
      id: string;
      owner_id: string;
      note_id: string;
      label: string;
      object_count: number;
      payload: unknown;
      created_at: Date;
    }>(
      `SELECT id, owner_id, note_id, label, object_count, payload, created_at
       FROM snapshots WHERE owner_id = $1 ORDER BY created_at`,
      [ownerId],
    );
    for (const row of snapshots.rows) {
      counts.snapshots += 1;
      yield `${JSON.stringify({
        type: "snapshot",
        data: {
          id: row.id,
          ownerId: row.owner_id,
          noteId: row.note_id,
          label: row.label,
          objectCount: Number(row.object_count),
          payload: row.payload,
          createdAt: row.created_at.toISOString(),
        },
      })}\n`;
    }

    const end: ExportEnd = {
      type: "end",
      counts,
      exportedAt: new Date().toISOString(),
    };
    yield `${JSON.stringify(end)}\n`;
    await client.query("COMMIT");
    transactionOpen = false;
  } finally {
    try {
      if (transactionOpen) await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

export function metadataExportStream(ownerId: string): Readable {
  return Readable.from(buildMetadataExport(ownerId));
}

export function registerExportRoutes(
  app: FastifyInstance,
  env: AuroraEnv,
): void {
  const preHandler = requireSessionPreHandler(env);

  app.get("/api/export", { preHandler }, async (request, reply) => {
    const stream = metadataExportStream(request.ownerId!);
    return reply
      .status(200)
      .header("content-type", "application/x-ndjson")
      .header(
        "content-disposition",
        `attachment; filename="aurora-metadata-export-${new Date().toISOString().slice(0, 10)}.ndjson"`,
      )
      .send(stream);
  });
}

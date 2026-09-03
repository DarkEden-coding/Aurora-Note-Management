// Provides owner-scoped folder CRUD with parent-cycle guards for library routes.
import { conflict, notFound } from "../errors.js";
import { query } from "../db/pool.js";
import pg from "pg";

export type FolderRow = {
  id: string;
  owner_id: string;
  project_id: string;
  parent_id: string | null;
  name: string;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
};

export function mapFolder(row: FolderRow): {
  id: string;
  ownerId: string;
  projectId: string;
  parentId: string | null;
  name: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: row.id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    parentId: row.parent_id,
    name: row.name,
    sortOrder: Number(row.sort_order),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const FOLDER_SELECT = `
  SELECT id, owner_id, project_id, parent_id, name, sort_order, created_at, updated_at
  FROM folders
`;

export async function listFolders(ownerId: string, projectId: string) {
  const result = await query<FolderRow>(
    `${FOLDER_SELECT} WHERE owner_id = $1 AND project_id = $2 ORDER BY parent_id NULLS FIRST, sort_order, created_at`,
    [ownerId, projectId],
  );
  return result.rows.map(mapFolder);
}

export async function createFolder(
  ownerId: string,
  projectId: string,
  input: { name: string; parentId?: string | undefined },
) {
  if (input.parentId) {
    const parent = await ensureFolder(ownerId, input.parentId);
    if (parent.project_id !== projectId) {
      throw conflict("Parent folder belongs to a different project");
    }
  }
  const result = await query<FolderRow>(
    `INSERT INTO folders (owner_id, project_id, parent_id, name) VALUES ($1, $2, $3, $4) RETURNING id, owner_id, project_id, parent_id, name, sort_order, created_at, updated_at`,
    [ownerId, projectId, input.parentId ?? null, input.name],
  );
  return mapFolder(result.rows[0]!);
}

export async function ensureFolder(
  ownerId: string,
  folderId: string,
): Promise<FolderRow> {
  const result = await query<FolderRow>(
    `${FOLDER_SELECT} WHERE owner_id = $1 AND id = $2`,
    [ownerId, folderId],
  );
  const row = result.rows[0];
  if (!row) throw notFound("Folder");
  return row;
}

async function isDescendant(
  ownerId: string,
  ancestorId: string,
  candidateId: string,
): Promise<boolean> {
  let currentId: string | null = candidateId;
  for (let depth = 0; depth < 64 && currentId; depth += 1) {
    if (currentId === ancestorId) return true;
    const row: pg.QueryResult<{ parent_id: string | null }> = await query<{
      parent_id: string | null;
    }>("SELECT parent_id FROM folders WHERE owner_id = $1 AND id = $2", [
      ownerId,
      currentId,
    ]);
    currentId = row.rows[0]?.parent_id ?? null;
  }
  return false;
}

export async function updateFolder(
  ownerId: string,
  folderId: string,
  patch: { name?: string | undefined; parentId?: string | null | undefined },
) {
  const existing = await ensureFolder(ownerId, folderId);
  let parentId = existing.parent_id;
  if (patch.parentId !== undefined) {
    if (patch.parentId === folderId) {
      throw conflict("Folder cannot be its own parent");
    }
    if (
      patch.parentId &&
      (await isDescendant(ownerId, folderId, patch.parentId))
    ) {
      throw conflict("Folder cannot be moved under one of its descendants");
    }
    if (patch.parentId) {
      const parent = await ensureFolder(ownerId, patch.parentId);
      if (parent.project_id !== existing.project_id) {
        throw conflict("Parent folder belongs to a different project");
      }
    }
    parentId = patch.parentId;
  }
  const result = await query<FolderRow>(
    `UPDATE folders SET parent_id = $3, name = COALESCE($4, name), updated_at = now()
     WHERE owner_id = $1 AND id = $2
     RETURNING id, owner_id, project_id, parent_id, name, sort_order, created_at, updated_at`,
    [ownerId, folderId, parentId, patch.name ?? null],
  );
  return mapFolder(result.rows[0]!);
}

export async function deleteFolder(ownerId: string, folderId: string) {
  const result = await query<{ id: string }>(
    "DELETE FROM folders WHERE owner_id = $1 AND id = $2 RETURNING id",
    [ownerId, folderId],
  );
  if (!result.rows[0]) throw notFound("Folder");
  return { deleted: true };
}

// Provides owner-scoped project CRUD and guard checks used by library routes.
import { conflict, notFound } from "../errors.js";
import { query } from "../db/pool.js";

export type ProjectRow = {
  id: string;
  owner_id: string;
  name: string;
  color: string;
  sort_order: number;
  is_favorite: boolean;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export function mapProject(row: ProjectRow): {
  id: string;
  ownerId: string;
  name: string;
  color: string;
  sortOrder: number;
  isFavorite: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    color: row.color,
    sortOrder: Number(row.sort_order),
    isFavorite: row.is_favorite,
    archivedAt: row.archived_at ? row.archived_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const PROJECT_SELECT = `
  SELECT id, owner_id, name, color, sort_order, is_favorite, archived_at, created_at, updated_at
  FROM projects
`;

export async function listProjects(ownerId: string, includeArchived: boolean) {
  const result = await query<ProjectRow>(
    `${PROJECT_SELECT} WHERE owner_id = $1 AND ($2 OR archived_at IS NULL) ORDER BY sort_order, created_at`,
    [ownerId, includeArchived],
  );
  return result.rows.map(mapProject);
}

export async function getProject(ownerId: string, projectId: string) {
  const result = await query<ProjectRow>(
    `${PROJECT_SELECT} WHERE owner_id = $1 AND id = $2`,
    [ownerId, projectId],
  );
  const row = result.rows[0];
  if (!row) throw notFound("Project");
  return mapProject(row);
}

export async function createProject(
  ownerId: string,
  input: { name: string; color?: string | undefined },
) {
  const inserted = await query<ProjectRow>(
    `INSERT INTO projects (owner_id, name, color) VALUES ($1, $2, $3)
     RETURNING id, owner_id, name, color, sort_order, is_favorite, archived_at, created_at, updated_at`,
    [ownerId, input.name, input.color ?? "#8b7cf6"],
  );
  return mapProject(inserted.rows[0]!);
}

export async function updateProject(
  ownerId: string,
  projectId: string,
  patch: {
    name?: string | undefined;
    color?: string | undefined;
    isFavorite?: boolean | undefined;
    archived?: boolean | undefined;
  },
) {
  const assignments: string[] = ["updated_at = now()"];
  const params: unknown[] = [ownerId, projectId];
  if (patch.name !== undefined) {
    params.push(patch.name);
    assignments.push(`name = $${params.length}`);
  }
  if (patch.color !== undefined) {
    params.push(patch.color);
    assignments.push(`color = $${params.length}`);
  }
  if (patch.isFavorite !== undefined) {
    params.push(patch.isFavorite);
    assignments.push(`is_favorite = $${params.length}`);
  }
  if (patch.archived !== undefined) {
    assignments.push(
      patch.archived ? "archived_at = now()" : "archived_at = NULL",
    );
  }
  const result = await query<ProjectRow>(
    `UPDATE projects SET ${assignments.join(", ")} WHERE owner_id = $1 AND id = $2 RETURNING id, owner_id, name, color, sort_order, is_favorite, archived_at, created_at, updated_at`,
    params,
  );
  const row = result.rows[0];
  if (!row) throw notFound("Project");
  return mapProject(row);
}

export async function deleteProject(ownerId: string, projectId: string) {
  const notes = await query<{ id: string }>(
    "SELECT id FROM notes WHERE owner_id = $1 AND project_id = $2 LIMIT 1",
    [ownerId, projectId],
  );
  if (notes.rows[0]) {
    throw conflict("Project still contains notes; delete or move them first");
  }
  const result = await query<{ id: string }>(
    "DELETE FROM projects WHERE owner_id = $1 AND id = $2 RETURNING id",
    [ownerId, projectId],
  );
  if (!result.rows[0]) throw notFound("Project");
  return { deleted: true };
}

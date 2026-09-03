// PostgreSQL full-text search over the owner's note titles, filenames, and text canvas payloads.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuroraEnv } from "../env.js";
import { query } from "../db/pool.js";
import { requireSessionPreHandler } from "../auth/sessions.js";

const searchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type SearchResults = {
  notes: {
    id: string;
    title: string;
    trashedAt: string | null;
    rank: number;
  }[];
  files: { id: string; originalName: string; rank: number }[];
  objects: {
    id: string;
    noteId: string;
    kind: string;
    text: string;
    rank: number;
  }[];
  serverTimestamp: string;
};

// websearch_to_tsquery keeps user input as a query expression; every call uses positional params.
export async function searchOwnerData(
  ownerId: string,
  q: string,
  limit: number,
): Promise<SearchResults> {
  const notes = await query<{
    id: string;
    title: string;
    trashed_at: Date | null;
    rank: string;
  }>(
    `SELECT id, title, trashed_at, ts_rank(search_vector, websearch_to_tsquery('english', $2)) AS rank
     FROM notes
     WHERE owner_id = $1 AND search_vector @@ websearch_to_tsquery('english', $2)
     ORDER BY rank DESC
     LIMIT $3`,
    [ownerId, q, limit],
  );
  const files = await query<{
    id: string;
    original_name: string;
    rank: string;
  }>(
    `SELECT id, original_name, ts_rank(search_vector, websearch_to_tsquery('english', $2)) AS rank
     FROM files
     WHERE owner_id = $1 AND search_vector @@ websearch_to_tsquery('english', $2)
     ORDER BY rank DESC
     LIMIT $3`,
    [ownerId, q, limit],
  );
  const objects = await query<{
    id: string;
    note_id: string;
    kind: string;
    text: string | null;
    rank: string;
  }>(
    `SELECT o.id, o.note_id, o.kind, o.payload ->> 'text' AS text,
            ts_rank(to_tsvector('english', coalesce(o.payload ->> 'text', '')), websearch_to_tsquery('english', $2)) AS rank
     FROM canvas_objects o
     JOIN notes n ON n.owner_id = o.owner_id AND n.id = o.note_id
     WHERE o.owner_id = $1
       AND o.kind IN ('rich-text', 'sticky-note')
       AND to_tsvector('english', coalesce(o.payload ->> 'text', '')) @@ websearch_to_tsquery('english', $2)
       AND n.trashed_at IS NULL
     ORDER BY rank DESC
     LIMIT $3`,
    [ownerId, q, limit],
  );
  return {
    notes: notes.rows.map((row) => ({
      id: row.id,
      title: row.title,
      trashedAt: row.trashed_at ? row.trashed_at.toISOString() : null,
      rank: Number(row.rank),
    })),
    files: files.rows.map((row) => ({
      id: row.id,
      originalName: row.original_name,
      rank: Number(row.rank),
    })),
    objects: objects.rows.map((row) => ({
      id: row.id,
      noteId: row.note_id,
      kind: row.kind,
      text: row.text ?? "",
      rank: Number(row.rank),
    })),
    serverTimestamp: new Date().toISOString(),
  };
}

export function registerSearchRoutes(
  app: FastifyInstance,
  env: AuroraEnv,
): void {
  const preHandler = requireSessionPreHandler(env);

  app.get("/api/search", { preHandler }, async (request) => {
    const { q, limit } = searchQuerySchema.parse(request.query);
    return searchOwnerData(request.ownerId!, q, limit);
  });
}

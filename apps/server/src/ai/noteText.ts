// Extracts readable text from Tiptap JSON, sticky notes, and project note listings.
import { notFound } from "../errors.js";
import { query } from "../db/pool.js";
import { getProject } from "../library/projects.js";

type DocNode = {
  type?: string;
  text?: string;
  content?: DocNode[];
};

export function extractDocText(doc: unknown): string {
  return walk(doc as DocNode)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function walk(node: DocNode | undefined): string {
  if (!node || typeof node !== "object") return "";
  if (node.type === "text") return node.text ?? "";
  const children = node.content ?? [];
  if (node.type === "tableRow") {
    return `${children.map(walk).join(" | ")}\n`;
  }
  const inner = children.map(walk).join("");
  if (
    node.type === "paragraph" ||
    node.type === "heading" ||
    node.type === "listItem" ||
    node.type === "blockquote"
  ) {
    return `${inner}\n`;
  }
  return inner;
}

export type ProjectNoteSummary = {
  id: string;
  title: string;
  folderPath: string;
  updatedAt: string;
};

export async function listProjectNotes(
  ownerId: string,
  projectId: string,
): Promise<ProjectNoteSummary[]> {
  await getProject(ownerId, projectId);
  const notes = await query<{
    id: string;
    title: string;
    folder_id: string | null;
    updated_at: Date;
  }>(
    `SELECT id, title, folder_id, updated_at FROM notes
     WHERE owner_id = $1 AND project_id = $2 AND trashed_at IS NULL AND archived_at IS NULL
     ORDER BY updated_at DESC`,
    [ownerId, projectId],
  );
  const folders = await query<{
    id: string;
    parent_id: string | null;
    name: string;
  }>(
    `SELECT id, parent_id, name FROM folders WHERE owner_id = $1 AND project_id = $2`,
    [ownerId, projectId],
  );
  const byId = new Map(folders.rows.map((row) => [row.id, row]));
  const folderPath = (folderId: string | null): string => {
    const names: string[] = [];
    let current = folderId ? byId.get(folderId) : undefined;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      names.unshift(current.name);
      current = current.parent_id ? byId.get(current.parent_id) : undefined;
    }
    return names.join(" / ");
  };
  return notes.rows.map((row) => ({
    id: row.id,
    title: row.title,
    folderPath: folderPath(row.folder_id),
    updatedAt: row.updated_at.toISOString(),
  }));
}

export async function readNoteText(
  ownerId: string,
  projectId: string,
  noteId: string,
): Promise<{ id: string; title: string; text: string }> {
  const note = await query<{ id: string; title: string }>(
    `SELECT id, title FROM notes
     WHERE owner_id = $1 AND project_id = $2 AND id = $3
       AND trashed_at IS NULL AND archived_at IS NULL`,
    [ownerId, projectId, noteId],
  );
  const row = note.rows[0];
  if (!row) throw notFound("Note");
  const objects = await query<{ kind: string; payload: unknown }>(
    `SELECT kind, payload FROM canvas_objects
     WHERE owner_id = $1 AND note_id = $2
     ORDER BY z_index, id`,
    [ownerId, noteId],
  );
  const chunks: string[] = [];
  for (const object of objects.rows) {
    const payload = (object.payload ?? {}) as Record<string, unknown>;
    if (object.kind === "sticky-note" && typeof payload.text === "string") {
      chunks.push(payload.text);
    } else if (object.kind === "rich-text") {
      const text = extractDocText(payload.doc);
      if (text) chunks.push(text);
    }
  }
  return { id: row.id, title: row.title, text: chunks.join("\n\n") };
}

export type GrepHit = {
  noteId: string;
  title: string;
  snippet: string;
};

export async function grepProjectNotes(
  ownerId: string,
  projectId: string,
  pattern: string,
): Promise<GrepHit[]> {
  const summaries = await listProjectNotes(ownerId, projectId);
  const needle = pattern.toLowerCase();
  const hits: GrepHit[] = [];
  for (const summary of summaries) {
    const body = await readNoteText(ownerId, projectId, summary.id);
    const haystack = `${body.title}\n${body.text}`;
    const index = haystack.toLowerCase().indexOf(needle);
    if (index === -1) continue;
    const start = Math.max(0, index - 80);
    const snippet = haystack
      .slice(start, start + 200)
      .replace(/\s+/g, " ")
      .trim();
    hits.push({ noteId: summary.id, title: summary.title, snippet });
    if (hits.length >= 40) break;
  }
  return hits;
}

export function splitAssistantText(
  text: string,
): Array<
  { type: "text"; text: string } | { type: "html"; title: string; html: string }
> {
  const parts: Array<
    | { type: "text"; text: string }
    | { type: "html"; title: string; html: string }
  > = [];
  const re = /```html\s*\n([\s\S]*?)```/g;
  let last = 0;
  let visual = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const before = text.slice(last, match.index).trim();
    if (before) parts.push({ type: "text", text: before });
    visual += 1;
    parts.push({
      type: "html",
      title: `Visualization ${visual}`,
      html: match[1]!.trim(),
    });
    last = match.index + match[0].length;
  }
  const rest = text.slice(last).trim();
  if (rest) parts.push({ type: "text", text: rest });
  if (parts.length === 0 && text.trim())
    parts.push({ type: "text", text: text.trim() });
  return parts;
}

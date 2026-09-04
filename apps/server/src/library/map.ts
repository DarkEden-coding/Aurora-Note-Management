// Owner-scoped row mappers shared by library services and routes.
// NoteJson/PageJson live here until promoted into @aurora/shared contracts.
import {
  backgroundSchema,
  type Background,
  type CanvasMode,
} from "@aurora/shared";

export type BackgroundRow = { background: unknown };

// Transport types for notes and pages; server-local until promoted into @aurora/shared.
export type NoteJson = {
  id: string;
  ownerId: string;
  projectId: string;
  folderId: string | null;
  title: string;
  kind: "canvas" | "pdf";
  canvasMode: CanvasMode;
  background: Background;
  favorite: boolean;
  archivedAt: string | null;
  trashedAt: string | null;
  revision: number;
  pdfFileId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PageJson = {
  id: string;
  ownerId: string;
  noteId: string;
  pageIndex: number;
  width: number;
  height: number;
  background: Background;
};

export const DEFAULT_BACKGROUND: Background = {
  pattern: "blank",
  color: "#ffffff",
  patternColor: "#d4d4d8",
  spacing: 24,
};

const BACKGROUND_PATTERNS = [
  "blank",
  "ruled",
  "square-grid",
  "dot-grid",
  "solid",
] as const;

const CANVAS_MODES: readonly CanvasMode[] = [
  "infinite",
  "fixed-width",
  "fixed-height",
  "paged",
];

// Tolerant reader for stored JSONB backgrounds: valid values win, missing or
// invalid fields fall back to defaults so legacy rows never break responses.
export function mergeBackground(raw: unknown): Background {
  const result = backgroundSchema.safeParse(raw ?? {});
  if (result.success) return result.data;
  const partial = (raw ?? {}) as Record<string, unknown>;
  const pattern = BACKGROUND_PATTERNS.find(
    (candidate) => candidate === partial.pattern,
  );
  return {
    pattern: pattern ?? DEFAULT_BACKGROUND.pattern,
    color:
      typeof partial.color === "string" && partial.color.length <= 32
        ? partial.color
        : DEFAULT_BACKGROUND.color,
    patternColor:
      typeof partial.patternColor === "string" &&
      partial.patternColor.length <= 32
        ? partial.patternColor
        : DEFAULT_BACKGROUND.patternColor,
    spacing:
      typeof partial.spacing === "number" &&
      partial.spacing >= 4 &&
      partial.spacing <= 256
        ? partial.spacing
        : DEFAULT_BACKGROUND.spacing,
  };
}

export type NoteRow = {
  id: string;
  owner_id: string;
  project_id: string;
  folder_id: string | null;
  title: string;
  kind: string;
  canvas_mode: string;
  background: unknown;
  favorite: boolean;
  archived_at: Date | null;
  trashed_at: Date | null;
  revision: number;
  pdf_file_id: string | null;
  created_at: Date;
  updated_at: Date;
};

export function mapNote(row: NoteRow): NoteJson {
  return {
    id: row.id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    folderId: row.folder_id,
    title: row.title,
    kind: row.kind === "pdf" ? "pdf" : "canvas",
    canvasMode:
      CANVAS_MODES.find((mode) => mode === row.canvas_mode) ?? "infinite",
    background: mergeBackground(row.background),
    favorite: row.favorite,
    archivedAt: row.archived_at ? row.archived_at.toISOString() : null,
    trashedAt: row.trashed_at ? row.trashed_at.toISOString() : null,
    revision: row.revision,
    pdfFileId: row.pdf_file_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export type PageRow = {
  id: string;
  owner_id: string;
  note_id: string;
  page_index: number;
  width: string;
  height: string;
  background: unknown;
  created_at: Date;
  updated_at: Date;
};

export function mapPage(row: PageRow): PageJson {
  return {
    id: row.id,
    ownerId: row.owner_id,
    noteId: row.note_id,
    pageIndex: Number(row.page_index),
    width: Number(row.width),
    height: Number(row.height),
    background: mergeBackground(row.background),
  };
}

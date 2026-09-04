// This file is the sole transport contract shared by Aurora's browser and authoritative server.
import { z } from "zod";

export const idSchema = z.string().uuid();
export const isoDateSchema = z.string().datetime();

export const themeSchema = z.enum(["neomorphic", "glass", "minimal"]);

// Account-synced, ordered drawing colors. Full six-digit CSS hex is required
// so every client renders the exact same color without shorthand expansion.
export const drawingPaletteSchema = z
  .array(z.string().regex(/^#[0-9a-fA-F]{6}$/))
  .min(1)
  .max(64)
  .refine(
    (colors) =>
      new Set(colors.map((color) => color.toLowerCase())).size ===
      colors.length,
    { message: "Drawing palette colors must be unique" },
  )
  .default(["#000000"]);

export const canvasModeSchema = z.enum([
  "infinite",
  "fixed-width",
  "fixed-height",
  "paged",
]);
export const noteKindSchema = z.enum(["canvas", "pdf"]);
export const objectKindSchema = z.enum([
  "rich-text",
  "stroke",
  "image",
  "attachment",
  "rectangle",
  "ellipse",
  "line",
  "arrow",
  "sticky-note",
  "pdf-page-reference",
]);

export const boundsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().positive().finite(),
  height: z.number().positive().finite(),
});

export const viewportSchema = boundsSchema.extend({
  zoom: z.number().positive().finite(),
});

export const backgroundSchema = z.object({
  pattern: z.enum(["blank", "ruled", "square-grid", "dot-grid", "solid"]),
  color: z.string().max(32),
  patternColor: z.string().max(32),
  spacing: z.number().min(4).max(256),
});

export const canvasObjectSchema = z.object({
  id: idSchema,
  ownerId: idSchema,
  noteId: idSchema,
  pageId: idSchema.nullable(),
  kind: objectKindSchema,
  bounds: boundsSchema,
  rotation: z.number().finite(),
  zIndex: z.number().int(),
  locked: z.boolean(),
  groupId: idSchema.nullable(),
  payload: z.record(z.string(), z.unknown()),
  revision: z.number().int().nonnegative(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});

export const syncOperationSchema = z.object({
  id: idSchema,
  deviceId: idSchema,
  noteId: idSchema,
  objectId: idSchema,
  baseRevision: z.number().int().nonnegative(),
  clientTimestamp: isoDateSchema,
  mutation: z.discriminatedUnion("type", [
    z.object({ type: z.literal("upsert"), object: canvasObjectSchema }),
    z.object({ type: z.literal("delete") }),
  ]),
});

export const syncAckSchema = z.object({
  operationId: idSchema,
  status: z.enum(["applied", "duplicate", "conflict"]),
  object: canvasObjectSchema.optional(),
  conflictId: idSchema.optional(),
  serverTimestamp: isoDateSchema,
});

export const deleteMarkerSchema = z.object({
  deleted: z.literal(true),
  baseRevision: z.number().int().nonnegative(),
  clientTimestamp: isoDateSchema,
});

export const syncConflictSchema = z.object({
  id: idSchema,
  noteId: idSchema,
  objectId: idSchema,
  baseObject: canvasObjectSchema.nullable(),
  incomingObject: z.union([canvasObjectSchema, deleteMarkerSchema]),
  createdAt: isoDateSchema,
});

export const regionalObjectQuerySchema = z.object({
  noteId: idSchema,
  pageId: idSchema.nullable().optional(),
  viewport: boundsSchema,
  sinceRevision: z.number().int().nonnegative().optional(),
});

// Response of the regional object query route; `truncated` reports that the
// server hit its regional read cap and another viewport pass may be needed.
export const regionalObjectQueryResponseSchema = z.object({
  objects: z.array(canvasObjectSchema),
  truncated: z.boolean(),
  serverTimestamp: isoDateSchema,
});

// ---- Library tree contract (GET /api/library) ----------------------------
// Flattened, id-stable summaries the web sidebar renders. The server derives
// `trashed`/`archived`/`order` from its richer row shapes so both runtimes
// share one definition.

export const libraryProjectSchema = z.object({
  id: idSchema,
  name: z.string(),
  order: z.number().int(),
});

export const libraryFolderSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  parentId: idSchema.nullable(),
  name: z.string(),
});

export const libraryNoteSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  folderId: idSchema.nullable(),
  title: z.string(),
  kind: noteKindSchema,
  canvasMode: canvasModeSchema,
  background: backgroundSchema.default({
    pattern: "dot-grid",
    color: "#1b1d21",
    patternColor: "#3a3f4a",
    spacing: 24,
  }),
  favorite: z.boolean(),
  trashed: z.boolean(),
  archived: z.boolean(),
  revision: z.number().int().nonnegative(),
  updatedAt: isoDateSchema,
});

export const libraryTreeSchema = z.object({
  projects: z.array(libraryProjectSchema),
  folders: z.array(libraryFolderSchema),
  notes: z.array(libraryNoteSchema),
});

// ---- Owner-scoped WebSocket events (/sync/ws) ----------------------------
// Object broadcasts carry complete upserts and explicit deletion IDs so every
// connected device can apply the same authoritative change.
export const serverEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("objects-changed"),
    noteId: idSchema,
    objects: z.array(canvasObjectSchema),
    deletedObjectIds: z.array(idSchema),
    originOperationId: z.string(),
    serverTimestamp: isoDateSchema,
  }),
  z.object({
    type: z.literal("note-changed"),
    noteId: idSchema,
    originOperationId: z.string(),
    serverTimestamp: isoDateSchema,
  }),
]);

export type Theme = z.infer<typeof themeSchema>;
export type DrawingPalette = z.infer<typeof drawingPaletteSchema>;
export type CanvasMode = z.infer<typeof canvasModeSchema>;
export type NoteKind = z.infer<typeof noteKindSchema>;
export type Bounds = z.infer<typeof boundsSchema>;
export type Viewport = z.infer<typeof viewportSchema>;
export type Background = z.infer<typeof backgroundSchema>;
export type CanvasObject = z.infer<typeof canvasObjectSchema>;
export type SyncOperation = z.infer<typeof syncOperationSchema>;
export type SyncAck = z.infer<typeof syncAckSchema>;
export type DeleteMarker = z.infer<typeof deleteMarkerSchema>;
export type SyncConflict = z.infer<typeof syncConflictSchema>;
export type RegionalObjectQuery = z.infer<typeof regionalObjectQuerySchema>;
export type RegionalObjectQueryResponse = z.infer<
  typeof regionalObjectQueryResponseSchema
>;
export type LibraryProject = z.infer<typeof libraryProjectSchema>;
export type LibraryFolder = z.infer<typeof libraryFolderSchema>;
export type LibraryNote = z.infer<typeof libraryNoteSchema>;
export type LibraryTree = z.infer<typeof libraryTreeSchema>;
export type ServerEvent = z.infer<typeof serverEventSchema>;

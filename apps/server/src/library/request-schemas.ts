// Server-local zod request schemas until promoted into @aurora/shared contracts.
// Schemas that already exist in @aurora/shared are re-exported from there so the
// server never drifts from the transport contract.
import { z } from "zod";
import {
  backgroundSchema,
  canvasModeSchema,
  objectKindSchema,
} from "@aurora/shared";

export { backgroundSchema };

export const noteKindSchema = z.enum(["canvas", "pdf"]);

// All four canvas modes are accepted; the shared contract is authoritative.
export const noteCanvasModeSchema = canvasModeSchema;

// Canvas object kinds accepted by server-side canvas routes; mirrors the shared contract.
export const canvasObjectKindSchema = objectKindSchema;

export const noteLinkStateSchema = z.enum(["live", "trashed", "deleted"]);

export const searchSectionSchema = z.enum(["notes", "files", "objects"]);

export const projectSummarySchema = z.object({
  id: z.string().uuid(),
  ownerId: z.string().uuid(),
  name: z.string(),
  color: z.string(),
  sortOrder: z.number().int(),
  isFavorite: z.boolean(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const folderSummarySchema = z.object({
  id: z.string().uuid(),
  ownerId: z.string().uuid(),
  projectId: z.string().uuid(),
  parentId: z.string().uuid().nullable(),
  name: z.string(),
  sortOrder: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const pageSummarySchema = z.object({
  id: z.string().uuid(),
  ownerId: z.string().uuid(),
  noteId: z.string().uuid(),
  pageIndex: z.number().int().min(0),
  width: z.number().positive(),
  height: z.number().positive(),
  background: backgroundSchema,
});

export const noteSummarySchema = z.object({
  id: z.string().uuid(),
  ownerId: z.string().uuid(),
  projectId: z.string().uuid(),
  folderId: z.string().uuid().nullable(),
  title: z.string(),
  kind: noteKindSchema,
  canvasMode: noteCanvasModeSchema,
  background: backgroundSchema,
  favorite: z.boolean(),
  archivedAt: z.string().nullable(),
  trashedAt: z.string().nullable(),
  revision: z.number().int().min(0),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const noteLinkSummarySchema = z.object({
  id: z.string().uuid(),
  sourceNoteId: z.string().uuid(),
  targetNoteId: z.string().uuid(),
  targetPageIndex: z.number().int().min(0).nullable(),
  targetNoteTitle: z.string(),
  targetNoteState: noteLinkStateSchema,
  targetPageCount: z.number().int().min(0),
});

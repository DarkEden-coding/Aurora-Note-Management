// Maps library domain operations to owner-scoped HTTP routes with validated request payloads.
// Library transport payloads are server-local zod schemas until promoted into @aurora/shared contracts.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuroraEnv } from "../env.js";
import { requireSessionPreHandler } from "../auth/sessions.js";
import {
  backgroundSchema,
  canvasObjectKindSchema,
  noteKindSchema,
  noteCanvasModeSchema,
} from "./request-schemas.js";
import * as projects from "./projects.js";
import * as folders from "./folders.js";
import * as notes from "./notes.js";
import { getLibraryTree } from "./tree.js";

const createProjectSchema = z.object({
  name: z.string().min(1).max(120),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
});

const patchProjectSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  isFavorite: z.boolean().optional(),
  archived: z.boolean().optional(),
});

const idParamSchema = z.object({ id: z.string().uuid() });

const createFolderSchema = z.object({
  name: z.string().min(1).max(120),
  parentId: z.string().uuid().optional(),
});

const patchFolderSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  parentId: z.string().uuid().nullable().optional(),
});

const createNoteSchema = z.object({
  projectId: z.string().uuid(),
  folderId: z.string().uuid().optional(),
  title: z.string().max(200).optional(),
  kind: noteKindSchema.optional(),
  canvasMode: noteCanvasModeSchema.optional(),
  background: backgroundSchema.optional(),
});

const patchNoteSchema = z.object({
  title: z.string().max(200).optional(),
  folderId: z.string().uuid().nullable().optional(),
  background: backgroundSchema.optional(),
  canvasMode: noteCanvasModeSchema.optional(),
});

const listNotesQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
  folderId: z.string().uuid().optional(),
  favorite: z.stringbool().optional(),
  archived: z.stringbool().optional(),
  trashed: z.stringbool().optional(),
  kind: noteKindSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const createLinkSchema = z.object({
  targetNoteId: z.string().uuid(),
  targetPageIndex: z.number().int().min(0).optional(),
});

const listProjectsQuerySchema = z.object({
  includeArchived: z.stringbool().optional(),
});

export function registerLibraryRoutes(
  app: FastifyInstance,
  env: AuroraEnv,
): void {
  const preHandler = requireSessionPreHandler(env);

  // Aggregate tree hydration endpoint (shared libraryTreeSchema contract).
  app.get("/api/library", { preHandler }, async (request) => {
    return getLibraryTree(request.ownerId!);
  });

  app.get("/api/projects", { preHandler }, async (request) => {
    const { includeArchived } = listProjectsQuerySchema.parse(request.query);
    return projects.listProjects(request.ownerId!, includeArchived ?? false);
  });
  app.post("/api/projects", { preHandler }, async (request, reply) => {
    const input = createProjectSchema.parse(request.body);
    const project = await projects.createProject(request.ownerId!, input);
    return reply.status(201).send({ project });
  });
  app.patch("/api/projects/:id", { preHandler }, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    const patch = patchProjectSchema.parse(request.body);
    return {
      project: await projects.updateProject(request.ownerId!, id, patch),
    };
  });
  app.delete("/api/projects/:id", { preHandler }, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return projects.deleteProject(request.ownerId!, id);
  });

  app.get("/api/projects/:id/folders", { preHandler }, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    await projects.getProject(request.ownerId!, id);
    return { folders: await folders.listFolders(request.ownerId!, id) };
  });
  app.post(
    "/api/projects/:id/folders",
    { preHandler },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      await projects.getProject(request.ownerId!, id);
      const input = createFolderSchema.parse(request.body);
      const folder = await folders.createFolder(request.ownerId!, id, input);
      return reply.status(201).send({ folder });
    },
  );
  app.patch("/api/folders/:id", { preHandler }, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    const patch = patchFolderSchema.parse(request.body);
    return { folder: await folders.updateFolder(request.ownerId!, id, patch) };
  });
  app.delete("/api/folders/:id", { preHandler }, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return folders.deleteFolder(request.ownerId!, id);
  });

  app.get("/api/notes", { preHandler }, async (request) => {
    const filters = listNotesQuerySchema.parse(request.query);
    return { notes: await notes.listNotes(request.ownerId!, filters) };
  });
  app.post("/api/notes", { preHandler }, async (request, reply) => {
    const input = createNoteSchema.parse(request.body);
    await projects.getProject(request.ownerId!, input.projectId);
    const note = await notes.createNote(request.ownerId!, input);
    return reply.status(201).send({ note });
  });
  app.get("/api/notes/:id", { preHandler }, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return notes.getNoteWithPages(request.ownerId!, id);
  });
  app.patch("/api/notes/:id", { preHandler }, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    const patch = patchNoteSchema.parse(request.body);
    return { note: await notes.updateNote(request.ownerId!, id, patch) };
  });

  app.post("/api/notes/:id/archive", { preHandler }, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return { note: await notes.setNoteArchived(request.ownerId!, id, true) };
  });
  app.post("/api/notes/:id/unarchive", { preHandler }, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return { note: await notes.setNoteArchived(request.ownerId!, id, false) };
  });
  app.post("/api/notes/:id/favorite", { preHandler }, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return { note: await notes.setNoteFavorite(request.ownerId!, id, true) };
  });
  app.post("/api/notes/:id/unfavorite", { preHandler }, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return { note: await notes.setNoteFavorite(request.ownerId!, id, false) };
  });
  app.post("/api/notes/:id/trash", { preHandler }, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return { note: await notes.setNoteTrashed(request.ownerId!, id, true) };
  });
  app.post("/api/notes/:id/restore", { preHandler }, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return { note: await notes.setNoteTrashed(request.ownerId!, id, false) };
  });
  app.delete("/api/notes/:id", { preHandler }, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return notes.deleteNote(request.ownerId!, id);
  });

  app.get("/api/notes/:id/links", { preHandler }, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return { links: await notes.listNoteLinks(request.ownerId!, id) };
  });
  app.post("/api/notes/:id/links", { preHandler }, async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const input = createLinkSchema.parse(request.body);
    const result = await notes.createNoteLink(request.ownerId!, id, input);
    return reply.status(201).send(result);
  });
  app.delete(
    "/api/notes/:id/links/:linkId",
    { preHandler },
    async (request) => {
      const { id, linkId } = z
        .object({ id: z.string().uuid(), linkId: z.string().uuid() })
        .parse(request.params);
      return notes.deleteNoteLink(request.ownerId!, id, linkId);
    },
  );
}

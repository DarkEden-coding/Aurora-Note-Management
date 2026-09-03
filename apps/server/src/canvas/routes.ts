// Routes regional canvas reads; every read is bounds-limited, page-scoped, and owner-scoped.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { regionalObjectQuerySchema } from "@aurora/shared";
import type { AuroraEnv } from "../env.js";
import { invalid } from "../errors.js";
import { requireSessionPreHandler } from "../auth/sessions.js";
import { ensureNoteReadable, queryRegionalObjects } from "./objects.js";

const noteIdParamSchema = z.object({ noteId: z.string().uuid() });
const queryBodySchema = regionalObjectQuerySchema.omit({ noteId: true });

export function registerCanvasRoutes(
  app: FastifyInstance,
  env: AuroraEnv,
): void {
  const preHandler = requireSessionPreHandler(env);

  app.post(
    "/api/notes/:noteId/objects/query",
    { preHandler },
    async (request) => {
      const { noteId } = noteIdParamSchema.parse(request.params);
      const body = queryBodySchema.parse(request.body);
      const q = regionalObjectQuerySchema.parse({ ...body, noteId });
      if (q.noteId !== noteId) {
        throw invalid("Regional query noteId must match the route parameter");
      }
      await ensureNoteReadable(request.ownerId!, noteId);
      return queryRegionalObjects(request.ownerId!, q);
    },
  );
}

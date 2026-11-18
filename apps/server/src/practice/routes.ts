// Browser practice routes (single owner): read a note's practice session, submit work (with the measured card layout), and choose Next/Retry.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { practiceActionSchema, practiceSubmitSchema } from "@aurora/shared";
import { ownerPreHandler } from "../account/owner.js";
import { actOnQuestion, getSessionForNote, submitQuestion } from "./service.js";

const noteParamsSchema = z.object({ noteId: z.string().uuid() });
const questionParamsSchema = z.object({ questionId: z.string().uuid() });

export function registerPracticeRoutes(app: FastifyInstance): void {
  const preHandler = ownerPreHandler();

  app.get("/api/practice/notes/:noteId", { preHandler }, async (request) => {
    const { noteId } = noteParamsSchema.parse(request.params);
    return getSessionForNote(request.ownerId!, noteId);
  });

  app.post(
    "/api/practice/questions/:questionId/submit",
    { preHandler },
    async (request) => {
      const { questionId } = questionParamsSchema.parse(request.params);
      const { regions } = practiceSubmitSchema.parse(request.body ?? {});
      return submitQuestion(request.ownerId!, questionId, regions);
    },
  );

  app.post(
    "/api/practice/questions/:questionId/action",
    { preHandler },
    async (request) => {
      const { questionId } = questionParamsSchema.parse(request.params);
      const { action } = practiceActionSchema.parse(request.body);
      return actOnQuestion(request.ownerId!, questionId, action);
    },
  );
}

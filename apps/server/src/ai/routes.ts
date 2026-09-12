// HTTP routes for ChatGPT device login, chat CRUD, note context, and streamed turns.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  chatModelSchema,
  chatPartSchema,
  chatReasoningSchema,
  idSchema,
} from "@aurora/shared";
import type { AuroraEnv } from "../env.js";
import { requireSessionPreHandler } from "../auth/sessions.js";
import {
  deleteCredentials,
  extractEmail,
  loadCredentials,
  pollDeviceAuth,
  startDeviceAuth,
} from "./oauth.js";
import {
  createConversation,
  deleteConversation,
  listConversations,
  listMessages,
  patchConversation,
} from "./conversations.js";
import {
  grepProjectNotes,
  listProjectNotes,
  readNoteText,
} from "./noteText.js";
import { streamTurn } from "./turn.js";

const idParam = z.object({ id: idSchema });
const projectParam = z.object({ projectId: idSchema });
const noteParam = z.object({ noteId: idSchema });
const listQuery = z.object({ projectId: idSchema.optional() });
const createBody = z.object({
  projectId: idSchema,
  title: z.string().min(1).max(120).optional(),
});
const patchBody = z
  .object({
    title: z.string().min(1).max(120).optional(),
    model: chatModelSchema.optional(),
    reasoning: chatReasoningSchema.optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, "Patch cannot be empty");
const grepQuery = z.object({ q: z.string().min(1).max(200) });
const pollBody = z.object({
  deviceAuthId: z.string().min(1).max(200),
  userCode: z.string().min(1).max(64),
});
const turnBody = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "tool"]),
        parts: z.array(chatPartSchema).min(1),
      }),
    )
    .min(1)
    .max(20),
});

export function registerAiRoutes(app: FastifyInstance, env: AuroraEnv): void {
  const preHandler = requireSessionPreHandler(env);

  app.get("/api/ai/auth/status", { preHandler }, async (request) => {
    const creds = await loadCredentials(request.ownerId!);
    if (creds) {
      return {
        connected: true,
        email: extractEmail(creds.accessToken, creds.idToken),
        mode: "chatgpt" as const,
      };
    }
    if (env.OPENAI_API_KEY) {
      return { connected: true, mode: "api-key" as const };
    }
    return { connected: false, mode: "none" as const };
  });

  app.post("/api/ai/auth/device/start", { preHandler }, async () => {
    return startDeviceAuth();
  });

  app.post("/api/ai/auth/device/poll", { preHandler }, async (request) => {
    const body = pollBody.parse(request.body);
    return pollDeviceAuth(request.ownerId!, body.deviceAuthId, body.userCode);
  });

  app.delete("/api/ai/auth", { preHandler }, async (request, reply) => {
    await deleteCredentials(request.ownerId!);
    return reply.status(204).send();
  });

  app.get("/api/ai/conversations", { preHandler }, async (request) => {
    const { projectId } = listQuery.parse(request.query);
    return {
      conversations: await listConversations(request.ownerId!, projectId),
    };
  });

  app.post("/api/ai/conversations", { preHandler }, async (request) => {
    const body = createBody.parse(request.body);
    return createConversation(request.ownerId!, body.projectId, body.title);
  });

  app.patch("/api/ai/conversations/:id", { preHandler }, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = patchBody.parse(request.body);
    return patchConversation(request.ownerId!, id, body);
  });

  app.delete(
    "/api/ai/conversations/:id",
    { preHandler },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      await deleteConversation(request.ownerId!, id);
      return reply.status(204).send();
    },
  );

  app.get(
    "/api/ai/conversations/:id/messages",
    { preHandler },
    async (request) => {
      const { id } = idParam.parse(request.params);
      return { messages: await listMessages(request.ownerId!, id) };
    },
  );

  app.post(
    "/api/ai/conversations/:id/turn",
    { preHandler, bodyLimit: 8_388_608 },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = turnBody.parse(request.body);
      await streamTurn({
        env,
        ownerId: request.ownerId!,
        conversationId: id,
        incoming: body.messages,
        reply,
      });
    },
  );

  app.get(
    "/api/ai/projects/:projectId/notes",
    { preHandler },
    async (request) => {
      const { projectId } = projectParam.parse(request.params);
      return { notes: await listProjectNotes(request.ownerId!, projectId) };
    },
  );

  app.get("/api/ai/notes/:noteId/text", { preHandler }, async (request) => {
    const { noteId } = noteParam.parse(request.params);
    const projectId = z
      .object({ projectId: idSchema })
      .parse(request.query).projectId;
    return readNoteText(request.ownerId!, projectId, noteId);
  });

  app.get(
    "/api/ai/projects/:projectId/grep",
    { preHandler },
    async (request) => {
      const { projectId } = projectParam.parse(request.params);
      const { q } = grepQuery.parse(request.query);
      return { hits: await grepProjectNotes(request.ownerId!, projectId, q) };
    },
  );
}

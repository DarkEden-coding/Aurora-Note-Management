// Fastify request context augmentation: ownerId and sessionId are set by the session preHandler.
import "@fastify/cookie";
import "@fastify/websocket";

declare module "fastify" {
  interface FastifyRequest {
    ownerId?: string;
    sessionId?: string;
  }
}

// @fastify/cookie and @fastify/websocket decorate FastifyRequest; imports above keep their type
// augmentations loaded for every module in this package that touches sessions or sockets.
export {};

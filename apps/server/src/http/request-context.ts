// Fastify request context augmentation: ownerId is set by the owner preHandler.
import "@fastify/websocket";

declare module "fastify" {
  interface FastifyRequest {
    ownerId?: string;
  }
}

// @fastify/websocket decorates FastifyRequest; the import above keeps its type augmentation
// loaded for every module in this package that touches sockets.
export {};

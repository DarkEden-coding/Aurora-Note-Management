// Owner-scoped WebSocket hub: authenticates handshakes, tracks connections per owner, and broadcasts canvas events.
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import type { ServerEvent } from "@aurora/shared";
import type { AuroraEnv } from "../env.js";
import { requireSession } from "../auth/sessions.js";

export type OwnerBroadcastEvent = ServerEvent;

const connections = new Map<string, Set<WebSocket>>();

function addConnection(ownerId: string, socket: WebSocket): void {
  let sockets = connections.get(ownerId);
  if (!sockets) {
    sockets = new Set<WebSocket>();
    connections.set(ownerId, sockets);
  }
  sockets.add(socket);
}

function removeConnection(ownerId: string, socket: WebSocket): void {
  const sockets = connections.get(ownerId);
  if (!sockets) return;
  sockets.delete(socket);
  if (sockets.size === 0) connections.delete(ownerId);
}

export function connectionCount(ownerId?: string): number {
  if (ownerId) return connections.get(ownerId)?.size ?? 0;
  let total = 0;
  for (const sockets of connections.values()) total += sockets.size;
  return total;
}

export function broadcastToOwner(
  ownerId: string,
  event: OwnerBroadcastEvent,
  exclude?: WebSocket,
): void {
  const sockets = connections.get(ownerId);
  if (!sockets) return;
  for (const socket of sockets) {
    if (socket === exclude) continue;
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(event));
    }
  }
}

// Handshake authentication happens against the signed session cookie; unauthenticated
// upgrades are closed with a 4401 before any owner subscription is registered.
export function registerWsRoutes(app: FastifyInstance, env: AuroraEnv): void {
  app.get(
    "/sync/ws",
    { websocket: true },
    async (socket: WebSocket, request: FastifyRequest) => {
      let ownerId: string;
      try {
        const session = await requireSession(env, request);
        ownerId = session.userId;
      } catch {
        socket.close(4401, "unauthorized");
        return;
      }
      addConnection(ownerId, socket);
      socket.on("close", () => {
        removeConnection(ownerId, socket);
      });
      socket.on("error", () => {
        removeConnection(ownerId, socket);
        socket.close();
      });
    },
  );
}

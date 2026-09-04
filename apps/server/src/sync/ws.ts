// Owner-scoped WebSocket hub: authenticates handshakes, tracks connections per owner, and broadcasts canvas events.
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import type { ServerEvent } from "@aurora/shared";
import type { AuroraEnv } from "../env.js";
import { requireSession } from "../auth/sessions.js";

export type OwnerBroadcastEvent = ServerEvent;

const connections = new Map<string, Set<WebSocket>>();
const HEARTBEAT_INTERVAL_MS = 30_000;

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
      let alive = true;
      const heartbeat = setInterval(() => {
        if (!alive) {
          socket.terminate();
          return;
        }
        alive = false;
        socket.ping();
      }, HEARTBEAT_INTERVAL_MS);
      heartbeat.unref();
      socket.on("pong", () => {
        alive = true;
      });
      const cleanup = (): void => {
        clearInterval(heartbeat);
        removeConnection(ownerId, socket);
      };
      socket.on("close", cleanup);
      socket.on("error", () => {
        cleanup();
        socket.terminate();
      });
    },
  );
}

// Owner-scoped WebSocket hub: authenticates handshakes, tracks connections per owner, and broadcasts canvas events.
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import type { ServerEvent } from "@aurora/shared";
import { resolveOwnerId } from "../account/owner.js";

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

// Cross-site upgrades are rejected by the origin guard before this handler runs; every
// connection that reaches it subscribes to the single owner's broadcasts.
export function registerWsRoutes(app: FastifyInstance): void {
  app.get("/sync/ws", { websocket: true }, async (socket: WebSocket) => {
    let ownerId: string;
    try {
      ownerId = await resolveOwnerId();
    } catch {
      socket.close(1011, "owner unavailable");
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
  });
}

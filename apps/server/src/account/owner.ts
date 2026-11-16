// Resolves Aurora's single owner. Access control lives at the network edge (Tailscale Serve,
// tailnet only), so every request that reaches the server acts as this owner.
import type { FastifyReply, FastifyRequest } from "fastify";
import { withTransaction } from "../db/pool.js";

// Self-hosted Aurora has exactly one owner row. The transaction-scoped lock makes
// the initial read/create sequence atomic across concurrent server processes.
const OWNER_LOCK_KEY = 0x4155524f;

let cachedOwnerId: Promise<string> | null = null;

async function ensureOwner(): Promise<string> {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [OWNER_LOCK_KEY]);
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM users ORDER BY created_at LIMIT 1",
    );
    if (existing.rows[0]) return existing.rows[0].id;
    const created = await client.query<{ id: string }>(
      "INSERT INTO users DEFAULT VALUES RETURNING id",
    );
    return created.rows[0]!.id;
  });
}

// The owner row never changes once created, so one lookup serves the process lifetime.
export function resolveOwnerId(): Promise<string> {
  cachedOwnerId ??= ensureOwner().catch((error: unknown) => {
    cachedOwnerId = null;
    throw error;
  });
  return cachedOwnerId;
}

export function ownerPreHandler() {
  return async (
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> => {
    request.ownerId = await resolveOwnerId();
  };
}

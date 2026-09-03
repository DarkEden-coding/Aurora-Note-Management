// Owns opaque session tokens: creation, secure cookie flags, DB-backed validation, and revocation.
import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { CookieSerializeOptions } from "@fastify/cookie";
import type { AuroraEnv } from "../env.js";
import { unauthorized } from "../errors.js";
import { query } from "../db/pool.js";

export function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function createSessionToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, tokenHash: hashSessionToken(token) };
}

export function sessionCookieOptions(env: AuroraEnv): CookieSerializeOptions {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: new URL(env.AURORA_ORIGIN).protocol === "https:",
    maxAge: env.AURORA_SESSION_TTL_DAYS * 86_400,
  };
}

export type SessionRow = {
  userId: string;
  sessionId: string;
  expiresAt: Date;
};

function readSessionToken(
  request: FastifyRequest,
  env: AuroraEnv,
): string | null {
  const raw = request.cookies[env.AURORA_SESSION_COOKIE_NAME];
  if (!raw) return null;
  const verified = request.unsignCookie(raw);
  if (!verified.valid) return null;
  return verified.value;
}

export async function createSession(
  env: AuroraEnv,
  ownerId: string,
  userAgent?: string,
): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const { token, tokenHash } = createSessionToken();
  const expiresAt = new Date(
    Date.now() + env.AURORA_SESSION_TTL_DAYS * 86_400_000,
  );
  const result = await query<{ id: string }>(
    `INSERT INTO sessions (user_id, token_hash, expires_at, user_agent)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [ownerId, tokenHash, expiresAt, userAgent ?? null],
  );
  return { token, sessionId: result.rows[0]!.id, expiresAt };
}

// Sessions are revoked in the database; the cookie value is only an unverified handle here.
export async function revokeSession(
  env: AuroraEnv,
  request: FastifyRequest,
): Promise<void> {
  const token = readSessionToken(request, env);
  if (!token) return;
  await query(
    "UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL",
    [hashSessionToken(token)],
  );
}

// Validate the signed cookie against the session ledger; expired or revoked sessions are rejected.
export async function requireSession(
  env: AuroraEnv,
  request: FastifyRequest,
): Promise<SessionRow> {
  const token = readSessionToken(request, env);
  if (!token) throw unauthorized();
  const result = await query<SessionRow>(
    `SELECT s.id AS "sessionId", s.user_id AS "userId", s.expires_at AS "expiresAt"
     FROM sessions s
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [hashSessionToken(token)],
  );
  const row = result.rows[0];
  if (!row) throw unauthorized("Session is expired or revoked");
  return row;
}

export async function revokeExpiredSessions(): Promise<number> {
  const result = await query<{ id: string }>(
    "DELETE FROM sessions WHERE expires_at < now() RETURNING id",
  );
  return result.rows.length;
}

export function requireSessionPreHandler(env: AuroraEnv) {
  return async (
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> => {
    const session = await requireSession(env, request);
    request.ownerId = session.userId;
    request.sessionId = session.sessionId;
  };
}

// Fastify request context: ownerId is set by the session preHandler on every owner-scoped route.
declare module "fastify" {
  interface FastifyRequest {
    ownerId?: string;
    sessionId?: string;
  }
  interface FastifyInstance {
    auroraEnv?: AuroraEnv;
  }
}

export function applySessionCookie(
  env: AuroraEnv,
  reply: FastifyReply,
  token: string,
): void {
  reply.setCookie(
    env.AURORA_SESSION_COOKIE_NAME,
    token,
    sessionCookieOptions(env),
  );
}

export function clearSessionCookie(env: AuroraEnv, reply: FastifyReply): void {
  reply.clearCookie(env.AURORA_SESSION_COOKIE_NAME, { path: "/" });
}

// Maps auth flows to public and owner-scoped routes; sessions ride signed HttpOnly cookies.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { themeSchema } from "@aurora/shared";
import type { AuroraEnv } from "../env.js";
import { query } from "../db/pool.js";
import {
  applySessionCookie,
  clearSessionCookie,
  createSession,
  requireSessionPreHandler,
  revokeSession,
} from "./sessions.js";
import {
  bootstrapStatus,
  ensureBootstrapUser,
  issueSetupTokenIfAbsent,
  markEnrolled,
} from "./bootstrap.js";
import {
  enrollWithSetupToken,
  generatePasskeyLoginOptions,
  generatePasskeyRegistrationOptions,
  getBootstrapUser,
  listCredentials,
  loginWithPasskey,
  registerPasskey,
} from "./webauthn.js";

const setupBodySchema = z.object({ setupToken: z.string().min(1).max(512) });
const themeBodySchema = z.object({ theme: themeSchema });
const registerBodySchema = z.object({
  ceremonyId: z.string().uuid(),
  response: z.record(z.string(), z.unknown()),
  name: z.string().max(120).optional(),
});
const loginBodySchema = z.object({
  ceremonyId: z.string().uuid(),
  response: z.record(z.string(), z.unknown()),
});

export function registerAuthRoutes(app: FastifyInstance, env: AuroraEnv): void {
  const preHandler = requireSessionPreHandler(env);

  // Public bootstrap status: only booleans, never token material.
  app.get("/api/auth/bootstrap/status", async () => bootstrapStatus());

  // One-time setup enrollment consumes the token and issues a session.
  app.post("/api/auth/setup/verify", async (request, reply) => {
    const { setupToken } = setupBodySchema.parse(request.body);
    const ownerId = await ensureBootstrapUser();
    await enrollWithSetupToken(ownerId, setupToken);
    const session = await createSession(
      env,
      ownerId,
      request.headers["user-agent"],
    );
    applySessionCookie(env, reply, session.token);
    return { authenticated: true, enrolled: false };
  });

  // Passkey registration requires an authenticated session.
  app.get("/api/auth/passkeys/options", { preHandler }, async (request) => {
    const ownerId = request.ownerId!;
    return generatePasskeyRegistrationOptions(env, ownerId);
  });

  app.post("/api/auth/passkeys", { preHandler }, async (request) => {
    const { ceremonyId, response, name } = registerBodySchema.parse(
      request.body,
    );
    const ownerId = request.ownerId!;
    const result = await registerPasskey(
      env,
      ownerId,
      response,
      name,
      ceremonyId,
    );
    await markEnrolled(ownerId);
    return {
      authenticated: true,
      enrolled: true,
      credentialId: result.credentialId,
    };
  });

  // Login options are public; the bootstrap user owns every allowCredential entry.
  app.get("/api/auth/passkeys/login/options", async () => {
    const ownerId = await getBootstrapUser();
    return generatePasskeyLoginOptions(env, ownerId);
  });

  app.post("/api/auth/passkeys/login", async (request, reply) => {
    const { ceremonyId, response } = loginBodySchema.parse(request.body);
    const ownerId = await getBootstrapUser();
    const result = await loginWithPasskey(env, ownerId, response, ceremonyId);
    const session = await createSession(
      env,
      ownerId,
      request.headers["user-agent"],
    );
    applySessionCookie(env, reply, session.token);
    // A successful passkey authentication implies an enrolled owner.
    await markEnrolled(ownerId);
    return {
      authenticated: true,
      enrolled: true,
      credentialId: result.credentialId,
    };
  });

  app.get("/api/auth/session", { preHandler }, async (request) => {
    const status = await bootstrapStatus();
    const owner = await query<{ theme: string }>(
      "SELECT theme FROM users WHERE id = $1",
      [request.ownerId!],
    );
    const theme = themeSchema.safeParse(owner.rows[0]?.theme);
    return {
      authenticated: true,
      ownerId: request.ownerId,
      sessionId: request.sessionId,
      enrolled: status.enrolled,
      theme: theme.success ? theme.data : "neomorphic",
    };
  });

  // Account-level theme mirror; local-first on the client, converged via session.
  app.patch("/api/account/theme", { preHandler }, async (request) => {
    const { theme } = themeBodySchema.parse(request.body);
    await query("UPDATE users SET theme = $2 WHERE id = $1", [
      request.ownerId!,
      theme,
    ]);
    return { theme };
  });

  app.post("/api/auth/logout", { preHandler }, async (request, reply) => {
    await revokeSession(env, request);
    clearSessionCookie(env, reply);
    return { authenticated: false };
  });
}

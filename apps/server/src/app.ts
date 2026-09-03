// Composes the Fastify instance: config, security plugins, session decorator, domain routes, and error mapping.
// This instance must always run without a live database while type checking; runtime DB use happens in route handlers only.
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import type { AuroraEnv } from "./env.js";
import { registerErrorHandler } from "./errors.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { registerLibraryRoutes } from "./library/routes.js";
import { registerCanvasRoutes } from "./canvas/routes.js";
import { registerSyncRoutes } from "./sync/routes.js";
import { registerWsRoutes } from "./sync/ws.js";
import { registerFileRoutes } from "./files/routes.js";
import { registerSearchRoutes } from "./search/search.js";
import { registerSnapshotRoutes } from "./history/snapshots.js";
import { registerBackupRoutes } from "./backup/export.js";
import "./http/request-context.js";

export type BuildServerOptions = {
  logger?: boolean;
};

// Returns the SPA index.html path when AURORA_WEB_DIST contains a built web app.
function resolveSpaIndexFile(env: AuroraEnv): string | undefined {
  if (!env.AURORA_WEB_DIST) return undefined;
  const indexFile = path.join(env.AURORA_WEB_DIST, "index.html");
  try {
    return fs.existsSync(indexFile) ? indexFile : undefined;
  } catch {
    return undefined;
  }
}

export async function buildServer(
  env: AuroraEnv,
  options: BuildServerOptions = {},
) {
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: true,
    bodyLimit: 1_048_576,
  });
  app.auroraEnv = env;

  await app.register(cookie, { secret: env.AURORA_COOKIE_SECRET });
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "same-origin" },
  });
  await app.register(multipart, {
    limits: {
      fileSize: env.AURORA_MAX_UPLOAD_BYTES,
      files: 1,
      fields: 0,
    },
  });
  await app.register(websocket, {
    options: { maxPayload: 1_048_576 },
  });

  app.get("/readyz", async () => {
    const { checkReadiness } = await import("./index.js");
    const ready = await checkReadiness();
    return { ok: ready, service: "aurora-server" };
  });

  const spaIndexFile = resolveSpaIndexFile(env);
  registerErrorHandler(app, spaIndexFile ? { spaIndexFile } : {});

  // Production single-image mode: serve the built web app next to the API. The
  // SPA fallback lives in the not-found handler; /api and /sync/ws stay JSON.
  if (spaIndexFile) {
    await app.register(fastifyStatic, {
      root: path.dirname(spaIndexFile),
      index: false,
      wildcard: false,
    });
  }

  app.get("/healthz", async () => ({ ok: true, service: "aurora-server" }));

  registerAuthRoutes(app, env);
  registerLibraryRoutes(app, env);
  registerCanvasRoutes(app, env);
  registerSyncRoutes(app, env);
  registerWsRoutes(app, env);
  registerFileRoutes(app, env);
  registerSearchRoutes(app, env);
  registerSnapshotRoutes(app, env);
  registerBackupRoutes(app, env);

  return app;
}

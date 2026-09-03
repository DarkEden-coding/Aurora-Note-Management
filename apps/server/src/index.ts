// Process entry point: validates configuration, prepares bootstrap state, and listens.
// This module must always run without a live database while type checking; runtime DB use is explicit.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, type AuroraEnv } from "./env.js";
import { buildServer } from "./app.js";
import { bootstrapStatus, issueSetupTokenIfAbsent } from "./auth/bootstrap.js";
import { closePool, query } from "./db/pool.js";

// Creates the upload directory and ensures a one-time setup token exists for first enrollment.
async function prepareBootstrapState(env: AuroraEnv): Promise<void> {
  await fs.mkdir(env.AURORA_UPLOAD_DIR, { recursive: true });
  const issued = await issueSetupTokenIfAbsent(env);
  const status = await bootstrapStatus();
  if (!status.enrolled && issued.token) {
    console.log(
      "Aurora setup token (one-time): use it to enroll the first passkey",
    );
    console.log(`Aurora setup token: ${issued.token}`);
  }
}

export async function main(): Promise<void> {
  const env = loadEnv();
  // Apply pending migrations before anything touches the schema (bootstrap user
  // creation requires the users table to exist).
  const { getPool } = await import("./db/pool.js");
  const { runMigrations } = await import("./db/migrate.js");
  const appliedNow = await runMigrations(getPool());
  if (appliedNow.length > 0) {
    console.log(
      `Aurora migrations applied at startup: ${appliedNow.join(", ")}`,
    );
  }
  await prepareBootstrapState(env);
  const app = await buildServer(env, { logger: true });
  await app.ready();
  await app.listen({ host: env.AURORA_HOST, port: env.AURORA_PORT });
  console.log(
    `Aurora server listening on ${env.AURORA_HOST}:${env.AURORA_PORT} (origin ${env.AURORA_ORIGIN})`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`Aurora server shutting down (${signal})`);
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// Readiness probe handler used by the /readyz route; keeps DB use explicit at startup.
export async function checkReadiness(): Promise<boolean> {
  await query("SELECT 1");
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

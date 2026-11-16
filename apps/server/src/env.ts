// Validates Aurora server configuration; fails fast on missing or invalid production settings.
import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  AURORA_HOST: z.string().default("127.0.0.1"),
  AURORA_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  DATABASE_URL: z.string().min(1),
  AURORA_UPLOAD_DIR: z.string().min(1).default(".data/uploads"),
  // Optional directory of the built web app (apps/web/dist); when set, the server
  // serves it statically with an SPA fallback so one image can host web + API.
  AURORA_WEB_DIST: z.string().min(1).optional(),
  AURORA_MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(26_214_400),
  // The browser-visible origin; the origin guard rejects requests from any other site.
  AURORA_ORIGIN: z.string().url(),
  AURORA_LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  // Retention windows (days) for the cleanup job; trash and snapshots follow the 30-day policy.
  AURORA_TRASH_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  AURORA_OPERATION_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  AURORA_SNAPSHOT_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  OPENAI_API_KEY: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
  AURORA_AI_MODEL: z.string().min(1).default("gpt-5.5"),
});

export type AuroraEnv = z.infer<typeof envSchema> & {
  AURORA_UPLOAD_DIR: string;
};
export type EnvSource = Record<string, string | undefined>;

export function loadEnv(source: EnvSource = process.env): AuroraEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid Aurora server environment: ${issues}`);
  }
  const env = parsed.data;
  const origin = new URL(env.AURORA_ORIGIN);
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (
    env.NODE_ENV === "production" &&
    origin.protocol !== "https:" &&
    !localHosts.has(origin.hostname)
  ) {
    throw new Error(
      "Invalid Aurora server environment: production AURORA_ORIGIN must use HTTPS unless it is localhost",
    );
  }
  return {
    ...env,
    AURORA_UPLOAD_DIR: path.resolve(env.AURORA_UPLOAD_DIR),
    ...(env.AURORA_WEB_DIST
      ? { AURORA_WEB_DIST: path.resolve(env.AURORA_WEB_DIST) }
      : {}),
  };
}

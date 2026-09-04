// Manages the one-time setup token: issue, hash persistence, and single-use consumption for enrollment.
import crypto from "node:crypto";
import type { AuroraEnv } from "../env.js";
import { invalid, unauthorized } from "../errors.js";
import { query, withTransaction } from "../db/pool.js";

export function generateSetupToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(24).toString("base64url");
  const tokenHash = crypto
    .createHash("sha256")
    .update(token, "utf8")
    .digest("hex");
  return { token, tokenHash };
}

// Self-hosted Aurora has exactly one owner row. The transaction-scoped lock makes
// the initial read/create sequence atomic across concurrent server processes.
const BOOTSTRAP_USER_LOCK_KEY = 0x4155524f;

export async function ensureBootstrapUser(): Promise<string> {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [
      BOOTSTRAP_USER_LOCK_KEY,
    ]);
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

export type BootstrapStatus = {
  enrolled: boolean;
  hasSetupToken: boolean;
};

export async function bootstrapStatus(): Promise<BootstrapStatus> {
  const result = await query<{
    enrolled_at: Date | null;
    setup_token_hash: string | null;
  }>(
    "SELECT enrolled_at, setup_token_hash FROM users ORDER BY created_at LIMIT 1",
  );
  const row = result.rows[0];
  if (!row) return { enrolled: false, hasSetupToken: false };
  return {
    enrolled: row.enrolled_at !== null,
    hasSetupToken: row.setup_token_hash !== null,
  };
}

// Issue a fresh token only when the owner is not enrolled and no token is stored.
export async function issueSetupTokenIfAbsent(
  env: Pick<AuroraEnv, "AURORA_SETUP_TOKEN">,
): Promise<{ token: string | null; created: boolean }> {
  const ownerId = await ensureBootstrapUser();
  if (env.AURORA_SETUP_TOKEN) {
    const tokenHash = crypto
      .createHash("sha256")
      .update(env.AURORA_SETUP_TOKEN, "utf8")
      .digest("hex");
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE users SET setup_token_hash = $2
         WHERE id = $1 AND enrolled_at IS NULL AND setup_token_hash IS NULL`,
        [ownerId, tokenHash],
      );
    });
    return { token: env.AURORA_SETUP_TOKEN, created: false };
  }
  const status = await bootstrapStatus();
  if (status.enrolled || status.hasSetupToken)
    return { token: null, created: false };
  const { token, tokenHash } = generateSetupToken();
  await query("UPDATE users SET setup_token_hash = $2 WHERE id = $1", [
    ownerId,
    tokenHash,
  ]);
  return { token, created: true };
}

// Issue unconditionally (reset guidance): rotate the stored token hash.
export async function rotateSetupToken(): Promise<string> {
  const ownerId = await ensureBootstrapUser();
  const { token, tokenHash } = generateSetupToken();
  await query(
    "UPDATE users SET setup_token_hash = $2, enrolled_at = CASE WHEN setup_token_hash IS NULL THEN NULL ELSE enrolled_at END WHERE id = $1",
    [ownerId, tokenHash],
  );
  return token;
}

export async function clearSetupToken(ownerId: string): Promise<void> {
  await query("UPDATE users SET setup_token_hash = NULL WHERE id = $1", [
    ownerId,
  ]);
}

// Constant-time comparison of sha256 digests; consumption clears the token atomically so a
// token can be used exactly once even under concurrent requests.
export async function consumeSetupToken(
  ownerId: string,
  token: string,
): Promise<void> {
  const tokenHash = crypto
    .createHash("sha256")
    .update(token, "utf8")
    .digest("hex");
  await withTransaction(async (client) => {
    const stored = await client.query<{
      setup_token_hash: string | null;
    }>("SELECT setup_token_hash FROM users WHERE id = $1 FOR UPDATE", [
      ownerId,
    ]);
    const row = stored.rows[0];
    if (!row) throw unauthorized("Bootstrap user is missing");
    if (!row.setup_token_hash) {
      throw invalid("Setup token was already consumed or never issued");
    }
    const storedHash = Buffer.from(row.setup_token_hash, "hex");
    const incomingHash = Buffer.from(tokenHash, "hex");
    if (
      storedHash.length !== incomingHash.length ||
      !crypto.timingSafeEqual(storedHash, incomingHash)
    ) {
      throw unauthorized("Setup token is invalid");
    }
    await client.query(
      "UPDATE users SET setup_token_hash = NULL WHERE id = $1",
      [ownerId],
    );
  });
}

export async function markEnrolled(ownerId: string): Promise<void> {
  await query(
    "UPDATE users SET enrolled_at = COALESCE(enrolled_at, now()) WHERE id = $1",
    [ownerId],
  );
}

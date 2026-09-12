// Imports an existing Codex CLI ChatGPT login from stdin into Aurora's owner-scoped credential store.
import { z } from "zod";
import { closePool, query } from "../db/pool.js";
import { saveCredentials } from "./oauth.js";

const codexAuthSchema = z.object({
  tokens: z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    id_token: z.string().min(1).optional(),
  }),
});

/** Imports credentials for Aurora's sole enrolled owner without printing secrets. */
async function main(): Promise<void> {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const auth = codexAuthSchema.parse(JSON.parse(input));
  const owners = await query<{ id: string }>(
    "SELECT id FROM users WHERE enrolled_at IS NOT NULL ORDER BY created_at LIMIT 2",
  );
  if (owners.rowCount !== 1) {
    throw new Error(
      `Expected one enrolled Aurora owner, found ${owners.rowCount}`,
    );
  }
  await saveCredentials(owners.rows[0]!.id, {
    access_token: auth.tokens.access_token,
    refresh_token: auth.tokens.refresh_token,
    ...(auth.tokens.id_token ? { id_token: auth.tokens.id_token } : {}),
  });
  process.stdout.write("Imported Codex OAuth credentials into Aurora.\n");
}

void main()
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Credential import failed"}\n`,
    );
    process.exitCode = 1;
  })
  .finally(closePool);

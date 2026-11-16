// Imports an existing Codex CLI ChatGPT login from stdin into Aurora's owner-scoped credential store.
import { z } from "zod";
import { closePool } from "../db/pool.js";
import { resolveOwnerId } from "../account/owner.js";
import { saveCredentials } from "./oauth.js";

const codexAuthSchema = z.object({
  tokens: z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    id_token: z.string().min(1).optional(),
  }),
});

/** Imports credentials for Aurora's single owner without printing secrets. */
async function main(): Promise<void> {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const auth = codexAuthSchema.parse(JSON.parse(input));
  await saveCredentials(await resolveOwnerId(), {
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

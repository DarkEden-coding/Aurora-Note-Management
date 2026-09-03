// Passkey reset guidance: one-time setup token management and enrollment status for lockout recovery.
import { fileURLToPath } from "node:url";
import { query } from "../db/pool.js";
import {
  bootstrapStatus,
  ensureBootstrapUser,
  issueSetupTokenIfAbsent,
  rotateSetupToken,
} from "./bootstrap.js";
import { listCredentials } from "./webauthn.js";

async function printEnrollmentStatus(): Promise<void> {
  const status = await bootstrapStatus();
  console.log(
    `Aurora enrollment status: enrolled=${status.enrolled} hasSetupToken=${status.hasSetupToken}`,
  );
  const ownerId = await ensureBootstrapUser();
  const credentials = await listCredentials(ownerId);
  if (credentials.length === 0) {
    console.log("Aurora passkeys: none enrolled");
  } else {
    for (const credential of credentials) {
      console.log(
        `Aurora passkeys: id=${credential.id} name=${credential.name} counter=${credential.counter}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "status";
  if (command === "status") {
    await printEnrollmentStatus();
    return;
  }
  if (command === "setup-token") {
    await ensureBootstrapUser();
    const issued = await issueSetupTokenIfAbsent({
      AURORA_SETUP_TOKEN: process.env.AURORA_SETUP_TOKEN,
    });
    if (issued.token) {
      console.log(`Aurora setup token (one-time): ${issued.token}`);
      if (issued.created) {
        console.log(
          "Aurora setup token: freshly generated; stored hash replaces nothing",
        );
      } else {
        console.log(
          "Aurora setup token: pre-provisioned value echoed from configuration",
        );
      }
    } else {
      const rotated = await rotateSetupToken();
      console.log(`Aurora setup token (rotated, one-time): ${rotated}`);
    }
    return;
  }
  if (command === "revoke-all") {
    const ownerId = await ensureBootstrapUser();
    await query(
      "UPDATE passkey_credentials SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
      [ownerId],
    );
    console.log(
      "Aurora passkeys: all credentials revoked; rotate the setup token to re-enroll",
    );
    await rotateSetupToken();
    return;
  }
  console.error("Aurora auth reset usage: status | setup-token | revoke-all");
  process.exitCode = 1;
}

// Run directly: connect, execute the reset guidance command, and exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      const { closePool } = await import("../db/pool.js");
      await closePool();
    });
}

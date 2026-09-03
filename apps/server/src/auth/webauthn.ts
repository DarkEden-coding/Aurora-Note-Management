// Implements WebAuthn passkey registration and authentication against Aurora's single owner.
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuroraEnv } from "../env.js";
import { conflict, invalid, unauthorized } from "../errors.js";
import { query, withTransaction } from "../db/pool.js";
import {
  consumeSetupToken,
  ensureBootstrapUser,
  markEnrolled,
} from "./bootstrap.js";

type CredentialRow = {
  id: string;
  user_id: string;
  name: string;
  public_key: Buffer;
  counter: string;
  transports: string[];
  revoked_at: Date | null;
};

// Challenges are independent, short-lived ceremonies. Each options response returns
// an opaque ceremony ID, so concurrent browsers cannot replace one another's challenge.

export async function getBootstrapUser(): Promise<string> {
  return ensureBootstrapUser();
}

export async function storeChallenge(
  ownerId: string,
  challenge: string,
  kind: "registration" | "authentication",
): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO auth_challenges (user_id, kind, challenge)
     VALUES ($1, $2, $3) RETURNING id`,
    [ownerId, kind, challenge],
  );
  return result.rows[0]!.id;
}

async function consumeChallenge(
  ownerId: string,
  ceremonyId: string,
  kind: "registration" | "authentication",
): Promise<string> {
  return withTransaction(async (client) => {
    const result = await client.query<{ challenge: string }>(
      `SELECT challenge FROM auth_challenges
       WHERE id = $1 AND user_id = $2 AND kind = $3
         AND consumed_at IS NULL AND expires_at > now()
       FOR UPDATE`,
      [ceremonyId, ownerId, kind],
    );
    const row = result.rows[0];
    if (!row) {
      throw unauthorized(
        "WebAuthn challenge is missing or expired; request new options",
      );
    }
    await client.query(
      "UPDATE auth_challenges SET consumed_at = now() WHERE id = $1",
      [ceremonyId],
    );
    return row.challenge;
  });
}

export async function listCredentials(
  ownerId: string,
): Promise<CredentialRow[]> {
  const result = await query<CredentialRow>(
    `SELECT id, user_id, name, public_key, counter, transports, revoked_at
     FROM passkey_credentials
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [ownerId],
  );
  return result.rows;
}

export async function generatePasskeyRegistrationOptions(
  env: AuroraEnv,
  ownerId: string,
): Promise<Record<string, unknown>> {
  const credentials = await listCredentials(ownerId);
  const options = await generateRegistrationOptions({
    rpName: env.AURORA_RP_NAME,
    rpID: env.AURORA_RP_ID,
    userID: new TextEncoder().encode(ownerId),
    userName: "aurora-owner",
    attestationType: "none",
    excludeCredentials: credentials.map((credential) => ({
      id: credential.id,
      transports: credential.transports as (
        "usb" | "ble" | "nfc" | "internal" | "hybrid"
      )[],
    })),
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
  });
  const ceremonyId = await storeChallenge(
    ownerId,
    options.challenge,
    "registration",
  );
  return { ceremonyId, options: options as unknown as Record<string, unknown> };
}

type RegistrationResponse = Record<string, unknown>;

export async function registerPasskey(
  env: AuroraEnv,
  ownerId: string,
  response: RegistrationResponse,
  name: string | undefined,
  ceremonyId: string,
): Promise<{ credentialId: string }> {
  const expectedChallenge = await consumeChallenge(
    ownerId,
    ceremonyId,
    "registration",
  );
  const verification = await verifyRegistrationResponse({
    response: response as never,
    expectedChallenge,
    expectedOrigin: env.AURORA_ORIGIN,
    expectedRPID: env.AURORA_RP_ID,
    requireUserVerification: true,
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw invalid("Passkey registration verification failed");
  }
  const credential = verification.registrationInfo.credential;
  const transports = credential.transports ?? [];
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO passkey_credentials (id, user_id, name, public_key, counter, transports)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         public_key = EXCLUDED.public_key,
         counter = GREATEST(passkey_credentials.counter, EXCLUDED.counter),
         transports = EXCLUDED.transports,
         revoked_at = NULL`,
      [
        credential.id,
        ownerId,
        name ?? "passkey",
        Buffer.from(credential.publicKey),
        credential.counter,
        transports,
      ],
    );
  });
  await markEnrolled(ownerId);
  return { credentialId: credential.id };
}

export async function generatePasskeyLoginOptions(
  env: AuroraEnv,
  ownerId: string,
): Promise<Record<string, unknown>> {
  const credentials = await listCredentials(ownerId);
  if (credentials.length === 0) {
    throw conflict(
      "No passkey is enrolled; complete setup token enrollment first",
    );
  }
  const options = await generateAuthenticationOptions({
    rpID: env.AURORA_RP_ID,
    userVerification: "required",
    allowCredentials: credentials.map((credential) => ({
      id: credential.id,
      transports: credential.transports as (
        "usb" | "ble" | "nfc" | "internal" | "hybrid"
      )[],
    })),
  });
  const ceremonyId = await storeChallenge(
    ownerId,
    options.challenge,
    "authentication",
  );
  return { ceremonyId, options: options as unknown as Record<string, unknown> };
}

export async function loginWithPasskey(
  env: AuroraEnv,
  ownerId: string,
  response: RegistrationResponse,
  ceremonyId: string,
): Promise<{ credentialId: string }> {
  const credentialId = (response as { id?: unknown }).id;
  if (typeof credentialId !== "string")
    throw invalid("Passkey response is missing credential id");
  const credentials = await listCredentials(ownerId);
  const credential = credentials.find((row) => row.id === credentialId);
  if (!credential) throw unauthorized("Unknown passkey credential");
  const expectedChallenge = await consumeChallenge(
    ownerId,
    ceremonyId,
    "authentication",
  );
  const verification = await verifyAuthenticationResponse({
    response: response as never,
    expectedChallenge,
    expectedOrigin: env.AURORA_ORIGIN,
    expectedRPID: env.AURORA_RP_ID,
    credential: {
      id: credential.id,
      publicKey: new Uint8Array(credential.public_key),
      counter: Number(credential.counter),
      transports: credential.transports as (
        "usb" | "ble" | "nfc" | "internal" | "hybrid"
      )[],
    },
    requireUserVerification: true,
  });
  if (!verification.verified)
    throw unauthorized("Passkey authentication failed");
  await query(
    `UPDATE passkey_credentials
     SET counter = GREATEST(passkey_credentials.counter, $2), last_used_at = now()
     WHERE id = $1 AND user_id = $3`,
    [credential.id, verification.authenticationInfo.newCounter, ownerId],
  );
  return { credentialId: credential.id };
}

// Setup enrollment consumes the one-time token and creates the session in the same flow.
export async function enrollWithSetupToken(
  ownerId: string,
  setupToken: string,
): Promise<void> {
  await consumeSetupToken(ownerId, setupToken);
}

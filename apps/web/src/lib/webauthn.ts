// This module wraps the browser WebAuthn APIs for Aurora's passkey enrollment and login: it converts base64url server options to ArrayBuffer form and serializes credential responses back to base64url JSON for the server.
// Option/response shapes mirror the WebAuthn JSON serialization the server is
// expected to return; payload validation stays server-side.

export interface PublicKeyCredentialCreationOptionsJSON {
  rp: { id?: string; name: string };
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pubKeyCredParams: { type: "public-key"; alg: number }[];
  timeout?: number;
  excludeCredentials?: { id: string; transports?: string[] }[];
  authenticatorSelection?: {
    residentKey?: "required" | "preferred" | "discouraged";
    userVerification?: "required" | "preferred" | "discouraged";
  };
  attestation?: string;
}

export interface PublicKeyCredentialRequestOptionsJSON {
  challenge: string;
  timeout?: number;
  rpId?: string;
  allowCredentials?: { id: string; transports?: string[] }[];
  userVerification?: "required" | "preferred" | "discouraged";
}

function base64UrlToBuffer(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function bufferToBase64Url(buffer: ArrayBuffer | null): string {
  if (!buffer) return "";
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function webauthnSupported(): boolean {
  return typeof window !== "undefined" && "PublicKeyCredential" in window;
}

export async function createPasskey(
  options: PublicKeyCredentialCreationOptionsJSON,
): Promise<unknown> {
  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: base64UrlToBuffer(options.challenge),
      rp: options.rp,
      user: {
        id: base64UrlToBuffer(options.user.id),
        name: options.user.name,
        displayName: options.user.displayName,
      },
      pubKeyCredParams: options.pubKeyCredParams,
      ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
      ...(options.excludeCredentials
        ? {
            excludeCredentials: options.excludeCredentials.map((c) => ({
              id: base64UrlToBuffer(c.id),
              ...(c.transports
                ? { transports: c.transports as AuthenticatorTransport[] }
                : {}),
              type: "public-key" as const,
            })),
          }
        : {}),
      ...(options.authenticatorSelection
        ? { authenticatorSelection: options.authenticatorSelection }
        : {}),
      attestation:
        (options.attestation as AttestationConveyancePreference) ?? "none",
    },
  })) as PublicKeyCredential | null;

  if (!credential) throw new Error("Passkey creation was cancelled.");
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      attestationObject: bufferToBase64Url(response.attestationObject),
    },
  };
}

export async function assertPasskey(
  options: PublicKeyCredentialRequestOptionsJSON,
): Promise<unknown> {
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: base64UrlToBuffer(options.challenge),
      ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
      ...(options.rpId ? { rpId: options.rpId } : {}),
      ...(options.allowCredentials
        ? {
            allowCredentials: options.allowCredentials.map((c) => ({
              id: base64UrlToBuffer(c.id),
              ...(c.transports
                ? { transports: c.transports as AuthenticatorTransport[] }
                : {}),
              type: "public-key" as const,
            })),
          }
        : {}),
      userVerification:
        (options.userVerification as UserVerificationRequirement) ??
        "preferred",
    },
  })) as PublicKeyCredential | null;

  if (!credential) throw new Error("Passkey login was cancelled.");
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      authenticatorData: bufferToBase64Url(response.authenticatorData),
      signature: bufferToBase64Url(response.signature),
      userHandle: bufferToBase64Url(response.userHandle),
    },
  };
}

// ChatGPT device-code OAuth against auth.openai.com; tokens live in ai_credentials.
import { query } from "../db/pool.js";
import { DomainError, notFound } from "../errors.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const DEVICE_USERCODE = `${ISSUER}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN = `${ISSUER}/api/accounts/deviceauth/token`;
const DEVICE_AUTHORIZE = `${ISSUER}/api/accounts/deviceauth/authorize`;
const TOKEN_URL = `${ISSUER}/oauth/token`;
const DEVICE_REDIRECT = `${ISSUER}/deviceauth/callback`;
const REFRESH_SKEW_MS = 60_000;

export type StoredCredential = {
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  accountId: string | null;
  expiresAt: Date;
};

export type JwtClaims = {
  email?: string;
  chatgpt_account_id?: string;
  organizations?: Array<{ id: string }>;
  "https://api.openai.com/auth"?: { chatgpt_account_id?: string };
  exp?: number;
};

export function parseJwtClaims(token: string): JwtClaims | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    return JSON.parse(
      Buffer.from(payload, "base64url").toString(),
    ) as JwtClaims;
  } catch {
    return undefined;
  }
}

export function jwtExpiryMs(token: string): number | null {
  const exp = parseJwtClaims(token)?.exp;
  return typeof exp === "number" ? exp * 1000 : null;
}

export function extractAccountId(
  accessToken: string,
  idToken: string | null,
): string | undefined {
  for (const token of [idToken, accessToken]) {
    if (!token) continue;
    const claims = parseJwtClaims(token);
    const id =
      claims?.chatgpt_account_id ||
      claims?.["https://api.openai.com/auth"]?.chatgpt_account_id ||
      claims?.organizations?.[0]?.id;
    if (id) return id;
  }
  return undefined;
}

export function extractEmail(
  accessToken: string,
  idToken: string | null,
): string | undefined {
  for (const token of [idToken, accessToken]) {
    if (!token) continue;
    const email = parseJwtClaims(token)?.email;
    if (email) return email;
  }
  return undefined;
}

export type DeviceStart = {
  verificationUrl: string;
  userCode: string;
  deviceAuthId: string;
  interval: number;
};

export async function startDeviceAuth(): Promise<DeviceStart> {
  const response = await fetch(DEVICE_USERCODE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  if (!response.ok) {
    throw new DomainError(
      502,
      "upstream",
      response.status === 403
        ? "OpenAI blocked device login. Retry in your regular browser or from another network."
        : `ChatGPT device login failed to start (${response.status})`,
    );
  }
  const data = (await response.json()) as {
    device_auth_id?: string;
    user_code?: string;
    interval?: string | number;
  };
  if (!data.device_auth_id || !data.user_code) {
    throw new DomainError(
      502,
      "upstream",
      "ChatGPT device login returned no code",
    );
  }
  const interval = Number(data.interval);
  return {
    // Skip /codex/device's extra redirect. Some Chromium clients leave that
    // route as a blank tab instead of following it to the authorization flow.
    verificationUrl: DEVICE_AUTHORIZE,
    userCode: data.user_code,
    deviceAuthId: data.device_auth_id,
    interval: Number.isFinite(interval) && interval > 0 ? interval : 5,
  };
}

type DevicePollResult = { status: "pending" } | { status: "connected" };

export async function pollDeviceAuth(
  ownerId: string,
  deviceAuthId: string,
  userCode: string,
): Promise<DevicePollResult> {
  const response = await fetch(DEVICE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      device_auth_id: deviceAuthId,
      user_code: userCode,
    }),
  });
  if (response.status === 403 || response.status === 404) {
    return { status: "pending" };
  }
  if (!response.ok) {
    throw new DomainError(
      502,
      "upstream",
      `ChatGPT device poll failed (${response.status})`,
    );
  }
  const data = (await response.json()) as {
    authorization_code?: string;
    code_verifier?: string;
  };
  if (!data.authorization_code || !data.code_verifier) {
    return { status: "pending" };
  }
  const tokens = await exchangeAuthorizationCode(
    data.authorization_code,
    data.code_verifier,
  );
  await saveCredentials(ownerId, tokens);
  return { status: "connected" };
}

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_in?: number;
};

async function exchangeAuthorizationCode(
  code: string,
  codeVerifier: string,
): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: DEVICE_REDIRECT,
      client_id: CLIENT_ID,
      code_verifier: codeVerifier,
    }).toString(),
  });
  if (!response.ok) {
    throw new DomainError(
      502,
      "upstream",
      `ChatGPT token exchange failed (${response.status})`,
    );
  }
  return (await response.json()) as TokenResponse;
}

async function refreshTokens(refreshToken: string): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  });
  if (!response.ok) {
    throw new DomainError(
      401,
      "unauthorized",
      "ChatGPT session expired; connect again in settings",
    );
  }
  return (await response.json()) as TokenResponse;
}

function expiresAtFrom(tokens: TokenResponse): Date {
  const jwtMs = jwtExpiryMs(tokens.access_token);
  if (jwtMs) return new Date(jwtMs);
  const seconds = tokens.expires_in ?? 3600;
  return new Date(Date.now() + seconds * 1000);
}

async function saveCredentials(
  ownerId: string,
  tokens: TokenResponse,
): Promise<void> {
  const accountId =
    extractAccountId(tokens.access_token, tokens.id_token ?? null) ?? null;
  const expiresAt = expiresAtFrom(tokens);
  await query(
    `INSERT INTO ai_credentials
       (owner_id, access_token, refresh_token, id_token, account_id, expires_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (owner_id) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       id_token = excluded.id_token,
       account_id = excluded.account_id,
       expires_at = excluded.expires_at,
       updated_at = now()`,
    [
      ownerId,
      tokens.access_token,
      tokens.refresh_token,
      tokens.id_token ?? null,
      accountId,
      expiresAt,
    ],
  );
}

export async function loadCredentials(
  ownerId: string,
): Promise<StoredCredential | null> {
  const result = await query<{
    access_token: string;
    refresh_token: string;
    id_token: string | null;
    account_id: string | null;
    expires_at: Date;
  }>(
    `SELECT access_token, refresh_token, id_token, account_id, expires_at
     FROM ai_credentials WHERE owner_id = $1`,
    [ownerId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    idToken: row.id_token,
    accountId: row.account_id,
    expiresAt: row.expires_at,
  };
}

export async function deleteCredentials(ownerId: string): Promise<void> {
  await query(`DELETE FROM ai_credentials WHERE owner_id = $1`, [ownerId]);
}

const refreshInFlight = new Map<string, Promise<StoredCredential>>();

export async function getValidAccessToken(
  ownerId: string,
): Promise<StoredCredential> {
  const current = await loadCredentials(ownerId);
  if (!current) throw notFound("ChatGPT account");
  if (current.expiresAt.getTime() - REFRESH_SKEW_MS > Date.now())
    return current;
  const existing = refreshInFlight.get(ownerId);
  if (existing) return existing;
  const pending = (async () => {
    const tokens = await refreshTokens(current.refreshToken);
    await saveCredentials(ownerId, tokens);
    const next = await loadCredentials(ownerId);
    if (!next) throw notFound("ChatGPT account");
    return next;
  })().finally(() => {
    refreshInFlight.delete(ownerId);
  });
  refreshInFlight.set(ownerId, pending);
  return pending;
}

// Builds an OpenAI Responses client for ChatGPT Codex OAuth or a platform API key.
import OpenAI from "openai";
import type { AuroraEnv } from "../env.js";
import { DomainError } from "../errors.js";
import {
  getValidAccessToken,
  loadCredentials,
  type StoredCredential,
} from "./oauth.js";

const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

export type AiClient = {
  openai: OpenAI;
  model: string;
  store: boolean;
};

export async function createAiClient(
  env: AuroraEnv,
  ownerId: string,
): Promise<AiClient> {
  const existing = await loadCredentials(ownerId);
  if (existing) {
    const creds = await getValidAccessToken(ownerId);
    return {
      openai: openaiFromChatGpt(creds),
      model: env.AURORA_AI_MODEL,
      store: false,
    };
  }
  if (!env.OPENAI_API_KEY) {
    throw new DomainError(
      401,
      "unauthorized",
      "Connect a ChatGPT account in settings, or set OPENAI_API_KEY",
    );
  }
  return {
    openai: new OpenAI({ apiKey: env.OPENAI_API_KEY }),
    model: env.AURORA_AI_MODEL,
    store: true,
  };
}

function openaiFromChatGpt(creds: StoredCredential): OpenAI {
  const headers: Record<string, string> = {
    "OpenAI-Beta": "responses=experimental",
    // Codex backend rejects unknown originators; this matches the CLI contract.
    originator: "codex_cli_rs",
  };
  if (creds.accountId) headers["ChatGPT-Account-Id"] = creds.accountId;
  return new OpenAI({
    apiKey: creds.accessToken,
    baseURL: CODEX_BASE_URL,
    defaultHeaders: headers,
  });
}

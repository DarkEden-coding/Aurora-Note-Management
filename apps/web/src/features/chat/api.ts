// Chat HTTP helpers: conversation CRUD, device login, note context, and SSE turns.
import type {
  AiAuthStatus,
  ChatConversation,
  ChatMessage,
  ChatModel,
  ChatPart,
  ChatReasoning,
  ChatTurnEvent,
} from "@aurora/shared";
import { api, apiPatch, apiPost } from "../../lib/http.js";

export function getAiAuthStatus(): Promise<AiAuthStatus> {
  return api<AiAuthStatus>("/api/ai/auth/status");
}

export function startDeviceAuth(): Promise<{
  verificationUrl: string;
  userCode: string;
  deviceAuthId: string;
  interval: number;
}> {
  return apiPost("/api/ai/auth/device/start", {});
}

export function pollDeviceAuth(
  deviceAuthId: string,
  userCode: string,
): Promise<{ status: "pending" | "connected" }> {
  return apiPost("/api/ai/auth/device/poll", { deviceAuthId, userCode });
}

export function disconnectAiAuth(): Promise<void> {
  return api("/api/ai/auth", { method: "DELETE" });
}

export function listConversations(
  projectId?: string,
): Promise<{ conversations: ChatConversation[] }> {
  const query = projectId ? `?projectId=${projectId}` : "";
  return api(`/api/ai/conversations${query}`);
}

export function createConversation(
  projectId: string,
  title?: string,
): Promise<ChatConversation> {
  return apiPost("/api/ai/conversations", { projectId, title });
}

export function updateConversation(
  id: string,
  patch: {
    title?: string;
    model?: ChatModel;
    reasoning?: ChatReasoning;
  },
): Promise<ChatConversation> {
  return apiPatch(`/api/ai/conversations/${id}`, patch);
}

export function deleteConversation(id: string): Promise<void> {
  return api(`/api/ai/conversations/${id}`, { method: "DELETE" });
}

export function listMessages(
  conversationId: string,
): Promise<{ messages: ChatMessage[] }> {
  return api(`/api/ai/conversations/${conversationId}/messages`);
}

export type ProjectNoteHit = {
  id: string;
  title: string;
  folderPath: string;
  updatedAt: string;
};

export function listProjectNotes(
  projectId: string,
): Promise<{ notes: ProjectNoteHit[] }> {
  return api(`/api/ai/projects/${projectId}/notes`);
}

export function readNoteText(
  noteId: string,
  projectId: string,
): Promise<{ id: string; title: string; text: string }> {
  return api(`/api/ai/notes/${noteId}/text?projectId=${projectId}`);
}

export function grepProjectNotes(
  projectId: string,
  q: string,
): Promise<{
  hits: Array<{ noteId: string; title: string; snippet: string }>;
}> {
  return api(`/api/ai/projects/${projectId}/grep?q=${encodeURIComponent(q)}`);
}

export async function* streamTurn(
  conversationId: string,
  messages: Array<{ role: "user" | "tool"; parts: ChatPart[] }>,
  signal?: AbortSignal,
): AsyncGenerator<ChatTurnEvent> {
  const response = await fetch(`/api/ai/conversations/${conversationId}/turn`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Turn failed: ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const line = chunk
        .split("\n")
        .find((entry) => entry.startsWith("data: "));
      if (!line) continue;
      yield JSON.parse(line.slice(6)) as ChatTurnEvent;
    }
  }
}

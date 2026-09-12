// Streams one model turn over SSE after persisting incoming user/tool messages.
import { setTimeout as delay } from "node:timers/promises";
import type { FastifyReply } from "fastify";
import type { ChatMessage, ChatPart, ChatTurnEvent } from "@aurora/shared";
import type { AuroraEnv } from "../env.js";
import { getPool } from "../db/pool.js";
import { invalid } from "../errors.js";
import { createAiClient } from "./client.js";
import {
  getConversation,
  insertMessage,
  listMessages,
  patchConversation,
} from "./conversations.js";
import { splitAssistantText } from "./noteText.js";
import { AGENT_INSTRUCTIONS, AGENT_TOOLS } from "./prompt.js";

type ResponseInputItem = Record<string, unknown>;

function textItem(role: "user" | "assistant", text: string): ResponseInputItem {
  return {
    role,
    content: [
      { type: role === "assistant" ? "output_text" : "input_text", text },
    ],
  };
}

export function messagesToInput(messages: ChatMessage[]): ResponseInputItem[] {
  const items: ResponseInputItem[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text = message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      if (text) items.push(textItem("user", text));
      continue;
    }
    if (message.role === "assistant") {
      for (const part of message.parts) {
        if (part.type !== "reasoning") continue;
        items.push({
          type: "reasoning",
          id: part.id,
          encrypted_content: part.encryptedContent,
          summary: part.summary.map((text) => ({ type: "summary_text", text })),
        });
      }
      const text = message.parts
        .map((part) => {
          if (part.type === "text") return part.text;
          if (part.type === "html") return `\`\`\`html\n${part.html}\n\`\`\``;
          return "";
        })
        .filter(Boolean)
        .join("\n");
      if (text) items.push(textItem("assistant", text));
      for (const part of message.parts) {
        if (part.type !== "tool-call") continue;
        items.push({
          type: "function_call",
          call_id: part.callId,
          name: part.name,
          arguments: JSON.stringify(part.arguments),
        });
      }
      continue;
    }
    for (const part of message.parts) {
      if (part.type !== "tool-result") continue;
      items.push({
        type: "function_call_output",
        call_id: part.callId,
        output: part.output,
      });
      if (part.images && part.images.length > 0) {
        items.push({
          role: "user",
          content: [
            { type: "input_text", text: "Screenshot of the tool result:" },
            ...part.images.map((url) => ({
              type: "input_image",
              image_url: url,
              detail: "auto",
            })),
          ],
        });
      }
    }
  }
  return items;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function writeEvent(reply: FastifyReply, event: ChatTurnEvent): void {
  reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

function titleFrom(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.slice(0, 60) || "New chat";
}

/** Returns the last successfully rendered HTML when the model omits html_submit. */
export function latestRenderableHtml(
  history: ChatMessage[],
): { title: string; html: string } | null {
  let candidate: { callId: string; html: string; rendered: boolean } | null =
    null;
  let start = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.role === "user") {
      start = index + 1;
      break;
    }
  }
  for (const message of history.slice(start)) {
    for (const part of message.parts) {
      if (part.type === "tool-call" && part.name === "html_render") {
        candidate = {
          callId: part.callId,
          html:
            typeof part.arguments.html === "string" ? part.arguments.html : "",
          rendered: false,
        };
      }
      if (part.type === "tool-call" && part.name === "html_submit") {
        candidate = null;
      }
      if (
        part.type === "tool-result" &&
        candidate &&
        part.callId === candidate.callId
      ) {
        candidate.rendered = part.output === "rendered";
      }
    }
  }
  return candidate?.rendered && candidate.html
    ? { title: "Visualization", html: candidate.html }
    : null;
}

/** Rejects user interruptions plus missing, duplicate, and replayed tool results. */
export function validateToolContinuation(
  history: ChatMessage[],
  incoming: StreamTurnParams["incoming"],
): void {
  let assistantIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.role === "assistant") {
      assistantIndex = index;
      break;
    }
  }
  const assistant = history[assistantIndex];
  const pending = new Set(
    assistant?.parts
      .filter((part) => part.type === "tool-call")
      .map((part) => part.callId) ?? [],
  );
  for (const message of history.slice(assistantIndex + 1)) {
    for (const part of message.parts) {
      if (part.type === "tool-result") pending.delete(part.callId);
    }
  }

  const message = incoming[0];
  if (message?.role !== "tool") {
    if (pending.size > 0) {
      throw invalid("Finish the pending tool request before sending a message");
    }
    return;
  }
  for (const part of message.parts) {
    if (part.type !== "tool-result" || !pending.delete(part.callId)) {
      throw invalid("Tool results do not match the latest assistant request");
    }
  }
  if (pending.size > 0) {
    throw invalid("Tool results do not match the latest assistant request");
  }
}

type StreamTurnParams = {
  env: AuroraEnv;
  ownerId: string;
  conversationId: string;
  incoming: Array<{ role: "user" | "tool"; parts: ChatPart[] }>;
  reply: FastifyReply;
  signal?: AbortSignal;
};

async function runTurn(params: StreamTurnParams): Promise<void> {
  const conversation = await getConversation(
    params.ownerId,
    params.conversationId,
  );
  const { openai, model, store } = await createAiClient(
    params.env,
    params.ownerId,
    conversation.model,
  );
  const prior = await listMessages(params.ownerId, params.conversationId);
  const priorCount = prior.length;
  validateToolContinuation(prior, params.incoming);
  const inserted: ChatMessage[] = [];
  for (const message of params.incoming) {
    inserted.push(
      await insertMessage(
        params.ownerId,
        params.conversationId,
        message.role,
        message.parts,
      ),
    );
  }
  if (priorCount === 0) {
    const first = params.incoming[0];
    const text = first?.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(" ");
    if (text) {
      await patchConversation(params.ownerId, params.conversationId, {
        title: titleFrom(text),
      });
    }
  }

  const history = [...prior, ...inserted];
  const projectLine = `Current project id: ${conversation.projectId}`;

  params.reply.hijack();
  params.reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  try {
    const stream = await openai.responses.create(
      {
        model,
        instructions: `${AGENT_INSTRUCTIONS}\n${projectLine}`,
        input: messagesToInput(history) as never,
        tools: AGENT_TOOLS as never,
        stream: true,
        store,
        reasoning: { effort: conversation.reasoning },
        prompt_cache_key: conversation.id,
        ...(!store
          ? { include: ["reasoning.encrypted_content" as const] }
          : {}),
      },
      params.signal ? { signal: params.signal } : undefined,
    );

    let text = "";
    const reasoning: ChatPart[] = [];
    const toolCalls: Array<{
      callId: string;
      name: string;
      arguments: Record<string, unknown>;
    }> = [];

    for await (const event of stream) {
      if (event.type === "response.output_text.delta") {
        text += event.delta;
        writeEvent(params.reply, { type: "text-delta", delta: event.delta });
      }
      if (event.type === "response.output_item.done") {
        const item = event.item;
        if (item.type === "reasoning" && item.encrypted_content) {
          reasoning.push({
            type: "reasoning",
            id: item.id,
            encryptedContent: item.encrypted_content,
            summary: item.summary.map((entry) => entry.text),
          });
        }
        if (item.type === "function_call") {
          const parsed = {
            callId: item.call_id,
            name: item.name,
            arguments: parseArgs(item.arguments),
          };
          toolCalls.push(parsed);
          writeEvent(params.reply, {
            type: "tool-call",
            callId: parsed.callId,
            name: parsed.name,
            arguments: parsed.arguments,
          });
        }
      }
    }

    const parts: ChatPart[] = [...reasoning];
    parts.push(...splitAssistantText(text));
    for (const call of toolCalls) {
      parts.push({
        type: "tool-call",
        callId: call.callId,
        name: call.name,
        arguments: call.arguments,
      });
      if (call.name === "html_submit") {
        const title =
          typeof call.arguments.title === "string"
            ? call.arguments.title
            : "Visualization";
        const html =
          typeof call.arguments.html === "string" ? call.arguments.html : "";
        if (html) parts.push({ type: "html", title, html });
      }
    }
    if (toolCalls.length === 0 && !parts.some((part) => part.type === "html")) {
      const fallback = latestRenderableHtml(history);
      if (fallback) parts.push({ type: "html", ...fallback });
    }
    if (parts.length === 0) {
      parts.push({ type: "text", text: "" });
    }

    const message = await insertMessage(
      params.ownerId,
      params.conversationId,
      "assistant",
      parts,
    );
    writeEvent(params.reply, { type: "done", message });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The model request failed";
    writeEvent(params.reply, { type: "error", message });
  } finally {
    params.reply.raw.end();
  }
}

/** Serializes model turns so one conversation cannot interleave its history. */
export async function streamTurn(params: StreamTurnParams): Promise<void> {
  const client = await getPool().connect();
  let lockHeld = false;
  try {
    while (!lockHeld) {
      params.signal?.throwIfAborted();
      const result = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 1096110671)) AS locked",
        [params.conversationId],
      );
      lockHeld = result.rows[0]?.locked ?? false;
      if (!lockHeld) {
        await delay(
          100,
          undefined,
          params.signal ? { signal: params.signal } : undefined,
        );
      }
    }
    params.signal?.throwIfAborted();
    await runTurn(params);
  } finally {
    try {
      if (lockHeld) {
        await client.query(
          "SELECT pg_advisory_unlock(hashtextextended($1, 1096110671))",
          [params.conversationId],
        );
      }
    } finally {
      client.release();
    }
  }
}

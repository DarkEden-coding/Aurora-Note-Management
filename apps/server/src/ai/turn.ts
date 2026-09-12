// Streams one model turn over SSE after persisting incoming user/tool messages.
import type { FastifyReply } from "fastify";
import type { ChatMessage, ChatPart, ChatTurnEvent } from "@aurora/shared";
import type { AuroraEnv } from "../env.js";
import { createAiClient } from "./client.js";
import {
  countMessages,
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

export async function streamTurn(params: {
  env: AuroraEnv;
  ownerId: string;
  conversationId: string;
  incoming: Array<{ role: "user" | "tool"; parts: ChatPart[] }>;
  reply: FastifyReply;
}): Promise<void> {
  const conversation = await getConversation(
    params.ownerId,
    params.conversationId,
  );
  const priorCount = await countMessages(params.ownerId, params.conversationId);
  for (const message of params.incoming) {
    await insertMessage(
      params.ownerId,
      params.conversationId,
      message.role,
      message.parts,
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

  const history = await listMessages(params.ownerId, params.conversationId);
  const { openai, model, store } = await createAiClient(
    params.env,
    params.ownerId,
    conversation.model,
  );
  const projectLine = `Current project id: ${conversation.projectId}`;

  params.reply.hijack();
  params.reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  try {
    const stream = await openai.responses.create({
      model,
      instructions: `${AGENT_INSTRUCTIONS}\n${projectLine}`,
      input: messagesToInput(history) as never,
      tools: AGENT_TOOLS as never,
      stream: true,
      store,
      reasoning: { effort: conversation.reasoning },
    });

    let text = "";
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

    const parts: ChatPart[] = [];
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

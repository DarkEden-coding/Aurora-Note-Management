// Regressions for stateless reasoning continuity and stable prompt caching.
import fs from "node:fs";
import { expect, it } from "vitest";
import type { ChatMessage } from "@aurora/shared";
import {
  latestRenderableHtml,
  messagesToInput,
  pendingToolCallIds,
  validateToolContinuation,
} from "../src/ai/turn.js";

it("replays encrypted reasoning before assistant output and tool calls", () => {
  const message: ChatMessage = {
    id: "123e4567-e89b-42d3-a456-426614174000",
    conversationId: "223e4567-e89b-42d3-a456-426614174000",
    role: "assistant",
    parts: [
      {
        type: "reasoning",
        id: "reasoning-1",
        encryptedContent: "encrypted",
        summary: ["Checked the notes"],
      },
      { type: "text", text: "Result" },
      {
        type: "tool-call",
        callId: "call-1",
        name: "read_note",
        arguments: { noteId: "323e4567-e89b-42d3-a456-426614174000" },
      },
    ],
    createdAt: new Date().toISOString(),
  };

  expect(messagesToInput([message])).toEqual([
    {
      type: "reasoning",
      id: "reasoning-1",
      encrypted_content: "encrypted",
      summary: [{ type: "summary_text", text: "Checked the notes" }],
    },
    {
      role: "assistant",
      content: [{ type: "output_text", text: "Result" }],
    },
    {
      type: "function_call",
      call_id: "call-1",
      name: "read_note",
      arguments: '{"noteId":"323e4567-e89b-42d3-a456-426614174000"}',
    },
  ]);
});

it("detects interrupted tools and rejects replayed results", () => {
  const assistant: ChatMessage = {
    id: "123e4567-e89b-42d3-a456-426614174000",
    conversationId: "223e4567-e89b-42d3-a456-426614174000",
    role: "assistant",
    parts: [
      {
        type: "tool-call",
        callId: "call-1",
        name: "list_notes",
        arguments: {},
      },
    ],
    createdAt: new Date().toISOString(),
  };
  const result: ChatMessage = {
    ...assistant,
    id: "323e4567-e89b-42d3-a456-426614174000",
    role: "tool",
    parts: [{ type: "tool-result", callId: "call-1", output: "[]" }],
  };

  expect(pendingToolCallIds([assistant])).toEqual(["call-1"]);
  expect(pendingToolCallIds([assistant, result])).toEqual([]);
  expect(() =>
    validateToolContinuation(
      [assistant, result],
      [
        {
          role: "tool",
          parts: [{ type: "tool-result", callId: "call-1", output: "[]" }],
        },
      ],
    ),
  ).toThrow("Tool results do not match");
});

it("recovers the last rendered HTML when the model omits submit", () => {
  const base = {
    conversationId: "223e4567-e89b-42d3-a456-426614174000",
    createdAt: new Date().toISOString(),
  };
  const history: ChatMessage[] = [
    {
      ...base,
      id: "123e4567-e89b-42d3-a456-426614174000",
      role: "user",
      parts: [{ type: "text", text: "Show me" }],
    },
    {
      ...base,
      id: "323e4567-e89b-42d3-a456-426614174000",
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          callId: "render-1",
          name: "html_render",
          arguments: { html: "<main>Visible</main>" },
        },
      ],
    },
    {
      ...base,
      id: "423e4567-e89b-42d3-a456-426614174000",
      role: "tool",
      parts: [{ type: "tool-result", callId: "render-1", output: "rendered" }],
    },
  ];

  expect(latestRenderableHtml(history)).toEqual({
    title: "Visualization",
    html: "<main>Visible</main>",
  });
  history[2]!.parts = [
    { type: "tool-result", callId: "render-1", output: "errors: broken" },
  ];
  expect(latestRenderableHtml(history)).toEqual({
    title: "Visualization",
    html: "<main>Visible</main>",
  });
  expect(latestRenderableHtml(history.slice(0, 2))).toBeNull();
});

it("uses a conversation cache key and serializes turns", () => {
  const source = fs.readFileSync(
    new URL("../src/ai/turn.ts", import.meta.url),
    "utf8",
  );
  expect(source).toContain("prompt_cache_key: conversation.id");
  expect(source).toContain('include: ["reasoning.encrypted_content" as const]');
  expect(source).toContain("pg_try_advisory_lock");
});

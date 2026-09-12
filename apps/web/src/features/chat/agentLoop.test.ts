// Verifies that browser-side tools report their live execution states in order.
import { beforeEach, expect, it, vi } from "vitest";
import type { ChatTurnEvent } from "@aurora/shared";
import { runAgentTurn, type ToolProgress } from "./agentLoop.js";

const api = vi.hoisted(() => ({
  streamTurn: vi.fn(),
  listProjectNotes: vi.fn(),
}));

vi.mock("./api.js", () => api);
vi.mock("./noteSnapshot.js", () => ({ screenshotNote: vi.fn() }));

async function* events(items: ChatTurnEvent[]): AsyncGenerator<ChatTurnEvent> {
  yield* items;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listProjectNotes.mockResolvedValue({ notes: [] });
});

it("reports queued, running, and completed states for a tool call", async () => {
  const call = {
    type: "tool-call" as const,
    callId: "call-1",
    name: "list_notes",
    arguments: {},
  };
  api.streamTurn
    .mockReturnValueOnce(
      events([
        call,
        {
          type: "done",
          message: {
            id: "assistant-1",
            conversationId: "conversation-1",
            role: "assistant",
            parts: [call],
            createdAt: new Date().toISOString(),
          },
        },
      ]),
    )
    .mockReturnValueOnce(
      events([
        {
          type: "done",
          message: {
            id: "assistant-2",
            conversationId: "conversation-1",
            role: "assistant",
            parts: [{ type: "text", text: "Done" }],
            createdAt: new Date().toISOString(),
          },
        },
      ]),
    );

  const progress: ToolProgress[] = [];
  await runAgentTurn({
    conversationId: "conversation-1",
    projectId: "project-1",
    incoming: [{ role: "user", parts: [{ type: "text", text: "List notes" }] }],
    workbench: { render: vi.fn(), act: vi.fn(), html: vi.fn() },
    handlers: {
      onTextDelta: vi.fn(),
      onAssistant: vi.fn(),
      onToolProgress: (update) => progress.push(update),
      onError: vi.fn(),
    },
  });

  expect(progress.map(({ status }) => status)).toEqual([
    "queued",
    "running",
    "completed",
  ]);
  expect(api.listProjectNotes).toHaveBeenCalledWith("project-1", undefined);
});

it("reports tool failures without stopping the model continuation", async () => {
  const call = {
    type: "tool-call" as const,
    callId: "call-1",
    name: "list_notes",
    arguments: {},
  };
  api.listProjectNotes.mockRejectedValue(new Error("Notes unavailable"));
  api.streamTurn
    .mockReturnValueOnce(
      events([
        call,
        {
          type: "done",
          message: {
            id: "assistant-1",
            conversationId: "conversation-1",
            role: "assistant",
            parts: [call],
            createdAt: new Date().toISOString(),
          },
        },
      ]),
    )
    .mockReturnValueOnce(
      events([
        {
          type: "done",
          message: {
            id: "assistant-2",
            conversationId: "conversation-1",
            role: "assistant",
            parts: [{ type: "text", text: "Could not list notes" }],
            createdAt: new Date().toISOString(),
          },
        },
      ]),
    );

  const progress: ToolProgress[] = [];
  await runAgentTurn({
    conversationId: "conversation-1",
    projectId: "project-1",
    incoming: [{ role: "user", parts: [{ type: "text", text: "List notes" }] }],
    workbench: { render: vi.fn(), act: vi.fn(), html: vi.fn() },
    handlers: {
      onTextDelta: vi.fn(),
      onAssistant: vi.fn(),
      onToolProgress: (update) => progress.push(update),
      onError: vi.fn(),
    },
  });

  expect(progress.at(-1)?.status).toBe("failed");
  expect(api.streamTurn).toHaveBeenCalledTimes(2);
});

it("does not start an aborted turn", async () => {
  const controller = new AbortController();
  controller.abort();

  await expect(
    runAgentTurn({
      conversationId: "conversation-1",
      projectId: "project-1",
      incoming: [{ role: "user", parts: [{ type: "text", text: "Hello" }] }],
      workbench: { render: vi.fn(), act: vi.fn(), html: vi.fn() },
      signal: controller.signal,
      handlers: {
        onTextDelta: vi.fn(),
        onAssistant: vi.fn(),
        onToolProgress: vi.fn(),
        onError: vi.fn(),
      },
    }),
  ).rejects.toHaveProperty("name", "AbortError");
  expect(api.streamTurn).not.toHaveBeenCalled();
});

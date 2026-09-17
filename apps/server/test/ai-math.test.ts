import { afterAll, beforeEach, expect, it, vi } from "vitest";
import type { FastifyReply } from "fastify";
import type { MathSolveEvent } from "@aurora/shared";
import { mathSolveRequestSchema } from "@aurora/shared";
import type { AuroraEnv } from "../src/env.js";
import { streamMathSolve } from "../src/ai/math.js";

const { create, python } = vi.hoisted(() => ({
  create: vi.fn(),
  python: vi.fn(),
}));
const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
vi.mock("../src/ai/client.js", () => ({
  createAiClient: async () => ({
    openai: { responses: { create } },
    model: "gpt-5.6-luna",
    store: false,
  }),
}));
vi.mock("../src/ai/python.js", () => ({ runPython: python }));

beforeEach(() => {
  create.mockReset();
  python.mockReset();
  errorLog.mockClear();
});

afterAll(() => errorLog.mockRestore());

function completion(output: unknown[]): AsyncGenerator<unknown> {
  return (async function* () {
    yield { type: "response.completed", response: { output } };
  })();
}
function message(text: string): unknown {
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
  };
}
function tool(name: string, args: unknown): unknown {
  return {
    type: "function_call",
    name,
    call_id: "call-1",
    arguments: JSON.stringify(args),
  };
}
async function solve(
  clarifications: Array<{ question: string; answer: string }> = [],
): Promise<MathSolveEvent[]> {
  const events: MathSolveEvent[] = [];
  const reply = {
    hijack: vi.fn(),
    raw: {
      writeHead: vi.fn(),
      write: (chunk: string) => {
        events.push(JSON.parse(chunk.slice(6)) as MathSolveEvent);
      },
      end: vi.fn(),
    },
  } as unknown as FastifyReply;
  await streamMathSolve(
    {} as AuroraEnv,
    "owner",
    {
      image: "data:image/png;base64,AAAA",
      clarifications,
    },
    reply,
    new AbortController().signal,
  );
  expect(reply.raw.end).toHaveBeenCalledOnce();
  return events;
}

it("pauses for separate uncertainty questions without leaking a premature answer", async () => {
  const questions = [
    { id: "a", question: "Is the numerator 3 or 8?", suggestedAnswer: "3" },
    { id: "b", question: "Is the exponent negative?", suggestedAnswer: "-2" },
  ];
  create.mockResolvedValueOnce(
    completion([
      message("Premature answer"),
      tool("ask_questions", { questions }),
    ]),
  );
  const events = await solve();
  expect(events).toEqual([
    { type: "reasoning-done" },
    { type: "questions", questions },
    { type: "done" },
  ]);
  expect(python).not.toHaveBeenCalled();
  expect(create.mock.calls[0]![0].reasoning.effort).toBe("medium");
});

it("uses clarified values, runs Python, and passes its result and encrypted reasoning to the final turn", async () => {
  const reasoning = {
    type: "reasoning",
    id: "r1",
    encrypted_content: "opaque",
    summary: [],
  };
  create.mockResolvedValueOnce(
    completion([reasoning, tool("run_python", { code: "print(8 ** -2)" })]),
  );
  create.mockResolvedValueOnce(
    completion([message("Question: $8^{-2}$\nAnswer: $1/64$")]),
  );
  python.mockResolvedValueOnce({ success: true, output: "0.015625\n" });
  const events = await solve([
    { question: "Is the numerator 3 or 8?", answer: "8" },
  ]);
  expect(python).toHaveBeenCalledWith(
    "print(8 ** -2)",
    expect.any(AbortSignal),
  );
  expect(events.map((event) => event.type)).toEqual([
    "reasoning-done",
    "python-start",
    "python-result",
    "reasoning-done",
    "text-delta",
    "done",
  ]);
  const request = create.mock.calls[1]![0];
  expect(request.input[0].content[0].text).toContain('"answer":"8"');
  expect(request.input).toContainEqual(reasoning);
  expect(request.input).toContainEqual({
    type: "function_call_output",
    call_id: "call-1",
    output: JSON.stringify({ success: true, output: "0.015625\n" }),
  });
  expect(request.include).toEqual(["reasoning.encrypted_content"]);
});

it("continues a reasoning-only completion to get the final answer", async () => {
  const reasoning = {
    type: "reasoning",
    id: "r1",
    encrypted_content: "opaque",
    summary: [],
  };
  create.mockResolvedValueOnce(completion([reasoning]));
  create.mockResolvedValueOnce(completion([message("Answer: $\u221a2$")]));

  expect(await solve()).toContainEqual({
    type: "text-delta",
    delta: "Answer: $\u221a2$",
  });
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[1]![0].input).toContainEqual(reasoning);
  expect(create.mock.calls[1]![0].input).toContainEqual({
    role: "user",
    content: "Give the final solution now. Do not provide reasoning only.",
  });
});

it("allows simple answers without Python", async () => {
  create.mockResolvedValueOnce(completion([message("Answer: 4")]));
  expect(await solve()).toContainEqual({
    type: "text-delta",
    delta: "Answer: 4",
  });
  expect(python).not.toHaveBeenCalled();
});

it.each([
  ["without a completion event", false],
  ["with an empty completed output", true],
])(
  "uses streamed answer text %s without retrying",
  async (_label, completed) => {
    create.mockResolvedValueOnce(
      (async function* () {
        yield { type: "response.output_text.delta", delta: "Answer: " };
        yield { type: "response.output_text.delta", delta: "4" };
        if (completed)
          yield { type: "response.completed", response: { output: [] } };
      })(),
    );

    expect(await solve()).toContainEqual({
      type: "text-delta",
      delta: "Answer: 4",
    });
    expect(create).toHaveBeenCalledTimes(1);
  },
);

it("logs stream failures without request contents", async () => {
  create.mockResolvedValueOnce(
    (async function* () {
      yield { type: "response.created" };
    })(),
  );

  expect(await solve()).toEqual([
    { type: "error", message: expect.stringContaining("before completion") },
  ]);
  expect(errorLog).toHaveBeenCalledWith(
    "Math solver failed",
    expect.objectContaining({
      turn: 1,
      receivedCompletion: false,
      streamedTextLength: 0,
    }),
  );
  expect(JSON.stringify(errorLog.mock.calls)).not.toContain("base64");
});

it("reports Python failures as tool results and bounds repeated execution", async () => {
  create.mockImplementation(async () =>
    completion([tool("run_python", { code: "print(1)" })]),
  );
  python.mockRejectedValue(new Error("Python runtime unavailable"));
  const events = await solve();
  expect(python).toHaveBeenCalledTimes(3);
  expect(create).toHaveBeenCalledTimes(4);
  expect(events).toContainEqual({
    type: "python-result",
    success: false,
    output: "Python runtime unavailable",
  });
  expect(events.at(-1)?.type).toBe("error");
  expect(events.some((event) => event.type === "text-delta")).toBe(false);
});

it("validates clarification input and rejects malformed model questions", async () => {
  expect(() =>
    mathSolveRequestSchema.parse({
      image: "data:image/png;base64,AAAA",
      clarifications: [{ question: "Value?", answer: "  " }],
    }),
  ).toThrow();
  create.mockResolvedValueOnce(
    completion([tool("ask_questions", { questions: [] })]),
  );
  expect((await solve()).at(-1)?.type).toBe("error");
});

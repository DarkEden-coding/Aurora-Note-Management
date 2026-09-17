import { afterEach, describe, expect, it, vi } from "vitest";
import {
  expandResultRegion,
  normalizeRegion,
  streamMathSolution,
} from "./mathSolver";

const originalFetch = globalThis.fetch;
const request = { image: "data:image/png;base64,test" };

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("normalizeRegion", () => {
  it("normalizes a reverse drag and clamps it to the viewport", () => {
    expect(
      normalizeRegion({ x: 90, y: 80 }, { x: -10, y: 20 }, 70, 60),
    ).toEqual({ x: 0, y: 20, width: 70, height: 40 });
  });
});

describe("expandResultRegion", () => {
  it("centers the expanded result and keeps it inside the viewport", () => {
    expect(
      expandResultRegion({ x: 700, y: 500, width: 100, height: 50 }, 800, 600),
    ).toEqual({ x: 168, y: 248, width: 620, height: 340 });
  });
});

describe("streamMathSolution", () => {
  it("posts cumulative clarifications and parses split stream chunks", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"questions","questions":[{"id":"one","question":"Is that 3?","suggestedAnswer":"3"}]}\n\n',
          ),
        );
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"text-delta","delta":"Answer',
          ),
        );
        controller.enqueue(
          new TextEncoder().encode(': 4"}\n\ndata: {"type":"done"}\n\n'),
        );
        controller.close();
      },
    });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(stream, { status: 200 }));

    const events = [];
    for await (const event of streamMathSolution({
      ...request,
      clarifications: [{ question: "Is that 3?", answer: "3" }],
    }))
      events.push(event);
    expect(events).toEqual([
      {
        type: "questions",
        questions: [
          { id: "one", question: "Is that 3?", suggestedAnswer: "3" },
        ],
      },
      { type: "text-delta", delta: "Answer: 4" },
      { type: "done" },
    ]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/ai/math/solve",
      expect.objectContaining({
        body: JSON.stringify({
          ...request,
          clarifications: [{ question: "Is that 3?", answer: "3" }],
        }),
      }),
    );
  });

  it("reports server errors and truncated streams", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message: "ChatGPT session expired; connect again in settings",
            },
          }),
          { status: 401 },
        ),
      );
    const read = async (): Promise<void> => {
      for await (const _event of streamMathSolution(request)) {
        /* no events */
      }
    };
    await expect(read()).rejects.toThrow(
      "ChatGPT session expired; connect again in settings",
    );

    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response('data: {"type":"text-delta","delta":"partial"}\n\n', {
          status: 200,
        }),
      );
    await expect(read()).rejects.toThrow("truncated");
  });
});

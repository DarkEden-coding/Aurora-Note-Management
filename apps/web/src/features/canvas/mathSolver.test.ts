import { afterEach, describe, expect, it, vi } from "vitest";
import {
  expandResultRegion,
  normalizeRegion,
  streamMathSolution,
} from "./mathSolver";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("normalizeRegion", () => {
  it("normalizes a reverse drag and clamps it to the viewport", () => {
    expect(
      normalizeRegion({ x: 90, y: 80 }, { x: -10, y: 20 }, 70, 60),
    ).toEqual({
      x: 0,
      y: 20,
      width: 70,
      height: 40,
    });
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
  it("streams reasoning and answer events", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          [
            'data: {"type":"reasoning-delta","delta":"Check"}',
            'data: {"type":"reasoning-done"}',
            'data: {"type":"text-delta","delta":"Answer: 4"}',
            'data: {"type":"done"}',
            "",
          ].join("\n\n"),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      );

    const events = [];
    for await (const event of streamMathSolution(
      "data:image/png;base64,test",
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "reasoning-delta", delta: "Check" },
      { type: "reasoning-done" },
      { type: "text-delta", delta: "Answer: 4" },
      { type: "done" },
    ]);
  });

  it("shows the server's actionable authentication error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: "ChatGPT session expired; connect again in settings",
          },
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    );

    const read = async (): Promise<void> => {
      for await (const _event of streamMathSolution(
        "data:image/png;base64,test",
      )) {
        // No events are expected for an HTTP error.
      }
    };
    await expect(read()).rejects.toThrow(
      "ChatGPT session expired; connect again in settings",
    );
  });
});

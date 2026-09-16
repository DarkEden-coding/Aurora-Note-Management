import { afterEach, describe, expect, it, vi } from "vitest";
import {
  expandResultRegion,
  normalizeRegion,
  solveMathImage,
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

describe("solveMathImage", () => {
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

    await expect(solveMathImage("data:image/png;base64,test")).rejects.toThrow(
      "ChatGPT session expired; connect again in settings",
    );
  });
});

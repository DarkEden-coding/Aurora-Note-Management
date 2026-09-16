import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeRegion, solveMathImage } from "./mathSolver";

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

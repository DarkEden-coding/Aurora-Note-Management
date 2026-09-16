import { describe, expect, it } from "vitest";
import { normalizeRegion } from "./mathSolver";

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

import { describe, expect, it } from "vitest";
import { PALM_REJECTION_WINDOW_MS, shouldRejectTouch } from "./pointerInput";

describe("stylus palm rejection", () => {
  it("rejects only touch contacts close to stylus activity", () => {
    expect(shouldRejectTouch("touch", 1_100, 1_000)).toBe(true);
    expect(
      shouldRejectTouch("touch", 1_000 + PALM_REJECTION_WINDOW_MS + 1, 1_000),
    ).toBe(false);
    expect(shouldRejectTouch("pen", 1_100, 1_000)).toBe(false);
    expect(shouldRejectTouch("mouse", 1_100, 1_000)).toBe(false);
  });
});

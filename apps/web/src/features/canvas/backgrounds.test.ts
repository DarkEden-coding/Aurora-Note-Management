// Focused tests for background presentation styles: pattern coverage and viewport-anchored offsets.
import { describe, expect, it } from "vitest";
import type { Background, Viewport } from "@aurora/shared";
import { DEFAULT_BACKGROUND, getBackgroundStyle } from "./backgrounds";

const VIEWPORT: Viewport = { x: 40, y: 20, width: 800, height: 600, zoom: 2 };

describe("getBackgroundStyle", () => {
  it("defaults to a dot grid", () => {
    expect(DEFAULT_BACKGROUND.pattern).toBe("dot-grid");
  });

  it("renders solid and blank as plain color", () => {
    const bg: Background = { ...DEFAULT_BACKGROUND, pattern: "solid" };
    expect(getBackgroundStyle(bg, VIEWPORT)).toEqual({
      backgroundColor: bg.color,
    });
    const blank: Background = { ...DEFAULT_BACKGROUND, pattern: "blank" };
    expect(getBackgroundStyle(blank, VIEWPORT)).toEqual({
      backgroundColor: blank.color,
    });
  });

  it("anchors pattern offsets to the world origin under the viewport transform", () => {
    const bg: Background = {
      ...DEFAULT_BACKGROUND,
      pattern: "ruled",
      spacing: 16,
    };
    const style = getBackgroundStyle(bg, VIEWPORT);
    expect(style.backgroundPosition).toBe("-80px -40px");
    expect(style.backgroundSize).toBe("32px 32px");
  });

  it("layers two gradients for square grids", () => {
    const bg: Background = { ...DEFAULT_BACKGROUND, pattern: "square-grid" };
    const style = getBackgroundStyle(bg, VIEWPORT);
    expect(
      String(style.backgroundImage).includes("repeating-linear-gradient(90deg"),
    ).toBe(true);
    expect(
      String(style.backgroundImage).includes("repeating-linear-gradient(0deg"),
    ).toBe(true);
  });

  it("uses radial gradients for dot grids", () => {
    const style = getBackgroundStyle(DEFAULT_BACKGROUND, VIEWPORT);
    expect(String(style.backgroundImage).startsWith("radial-gradient")).toBe(
      true,
    );
  });
});

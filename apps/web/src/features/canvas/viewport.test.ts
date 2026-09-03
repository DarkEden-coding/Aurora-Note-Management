// Focused tests for canvas viewport math: coordinate conversion, zoom anchoring, panning, and bounds helpers.
import { describe, expect, it } from "vitest";
import type { Viewport } from "@aurora/shared";
import {
  boundsContainPoint,
  boundsIntersect,
  canvasToScreen,
  clampZoom,
  expandBounds,
  panViewport,
  screenToCanvas,
  unionBounds,
  visibleCanvasBounds,
  zoomViewportAround,
} from "./viewport";

const V: Viewport = { x: 100, y: 50, width: 800, height: 600, zoom: 2 };

describe("screen<->canvas conversion", () => {
  it("round-trips through both directions", () => {
    const screen = { x: 120, y: 70 };
    const canvas = screenToCanvas(screen, V);
    expect(canvas).toEqual({ x: 160, y: 85 });
    expect(canvasToScreen(canvas, V)).toEqual(screen);
  });

  it("keeps the anchor point fixed while zooming", () => {
    const anchor = { x: 300, y: 200 };
    const before = screenToCanvas(anchor, V);
    const next = zoomViewportAround(V, anchor, 4, { width: 800, height: 600 });
    const after = screenToCanvas(anchor, next);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(next.zoom).toBe(4);
  });

  it("clamps zoom into the supported range", () => {
    expect(clampZoom(0)).toBe(0.1);
    expect(clampZoom(-5)).toBe(0.1);
    expect(clampZoom(1000)).toBe(8);
    expect(clampZoom(3)).toBe(3);
  });

  it("pans by screen deltas", () => {
    const next = panViewport(V, 100, 50);
    expect(next.x).toBeCloseTo(50, 6);
    expect(next.y).toBeCloseTo(25, 6);
  });

  it("derives visible canvas bounds from container size", () => {
    expect(visibleCanvasBounds({ width: 400, height: 300 }, V)).toEqual({
      x: 100,
      y: 50,
      width: 200,
      height: 150,
    });
    expect(visibleCanvasBounds({ width: 0, height: 0 }, V)).toEqual({
      x: 100,
      y: 50,
      width: 0,
      height: 0,
    });
  });
});

describe("bounds helpers", () => {
  it("detects intersection and containment", () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    expect(boundsIntersect(a, { x: 5, y: 5, width: 10, height: 10 })).toBe(
      true,
    );
    expect(boundsIntersect(a, { x: 11, y: 0, width: 5, height: 5 })).toBe(
      false,
    );
    expect(boundsContainPoint(a, { x: 10, y: 10 })).toBe(true);
    expect(boundsContainPoint(a, { x: 10.1, y: 5 })).toBe(false);
  });

  it("expands and unions bounds", () => {
    expect(expandBounds({ x: 10, y: 10, width: 10, height: 10 }, 5)).toEqual({
      x: 5,
      y: 5,
      width: 20,
      height: 20,
    });
    expect(unionBounds([])).toBeNull();
    expect(
      unionBounds([
        { x: 0, y: 0, width: 10, height: 10 },
        { x: 20, y: 20, width: 5, height: 5 },
      ]),
    ).toEqual({
      x: 0,
      y: 0,
      width: 25,
      height: 25,
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  orderCorners,
  quadFromPolygon,
  rectangleAspect,
  rectifiedSize,
} from "./quadGeometry";
import { projectRectangle } from "./testScene";

const frame = { width: 1500, height: 2000 };

describe("rectangleAspect", () => {
  it("recovers 4:3 from a slide shot steeply from below and to the side", () => {
    const quad = projectRectangle({
      width: 4,
      height: 3,
      yaw: 0.6,
      pitch: -0.35,
      distance: 9,
      focal: 1400,
      frame,
    });
    expect(rectangleAspect(quad, frame.width, frame.height)).toBeCloseTo(
      4 / 3,
      2,
    );
  });

  it("recovers a portrait page shot head-on", () => {
    const quad = projectRectangle({
      width: 8.5,
      height: 11,
      yaw: 0,
      pitch: 0,
      distance: 20,
      focal: 1400,
      frame,
    });
    expect(rectangleAspect(quad, frame.width, frame.height)).toBeCloseTo(
      8.5 / 11,
      3,
    );
  });
});

describe("rectifiedSize", () => {
  it("keeps the captured resolution and caps the long side", () => {
    const quad = projectRectangle({
      width: 16,
      height: 9,
      yaw: 0.4,
      pitch: 0.2,
      distance: 12,
      focal: 1400,
      frame,
    });
    const full = rectifiedSize(quad, frame.width, frame.height, 10_000);
    expect(full.width / full.height).toBeCloseTo(16 / 9, 1);
    const capped = rectifiedSize(quad, frame.width, frame.height, 800);
    expect(Math.max(capped.width, capped.height)).toBe(800);
  });
});

describe("orderCorners", () => {
  it("orders shuffled corners top-left first, clockwise", () => {
    const tl = { x: 10, y: 12 };
    const tr = { x: 100, y: 5 };
    const br = { x: 110, y: 90 };
    const bl = { x: 4, y: 80 };
    expect(orderCorners([br, tl, bl, tr])).toEqual([tl, tr, br, bl]);
  });
});

describe("quadFromPolygon", () => {
  it("restores a corner that something in front of the page cut off", () => {
    // A square with its top-left corner clipped diagonally.
    const clipped = [
      { x: 20, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
      { x: 0, y: 20 },
    ];
    const quad = orderCorners(quadFromPolygon(clipped)!);
    expect(quad[0].x).toBeCloseTo(0);
    expect(quad[0].y).toBeCloseTo(0);
  });
});

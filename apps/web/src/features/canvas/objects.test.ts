// Focused tests for canvas object helpers: payload conventions, factories, hit-testing, gesture bounds math, and handle logic.
import { describe, expect, it } from "vitest";
import type { CanvasObject } from "@aurora/shared";
import {
  MIN_BOUNDS_SIZE,
  applyResize,
  dragBoundsFree,
  getArrowHeadGeometry,
  getLineEndpoints,
  getShapeCornerRadius,
  getShapeDashArray,
  getShapeLineStyle,
  getStrokePoints,
  hitTestLineObject,
  hitTestTopmost,
  hitTestTopmostStroke,
  lineGeometryFromDrag,
  makeCanvasObject,
  moveObjectToBounds,
  nextZIndex,
  pointsToBounds,
  recomputeStrokeBounds,
  resizeObjectToBounds,
  setLineEndpointPayload,
  setStrokePayload,
  handleAtPoint,
} from "./objects";

const NOTE_ID = "00000000-0000-4000-8000-00000000b001";
const OWNER_ID = "00000000-0000-4000-8000-00000000a001";

function makeStroke(): CanvasObject {
  return makeCanvasObject({
    id: "00000000-0000-4000-8000-00000000c001",
    ownerId: OWNER_ID,
    noteId: NOTE_ID,
    kind: "stroke",
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    zIndex: 1,
    payload: setStrokePayload(
      [
        { x: 5, y: 5, pressure: 0.5 },
        { x: 15, y: 8, pressure: 0.25 },
      ],
      "#fff",
      2,
    ),
  });
}

describe("payload conventions", () => {
  it("parses stroke points and rejects malformed rows", () => {
    expect(getStrokePoints(makeStroke())).toEqual([
      { x: 5, y: 5, pressure: 0.5 },
      { x: 15, y: 8, pressure: 0.25 },
    ]);
    const bad = makeCanvasObject({
      id: "00000000-0000-4000-8000-00000000c002",
      ownerId: OWNER_ID,
      noteId: NOTE_ID,
      kind: "stroke",
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      zIndex: 1,
      payload: { points: [[1, 2], "nope", [1, 2, "x"]] },
    });
    expect(getStrokePoints(bad)).toEqual([]);
  });

  it("reads vector line styles and clamps rectangle radius", () => {
    const shape = makeCanvasObject({
      id: "00000000-0000-4000-8000-00000000c009",
      ownerId: OWNER_ID,
      noteId: NOTE_ID,
      kind: "rectangle",
      bounds: { x: 0, y: 0, width: 20, height: 20 },
      zIndex: 1,
      payload: { lineStyle: "dotted", strokeWidth: 4, cornerRadius: 100 },
    });
    expect(getShapeLineStyle(shape)).toBe("dotted");
    expect(getShapeDashArray(shape)).toBe("0 10");
    expect(getShapeCornerRadius(shape)).toBe(64);
  });

  it("derives tight stroke bounds with padding", () => {
    const o = makeStroke();
    const bounds = recomputeStrokeBounds(o);
    expect(bounds.x).toBeLessThanOrEqual(5);
    expect(bounds.width).toBeGreaterThanOrEqual(10);
    expect(
      recomputeStrokeBounds(makeCanvasObject({ ...makeStroke(), payload: {} })),
    ).toEqual({
      x: -5,
      y: -5,
      width: MIN_BOUNDS_SIZE + 10,
      height: MIN_BOUNDS_SIZE + 10,
    });
  });
});

describe("factories and z-order", () => {
  it("fills contract defaults", () => {
    const o = makeCanvasObject({
      id: "00000000-0000-4000-8000-00000000c003",
      ownerId: OWNER_ID,
      noteId: NOTE_ID,
      kind: "rectangle",
      bounds: { x: 1, y: 2, width: 3, height: 4 },
      zIndex: 7,
      payload: {},
    });
    expect(o.pageId).toBeNull();
    expect(o.rotation).toBe(0);
    expect(o.locked).toBe(false);
    expect(o.groupId).toBeNull();
    expect(o.revision).toBe(0);
    expect(o.createdAt).toBe(o.updatedAt);
    expect(nextZIndex([o])).toBe(8);
  });
});

describe("hit-testing", () => {
  it("returns the topmost containing object", () => {
    const lower = makeCanvasObject({
      id: "00000000-0000-4000-8000-00000000c004",
      ownerId: OWNER_ID,
      noteId: NOTE_ID,
      kind: "rectangle",
      bounds: { x: 0, y: 0, width: 10, height: 10 },
      zIndex: 1,
      payload: {},
    });
    const upper = {
      ...lower,
      id: "00000000-0000-4000-8000-00000000c005",
      zIndex: 9,
    };
    expect(hitTestTopmost([lower, upper], { x: 5, y: 5 })).toBe(upper);
    expect(hitTestTopmost([lower], { x: 50, y: 50 })).toBeNull();
  });

  it("hits lines by their path rather than their bounding box", () => {
    const line = makeCanvasObject({
      id: "00000000-0000-4000-8000-00000000c010",
      ownerId: OWNER_ID,
      noteId: NOTE_ID,
      kind: "line",
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      zIndex: 1,
      payload: setLineEndpointPayload({ x: 0, y: 0 }, { x: 100, y: 100 }),
    });
    expect(hitTestLineObject(line, { x: 50, y: 51 }, 2)).toBe(true);
    expect(hitTestLineObject(line, { x: 10, y: 90 }, 2)).toBe(false);

    const arrow = { ...line, kind: "arrow" as const };
    const { wing1 } = getArrowHeadGeometry({ x: 0, y: 0 }, { x: 100, y: 100 });
    expect(hitTestLineObject(arrow, wing1, 1)).toBe(true);
  });

  it("hits a stroke by its path rather than its bounding box", () => {
    const stroke = makeStroke();
    expect(hitTestTopmostStroke([stroke], { x: 10, y: 6.5 }, 1)).toBe(stroke);
    expect(hitTestTopmostStroke([stroke], { x: 10, y: 15 }, 1)).toBeNull();
  });
});

describe("gesture bounds math", () => {
  it("builds free-drag bounds from two corners", () => {
    expect(dragBoundsFree({ x: 10, y: 10 }, { x: 0, y: 4 })).toEqual({
      x: 0,
      y: 4,
      width: 10,
      height: 6,
    });
  });

  it("preserves arbitrary-angle and reverse directional line geometry", () => {
    expect(
      lineGeometryFromDrag({ x: 10, y: 20 }, { x: 40, y: 35 }),
    ).toMatchObject({
      start: { x: 10, y: 20 },
      end: { x: 40, y: 35 },
      bounds: { x: 10, y: 20, width: 30, height: 15 },
    });
    expect(
      lineGeometryFromDrag({ x: 40, y: 35 }, { x: 10, y: 20 }),
    ).toMatchObject({
      start: { x: 40, y: 35 },
      end: { x: 10, y: 20 },
      bounds: { x: 10, y: 20, width: 30, height: 15 },
    });
  });

  it("snaps line endpoints to the nearest 45 degrees", () => {
    const geometry = lineGeometryFromDrag(
      { x: 5, y: 5 },
      { x: 15, y: 13 },
      true,
    );
    expect(geometry.start).toEqual({ x: 5, y: 5 });
    expect(geometry.end.x - 5).toBeCloseTo(geometry.end.y - 5);
    expect(Math.hypot(geometry.end.x - 5, geometry.end.y - 5)).toBeCloseTo(
      Math.hypot(10, 8),
    );
    expect(
      lineGeometryFromDrag({ x: 0, y: 0 }, { x: 10, y: 10 }, false, 4).bounds,
    ).toEqual({
      x: -4,
      y: -4,
      width: 18,
      height: 18,
    });
  });

  it("resizes from each handle and clamps to the minimum size", () => {
    const start = { x: 10, y: 10, width: 100, height: 50 };
    expect(
      applyResize(start, "se", { x: 10, y: 10 }, { x: 60, y: 40 }),
    ).toEqual({
      x: 10,
      y: 10,
      width: 150,
      height: 80,
    });
    expect(
      applyResize(start, "nw", { x: 10, y: 10 }, { x: 60, y: 40 }),
    ).toEqual({
      x: 60,
      y: 40,
      width: 50,
      height: 20,
    });
    expect(
      applyResize(start, "w", { x: 10, y: 10 }, { x: 500, y: 10 }).width,
    ).toBe(MIN_BOUNDS_SIZE);
  });

  it("locates handles within tolerance", () => {
    const b = { x: 0, y: 0, width: 100, height: 100 };
    expect(handleAtPoint(b, { x: 0, y: 0 }, 4)).toBe("nw");
    expect(handleAtPoint(b, { x: 100, y: 50 }, 4)).toBe("e");
    expect(handleAtPoint(b, { x: 50, y: 50 }, 4)).toBeNull();
  });

  it("derives stroke bounds from points", () => {
    const bounds = pointsToBounds([{ x: 0, y: 0, pressure: 1 }], 4);
    expect(bounds.width).toBeGreaterThanOrEqual(MIN_BOUNDS_SIZE);
    expect(bounds.x).toBe(-4);
  });

  it("falls back to legacy bounds geometry for lines and arrows", () => {
    const base = {
      id: "00000000-0000-4000-8000-00000000c006",
      ownerId: OWNER_ID,
      noteId: NOTE_ID,
      bounds: { x: 10, y: 20, width: 30, height: 40 },
      zIndex: 1,
      payload: {},
    } as const;
    const line = makeCanvasObject({ ...base, kind: "line" });
    const arrow = makeCanvasObject({ ...base, kind: "arrow" });
    expect(getLineEndpoints(line)).toEqual({
      start: { x: 10, y: 40 },
      end: { x: 40, y: 40 },
    });
    expect(getLineEndpoints(arrow)).toEqual({
      start: { x: 10, y: 20 },
      end: { x: 40, y: 60 },
    });
  });

  it("resizes directional endpoint payload with its bounds", () => {
    const line = makeCanvasObject({
      id: "00000000-0000-4000-8000-00000000c008",
      ownerId: OWNER_ID,
      noteId: NOTE_ID,
      kind: "line",
      bounds: { x: 10, y: 20, width: 30, height: 20 },
      zIndex: 1,
      payload: setLineEndpointPayload({ x: 10, y: 20 }, { x: 40, y: 40 }),
    });
    expect(
      getLineEndpoints(
        resizeObjectToBounds(line, {
          x: 20,
          y: 40,
          width: 60,
          height: 40,
        }),
      ),
    ).toEqual({ start: { x: 20, y: 40 }, end: { x: 80, y: 80 } });
  });

  it("translates line endpoint payload when the object moves", () => {
    const line = makeCanvasObject({
      id: "00000000-0000-4000-8000-00000000c007",
      ownerId: OWNER_ID,
      noteId: NOTE_ID,
      kind: "arrow",
      bounds: { x: 10, y: 20, width: 30, height: 20 },
      zIndex: 1,
      payload: setLineEndpointPayload(
        { x: 40, y: 40 },
        { x: 10, y: 20 },
        { color: "red" },
      ),
    });
    const moved = moveObjectToBounds(line, {
      x: 25,
      y: 50,
      width: 30,
      height: 20,
    });
    expect(getLineEndpoints(moved)).toEqual({
      start: { x: 55, y: 70 },
      end: { x: 25, y: 50 },
    });
    expect(moved.payload.color).toBe("red");
  });

  it("keeps stroke points aligned when the object moves", () => {
    const moved = moveObjectToBounds(makeStroke(), {
      x: 20,
      y: 30,
      width: 10,
      height: 10,
    });
    expect(getStrokePoints(moved)).toEqual([
      { x: 25, y: 35, pressure: 0.5 },
      { x: 35, y: 38, pressure: 0.25 },
    ]);
  });
});

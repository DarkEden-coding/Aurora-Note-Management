// Focused tests for canvas object helpers: payload conventions, factories, hit-testing, gesture bounds math, and handle logic.
import { describe, expect, it } from "vitest";
import type { CanvasObject } from "@aurora/shared";
import {
  MIN_BOUNDS_SIZE,
  applyResize,
  dragBoundsAxis,
  dragBoundsFree,
  getStrokePoints,
  hitTestTopmost,
  hitTestTopmostStroke,
  makeCanvasObject,
  moveObjectToBounds,
  nextZIndex,
  pointsToBounds,
  recomputeStrokeBounds,
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

  it("picks the dominant axis for line/arrow drags", () => {
    expect(dragBoundsAxis({ x: 0, y: 0 }, { x: 50, y: 3 })).toEqual({
      x: 0,
      y: 0,
      width: 50,
      height: MIN_BOUNDS_SIZE,
    });
    expect(dragBoundsAxis({ x: 0, y: 0 }, { x: 3, y: 50 })).toEqual({
      x: 0,
      y: 0,
      width: MIN_BOUNDS_SIZE,
      height: 50,
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

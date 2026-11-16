// Box and lasso selection containment, and clone placement for paste and duplicate.
import { describe, expect, it } from "vitest";
import type { Bounds, CanvasObject } from "@aurora/shared";
import { getStrokePoints, makeCanvasObject } from "./objects";
import { boxPolygon, cloneObjects, objectsInRegion } from "./selectionRegion";

const NOTE_ID = "00000000-0000-4000-8000-00000000b001";
const OTHER_NOTE_ID = "00000000-0000-4000-8000-00000000b002";
const OWNER_ID = "00000000-0000-4000-8000-00000000a001";

function rectangle(bounds: Bounds, zIndex = 1): CanvasObject {
  return makeCanvasObject({
    id: `rect-${bounds.x}-${bounds.y}`,
    ownerId: OWNER_ID,
    noteId: NOTE_ID,
    kind: "rectangle",
    bounds,
    zIndex,
    payload: {},
  });
}

function stroke(points: [number, number][]): CanvasObject {
  return makeCanvasObject({
    id: "stroke",
    ownerId: OWNER_ID,
    noteId: NOTE_ID,
    kind: "stroke",
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    zIndex: 1,
    payload: { points: points.map(([x, y]) => [x, y, 0.5]) },
  });
}

describe("region selection", () => {
  it("selects fully enclosed objects and skips partial or locked ones", () => {
    const inside = rectangle({ x: 10, y: 10, width: 20, height: 20 });
    const partial = rectangle({ x: 90, y: 10, width: 40, height: 20 });
    const locked = {
      ...rectangle({ x: 40, y: 40, width: 10, height: 10 }),
      locked: true,
    };
    const box = boxPolygon({ x: 100, y: 100 }, { x: 0, y: 0 });
    expect(objectsInRegion([inside, partial, locked], box)).toEqual([inside]);
  });

  it("selects ink when most of its points fall inside a lasso", () => {
    const ink = stroke([
      [10, 10],
      [20, 12],
      [30, 14],
      [80, 80],
    ]);
    const lasso = [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 30 },
      { x: 0, y: 30 },
    ];
    expect(objectsInRegion([ink], lasso)).toEqual([ink]);
    const tight = [
      { x: 0, y: 0 },
      { x: 15, y: 0 },
      { x: 15, y: 15 },
      { x: 0, y: 15 },
    ];
    expect(objectsInRegion([ink], tight)).toEqual([]);
  });
});

describe("cloning", () => {
  it("gives clones new ids, the target note, offset geometry, and top stacking", () => {
    const ink = stroke([[10, 10]]);
    const shape = rectangle({ x: 0, y: 0, width: 10, height: 10 }, 5);
    const [first, second] = cloneObjects([shape, ink], {
      ownerId: OWNER_ID,
      noteId: OTHER_NOTE_ID,
      offset: { x: 24, y: 24 },
      baseZIndex: 10,
    });
    expect(first!.id).not.toBe(ink.id);
    expect(first!.noteId).toBe(OTHER_NOTE_ID);
    expect(first!.revision).toBe(0);
    expect(first!.zIndex).toBe(10);
    expect(getStrokePoints(first!)[0]).toMatchObject({ x: 34, y: 34 });
    expect(second!.bounds).toMatchObject({ x: 24, y: 24 });
    expect(second!.zIndex).toBe(11);
  });
});
